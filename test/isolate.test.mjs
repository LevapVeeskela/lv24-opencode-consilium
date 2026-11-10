import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative } from 'node:path';
import { Consilium, mergeWithDefaults } from '../dist/application/consilium.js';
import {
  ISOLATE_WORKTREES_RELATIVE_PATH,
  cleanupStaleWorktrees,
  createIsolatedWorktree
} from '../dist/infrastructure/opencode/isolate.js';
import { READ_ONLY_OVERLAY_RELATIVE_PATH } from '../dist/infrastructure/opencode/read-only.js';
import { buildRunArgs } from '../dist/infrastructure/opencode/args.js';
import { shouldIgnore } from '../dist/watch.js';

const TRUSTED_PROJECT_CONFIG = Symbol.for('lv24-opencode-consilium.trustedProjectConfig');

const FAKE_OPENCODE = `import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const agentArg = args.find(arg => arg.startsWith('--agent='));
const agent = agentArg === undefined ? 'default' : agentArg.slice('--agent='.length);

if (args.includes('--version')) {
  process.stdout.write('fake-opencode 1.0.0\\n');
  process.exit(0);
}

const cwd = process.cwd();
const realCwd = realpathSync(cwd);
const overlayPath = join(cwd, '.opencode', 'opencode.json');
const overlay = existsSync(overlayPath) ? JSON.parse(readFileSync(overlayPath, 'utf8')) : null;
const trackedPath = join(cwd, 'note.txt');
const capture = {
  args,
  cwd,
  realCwd,
  overlay,
  tracked: existsSync(trackedPath) ? readFileSync(trackedPath, 'utf8') : null,
  untrackedExists: existsSync(join(cwd, 'untracked.txt')),
  marker: false
};
try {
  writeFileSync(join(cwd, '.isolate-marker'), agent, 'utf8');
  capture.marker = existsSync(join(cwd, '.isolate-marker'));
} catch {
  capture.marker = false;
}
const captureDir = process.env.FAKE_CAPTURE_DIR;
if (captureDir) {
  writeFileSync(
    join(captureDir, agent + '-' + process.pid + '-' + Date.now() + '.json'),
    JSON.stringify(capture),
    'utf8'
  );
}

const chunks = [];
process.stdin.on('data', chunk => chunks.push(chunk));
await new Promise(resolve => process.stdin.on('end', resolve));

if (process.env.FAKE_HANG === '1') {
  setInterval(() => {}, 1000);
} else if (process.env.FAKE_EXIT_CODE !== undefined) {
  process.exit(Number(process.env.FAKE_EXIT_CODE));
} else {
  process.stdout.write(
    JSON.stringify({ type: 'text', part: { type: 'text', text: 'OK ' + agent } }) + '\\n'
  );
}
`;

function mkTemp(prefix = 'consilium-isolate-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

function createRepo() {
  const dir = mkTemp();
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'isolate@example.test'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Isolate Test'], { cwd: dir });
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: dir });
  writeFileSync(join(dir, 'note.txt'), 'base\n', 'utf8');
  execFileSync('git', ['add', 'note.txt'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'initial'], { cwd: dir });
  return dir;
}

function createFakeOpenCode(dir) {
  const script = join(dir, 'fake-opencode.mjs');
  writeFileSync(script, FAKE_OPENCODE, 'utf8');

  if (process.platform === 'win32') {
    const shim = join(dir, 'fake-opencode.cmd');
    writeFileSync(shim, `@"${process.execPath}" "%~dp0fake-opencode.mjs" %*\r\n`, 'utf8');
    return shim;
  }

  const shim = join(dir, 'fake-opencode');
  writeFileSync(
    shim,
    `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/fake-opencode.mjs" "$@"\n`,
    'utf8'
  );
  chmodSync(shim, 0o755);
  return shim;
}

function markTrusted(config) {
  Object.defineProperty(config, TRUSTED_PROJECT_CONFIG, {
    value: true,
    enumerable: true,
    configurable: true
  });
  return config;
}

