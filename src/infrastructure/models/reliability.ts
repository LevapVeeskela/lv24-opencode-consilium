/**
 * @fileoverview Память надёжности моделей: попытки, ошибки и бонус к рейтингу
 * @module lv24-opencode-consilium
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { writeFileAtomic } from '../../shared/fs.js';
import { isRecord } from '../../shared/record.js';

/** Каталог состояния Consilium внутри рабочей директории */
const CONFIG_DIRECTORY = '.consilium';
/** Файл статистики надёжности */
const RELIABILITY_FILE = 'reliability.json';
/** Максимум моделей в памяти (LRU по lastUsedAt) */
const MAX_RELIABILITY_MODELS = 200;
/** Минимальное число попыток, после которого бонус считается значимым */
const MIN_BONUS_ATTEMPTS = 3;
/** Число попыток, после которого доверие к статистике максимально */
const FULL_CONFIDENCE_ATTEMPTS = 10;
/** Максимальный штраф/бонус к score */
const MAX_BONUS = 0.05;

/** Статистика одной модели */
export interface ModelReliability {
  /** Всего попыток вызова */
  attempts: number;
  /** Успешных попыток */
  successes: number;
  /** Ошибок RATE_LIMITED */
  rateLimited: number;
  /** Ошибок TIMEOUT */
  timeouts: number;
  /** Ошибок MODEL_UNAVAILABLE */
  unavailable: number;
  /** Пустых ответов (EMPTY_RESPONSE) */
  empty: number;
  /** Прочие ошибки */
  otherErrors: number;
  /** Суммарная задержка всех попыток, мс */
  totalLatencyMs: number;
  /** Время последней попытки (ISO 8601) */
  lastUsedAt: string;
}

/** Файл `.consilium/reliability.json` */
export interface ReliabilityStore {
  version: 1;
  models: Record<string, ModelReliability>;
}

/** Параметры записи одной попытки */
export interface ModelAttemptRecord {
  /** Идентификатор модели `provider/model` */
  model: string;
  /** Попытка успешна */
  ok: boolean;
  /** Код ошибки OpenCode (RATE_LIMITED, TIMEOUT, …) */
  errorCode?: string;
  /** Длительность попытки, мс */
  latencyMs: number;
  /** Рабочая директория проекта (по умолчанию process.cwd()) */
  dir?: string;
  /** Необязательный приёмник ошибок записи (запись не бросает исключение) */
  onError?: (error: unknown) => void;
}

/** Пустая статистика */
export function emptyReliabilityStore(): ReliabilityStore {
  return { version: 1, models: {} };
}

/** Путь к файлу статистики */
function reliabilityPath(dir?: string): string {
  return resolve(dir ?? process.cwd(), CONFIG_DIRECTORY, RELIABILITY_FILE);
}

/** Неотрицательное целое из неизвестного значения */
function nonNegativeInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value));
}

/** Ограничивает долю диапазоном [0, 1] */
function clamp01(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return value > 1 ? 1 : value;
}

/** Округляет бонус до 6 знаков, чтобы ranking оставался детерминированным */
function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

