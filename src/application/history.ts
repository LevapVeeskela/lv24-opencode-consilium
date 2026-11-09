/**
 * @fileoverview История запусков консилиума и агрегированная статистика.
 * Чтение артефактов идёт best-effort: битые файлы пропускаются с предупреждением,
 * отсутствующий каталог даёт пустую историю.
 * @module lv24-opencode-consilium
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { AgentUsage } from '../domain/types.js';
import type { FindingSeverity } from '../domain/council/findings.js';
import { escapeHtml } from '../domain/artifacts/report.js';
import { errorMessage } from '../shared/errors.js';
import { isRecord } from '../shared/record.js';

const SEVERITIES: readonly FindingSeverity[] = ['critical', 'high', 'medium', 'low', 'info'];
const SEVERITY_RANK: Record<FindingSeverity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  info: 0
};
const MAX_TOP_ERRORS = 5;
const MAX_TOP_FINDINGS = 10;
const MAX_RECENT_RUNS = 10;
const MAX_TASK_CHARS = 300;
const MAX_CLAIM_CHARS = 500;

/** Находка, сохранённая в артефакте запуска. */
export interface HistoryFinding {
  severity: FindingSeverity;
  claim: string;
  contested: boolean;
}

/** Счётчики находок по уровням серьёзности. */
export interface HistoryFindingCounts {
  critical: number;
  high: number;
  medium: number;
  low: number;
  info: number;
}

/** Эксперт в сохранённом запуске. */
export interface HistoryExpert {
  agent: string;
  model?: string;
  success: boolean;
  errorCode?: string;
  duration?: number;
  cost?: number;
  usage?: AgentUsage;
}

/** Один запуск в истории. */
export interface HistoryEntry {
  id: string;
  dir: string;
  createdAt: string;
  mtimeMs: number;
  task: string;
  success: boolean;
  experts: HistoryExpert[];
  expertCount: number;
  successfulExperts: number;
  durationMs?: number;
  cost: number;
  findings: {
    counts: HistoryFindingCounts;
    total: number;
    contested: number;
    items: HistoryFinding[];
  };
  agreement?: string;
}

/** Результат чтения истории. */
export interface HistoryLoadResult {
  dir: string;
  entries: HistoryEntry[];
  warnings: string[];
}

/** Параметр `код ошибки — количество`. */
export interface HistoryErrorCount {
  code: string;
  count: number;
}

/** Статистика одной модели. */
export interface HistoryModelStats {
  model: string;
  attempts: number;
  successes: number;
  failures: number;
  errors: HistoryErrorCount[];
}

/** Краткая запись запуска для HTML-отчёта. */
export interface HistoryRecentRun {
  id: string;
  createdAt: string;
  task: string;
  success: boolean;
  cost: number;
}

/** Находка, встретившаяся в истории, с числом повторов. */
export interface HistoryTopFinding {
  severity: FindingSeverity;
  claim: string;
  count: number;
  contested: boolean;
}

/** Статистика по процентилям длительности. */
export interface HistoryDurationStats {
  p50: number;
  p95: number;
  count: number;
}

/** Агрегированная статистика истории. */
export interface HistoryStats {
  totalRuns: number;
  successfulRuns: number;
  failedRuns: number;
  /** Доля успешных запусков в диапазоне [0, 1]. */
  successRate: number;
  duration: HistoryDurationStats | null;
  totalCost: number;
  findings: {
    counts: HistoryFindingCounts;
    total: number;
  };
  contested: number;
  models: HistoryModelStats[];
  topErrorCodes: HistoryErrorCount[];
  agreement: Record<string, number>;
  recentRuns: HistoryRecentRun[];
  topFindings: HistoryTopFinding[];
}

/** Опции загрузки истории. */
export interface LoadHistoryOptions {
  /** Каталог с подкаталогами запусков (`.../.consilium/runs`). */
  dir: string;
  /** Максимальное число самых новых запусков. */
  limit?: number;
}

