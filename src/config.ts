/**
 * @fileoverview Загрузчик конфигурации
 * @module opencode-consilium
 */

import { readFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { dirname, resolve } from 'path';
import type {
  ConsiliumConfig,
  ExpertConfig
} from './types.js';
import {
  DEFAULT_CONFIG,
  DEFAULT_EXPERT_PROMPTS,
  CONFIG_FILE_NAMES,
  EXCLUDED_AGENTS
} from './defaults.js';

/**
 * Результат загрузки конфигурации
 */
export interface ConfigLoadResult {
  config: ConsiliumConfig;
  configPath: string | null;
  warnings: string[];
  errors?: string[];
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Удаляет комментарии и висячие запятые из JSONC, не трогая строки
 */
export function stripJsonComments(text: string): string {
  let result = '';
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;
  let escaped = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i] ?? '';
    const next = text[i + 1] ?? '';

    if (inLineComment) {
      if (char === '\n') {
        inLineComment = false;
        result += char;
      }
      continue;
    }

    if (inBlockComment) {
      if (char === '*' && next === '/') {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }

    if (inString) {
      result += char;
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      result += char;
      continue;
    }

    if (char === '/' && next === '/') {
      inLineComment = true;
      i += 1;
      continue;
    }

    if (char === '/' && next === '*') {
      inBlockComment = true;
      i += 1;
      continue;
    }

    result += char;
  }

  return removeTrailingCommas(result);
}

function removeTrailingCommas(text: string): string {
  let result = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i] ?? '';

    if (inString) {
      result += char;
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      result += char;
      continue;
    }

    if (char === ',') {
      let lookahead = i + 1;
      while (lookahead < text.length && /\s/.test(text[lookahead] ?? '')) {
        lookahead += 1;
      }
      const following = text[lookahead];
      if (following === '}' || following === ']') {
        continue;
      }
    }

    result += char;
  }

  return result;
}

/**
 * Читает JSON/JSONC файл
 */
export function readJsonFile(path: string): unknown {
  const content = readFileSync(path, 'utf-8').replace(/^\uFEFF/, '');
  return JSON.parse(stripJsonComments(content));
}

/**
 * Глубокое клонирование конфигурации с сохранением функций
 */
export function cloneConfig(config: ConsiliumConfig): ConsiliumConfig {
  return {
    ...config,
    experts: config.experts.map(expert => ({ ...expert })),
    chair: { ...config.chair },
    excludedAgents: config.excludedAgents ? [...config.excludedAgents] : undefined,
    timeouts: { ...config.timeouts },
    retry: { ...config.retry },
    output: { ...config.output },
    hooks: config.hooks ? { ...config.hooks } : undefined,
    opencodeArgs: config.opencodeArgs ? [...config.opencodeArgs] : undefined,
    plugins: config.plugins ? [...config.plugins] : undefined
  };
}

/**
 * Объединяет частичный конфиг с конфигурацией по умолчанию
 */
export function mergeWithDefaults(partial: Partial<ConsiliumConfig>): ConsiliumConfig {
  const base = cloneConfig(DEFAULT_CONFIG);
  const result: ConsiliumConfig = {
    ...base,
    ...partial,
    experts: partial.experts ? partial.experts.map(expert => ({ ...expert })) : base.experts,
    chair: { ...base.chair, ...partial.chair },
    excludedAgents: partial.excludedAgents ? [...partial.excludedAgents] : base.excludedAgents,
    timeouts: { ...base.timeouts, ...partial.timeouts },
    retry: { ...base.retry, ...partial.retry },
    output: { ...base.output, ...partial.output },
    hooks: partial.hooks ?? base.hooks,
    opencodeArgs: partial.opencodeArgs ? [...partial.opencodeArgs] : base.opencodeArgs,
    plugins: partial.plugins ? [...partial.plugins] : base.plugins
  };
  return result;
}

/**
 * Находит путь к файлу конфигурации OpenCode (проект → глобальный)
 */
