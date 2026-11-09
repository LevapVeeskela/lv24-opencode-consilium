/**
 * @fileoverview Отчёты консилиума: HTML и PR-markdown рендеры.
 * @module lv24-opencode-consilium/report
 */

import type { AgentResult, ConsiliumResult } from '../types.js';
import type {
  Finding,
  FindingSeverity,
  FindingSource,
  FindingsSummary,
  RejectedPosition
} from '../council/findings.js';

/** Формат отчёта. */
export type ReportFormat = 'html' | 'pr' | 'markdown';

/** Опции рендера отчёта. */
export interface ReportOptions {
  title?: string;
  generatedAt?: Date;
}

const TEXT_LIMIT = 6000;
const PACKAGE_NAME = 'lv24-opencode-consilium';
const PR_MARKER = '<!-- consilium:report -->';
const SEVERITIES: readonly FindingSeverity[] = ['critical', 'high', 'medium', 'low', 'info'];

interface ConsensusLike {
  agreement?: unknown;
  averageSimilarity?: unknown;
  pairs?: unknown;
  sharedTerms?: unknown;
  uniqueTerms?: unknown;
  summary?: unknown;
}

/** HTML-escape: & < > " '. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Самая длинная серия указанного символа в тексте */
function longestRun(text: string, char: string): number {
  let max = 0;
  let current = 0;
  for (const ch of text) {
    if (ch === char) {
      current += 1;
      if (current > max) max = current;
    } else {
      current = 0;
    }
  }
  return max;
}

/** Оборачивает текст в fence длиннее любых бэктиков внутри (без breakout). */
function fencedBlock(body: string): string[] {
  const fence = '`'.repeat(Math.max(3, longestRun(body, '`') + 1));
  return [`${fence}text`, body, fence];
}

/** Нейтрализует открытие HTML-комментария, чтобы нельзя было внедрить маркер отчёта. */
function neutralizeCommentOpener(text: string): string {
  return text.replace(/<!--/g, '&lt;!--');
}

/** Экранирует markdown-синтаксис ссылок в тексте вне code span. */
function escapeMarkdownLinks(text: string): string {
  return text.replace(/[\[\]()]/g, ch => `\\${ch}`);
}

/** Экранирует текст для markdown вне code span: HTML и синтаксис ссылок. */
function escapeMarkdownText(text: string): string {
  return escapeMarkdownLinks(escapeHtml(text));
}

