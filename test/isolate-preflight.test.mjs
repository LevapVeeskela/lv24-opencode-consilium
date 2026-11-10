import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join, relative } from 'node:path';
import { Consilium, mergeWithDefaults } from '../dist/application/consilium.js';
import { main } from '../dist/cli.js';
import { parseArgs, UsageError } from '../dist/interfaces/cli/args.js';
import { commandWatch } from '../dist/interfaces/cli/commands/watch.js';
import {
  ISOLATION_JSONC_UNSUPPORTED,
  IsolationConfigError,
  assertIsolatedReadOnlyPreflight
} from '../dist/infrastructure/opencode/isolate.js';

const TRUSTED_PROJECT_CONFIG = Symbol.for('lv24-opencode-consilium.trustedProjectConfig');

const FAKE_OPENCODE = `import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const agentArg = args.find(arg => arg.startsWith('--agent='));
const agent = agentArg === undefined ? 'default' : agentArg.slice('--agent='.length);

if (args.includes('--version')) {
  process.stdout.write('fake-opencode 1.0.0\\n');
  process.exit(0);
}

const cwd = process.cwd();
const overlayPath = join(cwd, '.opencode', 'opencode.json');
const overlay = existsSync(overlayPath) ? JSON.parse(readFileSync(overlayPath, 'utf8')) : null;
const captureDir = process.env.FAKE_CAPTURE_DIR;
if (captureDir) {
  writeFileSync(
    join(captureDir, agent + '-' + process.pid + '-' + Date.now() + '.json'),
    JSON.stringify({ args, cwd, overlay, trackedExists: existsSync(join(cwd, 'note.txt')) }),
    'utf8'
  );
}

const chunks = [];
process.stdin.on('data', chunk => chunks.push(chunk));
await new Promise(resolve => process.stdin.on('end', resolve));

process.stdout.write(
  JSON.stringify({ type: 'text', part: { type: 'text', text: 'OK ' + agent } }) + '\\n'
);
`;

const toolsDir = mkdtempSync(join(tmpdir(), 'consilium-preflight-tools-'));
const fakeOpenCode = createFakeOpenCode(toolsDir);

after(() => {
  rmSync(toolsDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function mkTemp(prefix = 'consilium-preflight-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

function createFakeOpenCode(dir) {
  const script = join(dir, 'fake-opencode.mjs');
  writeFileSync(script, FAKE_OPENCODE, 'utf8');

  if (process.platform === 'win32') {
    const shim = join(dir, 'opencode.cmd');
    writeFileSync(shim, `@"${process.execPath}" "%~dp0fake-opencode.mjs" %*\r\n`, 'utf8');
    return shim;
  }

  const shim = join(dir, 'opencode');
  writeFileSync(
    shim,
    `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/fake-opencode.mjs" "$@"\n`,
    'utf8'
  );
  chmodSync(shim, 0o755);
  return shim;
}

function createRepo() {
  const dir = mkTemp();
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'preflight@example.test'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Preflight Test'], { cwd: dir });
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: dir });
  writeFileSync(join(dir, 'note.txt'), 'base\n', 'utf8');
  execFileSync('git', ['add', 'note.txt'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'initial'], { cwd: dir });
  return dir;
}

function trackedJsonc(dir, content = '{ // project config\n  "agents": {}\n}\n') {
  mkdirSync(join(dir, '.opencode'), { recursive: true });
  const path = join(dir, '.opencode', 'opencode.jsonc');
  writeFileSync(path, content, 'utf8');
  execFileSync('git', ['add', '.opencode/opencode.jsonc'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'jsonc layer'], { cwd: dir });
  return path;
}

function trackedJson(dir, content = '{ "theme": "main-project" }\n') {
  mkdirSync(join(dir, '.opencode'), { recursive: true });
  const path = join(dir, '.opencode', 'opencode.json');
  writeFileSync(path, content, 'utf8');
  execFileSync('git', ['add', '.opencode/opencode.json'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'json layer'], { cwd: dir });
  return path;
}

function markTrusted(config) {
  Object.defineProperty(config, TRUSTED_PROJECT_CONFIG, {
    value: true,
    enumerable: true,
    configurable: true
  });
  return config;
}

function makeConfig(dir, overrides = {}) {
  return markTrusted(
    mergeWithDefaults({
      cwd: dir,
      opencodePath: fakeOpenCode,
      autoDiscoverAgents: false,
      experts: [{ name: 'arch' }, { name: 'sec' }],
      chair: { agent: 'consilium', timeout: 5000 },
      timeouts: { expert: 5000, chair: 5000, shutdown: 500 },
      retry: {
        expertRetries: 0,
        chairRetries: 0,
        delay: 1,
        exponentialBackoff: false,
        jitter: false,
        maxConcurrency: 2
      },
      output: { file: false, format: 'text', progress: false, logLevel: 'silent' },
      artifacts: false,
      ...overrides
    })
  );
}

function readRunCaptures(dir) {
  if (!existsSync(dir)) return [];
  const captures = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const parsed = JSON.parse(readFileSync(join(dir, name), 'utf8'));
    if (Array.isArray(parsed.args) && parsed.args.includes('run')) {
      captures.push(parsed);
    }
  }
  return captures;
}

function worktreesRoot(dir) {
  return join(dir, '.consilium', 'worktrees');
}

function listWorktrees(dir) {
  const root = worktreesRoot(dir);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name);
}

