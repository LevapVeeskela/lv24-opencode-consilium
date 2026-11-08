/**
 * @fileoverview Загрузчик конфигурации
 * @module lv24-opencode-consilium
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
import {
  readAgentDefinition,
  readAgentSection,
  type AgentSectionView
} from './compat.js';
import { isValidVariant, variantOf, withVariant } from './variants.js';

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

/** Возвращает объект только для объектных значений */
function recordOf(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
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
 * Возвращает все найденные файлы конфигурации OpenCode в порядке возрастания
 * приоритета: глобальный → прямые файлы от корня к cwd → `.opencode`-файлы
 * от корня к cwd. OpenCode сливает их именно в таком порядке.
 */
export function listOpenCodeConfigPaths(cwd?: string): string[] {
  const start = resolve(cwd ?? process.cwd());
  const paths: string[] = [];
  const seen = new Set<string>();

  const push = (candidate: string): void => {
    if (!seen.has(candidate) && existsSync(candidate)) {
      seen.add(candidate);
      paths.push(candidate);
    }
  };

  const configHome = process.env.XDG_CONFIG_HOME || resolve(homedir(), '.config');
  push(resolve(configHome, 'opencode', 'opencode.json'));
  push(resolve(configHome, 'opencode', 'opencode.jsonc'));

  const chain: string[] = [];
  let current = start;
  for (let depth = 0; depth < 24; depth += 1) {
    chain.unshift(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  for (const directory of chain) {
    push(resolve(directory, 'opencode.json'));
    push(resolve(directory, 'opencode.jsonc'));
  }
  for (const directory of chain) {
    push(resolve(directory, '.opencode', 'opencode.json'));
    push(resolve(directory, '.opencode', 'opencode.jsonc'));
  }

  return paths;
}

/**
 * Находит основной файл конфигурации OpenCode (наивысший приоритет).
 * Если заданный `opencodeConfigPath` не существует, используется автоопределение.
 */
export function findOpenCodeConfigPath(configuredPath?: string, cwd?: string): string | null {
  const start = resolve(cwd ?? process.cwd());

  if (configuredPath) {
    const resolved = resolve(start, configuredPath);
    if (existsSync(resolved)) return resolved;
    if (!configuredPath.endsWith('.jsonc') && existsSync(`${resolved}c`)) {
      return `${resolved}c`;
    }
  }

  const paths = listOpenCodeConfigPaths(start);
  return paths.length > 0 ? paths[paths.length - 1] ?? null : null;
}

/** Сливает конфигурации OpenCode: агенты и MCP объединяются по именам */
function mergeOpenCodeConfigs(layers: JsonRecord[]): JsonRecord {
  const merged: JsonRecord = {};

  for (const layer of layers) {
    for (const [key, value] of Object.entries(layer)) {
      if (key === 'agent' || key === 'agents') {
        merged[key] = { ...recordOf(merged[key]), ...recordOf(value) };
      } else if (key === 'mcp') {
        const base = recordOf(merged.mcp);
        const next = recordOf(value);
        const mcp: JsonRecord = { ...base, ...next };
        if (isRecord(base.servers) || isRecord(next.servers)) {
          mcp.servers = { ...recordOf(base.servers), ...recordOf(next.servers) };
        }
        merged.mcp = mcp;
      } else {
        merged[key] = value;
      }
    }
  }

  return merged;
}

/** Снимок агентов из конфигурации OpenCode */
export interface OpenCodeAgentSnapshot {
  /** Файл с наивысшим приоритетом */
  path: string | null;
  /** Слитая конфигурация */
  config: JsonRecord | null;
  section: AgentSectionView | null;
  /** Все прочитанные файлы в порядке возрастания приоритета */
  files: string[];
  /** Причина, по которой конфигурация не прочитана */
  error?: string;
  /** Некритичное предупреждение (например, заданный путь не найден) */
  warning?: string;
}

/**
 * Читает агентов из opencode.json, понимая V1 (`agent`) и V2 (`agents`).
 * Без явного пути сливает все слои так же, как OpenCode.
 */
export function loadOpenCodeAgents(
  options: { opencodeConfigPath?: string; cwd?: string } = {}
): OpenCodeAgentSnapshot {
  const start = resolve(options.cwd ?? process.cwd());
  const explicit = options.opencodeConfigPath?.trim();
  let files: string[] = [];
  let warning: string | undefined;

  if (explicit !== undefined && explicit.length > 0) {
    const resolved = resolve(start, explicit);
    if (existsSync(resolved)) {
      files = [resolved];
    } else if (!explicit.endsWith('.jsonc') && existsSync(`${resolved}c`)) {
      files = [`${resolved}c`];
    } else {
      files = listOpenCodeConfigPaths(start);
      warning =
        files.length > 0
          ? `opencodeConfigPath "${explicit}" не найден; использовано автоопределение: ${files[files.length - 1]}`
          : `opencodeConfigPath "${explicit}" не найден, конфигурация OpenCode не обнаружена`;
    }
  } else {
    files = listOpenCodeConfigPaths(start);
  }

  if (files.length === 0) {
    return { path: null, config: null, section: null, files, warning };
  }

  const layers: JsonRecord[] = [];
  const errors: string[] = [];
  for (const file of files) {
    try {
      const config = readJsonFile(file);
      if (isRecord(config)) {
        layers.push(config);
      } else {
        errors.push(`${file}: ожидается JSON-объект`);
      }
    } catch (error) {
      errors.push(`${file}: ${(error as Error).message}`);
    }
  }

  const path = files[files.length - 1] ?? null;
  if (layers.length === 0) {
    return {
      path,
      config: null,
      section: null,
      files,
      error: errors.join('; ') || 'конфигурация не прочитана',
      warning
    };
  }

  const merged = mergeOpenCodeConfigs(layers);
  return { path, config: merged, section: readAgentSection(merged), files, warning };
}

/** Встроенные агенты OpenCode, которые доступны без записи в opencode.json */
const BUILTIN_OPENCODE_AGENTS = new Set([
  'build',
  'plan',
  'general',
  'explore',
  'compaction',
  'title',
  'summary'
]);

/** Проверяет наличие файлового агента (`.opencode/agents/<name>.md`) */
function hasAgentFile(agentName: string, cwd?: string): boolean {
  if (agentName.includes('..')) return false;

  const start = resolve(cwd ?? process.cwd());
  const chain: string[] = [];
  let current = start;
  for (let depth = 0; depth < 24; depth += 1) {
    chain.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  const directories: string[] = [];
  for (const directory of chain) {
    directories.push(resolve(directory, '.opencode', 'agents'));
    directories.push(resolve(directory, '.opencode', 'agent'));
  }
  const configHome = process.env.XDG_CONFIG_HOME || resolve(homedir(), '.config');
  directories.push(resolve(configHome, 'opencode', 'agents'));
  directories.push(resolve(configHome, 'opencode', 'agent'));

  return directories.some(directory => existsSync(resolve(directory, `${agentName}.md`)));
}

/**
 * Проверяет, существует ли агент и какую модель он использует.
 *
 * Нужна для OpenCode V2: `opencode run --agent` не применяет модель агента
 * из конфигурации, поэтому её приходится передавать через `--model`, а для
 * несуществующего агента — сразу запускать default-агент.
 */
export function resolveOpenCodeAgent(
  agentName: string,
  options: { opencodeConfigPath?: string; cwd?: string } = {}
): { exists: boolean; model?: string } {
  if (BUILTIN_OPENCODE_AGENTS.has(agentName)) {
    return { exists: true };
  }
  if (hasAgentFile(agentName, options.cwd)) {
    return { exists: true };
  }

  const snapshot = loadOpenCodeAgents(options);
  const entry = snapshot.section?.entries[agentName];
  if (entry === undefined) {
    return { exists: false };
  }
  return { exists: true, model: readAgentDefinition(entry).model };
}

/**
 * Возвращает модель агента из opencode.json.
 */
export function resolveOpenCodeAgentModel(
  agentName: string,
  options: { opencodeConfigPath?: string; cwd?: string } = {}
): string | undefined {
  return resolveOpenCodeAgent(agentName, options).model;
}

/**
 * Извлекает агентов из раздела opencode.json
 */
function extractAgentsFromOpenCode(
  section: AgentSectionView,
  excludedAgents: string[]
): ExpertConfig[] {
  const excluded = new Set(excludedAgents);
  const agents: ExpertConfig[] = [];
  let priority = 1;

  for (const [name, raw] of Object.entries(section.entries)) {
    if (excluded.has(name)) continue;
    const definition = readAgentDefinition(raw);
    if (definition.mode === 'subagent') continue;
    if (definition.disabled) continue;

    // prompt в opencode.json — это системный промпт агента, OpenCode применит его сам.
    // Для пользовательского сообщения берём task-aware промпт роли по умолчанию.
    agents.push({
      name,
      enabled: true,
      priority,
      model: definition.model,
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
      version: '1.4.1',
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
      autoDiscoverAgents: true
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
