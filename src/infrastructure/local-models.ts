/**
 * @fileoverview Локальные провайдеры моделей: определение, фильтрация и проверка доступности
 * @module lv24-opencode-consilium
 */

import { isRecord } from '../shared/record.js';

/** Минимальная форма ссылки на модель для фильтрации */
export interface LocalModelLike {
  /** Полный id OpenCode: `provider/model` */
  id?: string;
  /** Провайдер OpenCode */
  providerID?: string;
  /** Идентификатор модели без провайдера */
  modelID?: string;
}

/** Идентификаторы локальных провайдеров в нижнем регистре */
export const LOCAL_PROVIDERS = [
  'ollama',
  'lmstudio',
  'lm-studio',
  'local',
  'llamacpp',
  'llama.cpp',
  'vllm'
] as const;

/** Идентификатор локального провайдера */
export type LocalProvider = (typeof LOCAL_PROVIDERS)[number];

const LOCAL_PROVIDER_SET: ReadonlySet<string> = new Set<string>(LOCAL_PROVIDERS);

/** Провайдер, которого проверяют пробой доступности */
export type LocalProbeProvider = 'ollama' | 'lmstudio';

/** Результат проверки одного локального провайдера */
export interface LocalProviderProbeResult {
  /** Идентификатор провайдера */
  provider: LocalProbeProvider;
  /** Проверенный URL */
  url: string;
  /** Провайдер ответил и вернул разбираемый список моделей */
  ok: boolean;
  /** Количество моделей (0 при ошибке) */
  models: number;
  /** Текст ошибки, если проверка не удалась */
  error?: string;
}

/** Опции проверки локальных провайдеров */
export interface ProbeLocalProvidersOptions {
  /** Таймаут одного запроса, мс (по умолчанию 2000) */
  timeoutMs?: number;
}

interface ProbeTarget {
  provider: LocalProbeProvider;
  url: string;
}

const DEFAULT_PROBE_TIMEOUT_MS = 2_000;
const PROBE_TARGETS: readonly ProbeTarget[] = [
  { provider: 'ollama', url: 'http://127.0.0.1:11434/api/tags' },
  { provider: 'lmstudio', url: 'http://127.0.0.1:1234/v1/models' }
];

/** Провайдер из ссылки `provider/model` (часть до `/`, нижний регистр) */
function providerFromModelId(modelId: string): string {
  if (typeof modelId !== 'string') return '';
  const slash = modelId.indexOf('/');
  return (slash === -1 ? modelId : modelId.slice(0, slash)).trim().toLowerCase();
}

/** Ссылка на модель из объекта (`id` или `providerID/modelID`) */
function modelIdentifier(model: LocalModelLike): string {
  if (typeof model.id === 'string' && model.id.trim().length > 0) return model.id;
  const provider = typeof model.providerID === 'string' ? model.providerID : '';
  const modelId = typeof model.modelID === 'string' ? model.modelID : '';
  return provider.length > 0 && modelId.length > 0 ? `${provider}/${modelId}` : '';
}

/**
 * Проверяет, принадлежит ли модель локальному провайдеру.
 * Провайдер — часть ссылки до `/`, сравнение регистронезависимое.
 */
export function isLocalModel(modelId: string): boolean {
  return LOCAL_PROVIDER_SET.has(providerFromModelId(modelId));
}

/** Оставляет только локальные модели, сохраняя исходный порядок */
export function filterLocalModels<T extends LocalModelLike | string>(
  models: readonly T[]
): T[] {
  return models.filter(model =>
    typeof model === 'string' ? isLocalModel(model) : isLocalModel(modelIdentifier(model))
  );
}

/**
 * Возвращает ссылки, которые не относятся к локальным провайдерам.
 * Помогает провалидировать конфигурацию для будущего режима `--local-only`.
 */
export function findNonLocalModels(models: readonly string[]): string[] {
  return models.filter(model => !isLocalModel(model));
}

/**
 * Проверяет, что все ссылки ведут на локальные провайдеры.
 * Бросает ошибку со списком нелокальных моделей.
 */
export function assertLocalConfig(models: readonly string[]): void {
  const nonLocal = findNonLocalModels(models);
  if (nonLocal.length === 0) return;
  throw new Error(
    `Local-only mode requires local providers; non-local models: ${nonLocal.join(', ')}`
  );
}

