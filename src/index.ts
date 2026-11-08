/**
 * @fileoverview Основной API Consilium
 * @module opencode-consilium
 */

import { writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from 'fs';
import { dirname, resolve } from 'path';
import type {
  ConsiliumConfig,
  ConsiliumResult,
  AgentResult,
  AgentUsage,
  RunOptions,
  ProgressCallback,
  ProgressEvent,
  ConsiliumStatus,
  ConsiliumPlugin
} from './types.js';
import { loadConfig, mergeWithDefaults, cloneConfig } from './config.js';
import {
  callExpertsParallel,
  callChair,
  checkOpenCodeAvailable,
  createRunController,
  type RunController
} from './agents.js';
import { DEFAULT_CONFIG, DEFAULT_EXPERT_PROMPTS, DEFAULT_CHAIR_PROMPT_TEMPLATE } from './defaults.js';
import { applyPreset } from './presets.js';
import { analyzeConsensus, formatConsensusReport } from './consensus.js';
import { selectSmartExperts } from './smart-experts.js';
import { createCostTracker } from './fallback.js';
import {
  createArtifactId,
  resolveArtifactRoot,
  saveArtifact,
  type ArtifactRun
} from './artifacts.js';

function sumUsage(results: AgentResult[]): AgentUsage | undefined {
  let found = false;
  const total: Required<AgentUsage> = {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cost: 0
  };

  for (const result of results) {
    const usage = result.usage;
    if (!usage) continue;
    found = true;
    total.inputTokens += usage.inputTokens ?? 0;
    total.outputTokens += usage.outputTokens ?? 0;
    total.reasoningTokens += usage.reasoningTokens ?? 0;
    total.cacheReadTokens += usage.cacheReadTokens ?? 0;
    total.cacheWriteTokens += usage.cacheWriteTokens ?? 0;
    total.cost += usage.cost ?? 0;
  }

  return found ? total : undefined;
}

/** Собирает модели агентов из результатов */
function collectModels(results: AgentResult[]): Record<string, string> {
  const models: Record<string, string> = {};
  for (const result of results) {
    if (result.model) models[result.agent] = result.model;
  }
  return models;
}

/** Входные данные для анализа согласия */
function consensusInputs(results: AgentResult[]): Array<{
  agent: string;
  text: string;
  model?: string;
  success: boolean;
}> {
  return results.map(result => ({
    agent: result.agent,
    text: result.text,
    model: result.model,
    success: result.success
  }));
}

/** Собирает реальные session id агентов */
function collectSessions(results: AgentResult[]): Record<string, string> {
  const sessions: Record<string, string> = {};
  for (const result of results) {
    if (result.sessionId !== undefined) sessions[result.agent] = result.sessionId;
  }
  return sessions;
}

function buildExpertPrompt(expertName: string, prompt: unknown, task: string): string {
  if (typeof prompt === 'function') {
    return prompt(task);
  }
  if (typeof prompt === 'string' && prompt.trim().length > 0) {
    return prompt.replace(/\$\{task\}/g, task);
  }
  const fallback = Object.prototype.hasOwnProperty.call(DEFAULT_EXPERT_PROMPTS, expertName)
    ? DEFAULT_EXPERT_PROMPTS[expertName]
    : DEFAULT_EXPERT_PROMPTS.default;
  return typeof fallback === 'function' ? fallback(task) : task;
}

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

      const selectedExperts = this.selectExperts(runConfig, options.experts, hooks);
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
        const result = this.createCancelledResult(expertResults, undefined, parallelTime, runConfig);
        result.metadata = {
          ...(result.metadata ?? {}),
          ...options.metadata,
          models: collectModels(expertResults),
          sessions: collectSessions(expertResults),
          cost: costTracker.report(),
          ...(session ? { session } : {})
        };
        this.status = 'cancelled';
        this.saveArtifactRun(result, task, artifactsSetting, runConfig, hooks);
        await hooks.onEnd?.(result);
        return result;
      }

      this.status = 'running_chair';
      const configuredChair = runConfig.chair.agent;
      const chairAgent = options.chair ?? configuredChair;
      if (chairAgent !== configuredChair) {
        // Модель была выбрана для другого агента: переразрешаем её для нового.
        runConfig.chair = { ...runConfig.chair, agent: chairAgent, model: undefined };
      } else {
        runConfig.chair.agent = chairAgent;
      }

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
        const result = this.createCancelledResult(expertResults, chairResult, parallelTime, runConfig);
        result.metadata = {
          ...(result.metadata ?? {}),
          ...options.metadata,
          models: collectModels([...expertResults, chairResult]),
          sessions: collectSessions([...expertResults, chairResult]),
          cost: costTracker.report(),
          ...(session ? { session } : {})
        };
        this.status = 'cancelled';
        this.saveArtifactRun(result, task, artifactsSetting, runConfig, hooks);
        await hooks.onEnd?.(result);
        return result;
      }

      this.status = 'completed';

      const models = collectModels([...expertResults, chairResult]);
      const sessions = collectSessions([...expertResults, chairResult]);

      const consensusReport = consensusEnabled
        ? analyzeConsensus(consensusInputs(expertResults))
        : undefined;
      const consensusText = consensusReport
        ? `\n\n---\n\n${formatConsensusReport(consensusReport)}`
        : '';

      const result: ConsiliumResult = {
        text: `${chairResult.text}${consensusText}`.trim(),
        experts: expertResults,
        chair: chairResult,
        totalTime: Date.now() - this.startTime,
        parallelTime,
        success: chairResult.success,
        usage: sumUsage([...expertResults, chairResult]),
        metadata: {
          ...options.metadata,
          models,
          cost: costTracker.report(),
          ...(costExceeded ? { costExceeded: true } : {}),
          ...(consensusReport ? { consensus: consensusReport } : {}),
          ...(smartSelection
            ? {
                smartExperts: {
                  dropped: smartSelection.dropped,
                  scores: smartSelection.scores,
                  reasons: smartSelection.reasons
                }
              }
            : {}),
          ...(session ? { session } : {}),
          ...(Object.keys(sessions).length > 0 ? { sessions } : {}),
          ...(fallbackModels.length > 0 ? { fallbackModels } : {})
        }
      };

      if (maxCost !== undefined) {
        const hasCostTelemetry = [...expertResults, chairResult].some(
          item => typeof item.usage?.cost === 'number'
        );
        if (!hasCostTelemetry) {
          hooks.onLog?.(
            'warn',
            'Провайдер не сообщил стоимость запуска: лимит maxCost невозможно проверить.'
          );
          result.metadata = { ...result.metadata, costTelemetry: 'missing' };
        }
      }

      const explicitOutput = options.outputFile;
      const configuredFile = runConfig.output.file;
      const outputTarget = explicitOutput ?? (configuredFile !== false ? configuredFile : undefined);

      if (outputTarget) {
        try {
          const fullPath = this.saveResult(result, outputTarget, runConfig);
          result.metadata = { ...result.metadata, savedFile: fullPath };
        } catch (error) {
          result.metadata = {
            ...result.metadata,
            saveError: (error as Error).message
          };
          hooks.onLog?.('warn', `Не удалось сохранить результат: ${(error as Error).message}`);
        }
      }

      this.saveArtifactRun(result, task, artifactsSetting, runConfig, hooks);

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
      prompt: buildExpertPrompt(expert.name, expert.prompt, task)
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

  private selectExperts(
    config: ConsiliumConfig,
    requested: string[] | undefined,
    hooks: ConsiliumConfig['hooks']
  ): ConsiliumConfig['experts'] {
    if (requested && requested.length > 0) {
      const wanted = new Set(requested);
      const available = new Set(config.experts.map(expert => expert.name));
      const missing = requested.filter(name => !available.has(name));
      if (missing.length > 0) {
        hooks?.onLog?.('warn', `Неизвестные эксперты пропущены: ${missing.join(', ')}`);
      }
      const experts = config.experts.filter(
        expert => wanted.has(expert.name) && expert.enabled !== false
      );
      if (experts.length === 0) {
        throw new Error(
          `Выбранные эксперты недоступны: ${requested.join(', ')}. Доступны: ${[...available].join(', ')}`
        );
      }
      return experts;
    }

    const experts = config.experts.filter(expert => expert.enabled !== false);
    if (experts.length === 0) {
      throw new Error('Нет активных экспертов для консилиума');
    }
    return experts;
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

  private saveResult(
    result: ConsiliumResult,
    outputPath: string,
    config: ConsiliumConfig
  ): string {
    const baseDir = config.cwd ? resolve(config.cwd) : process.cwd();
    const fullPath = resolve(baseDir, outputPath);
    const dir = dirname(fullPath);

    if (outputPath.trim().length === 0) {
      throw new Error('Пустой путь для сохранения результата');
    }

    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    let content: string;
    switch (config.output.format) {
      case 'json':
        content = JSON.stringify(result, null, 2);
        break;
      case 'markdown':
        content = this.formatAsMarkdown(result);
        break;
      default:
        content = result.text;
    }

    const temporary = `${fullPath}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    try {
      writeFileSync(temporary, content, 'utf-8');
      renameSync(temporary, fullPath);
    } catch (error) {
      try {
        if (existsSync(temporary)) {
          unlinkSync(temporary);
        }
      } catch {
        // Очистка необязательна
      }
      throw error;
    }
    return fullPath;
  }

  /**
   * Сохраняет артефакт запуска, если он включён.
   * Ошибка сохранения не должна ломать сам запуск.
   */
  private saveArtifactRun(
    result: ConsiliumResult,
    task: string,
    setting: boolean | string | undefined,
    runConfig: ConsiliumConfig,
    hooks: ConsiliumConfig['hooks'] | undefined
  ): void {
    if (setting === undefined || setting === false) return;

    try {
      const metadata = result.metadata ?? {};
      const metaModels = metadata.models;
      const models =
        metaModels !== null && typeof metaModels === 'object' && !Array.isArray(metaModels)
          ? (metaModels as Record<string, string>)
          : collectModels([...result.experts, result.chair]);
      const run: ArtifactRun = {
        version: 1,
        id: createArtifactId(),
        createdAt: new Date().toISOString(),
        task,
        success: result.success,
        text: result.text,
        experts: result.experts.map(expert => ({
          agent: expert.agent,
          model: expert.model,
          success: expert.success,
          errorCode: expert.errorCode,
          errorMessage: expert.errorMessage,
          duration: expert.duration,
          text: expert.text,
          usage: expert.usage
        })),
        models,
        chairAgent: result.chair.agent,
        usage: result.usage,
        consensus: metadata.consensus,
        metadata
      };

      const root = resolveArtifactRoot({ artifacts: setting, cwd: runConfig.cwd });
      const ref = saveArtifact(run, { root });
      result.metadata = {
        ...metadata,
        artifacts: { id: ref.id, dir: ref.dir }
      };
    } catch (error) {
      result.metadata = {
        ...(result.metadata ?? {}),
        artifactsError: (error as Error).message
      };
      hooks?.onLog?.('warn', `Не удалось сохранить артефакт: ${(error as Error).message}`);
    }
  }

  private formatAsMarkdown(result: ConsiliumResult): string {
    let md = `# Результат консилиума\n\n`;
    md += `**Время выполнения:** ${(result.totalTime / 1000).toFixed(1)}с\n\n`;
    if (result.usage?.cost) {
      md += `**Стоимость:** $${result.usage.cost.toFixed(6)}\n\n`;
    }
    md += `---\n\n`;
    md += result.text;
    md += `\n\n---\n\n`;
    md += `## Мнения экспертов\n\n`;

    for (const expert of result.experts) {
      const model = expert.model ? ` (${expert.model})` : '';
      md += `### ${expert.agent.toUpperCase()}${model}\n`;
      md += `${expert.success ? '' : '⚠️ '}${expert.text}\n\n`;
    }

    return md;
  }

  private createCancelledResult(
    experts: AgentResult[],
    chair: AgentResult | undefined,
    parallelTime: number,
    config: ConsiliumConfig
  ): ConsiliumResult {
    return {
      text: '[Консилиум отменён]',
      experts,
      chair: chair || {
        agent: config.chair.agent,
        text: '[Отменено]',
        success: false,
        errorCode: 'CANCELLED'
      },
      totalTime: Date.now() - this.startTime,
      parallelTime,
      success: false,
      usage: sumUsage(chair ? [...experts, chair] : experts),
      metadata: { cancelled: true }
    };
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
export * from './types.js';
export * from './config.js';
export * from './agents.js';
export * from './models.js';
export * from './presets.js';
export * from './compat.js';
export * from './artifacts.js';
export * from './consensus.js';
export * from './smart-experts.js';
export * from './fallback.js';
export * from './report.js';
export * from './watch.js';
export * from './variants.js';
export * from './replay.js';
export * from './verify.js';
export { DEFAULT_CONFIG } from './defaults.js';
