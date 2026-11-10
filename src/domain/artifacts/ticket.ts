/**
 * @fileoverview Ticket-ready reports (Jira wiki markup and Linear markdown)
 * for consilium findings. Both renderers are pure and deterministic.
 * @module lv24-opencode-consilium
 */

import type { Finding, FindingsSummary } from '../council/findings.js';
import type { ConsiliumResult } from '../types.js';
import {
  findingsLocation,
  findingsSummaryOf,
  formatFindingsCounts
} from './findings-summary.js';

/** Supported ticket trackers. */
export type TicketTarget = 'jira' | 'linear';

/** Options for {@link renderTicketReport}. */
export interface TicketReportOptions {
  target: TicketTarget;
  /** Tool version shown in the footer. */
  version?: string;
}

const DEFAULT_TITLE = 'Consilium review';
const PACKAGE_NAME = 'lv24-opencode-consilium';
const MAX_VERDICT = 6000;

interface TicketView {
  title: string;
  status: string;
  verdict: string;
  models: string;
  cost: string;
  duration: string;
  summary: FindingsSummary | null;
  version?: string;
}

/**
 * Renders a run as a Jira wiki-markup or Linear markdown ticket body.
 * Empty runs still produce a valid document that states there are no findings.
 */
export function renderTicketReport(
  result: ConsiliumResult,
  options: TicketReportOptions
): string {
  const view = buildView(result, options);
  return options.target === 'jira' ? renderJira(view) : renderLinear(view);
}

function buildView(result: ConsiliumResult, options: TicketReportOptions): TicketView {
  const experts = Array.isArray(result.experts) ? result.experts : [];
  const successful = experts.filter(
    expert => expert !== null && expert !== undefined && expert.success === true
  ).length;
  const models = experts.map(expert => {
    const name = singleLine(expert?.agent ?? '—');
    const model = singleLine(expert?.model ?? '');
    return model.length > 0 ? `${name} (${model})` : name;
  });
  if (result.chair !== undefined && result.chair !== null) {
    const name = singleLine(result.chair.agent ?? 'chair');
    const model = singleLine(result.chair.model ?? '');
    models.push(model.length > 0 ? `chair: ${name} (${model})` : `chair: ${name}`);
  }

  const verdict =
    typeof result.chair?.text === 'string' && result.chair.text.trim().length > 0
      ? result.chair.text
      : typeof result.text === 'string'
        ? result.text
        : '';
  const view: TicketView = {
    title: DEFAULT_TITLE,
    status: result.success
      ? `Completed (${successful}/${experts.length} experts OK)`
      : `Completed with errors (${successful}/${experts.length} experts OK)`,
    verdict: verdict.length > 0 ? truncate(verdict, MAX_VERDICT) : 'No verdict was returned.',
    models: models.length > 0 ? models.join(', ') : '—',
    cost: formatCost(result.usage?.cost),
    duration: formatDuration(result.totalTime),
    summary: findingsSummaryOf(result)
  };
  if (options.version !== undefined && options.version.length > 0) {
    view.version = singleLine(options.version);
  }
  return view;
}

