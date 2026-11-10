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
  mergePresets,
  PRESET_NAME_PATTERN,
  type CouncilPreset,
  type CustomPresetConfig
} from '../../domain/council/presets.js';
import { MAX_DEADLINE_MS, sanitizeDeadlineMs } from '../../application/run.js';
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
 * Опции загрузки конфигурации
 */
export interface LoadConfigOptions {
  /**
   * Явно доверять конфигурации проекта (CLI `-c`).
   * По умолчанию `false`: опасные ключи из файла игнорируются.
   */
  trustProjectConfig?: boolean;
}

/** Символ-метка конфигурации, которой явно доверяет вызывающий код */
export const TRUSTED_PROJECT_CONFIG = Symbol.for('lv24-opencode-consilium.trustedProjectConfig');

/** Проверяет, была ли конфигурация загружена с явным доверием */
export function isTrustedProjectConfig(config: unknown): boolean {
  return (
    typeof config === 'object' &&
    config !== null &&
    (config as Record<PropertyKey, unknown>)[TRUSTED_PROJECT_CONFIG] === true
  );
}

function markTrustedProjectConfig(config: ConsiliumConfig): void {
  Object.defineProperty(config, TRUSTED_PROJECT_CONFIG, {
    value: true,
    // Enumerable symbols survive object spread (`{ ...config }`), which is how
    // presets, deadline prompts and CLI overrides build derived configs. JSON
    // serialization ignores symbol keys, so this never leaks into files.
    enumerable: true,
    configurable: true
  });
}

/** Копирует пользовательские пресеты, не деля массивы `experts` с исходником */
function clonePresets(presets?: CustomPresetConfig): CustomPresetConfig | undefined {
  if (presets === undefined) return undefined;
  const cloned: CustomPresetConfig = {};
  for (const [name, preset] of Object.entries(presets)) {
    const copy: Partial<CouncilPreset> = { ...preset };
    if (preset.experts !== undefined) copy.experts = [...preset.experts];
    cloned[name] = copy;
  }
  return Object.keys(cloned).length > 0 ? cloned : undefined;
}

/**
 * Глубокое клонирование конфигурации с сохранением функций
 */
