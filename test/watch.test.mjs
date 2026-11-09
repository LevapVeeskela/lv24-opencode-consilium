import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  buildPreCommitHook,
  createDebouncer,
  createProjectWatcher,
  installPreCommitHook,
  removeHookBlock,
  resolveHooksDir,
  shouldIgnore,
  uninstallPreCommitHook,
  upsertHookBlock
} from '../dist/watch.js';
import { commandWatch } from '../dist/interfaces/cli/commands/watch.js';
import { Consilium } from '../dist/application/consilium.js';

const START = '# >>> consilium >>>';
const END = '# <<< consilium <<<';

function countOccurrences(haystack, needle) {
  return haystack.split(needle).length - 1;
}

function mkTemp(prefix = 'consilium-watch-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function waitFor(cond, timeoutMs = 5000, stepMs = 25) {
  const deadline = Date.now() + timeoutMs;
  return (async () => {
    while (!cond()) {
      if (Date.now() > deadline) {
        throw new Error('timeout waiting for condition');
      }
      await new Promise(r => setTimeout(r, stepMs));
    }
  })();
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function withTimeout(promise, timeoutMs, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function writeWatchConfig(dir) {
  fs.writeFileSync(
    path.join(dir, 'consilium.config.json'),
    JSON.stringify(
      {
        autoDiscoverAgents: false,
        artifacts: false,
        consensus: false,
        debounceMs: 20,
        experts: [{ name: 'arch' }, { name: 'sec' }]
      },
      null,
      2
    ),
    'utf8'
  );
}

function fakeRunResult() {
  return {
    text: 'ok',
    experts: [{ agent: 'arch', text: 'ok', success: true }],
    chair: { agent: 'consilium', text: 'ok', success: true },
    totalTime: 1,
    parallelTime: 1,
    success: true,
    metadata: {}
  };
}

function spySignalHandlers() {
  const originalOnce = process.once;
  const handlers = { SIGINT: [], SIGTERM: [] };
  process.once = function (event, listener) {
    if (event === 'SIGINT' || event === 'SIGTERM') {
      handlers[event].push(listener);
    }
    return originalOnce.call(this, event, listener);
  };
  return {
    handlers,
    shutdown() {
      const listener = handlers.SIGINT[0] ?? handlers.SIGTERM[0];
      if (listener !== undefined) listener();
    },
    restore() {
      process.once = originalOnce;
    }
  };
}

// --- shouldIgnore ---

test('shouldIgnore: стандартные директории (posix)', () => {
  assert.equal(shouldIgnore('node_modules/pkg/index.js'), true);
  assert.equal(shouldIgnore('.git/HEAD'), true);
  assert.equal(shouldIgnore('dist/bundle.js'), true);
  assert.equal(shouldIgnore('.consilium/cache.json'), true);
  assert.equal(shouldIgnore('coverage/lcov.info'), true);
  assert.equal(shouldIgnore('src/index.ts'), false);
  assert.equal(shouldIgnore('README.md'), false);
});

test('shouldIgnore: префикс только по полному сегменту', () => {
  assert.equal(shouldIgnore('mydist/file.js'), false);
  assert.equal(shouldIgnore('src/district/x.ts'), false);
  assert.equal(shouldIgnore('dist2/y.js'), false);
});

test('shouldIgnore: windows-разделители', () => {
  assert.equal(shouldIgnore('node_modules\\pkg\\index.js'), true);
  assert.equal(shouldIgnore('.git\\hooks\\pre-commit'), true);
  assert.equal(shouldIgnore('src\\a.ts'), false);
});

test('shouldIgnore: абсолютные пути внутри игнорируемых директорий', () => {
  assert.equal(shouldIgnore('/repo/dist/out.js'), true);
  assert.equal(shouldIgnore('/repo/node_modules/x/y.js'), true);
  assert.equal(shouldIgnore('/repo/src/a.ts'), false);
  assert.equal(shouldIgnore('C:\\repo\\coverage\\lcov.info'), true);
  assert.equal(shouldIgnore('C:\\repo\\src\\a.ts'), false);
});

test('shouldIgnore: кастомные ignore не отменяют дефолты', () => {
  assert.equal(shouldIgnore('dist/x.js', ['generated']), true);
  assert.equal(shouldIgnore('node_modules/pkg/i.js', ['generated']), true);
  assert.equal(shouldIgnore('src/generated.ts', ['generated']), false);
});

test('shouldIgnore: глобы *.tmp, *.log, .DS_Store', () => {
  assert.equal(shouldIgnore('build.tmp'), true);
  assert.equal(shouldIgnore('a/b.tmp'), true);
  assert.equal(shouldIgnore('a/debug.log'), true);
  assert.equal(shouldIgnore('debug.log'), true);
  assert.equal(shouldIgnore('.DS_Store'), true);
  assert.equal(shouldIgnore('a/.DS_Store'), true);
  assert.equal(shouldIgnore('a/b.ts'), false);
  assert.equal(shouldIgnore('template.tmpl'), false);
});

test('shouldIgnore: кастомные ignore', () => {
  assert.equal(shouldIgnore('generated/x.ts', ['generated']), true);
  assert.equal(shouldIgnore('src/generated.ts', ['generated']), false);
  assert.equal(shouldIgnore('a/b.snap', ['*.snap']), true);
  assert.equal(shouldIgnore('a/b.ts', ['*.snap']), false);
});

// --- createDebouncer ---

test('createDebouncer: собирает пути, срабатывает один раз с отсортированным массивом', async () => {
  const calls = [];
  const d = createDebouncer(20, paths => calls.push(paths));
  d.push('b.txt');
  d.push('a.txt');
  d.push('b.txt');
  await sleep(100);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], ['a.txt', 'b.txt']);
});

