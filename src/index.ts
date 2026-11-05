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
      const parallelStarted = Date.now();
      const expertResults = await callExpertsParallel(selectedExperts, task, runConfig, { controller });
      const parallelTime = Date.now() - parallelStarted;

      if (controller.isCancelled()) {
        const result = this.createCancelledResult(expertResults, undefined, parallelTime, runConfig);
        this.status = 'cancelled';
        await hooks.onEnd?.(result);
        return result;
      }

      this.status = 'running_chair';
      const chairAgent = options.chair ?? runConfig.chair.agent;
      runConfig.chair.agent = chairAgent;

      const chairResult = await callChair(expertResults, task, runConfig, { controller });

      if (controller.isCancelled()) {
        const result = this.createCancelledResult(expertResults, chairResult, parallelTime, runConfig);
        this.status = 'cancelled';
        await hooks.onEnd?.(result);
        return result;
      }

      this.status = 'completed';

      const models: Record<string, string> = {};
      for (const expert of expertResults) {
        if (expert.model) models[expert.agent] = expert.model;
      }
      if (chairResult.model) models[chairResult.agent] = chairResult.model;

      const result: ConsiliumResult = {
        text: chairResult.text,
        experts: expertResults,
        chair: chairResult,
        totalTime: Date.now() - this.startTime,
        parallelTime,
        success: chairResult.success,
        usage: sumUsage([...expertResults, chairResult]),
        metadata: {
          ...options.metadata,
          models
        }
      };

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
export * from './verify.js';
export { DEFAULT_CONFIG } from './defaults.js';
