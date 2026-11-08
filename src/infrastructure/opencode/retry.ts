/**
 * @fileoverview Таймауты, повторы и классификация повторяемых ошибок
 * @module lv24-opencode-consilium
 */

import type { AgentErrorCode } from '../../domain/types.js';

/** Таймаут эксперта по умолчанию (мс) */
export const DEFAULT_TIMEOUT = 300000;

/** Таймаут председателя по умолчанию (мс) */
export const DEFAULT_CHAIR_TIMEOUT = 600000;

/** Базовая задержка повтора по умолчанию (мс) */
export const DEFAULT_RETRY_DELAY = 1000;

/** Максимальное число повторов */
export const MAX_RETRIES = 10;

/** Максимальная задержка rate limit, которую имеет смысл ждать внутри запуска */
export const RATE_LIMIT_RETRY_WINDOW_MS = 30_000;

/** Приводит значение к конечному числу либо undefined */
export function toFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Приводит значение к положительному целому либо undefined */
export function positiveInteger(value: unknown): number | undefined {
  const numeric = toFiniteNumber(value);
  if (numeric === undefined || numeric <= 0 || !Number.isInteger(numeric)) {
    return undefined;
  }
  return numeric;
}

/** Приводит значение к неотрицательному целому либо undefined */
export function nonNegativeInteger(value: unknown): number | undefined {
  const numeric = toFiniteNumber(value);
  if (numeric === undefined || numeric < 0 || !Number.isInteger(numeric)) {
    return undefined;
  }
  return numeric;
}

/** Нормализует таймаут: конечное положительное число (мс) либо fallback */
export function sanitizeTimeout(value: unknown, fallback: number): number {
  const toTimeout = (candidate: unknown): number | undefined => {
    const numeric = toFiniteNumber(candidate);
    if (numeric === undefined || numeric <= 0) return undefined;
    return Math.max(1, Math.round(numeric));
  };
  return toTimeout(value) ?? toTimeout(fallback) ?? DEFAULT_TIMEOUT;
}

/** Нормализует число повторов: неотрицательное целое, не больше MAX_RETRIES */
export function sanitizeRetries(value: unknown, fallback: number): number {
  const retries = nonNegativeInteger(value) ?? nonNegativeInteger(fallback) ?? 0;
  return Math.min(MAX_RETRIES, retries);
}

/** Задержка перед повтором: экспоненциальный рост и опциональный джиттер */
export function calculateRetryDelay(
  attempt: number,
  baseDelay: number,
  exponentialBackoff: boolean,
  jitter: boolean
): number {
  const base = exponentialBackoff ? baseDelay * Math.pow(2, attempt) : baseDelay;
  if (!jitter) return base;
  // Полный джиттер 50–100%: параллельные эксперты не упираются в лимит одновременно.
  return Math.max(0, Math.round(base * (0.5 + Math.random() * 0.5)));
}

/** Проверяет, имеет ли смысл повторять попытку */
export function isRetryable(code: AgentErrorCode | undefined, retryAfterMs?: number): boolean {
  if (code === undefined) return true;
  if (code === 'RATE_LIMITED') {
    // Короткий лимит (секунды) пережидаем; длинный — сразу отдаём ошибку.
    return (
      retryAfterMs !== undefined &&
      retryAfterMs > 0 &&
      retryAfterMs <= RATE_LIMIT_RETRY_WINDOW_MS
    );
  }
  return (
    code !== 'CANCELLED' &&
    code !== 'MODEL_UNAVAILABLE' &&
    code !== 'PARSE_ERROR' &&
    code !== 'AGENT_NOT_FOUND' &&
    code !== 'COST_LIMIT'
  );
}
