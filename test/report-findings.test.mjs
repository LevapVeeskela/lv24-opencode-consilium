import test from 'node:test';
import assert from 'node:assert/strict';
import { renderHtmlReport, renderPrMarkdown } from '../dist/report.js';
import { printSummary } from '../dist/interfaces/cli/output.js';

const FIXED_DATE = new Date('2026-01-01T00:00:00.000Z');
const PR_MARKER = '<!-- consilium:report -->';

function findingsFixture() {
  return {
    items: [
      {
        fingerprint: 'f_high',
        severity: 'high',
        category: 'security',
        file: 'src/a.ts',
        line: 10,
        claim: 'Unsafe <script>alert("x|y")</script> [link](https://evil)',
        evidence: 'evidence <b>',
        confidence: 0.9,
        sources: [
          { agent: 'alpha', model: 'prov/a' },
          { agent: 'beta' }
        ],
        contested: true,
        rejectedBy: ['beta']
      },
      {
        fingerprint: 'f_low',
        severity: 'low',
        category: 'style',
        file: 'src/b.ts',
        line: 22,
        claim: 'Minor style issue',
        sources: [{ agent: 'alpha', model: 'prov/a' }],
        contested: false,
        rejectedBy: []
      }
    ],
    counts: { critical: 0, high: 1, medium: 0, low: 1, info: 0 },
    rejected: [
      {
        claim: 'Rejected <b>claim</b>',
        reason: 'not <i>valid</i>',
        agent: 'beta'
      }
    ],
    parseErrors: ['beta: invalid-json <oops>']
  };
}

function baseResult() {
  return {
    text: 'chair verdict',
    experts: [
      {
        agent: 'alpha',
        model: 'prov/a',
        text: 'answer one',
        success: true,
        duration: 10,
        usage: { inputTokens: 10, outputTokens: 20, cost: 0.001 }
      }
    ],
    chair: { agent: 'chair', model: 'prov/c', text: 'chair verdict', success: true },
    totalTime: 2000,
    parallelTime: 1600,
    success: true,
    usage: { inputTokens: 100, outputTokens: 50, cost: 0.005 },
    metadata: { artifacts: { dir: '/tmp/runs/abc' } }
  };
}

function resultWithFindings() {
  const result = baseResult();
  result.metadata.findings = findingsFixture();
  return result;
}

test('HTML findings: значения экранированы, строки и details на месте', () => {
  const html = renderHtmlReport(resultWithFindings(), { generatedAt: FIXED_DATE });

  assert.ok(!html.includes('<script>alert("x|y")</script>'));
  assert.ok(!html.includes('Rejected <b>claim</b>'));
  assert.ok(html.includes('&lt;script&gt;alert(&quot;x|y&quot;)&lt;/script&gt;'));
  assert.ok(html.includes('&lt;b&gt;claim&lt;/b&gt;'));
  assert.ok(html.includes('not &lt;i&gt;valid&lt;/i&gt;'));
  assert.ok(html.includes('beta: invalid-json &lt;oops&gt;'));
  assert.ok(html.includes('critical: 0, high: 1, medium: 0, low: 1, info: 0'));
  assert.ok(html.includes('sev-high'));
  assert.ok(html.includes('sev-low'));
  assert.ok(html.includes('src/a.ts:10'));
  assert.ok(html.includes('src/b.ts:22'));
  assert.ok(html.includes('Unsafe'));
  assert.ok(html.includes('Minor style issue'));
  assert.ok(html.includes('alpha (prov/a)'));
  assert.ok(html.includes('contested'));
  assert.ok(html.includes('Rejected positions (1)'));
  assert.ok(html.includes('<details><summary>Rejected positions (1)</summary>'));

  const summaryIndex = html.indexOf('<h2>Сводка</h2>');
  const findingsIndex = html.indexOf('<h2>Находки (Findings)</h2>');
  const modelsIndex = html.indexOf('<h2>Модели</h2>');
  assert.ok(summaryIndex >= 0 && findingsIndex > summaryIndex && modelsIndex > findingsIndex);
});

test('PR findings: один маркер, таблица, экранированные ячейки, details', () => {
  const md = renderPrMarkdown(resultWithFindings());

  assert.equal((md.match(/<!-- consilium:report -->/g) || []).length, 1);
  assert.ok(md.trimEnd().endsWith(PR_MARKER));
  assert.ok(md.includes('| Severity | Category | Location | Claim | Sources |'));
  assert.ok(md.includes('| high | security | src/a.ts:10 |'));
  assert.ok(md.includes('| low | style | src/b.ts:22 |'));
  assert.ok(md.includes('x\\|y'));
  assert.ok(md.includes('\\[link\\]\\(https://evil\\)'));
  assert.ok(!md.includes('<script>'));
  assert.ok(!md.includes('[link](https://evil)'));
  assert.ok(md.includes('<details><summary>Rejected positions (1)</summary>'));
  assert.ok(md.includes('Rejected &lt;b&gt;claim&lt;/b&gt;'));
  assert.ok(md.includes('contested'));
  assert.equal((md.match(/<details>/g) || []).length, (md.match(/<\/details>/g) || []).length);
});

test('без metadata.findings HTML и PR не меняются', () => {
  const result = baseResult();
  const html = renderHtmlReport(result, { generatedAt: FIXED_DATE });
  const md = renderPrMarkdown(result);

  assert.ok(!html.includes('Findings'));
  assert.ok(!html.includes('Rejected positions'));
  assert.ok(!html.includes('sev-'));
  assert.ok(!md.includes('Findings'));
  assert.ok(!md.includes('Rejected positions'));
  assert.ok(!md.includes('| Severity |'));
  assert.equal((md.match(/<!-- consilium:report -->/g) || []).length, 1);
});

test('printSummary: строка Findings с contested, без находок — без изменений', (t) => {
  const lines = [];
  t.mock.method(console, 'error', (...args) => {
    lines.push(args.join(' '));
  });

  printSummary(resultWithFindings(), {});
  const output = lines.join('\n');
  assert.match(output, /Findings: 2 \(critical: 0, high: 1, medium: 0, low: 1, info: 0\) · contested: 1/);

  lines.length = 0;
  printSummary(baseResult(), {});
  const plain = lines.join('\n');
  assert.doesNotMatch(plain, /Findings:|contested:/);
});