/** Запись аудита local-only: агент и его явная модель (если задана) */
export interface LocalOnlyEntry {
  label: string;
  model?: string;
}

/** Результат аудита local-only */
export interface LocalOnlyAudit {
  /** Агенты без явной модели: приватность нельзя гарантировать */
  missing: string[];
  /** Модели с нелокальным провайдером */
  nonLocal: string[];
}

/**
 * Аудит local-only режима: каждый агент обязан иметь явную модель, и каждая
 * модель должна быть локальной. Иначе запуск не гарантирует приватность.
 */
export function auditLocalOnly(entries: readonly LocalOnlyEntry[]): LocalOnlyAudit {
  const missing: string[] = [];
  const models: string[] = [];
  for (const entry of entries) {
    const model = typeof entry.model === 'string' ? entry.model.trim() : '';
    if (model.length === 0) {
      missing.push(entry.label);
    } else {
      models.push(model);
    }
  }
  return { missing, nonLocal: findNonLocalModels(models) };
}

/** Приводит таймаут к безопасному неотрицательному целому */
function normalizeTimeout(timeoutMs: number | undefined): number {
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs < 0) {
    return DEFAULT_PROBE_TIMEOUT_MS;
  }
  return Math.min(Number.MAX_SAFE_INTEGER, Math.floor(timeoutMs));
}

/** Извлекает читаемый текст ошибки, не бросая исключение */
function describeError(error: unknown, timeoutMs: number): string {
  if (isRecord(error)) {
    const name = typeof error['name'] === 'string' ? error['name'] : '';
    if (name === 'TimeoutError') return `timeout after ${timeoutMs}ms`;
    if (name === 'AbortError') return 'request aborted';
    const message = typeof error['message'] === 'string' ? error['message'].trim() : '';
    if (message.length > 0) return message;
    if (name.length > 0) return name;
  }
  if (typeof error === 'string' && error.trim().length > 0) return error.trim();
  return 'unknown error';
}

/** Считает модели в ответе Ollama (`models`) или LM Studio (`data`) */
function countModels(payload: unknown): number {
  if (Array.isArray(payload)) return payload.length;
  if (!isRecord(payload)) return 0;
  if (Array.isArray(payload['models'])) return payload['models'].length;
  if (Array.isArray(payload['data'])) return payload['data'].length;
  return 0;
}

/** Проверяет один провайдер; любые ошибки превращаются в результат */
async function probeOne(
  target: ProbeTarget,
  timeoutMs: number
): Promise<LocalProviderProbeResult> {
  try {
    const response = await fetch(target.url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/json' }
    });

    if (!response.ok) {
      const status = typeof response.status === 'number' ? response.status : 0;
      const statusText =
        typeof response.statusText === 'string' ? response.statusText.trim() : '';
      const label = status > 0 ? `HTTP ${status}` : 'HTTP error';
      return {
        provider: target.provider,
        url: target.url,
        ok: false,
        models: 0,
        error: statusText.length > 0 ? `${label} ${statusText}` : label
      };
    }

    const payload: unknown = await response.json();
    return {
      provider: target.provider,
      url: target.url,
      ok: true,
      models: countModels(payload)
    };
  } catch (error) {
    return {
      provider: target.provider,
      url: target.url,
      ok: false,
      models: 0,
      error: describeError(error, timeoutMs)
    };
  }
}

/**
 * Проверяет доступность Ollama и LM Studio.
 * Запросы выполняются параллельно; функция никогда не бросает исключение.
 */
export async function probeLocalProviders(
  options: ProbeLocalProvidersOptions = {}
): Promise<LocalProviderProbeResult[]> {
  const timeoutMs = normalizeTimeout(options.timeoutMs);
  return Promise.all(PROBE_TARGETS.map(target => probeOne(target, timeoutMs)));
}

/**
 * Форматирует результаты проверки как компактную текстовую таблицу.
 */
export function formatLocalProviders(
  results: readonly LocalProviderProbeResult[]
): string {
  if (results.length === 0) return 'No local providers.';

  const lines = ['provider\tstatus\tmodels\turl\terror'];
  for (const result of results) {
    const row = [
      result.provider,
      result.ok ? 'ok' : 'fail',
      String(result.models),
      result.url
    ];
    if (result.error !== undefined && result.error.length > 0) row.push(result.error);
    lines.push(row.join('\t'));
  }
  return lines.join('\n');
}
