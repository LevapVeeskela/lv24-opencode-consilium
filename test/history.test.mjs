import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  formatHistoryTable,
  formatStats,
  loadHistory,
  renderStatsHtml,
  summarizeHistory
} from '../dist/application/history.js';
import { parseArgs, UsageError } from '../dist/interfaces/cli/args.js';
import { commandHistory, commandStats } from '../dist/interfaces/cli/commands/history.js';
import { printHelp } from '../dist/interfaces/cli/help.js';

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), `consilium-${prefix}-`));
}

function cleanup(directory) {
  rmSync(directory, { recursive: true, force: true });
}

function makeRun(id, createdAt, overrides = {}) {
  return {
    version: 1,
    id,
    createdAt,
    task: `Task ${id}`,
    success: true,
    text: `Result ${id}`,
    experts: [],
    models: {},
    usage: { cost: 0 },
    metadata: {},
    ...overrides
  };
}

function writeRun(runsDir, run, mtime) {
  const directory = join(runsDir, run.id);
  mkdirSync(directory, { recursive: true });
  const file = join(directory, 'run.json');
  writeFileSync(file, `${JSON.stringify(run, null, 2)}\n`, 'utf8');
  if (mtime !== undefined) {
    utimesSync(file, mtime, mtime);
  }
  return directory;
}

/**
 * 3 артефакта: успешный с находками и консенсусом, неуспешный с RATE_LIMITED,
 * и битый run.json. mtime задаёт порядок: битый самый новый, успешный — самый старый.
 */
function createHistoryFixture() {
  const root = tempDir('history');
  const runs = join(root, '.consilium', 'runs');

  const success = makeRun('20260101-000000-aaaa', '2026-01-01T00:00:00.000Z', {
    task: 'Review <script>alert(1)</script>',
    experts: [
      {
        agent: 'arch',
        model: 'openai/gpt-x',
        success: true,
        duration: 100,
        text: 'arch answer',
        usage: { inputTokens: 10, outputTokens: 5, cost: 0.01 }
      },
      {
        agent: 'sec',
        model: 'openai/gpt-x',
        success: true,
        duration: 100,
        text: 'sec answer',
        usage: { cost: 0.02 }
      },
      {
        agent: 'ba',
        model: 'anthropic/claude-y',
        success: true,
        duration: 100,
        text: 'ba answer',
        usage: { cost: 0.005 }
      }
    ],
    models: {
      arch: 'openai/gpt-x',
      sec: 'openai/gpt-x',
      ba: 'anthropic/claude-y'
    },
    usage: { cost: 0.035 },
    metadata: {
      findings: {
        counts: { critical: 1, high: 2, medium: 0, low: 0, info: 0 },
        items: [
          {
            severity: 'critical',
            claim: '<script>alert("claim")</script>',
            contested: true
          },
          { severity: 'high', claim: 'Second issue', contested: false },
          { severity: 'high', claim: 'Third issue', contested: false }
        ]
      },
      consensus: { agreement: 'high', averageSimilarity: 0.6 }
    }
  });

  const failure = makeRun('20260102-000000-bbbb', '2026-01-02T00:00:00.000Z', {
    task: 'Flaky run',
    success: false,
    experts: [
      {
        agent: 'arch',
        model: 'openai/gpt-x',
        success: false,
        errorCode: 'RATE_LIMITED',
        duration: 300,
        text: ''
      },
      {
        agent: 'sec',
        model: 'anthropic/claude-y',
        success: true,
        duration: 300,
        text: 'survived'
      }
    ],
    models: {
      arch: 'openai/gpt-x',
      sec: 'anthropic/claude-y'
    },
    usage: { cost: 0.01 },
    metadata: {
      findings: {
        counts: { critical: 0, high: 0, medium: 1, low: 0, info: 0 },
        items: [
          { severity: 'medium', claim: 'Medium issue', contested: false }
        ]
      }
    }
  });

  writeRun(runs, success, new Date('2026-01-01T00:00:00.000Z'));
  writeRun(runs, failure, new Date('2026-01-02T00:00:00.000Z'));

  const corruptDir = join(runs, '20260103-000000-cccc');
  mkdirSync(corruptDir, { recursive: true });
  const corruptFile = join(corruptDir, 'run.json');
  writeFileSync(corruptFile, '{ broken json', 'utf8');
  utimesSync(
    corruptFile,
    new Date('2026-01-03T00:00:00.000Z'),
    new Date('2026-01-03T00:00:00.000Z')
  );

  return { root, runs, success, failure, corruptDir };
}