/** Инлайн-код без выхода за пределы code span. */
function inlineCode(text: string): string {
  const flat = text
    .replace(/\r\n?|[\n\u2028\u2029]/g, ' ')
    .replace(/`/g, "'");
  return `\`${neutralizeCommentOpener(flat)}\``;
}

function toText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function num(value: unknown, suffix = ''): string {
  return typeof value === 'number' && Number.isFinite(value) ? `${value}${suffix}` : '—';
}

function int(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(Math.trunc(value)) : '—';
}

function money(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return `$${value.toFixed(4)}`;
}

function fmtDate(d: Date): string {
  return Number.isNaN(d.getTime()) ? '—' : d.toISOString();
}

function fmtDuration(ms: unknown): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.trunc(ms)} мс`;
  return `${(ms / 1000).toFixed(1)} с`;
}

function tokensLine(r: AgentResult): string {
  const u = r.usage;
  if (!u) return '—';
  const parts: string[] = [];
  if (typeof u.inputTokens === 'number' && Number.isFinite(u.inputTokens)) parts.push(`in ${u.inputTokens}`);
  if (typeof u.outputTokens === 'number' && Number.isFinite(u.outputTokens)) parts.push(`out ${u.outputTokens}`);
  if (typeof u.cost === 'number' && Number.isFinite(u.cost)) parts.push(money(u.cost));
  return parts.length > 0 ? parts.join(' · ') : '—';
}

function truncate(text: string): { body: string; truncated: boolean } {
  if (text.length <= TEXT_LIMIT) return { body: text, truncated: false };
  return { body: text.slice(0, TEXT_LIMIT), truncated: true };
}

function consensusOf(result: ConsiliumResult): ConsensusLike | null {
  const m = result.metadata;
  if (!m || typeof m !== 'object') return null;
  const c = (m as Record<string, unknown>)['consensus'];
  if (!c || typeof c !== 'object') return null;
  return c as ConsensusLike;
}

function artifactsDirOf(result: ConsiliumResult): string | null {
  const m = result.metadata;
  if (!m || typeof m !== 'object') return null;
  const a = (m as Record<string, unknown>)['artifacts'];
  if (!a || typeof a !== 'object') return null;
  const dir = (a as Record<string, unknown>)['dir'];
  return typeof dir === 'string' && dir.length > 0 ? dir : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toSeverity(value: unknown): FindingSeverity {
  if (typeof value !== 'string') return 'medium';
  const normalized = value.trim().toLowerCase();
  return (SEVERITIES as readonly string[]).includes(normalized) ? (normalized as FindingSeverity) : 'medium';
}

function toFindingSource(value: unknown): FindingSource | null {
  if (!isRecord(value)) return null;
  const agent = typeof value['agent'] === 'string' ? value['agent'] : '';
  if (agent.length === 0) return null;
  const model = typeof value['model'] === 'string' && value['model'].length > 0 ? value['model'] : undefined;
  return { agent, model };
}

function toFinding(value: unknown): Finding | null {
  if (!isRecord(value)) return null;
  const claim = typeof value['claim'] === 'string' ? value['claim'].trim() : '';
  if (claim.length === 0) return null;
  const lineValue = value['line'];
  const line = typeof lineValue === 'number' && Number.isFinite(lineValue) && lineValue > 0
    ? Math.floor(lineValue)
    : undefined;
  const confidenceValue = value['confidence'];
  const confidence =
    typeof confidenceValue === 'number' && Number.isFinite(confidenceValue) && confidenceValue >= 0 && confidenceValue <= 1
      ? confidenceValue
      : undefined;
  const rejectedBy = strArray(value['rejectedBy']);
  const sources = Array.isArray(value['sources'])
    ? value['sources'].map(toFindingSource).filter((source): source is FindingSource => source !== null)
    : [];
  return {
    fingerprint: typeof value['fingerprint'] === 'string' ? value['fingerprint'] : '',
    severity: toSeverity(value['severity']),
    category:
      typeof value['category'] === 'string' && value['category'].trim().length > 0
        ? value['category']
        : 'general',
    file: typeof value['file'] === 'string' && value['file'].length > 0 ? value['file'] : undefined,
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
    reason: typeof value['reason'] === 'string' && value['reason'].length > 0 ? value['reason'] : undefined,
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

/** Извлекает валидную сводку находок из `metadata.findings` или возвращает null. */
export function findingsSummaryOf(result: ConsiliumResult): FindingsSummary | null {
  const metadata = result.metadata;
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

/** Форматирует счётчики серьёзности: `critical: 0, high: 1, ...`. */
export function formatFindingsCounts(counts: Record<FindingSeverity, number>): string {
  return SEVERITIES.map(severity => `${severity}: ${counts[severity]}`).join(', ');
}

function findingsLocation(item: Finding): string {
  if (item.file === undefined) return '—';
  return item.line === undefined ? item.file : `${item.file}:${item.line}`;
}

function findingSourceLabel(source: FindingSource): string {
  return source.model === undefined ? source.agent : `${source.agent} (${source.model})`;
}

function findingsSourcesLabel(sources: FindingSource[]): string {
  return sources.length > 0 ? sources.map(findingSourceLabel).join(', ') : '—';
}

function consensusPairs(c: ConsensusLike): Array<{ left: string; right: string; similarity: number }> {
  if (!Array.isArray(c.pairs)) return [];
  const out: Array<{ left: string; right: string; similarity: number }> = [];
  for (const p of c.pairs) {
    if (!p || typeof p !== 'object') continue;
    const rec = p as Record<string, unknown>;
    if (typeof rec['left'] !== 'string' || typeof rec['right'] !== 'string') continue;
    if (typeof rec['similarity'] !== 'number' || !Number.isFinite(rec['similarity'])) continue;
    out.push({ left: rec['left'] as string, right: rec['right'] as string, similarity: rec['similarity'] as number });
  }
  return out;
}

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function uniqueTermsEntries(c: ConsensusLike): Array<[string, string[]]> {
  const u = c.uniqueTerms;
  if (!u || typeof u !== 'object' || Array.isArray(u)) return [];
  const out: Array<[string, string[]]> = [];
  for (const [k, v] of Object.entries(u as Record<string, unknown>)) out.push([k, strArray(v)]);
  return out;
}

function expertsOkTotal(result: ConsiliumResult): { ok: number; total: number } {
  const total = Array.isArray(result.experts) ? result.experts.length : 0;
  const ok = Array.isArray(result.experts) ? result.experts.filter(e => e.success).length : 0;
  return { ok, total };
}

function totalCost(result: ConsiliumResult): number | null {
  const c = result.usage?.cost;
  return typeof c === 'number' && Number.isFinite(c) ? c : null;
}

function buildHtmlFindings(summary: FindingsSummary): string {
  const rows = summary.items
    .map(item => {
      const location = findingsLocation(item);
      const locationCell = location === '—' ? '—' : `<code>${escapeHtml(location)}</code>`;
      const contested = item.contested ? '<span class="contested">⚠ contested</span>' : '—';
      return `<tr><td><span class="sev sev-${item.severity}">${item.severity}</span></td>`
        + `<td>${escapeHtml(item.category)}</td>`
        + `<td>${locationCell}</td>`
        + `<td>${escapeHtml(item.claim)}</td>`
        + `<td>${escapeHtml(findingsSourcesLabel(item.sources))}</td>`
        + `<td>${contested}</td></tr>`;
    })
    .join('');
  const rejected = summary.rejected.length > 0
    ? `<details><summary>Rejected positions (${summary.rejected.length})</summary><ul>`
      + summary.rejected
          .map(position => {
            const reason = position.reason === undefined ? '' : ` — ${escapeHtml(position.reason)}`;
            const agent = position.agent.length > 0 ? ` (${escapeHtml(position.agent)})` : '';
            return `<li><strong>${escapeHtml(position.claim)}</strong>${reason}${agent}</li>`;
          })
          .join('')
      + `</ul></details>`
    : '';
  const parseErrors = summary.parseErrors.length > 0
    ? `<p class="note">Ошибки разбора: ${escapeHtml(summary.parseErrors.join('; '))}</p>`
    : '';
  return `<section class="findings"><h2>Находки (Findings)</h2>`
    + `<p>Findings: ${summary.items.length} (${escapeHtml(formatFindingsCounts(summary.counts))}).</p>`
    + `<table><thead><tr><th>Серьёзность</th><th>Категория</th><th>Файл</th><th>Утверждение</th><th>Источники</th><th>Спорность</th></tr></thead>`
    + `<tbody>${rows}</tbody></table>`
    + rejected
    + parseErrors
    + `</section>`;
}

/**
 * Рендерит полностью автономный HTML-отчёт (один файл, инлайн-стили).
 */
export function renderHtmlReport(result: ConsiliumResult, options?: ReportOptions): string {
  const title = options?.title ?? 'Отчёт консилиума';
  const generatedAt = options?.generatedAt instanceof Date && !Number.isNaN(options.generatedAt.getTime())
    ? options.generatedAt
    : new Date();
  const { ok, total } = expertsOkTotal(result);
  const consensus = consensusOf(result);
  const artifactsDir = artifactsDirOf(result);
  const findings = findingsSummaryOf(result);
  const findingsBlock = findings !== null && findings.items.length > 0 ? buildHtmlFindings(findings) : '';
  const findingsStyles = findingsBlock.length > 0
    ? `.sev{display:inline-block;padding:1px 8px;border-radius:10px;font-size:12px;font-weight:600;color:#fff;background:#57606a}`
      + `.sev-critical{background:#b42318}.sev-high{background:#d1242f}.sev-medium{background:#bf8700}.sev-low{background:#1a7f37}.sev-info{background:#57606a}`
      + `.contested{color:#b42318;font-size:13px}.note{color:#555;font-size:13px}.findings details{margin:12px 0}.findings summary{cursor:pointer;color:#555}`
      + `@media (prefers-color-scheme:dark){.note,.findings summary{color:#9aa4b2}.contested{color:#ff7b72}}`
    : '';

  const modelsRows = (Array.isArray(result.experts) ? result.experts : [])
    .map(e => `<tr><td>${escapeHtml(e.agent ?? '—')}</td><td>${escapeHtml(e.model ?? '—')}</td><td>${e.success ? 'OK' : 'FAIL'}</td></tr>`)
    .join('');

  const cards = (Array.isArray(result.experts) ? result.experts : [])
    .map(e => {
      const text = typeof e.text === 'string' ? e.text : '';
      const { body, truncated } = truncate(text);
      const status = e.success ? 'успешно' : `ошибка${e.errorCode ? `: ${escapeHtml(String(e.errorCode))}` : ''}`;
      const errMsg = !e.success && typeof e.errorMessage === 'string' && e.errorMessage.length > 0
        ? `<p class="err">${escapeHtml(e.errorMessage)}</p>`
        : '';
      return `<section class="card"><h3>${escapeHtml(e.agent ?? '—')}</h3>`
        + `<p class="meta">Модель: ${escapeHtml(e.model ?? '—')} · Статус: ${status} · Длительность: ${escapeHtml(fmtDuration(e.duration))} · Токены/стоимость: ${escapeHtml(tokensLine(e))}</p>`
        + errMsg
        + (body.length > 0
          ? `<pre>${escapeHtml(body)}</pre>${truncated ? '<p class="cut">…текст обрезан до 6000 символов…</p>' : ''}`
          : '<p class="empty">— пустой ответ —</p>')
        + `</section>`;
    })
    .join('');

  const consensusBlock = consensus ? buildHtmlConsensus(consensus) : '';
  const chairVerdict =
    typeof result.chair?.text === 'string' && result.chair.text.length > 0
      ? result.chair.text
      : result.text;

  return `<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width, initial-scale=1">`
    + `<title>${escapeHtml(title)}</title>`
    + `<style>body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;max-width:960px;margin:0 auto;padding:24px;line-height:1.5;color:#111;background:#fff}`
    + `.badge{display:inline-block;padding:2px 10px;border-radius:12px;font-size:13px;color:#fff;background:${result.success ? '#1a7f37' : '#b42318'}}`
    + `table{border-collapse:collapse;width:100%;margin:12px 0}th,td{border:1px solid #ccc;padding:6px 8px;text-align:left;font-size:14px}`
    + `pre{white-space:pre-wrap;background:#f6f6f6;padding:12px;border-radius:8px;font-size:13px;overflow-wrap:anywhere}`
    + `.card{border:1px solid #ddd;border-radius:10px;padding:12px 16px;margin:12px 0}.meta{color:#555;font-size:13px}.err{color:#b42318;font-size:13px}.cut,.empty{color:#777;font-size:13px}`
    + `@media print{body{max-width:none;padding:0}.card{break-inside:avoid}}`
    + `@media (prefers-color-scheme:dark){body{background:#0d1117;color:#e6edf3}pre{background:#161b22}.card{border-color:#30363d}th,td{border-color:#30363d}.meta,.cut,.empty{color:#9aa4b2}}`
    + findingsStyles
    + `</style></head><body>`
    + `<header><h1>${escapeHtml(title)}</h1><p>Дата: ${escapeHtml(fmtDate(generatedAt))} <span class="badge">${result.success ? 'успешно' : 'частично'}</span></p></header>`
    + `<section><h2>Сводка</h2><p>Время: всего ${escapeHtml(fmtDuration(result.totalTime))}, параллельно ${escapeHtml(fmtDuration(result.parallelTime))}. `
    + `Эксперты: ${ok}/${total} успешно. Стоимость: ${escapeHtml(totalCost(result) === null ? '—' : money(totalCost(result)))}.</p></section>`
    + findingsBlock
    + `<section><h2>Модели</h2><table><thead><tr><th>Эксперт</th><th>Модель</th><th>Статус</th></tr></thead><tbody>${modelsRows || '<tr><td colspan="3">—</td></tr>'}</tbody></table></section>`
    + consensusBlock
    + `<section><h2>Мнения экспертов</h2>${cards || '<p>—</p>'}</section>`
    + `<section><h2>Итог председателя</h2>${chairVerdict.length > 0 ? `<pre>${escapeHtml(truncate(chairVerdict).body)}</pre>${truncate(chairVerdict).truncated ? '<p class="cut">…текст обрезан до 6000 символов…</p>' : ''}` : '<p class="empty">— пустой ответ —</p>'}</section>`
    + (artifactsDir !== null ? `<section><h2>Артефакты</h2><p>Путь: <code>${escapeHtml(artifactsDir)}</code></p></section>` : '')
    + `<footer><hr><p>${escapeHtml(PACKAGE_NAME)}</p></footer>`
    + `</body></html>`;
}