function isInside(parent, child) {
  const rel = relative(parent, child);
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel);
}

function samePath(left, right) {
  const normalize = value => value.replace(/\\/g, '/');
  return process.platform === 'win32'
    ? normalize(left).toLowerCase() === normalize(right).toLowerCase()
    : normalize(left) === normalize(right);
}

function useCaptureDir(captureDir) {
  const previous = process.env.FAKE_CAPTURE_DIR;
  process.env.FAKE_CAPTURE_DIR = captureDir;
  return () => {
    if (previous === undefined) delete process.env.FAKE_CAPTURE_DIR;
    else process.env.FAKE_CAPTURE_DIR = previous;
  };
}

function usePath(dir) {
  const previous = process.env.PATH;
  process.env.PATH = `${dir}${delimiter}${previous ?? ''}`;
  return () => {
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
  };
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

test('preflight: no-op без isolate/read-only, git-ошибка сохраняется', () => {
  const dir = mkTemp();
  try {
    assert.doesNotThrow(() =>
      assertIsolatedReadOnlyPreflight({ cwd: dir, readOnly: true, isolate: false })
    );
    assert.doesNotThrow(() =>
      assertIsolatedReadOnlyPreflight({ cwd: dir, readOnly: false, isolate: true })
    );
    // Не-git каталог получает существующую ошибку git, а не JSONC-ошибку.
    assert.throws(
      () => assertIsolatedReadOnlyPreflight({ cwd: dir, readOnly: true, isolate: true }),
      /--isolate требует git-репозиторий/
    );
    assert.equal(ISOLATION_JSONC_UNSUPPORTED, 'ISOLATION_JSONC_UNSUPPORTED');
  } finally {
    cleanup(dir);
  }
});

test('isolate+read-only: tracked .opencode/opencode.jsonc — typed error до агентов', async () => {
  const dir = createRepo();
  const jsoncPath = trackedJsonc(dir);
  const original = readFileSync(jsoncPath, 'utf8');
  const captureDir = join(dir, 'captures');
  mkdirSync(captureDir, { recursive: true });
  const restoreCapture = useCaptureDir(captureDir);
  try {
    const config = makeConfig(dir, { isolate: true, readOnly: true });
    await assert.rejects(
      () => new Consilium(config).run('проверь задачу'),
      error => {
        assert.ok(error instanceof IsolationConfigError, `не тот тип ошибки: ${error}`);
        assert.equal(error.code, ISOLATION_JSONC_UNSUPPORTED);
        assert.ok(error.path !== undefined && samePath(error.path, jsoncPath));
        assert.match(error.message, /\.opencode[\\/]opencode\.jsonc/);
        assert.ok(
          error.message.includes('.opencode/opencode.json'),
          'сообщение должно предлагать переименование в opencode.json'
        );
        assert.match(error.message, /--read-only/);
        assert.match(error.message, /--allow-write/);
        return true;
      }
    );

    assert.deepEqual(readRunCaptures(captureDir), [], 'ни один агент не должен запускаться');
    assert.equal(existsSync(worktreesRoot(dir)), false, 'worktree не создаётся');
    assert.equal(readFileSync(jsoncPath, 'utf8'), original, 'файл не изменён');
  } finally {
    restoreCapture();
    cleanup(dir);
  }
});

test('CLI: --isolate --read-only с .opencode/opencode.jsonc — exit 2 и без spawn', async t => {
  const dir = createRepo();
  const jsoncPath = trackedJsonc(dir);
  const captureDir = join(dir, 'captures');
  mkdirSync(captureDir, { recursive: true });
  const restoreCapture = useCaptureDir(captureDir);
  const restorePath = usePath(toolsDir);
  const previousCwd = process.cwd();
  const lines = [];
  t.mock.method(console, 'error', (...args) => lines.push(args.join(' ')));
  t.mock.method(console, 'log', () => {});
  try {
    process.chdir(dir);
    const code = await main(['--isolate', '--read-only', 'review']);

    assert.equal(code, 2, `ожидался код 2, stderr: ${lines.join('\n')}`);
    const text = lines.join('\n');
    assert.ok(
      text.toLowerCase().includes(jsoncPath.toLowerCase()),
      `в stderr нет пути ${jsoncPath}: ${text}`
    );
    assert.ok(
      text.includes('.opencode/opencode.json'),
      `в stderr нет совета переименовать: ${text}`
    );
    assert.match(text, /--read-only/);
    assert.match(text, /--allow-write/);
    assert.deepEqual(readRunCaptures(captureDir), [], 'дочерний процесс не запускается');
    assert.equal(listWorktrees(dir).length, 0);
  } finally {
    process.chdir(previousCwd);
    restorePath();
    restoreCapture();
    cleanup(dir);
  }
});

test('CLI: --isolate --allow-write с .opencode/opencode.jsonc работает', async t => {
  const dir = createRepo();
  trackedJsonc(dir);
  const captureDir = join(dir, 'captures');
  mkdirSync(captureDir, { recursive: true });
  const restoreCapture = useCaptureDir(captureDir);
  const restorePath = usePath(toolsDir);
  const previousCwd = process.cwd();
  const errors = [];
  t.mock.method(console, 'error', (...args) => errors.push(args.join(' ')));
  t.mock.method(console, 'log', () => {});
  try {
    process.chdir(dir);
    const code = await main(['--isolate', '--allow-write', 'review']);

    assert.equal(code, 0, `ожидался код 0, stderr: ${errors.join('\n')}`);
    const captures = readRunCaptures(captureDir);
    assert.ok(captures.length >= 1, 'fake opencode должен запуститься');
    for (const capture of captures) {
      assert.ok(
        isInside(worktreesRoot(dir), capture.cwd),
        `агент запущен вне worktree: ${capture.cwd}`
      );
      assert.equal(capture.overlay, null, 'read-only слой не пишется при --allow-write');
      assert.equal(capture.trackedExists, true, 'tracked-файлы видны в worktree');
    }
    assert.deepEqual(listWorktrees(dir), [], 'worktree удалены после запуска');
    assert.equal(existsSync(join(dir, '.opencode', 'opencode.json')), false);
  } finally {
    process.chdir(previousCwd);
    restorePath();
    restoreCapture();
    cleanup(dir);
  }
});

test('CLI audit/watch: --isolate в репозитории с .jsonc — usage error', async t => {
  const dir = createRepo();
  trackedJsonc(dir);
  const previousCwd = process.cwd();
  const lines = [];
  t.mock.method(console, 'error', (...args) => lines.push(args.join(' ')));
  try {
    process.chdir(dir);
    assert.equal(await main(['audit', '--since', 'HEAD', '--isolate']), 2);
    assert.match(lines.join('\n'), /opencode\.jsonc/);

    lines.length = 0;
    await assert.rejects(
      () => commandWatch(parseArgs(['watch', '--isolate', '--read-only', 'review'])),
      error => {
        assert.ok(error instanceof UsageError);
        assert.match(error.message, /opencode\.jsonc/);
        return true;
      }
    );
  } finally {
    process.chdir(previousCwd);
    cleanup(dir);
  }
});

test('untracked .opencode/opencode.jsonc: fail closed с тем же typed error', async () => {
  const dir = createRepo();
  mkdirSync(join(dir, '.opencode'), { recursive: true });
  const jsoncPath = join(dir, '.opencode', 'opencode.jsonc');
  const original = '{ // untracked\n  "agents": {}\n}\n';
  writeFileSync(jsoncPath, original, 'utf8');
  const captureDir = join(dir, 'captures');
  mkdirSync(captureDir, { recursive: true });
  const restoreCapture = useCaptureDir(captureDir);
  try {
    const config = makeConfig(dir, { isolate: true, readOnly: true });
    await assert.rejects(
      () => new Consilium(config).run('проверь задачу'),
      error =>
        error instanceof IsolationConfigError &&
        error.code === ISOLATION_JSONC_UNSUPPORTED
    );
    assert.deepEqual(readRunCaptures(captureDir), []);
    assert.equal(existsSync(worktreesRoot(dir)), false);
    assert.equal(readFileSync(jsoncPath, 'utf8'), original);
  } finally {
    restoreCapture();
    cleanup(dir);
  }
});

test('repo с .opencode/opencode.json (без .jsonc) и isolate+read-only работает', async () => {
  const dir = createRepo();
  const jsonPath = trackedJson(dir);
  const captureDir = join(dir, 'captures');
  mkdirSync(captureDir, { recursive: true });
  const restoreCapture = useCaptureDir(captureDir);
  try {
    const config = makeConfig(dir, { isolate: true, readOnly: true });
    const result = await new Consilium(config).run('проверь задачу');

    assert.equal(result.success, true);
    assert.deepEqual(result.metadata?.safety, { readOnly: true, isolate: true });

    const captures = readRunCaptures(captureDir);
    assert.equal(captures.length, 3, 'два эксперта и председатель');
    for (const capture of captures) {
      assert.ok(isInside(worktreesRoot(dir), capture.cwd));
      assert.ok(capture.overlay, 'per-worktree read-only слой должен быть виден');
      assert.equal(capture.overlay.theme, 'main-project');
    }

    assert.equal(readFileSync(jsonPath, 'utf8'), '{ "theme": "main-project" }\n');
    assert.deepEqual(listWorktrees(dir), []);
  } finally {
    restoreCapture();
    cleanup(dir);
  }
});

test('non-isolated --read-only и .jsonc: прежний fail closed в overlay-пути', async () => {
  const dir = mkTemp();
  mkdirSync(join(dir, '.opencode'), { recursive: true });
  const jsoncPath = join(dir, '.opencode', 'opencode.jsonc');
  writeFileSync(jsoncPath, '{ // project config\n  "agents": {}\n}\n', 'utf8');
  const captureDir = join(dir, 'captures');
  mkdirSync(captureDir, { recursive: true });
  const restoreCapture = useCaptureDir(captureDir);
  try {
    const config = makeConfig(dir, { isolate: false, readOnly: true });
    await assert.rejects(
      () => new Consilium(config).run('проверь задачу'),
      /Не удалось включить read-only/
    );
    assert.deepEqual(readRunCaptures(captureDir), []);
    assert.equal(existsSync(join(dir, '.opencode', 'opencode.json')), false);
  } finally {
    restoreCapture();
    cleanup(dir);
  }
});
