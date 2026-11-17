import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { commandRun } from '../dist/interfaces/cli/commands/run.js';
import { commandAudit } from '../dist/interfaces/cli/commands/audit.js';
import { buildTaskDetails } from '../dist/interfaces/cli/task.js';
import { EXIT_CODES } from '../dist/interfaces/cli/args.js';
import { Consilium } from '../dist/application/consilium.js';
import { renderHtmlReport, renderPrMarkdown } from '../dist/report.js';
import {
  findProjectConfigRisks,
  formatProjectConfigRisks
} from '../dist/infrastructure/opencode/project-config-risk.js';

function mkTemp(prefix = 'consilium-diff-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function rm(dir) {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function initRepo(dir) {
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@example.invalid');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  git(dir, 'add', 'a.txt');
  git(dir, 'commit', '-q', '-m', 'first');
}

function writeConfig(dir) {
  fs.writeFileSync(
    path.join(dir, 'consilium.config.json'),
    JSON.stringify({
      autoDiscoverAgents: false,
      artifacts: false,
      consensus: false,
      findings: true,
      experts: [{ name: 'arch' }, { name: 'sec' }]
    }),
    'utf8'
  );
}

const EMPTY_COUNTS = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };

/** Runs commandRun in `dir` with a mocked council; returns code, output and call count. */
async function run(t, dir, options) {
  const previousCwd = process.cwd();
  const stderr = [];
  const stdout = [];
  let calls = 0;
  let seenOptions;
  let returned;
  t.mock.method(console, 'error', (...args) => stderr.push(args.join(' ')));
  t.mock.method(console, 'log', (...args) => stdout.push(args.join(' ')));
  t.mock.method(Consilium.prototype, 'run', async (_task, runOptions) => {
    calls += 1;
    seenOptions = runOptions;
    returned = {
      text: 'verdict',
      experts: [
        { agent: 'arch', text: 'ok', success: true },
        { agent: 'sec', text: 'ok', success: true }
      ],
      chair: { agent: 'consilium', text: 'verdict', success: true },
      totalTime: 1,
      parallelTime: 1,
      success: true,
      metadata: {
        ...(runOptions?.metadata ?? {}),
        findings: { items: [], counts: EMPTY_COUNTS, rejected: [], parseErrors: [] }
      }
    };
    return returned;
  });

  const originalOnce = process.once;
  process.once = function (event, listener) {
    if (event === 'SIGINT' || event === 'SIGTERM') return this;
    return originalOnce.call(this, event, listener);
  };
  try {
    process.chdir(dir);
    const code = await commandRun({ task: 'Review', silent: true, ...options });
    return {
      code,
      calls,
      stderr: stderr.join('\n'),
      stdout: stdout.join('\n'),
      runOptions: seenOptions,
      result: returned
    };
  } finally {
    process.once = originalOnce;
    process.chdir(previousCwd);
  }
}

const TRUNCATED = { empty: false, truncated: true, filesChanged: 40, chars: 60000 };

test('пустой diff: выход 0 без вызова моделей', async t => {
  const dir = mkTemp();
  try {
    writeConfig(dir);
    const outcome = await run(t, dir, {
      diffInfo: { empty: true, truncated: false, filesChanged: 0, chars: 0 },
      failOn: 'high',
      findings: true
    });
    assert.equal(outcome.code, EXIT_CODES.success);
    assert.equal(outcome.calls, 0);
    assert.match(outcome.stderr, /diff is empty: nothing to review/);
  } finally {
    rm(dir);
  }
});

test('пустой diff при -f json: машинно-читаемый признак пропуска', async t => {
  const dir = mkTemp();
  try {
    writeConfig(dir);
    const outcome = await run(t, dir, {
      diffInfo: { empty: true, truncated: false, filesChanged: 0, chars: 0 },
      format: 'json'
    });
    assert.equal(outcome.calls, 0);
    assert.deepEqual(JSON.parse(outcome.stdout), { success: true, skipped: 'empty-diff' });
  } finally {
    rm(dir);
  }
});

test('--diff в репозитории без изменений не запускает совет', async t => {
  const dir = mkTemp();
  try {
    initRepo(dir);
    writeConfig(dir);
    git(dir, 'add', 'consilium.config.json');
    git(dir, 'commit', '-q', '-m', 'config');
    const outcome = await run(t, dir, { diff: true });
    assert.equal(outcome.code, EXIT_CODES.success);
    assert.equal(outcome.calls, 0);
  } finally {
    rm(dir);
  }
});

test('--diff с изменениями: metadata.diff передаётся в запуск', async t => {
  const dir = mkTemp();
  try {
    initRepo(dir);
    writeConfig(dir);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\n');
    const outcome = await run(t, dir, { diff: true });
    assert.equal(outcome.code, EXIT_CODES.success);
    assert.equal(outcome.calls, 1);
    assert.equal(outcome.runOptions.metadata.diff.empty, false);
    assert.equal(outcome.runOptions.metadata.diff.truncated, false);
    assert.equal(outcome.runOptions.metadata.diff.filesChanged, 1);
  } finally {
    rm(dir);
  }
});

test('обрезанный diff при --fail-on: гейт не состоялся, код policyGate', async t => {
  const dir = mkTemp();
  try {
    writeConfig(dir);
    const outcome = await run(t, dir, { diffInfo: TRUNCATED, failOn: 'high', findings: true });
    assert.equal(outcome.code, EXIT_CODES.policyGate);
    assert.match(outcome.stderr, /diff truncated to 60000 characters \(40 files changed\)/);
    assert.match(
      outcome.stderr,
      /policy gate inconclusive: diff: truncated, part of the change was not reviewed/
    );
    assert.deepEqual(outcome.result.metadata.policyGate.reasons, [
      { kind: 'diff_truncated', agent: 'diff', code: 'TRUNCATED' }
    ]);
  } finally {
    rm(dir);
  }
});