function zeroCounts(): HistoryFindingCounts {
  return { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function nonNegativeNumber(value: unknown): number | undefined {
  const parsed = finiteNumber(value);
  return parsed !== undefined && parsed >= 0 ? parsed : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

function toSeverity(value: unknown): FindingSeverity {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return (SEVERITIES as readonly string[]).includes(normalized)
    ? (normalized as FindingSeverity)
    : 'medium';
}

/** Разбирает usage, оставляя только числовые поля. */
function parseUsage(value: unknown): AgentUsage | undefined {
  if (!isRecord(value)) return undefined;
  const usage: AgentUsage = {};
  const fields: Array<keyof AgentUsage> = [
    'inputTokens',
    'outputTokens',
    'reasoningTokens',
    'cacheReadTokens',
    'cacheWriteTokens',
    'cost'
  ];
  let hasField = false;
  for (const field of fields) {
    const parsed = nonNegativeNumber(value[field]);
    if (parsed !== undefined) {
      usage[field] = parsed;
      hasField = true;
    }
  }
  return hasField ? usage : undefined;
}

/** Разбирает массив сохранённых экспертов. */
function parseExperts(value: unknown, models: unknown): HistoryExpert[] {
  if (!Array.isArray(value)) return [];
  const modelMap = isRecord(models) ? models : {};
  const experts: HistoryExpert[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const agent = nonEmptyString(item['agent']) ?? 'unknown';
    const model =
      nonEmptyString(item['model']) ??
      nonEmptyString(modelMap[agent]);
    const expert: HistoryExpert = {
      agent,
      success: item['success'] === true
    };
    if (model !== undefined) expert.model = model;
    const errorCode = nonEmptyString(item['errorCode']);
    if (errorCode !== undefined) expert.errorCode = errorCode;
    const duration = nonNegativeNumber(item['duration']);
    if (duration !== undefined) expert.duration = duration;
    const usage = parseUsage(item['usage']);
    if (usage !== undefined) {
      expert.usage = usage;
      if (usage.cost !== undefined) expert.cost = usage.cost;
    }
    experts.push(expert);
  }
  return experts;
}

/** Разбирает `metadata.findings`: counts, items и contested. */
function parseFindings(value: unknown): HistoryEntry['findings'] {
  const counts = zeroCounts();
  const items: HistoryFinding[] = [];
  let hasCounts = false;
  let contested = 0;

  if (isRecord(value)) {
    const rawCounts = value['counts'];
    if (isRecord(rawCounts)) {
      for (const severity of SEVERITIES) {
        const parsed = nonNegativeNumber(rawCounts[severity]);
        if (parsed === undefined) continue;
        counts[severity] = Math.trunc(parsed);
        hasCounts = true;
      }
    }

    const rawItems = value['items'];
    if (Array.isArray(rawItems)) {
      for (const item of rawItems.slice(0, 100)) {
        if (!isRecord(item)) continue;
        const claim = nonEmptyString(item['claim']);
        if (claim === undefined) continue;
        const finding: HistoryFinding = {
          severity: toSeverity(item['severity']),
          claim: truncate(claim, MAX_CLAIM_CHARS),
          contested: item['contested'] === true
        };
        if (finding.contested) contested += 1;
        items.push(finding);
      }
    }

    if (!hasCounts && items.length > 0) {
      for (const item of items) counts[item.severity] += 1;
    }
    if (items.length === 0) {
      const explicit = nonNegativeNumber(value['contested']);
      if (explicit !== undefined) contested = Math.trunc(explicit);
    }
  }

  const total = hasCounts || items.length > 0
    ? SEVERITIES.reduce((sum, severity) => sum + counts[severity], 0)
    : 0;
  return { counts, total, contested, items };
}

/** Достаёт agreement из metadata.consensus или корневого consensus. */
function parseAgreement(metadata: unknown, rootConsensus: unknown): string | undefined {
  const candidates = [
    isRecord(metadata) ? metadata['consensus'] : undefined,
    rootConsensus
  ];
  for (const candidate of candidates) {
    if (!isRecord(candidate)) continue;
    const agreement = nonEmptyString(candidate['agreement']);
    if (agreement !== undefined) return agreement;
  }
  return undefined;
}

/** Суммирует стоимость usage у экспертов и председателя. */
function sumUsageCosts(values: unknown[]): number | undefined {
  let total = 0;
  let found = false;
  for (const value of values) {
    if (!isRecord(value)) continue;
    const usage = isRecord(value['usage'])
      ? parseUsage(value['usage'])
      : parseUsage(value);
    if (usage?.cost === undefined) continue;
    total += usage.cost;
    found = true;
  }
  return found ? total : undefined;
}

/** Преобразует разобранный run.json в запись истории. */
function toHistoryEntry(data: unknown, dir: string, mtimeMs: number): HistoryEntry | null {
  if (!isRecord(data)) return null;
  const id = nonEmptyString(data['id']);
  if (id === undefined) return null;

  const metadata = isRecord(data['metadata']) ? data['metadata'] : {};
  const experts = parseExperts(data['experts'], data['models']);
  const chair = isRecord(data['chair']) ? data['chair'] : undefined;
  const findings = parseFindings(metadata['findings']);

  const usage = isRecord(data['usage']) ? data['usage'] : undefined;
  const metadataCost = isRecord(metadata['cost']) ? metadata['cost'] : undefined;
  const cost =
    nonNegativeNumber(usage?.['cost']) ??
    nonNegativeNumber(metadataCost?.['spent']) ??
    sumUsageCosts([
      ...(Array.isArray(data['experts']) ? data['experts'] : []),
      ...(chair === undefined ? [] : [chair])
    ]) ??
    0;

  const explicitDuration =
    nonNegativeNumber(data['totalTime']) ??
    nonNegativeNumber(data['duration']) ??
    nonNegativeNumber(metadata['totalTime']) ??
    nonNegativeNumber(metadata['duration']) ??
    nonNegativeNumber(metadata['durationMs']);
  const expertDuration = experts.reduce<number | undefined>((max, expert) => {
    if (expert.duration === undefined) return max;
    return max === undefined ? expert.duration : Math.max(max, expert.duration);
  }, undefined);
  const durationMs = explicitDuration ?? expertDuration;

  const createdAt =
    nonEmptyString(data['createdAt']) ?? new Date(mtimeMs).toISOString();
  const task = typeof data['task'] === 'string' ? data['task'] : '';
  const successfulExperts = experts.filter(expert => expert.success).length;
  const agreement = parseAgreement(metadata, data['consensus']);

  const entry: HistoryEntry = {
    id,
    dir,
    createdAt,
    mtimeMs,
    task: truncate(task, MAX_TASK_CHARS),
    success: data['success'] === true,
    experts,
    expertCount: experts.length,
    successfulExperts,
    cost,
    findings
  };
  if (durationMs !== undefined) entry.durationMs = durationMs;
  if (agreement !== undefined) entry.agreement = agreement;
  return entry;
}

/**
 * Читает `run.json` из подкаталогов `dir`, сортирует новые сверху по mtime
 * и применяет limit. Битые файлы попадают в warnings, а не в исключение.
 */
export function loadHistory(options: LoadHistoryOptions): HistoryLoadResult {
  const dir = resolve(options.dir);
  const warnings: string[] = [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      warnings.push(`Cannot read history directory ${dir}: ${errorMessage(error)}`);
    }
    return { dir, entries: [], warnings };
  }

  const entries: HistoryEntry[] = [];
  for (const name of names) {
    const runDir = join(dir, name);
    const file = join(runDir, 'run.json');
    let mtimeMs: number;
    try {
      const stat = statSync(file);
      if (!stat.isFile()) continue;
      mtimeMs = stat.mtimeMs;
    } catch {
      continue;
    }

    let raw: string;
    try {
      raw = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    } catch (error) {
      warnings.push(`Skipped unreadable run file ${file}: ${errorMessage(error)}`);
      continue;
    }

    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch (error) {
      warnings.push(`Skipped corrupt run file ${file}: ${errorMessage(error)}`);
      continue;
    }

    const entry = toHistoryEntry(data, runDir, mtimeMs);
    if (entry === null) {
      warnings.push(`Skipped corrupt run file ${file}: invalid artifact shape`);
      continue;
    }
    entries.push(entry);
  }

  entries.sort((left, right) => {
    if (right.mtimeMs !== left.mtimeMs) return right.mtimeMs - left.mtimeMs;
    if (left.createdAt !== right.createdAt) {
      return right.createdAt < left.createdAt ? -1 : 1;
    }
    return left.id < right.id ? 1 : left.id > right.id ? -1 : 0;
  });

  const limit = options.limit;
  if (limit !== undefined && Number.isFinite(limit)) {
    entries.splice(Math.max(0, Math.trunc(limit)));
  }
  return { dir, entries, warnings };
}

/** Ближайший процентиль с линейной интерполяцией, округлённый до мс. */
function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const index = (sorted.length - 1) * fraction;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return Math.round(sorted[lower]);
  return Math.round(sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower));
}