test('createDebouncer: flush срабатывает сразу, двойного вызова нет', async () => {
  const calls = [];
  const d = createDebouncer(50, paths => calls.push(paths));
  d.push('x.txt');
  d.flush();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], ['x.txt']);
  await sleep(100);
  assert.equal(calls.length, 1);
  d.flush(); // пустой flush — ничего не делает
  assert.equal(calls.length, 1);
});

test('createDebouncer: cancel отменяет срабатывание', async () => {
  const calls = [];
  const d = createDebouncer(20, paths => calls.push(paths));
  d.push('x.txt');
  d.cancel();
  await sleep(80);
  assert.equal(calls.length, 0);
});

// --- hook helpers ---

test('buildPreCommitHook возвращает shebang + set -e + команду', () => {
  assert.equal(buildPreCommitHook('npm run review'), '#!/bin/sh\nset -e\nnpm run review\n');
});

test('upsertHookBlock на пустом файле даёт shebang и блок', () => {
  const out = upsertHookBlock('', 'npm run review');
  assert.ok(out.startsWith('#!/bin/sh\n'), 'shebang первым');
  assert.ok(out.includes(START));
  assert.ok(out.includes(END));
  assert.ok(out.includes('npm run review'));
  assert.equal(countOccurrences(out, START), 1);
});

test('upsertHookBlock сохраняет существующий hook и дописывает блок', () => {
  const existing = '#!/bin/sh\necho existing\n';
  const out = upsertHookBlock(existing, 'npm run review');
  assert.ok(out.includes('echo existing'));
  assert.ok(out.includes('npm run review'));
  assert.equal(countOccurrences(out, START), 1);
  assert.equal(countOccurrences(out, END), 1);
});

test('upsertHookBlock заменяет существующий блок, идемпотентен', () => {
  const first = upsertHookBlock('#!/bin/sh\necho hi\n', 'npm run old');
  const second = upsertHookBlock(first, 'npm run new');
  assert.ok(second.includes('npm run new'));
  assert.ok(!second.includes('npm run old'));
  assert.ok(second.includes('echo hi'));
  assert.equal(countOccurrences(second, START), 1);
  const third = upsertHookBlock(second, 'npm run new');
  assert.equal(third, second);
});

test('removeHookBlock удаляет блок и оставляет остальное', () => {
  const withBlock = upsertHookBlock('#!/bin/sh\necho hi\n', 'npm run review');
  const out = removeHookBlock(withBlock);
  assert.ok(out.includes('echo hi'));
  assert.ok(!out.includes(START));
  assert.ok(!out.includes(END));
  assert.ok(!out.includes('npm run review'));
});

test('removeHookBlock без блока возвращает строку как есть', () => {
  const src = '#!/bin/sh\necho hi\n';
  assert.equal(removeHookBlock(src), src);
});

// --- install / uninstall ---

test('installPreCommitHook без .git бросает понятную ошибку', () => {
  const dir = mkTemp();
  assert.throws(() => installPreCommitHook(dir, 'npm run review'), /\.git/);
});

test('install создаёт hook с маркером и командой; повторный install без дублей', () => {
  const dir = mkTemp();
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  const first = installPreCommitHook(dir, 'npm run review');
  assert.equal(first.created, true);
  assert.equal(first.path, path.join(dir, '.git', 'hooks', 'pre-commit'));
  let content = fs.readFileSync(first.path, 'utf8');
  assert.ok(content.includes(START));
  assert.ok(content.includes('npm run review'));

  const second = installPreCommitHook(dir, 'npm run review');
  assert.equal(second.created, false);
  content = fs.readFileSync(first.path, 'utf8');
  assert.equal(countOccurrences(content, START), 1);
  assert.equal(countOccurrences(content, END), 1);
});

