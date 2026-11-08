/**
 * @fileoverview Низкоуровневое чтение секций opencode.json(c)
 * @module lv24-opencode-consilium
 *
 * Модуль не работает с файловой системой: все функции чистые, чтобы их можно
 * было покрыть тестами и переиспользовать в CLI, MCP и doctor.
 */

import { isRecord, recordOf } from '../../../shared/record.js';

// Помощники формы значений живут в shared-ядре; реэкспорт сохраняет импорты из
// старых модулей совместимости.
export { isRecord, recordOf };

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

/**
 * Возвращает V1-поля, которые OpenCode V2 переименовывает или игнорирует.
 * Используется диагностикой, чтобы предупредить о настройках без эффекта.
 */
export function findLegacyV1Fields(config: unknown): string[] {
  const root = recordOf(config);
  return LEGACY_V1_FIELDS.filter(field => field in root);
}
