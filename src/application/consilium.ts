/**
 * @fileoverview Основной API Consilium
 * @module lv24-opencode-consilium
 */

import type {
  ConsiliumConfig,
  ConsiliumResult,
  AgentResult,
  RunOptions,
  ProgressCallback,
  ProgressEvent,
  ConsiliumStatus,
  ConsiliumPlugin
} from '../domain/types.js';
import { loadConfig, mergeWithDefaults, cloneConfig } from '../infrastructure/config/config.js';
import {
  callExpertsParallel,
  callChair,
  checkOpenCodeAvailable,
  createRunController,
  type RunController
} from '../infrastructure/opencode/agents.js';
import { resolveCwd } from '../infrastructure/opencode/spawn.js';
import {
  applyReadOnlyOverlay,
  type ReadOnlyOverlay
} from '../infrastructure/opencode/read-only.js';
import {
  assertIsolatedReadOnlyPreflight,
  cleanupStaleWorktrees,
  resolveIsolateRoot
} from '../infrastructure/opencode/isolate.js';
import { DEFAULT_CONFIG, DEFAULT_CHAIR_PROMPT_TEMPLATE } from '../domain/defaults.js';
import { applyPreset } from '../domain/council/presets.js';
import { auditLocalOnly } from '../infrastructure/local-models.js';
import { selectSmartExperts } from '../domain/council/smart-experts.js';
import { createCostTracker } from '../domain/council/fallback.js';
import { appendFindingsInstruction, buildExpertPrompt } from '../domain/council/prompts.js';
import { collectFindings } from './findings.js';
import {
  normalizeDebateRounds,
  runDebateRound,
  withDebateChairNote,
  type DebateOutcome
} from './debate.js';
import {
  applyCostTelemetryWarning,
  buildCancelledMetadata,
  buildCompletedResult,
  buildDeadlineChairNote,
  buildDeadlineFailureChair,
  buildDeadlineMetadata,
  createCancelledResult,
  runExpertPhaseWithDeadline,
  sanitizeDeadlineMs,
  saveArtifactRun,
  saveResult,
  selectChairAgent,
  selectExperts,
  summarizeDeadline,
  withDeadlineChairNote
} from './run.js';

/**
 * Класс Consilium - основной интерфейс для работы с консилиумом
 */
export class Consilium {
  private config: ConsiliumConfig;
  private status: ConsiliumStatus = 'idle';
  private progressCallbacks: Set<ProgressCallback> = new Set();
  private plugins: ConsiliumPlugin[] = [];
  private warnings: string[] = [];
  private controller: RunController | null = null;
  private startTime = 0;
  /** Отмена запрошена пользователем (не дедлайном) */
  private cancelRequested = false;

  constructor(config?: Partial<ConsiliumConfig> | string) {
    if (typeof config === 'string') {
      const result = loadConfig(config, { trustProjectConfig: true });
      this.config = result.config;
      this.warnings = result.warnings;
    } else if (config) {
      this.config = mergeWithDefaults(config);
    } else {
      const result = loadConfig();
      this.config = result.config;
      this.warnings = result.warnings;
    }
    this.plugins = this.config.plugins ? [...this.config.plugins] : [];
  }

  /**
   * Получить копию текущей конфигурации
   */
  getConfig(): ConsiliumConfig {
    return cloneConfig(this.config);
  }

  /**
   * Предупреждения, полученные при загрузке конфигурации
   */
  getWarnings(): string[] {
    return [...this.warnings];
  }

  /**
   * Получить текущий статус
   */
  getStatus(): ConsiliumStatus {
    return this.status;
  }

  /**
   * Добавить callback для отслеживания прогресса
   */
  onProgress(callback: ProgressCallback): () => void {
    this.progressCallbacks.add(callback);
    return () => {
      this.progressCallbacks.delete(callback);
    };
  }

  /**
   * Зарегистрировать плагин (инициализируется перед запуском)
   */
  use(plugin: ConsiliumPlugin): this {
    this.plugins.push(plugin);
    if (plugin.hooks) {
      this.config.hooks = {
        ...this.config.hooks,
        ...plugin.hooks
      };
    }
    return this;
  }

