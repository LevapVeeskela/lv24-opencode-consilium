/**
 * @fileoverview Baseline принятых находок и политика гейта `--fail-on`.
 * @module lv24-opencode-consilium
 */

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import type { FindingSeverity } from '../council/findings.js';
import { errorMessage } from '../../shared/errors.js';
import { writeFileAtomic } from '../../shared/fs.js';
import { isRecord } from '../../shared/record.js';
import { stripControlSequences } from '../../shared/redact.js';

/** Версия формата baseline */
export const BASELINE_VERSION = 1 as const;
/** Каталог baseline относительно корня проекта */
export const BASELINE_DIRECTORY = '.consilium';
/** Имя файла baseline */
export const BASELINE_FILENAME = 'baseline.json';
/** Срок жизни записи baseline по умолчанию, дней */
export const DEFAULT_PRUNE_DAYS = 90;
/** Сколько находок печатать в отчёте гейта */
export const MAX_GATE_FINDINGS = 10;

/** Уровни серьёзности в порядке убывания */
export const FINDING_SEVERITIES: readonly FindingSeverity[] = [
  'critical',
  'high',
  'medium',
  'low',
  'info'
];

/** Порог политики: конкретная серьёзность или отсутствие гейта */
export type FailOnLevel = FindingSeverity | 'none';

/** Допустимые значения `--fail-on` */
export const FAIL_ON_LEVELS: readonly FailOnLevel[] = [...FINDING_SEVERITIES, 'none'];

const SEVERITY_RANK: Record<FindingSeverity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  info: 0
};

/** Принятая находка в baseline */
export interface BaselineEntry {
  fingerprint: string;
  severity: FindingSeverity;
  claim: string;
  acceptedAt: string;
}

/** Содержимое `.consilium/baseline.json` */
export interface BaselineFile {
  version: typeof BASELINE_VERSION;
  updatedAt: string;
  findings: BaselineEntry[];
}

/** Результат чтения baseline: при отсутствии/поломке — пустой baseline и предупреждение */
export interface BaselineLoadResult {
  baseline: BaselineFile;
  warning?: string;
}

/** Результат добавления находок в baseline */
export interface BaselineAcceptResult {
  baseline: BaselineFile;
  added: number;
  updated: number;
}

/** Параметры очистки baseline */
export interface BaselinePruneOptions {
  /** Удалить записи старше N дней (по умолчанию 90) */
  olderThanDays?: number;
  /** Удалить все записи */
  all?: boolean;
  /** Момент отсчёта (для тестов) */
  now?: Date;
}

/** Результат очистки baseline */
export interface BaselinePruneResult {
  baseline: BaselineFile;
  removed: number;
}

/**
 * Минимальные поля находки, нужные baseline и гейту.
 * Полная `Finding` структурно совместима с этим типом.
 */
export interface BaselineFinding {
  fingerprint: string;
  severity: FindingSeverity;
  claim: string;
  file?: string;
  line?: number;
}

/** Результат проверки политики */
export interface PolicyGateResult {
  threshold: FailOnLevel;
  /** Всего находок до фильтрации baseline */
  total: number;
  /** Сколько находок отброшено как принятые в baseline */
  accepted: number;
  /** Сколько находок осталось после фильтрации */
  remaining: number;
  /** Счётчики оставшихся находок по уровням */
  counts: Record<FindingSeverity, number>;
  /** Счётчики нарушений (находок не ниже порога) */
  violationCounts: Record<FindingSeverity, number>;
  /** Находки, нарушающие порог, отсортированы по убыванию серьёзности */
  violations: BaselineFinding[];
  failed: boolean;
}

/**
 * Возвращает путь к baseline. Принимает корень проекта либо готовый путь
 * к файлу `baseline.json`.
 */
export function resolveBaselinePath(cwdOrFile: string = process.cwd()): string {
  const resolved = path.resolve(cwdOrFile);
  if (path.basename(resolved) === BASELINE_FILENAME) {
    return resolved;
  }
  return path.join(resolved, BASELINE_DIRECTORY, BASELINE_FILENAME);
}

/** Пустой baseline с текущей отметкой времени */
export function emptyBaseline(now: Date = new Date()): BaselineFile {
  return {
    version: BASELINE_VERSION,
    updatedAt: now.toISOString(),
    findings: []
  };
}

/**
 * Читает baseline. Отсутствующий, нечитаемый или повреждённый файл не роняет
 * команду: возвращается пустой baseline и предупреждение.
 */