export function cloneConfig(config: ConsiliumConfig): ConsiliumConfig {
  const cloned: ConsiliumConfig = {
    ...config,
    experts: config.experts.map(expert => ({ ...expert })),
    chair: { ...config.chair },
    excludedAgents: Array.isArray(config.excludedAgents)
      ? [...config.excludedAgents]
      : undefined,
    timeouts: { ...config.timeouts },
    retry: { ...config.retry },
    output: { ...config.output },
    hooks: config.hooks ? { ...config.hooks } : undefined,
    opencodeArgs: config.opencodeArgs ? [...config.opencodeArgs] : undefined,
    plugins: config.plugins ? [...config.plugins] : undefined,
    presets: clonePresets(config.presets)
  };
  if (isTrustedProjectConfig(config)) {
    markTrustedProjectConfig(cloned);
  }
  return cloned;
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
    excludedAgents: Array.isArray(partial.excludedAgents)
      ? [...partial.excludedAgents]
      : base.excludedAgents,
    timeouts: { ...base.timeouts, ...partial.timeouts },
    retry: { ...base.retry, ...partial.retry },
    output: { ...base.output, ...partial.output },
    hooks: partial.hooks ?? base.hooks,
    opencodeArgs: partial.opencodeArgs ? [...partial.opencodeArgs] : base.opencodeArgs,
    plugins: partial.plugins ? [...partial.plugins] : base.plugins,
    // Валидные пресеты клонируются; некорректное значение сохраняется, чтобы
    // validateConfig мог сообщить о нём (loadConfig отбрасывает его раньше).
    presets:
      partial.presets === undefined
        ? clonePresets(base.presets)
        : isRecord(partial.presets)
          ? clonePresets(partial.presets as CustomPresetConfig)
          : partial.presets
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

  if (isTrustedProjectConfig(partial)) {
    markTrustedProjectConfig(result);
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

  if (config.localOnly !== undefined && typeof config.localOnly !== 'boolean') {
    warnings.push('Поле localOnly должно быть boolean.');
  }

  if (config.readOnly !== undefined && typeof config.readOnly !== 'boolean') {
    warnings.push('Поле readOnly должно быть boolean.');
  }

  if (config.isolate !== undefined && typeof config.isolate !== 'boolean') {
    warnings.push('Поле isolate должно быть boolean.');
  }

  if (config.presets !== undefined) {
    if (config.presets === null) {
      warnings.push('Поле presets должно быть объектом; значение проигнорировано.');
    } else {
      warnings.push(...mergePresets(config.presets).warnings);
    }
  }

  if (config.deadlineMs !== undefined) {
    const value = config.deadlineMs;
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
      warnings.push(
        'deadlineMs должен быть положительным целым числом (мс); значение проигнорировано.'
      );
      delete config.deadlineMs;
    } else if (value > MAX_DEADLINE_MS) {
      warnings.push(
        `deadlineMs не может превышать 24 часа; значение ограничено ${MAX_DEADLINE_MS} мс.`
      );
      config.deadlineMs = sanitizeDeadlineMs(value);
    } else {
      config.deadlineMs = sanitizeDeadlineMs(value);
    }
  }

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

  if (config.findings !== undefined && typeof config.findings !== 'boolean') {
    warnings.push('findings должен быть boolean.');
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

  if (
    config.report !== undefined &&
    !['html', 'pr', 'markdown', 'sarif', 'jira', 'linear'].includes(config.report)
  ) {
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
  if (config.context !== undefined && config.context !== 'off' && config.context !== 'auto') {
    warnings.push(`context должен быть "off" или "auto", получено: ${String(config.context)}`);
  }

  if (config.rounds !== undefined) {
    if (config.rounds !== 1 && config.rounds !== 2) {
      warnings.push('rounds должен быть 1 или 2; используется 1.');
      config.rounds = 1;
    }
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

/** Допустимое имя агента из конфигурации проекта */
const SAFE_AGENT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/;

function warnIgnoredProjectKey(warnings: string[], key: string): void {
  warnings.push(
    `Ключ "${key}" проигнорирован в целях безопасности (was ignored for safety): ` +
      'конфигурация проекта не является доверенной. ' +
      'Чтобы использовать его, передайте файл явно через explicit -c <path>.'
  );
}

/**
 * Удаляет опасные для запуска ключи из недоверенной конфигурации проекта.
 * Безопасные значения (`artifacts: boolean`, `output.file: false`) сохраняются.
 */
function applyProjectConfigTrustPolicy(
  userConfig: Partial<ConsiliumConfig>,
  trustProjectConfig: boolean,
  warnings: string[]
): void {
  if (trustProjectConfig) return;

  const processKeys = ['opencodePath', 'opencodeArgs', 'autoApprove', 'cwd', 'opencodeConfigPath'] as const;
  for (const key of processKeys) {
    if (Object.prototype.hasOwnProperty.call(userConfig, key)) {
      delete userConfig[key];
      warnIgnoredProjectKey(warnings, key);
    }
  }

  if (isRecord(userConfig.output) && typeof userConfig.output.file === 'string') {
    delete (userConfig.output as { file?: string | false }).file;
    warnIgnoredProjectKey(warnings, 'output.file');
  }

  if (Object.prototype.hasOwnProperty.call(userConfig, 'reportFile')) {
    delete userConfig.reportFile;
    warnIgnoredProjectKey(warnings, 'reportFile');
  }

  if (typeof userConfig.artifacts === 'string') {
    delete userConfig.artifacts;
    warnIgnoredProjectKey(warnings, 'artifacts');
  }
}

/** Проверяет имя агента-председателя и откатывается к безопасному умолчанию */
function sanitizeChairAgent(
  userConfig: Partial<ConsiliumConfig>,
  warnings: string[]
): void {
  if (!isRecord(userConfig.chair)) return;
  const agent = userConfig.chair.agent;
  if (typeof agent === 'string' && SAFE_AGENT_NAME_PATTERN.test(agent)) return;

  if (agent !== undefined) {
    warnings.push(
      `Некорректное имя агента-председателя "${String(agent)}". ` +
        `Используется ${DEFAULT_CONFIG.chair.agent}.`
    );
  }
  userConfig.chair = {
    ...userConfig.chair,
    agent: DEFAULT_CONFIG.chair.agent
  };
}

/**
 * Проверяет excludedAgents: не массив строк — предупреждение, значение
 * игнорируется, чтобы автоопределение агентов не падало с TypeError.
 */
function sanitizeExcludedAgents(
  userConfig: Partial<ConsiliumConfig>,
  warnings: string[]
): void {
  if (userConfig.excludedAgents === undefined) return;

  const value: unknown = userConfig.excludedAgents;
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    warnings.push(
      'Поле excludedAgents должно быть массивом строк; значение проигнорировано.'
    );
    delete userConfig.excludedAgents;
  }
}

/** Проверяет localOnly: не boolean — предупреждение, значение игнорируется */
function sanitizeLocalOnly(
  userConfig: Partial<ConsiliumConfig>,
  warnings: string[]
): void {
  if (userConfig.localOnly === undefined) return;
  if (typeof userConfig.localOnly !== 'boolean') {
    warnings.push('Поле localOnly должно быть boolean; значение проигнорировано.');
    delete userConfig.localOnly;
  }
}

/**
 * Проверяет пользовательские пресеты через mergePresets и оставляет в
 * конфигурации только нормализованные пользовательские записи.
 */
function sanitizePresets(
  userConfig: Partial<ConsiliumConfig>,
  warnings: string[]
): void {
  if (userConfig.presets === undefined) return;

  const raw: unknown = userConfig.presets;
  const merged = mergePresets(raw as CustomPresetConfig);
  warnings.push(...merged.warnings);

  if (raw === null) {
    warnings.push('Поле presets должно быть объектом; значение проигнорировано.');
    delete userConfig.presets;
    return;
  }
  if (!isRecord(raw)) {
    delete userConfig.presets;
    return;
  }

  const custom: CustomPresetConfig = {};
  for (const [name, entry] of Object.entries(raw)) {
    if (!PRESET_NAME_PATTERN.test(name) || !isRecord(entry)) continue;
    const preset = merged.presets[name];
    if (preset === undefined) continue;
    const partial: Partial<CouncilPreset> = { ...preset };
    delete partial.name;
    if (partial.experts !== undefined) partial.experts = [...partial.experts];
    custom[name] = partial;
  }

  if (Object.keys(custom).length > 0) {
    userConfig.presets = custom;
  } else {
    delete userConfig.presets;
  }
}

/** Удаляет экспертов с недопустимыми именами (включая найденных в opencode.json) */
function sanitizeExpertNames(
  userConfig: Partial<ConsiliumConfig>,
  warnings: string[]
): void {
  if (!Array.isArray(userConfig.experts)) return;

  const validExperts: ExpertConfig[] = [];
  for (const expert of userConfig.experts) {
    if (!isRecord(expert) || typeof expert.name !== 'string') continue;
    if (!SAFE_AGENT_NAME_PATTERN.test(expert.name)) {
      warnings.push(
        `Некорректное имя эксперта "${expert.name}"; ` +
          'эксперт удалён из конфигурации проекта.'
      );
      continue;
    }
    validExperts.push(expert);
  }

  if (validExperts.length === 0) {
    warnings.push(
      'Список экспертов пуст после проверки имён; используются эксперты по умолчанию.'
    );
    delete userConfig.experts;
    return;
  }

  userConfig.experts = validExperts;
}

/**
 * Загружает конфигурацию из файла
 */
export function loadConfig(
  explicitPath?: string,
  options: LoadConfigOptions = {}
): ConfigLoadResult {
  const trustProjectConfig = options.trustProjectConfig === true;
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

  // Политика доверия: опасные ключи проекта удаляются до merge/валидации и до
  // автоопределения, чтобы они не влияли на пути запуска и рабочую директорию.
  applyProjectConfigTrustPolicy(userConfig, trustProjectConfig, warnings);
  sanitizeChairAgent(userConfig, warnings);
  sanitizeLocalOnly(userConfig, warnings);
  sanitizePresets(userConfig, warnings);

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

  sanitizeExcludedAgents(userConfig, warnings);

  // Автоопределение агентов из opencode.json, если эксперты не заданы явно
  if (userConfig.autoDiscoverAgents !== false) {
    const snapshot = loadOpenCodeAgents({
      opencodeConfigPath: userConfig.opencodeConfigPath,
      cwd: userConfig.cwd
    });

    if (snapshot.warning !== undefined) {
      warnings.push(snapshot.warning);
    }

    // Битый файл слоя не должен скрывать остальные слои: предупреждаем о
    // каждом файле и продолжаем с теми, что разобрались.
    for (const error of snapshot.errors) {
      warnings.push(`Не удалось прочитать ${error}`);
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
      // Явно заданную пользователем модель не перекрываем.
      const chairName = userConfig.chair?.agent ?? DEFAULT_CONFIG.chair.agent;
      const chairEntry = section.entries[chairName];
      const chairModel = chairEntry === undefined ? undefined : readAgentDefinition(chairEntry).model;
      const configuredChairModel = userConfig.chair?.model;
      const chairModelConfigured =
        configuredChairModel !== undefined &&
        (typeof configuredChairModel !== 'string' ||
          configuredChairModel.trim().length > 0);
      if (
        chairModel !== undefined &&
        chairModel.length > 0 &&
        !chairModelConfigured
      ) {
        userConfig.chair = {
          ...(userConfig.chair ?? { agent: DEFAULT_CONFIG.chair.agent }),
          model: chairModel
        };
      }
    } else if (snapshot.path !== null && snapshot.errors.length === 0) {
      warnings.push(
        `Не удалось прочитать ${snapshot.path}: ${snapshot.error ?? 'неизвестная ошибка'}`
      );
    }
  }

  sanitizeExpertNames(userConfig, warnings);

  const mergedConfig = mergeWithDefaults(userConfig);
  if (trustProjectConfig) {
    markTrustedProjectConfig(mergedConfig);
  } else if (mergedConfig.opencodeArgs === undefined) {
    // mergeWithDefaults всегда создаёт поле opencodeArgs; для недоверенного
    // конфига ключ не должен оставаться даже со значением undefined.
    delete (mergedConfig as { opencodeArgs?: string[] }).opencodeArgs;
  }
  warnings.push(...validateConfig(mergedConfig));

  return {
    config: mergedConfig,
    configPath,
    warnings,
    errors
  };
}
