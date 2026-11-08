/**
 * @fileoverview Загрузка, слияние с умолчаниями и валидация конфигурации
 * @module lv24-opencode-consilium
 */

import { existsSync } from 'fs';
import { resolve } from 'path';
import type {
  ConsiliumConfig,
  ExpertConfig
} from '../../domain/types.js';
import {
  DEFAULT_CONFIG,
  DEFAULT_EXPERT_PROMPTS,
  CONFIG_FILE_NAMES,
  EXCLUDED_AGENTS
} from '../../domain/defaults.js';
import { readAgentDefinition } from './compat.js';
import { isValidVariant, variantOf, withVariant } from '../../domain/council/variants.js';
import { readJsonFile, isRecord } from './jsonc.js';
import {
  loadOpenCodeAgents,
  extractAgentsFromOpenCode
} from './opencode.js';

/**
 * Результат загрузки конфигурации
 */
export interface ConfigLoadResult {
  config: ConsiliumConfig;
  configPath: string | null;
  warnings: string[];
  errors?: string[];
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

  // Вариант модели — общий дефолт для моделей без собственного #variant.
  if (result.variant !== undefined && isValidVariant(result.variant)) {
    const variant = result.variant;
    result.experts = result.experts.map(expert => {
      if (expert.model === undefined || !expert.model.includes('/')) return expert;
      if (variantOf(expert.model) !== undefined) return expert;
      return { ...expert, model: withVariant(expert.model, variant) };
    });
    if (
      result.chair.model !== undefined &&
      result.chair.model.includes('/') &&
      variantOf(result.chair.model) === undefined
    ) {
      result.chair = {
        ...result.chair,
        model: withVariant(result.chair.model, variant)
      };
    }
  }

  return result;
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
    if (config.retry.jitter !== undefined && typeof config.retry.jitter !== 'boolean') {
      warnings.push('retry.jitter должен быть boolean.');
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

  if (
    config.maxCost !== undefined &&
    (!Number.isFinite(config.maxCost) || config.maxCost < 0)
  ) {
    warnings.push('maxCost должен быть числом >= 0 (USD).');
  }

  if (config.fallbackModels !== undefined) {
    if (!Array.isArray(config.fallbackModels)) {
      warnings.push('fallbackModels должен быть массивом моделей provider/model.');
    } else {
      const invalid = config.fallbackModels.filter(
        model => typeof model !== 'string' || !isValidModelId(model)
      );
      if (invalid.length > 0) {
        warnings.push(`Некорректные fallbackModels: ${invalid.join(', ')}`);
      }
    }
  }

  if (
    config.session !== undefined &&
    (typeof config.session !== 'string' || config.session.trim().length === 0)
  ) {
    warnings.push('session должен быть непустой строкой.');
  }

  if (config.report !== undefined && !['html', 'pr', 'markdown'].includes(config.report)) {
    warnings.push(`Неизвестный формат отчёта: ${String(config.report)}`);
  }
  if (config.reportFile !== undefined && config.reportFile.trim().length === 0) {
    warnings.push('reportFile должен быть непустым путём.');
  }
  if (config.variant !== undefined && !isValidVariant(config.variant)) {
    warnings.push(`Некорректный вариант модели: ${config.variant}`);
  }
  if (
    config.debounceMs !== undefined &&
    (!Number.isInteger(config.debounceMs) || config.debounceMs < 0)
  ) {
    warnings.push('debounceMs должен быть целым числом >= 0.');
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
    const snapshot = loadOpenCodeAgents({
      opencodeConfigPath: userConfig.opencodeConfigPath,
      cwd: userConfig.cwd
    });

    if (snapshot.warning !== undefined) {
      warnings.push(snapshot.warning);
    }

    if (snapshot.section !== null) {
      const section = snapshot.section;
      const excludedAgents = [...EXCLUDED_AGENTS, ...(userConfig.excludedAgents || [])];
      const discovered = extractAgentsFromOpenCode(section, excludedAgents);
      if (discovered.length > 0 && !userConfig.experts) {
        userConfig.experts = discovered;
      }

      if (section.duplicated.length > 0) {
        warnings.push(
          `Агенты заданы и в agent, и в agents (OpenCode V2 использует agents): ${section.duplicated.join(', ')}. ` +
            'Оставьте одно определение, иначе V1 и V2 могут взять разные модели.'
        );
      }

      // Модель председателя тоже берём из opencode.json, чтобы отчёты были точными.
      const chairName = userConfig.chair?.agent ?? DEFAULT_CONFIG.chair.agent;
      const chairEntry = section.entries[chairName];
      const chairModel = chairEntry === undefined ? undefined : readAgentDefinition(chairEntry).model;
      if (chairModel !== undefined && chairModel.length > 0) {
        userConfig.chair = {
          ...(userConfig.chair ?? { agent: DEFAULT_CONFIG.chair.agent }),
          model: chairModel
        };
      }
    } else if (snapshot.path !== null) {
      warnings.push(
        `Не удалось прочитать ${snapshot.path}: ${snapshot.error ?? 'неизвестная ошибка'}`
      );
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
