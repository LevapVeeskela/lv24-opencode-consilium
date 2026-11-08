/**
 * @fileoverview Учёт расходов и цепочка fallback-моделей
 * @module opencode-consilium
 */

import type { AgentErrorCode, AgentUsage } from './types.js';

/** Сводный отчёт о расходах */
export interface CostReport {
  /** Лимит расходов (если задан) */
  limit?: number;
  /** Суммарные расходы */
  spent: number;
  /** Флаг превышения лимита */
  exceeded: boolean;
  /** Расходы по агентам */
  byAgent: Record<string, number>;
}

/** Накопительный учёт расходов */
export interface CostTracker {
  /** Учесть расход агента */
  add(agent: string, usage?: AgentUsage): CostReport;
  /** Текущий отчёт (копия) */
  report(): CostReport;
  /** Превышен ли лимит */
  exceeded(): boolean;
}

/** Проверка конечности неотрицательного лимита */
function normalizeLimit(limit: number | undefined): number | undefined {
  if (limit === undefined) return undefined;
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit < 0) return undefined;
  return limit;
}

/** Округляет стоимость до микроцентов */
function roundCost(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

/**
 * Создать трекер расходов
 * @param limit Необязательный лимит; невалидный (не конечный, < 0) игнорируется
 */
export function createCostTracker(limit?: number): CostTracker {
  const validLimit = normalizeLimit(limit);
  let spent = 0;
  const byAgent: Record<string, number> = {};

  /** Проверка превышения: строго больше лимита */
  function isExceeded(): boolean {
    return validLimit !== undefined && spent > validLimit;
  }

  /** Снимок состояния (копия) */
  function snapshot(): CostReport {
    const report: CostReport = { spent, exceeded: isExceeded(), byAgent: { ...byAgent } };
    if (validLimit !== undefined) report.limit = validLimit;
    return report;
  }

  return {
    add(agent: string, usage?: AgentUsage): CostReport {
      const cost = usage?.cost;
      if (typeof cost === 'number' && Number.isFinite(cost) && cost >= 0) {
        // Округляем до микроцентов, чтобы 0.1 + 0.05 не превращалось в 0.15000000000000002.
        spent = roundCost(spent + cost);
        byAgent[agent] = roundCost((byAgent[agent] ?? 0) + cost);
      }
      return snapshot();
    },
    report(): CostReport {
      return snapshot();
    },
    exceeded(): boolean {
      return isExceeded();
    }
  };
}

/** Коды ошибок, при которых имеет смысл fallback на другую модель */
const FALLBACK_CODES: ReadonlySet<AgentErrorCode> = new Set([
  'RATE_LIMITED',
  'MODEL_UNAVAILABLE',
  'EMPTY_RESPONSE'
]);

/**
 * Проверить, стоит ли переключаться на резервную модель
 * @param code Код ошибки агента
 */
export function shouldFallback(code: AgentErrorCode | undefined): boolean {
  if (code === undefined) return false;
  return FALLBACK_CODES.has(code);
}

/** Паттерн допустимого идентификатора модели */
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/#+-]*$/;

/** Проверка идентификатора модели: обрезан, содержит `/`, соответствует паттерну */
function isValidModelId(id: string): boolean {
  return id.length > 0 && id.includes('/') && MODEL_ID_PATTERN.test(id);
}

/**
 * Построить цепочку резервных моделей
 * @param primary Основная модель (исключается из цепочки)
 * @param pool Кандидаты в порядке приоритета (не мутируется)
 * @param options Опции: max — длина цепочки (по умолчанию 2, от 1 до 10)
 */
export function buildFallbackChain(
  primary: string | undefined,
  pool: string[],
  options?: { max?: number }
): string[] {
  let max = options?.max;
  if (typeof max !== 'number' || !Number.isFinite(max)) {
    max = 2;
  }
  max = Math.min(10, Math.max(1, Math.floor(max)));

  const primaryTrimmed = typeof primary === 'string' ? primary.trim() : '';
  const seen = new Set<string>();
  const chain: string[] = [];
  for (const raw of pool) {
    if (chain.length >= max) break;
    if (typeof raw !== 'string') continue;
    const id = raw.trim();
    if (!isValidModelId(id)) continue;
    if (id === primaryTrimmed) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    chain.push(id);
  }
  return chain;
}

/** Форматирование суммы в долларах с 4 знаками */
function formatUsd(value: number): string {
  return `$${value.toFixed(4)}`;
}

/**
 * Компактный markdown-отчёт о расходах на русском
 * @param report Отчёт трекера
 */
export function formatCostReport(report: CostReport): string {
  const lines: string[] = [];
  lines.push(`**Расходы: ${formatUsd(report.spent)}**`);
  if (report.spent === 0) {
    lines.push('Расходы отсутствуют.');
  } else {
    const entries = Object.entries(report.byAgent).sort((a, b) => b[1] - a[1]);
    for (const [agent, cost] of entries) {
      lines.push(`- ${agent}: ${formatUsd(cost)}`);
    }
  }
  if (report.limit !== undefined) {
    let limitLine = `Лимит: ${formatUsd(report.limit)}`;
    limitLine += report.exceeded ? ' — превышен' : ' — в пределах лимита';
    lines.push(limitLine);
  }
  return lines.join('\n');
}