function captureConsole(t) {
  const logs = [];
  const errors = [];
  t.mock.method(console, 'log', (...args) => {
    logs.push(args.join(' '));
  });
  t.mock.method(console, 'error', (...args) => {
    errors.push(args.join(' '));
  });
  return { logs, errors };
}

test('loadHistory: новые сверху по mtime, limit, битый файл в warnings', t => {
  const { root, runs, success, failure, corruptDir } = createHistoryFixture();
  t.after(() => cleanup(root));

  const loaded = loadHistory({ dir: runs });
  assert.deepEqual(
    loaded.entries.map(entry => entry.id),
    [failure.id, success.id]
  );
  assert.equal(loaded.warnings.length, 1);
  assert.match(loaded.warnings[0], /corrupt/i);
  assert.ok(loaded.warnings[0].includes(corruptDir));

  const limited = loadHistory({ dir: runs, limit: 1 });
  assert.equal(limited.entries.length, 1);
  assert.equal(limited.entries[0].id, failure.id);

  const missing = loadHistory({ dir: join(root, 'no-such-dir') });
  assert.deepEqual(missing.entries, []);
  assert.deepEqual(missing.warnings, []);
});

test('summarizeHistory: успешность, стоимость, находки, модели и ошибки', t => {
  const { root, runs } = createHistoryFixture();
  t.after(() => cleanup(root));

  const { entries } = loadHistory({ dir: runs });
  const summary = summarizeHistory(entries);

  assert.equal(summary.totalRuns, 2);
  assert.equal(summary.successfulRuns, 1);
  assert.equal(summary.failedRuns, 1);
  assert.equal(summary.successRate, 0.5);
  assert.ok(Math.abs(summary.totalCost - 0.045) < 1e-9);
  assert.deepEqual(summary.findings.counts, {
    critical: 1,
    high: 2,
    medium: 1,
    low: 0,
    info: 0
  });
  assert.equal(summary.findings.total, 4);
  assert.equal(summary.contested, 1);
  assert.deepEqual(summary.duration, { p50: 200, p95: 290, count: 2 });

  const gpt = summary.models.find(model => model.model === 'openai/gpt-x');
  assert.ok(gpt);
  assert.equal(gpt.attempts, 3);
  assert.equal(gpt.successes, 2);
  assert.equal(gpt.failures, 1);
  assert.deepEqual(gpt.errors, [{ code: 'RATE_LIMITED', count: 1 }]);

  const claude = summary.models.find(model => model.model === 'anthropic/claude-y');
  assert.ok(claude);
  assert.equal(claude.attempts, 2);
  assert.equal(claude.successes, 2);
  assert.equal(claude.failures, 0);
  assert.deepEqual(claude.errors, []);

  assert.deepEqual(summary.topErrorCodes, [{ code: 'RATE_LIMITED', count: 1 }]);
  assert.deepEqual(summary.agreement, { high: 1 });
  assert.equal(summary.recentRuns[0].id, '20260102-000000-bbbb');
  assert.equal(summary.recentRuns[1].task, 'Review <script>alert(1)</script>');
  assert.ok(
    summary.topFindings.some(
      finding =>
        finding.claim.includes('<script>') &&
        finding.contested === true &&
        finding.count === 1
    )
  );
});

test('summarizeHistory: пустая история даёт нули без исключений', () => {
  const summary = summarizeHistory([]);
  assert.equal(summary.totalRuns, 0);
  assert.equal(summary.successRate, 0);
  assert.equal(summary.duration, null);
  assert.equal(summary.totalCost, 0);
  assert.equal(summary.findings.total, 0);
  assert.equal(summary.contested, 0);
  assert.deepEqual(summary.models, []);
  assert.deepEqual(summary.topErrorCodes, []);
  assert.deepEqual(summary.agreement, {});
  assert.deepEqual(summary.recentRuns, []);
  assert.deepEqual(summary.topFindings, []);
});