function buildHtmlConsensus(c: ConsensusLike): string {
  const agreement = typeof c.agreement === 'string' ? c.agreement : '—';
  const avg = typeof c.averageSimilarity === 'number' && Number.isFinite(c.averageSimilarity)
    ? `${Math.round((c.averageSimilarity as number) * 100)}%`
    : '—';
  const pairs = consensusPairs(c);
  const shared = strArray(c.sharedTerms);
  const unique = uniqueTermsEntries(c);
  const pairRows = pairs.map(p => `<tr><td>${escapeHtml(p.left)} ↔ ${escapeHtml(p.right)}</td><td>${Math.round(p.similarity * 100)}%</td></tr>`).join('');
  return `<section><h2>Консенсус</h2>`
    + `<p>Согласие: ${escapeHtml(agreement)}. Среднее сходство: ${escapeHtml(avg)}.</p>`
    + (pairRows ? `<table><thead><tr><th>Пара</th><th>Сходство</th></tr></thead><tbody>${pairRows}</tbody></table>` : '<p>Пар для сравнения нет.</p>')
    + `<p>Общие термины: ${shared.length > 0 ? escapeHtml(shared.join(', ')) : '—'}</p>`
    + (unique.length > 0
      ? `<ul>${unique.map(([k, v]) => `<li>${escapeHtml(k)}: ${v.length > 0 ? escapeHtml(v.join(', ')) : '—'}</li>`).join('')}</ul>`
      : '')
    + `</section>`;
}