function findOpenCodeConfigPath(configuredPath?: string): string | null {
  const candidates: string[] = [];
  if (configuredPath) {
    candidates.push(resolve(process.cwd(), configuredPath));
    if (!configuredPath.endsWith('.jsonc')) {
      candidates.push(resolve(process.cwd(), `${configuredPath}c`));
    }
  } else {
    const cwd = process.cwd();
    candidates.push(resolve(cwd, 'opencode.json'));
    candidates.push(resolve(cwd, 'opencode.jsonc'));
    const configHome = process.env.XDG_CONFIG_HOME || resolve(homedir(), '.config');
    candidates.push(resolve(configHome, 'opencode', 'opencode.json'));
    candidates.push(resolve(configHome, 'opencode', 'opencode.jsonc'));
  }

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Извлекает агентов из opencode.json
 */
function extractAgentsFromOpenCode(
  openCodeConfig: unknown,
  excludedAgents: string[]
): ExpertConfig[] {
  if (!isRecord(openCodeConfig)) return [];
  const agentSection = openCodeConfig.agent;
  if (!isRecord(agentSection)) return [];

  const excluded = new Set(excludedAgents);
  const agents: ExpertConfig[] = [];
  let priority = 1;

  for (const [name, raw] of Object.entries(agentSection)) {
    if (excluded.has(name)) continue;
    const definition = isRecord(raw) ? raw : {};
    if (definition.mode === 'subagent') continue;
    if (definition.disable === true) continue;

    const model = typeof definition.model === 'string' ? definition.model : undefined;

    // prompt в opencode.json — это системный промпт агента, OpenCode применит его сам.
    // Для пользовательского сообщения берём task-aware промпт роли по умолчанию.
    agents.push({
      name,
      enabled: true,
      priority,
      model,
      prompt: Object.prototype.hasOwnProperty.call(DEFAULT_EXPERT_PROMPTS, name)
        ? DEFAULT_EXPERT_PROMPTS[name]
        : DEFAULT_EXPERT_PROMPTS.default
    });
    priority += 1;
  }

  return agents;
}

/**
 * Проверяет формат модели
 */
export function isValidModelId(model: string): boolean {
  return /^[A-Za-z0-9._:@/#+-]+$/.test(model) && model.includes('/');
}

/**
 * Валидирует конфигурацию
 */
export function validateConfig(config: ConsiliumConfig): string[] {
  const warnings: string[] = [];

  if (!Array.isArray(config.experts)) {
    warnings.push('Поле experts должно быть массивом. Используются эксперты по умолчанию.');
    return warnings;
  }

  if (config.experts.length === 0) {
    warnings.push('Список экспертов пуст. Добавьте хотя бы одного эксперта.');
  }

  for (const expert of config.experts) {
    if (!expert || typeof expert.name !== 'string' || expert.name.trim().length === 0) {
      warnings.push('Обнаружен эксперт без имени.');
    } else if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/.test(expert.name)) {
      warnings.push(`Некорректное имя эксперта: ${expert.name}`);
    }
    if (expert?.model && !isValidModelId(expert.model)) {
      warnings.push(`Некорректный id модели у эксперта ${expert.name}: ${expert.model}`);
    }
    if (expert?.timeout !== undefined && (!Number.isFinite(expert.timeout) || expert.timeout <= 0)) {
      warnings.push(`Некорректный таймаут эксперта ${expert.name}.`);
    }
  }

  const names = config.experts.map(e => e?.name).filter((name): name is string => Boolean(name));
  const duplicates = names.filter((n, i) => names.indexOf(n) !== i);
  if (duplicates.length > 0) {
    warnings.push(`Обнаружены дубликаты экспертов: ${[...new Set(duplicates)].join(', ')}`);
  }

  if (!isRecord(config.chair) || typeof config.chair.agent !== 'string' || config.chair.agent.length === 0) {
    warnings.push('Не указан агент-председатель.');
  } else if (config.chair.model && !isValidModelId(config.chair.model)) {
    warnings.push(`Некорректный id модели председателя: ${config.chair.model}`);
  }

  if (!isRecord(config.timeouts)) {
    warnings.push('Секция timeouts отсутствует или некорректна.');
  } else {
    for (const key of ['expert', 'chair', 'shutdown'] as const) {
      const value = config.timeouts[key];
      if (!Number.isFinite(value) || value <= 0) {
        warnings.push(`Некорректный таймаут ${key}.`);
      }
    }
    if (Number.isFinite(config.timeouts.expert) && config.timeouts.expert < 10000) {
      warnings.push('Таймаут эксперта слишком маленький (< 10 сек). Возможны ложные таймауты.');
    }
    if (Number.isFinite(config.timeouts.chair) && config.timeouts.chair < 30000) {
      warnings.push('Таймаут председателя слишком маленький (< 30 сек). Возможны ложные таймауты.');
    }
  }

  if (!isRecord(config.retry)) {
    warnings.push('Секция retry отсутствует или некорректна.');
  } else {
    if (!Number.isInteger(config.retry.expertRetries) || config.retry.expertRetries < 0) {
      warnings.push('retry.expertRetries должен быть целым числом >= 0.');
    }
    if (!Number.isInteger(config.retry.chairRetries) || config.retry.chairRetries < 0) {
      warnings.push('retry.chairRetries должен быть целым числом >= 0.');
    }
    if (!Number.isFinite(config.retry.delay) || config.retry.delay < 0) {
      warnings.push('retry.delay должен быть числом >= 0.');
    }
    if (
      config.retry.maxConcurrency !== undefined &&
      (!Number.isInteger(config.retry.maxConcurrency) || config.retry.maxConcurrency < 1 || config.retry.maxConcurrency > 8)
    ) {
      warnings.push('retry.maxConcurrency должен быть целым числом от 1 до 8.');
    }
  }

  if (!isRecord(config.output)) {
    warnings.push('Секция output отсутствует или некорректна.');
  } else if (!['text', 'markdown', 'json'].includes(config.output.format)) {
    warnings.push(`Неизвестный формат вывода: ${String(config.output.format)}`);
  }

  return warnings;
}

/**
 * Находит файл конфигурации
 */
function findConfigFile(explicitPath?: string): string | null {
  if (explicitPath) {
    const resolved = resolve(process.cwd(), explicitPath);
    return existsSync(resolved) ? resolved : null;
  }

  for (const fileName of CONFIG_FILE_NAMES) {
    const filePath = resolve(process.cwd(), fileName);
    if (existsSync(filePath)) {
      return filePath;
    }
  }

  return null;
}

/**
 * Нормализует промпт из конфига
 */
function parsePromptConfig(
  promptConfig: unknown,
  expertName: string
): string | ((task: string) => string) {
  if (typeof promptConfig === 'string') {
    return promptConfig;
  }
  if (typeof promptConfig === 'function') {
    return promptConfig as (task: string) => string;
  }
  if (Object.prototype.hasOwnProperty.call(DEFAULT_EXPERT_PROMPTS, expertName)) {
    return DEFAULT_EXPERT_PROMPTS[expertName] ?? ((task: string) => task);
  }
  return DEFAULT_EXPERT_PROMPTS.default ?? ((task: string) => task);
}

/**
 * Загружает конфигурацию из файла
 */
export function loadConfig(explicitPath?: string): ConfigLoadResult {
  const warnings: string[] = [];
  const errors: string[] = [];
  const configPath = findConfigFile(explicitPath);

  if (explicitPath && !configPath) {
    const message = `Файл конфигурации не найден: ${explicitPath}. Используются значения по умолчанию.`;
    warnings.push(message);
    errors.push(message);
  }

  let userConfig: Partial<ConsiliumConfig> = {};

  if (configPath) {
    try {
      const parsed = readJsonFile(configPath);
      if (isRecord(parsed)) {
        userConfig = parsed as Partial<ConsiliumConfig>;
      } else {
        const message = `Конфигурация ${configPath} должна быть JSON-объектом.`;
        warnings.push(message);
        errors.push(message);
      }
    } catch (error) {
      const message = `Ошибка при чтении ${configPath}: ${(error as Error).message}`;
      warnings.push(message);
      errors.push(message);
    }
  }

  if (Array.isArray(userConfig.experts)) {
    userConfig.experts = userConfig.experts
      .filter((expert): expert is ExpertConfig => isRecord(expert) && typeof expert.name === 'string')
      .map(expert => ({
        ...expert,
        prompt: parsePromptConfig(expert.prompt, expert.name)
      }));
  } else if (userConfig.experts !== undefined) {
    warnings.push('Поле experts должно быть массивом. Используются эксперты по умолчанию.');
    delete userConfig.experts;
  }

  // Автоопределение агентов из opencode.json, если эксперты не заданы явно
  if (userConfig.autoDiscoverAgents !== false) {
    const openCodePath = findOpenCodeConfigPath(userConfig.opencodeConfigPath);
    if (openCodePath) {
      try {
        const openCodeConfig = readJsonFile(openCodePath);
        const excludedAgents = [...EXCLUDED_AGENTS, ...(userConfig.excludedAgents || [])];
        const discovered = extractAgentsFromOpenCode(openCodeConfig, excludedAgents);
        if (discovered.length > 0 && !userConfig.experts) {
          userConfig.experts = discovered;
        }

        // Модель председателя тоже берём из opencode.json, чтобы отчёты были точными.
        if (isRecord(openCodeConfig)) {
          const agentSection = openCodeConfig.agent;
          const chairName = userConfig.chair?.agent ?? DEFAULT_CONFIG.chair.agent;
          if (isRecord(agentSection) && isRecord(agentSection[chairName])) {
            const chairModel = agentSection[chairName].model;
            if (typeof chairModel === 'string' && chairModel.length > 0) {
              userConfig.chair = {
                ...(userConfig.chair ?? { agent: DEFAULT_CONFIG.chair.agent }),
                model: chairModel
              };
            }
          }
        }
      } catch (error) {
        warnings.push(`Не удалось прочитать ${openCodePath}: ${(error as Error).message}`);
      }
    }
  }

  const mergedConfig = mergeWithDefaults(userConfig);
  warnings.push(...validateConfig(mergedConfig));

  return {
    config: mergedConfig,
    configPath,
    warnings,
    errors
  };
}

/**
 * Создаёт минимальный конфиг
 */
export function createMinimalConfig(experts: string[] = []): ConsiliumConfig {
  const expertConfigs: ExpertConfig[] = experts.length > 0
    ? experts.map((name, index) => ({
        name,
        enabled: true,
        priority: index + 1,
        prompt: Object.prototype.hasOwnProperty.call(DEFAULT_EXPERT_PROMPTS, name)
          ? DEFAULT_EXPERT_PROMPTS[name] ?? ((task: string) => task)
          : DEFAULT_EXPERT_PROMPTS.default ?? ((task: string) => task)
      }))
    : DEFAULT_CONFIG.experts.map(expert => ({ ...expert }));

  return mergeWithDefaults({ experts: expertConfigs });
}

/**
 * Генерирует пример конфигурационного файла
 */
export function generateExampleConfig(): string {
  return JSON.stringify(
    {
      version: '1.1.0',
      experts: [
        {
          name: 'arch',
          enabled: true,
          priority: 1,
          timeout: 300000,
          retries: 1,
          prompt: 'Как архитектор, проанализируй задачу кратко (3-5 предложений): ${task}'
        },
        {
          name: 'ux',
          enabled: true,
          priority: 2
        },
        {
          name: 'ba',
          enabled: true,
          priority: 3
        },
        {
          name: 'sec',
          enabled: true,
          priority: 4
        }
      ],
      chair: {
        agent: 'consilium',
        timeout: 600000,
        maxExpertTextLength: 3000
      },
      excludedAgents: [...EXCLUDED_AGENTS],
      timeouts: {
        expert: 300000,
        chair: 600000,
        shutdown: 5000
      },
      retry: {
        expertRetries: 1,
        chairRetries: 1,
        delay: 1000,
        exponentialBackoff: true,
        maxConcurrency: 3
      },
      output: {
        file: false,
        format: 'markdown',
        progress: true,
        logLevel: 'info'
      },
      standalone: true,
      autoApprove: false,
      autoDiscoverAgents: true,
      opencodeConfigPath: 'opencode.json'
    },
    null,
    2
  );
}

/**
 * Возвращает директорию конфигурационного файла (для относительных путей)
 */
export function configDirectory(configPath: string | null): string {
  return configPath ? dirname(configPath) : process.cwd();
}