function makeConfig(dir, opencodePath, overrides = {}) {
  return markTrusted(
    mergeWithDefaults({
      cwd: dir,
      opencodePath,
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

function assertNoWorktrees(dir) {
  const root = worktreesRoot(dir);
  const left = existsSync(root)
    ? readdirSync(root, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name)
    : [];
  assert.deepEqual(left, [], `worktrees не удалены: ${left.join(', ')}`);
}

function gitWorktreeCount(dir) {
  const output = execFileSync('git', ['worktree', 'list', '--porcelain'], {
    cwd: dir,
    encoding: 'utf8'
  });
  return (output.match(/^worktree /gm) ?? []).length;
}

function isInside(parent, child) {
  let root = parent;
  let target = child;
  try {
    root = realpathSync(parent);
    target = realpathSync(child);
  } catch {
    // Worktree may already be removed; the lexical check is still useful.
  }
  const rel = relative(root, target);
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel);
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Сравнение содержимого без учёта autocrlf на Windows */
function normalizeEol(value) {
  return typeof value === 'string' ? value.replace(/\r\n/g, '\n') : value;
}

async function waitForCaptures(dir, count, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (readRunCaptures(dir).length >= count) return;
    await delay(50);
  }
}

function useCaptureDir(captureDir) {
  const previous = process.env.FAKE_CAPTURE_DIR;
  process.env.FAKE_CAPTURE_DIR = captureDir;
  return () => {
    if (previous === undefined) delete process.env.FAKE_CAPTURE_DIR;
    else process.env.FAKE_CAPTURE_DIR = previous;
  };
}

function useEnv(name, value) {
  const previous = process.env[name];
  process.env[name] = value;
  return () => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  };
}

test('isolate: каждый вызов агента получает отдельный worktree под .consilium/worktrees', async () => {
  const dir = createRepo();
  const captureDir = join(dir, 'captures');
  mkdirSync(captureDir, { recursive: true });
  const restoreEnv = useCaptureDir(captureDir);
  try {
    const config = makeConfig(dir, createFakeOpenCode(dir), { isolate: true });
    const result = await new Consilium(config).run('проверь задачу');

    assert.equal(result.success, true);
    assert.deepEqual(result.metadata?.safety, { readOnly: false, isolate: true });

    const captures = readRunCaptures(captureDir);
    assert.equal(captures.length, 3, 'два эксперта и председатель');
    assert.equal(new Set(captures.map(capture => capture.cwd)).size, 3);

    for (const capture of captures) {
      assert.equal(capture.marker, true, 'worktree должен существовать во время вызова');
      assert.equal(capture.args.includes('--worktree'), false, 'нативный --worktree запрещён');
      assert.ok(
        isInside(worktreesRoot(dir), capture.realCwd ?? capture.cwd),
        `cwd не внутри .consilium/worktrees: ${capture.cwd}`
      );
      assert.equal(existsSync(capture.cwd), false, 'worktree удалён после запуска');
    }

    assert.equal(existsSync(join(dir, '.opencode', 'opencode.json')), false);
    assertNoWorktrees(dir);
    assert.equal(gitWorktreeCount(dir), 1, 'в git остался только основной worktree');
  } finally {
    restoreEnv();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('isolate+read-only: слой с deny-правилами внутри worktree, основной проект не тронут', async () => {
  const dir = createRepo();
  mkdirSync(join(dir, '.opencode'), { recursive: true });
  const original = '{ "theme": "main-project" }\n';
  writeFileSync(join(dir, '.opencode', 'opencode.json'), original, 'utf8');
  execFileSync('git', ['add', '.opencode/opencode.json'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'opencode layer'], { cwd: dir });

  const captureDir = join(dir, 'captures');
  mkdirSync(captureDir, { recursive: true });
  const restoreEnv = useCaptureDir(captureDir);
  try {
    const config = makeConfig(dir, createFakeOpenCode(dir), {
      isolate: true,
      readOnly: true
    });
    const result = await new Consilium(config).run('проверь задачу');

    assert.equal(result.success, true);
    assert.deepEqual(result.metadata?.safety, { readOnly: true, isolate: true });

    const captures = readRunCaptures(captureDir);
    assert.equal(captures.length, 3);
    const coveredAgents = new Set();
    for (const capture of captures) {
      assert.ok(capture.overlay, 'дочерний процесс должен видеть слой внутри worktree');
      assert.equal(capture.overlay.theme, 'main-project');
      for (const agent of ['build', 'plan', 'general', 'explore']) {
        assert.deepEqual(
          capture.overlay.agents[agent].permissions.map(rule => [
            rule.action,
            rule.resource,
            rule.effect
          ]),
          [
            ['*', '*', 'deny'],
            ['read', '*', 'allow'],
            ['glob', '*', 'allow'],
            ['grep', '*', 'allow'],
            ['read', '*.env', 'deny'],
            ['read', '*.env.*', 'deny'],
            ['read', '*.env.example', 'allow']
          ]
        );
        assert.equal(capture.overlay.agent[agent].tools.write, false);
        assert.equal(capture.overlay.agent[agent].tools.bash, false);
      }
      for (const agent of ['arch', 'sec', 'consilium']) {
        if (capture.overlay.agents[agent] === undefined) continue;
        coveredAgents.add(agent);
        assert.ok(Array.isArray(capture.overlay.agents[agent].permissions));
        assert.equal(capture.overlay.agent[agent].tools.edit, false);
        assert.equal(capture.overlay.agent[agent].tools.task, false);
      }
    }
    assert.deepEqual([...coveredAgents].sort(), ['arch', 'consilium', 'sec']);

    assert.equal(
      readFileSync(join(dir, '.opencode', 'opencode.json'), 'utf8'),
      original,
      'основной слой восстановлен байт-в-байт'
    );
    assert.equal(existsSync(join(dir, '.consilium', 'read-only.lock')), false);
    assertNoWorktrees(dir);
  } finally {
    restoreEnv();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('worktree видит отслеживаемые изменения и не копирует untracked-файлы', async () => {
  const dir = createRepo();
  writeFileSync(join(dir, 'note.txt'), 'changed\n', 'utf8');
  writeFileSync(join(dir, 'untracked.txt'), 'secret\n', 'utf8');

  const captureDir = join(dir, 'captures');
  mkdirSync(captureDir, { recursive: true });
  const restoreEnv = useCaptureDir(captureDir);
  try {
    const config = makeConfig(dir, createFakeOpenCode(dir), {
      isolate: true,
      experts: [{ name: 'arch' }]
    });
    const result = await new Consilium(config).run('проверь задачу');
    assert.equal(result.success, true);

    const captures = readRunCaptures(captureDir);
    assert.equal(captures.length, 2);
    for (const capture of captures) {
      assert.equal(
        normalizeEol(capture.tracked),
        'changed\n',
        'незакоммиченное изменение видно в worktree'
      );
      assert.equal(capture.untrackedExists, false, 'untracked-файлы не копируются');
    }

    assert.equal(readFileSync(join(dir, 'note.txt'), 'utf8'), 'changed\n');
    assert.equal(existsSync(join(dir, 'untracked.txt')), true);
    assert.equal(
      execFileSync('git', ['stash', 'list'], { cwd: dir, encoding: 'utf8' }).trim(),
      '',
      'git stash create не должен менять stash list'
    );
    assertNoWorktrees(dir);
  } finally {
    restoreEnv();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('не-git каталог с isolate падает до запуска агентов', async () => {
  const dir = mkTemp();
  const captureDir = join(dir, 'captures');
  mkdirSync(captureDir, { recursive: true });
  const restoreEnv = useCaptureDir(captureDir);
  try {
    const config = makeConfig(dir, createFakeOpenCode(dir), { isolate: true });
    await assert.rejects(
      () => new Consilium(config).run('проверь задачу'),
      /--isolate требует git-репозиторий/
    );
    assert.deepEqual(readRunCaptures(captureDir), []);
    assert.equal(existsSync(join(dir, '.consilium')), false);
  } finally {
    restoreEnv();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('ошибка агента очищает worktree и read-only слой', async () => {
  const dir = createRepo();
  const captureDir = join(dir, 'captures');
  mkdirSync(captureDir, { recursive: true });
  const restoreCapture = useCaptureDir(captureDir);
  const restoreExit = useEnv('FAKE_EXIT_CODE', '1');
  try {
    const config = makeConfig(dir, createFakeOpenCode(dir), {
      isolate: true,
      readOnly: true
    });
    const result = await new Consilium(config).run('проверь задачу');
    assert.equal(result.success, false);

    const captures = readRunCaptures(captureDir);
    assert.ok(captures.length >= 1);
    for (const capture of captures) {
      assert.equal(existsSync(capture.cwd), false, `worktree не удалён: ${capture.cwd}`);
    }
    assert.equal(existsSync(join(dir, '.opencode', 'opencode.json')), false);
    assert.equal(existsSync(join(dir, '.consilium', 'read-only.lock')), false);
    assertNoWorktrees(dir);
    assert.equal(gitWorktreeCount(dir), 1);
  } finally {
    restoreExit();
    restoreCapture();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('отмена очищает worktree и read-only слой', async () => {
  const dir = createRepo();
  const captureDir = join(dir, 'captures');
  mkdirSync(captureDir, { recursive: true });
  const restoreCapture = useCaptureDir(captureDir);
  const restoreHang = useEnv('FAKE_HANG', '1');
  try {
    const config = makeConfig(dir, createFakeOpenCode(dir), {
      isolate: true,
      readOnly: true
    });
    const consilium = new Consilium(config);
    const runPromise = consilium.run('ALL_SLOW проверь задачу');

    await waitForCaptures(captureDir, 2);
    const beforeCancel = readRunCaptures(captureDir);
    for (const capture of beforeCancel) {
      assert.equal(existsSync(capture.cwd), true, 'worktree существует во время работы');
    }
    consilium.cancel();
    const result = await runPromise;

    assert.equal(result.success, false);
    assert.equal(result.metadata?.cancelled, true);
    assert.deepEqual(result.metadata?.safety, { readOnly: true, isolate: true });

    for (const capture of readRunCaptures(captureDir)) {
      assert.equal(existsSync(capture.cwd), false, `worktree не удалён: ${capture.cwd}`);
    }
    assert.equal(existsSync(join(dir, '.opencode', 'opencode.json')), false);
    assert.equal(existsSync(join(dir, '.consilium', 'read-only.lock')), false);
    assertNoWorktrees(dir);
  } finally {
    restoreHang();
    restoreCapture();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('очистка: осиротевшие worktree удаляются, живой не трогается', () => {
  const dir = createRepo();
  const live = createIsolatedWorktree({ cwd: dir, label: 'live' });
  try {
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(live.path, old, old);

    const orphan = join(worktreesRoot(dir), 'orphan-dead');
    mkdirSync(orphan, { recursive: true });
    writeFileSync(join(orphan, 'leftover.txt'), 'x', 'utf8');
    utimesSync(orphan, old, old);

    const stale = join(worktreesRoot(dir), 'stale-registered');
    execFileSync('git', ['worktree', 'add', '--detach', stale, 'HEAD'], { cwd: dir });
    execFileSync('git', ['worktree', 'lock', '--reason', 'consilium:999999:1', stale], {
      cwd: dir
    });
    utimesSync(stale, old, old);

    const unregisteredLive = join(worktreesRoot(dir), 'live-alias');
    mkdirSync(unregisteredLive, { recursive: true });
    writeFileSync(join(unregisteredLive, '.git'), 'gitdir: elsewhere\n', 'utf8');
    utimesSync(unregisteredLive, old, old);

    const removed = cleanupStaleWorktrees({ root: dir, staleAfterMs: 60 * 1000 });
    const removedNames = removed.map(path => basename(path)).sort();
    assert.deepEqual(removedNames, ['orphan-dead', 'stale-registered']);
    assert.equal(existsSync(live.path), true, 'живой worktree не удаляется');
    assert.equal(existsSync(orphan), false);
    assert.equal(existsSync(stale), false);
    assert.equal(existsSync(unregisteredLive), true, 'worktree-маркер без регистрации не удаляется');
    assert.equal(gitWorktreeCount(dir), 2, 'основной и живой worktree');
  } finally {
    live.remove();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('watch игнорирует .consilium/worktrees, buildRunArgs не знает --worktree', () => {
  assert.equal(ISOLATE_WORKTREES_RELATIVE_PATH, '.consilium/worktrees');
  assert.equal(
    shouldIgnore(join('.consilium', 'worktrees', 'arch-abc', 'src', 'index.ts')),
    true
  );
  assert.equal(buildRunArgs({ config: { isolate: true } }).includes('--worktree'), false);
  assert.equal(READ_ONLY_OVERLAY_RELATIVE_PATH, '.opencode/opencode.json');
});
