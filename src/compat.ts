/**
 * @fileoverview Совместимость с OpenCode V1 и V2
 * @module lv24-opencode-consilium
 *
 * Модуль не работает с файловой системой: все функции чистые, чтобы их можно
 * было покрыть тестами и переиспользовать в CLI, MCP и doctor.
 *
 * Правила совместимости:
 * - OpenCode V2 читает V1-конфигурацию, поэтому V1-форма остаётся базовой.
 * - Нативные V2-поля (`agents`, `commands`, `providers`, `permissions`,
 *   `mcp.servers`) в V1 не работают, поэтому писать их можно только в файл,
 *   который уже ведётся в нативном V2-формате.
 * - Внутри одной записи агента нельзя смешивать V1-поля (`prompt`, `disable`,
 *   `permission`) и V2-поля (`system`, `disabled`, `permissions`).
 * - `opencode run --agent` в V2 не применяет модель агента из конфигурации,
 *   поэтому модель всегда нужно передавать через `--model`.
 */

/** Основная версия OpenCode, под которую адаптируется пакет */
export type OpenCodeMajor = 1 | 2;

/** Разобранная версия OpenCode CLI */
export interface OpenCodeCliInfo {
  /** Сырой вывод `opencode --version` */
  raw: string | null;
  /** Нормализованная версия, например `2.2.6` */
  version: string | null;
  /** Основная версия; `null`, если версию распознать не удалось */
  major: OpenCodeMajor | null;
}

/** Формат конфигурации opencode.json */
export type ConfigFlavor = 'v1' | 'v2';

/** Нормализованное представление записи агента */
export interface AgentDefinitionView {
  /** Модель в формате `provider/model` или `provider/model#variant` */
  model?: string;
  mode?: string;
  disabled: boolean;
  /** Системный промпт: V2 `system` или V1 `prompt` */
  prompt?: string;
  description?: string;
  /** Запись уже использует нативные V2-поля */
  nativeV2: boolean;
}

/** Содержимое раздела агентов в opencode.json */
export interface AgentSectionView {
  flavor: ConfigFlavor;
  /** Ключ, в который пишем новые записи для этого файла */
  key: 'agent' | 'agents';
  /** Объединённый список: нативные V2-записи перекрывают V1 */
  entries: Record<string, Record<string, unknown>>;
  /** Имена, заданные и в `agent`, и в `agents` (в V2 побеждает `agents`) */
  duplicated: string[];
  /** Имена с некорректной (не объектной) записью */
  invalid: string[];
  /** Разделы по отдельности */
  v1: Record<string, Record<string, unknown>>;
  v2: Record<string, Record<string, unknown>>;
}

/** Данные для записи агента в opencode.json */
export interface AgentWrite {
  model?: string;
  prompt?: string;
  mode?: string;
  description?: string;
}

/** Результат записи агентов */
export interface UpsertAgentsResult {
  config: Record<string, unknown>;
  flavor: ConfigFlavor;
  /** Куда записан каждый агент */
  written: Record<string, 'agent' | 'agents' | 'both'>;
  warnings: string[];
}

/** Содержимое раздела MCP-серверов в opencode.json */
export interface McpSectionView {
  flavor: ConfigFlavor;
  servers: Record<string, Record<string, unknown>>;
  /** Плоские записи `mcp.<name>`, которые V2 игнорирует */
  flat: Record<string, Record<string, unknown>>;
  /** Имена, заданные и в `mcp.<name>`, и в `mcp.servers` */
  duplicated: string[];
}

/** Описание локального MCP-сервера */
export interface McpLocalServerSpec {
  command: string[];
  environment?: Record<string, string>;
  cwd?: string;
  enabled?: boolean;
}

/** Результат записи MCP-сервера */
export interface UpsertMcpResult {
  config: Record<string, unknown>;
  flavor: ConfigFlavor;
  key: 'mcp' | 'mcp.servers';
  warnings: string[];
}