/** Агрегирует записи истории: успешность, стоимость, находки, модели и согласие. */
export function summarizeHistory(entries: readonly HistoryEntry[]): HistoryStats {
  const totalRuns = entries.length;
  const successfulRuns = entries.filter(entry => entry.success).length;
  const failedRuns = totalRuns - successfulRuns;

  const durations: number[] = [];
  const counts = zeroCounts();
  let contested = 0;
  let totalCost = 0;

  const modelMap = new Map<
    string,
    { attempts: number; successes: number; failures: number; errors: Map<string, number> }
  >();
  const agreementMap = new Map<string, number>();
  const findingMap = new Map<
    string,
    { severity: FindingSeverity; claim: string; count: number; contested: boolean }
  >();

  for (const entry of entries) {
    totalCost += entry.cost;
    if (entry.durationMs !== undefined) durations.push(entry.durationMs);
    for (const severity of SEVERITIES) counts[severity] += entry.findings.counts[severity];
    contested += entry.findings.contested;
    if (entry.agreement !== undefined) {
      agreementMap.set(entry.agreement, (agreementMap.get(entry.agreement) ?? 0) + 1);
    }

    for (const expert of entry.experts) {
      const model = expert.model ?? 'unknown';
      let stats = modelMap.get(model);
      if (stats === undefined) {
        stats = { attempts: 0, successes: 0, failures: 0, errors: new Map() };
        modelMap.set(model, stats);
      }
      stats.attempts += 1;
      if (expert.success) {
        stats.successes += 1;
      } else {
        stats.failures += 1;
        if (expert.errorCode !== undefined) {
          stats.errors.set(expert.errorCode, (stats.errors.get(expert.errorCode) ?? 0) + 1);
        }
      }
    }

    for (const finding of entry.findings.items) {
      const key = `${finding.severity}\u0000${finding.claim}`;
      const existing = findingMap.get(key);
      if (existing === undefined) {
        findingMap.set(key, {
          severity: finding.severity,
          claim: finding.claim,
          count: 1,
          contested: finding.contested
        });
      } else {
        existing.count += 1;
        existing.contested = existing.contested || finding.contested;
      }
    }
  }

  const models: HistoryModelStats[] = [...modelMap.entries()]
    .map(([model, stats]) => ({
      model,
      attempts: stats.attempts,
      successes: stats.successes,
      failures: stats.failures,
      errors: [...stats.errors.entries()]
        .map(([code, count]) => ({ code, count }))
        .sort((left, right) => right.count - left.count || (left.code < right.code ? -1 : 1))
    }))
    .sort(
      (left, right) =>
        right.attempts - left.attempts || (left.model < right.model ? -1 : left.model > right.model ? 1 : 0)
    );

  const errorTotals = new Map<string, number>();
  for (const model of models) {
    for (const error of model.errors) {
      errorTotals.set(error.code, (errorTotals.get(error.code) ?? 0) + error.count);
    }
  }
  const topErrorCodes = [...errorTotals.entries()]
    .map(([code, count]) => ({ code, count }))
    .sort((left, right) => right.count - left.count || (left.code < right.code ? -1 : 1))
    .slice(0, MAX_TOP_ERRORS);

  const agreement: Record<string, number> = {};
  for (const key of [...agreementMap.keys()].sort()) {
    agreement[key] = agreementMap.get(key) ?? 0;
  }

  const topFindings: HistoryTopFinding[] = [...findingMap.values()]
    .sort(
      (left, right) =>
        SEVERITY_RANK[right.severity] - SEVERITY_RANK[left.severity] ||
        right.count - left.count ||
        (left.claim < right.claim ? -1 : left.claim > right.claim ? 1 : 0)
    )
    .slice(0, MAX_TOP_FINDINGS);

  return {
    totalRuns,
    successfulRuns,
    failedRuns,
    successRate: totalRuns === 0 ? 0 : successfulRuns / totalRuns,
    duration:
      durations.length === 0
        ? null
        : {
            p50: percentile(durations, 0.5),
            p95: percentile(durations, 0.95),
            count: durations.length
          },
    totalCost,
    findings: {
      counts,
      total: SEVERITIES.reduce((sum, severity) => sum + counts[severity], 0)
    },
    contested,
    models,
    topErrorCodes,
    agreement,
    recentRuns: entries.slice(0, MAX_RECENT_RUNS).map(entry => ({
      id: entry.id,
      createdAt: entry.createdAt,
      task: entry.task,
      success: entry.success,
      cost: entry.cost
    })),
    topFindings
  };
}

