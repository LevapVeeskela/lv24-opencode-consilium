import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  renderHtmlReport,
  renderPrMarkdown,
  renderReport,
  renderTicketReport
} from '../dist/report.js';
import { parseArgs } from '../dist/interfaces/cli/args.js';
import { inferReportFormat, writeRunReport } from '../dist/interfaces/cli/output.js';
import { mergeWithDefaults, validateConfig } from '../dist/config.js';

const ZERO_WIDTH = '\u200b';
const FIXED_DATE = new Date('2026-01-01T00:00:00.000Z');

function finding(overrides = {}) {
  return {
    fingerprint: 'f_high',
    severity: 'high',
    category: 'security',
    file: 'src/a.ts',
    line: 10,
    claim: 'SQL injection | {code} in the sort field\nsecond line',
    evidence: 'db.query interpolates the sort column <script>alert(1)</script>',
    confidence: 0.9,
    sources: [{ agent: 'alpha', model: 'prov/a' }],
    contested: true,
    rejectedBy: ['beta'],
    ...overrides
  };
}

function baseResult() {
  return {
    text: 'Chair says the change is safe to merge',
    experts: [
      {
        agent: 'alpha',
        model: 'prov/a',
        text: 'answer one',
        success: true,
        duration: 1200
      },
      {
        agent: 'beta',
        model: 'prov/b',
        text: '',
        success: false,
        duration: 800,
        errorCode: 'TIMEOUT'
      }
    ],
    chair: {
      agent: 'chair',
      model: 'prov/c',
      text: 'Verdict: one high issue <unsafe>',
      success: true
    },
    totalTime: 2500,
    parallelTime: 2000,
    success: false,
    usage: { inputTokens: 100, outputTokens: 50, cost: 0.0123 },
    metadata: {
      findings: {
        items: [finding()],
        counts: { critical: 0, high: 1, medium: 0, low: 0, info: 0 },
        rejected: [
          {
            claim: 'Rejected [claim]',
            reason: 'not reproducible',
            agent: 'beta'
          }
        ],
        parseErrors: []
      }
    }
  };
}

function emptyResult() {
  return {
    text: 'No issues found',
    experts: [],
    chair: { agent: 'chair', text: 'No issues found', success: true },
    totalTime: 50,
    parallelTime: 50,
    success: true,
    metadata: {
      findings: {
        items: [],
        counts: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
        rejected: [],
        parseErrors: []
      }
    }
  };
}

test('Jira ticket: wiki headings, table, metadata and rejected notes', () => {
  const text = renderTicketReport(baseResult(), { target: 'jira', version: '1.11.0' });

  assert.match(text, /^h1\. Consilium review$/m);
  assert.match(text, /^h2\. Summary$/m);
  assert.match(text, /^h2\. Run metadata$/m);
  assert.match(text, /^h2\. Findings$/m);
  assert.ok(
    text.includes('||Severity||Category||Location||Claim||Evidence||Contested||')
  );
  assert.ok(text.includes('src/a.ts:10'));
  assert.ok(text.includes('db.query interpolates the sort column'));
  assert.ok(text.includes('*Models:* alpha (prov/a), beta (prov/b), chair: chair (prov/c)'));
  assert.ok(text.includes('*Cost:* $0.0123'));
  assert.ok(text.includes('*Duration:* 2.5 s'));
  assert.ok(text.includes('{code}'));
  assert.ok(text.includes('*Rejected positions (1):*'));
  assert.ok(text.includes('Rejected [claim]'));
  assert.ok(text.includes('1.11.0'));

  const claimRow = text.split('\n').find(line => line.includes('SQL injection'));
  assert.ok(claimRow !== undefined, 'finding row is missing');
  assert.ok(claimRow.includes('SQL injection \\|'));
  assert.ok(claimRow.includes(`{${ZERO_WIDTH}code}`));
  assert.ok(!claimRow.includes('{code}'));
  assert.ok(!claimRow.includes('\n'));
});

