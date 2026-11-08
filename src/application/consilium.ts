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
import { DEFAULT_CONFIG, DEFAULT_CHAIR_PROMPT_TEMPLATE } from '../domain/defaults.js';
import { applyPreset } from '../domain/council/presets.js';
import { selectSmartExperts } from '../domain/council/smart-experts.js';
import { createCostTracker } from '../domain/council/fallback.js';
import { buildExpertPrompt } from '../domain/council/prompts.js';
import {
  applyCostTelemetryWarning,
  buildCancelledMetadata,
  buildCompletedResult,
  createCancelledResult,
  saveArtifactRun,
  saveResult,
  selectChairAgent,
  selectExperts
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

  constructor(config?: Partial<ConsiliumConfig> | string) {
    if (typeof config === 'string') {
      const result = loadConfig(config);
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

    let hooks: ConsiliumConfig['hooks'] | undefined;

    try {
    let runConfig = cloneConfig(this.config);
    runConfig.hooks = { ...this.config.hooks, ...options.hooks };

    for (const plugin of this.plugins) {
      if (plugin.init) {
        runConfig = await plugin.init(runConfig);
      }
    }

    if (options.preset) {
      runConfig = applyPreset(runConfig, options.preset);
    }

    if (options.timeout !== undefined && Number.isFinite(options.timeout) && options.timeout > 0) {
      runConfig.timeouts.expert = options.timeout;
      runConfig.experts = runConfig.experts.map(expert => ({ ...expert, timeout: options.timeout }));
    }

    // Опции запуска переопределяют конфигурацию; сами значения нужны и агентам.
    const artifactsSetting = options.artifacts ?? runConfig.artifacts;
    const consensusEnabled = options.consensus ?? runConfig.consensus === true;
    const smartEnabled = options.smartExperts ?? runConfig.smartExperts === true;
    const maxCost = options.maxCost ?? runConfig.maxCost;
    const fallbackModels = options.fallbackModels ?? runConfig.fallbackModels ?? [];
    const session = options.session ?? runConfig.session;

    runConfig.consensus = consensusEnabled;
    runConfig.fallbackModels = fallbackModels;
    runConfig.session = session;
    if (maxCost !== undefined) runConfig.maxCost = maxCost;

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

      if (!(await checkOpenCodeAvailable(runConfig))) {
        throw new Error(
          'OpenCode CLI не найден. Установите: npm install -g opencode-ai (или укажите opencodePath в конфиге)'
        );
      }

      await hooks.onStart?.(task, runConfig);

      const selectedExperts = selectExperts(runConfig, options.experts, hooks);
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
      const expertResults = await callExpertsParallel(councilExperts, task, runConfig, { controller });
      const parallelTime = Date.now() - parallelStarted;

      for (const result of expertResults) {
        costTracker.add(result.agent, result.usage);
      }
      let costExceeded = costTracker.exceeded();
      if (costExceeded) {
        hooks.onLog?.(
          'warn',
          `Лимит стоимости превышен после экспертов: $${costTracker.report().spent.toFixed(4)} ` +
            `из $${maxCost ?? 0}; председатель не запускается`
        );
      }

      if (controller.isCancelled()) {
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
            session
          )
        };
        this.status = 'cancelled';
        saveArtifactRun(result, task, artifactsSetting, runConfig, hooks);
        await hooks.onEnd?.(result);
        return result;
      }

      this.status = 'running_chair';
      const chairAgent = selectChairAgent(runConfig, options.chair);

      let chairResult: AgentResult;
      if (costTracker.exceeded()) {
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
        try {
          chairResult = await callChair(expertResults, task, runConfig, { controller });
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

      if (controller.isCancelled()) {
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
            session
          )
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
        metadata: options.metadata,
        cost: costTracker.report(),
        costExceeded,
        consensusEnabled,
        smartSelection,
        session,
        fallbackModels
      });

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

    const expertPrompts = experts.map(expert => ({
      agent: expert.name,
      model: expert.model,
      prompt: buildExpertPrompt(expert, task)
    }));

    const placeholderResults: AgentResult[] = experts.map(expert => ({
      agent: expert.name,
      model: expert.model,
      text: `[ответ эксперта ${expert.name}]`,
      success: true
    }));

    const chairPromptTemplate = this.config.chair.promptTemplate
      ? this.config.chair.promptTemplate(task, placeholderResults)
      : DEFAULT_CHAIR_PROMPT_TEMPLATE(task, placeholderResults);

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
export * from '../domain/council/presets.js';
export * from '../infrastructure/config/compat.js';
export * from '../domain/artifacts/artifacts.js';
export * from '../domain/council/consensus.js';
export * from '../domain/council/smart-experts.js';
export * from '../domain/council/fallback.js';
export * from '../domain/artifacts/report.js';
export * from '../infrastructure/watch.js';
export * from '../domain/council/variants.js';
export * from '../domain/artifacts/replay.js';
export * from './models/verify.js';
export { DEFAULT_CONFIG } from '../domain/defaults.js';