function renderLinear(view: TicketView): string {
  const lines: string[] = [`# ${singleLine(view.title)}`, ''];
  lines.push(`**Status:** ${singleLine(view.status)}`);
  lines.push(`**Findings:** ${findingsLine(view.summary)}`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(...linearFence(view.verdict));
  lines.push('');
  lines.push('## Run metadata');
  lines.push('');
  lines.push(`- **Models:** ${linearCell(view.models)}`);
  lines.push(`- **Cost:** ${linearCell(view.cost)}`);
  lines.push(`- **Duration:** ${linearCell(view.duration)}`);
  lines.push('');
  lines.push('## Findings');
  lines.push('');

  const summary = view.summary;
  if (summary === null || summary.items.length === 0) {
    lines.push('_No findings were reported by the council._');
  } else {
    lines.push('| Severity | Category | Location | Claim | Evidence | Contested |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    for (const item of summary.items) lines.push(linearFindingRow(item));
    lines.push('');
    lines.push(`**Accepted findings:** ${summary.items.length} (${formatFindingsCounts(summary.counts)}).`);
  }

  appendLinearNotes(lines, summary);
  lines.push('');
  lines.push(footerLinear(view.version));
  return `${lines.join('\n')}\n`;
}

function renderJira(view: TicketView): string {
  const lines: string[] = [`h1. ${jiraInline(view.title)}`, ''];
  lines.push(`*Status:* ${jiraInline(view.status)}`);
  lines.push(`*Findings:* ${jiraInline(findingsLine(view.summary))}`);
  lines.push('');
  lines.push('h2. Summary');
  lines.push('');
  lines.push(...jiraCode(view.verdict));
  lines.push('');
  lines.push('h2. Run metadata');
  lines.push('');
  lines.push(`* *Models:* ${jiraInline(view.models)}`);
  lines.push(`* *Cost:* ${jiraInline(view.cost)}`);
  lines.push(`* *Duration:* ${jiraInline(view.duration)}`);
  lines.push('');
  lines.push('h2. Findings');
  lines.push('');

  const summary = view.summary;
  if (summary === null || summary.items.length === 0) {
    lines.push('No findings were reported by the council.');
  } else {
    lines.push('||Severity||Category||Location||Claim||Evidence||Contested||');
    for (const item of summary.items) lines.push(jiraFindingRow(item));
    lines.push('');
    lines.push(`*Accepted findings:* ${summary.items.length} (${jiraInline(formatFindingsCounts(summary.counts))}).`);
  }

  appendJiraNotes(lines, summary);
  lines.push('');
  lines.push(footerJira(view.version));
  return `${lines.join('\n')}\n`;
}

function findingsLine(summary: FindingsSummary | null): string {
  if (summary === null) return 'No findings.';
  const count = summary.items.length;
  if (count === 0) return 'No findings.';
  return `${count} finding${count === 1 ? '' : 's'} (${formatFindingsCounts(summary.counts)})`;
}

function linearFindingRow(item: Finding): string {
  return (
    `| ${linearCell(item.severity)} | ${linearCell(item.category)} | ` +
    `${linearCell(findingsLocation(item))} | ${linearCell(item.claim)} | ` +
    `${linearCell(item.evidence ?? '—')} | ${linearCell(contestedLabel(item))} |`
  );
}

function jiraFindingRow(item: Finding): string {
  return (
    `|${jiraCell(item.severity)}|${jiraCell(item.category)}|` +
    `${jiraCell(findingsLocation(item))}|${jiraCell(item.claim)}|` +
    `${jiraCell(item.evidence ?? '—')}|${jiraCell(contestedLabel(item))}|`
  );
}

function contestedLabel(item: Finding): string {
  if (!item.contested) return 'no';
  const rejectedBy = item.rejectedBy.filter(name => name.length > 0);
  return rejectedBy.length > 0 ? `yes (${rejectedBy.join(', ')})` : 'yes';
}

function appendLinearNotes(lines: string[], summary: FindingsSummary | null): void {
  if (summary === null) return;
  if (summary.rejected.length > 0) {
    lines.push('');
    lines.push(`**Rejected positions (${summary.rejected.length}):**`);
    for (const position of summary.rejected) {
      const reason = position.reason === undefined ? '' : ` — ${linearCell(position.reason)}`;
      const agent = position.agent.length > 0 ? ` (${linearCell(position.agent)})` : '';
      lines.push(`- **${linearCell(position.claim)}**${reason}${agent}`);
    }
  }
  if (summary.parseErrors.length > 0) {
    lines.push('');
    lines.push(`**Parse errors:** ${summary.parseErrors.map(linearCell).join('; ')}`);
  }
}

function appendJiraNotes(lines: string[], summary: FindingsSummary | null): void {
  if (summary === null) return;
  if (summary.rejected.length > 0) {
    lines.push('');
    lines.push(`*Rejected positions (${summary.rejected.length}):*`);
    for (const position of summary.rejected) {
      const reason = position.reason === undefined ? '' : ` — ${jiraInline(position.reason)}`;
      const agent = position.agent.length > 0 ? ` (${jiraInline(position.agent)})` : '';
      lines.push(`* _${jiraInline(position.claim)}_${reason}${agent}`);
    }
  }
  if (summary.parseErrors.length > 0) {
    lines.push('');
    lines.push(`*Parse errors:* ${jiraInline(summary.parseErrors.join('; '))}`);
  }
}

function footerLinear(version: string | undefined): string {
  return `_Generated by ${PACKAGE_NAME}${version === undefined ? '' : ` ${version}`}._`;
}

function footerJira(version: string | undefined): string {
  return `_Generated by ${PACKAGE_NAME}${version === undefined ? '' : ` ${version}`}._`;
}

/** Markdown cell: escapes HTML, backslashes, links, pipes and newlines. */
function linearCell(value: string): string {
  return escapeMarkdownLinks(escapeHtml(singleLine(value)).replace(/\\/g, '\\\\'))
    .replace(/\|/g, '\\|');
}

/** Jira inline text: one line, no table separators. */
function jiraInline(value: string): string {
  return singleLine(value).replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
}

/** Jira table cell: strips newlines and escapes the cell separator. */
function jiraCell(value: string): string {
  return neutralizeJiraMacros(jiraInline(value));
}

/** Fenced markdown block with a fence longer than any run inside the body. */
function linearFence(body: string): string[] {
  const fence = '`'.repeat(Math.max(3, longestRun(body, '`') + 1));
  return [`${fence}text`, body, fence];
}

/** Jira `{code}` block that cannot be terminated by the contained text. */
function jiraCode(body: string): string[] {
  return ['{code}', neutralizeJiraMacros(body), '{code}'];
}

/**
 * Jira macros start with `{name`; a zero-width space keeps attacker-controlled
 * text from opening or closing a macro while rendering it unchanged.
 */
function neutralizeJiraMacros(value: string): string {
  return value.replace(
    /\{(code|noformat|panel|quote|color|anchor)(?::[^}]*)?\}/gi,
    match => `{\u200b${match.slice(1)}`
  );
}

function singleLine(value: string): string {
  return value
    .replace(/\r\n?|[\n\u2028\u2029]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeMarkdownLinks(value: string): string {
  return value.replace(/[\[\]()]/g, ch => `\\${ch}`);
}

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

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

function formatCost(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '—';
  return `$${value.toFixed(4)}`;
}

function formatDuration(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '—';
  return value < 1000 ? `${Math.trunc(value)} ms` : `${(value / 1000).toFixed(1)} s`;
}