/** Короткая дата для таблицы: `YYYY-MM-DD HH:MM:SS` (UTC из ISO). */
function formatDate(value: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})/.exec(value);
  return match === null ? value : `${match[1]} ${match[2]}`;
}

function padRight(value: string, width: number): string {
  return value.length >= width ? value : `${value}${' '.repeat(width - value.length)}`;
}

/**
 * Форматирует историю как выровненную текстовую таблицу.
 * Колонки: id, date, success, experts, cost, findings (critical/high/medium/low), agreement.
 */
export function formatHistoryTable(entries: readonly HistoryEntry[]): string {
  if (entries.length === 0) return 'No runs.';
  const headers = ['id', 'date', 'success', 'experts', 'cost', 'findings(critical/high/medium/low)', 'agreement'];
  const rows = entries.map(entry => [
    entry.id,
    formatDate(entry.createdAt),
    entry.success ? 'ok' : 'FAIL',
    `${entry.successfulExperts}/${entry.expertCount}`,
    `$${entry.cost.toFixed(4)}`,
    [
      entry.findings.counts.critical,
      entry.findings.counts.high,
      entry.findings.counts.medium,
      entry.findings.counts.low
    ].join('/'),
    entry.agreement ?? '—'
  ]);
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map(row => row[index].length))
  );
  const lines = [
    headers.map((header, index) => padRight(header, widths[index])).join('  '),
    widths.map(width => '-'.repeat(width)).join('  ')
  ];
  for (const row of rows) {
    lines.push(row.map((value, index) => padRight(value, widths[index])).join('  '));
  }
  return lines.join('\n');
}