/** Время последнего использования для LRU (невалидная дата — самый старый) */
function lastUsedTime(entry: ModelReliability): number {
  const timestamp = Date.parse(entry.lastUsedAt);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

/**
 * Оставляет не больше MAX_RELIABILITY_MODELS записей: сначала самые свежие.
 * keepKey гарантированно сохраняется при равных lastUsedAt (только что записан).
 */
function capModels(models: Record<string, ModelReliability>, keepKey?: string): void {
  const keys = Object.keys(models);
  if (keys.length <= MAX_RELIABILITY_MODELS) return;
  keys.sort((a, b) => {
    const delta = lastUsedTime(models[b]) - lastUsedTime(models[a]);
    if (delta !== 0) return delta;
    if (keepKey !== undefined) {
      if (a === keepKey) return -1;
      if (b === keepKey) return 1;
    }
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const kept = new Set(keys.slice(0, MAX_RELIABILITY_MODELS));
  for (const key of keys) {
    if (!kept.has(key)) delete models[key];
  }
}

/** Проверяет и приводит запись модели из файла */
function sanitizeEntry(value: unknown): ModelReliability | undefined {
  if (!isRecord(value)) return undefined;
  const attempts = nonNegativeInteger(value['attempts']);
  if (attempts === 0) return undefined;
  const rawLastUsedAt = value['lastUsedAt'];
  const lastUsedAt =
    typeof rawLastUsedAt === 'string' && Number.isFinite(Date.parse(rawLastUsedAt))
      ? rawLastUsedAt
      : new Date(0).toISOString();
  return {
    attempts,
    successes: nonNegativeInteger(value['successes']),
    rateLimited: nonNegativeInteger(value['rateLimited']),
    timeouts: nonNegativeInteger(value['timeouts']),
    unavailable: nonNegativeInteger(value['unavailable']),
    empty: nonNegativeInteger(value['empty']),
    otherErrors: nonNegativeInteger(value['otherErrors']),
    totalLatencyMs: nonNegativeInteger(value['totalLatencyMs']),
    lastUsedAt
  };
}

/**
 * Загружает статистику надёжности. Отсутствующий, повреждённый или
 * несовместимый файл трактуется как пустая статистика.
 */
export function loadReliability(dir?: string): ReliabilityStore {
  let raw: string;
  try {
    raw = readFileSync(reliabilityPath(dir), 'utf8');
  } catch {
    return emptyReliabilityStore();
  }

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return emptyReliabilityStore();
  }

  if (!isRecord(data)) return emptyReliabilityStore();
  const version = data['version'];
  if ((version !== undefined && version !== 1) || !isRecord(data['models'])) {
    return emptyReliabilityStore();
  }

  const models: Record<string, ModelReliability> = {};
  for (const [key, value] of Object.entries(data['models'])) {
    const model = key.trim();
    if (model.length === 0) continue;
    const entry = sanitizeEntry(value);
    if (entry !== undefined) models[model] = entry;
  }

  capModels(models);
  return { version: 1, models };
}

/** Увеличивает счётчик, не выходя за безопасный диапазон */
function addCount(current: number, delta = 1): number {
  return Math.min(Number.MAX_SAFE_INTEGER, current + delta);
}

/** Категория ошибки в статистике */
function errorField(errorCode: string | undefined): keyof Pick<
  ModelReliability,
  'rateLimited' | 'timeouts' | 'unavailable' | 'empty' | 'otherErrors'
> {
  switch ((errorCode ?? '').trim().toUpperCase()) {
    case 'RATE_LIMITED':
    case 'RATE_LIMIT':
    case '429':
      return 'rateLimited';
    case 'TIMEOUT':
    case 'TIMED_OUT':
      return 'timeouts';
    case 'MODEL_UNAVAILABLE':
    case 'UNAVAILABLE':
      return 'unavailable';
    case 'EMPTY_RESPONSE':
      return 'empty';
    default:
      return 'otherErrors';
  }
}

/**
 * Записывает одну попытку вызова модели.
 *
 * Запись атомарная и best-effort: ошибка чтения/записи не бросается наружу,
 * а передаётся в `onError`, потому что статистика не должна ломать запуск.
 */
export function recordModelAttempt(input: ModelAttemptRecord): ReliabilityStore {
  const store = loadReliability(input.dir);
  const key = input.model.trim();
  if (key.length === 0) return store;

  const entry = store.models[key] ?? {
    attempts: 0,
    successes: 0,
    rateLimited: 0,
    timeouts: 0,
    unavailable: 0,
    empty: 0,
    otherErrors: 0,
    totalLatencyMs: 0,
    lastUsedAt: new Date(0).toISOString()
  };

  entry.attempts = addCount(entry.attempts);
  if (input.ok) {
    entry.successes = addCount(entry.successes);
  } else {
    const field = errorField(input.errorCode);
    entry[field] = addCount(entry[field]);
  }

  const latency =
    Number.isFinite(input.latencyMs) && input.latencyMs > 0
      ? Math.min(Number.MAX_SAFE_INTEGER, Math.round(input.latencyMs))
      : 0;
  entry.totalLatencyMs = addCount(entry.totalLatencyMs, latency);
  entry.lastUsedAt = new Date().toISOString();
  store.models[key] = entry;
  capModels(store.models, key);

  try {
    writeFileAtomic(
      reliabilityPath(input.dir),
      `${JSON.stringify(store, null, 2)}\n`
    );
  } catch (error) {
    try {
      input.onError?.(error);
    } catch {
      // Приёмник ошибок тоже не должен ломать запуск
    }
  }

  return store;
}

/** Находит статистику модели (регистронезависимый запасной вариант) */
function findEntry(
  store: ReliabilityStore,
  model: string
): ModelReliability | undefined {
  const key = model.trim();
  if (key.length === 0) return undefined;
  const direct = store.models[key];
  if (direct !== undefined) return direct;
  const lower = key.toLowerCase();
  for (const [candidate, entry] of Object.entries(store.models)) {
    if (candidate.toLowerCase() === lower) return entry;
  }
  return undefined;
}

/**
 * Бонус к score модели в диапазоне [-0.05, +0.05].
 *
 * Учитываются успешность, доля тяжёлых ошибок (rate limit, таймауты,
 * недоступность) и размер выборки: до 3 попыток бонус равен нулю, после
 * 10 попыток доверие максимально.
 */
export function reliabilityBonus(model: string, store?: ReliabilityStore): number {
  if (store === undefined) return 0;
  const entry = findEntry(store, model);
  if (entry === undefined || entry.attempts < MIN_BONUS_ATTEMPTS) return 0;

  const attempts = entry.attempts;
  const successRate = clamp01(entry.successes / attempts);
  const severeErrorRate = clamp01(
    (entry.rateLimited + entry.timeouts + entry.unavailable) / attempts
  );
  const confidence = Math.min(1, attempts / FULL_CONFIDENCE_ATTEMPTS);

  const raw = (successRate - 0.5) * 0.10 - severeErrorRate * 0.05;
  const bonus = Math.max(-MAX_BONUS, Math.min(MAX_BONUS, raw * confidence));
  return round6(bonus);
}

/**
 * Форматирует статистику для будущей команды `models --reliability`.
 * Строки отсортированы по числу попыток, затем по имени модели.
 */
export function formatReliabilityTable(store: ReliabilityStore): string {
  const rows = Object.entries(store.models).sort((a, b) => {
    if (b[1].attempts !== a[1].attempts) return b[1].attempts - a[1].attempts;
    return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
  });
  if (rows.length === 0) return 'Надёжность моделей: нет данных.';

  const header = [
    'Модель',
    'Попытки',
    'Успех',
    'Успешность',
    'RateLimit',
    'Timeout',
    'Unavailable',
    'Empty',
    'Другие',
    'Ср. мс',
    'Последний запуск'
  ];
  const lines = [header.join('\t')];
  for (const [model, entry] of rows) {
    const successRate = entry.attempts > 0 ? (entry.successes / entry.attempts) * 100 : 0;
    const averageLatency =
      entry.attempts > 0 ? Math.round(entry.totalLatencyMs / entry.attempts) : 0;
    lines.push(
      [
        model,
        entry.attempts,
        entry.successes,
        `${successRate.toFixed(1)}%`,
        entry.rateLimited,
        entry.timeouts,
        entry.unavailable,
        entry.empty,
        entry.otherErrors,
        averageLatency,
        entry.lastUsedAt
      ].join('\t')
    );
  }
  return lines.join('\n');
}