  /**
   * Отменить текущий запуск
   */
  cancel(): void {
    this.cancelRequested = true;
    this.controller?.cancel();
  }

  /**
   * Запустить консилиум
   */
  async run(task: string, options: RunOptions = {}): Promise<ConsiliumResult> {
    if (!task || task.trim().length === 0) {
      throw new Error('Задача не может быть пустой');
    }

    if (this.status === 'running_experts' || this.status === 'running_chair') {
      throw new Error(`Consilium уже запущен (статус: ${this.status})`);
    }

    // Захватываем запуск синхронно, до любых await, чтобы исключить гонку.
    const controller = createRunController();
    this.controller = controller;
    this.status = 'running_experts';
    this.startTime = Date.now();
    this.cancelRequested = false;

    let hooks: ConsiliumConfig['hooks'] | undefined;
    /** Временный read-only слой; восстанавливается на любом пути выхода */
    let readOnlyOverlay: ReadOnlyOverlay | undefined;

    try {
    let runConfig = cloneConfig(this.config);
    runConfig.hooks = { ...this.config.hooks, ...options.hooks };

    for (const plugin of this.plugins) {
      if (plugin.init) {
        runConfig = await plugin.init(runConfig);
      }
    }

    if (options.preset) {
      runConfig = applyPreset(runConfig, options.preset, runConfig.presets);
    }

    if (options.timeout !== undefined && Number.isFinite(options.timeout) && options.timeout > 0) {
      runConfig.timeouts.expert = options.timeout;
      runConfig.experts = runConfig.experts.map(expert => ({ ...expert, timeout: options.timeout }));
    }

    // Опции запуска переопределяют конфигурацию; сами значения нужны и агентам.
    const artifactsSetting = options.artifacts ?? runConfig.artifacts;
    const consensusEnabled = options.consensus ?? runConfig.consensus === true;
    const findingsEnabled = options.findings ?? runConfig.findings === true;
    const smartEnabled = options.smartExperts ?? runConfig.smartExperts === true;
    const maxCost = options.maxCost ?? runConfig.maxCost;
    const fallbackModels = options.fallbackModels ?? runConfig.fallbackModels ?? [];
    const session = options.session ?? runConfig.session;
    const deadlineMs = sanitizeDeadlineMs(options.deadlineMs ?? runConfig.deadlineMs);
    const requestedRounds = options.rounds ?? runConfig.rounds;
    const rounds = normalizeDebateRounds(requestedRounds);
    const readOnly = options.readOnly ?? runConfig.readOnly === true;
    const isolate = options.isolate ?? runConfig.isolate === true;
    const safety = { readOnly, isolate };

    runConfig.consensus = consensusEnabled;
    if (options.findings !== undefined) {
      runConfig.findings = findingsEnabled;
    }
    runConfig.fallbackModels = fallbackModels;
    runConfig.session = session;
    runConfig.readOnly = readOnly;
    runConfig.isolate = isolate;
    if (maxCost !== undefined) runConfig.maxCost = maxCost;
    if (deadlineMs !== undefined) {
      runConfig.deadlineMs = deadlineMs;
    } else {
      delete runConfig.deadlineMs;
    }

    // Гарантия приватности на уровне library/plugin/MCP, а не только CLI:
    // в localOnly каждый агент обязан иметь явную локальную модель.
    if (runConfig.localOnly === true) {
      const audit = auditLocalOnly([
        ...runConfig.experts.map(expert => ({
          label: `эксперт ${expert.name}`,
          model: expert.model
        })),
        { label: `председатель ${runConfig.chair.agent}`, model: runConfig.chair.model }
      ]);
      if (audit.missing.length > 0) {
        throw new Error(
          'localOnly требует явную локальную модель для каждого агента. ' +
            `Без модели: ${audit.missing.join(', ')}`
        );
      }
      if (audit.nonLocal.length > 0) {
        throw new Error(
          'localOnly требует только локальных провайдеров. ' +
            `Нелокальные модели: ${audit.nonLocal.join(', ')}`
        );
      }
    }

    const baseHooks = runConfig.hooks ?? {};
    runConfig.hooks = {
      ...baseHooks,
      onExpertStart: async (expert: string, expertTask: string) => {
        this.emitProgress({
          type: 'expert_start',
          agent: expert,
          status: 'running_experts',
          progress: 0,
          timestamp: Date.now()
        });
        await baseHooks.onExpertStart?.(expert, expertTask);
      },
      onExpertEnd: async (result: AgentResult) => {
        this.emitProgress({
          type: 'expert_end',
          agent: result.agent,
          status: 'running_experts',
          progress: 0,
          timestamp: Date.now(),
          data: result
        });
        await baseHooks.onExpertEnd?.(result);
      },
      onChairStart: async (chairTask: string, expertResults: AgentResult[]) => {
        this.emitProgress({
          type: 'chair_start',
          status: 'running_chair',
          progress: 50,
          timestamp: Date.now()
        });
        await baseHooks.onChairStart?.(chairTask, expertResults);
      },
      onChairEnd: async (result: AgentResult) => {
        this.emitProgress({
          type: 'chair_end',
          agent: result.agent,
          status: 'running_chair',
          progress: 95,
          timestamp: Date.now(),
          data: result
        });
        await baseHooks.onChairEnd?.(result);
      }
    };
    hooks = runConfig.hooks;

    if (requestedRounds !== undefined && requestedRounds !== rounds) {
      hooks.onLog?.(
        'warn',
        `rounds=${String(requestedRounds)} не поддерживается: допустимо 1 или 2; ` +
          'выполняется 1 раунд'
      );
    }

      if (!(await checkOpenCodeAvailable(runConfig))) {
        throw new Error(
          'OpenCode CLI не найден. Установите: npm install -g opencode-ai (или укажите opencodePath в конфиге)'
        );
      }

      const selectedExperts = selectExperts(runConfig, options.experts, hooks);

      // Fail fast до создания worktree, хуков и вызова моделей: JSONC в корне
      // репозитория перекрывает per-worktree read-only слой (SPAWN_ERROR).
      assertIsolatedReadOnlyPreflight({
        cwd: resolveCwd(runConfig),
        readOnly,
        isolate
      });

      if (isolate) {
        // Проверяем git до вызова моделей и заранее убираем осиротевшие
        // worktree прошлых запусков. Без репозитория изоляция невозможна.
        const isolateRoot = resolveIsolateRoot(resolveCwd(runConfig));
        cleanupStaleWorktrees({
          root: isolateRoot,
          onLog: (level, message) => hooks?.onLog?.(level, message)
        });
      }

      if (readOnly && !isolate) {
        // Слой пишется до запуска агентов и снимается в finally.
        // Проектный .opencode/opencode.json приоритетнее прямого opencode.json,
        // поэтому OpenCode читает эти deny-правила для каждого дочернего процесса.
        // При --isolate слой живёт внутри worktree каждого агента.
        readOnlyOverlay = await applyReadOnlyOverlay({
          cwd: resolveCwd(runConfig),
          agents: [
            ...new Set([
              ...selectedExperts.map(expert => expert.name),
              options.chair ?? runConfig.chair.agent
            ])
          ],
          onLog: (level, message) => hooks?.onLog?.(level, message)
        });
      }

      await hooks.onStart?.(task, runConfig);

      let councilExperts = selectedExperts;
      let smartSelection: ReturnType<typeof selectSmartExperts> | undefined;

      if (smartEnabled) {
        smartSelection = selectSmartExperts(selectedExperts, task);
        if (smartSelection.dropped.length > 0) {
          hooks.onLog?.(
            'info',
            `Умный выбор экспертов: ${smartSelection.experts.map(expert => expert.name).join(', ')} ` +
              `(пропущены: ${smartSelection.dropped.join(', ')})`
          );
        }
        councilExperts = smartSelection.experts;
      }

      const costTracker = createCostTracker(maxCost);
      const parallelStarted = Date.now();
      let expertResults: AgentResult[];
      let debate: DebateOutcome | undefined;
      let deadlineHit: boolean;
      // В режиме дебатов стоимость первого раунда учитывается до проверки лимита
      // перед вторым раундом, поэтому отдельный цикл ниже уже не нужен.
      let expertCostsAdded = false;

      if (rounds === 2) {
        const debatePhase = await runExpertPhaseWithDeadline(
          deadlineMs,
          controller,
          async () => {
            const firstRound = await callExpertsParallel(councilExperts, task, runConfig, {
              controller
            });
            for (const result of firstRound) {
              costTracker.add(result.agent, result.usage);
            }

            const successful = firstRound.filter(result => result.success);
            if (successful.length < 2 || controller.isCancelled()) {
              return { results: firstRound, debate: undefined };
            }
            if (costTracker.exceeded()) {
              hooks?.onLog?.(
                'warn',
                `Лимит стоимости превышен после первого раунда: ` +
                  `$${costTracker.report().spent.toFixed(4)} из $${maxCost ?? 0}; ` +
                  'второй раунд дебатов пропущен'
              );
              return { results: firstRound, debate: undefined };
            }

            const outcome = await runDebateRound(firstRound, task, runConfig, {
              rounds,
              controller,
              costTracker
            });
            return {
              results: outcome?.results ?? firstRound,
              debate: outcome
            };
          }
        );

        expertResults = debatePhase.value.results;
        debate = debatePhase.value.debate;
        deadlineHit = debatePhase.hit;
        expertCostsAdded = true;
      } else {
        const expertPhase = await runExpertPhaseWithDeadline(
          deadlineMs,
          controller,
          () => callExpertsParallel(councilExperts, task, runConfig, { controller })
        );
        expertResults = expertPhase.value;
        deadlineHit = expertPhase.hit;
      }

      const parallelTime = Date.now() - parallelStarted;

      const deadlineSummary =
        deadlineMs !== undefined ? summarizeDeadline(expertResults) : undefined;
      const deadlineMetadata =
        deadlineMs !== undefined && deadlineSummary !== undefined
          ? buildDeadlineMetadata(deadlineMs, deadlineHit, deadlineSummary)
          : undefined;

      // Дедлайн отменяет общий контроллер, чтобы завершить дочерние процессы,
      // но председатель должен получить шанс синтезировать частичный результат.
      // Пользовательскую отмену не сбрасываем.
      if (deadlineHit && !this.cancelRequested) {
        controller.reset();
      }

      if (!expertCostsAdded) {
        for (const result of expertResults) {
          costTracker.add(result.agent, result.usage);
        }
      }
      let costExceeded = costTracker.exceeded();
      if (costExceeded) {
        hooks.onLog?.(
          'warn',
          `Лимит стоимости превышен после экспертов: $${costTracker.report().spent.toFixed(4)} ` +
            `из $${maxCost ?? 0}; председатель не запускается`
        );
      }

      if (this.cancelRequested || controller.isCancelled()) {
        const result = createCancelledResult(
          expertResults,
          undefined,
          parallelTime,
          this.startTime,
          runConfig
        );
        result.metadata = {
          ...(result.metadata ?? {}),
          ...buildCancelledMetadata(
            expertResults,
            undefined,
            options.metadata,
            costTracker.report(),
            session,
            findingsEnabled ? collectFindings(expertResults) : undefined,
            safety
          ),
          ...(debate !== undefined ? { debate: debate.metadata } : {}),
          ...(deadlineMetadata !== undefined ? { deadline: deadlineMetadata } : {})
        };
        this.status = 'cancelled';
        saveArtifactRun(result, task, artifactsSetting, runConfig, hooks);
        await hooks.onEnd?.(result);
        return result;
      }

      this.status = 'running_chair';
      const chairAgent = selectChairAgent(runConfig, options.chair);

      let chairResult: AgentResult;
      if (
        deadlineHit &&
        deadlineMs !== undefined &&
        deadlineSummary !== undefined &&
        deadlineSummary.completed === 0
      ) {
        // Дедлайн не оставил ни одного успешного эксперта: синтезировать нечего.
        chairResult = buildDeadlineFailureChair(chairAgent, deadlineMs, deadlineSummary);
      } else if (costTracker.exceeded()) {
        costExceeded = true;
        const spent = costTracker.report().spent;
        chairResult = {
          agent: chairAgent,
          text: '',
          success: false,
          attempt: 0,
          exitCode: null,
          errorCode: 'COST_LIMIT',
          errorMessage:
            `Лимит стоимости $${maxCost ?? 0} превышен ($${spent.toFixed(4)}); ` +
            'председатель не запускался'
        };
      } else {
        const successfulResults =
          deadlineHit && deadlineSummary !== undefined
            ? expertResults.filter(result => result.success)
            : expertResults;
        let chairConfig =
          debate !== undefined ? withDebateChairNote(runConfig, debate.note) : runConfig;
        if (deadlineHit && deadlineSummary !== undefined) {
          chairConfig = withDeadlineChairNote(
            chairConfig,
            buildDeadlineChairNote(deadlineSummary)
          );
        }
        try {
          chairResult = await callChair(successfulResults, task, chairConfig, { controller });
          costTracker.add(chairResult.agent, chairResult.usage);
          costExceeded = costTracker.exceeded();
        } catch (error) {
          // Ни один эксперт не ответил (или другая ошибка синтеза): сохраняем
          // частичный результат, чтобы артефакт и -o работали для post-mortem.
          chairResult = {
            agent: chairAgent,
            text: '',
            success: false,
            attempt: 0,
            exitCode: null,
            errorCode: 'EXIT_ERROR',
            errorMessage: (error as Error).message
          };
        }
      }

      const findingsSummary = findingsEnabled
        ? collectFindings(expertResults, chairResult)
        : undefined;

      if (this.cancelRequested || controller.isCancelled()) {
        const result = createCancelledResult(
          expertResults,
          chairResult,
          parallelTime,
          this.startTime,
          runConfig
        );
        result.metadata = {
          ...(result.metadata ?? {}),
          ...buildCancelledMetadata(
            expertResults,
            chairResult,
            options.metadata,
            costTracker.report(),
            session,
            findingsSummary,
            safety
          ),
          ...(debate !== undefined ? { debate: debate.metadata } : {}),
          ...(deadlineMetadata !== undefined ? { deadline: deadlineMetadata } : {})
        };
        this.status = 'cancelled';
        saveArtifactRun(result, task, artifactsSetting, runConfig, hooks);
        await hooks.onEnd?.(result);
        return result;
      }

      this.status = 'completed';

      const result = buildCompletedResult({
        experts: expertResults,
        chair: chairResult,
        parallelTime,
        startTime: this.startTime,
        metadata:
          debate !== undefined
            ? { ...options.metadata, debate: debate.metadata }
            : options.metadata,
        cost: costTracker.report(),
        costExceeded,
        consensusEnabled,
        findings: findingsSummary,
        smartSelection,
        session,
        fallbackModels,
        safety
      });

      if (deadlineMetadata !== undefined) {
        result.metadata = { ...result.metadata, deadline: deadlineMetadata };
        if (
          deadlineHit &&
          deadlineSummary !== undefined &&
          deadlineSummary.completed > 0 &&
          deadlineSummary.missing.length > 0
        ) {
          // Недостающие роли должны быть видны и в тексте, не только в JSON.
          const note =
            `Дедлайн экспертной фазы: ${deadlineSummary.completed} из ` +
            `${deadlineSummary.total} экспертов завершили работу; не ответили: ` +
            deadlineSummary.missing.join(', ');
          result.text = result.text.length > 0 ? `${result.text}\n\n[${note}]` : `[${note}]`;
        }
      }

      applyCostTelemetryWarning(result, maxCost, hooks);

      const explicitOutput = options.outputFile;
      const configuredFile = runConfig.output.file;
      const outputTarget = explicitOutput ?? (configuredFile !== false ? configuredFile : undefined);

      if (outputTarget) {
        try {
          const fullPath = saveResult(result, outputTarget, runConfig);
          result.metadata = { ...result.metadata, savedFile: fullPath };
        } catch (error) {
          result.metadata = {
            ...result.metadata,
            saveError: (error as Error).message
          };
          hooks.onLog?.('warn', `Не удалось сохранить результат: ${(error as Error).message}`);
        }
      }

      saveArtifactRun(result, task, artifactsSetting, runConfig, hooks);

      await hooks.onEnd?.(result);
      return result;
    } catch (error) {
      this.status = 'failed';
      try {
        await hooks?.onError?.(error as Error, { task, options });
      } catch {
        // Ошибка в хуке не должна маскировать исходную
      }
      this.emitProgress({
        type: 'error',
        status: 'failed',
        progress: 0,
        timestamp: Date.now(),
        data: error
      });
      throw error;
    } finally {
      // Снимаем временный слой до выхода из run: успех, ошибка и отмена.
      readOnlyOverlay?.restore();
      if (this.controller === controller) {
        this.controller = null;
      }
    }
  }

