/**
 * @fileoverview Чтение и запись раздела агентов opencode.json(c)
 * @module lv24-opencode-consilium
 *
 * Поддерживает V1 (`agent`) и нативный V2 (`agents`). Внутри одной записи
 * нельзя смешивать V1-поля (`prompt`, `disable`) и V2-поля (`system`, `disabled`).
 */

import { detectConfigFlavor, isRecord, recordOf, toModelRef, type ConfigFlavor } from './readers.js';

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
    // Внутри одного файла `agents` перекрывает `agent`, но неуказанные поля
    // сохраняются: записи сливаются по имени, а не заменяются целиком.
    entries[name] = { ...(entries[name] ?? {}), ...entry };
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