test('обрезанный diff с --gate-allow-partial: 0 и предупреждение', async t => {
  const dir = mkTemp();
  try {
    writeConfig(dir);
    const outcome = await run(t, dir, {
      diffInfo: TRUNCATED,
      failOn: 'high',
      findings: true,
      gateAllowPartial: true
    });
    assert.equal(outcome.code, EXIT_CODES.success);
    assert.match(outcome.stderr, /policy gate inconclusive \(allowed by --gate-allow-partial\)/);
  } finally {
    rm(dir);
  }
});

test('обрезанный diff без --fail-on: код 0, предупреждение остаётся', async t => {
  const dir = mkTemp();
  try {
    writeConfig(dir);
    const outcome = await run(t, dir, { diffInfo: TRUNCATED });
    assert.equal(outcome.code, EXIT_CODES.success);
    assert.match(outcome.stderr, /diff truncated/);
    assert.equal(outcome.result.metadata.policyGate, undefined);
  } finally {
    rm(dir);
  }
});

test('отчёты предупреждают об обрезанном diff', () => {
  const result = {
    text: 'verdict',
    experts: [{ agent: 'arch', text: 'ok', success: true }],
    chair: { agent: 'consilium', text: 'verdict', success: true },
    totalTime: 1,
    parallelTime: 1,
    success: true,
    metadata: { diff: TRUNCATED }
  };
  assert.match(renderPrMarkdown(result), /\*\*Diff truncated:\*\* only the first 60000 characters/);
  assert.match(renderHtmlReport(result), /<h2>Diff truncated<\/h2>/);

  result.metadata.diff = { ...TRUNCATED, truncated: false };
  assert.ok(!renderPrMarkdown(result).includes('Diff truncated'));
});

test('buildTaskDetails: сведения о diff только когда он запрошен', async () => {
  const dir = mkTemp();
  const previousCwd = process.cwd();
  try {
    initRepo(dir);
    process.chdir(dir);

    const plain = await buildTaskDetails({ task: 'Design a cache' });
    assert.equal(plain.diff, undefined);

    const empty = await buildTaskDetails({ task: 'Review', diff: true });
    assert.equal(empty.diff.empty, true);

    fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\n');
    const changed = await buildTaskDetails({ task: 'Review', diff: true });
    assert.equal(changed.diff.empty, false);
    assert.equal(changed.diff.filesChanged, 1);
    assert.ok(changed.diff.chars > 0);
    assert.match(changed.task, /untrusted-diff/);
  } finally {
    process.chdir(previousCwd);
    rm(dir);
  }
});

test('audit передаёт сведения о diff в run', async () => {
  const dir = mkTemp();
  const previousCwd = process.cwd();
  try {
    initRepo(dir);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\n');
    git(dir, 'commit', '-q', '-am', 'second');
    process.chdir(dir);

    let captured;
    const code = await commandAudit(
      { task: '', command: 'audit', since: 'HEAD~1' },
      {
        run: async options => {
          captured = options;
          return 0;
        }
      }
    );
    assert.equal(code, 0);
    assert.deepEqual(
      { empty: captured.diffInfo.empty, truncated: captured.diffInfo.truncated },
      { empty: false, truncated: false }
    );
    assert.equal(captured.diffInfo.filesChanged, 1);

    let emptyCapture;
    await commandAudit(
      { task: '', command: 'audit', since: 'HEAD' },
      {
        run: async options => {
          emptyCapture = options;
          return 0;
        }
      }
    );
    assert.equal(emptyCapture.diffInfo.empty, true);
  } finally {
    process.chdir(previousCwd);
    rm(dir);
  }
});

test('findProjectConfigRisks: mcp, плагины и провайдеры в проектном opencode-конфиге', () => {
  const dir = mkTemp();
  try {
    assert.deepEqual(findProjectConfigRisks(dir), []);
    assert.equal(formatProjectConfigRisks([]), undefined);

    fs.writeFileSync(
      path.join(dir, 'opencode.json'),
      JSON.stringify({ agent: { arch: {} }, mcp: {}, plugins: [] })
    );
    assert.deepEqual(findProjectConfigRisks(dir), [], 'пустые секции не считаются');

    fs.writeFileSync(
      path.join(dir, 'opencode.json'),
      JSON.stringify({ mcp: { tool: { type: 'local', command: ['node', 'x.js'] } } })
    );
    fs.mkdirSync(path.join(dir, '.opencode'));
    fs.writeFileSync(
      path.join(dir, '.opencode', 'opencode.jsonc'),
      '{\n  // custom endpoint\n  "provider": { "x": { "options": { "baseURL": "https://example.invalid" } } },\n  "plugins": [{ "package": "some-plugin" }]\n}\n'
    );

    const risks = findProjectConfigRisks(dir);
    assert.deepEqual(risks, [
      { file: 'opencode.json', keys: ['mcp'] },
      { file: '.opencode/opencode.jsonc', keys: ['plugins', 'provider'] }
    ]);
    const warning = formatProjectConfigRisks(risks);
    assert.match(warning, /Read-only does not restrict the project OpenCode config/);
    assert.match(warning, /opencode\.json \(mcp\)/);
  } finally {
    rm(dir);
  }
});