  /**
   * Запустить консилиум и вернуть только текст
   */
  async runSimple(task: string, options: RunOptions = {}): Promise<string> {
    const result = await this.run(task, options);
    return result.text;
  }

  /**
   * Dry run - возвращает сформированные промпты без вызова агентов
   */
  dryRun(task: string): {
    expertPrompts: Array<{ agent: string; prompt: string; model?: string }>;
    chairPromptTemplate: string;
  } {
    const experts = this.config.experts.filter(expert => expert.enabled !== false);
    const findingsEnabled = this.config.findings === true;

    const expertPrompts = experts.map(expert => ({
      agent: expert.name,
      model: expert.model,
      prompt: buildExpertPrompt(expert, task, findingsEnabled)
    }));

    const placeholderResults: AgentResult[] = experts.map(expert => ({
      agent: expert.name,
      model: expert.model,
      text: `[ответ эксперта ${expert.name}]`,
      success: true
    }));

    const baseChairPrompt = this.config.chair.promptTemplate
      ? this.config.chair.promptTemplate(task, placeholderResults)
      : DEFAULT_CHAIR_PROMPT_TEMPLATE(task, placeholderResults);
    const chairPromptTemplate = findingsEnabled
      ? appendFindingsInstruction(baseChairPrompt, 'chair')
      : baseChairPrompt;

    return {
      expertPrompts,
      chairPromptTemplate
    };
  }