test('install сохраняет существующий hook и обновляет команду', () => {
  const dir = mkTemp();
  fs.mkdirSync(path.join(dir, '.git', 'hooks'), { recursive: true });
  const hookPath = path.join(dir, '.git', 'hooks', 'pre-commit');
  fs.writeFileSync(hookPath, '#!/bin/sh\necho existing\n', 'utf8');
  installPreCommitHook(dir, 'npm run v1');
  installPreCommitHook(dir, 'npm run v2');
  const content = fs.readFileSync(hookPath, 'utf8');
  assert.ok(content.includes('echo existing'));
  assert.ok(content.includes('npm run v2'));
  assert.ok(!content.includes('npm run v1'));
  assert.equal(countOccurrences(content, START), 1);
});

test('uninstall удаляет файл свежей установки и сообщает корректно', () => {
  const dir = mkTemp();
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  installPreCommitHook(dir, 'npm run review');
  assert.equal(uninstallPreCommitHook(dir), true);
  assert.equal(fs.existsSync(path.join(dir, '.git', 'hooks', 'pre-commit')), false);
  assert.equal(uninstallPreCommitHook(dir), false);
});

test('uninstall сохраняет остальное содержимое hook', () => {
  const dir = mkTemp();
  fs.mkdirSync(path.join(dir, '.git', 'hooks'), { recursive: true });
  const hookPath = path.join(dir, '.git', 'hooks', 'pre-commit');
  fs.writeFileSync(hookPath, '#!/bin/sh\necho existing\n', 'utf8');
  installPreCommitHook(dir, 'npm run review');
  assert.equal(uninstallPreCommitHook(dir), true);
  assert.equal(fs.existsSync(hookPath), true);
  const content = fs.readFileSync(hookPath, 'utf8');
  assert.ok(content.includes('echo existing'));
  assert.ok(!content.includes(START));
});

test('uninstall без блока возвращает false', () => {
  const dir = mkTemp();
  fs.mkdirSync(path.join(dir, '.git', 'hooks'), { recursive: true });
  const hookPath = path.join(dir, '.git', 'hooks', 'pre-commit');
  fs.writeFileSync(hookPath, '#!/bin/sh\necho hi\n', 'utf8');
  assert.equal(uninstallPreCommitHook(dir), false);
  assert.ok(fs.readFileSync(hookPath, 'utf8').includes('echo hi'));
});