/** Поля V1-конфигурации, которые OpenCode V2 переименовывает или игнорирует */
export const LEGACY_V1_FIELDS: readonly string[] = [
  'theme',
  'autoupdate',
  'logLevel',
  'server',
  'subagent_depth',
  'small_model',
  'snapshot',
  'attachment'
];

/** Проверяет, является ли значение обычным объектом */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Возвращает объект только для объектных значений */
function recordOf(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

/** Преобразует раздел агентов в карту записей */
function agentMapOf(
  value: unknown,
  invalid: string[]
): Record<string, Record<string, unknown>> {
  const result: Record<string, Record<string, unknown>> = {};
  for (const [name, entry] of Object.entries(recordOf(value))) {
    if (isRecord(entry)) {
      result[name] = entry;
    } else {
      invalid.push(name);
    }
  }
  return result;
}

/**
 * Разбирает вывод `opencode --version`.
 * Понимает `opencode v2.2.6`, `2.2.6` и строки с суффиксами сборки.
 */
export function parseOpenCodeVersion(raw: string | null | undefined): OpenCodeCliInfo {
  const text = typeof raw === 'string' ? raw.trim() : '';
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  if (!match) {
    return { raw: text.length > 0 ? text : null, version: null, major: null };
  }

  const version = `${match[1]}.${match[2]}.${match[3]}`;
  const majorNumber = Number(match[1]);
  return {
    raw: text.length > 0 ? text : null,
    version,
    major: majorNumber >= 2 ? 2 : 1
  };
}

/**
 * Определяет формат конфигурации по набору нативных V2-ключей.
 * Отсутствие маркеров означает V1-формат (он совместим с обеими версиями).
 */
export function detectConfigFlavor(config: unknown): ConfigFlavor {
  if (!isRecord(config)) return 'v1';

  const v2TopLevel = [
    'agents',
    'commands',
    'providers',
    'permissions',
    'policies',
    'plugins',
    'snapshots',
    'media',
    'update'
  ];
  for (const key of v2TopLevel) {
    if (key in config) return 'v2';
  }

  const mcp = recordOf(config.mcp);
  if (isRecord(mcp.servers)) return 'v2';
  if (Array.isArray(config.skills)) return 'v2';

  return 'v1';
}

/** Возвращает человекочитаемое название формата */
export function describeConfigFlavor(flavor: ConfigFlavor): string {
  return flavor === 'v2' ? 'V2 (native)' : 'V1 (совместим с V1 и V2)';
}

/**
 * Нормализует ссылку на модель.
 * Поддерживает строку и расширенный объект V2 (`providerID`/`model`/`variant`).
 */
export function toModelRef(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  if (!isRecord(value)) return undefined;

  const provider =
    typeof value.providerID === 'string'
      ? value.providerID
      : typeof value.provider === 'string'
        ? value.provider
        : undefined;
  const model =
    typeof value.model === 'string'
      ? value.model
      : typeof value.modelID === 'string'
        ? value.modelID
        : undefined;

  if (provider === undefined || model === undefined) return undefined;
  if (provider.trim().length === 0 || model.trim().length === 0) return undefined;

  const variant = typeof value.variant === 'string' ? value.variant.trim() : '';
  return variant.length > 0 ? `${provider}/${model}#${variant}` : `${provider}/${model}`;
}

/** Делит ссылку `provider/model#variant` на модель и вариант */
export function splitModelRef(ref: string): { model: string; variant?: string } {
  const hash = ref.indexOf('#');
  if (hash === -1) return { model: ref };
  const variant = ref.slice(hash + 1).trim();
  return variant.length > 0
    ? { model: ref.slice(0, hash), variant }
    : { model: ref.slice(0, hash) };
}

/** Признаки нативных V2-полей в записи агента */
const AGENT_V2_FIELDS = ['system', 'permissions', 'disabled', 'steps', 'request', 'color', 'hidden'];

/** Нормализует запись агента из opencode.json */
export function readAgentDefinition(value: unknown): AgentDefinitionView {
  const entry = recordOf(value);
  const nativeV2 = AGENT_V2_FIELDS.some(field => field in entry);
  const prompt =
    typeof entry.system === 'string'
      ? entry.system
      : typeof entry.prompt === 'string'
        ? entry.prompt
        : undefined;

  return {
    model: toModelRef(entry.model),
    mode: typeof entry.mode === 'string' ? entry.mode : undefined,
    disabled: entry.disabled === true || entry.disable === true,
    prompt,
    description: typeof entry.description === 'string' ? entry.description : undefined,
    nativeV2
  };
}

/**
 * Читает раздел агентов из конфигурации OpenCode.
 * Поддерживает V1 (`agent`), V2 (`agents`) и файлы, где есть оба раздела.
 */
export function readAgentSection(config: unknown): AgentSectionView {
  const root = recordOf(config);
  const invalid: string[] = [];
  const v1 = agentMapOf(root.agent, invalid);
  const v2 = agentMapOf(root.agents, invalid);
  const flavor = detectConfigFlavor(root);

  const entries: Record<string, Record<string, unknown>> = { ...v1 };
  for (const [name, entry] of Object.entries(v2)) {
    entries[name] = entry;
  }

  const duplicated = Object.keys(v1).filter(name => Object.prototype.hasOwnProperty.call(v2, name));

  return {
    flavor,
    key: flavor === 'v2' ? 'agents' : 'agent',
    entries,
    duplicated,
    invalid,
    v1,
    v2
  };
}

/**
 * Выбирает стиль полей по разделу: `agents` — нативный V2, `agent` — V1.
 * Внутри одной записи нельзя смешивать `prompt`/`system`.
 */
function pickAgentFieldStyle(section: 'agent' | 'agents'): 'v1' | 'v2' {
  return section === 'agents' ? 'v2' : 'v1';
}

/** Поля V1, которые нельзя однозначно перевести в V2 при миграции */
const MIGRATION_UNSAFE_FIELDS = ['tools', 'permission', 'temperature', 'top_p', 'maxSteps', 'max_steps'];

/** Собирает запись агента в выбранном стиле */
function buildAgentEntry(
  base: Record<string, unknown>,
  write: AgentWrite,
  style: 'v1' | 'v2'
): Record<string, unknown> {
  const entry: Record<string, unknown> = { ...base };

  if (write.model !== undefined && write.model.trim().length > 0) {
    entry.model = write.model.trim();
  }
  if (write.mode !== undefined && write.mode.trim().length > 0) {
    entry.mode = write.mode.trim();
  }
  if (
    write.description !== undefined &&
    write.description.trim().length > 0 &&
    typeof entry.description !== 'string'
  ) {
    entry.description = write.description.trim();
  }

  if (write.prompt !== undefined && write.prompt.trim().length > 0) {
    if (style === 'v2') {
      entry.system = write.prompt;
    } else {
      entry.prompt = write.prompt;
    }
  }

  // Нормализуем промпт под формат раздела: в `agents` только system, в `agent` только prompt.
  if (style === 'v2') {
    if (entry.system === undefined && typeof entry.prompt === 'string') {
      entry.system = entry.prompt;
    }
    delete entry.prompt;
  } else {
    if (entry.prompt === undefined && typeof entry.system === 'string') {
      entry.prompt = entry.system;
    }
    delete entry.system;
  }

  // Отключение агента переносим между форматами, чтобы миграция не включала его обратно.
  if (style === 'v2') {
    if ('disable' in entry) {
      if (entry.disable === true) entry.disabled = true;
      delete entry.disable;
    }
  } else if ('disabled' in entry) {
    if (entry.disabled === true) entry.disable = true;
    delete entry.disabled;
  }

  return entry;
}

/**
 * Записывает агентов в конфигурацию OpenCode, сохраняя её формат.
 *
 * - В V2-файл пишем `agents` + `system`, в V1-файл — `agent` + `prompt`.
 * - Если агент уже есть в обоих разделах, обновляем обе записи: иначе V2
 *   отдаст приоритет нативной записи и наши изменения потеряются.
 * - `migrate: true` переносит управляемых агентов из `agent` в `agents`.
 */
export function upsertAgents(
  config: unknown,
  definitions: Record<string, AgentWrite>,
  options: { flavor?: ConfigFlavor; migrate?: boolean } = {}
): UpsertAgentsResult {
  const root = recordOf(config);
  const section = readAgentSection(root);
  const flavor = options.flavor ?? section.flavor;
  const migrateRequested = options.migrate === true;
  const migrate = migrateRequested && flavor === 'v2';

  const v1: Record<string, Record<string, unknown>> = { ...section.v1 };
  const v2: Record<string, Record<string, unknown>> = { ...section.v2 };
  const written: Record<string, 'agent' | 'agents' | 'both'> = {};
  const warnings: string[] = [];

  if (migrateRequested && !migrate) {
    warnings.push('migrate: файл ведётся в V1-формате, перенос в agents не выполнен.');
  }

  for (const [name, write] of Object.entries(definitions)) {
    const inV1 = Object.prototype.hasOwnProperty.call(v1, name);
    const inV2 = Object.prototype.hasOwnProperty.call(v2, name);

    // Не переносим агентов, у которых есть V1-ограничения: в V2 их нельзя
    // перевести без потери смысла, а смешивать поля в одной записи нельзя.
    if (migrate && inV1) {
      const unsafe = MIGRATION_UNSAFE_FIELDS.filter(field => field in v1[name]!);
      if (unsafe.length > 0) {
        v1[name] = buildAgentEntry(v1[name]!, write, 'v1');
        warnings.push(
          `Агент "${name}" не перенесён в agents: поля ${unsafe.join(', ')} нельзя однозначно ` +
            'перевести в V2 (ограничения инструментов/сэмплинга). Запись в agent обновлена и оставлена.'
        );
        written[name] = 'agent';
        continue;
      }
    }

    let targets: Array<'agent' | 'agents'>;
    if (migrate) {
      targets = ['agents'];
    } else if (inV1 && inV2) {
      targets = ['agent', 'agents'];
      warnings.push(
        `Агент "${name}" задан и в agent, и в agents: обновлены обе записи, иначе V2 проигнорирует V1-определение.`
      );
    } else if (inV2) {
      targets = ['agents'];
    } else if (inV1) {
      targets = ['agent'];
    } else {
      targets = [flavor === 'v2' ? 'agents' : 'agent'];
    }

    for (const target of targets) {
      const targetMap = target === 'agents' ? v2 : v1;
      // При миграции переносим существующую V1-запись целиком, иначе потеряются
      // mode/description/disable и другие поля, которых нет в definitions.
      const base =
        target === 'agents' && migrate
          ? { ...(v1[name] ?? {}), ...(v2[name] ?? {}) }
          : targetMap[name] ?? {};
      const style = pickAgentFieldStyle(target);
      targetMap[name] = buildAgentEntry(base, write, style);
    }

    if (migrate && inV1) {
      delete v1[name];
      warnings.push(`Агент "${name}" перенесён из agent в agents (native V2).`);
    }

    written[name] = targets.length === 2 ? 'both' : targets[0]!;
  }

  const next: Record<string, unknown> = { ...root };
  if (Object.keys(v1).length > 0) {
    next.agent = v1;
  } else if ('agent' in root && !migrate) {
    next.agent = v1;
  } else {
    delete next.agent;
  }
  if (Object.keys(v2).length > 0 || 'agents' in root) {
    next.agents = v2;
  }

  return { config: next, flavor, written, warnings };
}

/**
 * Читает MCP-серверы из конфигурации OpenCode.
 * V1 хранит их плоско в `mcp.<name>`, V2 — в `mcp.servers.<name>`.
 */
export function readMcpSection(config: unknown): McpSectionView {
  const root = recordOf(config);
  const mcp = recordOf(root.mcp);
  const flavor = detectConfigFlavor(root);

  const servers: Record<string, Record<string, unknown>> = {};
  for (const [name, entry] of Object.entries(recordOf(mcp.servers))) {
    servers[name] = recordOf(entry);
  }

  const flat: Record<string, Record<string, unknown>> = {};
  for (const [name, entry] of Object.entries(mcp)) {
    if (name === 'servers' || name === 'timeout') continue;
    if (!isRecord(entry)) continue;
    flat[name] = entry;
  }

  const duplicated = Object.keys(flat).filter(name =>
    Object.prototype.hasOwnProperty.call(servers, name)
  );

  return { flavor, servers, flat, duplicated };
}

/** Собирает запись MCP-сервера в формате нужной версии */
export function buildMcpServerEntry(
  flavor: ConfigFlavor,
  spec: McpLocalServerSpec
): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    type: 'local',
    command: [...spec.command]
  };

  if (spec.environment !== undefined && Object.keys(spec.environment).length > 0) {
    entry.environment = { ...spec.environment };
  }
  if (spec.cwd !== undefined && spec.cwd.trim().length > 0) {
    entry.cwd = spec.cwd.trim();
  }

  if (flavor === 'v2') {
    if (spec.enabled === false) entry.disabled = true;
  } else if (spec.enabled === false) {
    entry.enabled = false;
  }

  return entry;
}