test('formatHistoryTable и formatStats: текст и JSON-ready сводка', t => {
  const { root, runs, success, failure } = createHistoryFixture();
  t.after(() => cleanup(root));

  const { entries } = loadHistory({ dir: runs });
  const summary = summarizeHistory(entries);
  const table = formatHistoryTable(entries);

  assert.match(table, /^id\s+date/);
  assert.ok(table.includes(success.id));
  assert.ok(table.includes(failure.id));
  assert.ok(table.includes('FAIL'));
  assert.ok(table.includes('3/3'));
  assert.ok(table.includes('1/2'));
  assert.ok(table.includes('1/2/0/0'));
  assert.ok(table.includes('0/0/1/0'));
  assert.ok(table.includes('high'));
  assert.equal(formatHistoryTable([]), 'No runs.');

  const text = formatStats(summary);
  assert.match(text, /Runs: 2 \(1 ok, 1 failed\)/);
  assert.match(text, /Success rate: 50\.0%/);
  assert.match(text, /p50 200 ms, p95 290 ms \(2 runs\)/);
  assert.match(text, /Total cost: \$0\.0450/);
  assert.match(text, /Findings: 4 \(critical 1, high 2, medium 1, low 0, info 0\)/);
  assert.match(text, /Contested findings: 1/);
  assert.match(text, /openai\/gpt-x \| 3 \| 2 \| 1 \| RATE_LIMITED: 1/);
  assert.match(text, /Top errors: RATE_LIMITED: 1/);
  assert.match(text, /Agreement: high: 1/);

  const emptyText = formatStats(summarizeHistory([]));
  assert.match(emptyText, /Runs: 0 \(0 ok, 0 failed\)/);
  assert.match(emptyText, /Duration: n\/a/);
  assert.match(emptyText, /Models: none/);
  assert.match(emptyText, /Top errors: none/);
  assert.match(emptyText, /Agreement: none/);

  // JSON-совместимость: в сводке нет Map/undefined/циклов.
  assert.deepEqual(JSON.parse(JSON.stringify(summary)), summary);
});

test('renderStatsHtml: автономный HTML без скриптов и с экранированием', t => {
  const { root, runs } = createHistoryFixture();
  t.after(() => cleanup(root));

  const summary = summarizeHistory(loadHistory({ dir: runs }).entries);
  const html = renderStatsHtml(summary);

  assert.match(html, /^<!DOCTYPE html>/);
  assert.match(html, /<meta charset="utf-8">/);
  assert.match(html, /<style>/);
  assert.match(html, /openai\/gpt-x/);
  assert.match(html, /RATE_LIMITED/);
  assert.equal(/<script/i.test(html), false);
  assert.equal(html.includes('<script>alert'), false);
  assert.ok(html.includes('Review &lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(
    html.includes('&lt;script&gt;alert(&quot;claim&quot;)&lt;/script&gt;')
  );
});

test('CLI: history/stats распознаются только в argv[0], --limit положительный', () => {
  const history = parseArgs(['history', '--limit', '2', '--json']);
  assert.equal(history.command, 'history');
  assert.equal(history.limit, 2);
  assert.equal(history.json, true);

  const stats = parseArgs(['stats', '--html', 'reports/stats.html']);
  assert.equal(stats.command, 'stats');
  assert.equal(stats.statsHtml, 'reports/stats.html');

  const afterFlags = parseArgs(['--json', 'history']);
  assert.equal(afterFlags.command, undefined);
  assert.equal(afterFlags.task, 'history');

  const inTask = parseArgs(['run', 'history']);
  assert.equal(inTask.command, 'run');
  assert.equal(inTask.task, 'history');

  for (const value of ['0', '-1', '1.5', 'abc']) {
    assert.throws(
      () => parseArgs(['history', '--limit', value]),
      error => error instanceof UsageError && /положительное целое/.test(error.message)
    );
  }
  assert.throws(() => parseArgs(['history', '--limit']), /требует значение/);
  assert.throws(() => parseArgs(['stats', '--html']), /требует значение/);
});

test('CLI: commandHistory — текст, JSON, limit, предупреждение и пустой каталог', async t => {
  const { root, success, failure } = createHistoryFixture();
  t.after(() => cleanup(root));
  const out = captureConsole(t);

  assert.equal(
    await commandHistory({ task: '', command: 'history' }, { cwd: root }),
    0
  );
  const text = out.logs.join('\n');
  assert.ok(text.includes(success.id));
  assert.ok(text.includes(failure.id));
  assert.ok(out.errors.some(line => /corrupt/i.test(line)));

  out.logs.length = 0;
  assert.equal(
    await commandHistory(
      { task: '', command: 'history', json: true, limit: 1 },
      { cwd: root }
    ),
    0
  );
  const parsed = JSON.parse(out.logs.join('\n'));
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].id, failure.id);
  assert.equal(parsed[0].success, false);
  assert.equal(parsed[0].experts.length, 2);
  assert.equal(parsed[0].findings.counts.medium, 1);
  assert.equal(parsed[0].agreement, undefined);

  const emptyRoot = tempDir('history-empty');
  t.after(() => cleanup(emptyRoot));
  out.logs.length = 0;
  out.errors.length = 0;
  assert.equal(
    await commandHistory({ task: '', command: 'history' }, { cwd: emptyRoot }),
    0
  );
  assert.equal(out.logs.join('\n').trim(), 'No runs.');
  assert.deepEqual(out.errors, []);
});