test('Linear ticket: markdown headings, findings table and run metadata', () => {
  const text = renderTicketReport(baseResult(), { target: 'linear', version: '1.11.0' });

  assert.match(text, /^# Consilium review$/m);
  assert.match(text, /^## Summary$/m);
  assert.match(text, /^## Run metadata$/m);
  assert.match(text, /^## Findings$/m);
  assert.ok(text.includes('**Status:** Completed with errors (1/2 experts OK)'));
  assert.ok(
    text.includes(
      '**Models:** alpha \\(prov/a\\), beta \\(prov/b\\), chair: chair \\(prov/c\\)'
    )
  );
  assert.ok(text.includes('**Cost:** $0.0123'));
  assert.ok(text.includes('**Duration:** 2.5 s'));
  assert.ok(text.includes('| Severity | Category | Location | Claim | Evidence | Contested |'));
  assert.ok(text.includes('src/a.ts:10'));
  assert.ok(text.includes('db.query interpolates the sort column'));
  assert.ok(text.includes('&lt;script&gt;alert\\(1\\)&lt;/script&gt;'));
  assert.ok(!text.includes('<script>alert(1)</script>'));
  assert.ok(text.includes('SQL injection \\|'));
  assert.ok(text.includes('**Accepted findings:** 1'));
  assert.ok(text.includes('**Rejected positions (1):**'));
  assert.ok(text.includes('Rejected \\[claim\\]'));
  assert.ok(text.includes('1.11.0'));
});

test('ticket reports: empty findings produce valid output with a no-findings message', () => {
  const jira = renderTicketReport(emptyResult(), { target: 'jira' });
  const linear = renderTicketReport(emptyResult(), { target: 'linear' });

  assert.match(jira, /No findings were reported by the council\./);
  assert.match(linear, /_No findings were reported by the council\._/);
  assert.match(jira, /^h1\. Consilium review$/m);
  assert.match(linear, /^# Consilium review$/m);
  assert.ok(!jira.includes('||Severity||'));
  assert.ok(!linear.includes('| Severity |'));
});

test('CLI: --report jira|linear and extension inference', () => {
  const jira = parseArgs([
    '--report',
    'jira',
    '--report-file',
    'ticket.md',
    'задача'
  ]);
  assert.equal(jira.report, 'jira');
  assert.equal(jira.reportFile, 'ticket.md');

  const linear = parseArgs([
    '--report',
    'linear',
    '--report-file',
    'ticket.linear',
    'задача'
  ]);
  assert.equal(linear.report, 'linear');

  assert.equal(inferReportFormat('ticket.jira'), 'jira');
  assert.equal(inferReportFormat('TICKET.JIRA'), 'jira');
  assert.equal(inferReportFormat('ticket.linear'), 'linear');
  assert.equal(inferReportFormat('ticket.html'), 'html');
  assert.equal(inferReportFormat('ticket.md'), 'pr');
  assert.equal(inferReportFormat('ticket.sarif'), 'sarif');

  assert.throws(() => parseArgs(['--report', 'pdf']), /Неизвестный формат отчёта/);
});

test('config: jira and linear report formats pass validation', () => {
  for (const report of ['jira', 'linear']) {
    const warnings = validateConfig(mergeWithDefaults({ report }));
    assert.deepEqual(warnings, [], `${report} should be accepted`);
  }
  assert.ok(
    validateConfig(mergeWithDefaults({ report: 'pdf' })).some(warning =>
      warning.includes('формат отчёта')
    )
  );

  const schema = JSON.parse(
    readFileSync(new URL('../schema/config.schema.json', import.meta.url), 'utf8')
  );
  assert.ok(schema.properties.report.enum.includes('jira'));
  assert.ok(schema.properties.report.enum.includes('linear'));
});

test('CLI: ticket report file is written with explicit format and inferred extension', () => {
  const dir = mkdtempSync(join(tmpdir(), 'consilium-ticket-'));
  try {
    const linearTarget = join(dir, 'ticket.md');
    const linearPrinted = writeRunReport(
      baseResult(),
      { cwd: dir, version: '1.11.0', output: { format: 'text' } },
      { task: '', report: 'linear', reportFile: linearTarget, silent: true }
    );
    assert.equal(linearPrinted, false);
    const linearText = readFileSync(linearTarget, 'utf8');
    assert.match(linearText, /^# Consilium review/);
    assert.ok(linearText.includes('src/a.ts:10'));
    assert.ok(linearText.includes('1.11.0'));

    const jiraTarget = join(dir, 'ticket.jira');
    const jiraPrinted = writeRunReport(
      baseResult(),
      { cwd: dir, version: '1.11.0', output: { format: 'text' } },
      { task: '', reportFile: jiraTarget, silent: true }
    );
    assert.equal(jiraPrinted, false);
    const jiraText = readFileSync(jiraTarget, 'utf8');
    assert.match(jiraText, /^h1\. Consilium review/);
    assert.ok(jiraText.includes('||Severity||Category||Location||Claim||Evidence||Contested||'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('renderReport: existing html/pr/markdown/sarif formats are unchanged', () => {
  const result = baseResult();

  assert.equal(renderReport(result, 'html', { generatedAt: FIXED_DATE }), renderHtmlReport(result, { generatedAt: FIXED_DATE }));
  assert.equal(renderReport(result, 'pr'), renderPrMarkdown(result));
  assert.equal(renderReport(result, 'markdown'), renderPrMarkdown(result));
  assert.equal(JSON.parse(renderReport(result, 'sarif')).version, '2.1.0');
  assert.equal(
    renderReport(result, 'linear'),
    renderTicketReport(result, { target: 'linear' })
  );
  assert.equal(
    renderReport(result, 'jira'),
    renderTicketReport(result, { target: 'jira' })
  );
  assert.throws(() => renderReport(result, 'pdf'), /Неизвестный формат/);
});