export function loadBaseline(
  cwdOrFile: string = process.cwd(),
  now: Date = new Date()
): BaselineLoadResult {
  const file = resolveBaselinePath(cwdOrFile);
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      baseline: emptyBaseline(now),
      warning:
        code === 'ENOENT'
          ? `Baseline не найден: ${file}`
          : `Не удалось прочитать baseline ${file}: ${errorMessage(error)}`
    };
  }

  let data: unknown;
  try {
    // UTF-8 BOM не мешает JSON.parse только после удаления.
    data = JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch (error) {
    return {
      baseline: emptyBaseline(now),
      warning: `Некорректный baseline ${file}: ${errorMessage(error)}`
    };
  }

  if (
    !isRecord(data) ||
    data['version'] !== BASELINE_VERSION ||
    !Array.isArray(data['findings'])
  ) {
    return {
      baseline: emptyBaseline(now),
      warning:
        `Некорректный baseline ${file}: ожидался объект version=${BASELINE_VERSION} ` +
        'с массивом findings'
    };
  }

  const byFingerprint = new Map<string, BaselineEntry>();
  let skipped = 0;
  for (const item of data['findings']) {
    const entry = parseBaselineEntry(item);
    if (entry === null) {
      skipped += 1;
      continue;
    }
    // Дубликаты в повреждённом файле схлопываем: последняя запись побеждает.
    byFingerprint.set(entry.fingerprint, entry);
  }

  const updatedAt =
    typeof data['updatedAt'] === 'string' && data['updatedAt'].length > 0
      ? data['updatedAt']
      : now.toISOString();
  const baseline: BaselineFile = {
    version: BASELINE_VERSION,
    updatedAt,
    findings: [...byFingerprint.values()]
  };
  if (skipped > 0) {
    return {
      baseline,
      warning: `Baseline ${file}: пропущено некорректных записей: ${skipped}`
    };
  }
  return { baseline };
}

/** Атомарно записывает baseline и возвращает сохранённое содержимое */
export function saveBaseline(
  cwdOrFile: string,
  baseline: BaselineFile,
  now: Date = new Date()
): BaselineFile {
  const saved: BaselineFile = {
    version: BASELINE_VERSION,
    updatedAt: now.toISOString(),
    findings: baseline.findings.map(entry => ({ ...entry }))
  };
  writeFileAtomic(resolveBaselinePath(cwdOrFile), `${JSON.stringify(saved, null, 2)}\n`);
  return saved;
}

/**
 * Добавляет находки в baseline по fingerprint. У существующих записей
 * сохраняется `acceptedAt`, обновляются severity и claim.
 */
export function acceptFindings(
  baseline: BaselineFile,
  findings: readonly BaselineFinding[],
  now: Date = new Date()
): BaselineAcceptResult {
  const acceptedAt = now.toISOString();
  const byFingerprint = new Map<string, BaselineEntry>(
    baseline.findings.map(entry => [entry.fingerprint, entry])
  );
  let added = 0;
  let updated = 0;

  for (const finding of findings) {
    if (finding.fingerprint.trim().length === 0) continue;
    const existing = byFingerprint.get(finding.fingerprint);
    if (existing === undefined) {
      added += 1;
    } else {
      updated += 1;
    }
    byFingerprint.set(finding.fingerprint, {
      fingerprint: finding.fingerprint,
      severity: finding.severity,
      claim: finding.claim,
      acceptedAt: existing?.acceptedAt ?? acceptedAt
    });
  }

  return {
    baseline: {
      version: BASELINE_VERSION,
      updatedAt: acceptedAt,
      findings: [...byFingerprint.values()]
    },
    added,
    updated
  };
}

/**
 * Удаляет записи старше `olderThanDays` (по умолчанию 90) или все.
 * Записи с некорректной датой считаются устаревшими.
 */
export function pruneBaseline(
  baseline: BaselineFile,
  options: BaselinePruneOptions = {}
): BaselinePruneResult {
  const now = options.now ?? new Date();
  const days = Math.max(0, options.olderThanDays ?? DEFAULT_PRUNE_DAYS);
  const cutoff = now.getTime() - days * 24 * 60 * 60 * 1000;
  const kept = baseline.findings.filter(entry => {
    if (options.all === true) return false;
    const accepted = Date.parse(entry.acceptedAt);
    return Number.isFinite(accepted) && accepted >= cutoff;
  });

  return {
    baseline: {
      version: BASELINE_VERSION,
      updatedAt: now.toISOString(),
      findings: kept
    },
    removed: baseline.findings.length - kept.length
  };
}

/**
 * Извлекает минимальные находки из метаданных артефакта запуска.
 * Некорректные элементы пропускаются.
 */
export function artifactFindings(run: {
  metadata?: Record<string, unknown>;
}): BaselineFinding[] {
  const summary = run.metadata?.['findings'];
  if (!isRecord(summary) || !Array.isArray(summary['items'])) return [];

  const result: BaselineFinding[] = [];
  for (const item of summary['items']) {
    if (!isRecord(item)) continue;
    const fingerprint = item['fingerprint'];
    const claim = item['claim'];
    const severity = normalizeSeverity(item['severity']);
    if (typeof fingerprint !== 'string' || fingerprint.length === 0) continue;
    if (typeof claim !== 'string' || claim.length === 0) continue;
    if (severity === null) continue;

    const finding: BaselineFinding = { fingerprint, severity, claim };
    if (typeof item['file'] === 'string' && item['file'].length > 0) {
      finding.file = item['file'];
    }
    const line = item['line'];
    if (typeof line === 'number' && Number.isFinite(line) && line > 0) {
      finding.line = Math.floor(line);
    }
    result.push(finding);
  }
  return result;
}