/** Форматирует агрегированную статистику как текст. */
export function formatStats(summary: HistoryStats): string {
  const lines: string[] = [];
  lines.push(
    `Runs: ${summary.totalRuns} (${summary.successfulRuns} ok, ${summary.failedRuns} failed)`
  );
  lines.push(`Success rate: ${(summary.successRate * 100).toFixed(1)}%`);
  lines.push(
    summary.duration === null
      ? 'Duration: n/a'
      : `Duration: p50 ${summary.duration.p50} ms, p95 ${summary.duration.p95} ms ` +
          `(${summary.duration.count} runs)`
  );
  lines.push(`Total cost: $${summary.totalCost.toFixed(4)}`);
  lines.push(
    `Findings: ${summary.findings.total} (` +
      `${SEVERITIES.map(severity => `${severity} ${summary.findings.counts[severity]}`).join(', ')})`
  );
  lines.push(`Contested findings: ${summary.contested}`);

  if (summary.models.length === 0) {
    lines.push('Models: none');
  } else {
    lines.push('Models:');
    lines.push('  model | attempts | successes | failures | errors');
    for (const model of summary.models) {
      const errors =
        model.errors.length === 0
          ? '—'
          : model.errors.map(error => `${error.code}: ${error.count}`).join(', ');
      lines.push(
        `  ${model.model} | ${model.attempts} | ${model.successes} | ` +
          `${model.failures} | ${errors}`
      );
    }
  }

  lines.push(
    summary.topErrorCodes.length === 0
      ? 'Top errors: none'
      : `Top errors: ${summary.topErrorCodes
          .map(error => `${error.code}: ${error.count}`)
          .join(', ')}`
  );

  const agreement = Object.entries(summary.agreement);
  lines.push(
    agreement.length === 0
      ? 'Agreement: none'
      : `Agreement: ${agreement.map(([key, value]) => `${key}: ${value}`).join(', ')}`
  );
  return lines.join('\n');
}