test('CLI: commandStats — текст, --json важнее --html, пустая история', async t => {
  const { root } = createHistoryFixture();
  t.after(() => cleanup(root));
  const out = captureConsole(t);

  assert.equal(await commandStats({ task: '', command: 'stats' }, { cwd: root }), 0);
  assert.match(out.logs.join('\n'), /Runs: 2 \(1 ok, 1 failed\)/);

  out.logs.length = 0;
  assert.equal(
    await commandStats(
      { task: '', command: 'stats', json: true, statsHtml: 'ignored.html' },
      { cwd: root }
    ),
    0
  );
  const parsed = JSON.parse(out.logs.join('\n'));
  assert.equal(parsed.totalRuns, 2);
  assert.equal(parsed.findings.total, 4);
  assert.equal(existsSync(join(root, 'ignored.html')), false);

  const emptyRoot = tempDir('history-stats-empty');
  t.after(() => cleanup(emptyRoot));
  out.logs.length = 0;
  assert.equal(
    await commandStats({ task: '', command: 'stats' }, { cwd: emptyRoot }),
    0
  );
  assert.match(out.logs.join('\n'), /Runs: 0 \(0 ok, 0 failed\)/);
});

test('CLI: commandStats --html пишет статический отчёт атомарно и печатает путь', async t => {
  const { root } = createHistoryFixture();
  t.after(() => cleanup(root));

  const { logs } = captureConsole(t);
  const options = { task: '', command: 'stats', statsHtml: 'reports/stats.html' };
  assert.equal(await commandStats(options, { cwd: root }), 0);

  const target = resolve(root, 'reports', 'stats.html');
  assert.equal(logs.join('\n').trim(), target);
  assert.equal(existsSync(target), true);

  const html = readFileSync(target, 'utf8');
  assert.match(html, /^<!DOCTYPE html>/);
  assert.match(html, /Consilium statistics/);
  assert.ok(html.includes('Review &lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.equal(html.includes('<script>alert'), false);
  assert.deepEqual(readdirSync(join(root, 'reports')), ['stats.html']);

  // Повторная запись заменяет файл и не оставляет временных файлов.
  assert.equal(await commandStats(options, { cwd: root }), 0);
  assert.deepEqual(readdirSync(join(root, 'reports')), ['stats.html']);
});

test('help перечисляет history и stats', t => {
  const logs = [];
  t.mock.method(console, 'log', (...args) => {
    logs.push(args.join(' '));
  });
  printHelp();
  const text = logs.join('\n');
  assert.match(text, /consilium history \[--limit N\] \[--json\]/);
  assert.match(text, /consilium stats \[--json\] \[--html <файл>\]/);
});
