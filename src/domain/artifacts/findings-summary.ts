/**
 * @fileoverview Defensive extraction of normalized findings from run metadata.
 * Shared by the HTML/PR/SARIF and Jira/Linear report renderers.
 * @module lv24-opencode-consilium
 */

import type {
  Finding,
  FindingSeverity,
  FindingSource,
  FindingsSummary,
  RejectedPosition
} from '../council/findings.js';
import type { ConsiliumResult } from '../types.js';

const SEVERITIES: readonly FindingSeverity[] = ['critical', 'high', 'medium', 'low', 'info'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toSeverity(value: unknown): FindingSeverity {
  if (typeof value !== 'string') return 'medium';
  const normalized = value.trim().toLowerCase();
  return (SEVERITIES as readonly string[]).includes(normalized)
    ? (normalized as FindingSeverity)
    : 'medium';
}

function toFindingSource(value: unknown): FindingSource | null {
  if (!isRecord(value)) return null;
  const agent = typeof value['agent'] === 'string' ? value['agent'] : '';
  if (agent.length === 0) return null;
  const model =
    typeof value['model'] === 'string' && value['model'].length > 0
      ? value['model']
      : undefined;
  return { agent, model };
}

function toFinding(value: unknown): Finding | null {
  if (!isRecord(value)) return null;
  const claim = typeof value['claim'] === 'string' ? value['claim'].trim() : '';
  if (claim.length === 0) return null;
  const lineValue = value['line'];
  const line =
    typeof lineValue === 'number' && Number.isFinite(lineValue) && lineValue > 0
      ? Math.floor(lineValue)
      : undefined;
  const confidenceValue = value['confidence'];
  const confidence =
    typeof confidenceValue === 'number' &&
    Number.isFinite(confidenceValue) &&
    confidenceValue >= 0 &&
    confidenceValue <= 1
      ? confidenceValue
      : undefined;
  const rejectedBy = strArray(value['rejectedBy']);
  const sources = Array.isArray(value['sources'])
    ? value['sources']
        .map(toFindingSource)
        .filter((source): source is FindingSource => source !== null)
    : [];
  return {
    fingerprint: typeof value['fingerprint'] === 'string' ? value['fingerprint'] : '',
    severity: toSeverity(value['severity']),
    category:
      typeof value['category'] === 'string' && value['category'].trim().length > 0
        ? value['category']
        : 'general',
    file:
      typeof value['file'] === 'string' && value['file'].length > 0
        ? value['file']
        : undefined,
    line,
    claim,
    evidence: typeof value['evidence'] === 'string' ? value['evidence'] : undefined,
    confidence,
    sources,
    contested: value['contested'] === true || rejectedBy.length > 0,
    rejectedBy
  };
}

function toRejectedPosition(value: unknown): RejectedPosition | null {
  if (!isRecord(value)) return null;
  const claim = typeof value['claim'] === 'string' ? value['claim'].trim() : '';
  if (claim.length === 0) return null;
  return {
    claim,
    reason:
      typeof value['reason'] === 'string' && value['reason'].length > 0
        ? value['reason']
        : undefined,
    agent: typeof value['agent'] === 'string' ? value['agent'] : ''
  };
}

function zeroCounts(): Record<FindingSeverity, number> {
  return { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
}

function normalizeCounts(value: unknown, items: Finding[]): Record<FindingSeverity, number> {
  const derived = zeroCounts();
  for (const item of items) derived[item.severity] += 1;
  if (!isRecord(value)) return derived;
  const parsed = zeroCounts();
  let total = 0;
  for (const severity of SEVERITIES) {
    const count = value[severity];
    if (typeof count !== 'number' || !Number.isFinite(count) || count < 0) return derived;
    parsed[severity] = Math.trunc(count);
    total += parsed[severity];
  }
  return total === items.length ? parsed : derived;
}

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/** Извлекает валидную сводку находок из произвольного `metadata` или возвращает null. */
export function findingsSummaryFromMetadata(metadata: unknown): FindingsSummary | null {
  if (!isRecord(metadata)) return null;
  const raw = metadata['findings'];
  if (!isRecord(raw) || !Array.isArray(raw['items'])) return null;
  const items = raw['items']
    .map(toFinding)
    .filter((item): item is Finding => item !== null);
  const rejected = Array.isArray(raw['rejected'])
    ? raw['rejected']
        .map(toRejectedPosition)
        .filter((item): item is RejectedPosition => item !== null)
    : [];
  return {
    items,
    counts: normalizeCounts(raw['counts'], items),
    rejected,
    parseErrors: strArray(raw['parseErrors'])
  };
}

/** Извлекает валидную сводку находок из результата запуска или возвращает null. */
export function findingsSummaryOf(result: ConsiliumResult): FindingsSummary | null {
  return findingsSummaryFromMetadata(result.metadata);
}

/** Форматирует счётчики серьёзности: `critical: 0, high: 1, ...`. */
export function formatFindingsCounts(counts: Record<FindingSeverity, number>): string {
  return SEVERITIES.map(severity => `${severity}: ${counts[severity]}`).join(', ');
}

/** Локация находки в формате `file:line` (или `—`). */
export function findingsLocation(item: Finding): string {
  if (item.file === undefined) return '—';
  return item.line === undefined ? item.file : `${item.file}:${item.line}`;
}