  private emitProgress(event: ProgressEvent): void {
    for (const callback of this.progressCallbacks) {
      try {
        callback(event);
      } catch {
        // Ошибки подписчиков не влияют на запуск
      }
    }
  }
}

// Convenience exports

/**
 * Создать экземпляр Consilium
 */
export function createConsilium(config?: Partial<ConsiliumConfig> | string): Consilium {
  return new Consilium(config);
}

/**
 * Быстрый запуск консилиума
 */
export async function runConsilium(
  task: string,
  config?: Partial<ConsiliumConfig>
): Promise<ConsiliumResult> {
  const instance = new Consilium(config);
  return instance.run(task);
}

/**
 * Быстрый запуск с возвратом только текста
 */
export async function askConsilium(
  task: string,
  config?: Partial<ConsiliumConfig>
): Promise<string> {
  const instance = new Consilium(config);
  return instance.runSimple(task);
}

// Re-export types and utilities
export * from '../domain/types.js';
export * from '../infrastructure/config/config.js';
export * from '../infrastructure/opencode/agents.js';
export * from '../domain/models/models.js';
export * from '../infrastructure/models/sources.js';
export * from '../domain/council/presets.js';
export * from '../infrastructure/config/compat.js';
export * from '../domain/artifacts/artifacts.js';
export * from '../infrastructure/artifacts/store.js';
export * from '../domain/council/consensus.js';
export * from '../domain/council/findings.js';
export * from './findings.js';
export * from '../domain/council/smart-experts.js';
export * from '../domain/council/fallback.js';
export * from '../domain/artifacts/report.js';
export * from '../infrastructure/watch.js';
export * from '../domain/council/variants.js';
export * from '../domain/artifacts/replay.js';
export * from './models/verify.js';
export {
  ISOLATION_JSONC_UNSUPPORTED,
  IsolationConfigError,
  assertIsolatedReadOnlyPreflight,
  isIsolationConfigError,
  type IsolatedReadOnlyPreflightOptions
} from '../infrastructure/opencode/isolate.js';
export { DEFAULT_CONFIG } from '../domain/defaults.js';