/**
 * Записывает MCP-сервер в конфигурацию OpenCode.
 * V2 игнорирует плоские записи `mcp.<name>`, поэтому формат выбирается по файлу.
 */
export function upsertMcpServer(
  config: unknown,
  name: string,
  spec: McpLocalServerSpec,
  options: { flavor?: ConfigFlavor } = {}
): UpsertMcpResult {
  const root = recordOf(config);
  const section = readMcpSection(root);
  const flavor = options.flavor ?? section.flavor;
  const warnings: string[] = [];

  const mcp: Record<string, unknown> = { ...recordOf(root.mcp) };

  if (flavor === 'v2') {
    const servers: Record<string, unknown> = { ...recordOf(mcp.servers) };
    const existing = recordOf(servers[name]);
    servers[name] = { ...existing, ...buildMcpServerEntry('v2', spec) };
    mcp.servers = servers;

    if (Object.prototype.hasOwnProperty.call(section.flat, name)) {
      warnings.push(
        `Плоская запись mcp.${name} игнорируется OpenCode V2. Удалите её, чтобы не было двух источников правды.`
      );
    }
  } else {
    const existing = recordOf(mcp[name]);
    mcp[name] = { ...existing, ...buildMcpServerEntry('v1', spec) };
    if (Object.prototype.hasOwnProperty.call(section.servers, name)) {
      warnings.push(
        `OpenCode V1 не читает mcp.servers.${name}; запись добавлена в плоский раздел mcp.`
      );
    }
  }

  return {
    config: { ...root, mcp },
    flavor,
    key: flavor === 'v2' ? 'mcp.servers' : 'mcp',
    warnings
  };
}

/**
 * Возвращает V1-поля, которые OpenCode V2 переименовывает или игнорирует.
 * Используется диагностикой, чтобы предупредить о настройках без эффекта.
 */
export function findLegacyV1Fields(config: unknown): string[] {
  const root = recordOf(config);
  return LEGACY_V1_FIELDS.filter(field => field in root);
}

/** Ссылка на команду установки MCP-сервера для текущего формата */
export function describeMcpShellCommand(name: string, flavor: ConfigFlavor): string {
  if (flavor === 'v2') {
    return `opencode mcp add ${name} -- npx -y lv24-opencode-consilium mcp`;
  }
  return 'mcp.consilium: { "type": "local", "command": ["npx", "-y", "lv24-opencode-consilium", "mcp"] }';
}