test('upsertHookBlock сохраняет CRLF в существующем hook', () => {
  const existing = '#!/bin/sh\r\necho user-hook\r\n';
  const next = upsertHookBlock(existing, 'npx consilium review');
  assert.ok(next.includes('\r\n# >>> consilium >>>'));
  assert.ok(!/(?<!\r)\n# >>> consilium >>>/.test(next));
  const removed = removeHookBlock(next);
  assert.ok(!removed.includes('# >>> consilium >>>'));
  assert.ok(removed.includes('echo user-hook'));
});

test('upsertHookBlock схлопывает дубли блоков в один', () => {
  const twoBlocks = [
    '#!/bin/sh',
    START,
    'old-1',
    END,
    START,
    'old-2',
    END,
    ''
  ].join('\n');
  const next = upsertHookBlock(twoBlocks, 'new-command');
  assert.equal(countOccurrences(next, START), 1);
  assert.equal(countOccurrences(next, END), 1);
  assert.ok(next.includes('new-command'));
  assert.ok(!next.includes('old-1'));
});

test('upsertHookBlock вставляет блок перед exit/exec', () => {
  const existing = '#!/bin/sh\necho before\nexit 0\n';
  const next = upsertHookBlock(existing, 'npx consilium review');
  assert.ok(next.indexOf(START) < next.indexOf('exit 0'));
  assert.ok(next.indexOf('npx consilium review') < next.indexOf('exit 0'));
});

test('install отказывается трогать не-shell hook', () => {
  const dir = mkTemp();
  fs.mkdirSync(path.join(dir, '.git', 'hooks'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.git', 'hooks', 'pre-commit'),
    '#!/usr/bin/env python3\nprint("hi")\n',
    'utf8'
  );
  assert.throws(() => installPreCommitHook(dir, 'npx consilium'), /python3|shell/i);
});

test('install принимает #!/usr/bin/env bash', () => {
  const dir = mkTemp();
  fs.mkdirSync(path.join(dir, '.git', 'hooks'), { recursive: true });
  const hookPath = path.join(dir, '.git', 'hooks', 'pre-commit');
  fs.writeFileSync(hookPath, '#!/usr/bin/env bash\necho hi\n', 'utf8');

  assert.doesNotThrow(() => installPreCommitHook(dir, 'npx consilium'));
  const content = fs.readFileSync(hookPath, 'utf8');
  assert.ok(content.includes('echo hi'));
  assert.ok(content.includes('npx consilium'));
});

test('install принимает #!/usr/bin/env -S bash -e', () => {
  const dir = mkTemp();
  fs.mkdirSync(path.join(dir, '.git', 'hooks'), { recursive: true });
  const hookPath = path.join(dir, '.git', 'hooks', 'pre-commit');
  fs.writeFileSync(hookPath, '#!/usr/bin/env -S bash -e\necho hi\n', 'utf8');

  assert.doesNotThrow(() => installPreCommitHook(dir, 'npx consilium'));
  assert.ok(fs.readFileSync(hookPath, 'utf8').includes('npx consilium'));
});

test('install отклоняет #!/usr/bin/env -S python3', () => {
  const dir = mkTemp();
  fs.mkdirSync(path.join(dir, '.git', 'hooks'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.git', 'hooks', 'pre-commit'),
    '#!/usr/bin/env -S python3 -u\nprint("hi")\n',
    'utf8'
  );
  assert.throws(() => installPreCommitHook(dir, 'npx consilium'), /python3|shell/i);
});

test('resolveHooksDir понимает .git-файл (worktree)', () => {
  const dir = mkTemp();
  const gitDir = path.join(dir, 'actual-git-dir');
  fs.mkdirSync(gitDir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.git'), `gitdir: ${gitDir}\n`, 'utf8');
  assert.equal(resolveHooksDir(dir), path.join(gitDir, 'hooks'));
});

test('resolveHooksDir в реальном git worktree — общий hooks основного репозитория', t => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
  } catch {
    t.skip('git недоступен');
    return;
  }

  const root = mkTemp();
  const worktree = path.join(root, 'wt');
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
    fs.writeFileSync(path.join(root, 'a.txt'), 'a', 'utf8');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: root });
    execFileSync('git', ['worktree', 'add', '-q', worktree], { cwd: root });

    assert.equal(
      path.resolve(resolveHooksDir(worktree)),
      path.resolve(path.join(root, '.git', 'hooks'))
    );
  } finally {
    try {
      execFileSync('git', ['worktree', 'remove', '--force', worktree], {
        cwd: root,
        stdio: 'ignore'
      });
    } catch {
      // ignore cleanup
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// --- live watcher ---

test('createProjectWatcher срабатывает на изменение и закрывается через close()', async () => {
  const dir = mkTemp();
  let received = null;
  const w = createProjectWatcher({
    cwd: dir,
    debounceMs: 20,
    onTrigger: paths => {
      received = paths;
    }
  });
  try {
    fs.writeFileSync(path.join(dir, 'hello.txt'), 'hi');
    await waitFor(() => received !== null);
    assert.ok(received.some(p => p.includes('hello.txt')), `пути: ${received}`);
  } finally {
    w.close();
  }
});

test('createProjectWatcher: ошибка onTrigger логируется и не роняет вотчер', async () => {
  const dir = mkTemp();
  const errors = [];
  const origError = console.error;
  console.error = (...args) => {
    errors.push(args);
  };
  let calls = 0;
  const w = createProjectWatcher({
    cwd: dir,
    debounceMs: 20,
    onTrigger: () => {
      calls += 1;
      throw new Error('boom');
    }
  });
  try {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'x');
    await waitFor(() => errors.length > 0);
    assert.equal(calls, 1);
    assert.match(String(errors[0][0]), /boom/);
  } finally {
    console.error = origError;
    w.close();
  }
});

// --- commandWatch ---

test('commandWatch: правка во время прогона даёт один повтор после него', async (t) => {
  const dir = mkTemp();
  const previousCwd = process.cwd();
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});

  let releaseFirst;
  const firstGate = new Promise(resolve => {
    releaseFirst = resolve;
  });
  let calls = 0;
  t.mock.method(Consilium.prototype, 'run', async function () {
    calls += 1;
    if (calls === 1) await firstGate;
    return fakeRunResult();
  });

  const signals = spySignalHandlers();
  try {
    process.chdir(dir);
    writeWatchConfig(dir);

    const watchPromise = commandWatch({ task: 'review', silent: true });
    await waitFor(() => calls === 1);

    fs.writeFileSync(path.join(dir, 'during-run-1.txt'), 'x');
    await sleep(60);
    fs.writeFileSync(path.join(dir, 'during-run-2.txt'), 'x');
    await sleep(60);
    releaseFirst();

    await waitFor(() => calls >= 2, 3000);
    assert.equal(calls, 2, 'правки во время прогона должны дать ровно один повтор');

    signals.shutdown();
    await withTimeout(watchPromise, 2000, 'commandWatch не завершился');
  } finally {
    signals.shutdown();
    signals.restore();
    process.chdir(previousCwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('commandWatch: после прогона правки не глотаются паузой suppressUntil', async (t) => {
  const dir = mkTemp();
  const previousCwd = process.cwd();
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});

  let calls = 0;
  t.mock.method(Consilium.prototype, 'run', async () => {
    calls += 1;
    return fakeRunResult();
  });

  const signals = spySignalHandlers();
  try {
    process.chdir(dir);
    writeWatchConfig(dir);

    const watchPromise = commandWatch({ task: 'review', silent: true });
    await waitFor(() => calls === 1);
    // Первый прогон уже завершён (finally снял running); ждать старую 1-секундную
    // паузу не должны — иначе эта правка потеряется.
    await sleep(40);
    fs.writeFileSync(path.join(dir, 'after-run.txt'), 'x');

    await waitFor(() => calls >= 2, 900);
    assert.ok(calls >= 2, 'правка сразу после прогона должна запустить новый');

    signals.shutdown();
    await withTimeout(watchPromise, 2000, 'commandWatch не завершился');
  } finally {
    signals.shutdown();
    signals.restore();
    process.chdir(previousCwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('commandWatch: SIGINT во время первого прогона отменяет его', async (t) => {
  const dir = mkTemp();
  const previousCwd = process.cwd();
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});

  let calls = 0;
  let finishRun;
  let cancelled = false;
  t.mock.method(Consilium.prototype, 'run', async function () {
    calls += 1;
    return new Promise(resolve => {
      finishRun = () => resolve(fakeRunResult());
    });
  });
  t.mock.method(Consilium.prototype, 'cancel', function () {
    cancelled = true;
    finishRun?.();
  });

  const signals = spySignalHandlers();
  try {
    process.chdir(dir);
    writeWatchConfig(dir);

    const watchPromise = commandWatch({ task: 'review', silent: true });
    await waitFor(() => calls === 1);

    // Обработчики должны быть установлены ещё до первого прогона.
    assert.equal(signals.handlers.SIGINT.length, 1, 'SIGINT handler зарегистрирован заранее');
    assert.equal(signals.handlers.SIGTERM.length, 1, 'SIGTERM handler зарегистрирован заранее');

    signals.shutdown();
    await withTimeout(watchPromise, 2000, 'commandWatch не завершился после SIGINT');
    assert.equal(cancelled, true, 'активный прогон должен быть отменён');
  } finally {
    signals.shutdown();
    signals.restore();
    process.chdir(previousCwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('commandWatch передаёт --chair в RunOptions', async (t) => {
  const dir = mkTemp();
  const previousCwd = process.cwd();
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});

  let calls = 0;
  let runOptions;
  t.mock.method(Consilium.prototype, 'run', async function (_task, options) {
    calls += 1;
    runOptions = options;
    return fakeRunResult();
  });

  const signals = spySignalHandlers();
  try {
    process.chdir(dir);
    writeWatchConfig(dir);

    const watchPromise = commandWatch({ task: 'review', silent: true, chair: 'custom-chair' });
    await waitFor(() => calls === 1);
    assert.equal(runOptions?.chair, 'custom-chair');

    signals.shutdown();
    await withTimeout(watchPromise, 2000, 'commandWatch не завершился');
  } finally {
    signals.shutdown();
    signals.restore();
    process.chdir(previousCwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('commandWatch: --list-agents печатает состав и не запускает прогон', async (t) => {
  const dir = mkTemp();
  const previousCwd = process.cwd();
  const logs = [];
  t.mock.method(console, 'log', (...args) => {
    logs.push(args.join(' '));
  });
  t.mock.method(console, 'error', () => {});

  let calls = 0;
  t.mock.method(Consilium.prototype, 'run', async () => {
    calls += 1;
    return fakeRunResult();
  });

  try {
    process.chdir(dir);
    writeWatchConfig(dir);

    const code = await commandWatch({ task: 'review', silent: true, listAgents: true });
    assert.equal(code, 0);
    assert.equal(calls, 0);
    const output = logs.join('\n');
    assert.match(output, /Эксперты:/);
    assert.match(output, /arch/);
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