function cell(value: string): string {
  return escapeHtml(value.replace(/\r?\n/g, ' '));
}

function htmlTable(headers: string[], rows: string[]): string {
  return (
    '<table><thead><tr>' +
    headers.map(header => `<th>${cell(header)}</th>`).join('') +
    '</tr></thead><tbody>' +
    rows.join('') +
    '</tbody></table>'
  );
}

/**
 * Рендерит автономный статический HTML-отчёт (без скриптов и внешних ресурсов).
 * Все динамические значения экранируются.
 */
export function renderStatsHtml(summary: HistoryStats): string {
  const duration =
    summary.duration === null
      ? 'n/a'
      : `p50 ${summary.duration.p50} ms, p95 ${summary.duration.p95} ms (${summary.duration.count} runs)`;

  const modelRows = summary.models.map(
    model =>
      `<tr><td>${cell(model.model)}</td><td>${model.attempts}</td>` +
      `<td>${model.successes}</td><td>${model.failures}</td>` +
      `<td>${cell(
        model.errors.length === 0
          ? '—'
          : model.errors.map(error => `${error.code}: ${error.count}`).join(', ')
      )}</td></tr>`
  );
  const modelBlock =
    modelRows.length === 0
      ? '<p>No expert attempts.</p>'
      : htmlTable(['Model', 'Attempts', 'Successes', 'Failures', 'Errors'], modelRows);

  const errorRows = summary.topErrorCodes.map(
    error => `<tr><td>${cell(error.code)}</td><td>${error.count}</td></tr>`
  );
  const errorBlock =
    errorRows.length === 0
      ? '<p>No failures.</p>'
      : htmlTable(['Error code', 'Count'], errorRows);

  const agreementRows = Object.entries(summary.agreement).map(
    ([key, value]) => `<tr><td>${cell(key)}</td><td>${value}</td></tr>`
  );
  const agreementBlock =
    agreementRows.length === 0
      ? '<p>No consensus data.</p>'
      : htmlTable(['Agreement', 'Runs'], agreementRows);

  const recentRows = summary.recentRuns.map(
    run =>
      `<tr><td><code>${cell(run.id)}</code></td><td>${cell(formatDate(run.createdAt))}</td>` +
      `<td>${run.success ? 'ok' : 'FAIL'}</td><td>${cell(run.task)}</td>` +
      `<td>$${run.cost.toFixed(4)}</td></tr>`
  );
  const recentBlock =
    recentRows.length === 0
      ? '<p>No runs.</p>'
      : htmlTable(['ID', 'Date', 'Status', 'Task', 'Cost'], recentRows);

  const findingRows = summary.topFindings.map(
    finding =>
      `<tr><td><span class="sev sev-${finding.severity}">${finding.severity}</span></td>` +
      `<td>${cell(finding.claim)}</td><td>${finding.count}</td>` +
      `<td>${finding.contested ? 'yes' : 'no'}</td></tr>`
  );
  const findingsBlock =
    findingRows.length === 0
      ? '<p>No findings.</p>'
      : htmlTable(['Severity', 'Claim', 'Runs', 'Contested'], findingRows);

  return (
    '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>Consilium statistics</title><style>' +
    'body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;max-width:960px;margin:0 auto;padding:24px;line-height:1.5;color:#111;background:#fff}' +
    'h1{margin:0 0 16px}h2{margin:28px 0 10px}' +
    '.cards{display:flex;flex-wrap:wrap;gap:12px;margin:16px 0}' +
    '.card{border:1px solid #d0d7de;border-radius:10px;padding:10px 16px;min-width:140px}' +
    '.card .label{display:block;color:#57606a;font-size:12px;text-transform:uppercase}' +
    '.card .value{font-size:22px;font-weight:600}' +
    'table{border-collapse:collapse;width:100%;margin:8px 0 20px}' +
    'th,td{border:1px solid #d0d7de;padding:6px 8px;text-align:left;font-size:14px;vertical-align:top}' +
    'th{background:#f6f8fa}code{font-size:13px}' +
    '.sev{display:inline-block;padding:1px 8px;border-radius:10px;font-size:12px;font-weight:600;color:#fff;background:#57606a}' +
    '.sev-critical{background:#b42318}.sev-high{background:#d1242f}.sev-medium{background:#bf8700}.sev-low{background:#1a7f37}.sev-info{background:#57606a}' +
    'footer{margin-top:32px;color:#57606a;font-size:12px}' +
    '@media (prefers-color-scheme:dark){body{background:#0d1117;color:#e6edf3}.card{border-color:#30363d}.card .label,footer{color:#9aa4b2}th,td{border-color:#30363d}th{background:#161b22}}' +
    '</style></head><body>' +
    '<header><h1>Consilium statistics</h1></header>' +
    '<section class="cards">' +
    `<div class="card"><span class="label">Runs</span><span class="value">${summary.totalRuns}</span></div>` +
    `<div class="card"><span class="label">Success rate</span><span class="value">${(summary.successRate * 100).toFixed(1)}%</span></div>` +
    `<div class="card"><span class="label">Total cost</span><span class="value">$${summary.totalCost.toFixed(4)}</span></div>` +
    `<div class="card"><span class="label">Findings</span><span class="value">${summary.findings.total}</span></div>` +
    `<div class="card"><span class="label">Contested</span><span class="value">${summary.contested}</span></div>` +
    '</section>' +
    `<section><h2>Overview</h2><p>${cell(duration)}</p>` +
    `<p>Findings: ${SEVERITIES.map(
      severity => `${severity} ${summary.findings.counts[severity]}`
    )
      .map(value => cell(value))
      .join(', ')}</p></section>` +
    `<section><h2>Models</h2>${modelBlock}</section>` +
    `<section><h2>Top errors</h2>${errorBlock}</section>` +
    `<section><h2>Agreement</h2>${agreementBlock}</section>` +
    `<section><h2>Recent runs</h2>${recentBlock}</section>` +
    `<section><h2>Top findings</h2>${findingsBlock}</section>` +
    '<footer>Generated by consilium stats.</footer>' +
    '</body></html>'
  );
}