/** Экранирует значение для ячейки markdown-таблицы: HTML, ссылки, переводы строк и `|`. */
function markdownTableCell(value: string): string {
  return escapeMarkdownText(value)
    .replace(/\r\n?|[\n\u2028\u2029]/g, ' ')
    .replace(/\|/g, '\\|');
}

function buildPrFindings(summary: FindingsSummary): string[] {
  const lines: string[] = [];
  lines.push('### Находки (Findings)');
  lines.push('');
  lines.push(`Findings: ${summary.items.length} (${formatFindingsCounts(summary.counts)}).`);
  lines.push('');
  lines.push('| Severity | Category | Location | Claim | Sources |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const item of summary.items) {
    const claim = item.contested ? `${item.claim} ⚠ contested` : item.claim;
    lines.push(
      `| ${markdownTableCell(item.severity)} | ${markdownTableCell(item.category)} | `
      + `${markdownTableCell(findingsLocation(item))} | ${markdownTableCell(claim)} | `
      + `${markdownTableCell(findingsSourcesLabel(item.sources))} |`
    );
  }
  lines.push('');
  if (summary.rejected.length > 0) {
    lines.push(`<details><summary>Rejected positions (${summary.rejected.length})</summary>`);
    lines.push('');
    for (const position of summary.rejected) {
      const reason = position.reason === undefined ? '' : ` — ${markdownTableCell(position.reason)}`;
      const agent = position.agent.length > 0 ? ` (${markdownTableCell(position.agent)})` : '';
      lines.push(`- **${markdownTableCell(position.claim)}**${reason}${agent}`);
    }
    lines.push('');
    lines.push('</details>');
    lines.push('');
  }
  if (summary.parseErrors.length > 0) {
    lines.push(`_Ошибки разбора: ${markdownTableCell(summary.parseErrors.join('; '))}_`);
    lines.push('');
  }
  return lines;
}