/**
 * Проверяет политику: отбрасывает принятые в baseline находки и ищет
 * оставшиеся с серьёзностью не ниже порога.
 */
export function evaluatePolicyGate(
  findings: readonly BaselineFinding[] | undefined,
  baseline: BaselineFile | readonly BaselineEntry[] | ReadonlySet<string> | undefined,
  threshold: FailOnLevel
): PolicyGateResult {
  const items = findings ?? [];
  const acceptedFingerprints = new Set<string>();
  if (isFingerprintSet(baseline)) {
    for (const fingerprint of baseline) acceptedFingerprints.add(fingerprint);
  } else if (isBaselineEntryArray(baseline)) {
    for (const entry of baseline) acceptedFingerprints.add(entry.fingerprint);
  } else if (baseline !== undefined) {
    for (const entry of baseline.findings ?? []) {
      acceptedFingerprints.add(entry.fingerprint);
    }
  }
  const remaining = items.filter(item => !acceptedFingerprints.has(item.fingerprint));
  const violations =
    threshold === 'none'
      ? []
      : remaining
          .filter(item => SEVERITY_RANK[item.severity] >= SEVERITY_RANK[threshold])
          .sort((left, right) => {
            const bySeverity = SEVERITY_RANK[right.severity] - SEVERITY_RANK[left.severity];
            return bySeverity !== 0 ? bySeverity : left.claim.localeCompare(right.claim);
          });

  return {
    threshold,
    total: items.length,
    accepted: items.length - remaining.length,
    remaining: remaining.length,
    counts: countSeverities(remaining),
    violationCounts: countSeverities(violations),
    violations,
    failed: violations.length > 0
  };
}

/** Компактный отчёт о сработавшем гейте: счётчики и до 10 верхних находок */
export function formatPolicyGate(
  result: PolicyGateResult,
  limit: number = MAX_GATE_FINDINGS
): string {
  const max = Math.max(0, Math.floor(limit));
  const top = result.violations.slice(0, max);
  const counts = formatSeverityCounts(result.violationCounts);
  const header =
    `🚦 Policy gate (--fail-on ${result.threshold}): ` +
    `${result.violations.length} находок не ниже порога` +
    (counts.length > 0 ? ` (${counts})` : '') +
    ` · принято baseline: ${result.accepted} · всего: ${result.total}`;

  const lines = [header];
  for (const finding of top) {
    const file =
      finding.file === undefined ? '—' : flattenText(stripControlSequences(finding.file));
    const location = finding.line === undefined ? file : `${file}:${finding.line}`;
    const claim = truncateText(flattenText(stripControlSequences(finding.claim)), 160);
    lines.push(`  - ${location} [${finding.severity}] ${claim}`);
  }
  if (result.violations.length > top.length) {
    lines.push(`  … ещё ${result.violations.length - top.length}`);
  }
  return lines.join('\n');
}

function parseBaselineEntry(value: unknown): BaselineEntry | null {
  if (!isRecord(value)) return null;
  const fingerprint = value['fingerprint'];
  const claim = value['claim'];
  const acceptedAt = value['acceptedAt'];
  const severity = normalizeSeverity(value['severity']);
  if (typeof fingerprint !== 'string' || fingerprint.trim().length === 0) return null;
  if (typeof claim !== 'string') return null;
  if (typeof acceptedAt !== 'string' || acceptedAt.trim().length === 0) return null;
  if (severity === null) return null;
  return { fingerprint, severity, claim, acceptedAt };
}

function normalizeSeverity(value: unknown): FindingSeverity | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return (FINDING_SEVERITIES as readonly string[]).includes(normalized)
    ? (normalized as FindingSeverity)
    : null;
}

function isFingerprintSet(value: unknown): value is ReadonlySet<string> {
  return value instanceof Set;
}

function isBaselineEntryArray(value: unknown): value is readonly BaselineEntry[] {
  return Array.isArray(value);
}

function countSeverities(items: readonly BaselineFinding[]): Record<FindingSeverity, number> {
  const counts: Record<FindingSeverity, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    info: 0
  };
  for (const item of items) counts[item.severity] += 1;
  return counts;
}

function formatSeverityCounts(counts: Record<FindingSeverity, number>): string {
  return FINDING_SEVERITIES.filter(severity => counts[severity] > 0)
    .map(severity => `${severity}: ${counts[severity]}`)
    .join(', ');
}

/** Схлопывает переводы строк, чтобы находка оставалась одной строкой */
function flattenText(value: string): string {
  return value.replace(/\r\n?|[\n\u2028\u2029]/g, ' ');
}

/** Обрезает строку по code points, не разрывая суррогатные пары */
function truncateText(value: string, limit: number): string {
  const chars = Array.from(value);
  return chars.length <= limit ? value : `${chars.slice(0, limit).join('')}…`;
}