/**
 * Рендерит компактный PR-комментарий (GitHub markdown).
 */
export function renderPrMarkdown(result: ConsiliumResult): string {
  const { ok, total } = expertsOkTotal(result);
  const cost = totalCost(result);
  const lines: string[] = [];
  lines.push(`## Консилиум: ${result.success ? 'успешно' : 'частично'}`);
  lines.push('');
  lines.push(`Время ${fmtDuration(result.totalTime)} (параллельно ${fmtDuration(result.parallelTime)}) · эксперты ${ok}/${total} · стоимость ${cost === null ? '—' : money(cost)}`);
  lines.push('');
  const findings = findingsSummaryOf(result);
  if (findings !== null && findings.items.length > 0) lines.push(...buildPrFindings(findings));
  const experts = Array.isArray(result.experts) ? result.experts : [];
  if (experts.length === 0) {
    lines.push('Эксперты отсутствуют.');
  } else {
    for (const e of experts) {
      const name = toText(e.agent) || '—';
      const model = toText(e.model) || '—';
      const errorCode = e.errorCode ? escapeMarkdownText(toText(String(e.errorCode))) : '';
      const status = e.success ? 'OK' : `FAIL${errorCode ? ` (${errorCode})` : ''}`;
      lines.push(`<details><summary>Мнение: ${escapeMarkdownText(name)} (${escapeMarkdownText(model)}, ${status})</summary>`);
      lines.push('');
      const text = typeof e.text === 'string' ? e.text : '';
      if (text.length > 0) {
        const { body, truncated } = truncate(text);
        lines.push(...fencedBlock(body));
        if (truncated) lines.push('_…текст обрезан до 6000 символов…_');
      } else {
        lines.push('— пустой ответ —');
      }
      if (!e.success && typeof e.errorMessage === 'string' && e.errorMessage.length > 0) {
        lines.push(`Ошибка: ${inlineCode(e.errorMessage)}`);
      }
      lines.push(`Длительность: ${fmtDuration(e.duration)} · ${tokensLine(e)}`);
      lines.push('</details>');
      lines.push('');
    }
  }

  const chairText =
    typeof result.chair?.text === 'string' && result.chair.text.trim().length > 0
      ? result.chair.text
      : result.text;
  if (typeof chairText === 'string' && chairText.trim().length > 0) {
    const { body, truncated } = truncate(chairText);
    lines.push('### Итог председателя');
    lines.push('');
    lines.push(...fencedBlock(body));
    if (truncated) lines.push('_…текст обрезан до 6000 символов…_');
    lines.push('');
  }

  const consensus = consensusOf(result);
  if (consensus) {
    const agreement = typeof consensus.agreement === 'string' ? escapeMarkdownText(consensus.agreement) : '—';
    const avg = typeof consensus.averageSimilarity === 'number' && Number.isFinite(consensus.averageSimilarity)
      ? `${Math.round((consensus.averageSimilarity as number) * 100)}%`
      : '—';
    const pairs = consensusPairs(consensus)
      .slice()
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, 3);
    const shared = strArray(consensus.sharedTerms).slice(0, 10).map(escapeMarkdownText);
    lines.push(`Консенсус: ${agreement} (среднее ${avg})${pairs.length > 0 ? '; топ пар: ' + pairs.map(p => `${escapeMarkdownText(p.left)}↔${escapeMarkdownText(p.right)} ${Math.round(p.similarity * 100)}%`).join(', ') : ''}${shared.length > 0 ? `; общее: ${shared.join(', ')}` : ''}.`);
    lines.push('');
  }
  lines.push(`Стоимость: ${cost === null ? '—' : money(cost)} · токены: вх. ${int(result.usage?.inputTokens)}, исх. ${int(result.usage?.outputTokens)}.`);
  const dir = artifactsDirOf(result);
  if (dir !== null) lines.push(`Артефакты: ${inlineCode(dir)}.`);
  lines.push(PR_MARKER);
  return lines.join('\n');
}

/**
 * Диспетчер форматов: html, pr, markdown (markdown = PR-вариант).
 * @throws {Error} при неизвестном формате.
 */
export function renderReport(result: ConsiliumResult, format: ReportFormat, options?: ReportOptions): string {
  if (format === 'html') return renderHtmlReport(result, options);
  if (format === 'pr' || format === 'markdown') return renderPrMarkdown(result);
  throw new Error(`Неизвестный формат отчёта: ${String(format)}`);
}
