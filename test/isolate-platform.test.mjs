/**
 * @fileoverview Платформенные проверки уборки изолированных worktree.
 *
 * Windows: пробелы и Unicode в пути проекта, файл, удерживаемый дочерним
 * процессом во время remove(), длинный путь внутри worktree.
 * macOS: корень проекта через симлинк, пробелы/Unicode, очистка после ошибки
 * и отмены. Linux: очистка после ошибки и отмены.
 *
 * Модели не вызываются: используется только fake opencode. Тесты пропускаются
 * на чужих платформах и в окружении без git.
 */

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
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { Consilium, mergeWithDefaults } from '../dist/application/consilium.js';
import { createIsolatedWorktree } from '../dist/infrastructure/opencode/isolate.js';
import { READ_ONLY_OVERLAY_RELATIVE_PATH } from '../dist/infrastructure/opencode/read-only.js';

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
const trackedPath = join(cwd, 'note.txt');
const capture = {
  args,
  cwd,
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

function detectGit() {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

const GIT_AVAILABLE = detectGit();

/**
 * Опции node:test для пропуска: чужая платформа или отсутствие git.
 * Возвращает пустой объект, если тест должен выполниться.
 */
function skipOptions(matchesPlatform, platformReason) {
  if (!GIT_AVAILABLE) return { skip: 'git не найден в PATH' };
  if (!matchesPlatform) return { skip: platformReason };
  return {};
}

function mkTemp(prefix = 'consilium-isolate-platform-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

function initRepo(dir) {
  execFileSync('git', ['init', '-q'], { cwd: dir, windowsHide: true });
  execFileSync('git', ['config', 'user.email', 'isolate@example.test'], {
    cwd: dir,
    windowsHide: true
  });
  execFileSync('git', ['config', 'user.name', 'Isolate Test'], {
    cwd: dir,
    windowsHide: true
  });
  execFileSync('git', ['config', 'core.autocrlf', 'false'], {
    cwd: dir,
    windowsHide: true
  });
  writeFileSync(join(dir, 'note.txt'), 'base\n', 'utf8');
  execFileSync('git', ['add', 'note.txt'], { cwd: dir, windowsHide: true });
  execFileSync('git', ['commit', '-qm', 'initial'], { cwd: dir, windowsHide: true });
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

function leftWorktreeDirs(dir) {
  const root = worktreesRoot(dir);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name);
}

function assertNoWorktrees(dir, label = '') {
  const left = leftWorktreeDirs(dir);
  assert.deepEqual(left, [], `${label} worktrees не удалены: ${left.join(', ')}`);
}

function gitWorktreeCount(dir) {
  const output = execFileSync('git', ['worktree', 'list', '--porcelain'], {
    cwd: dir,
    encoding: 'utf8',
    windowsHide: true
  });
  return (output.match(/^worktree /gm) ?? []).length;
}

function isInside(parent, child) {
  const rel = relative(parent, child);
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel);
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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

/**
 * Уборка временного каталога с повторами: на Windows антивирус и git могут
 * ненадолго удерживать handle после завершения дочерних процессов.
 */
async function removeTempDir(dir) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      return;
    } catch (error) {
      if (attempt === 2) {
        process.stderr.write(
          `[isolate-platform] не удалось удалить временный каталог ${dir}: ` +
            `${error instanceof Error ? error.message : String(error)}\n`
        );
        return;
      }
      await delay(100 * (attempt + 1));
    }
  }
}

/**
 * Документированное восстановление после занятого каталога: после снятия
 * блокировки повторяем git worktree remove --force + prune и, если git не
 * справился (частично удалённый worktree), добиваем rmSync. Ограниченное
 * ожидание вместо фиксированной паузы.
 */
async function forceRemoveWorktree(root, path, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      execFileSync('git', ['worktree', 'unlock', path], {
        cwd: root,
        stdio: 'ignore',
        windowsHide: true
      });
    } catch {
      // Уже разблокирован или registration удалена — не критично.
    }
    try {
      execFileSync('git', ['worktree', 'remove', '--force', path], {
        cwd: root,
        stdio: 'ignore',
        windowsHide: true
      });
    } catch {
      try {
        rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch {
        // Повторим попытку до deadline: handle мог ещё не освободиться.
      }
    }
    try {
      execFileSync('git', ['worktree', 'prune'], {
        cwd: root,
        stdio: 'ignore',
        windowsHide: true
      });
    } catch {
      // Prune повторится на следующей итерации или не нужен.
    }
    if (!existsSync(path) && gitWorktreeCount(root) === 1) return true;
    if (Date.now() >= deadline) return false;
    await delay(100);
  }
}

/**
 * Дочерний процесс с эксклюзивным handle на файл (FileShare.None).
 * Обычный node:fs открывает файлы с FILE_SHARE_DELETE, поэтому для
 * воспроизведения Windows-блокировки нужен .NET через PowerShell.
 */
function startExclusiveFileHolder(file) {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '$handle = [System.IO.File]::Open(' +
      '$env:CONSILIUM_HELD_FILE, ' +
      '[System.IO.FileMode]::Open, ' +
      '[System.IO.FileAccess]::ReadWrite, ' +
      '[System.IO.FileShare]::None)',
    '[Console]::Out.WriteLine("ready")',
    '[Console]::Out.Flush()',
    '$null = [Console]::In.ReadLine()',
    '$handle.Dispose()'
  ].join('\n');
  return spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, CONSILIUM_HELD_FILE: file },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  });
}

/** Ждёт строку готовности; таймаут — только страховка, не проверка. */
function waitForLine(child, expected, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const finish = (error) => {
      clearTimeout(timer);
      child.stdout?.off('data', onData);
      child.off('exit', onExit);
      child.off('error', onError);
      if (error === undefined) resolve();
      else reject(error);
    };
    const onData = (chunk) => {
      buffer += chunk.toString('utf8');
      if (buffer.includes(expected)) finish(undefined);
    };
    const onExit = (code, signal) => {
      finish(new Error(`holder завершился раньше: ${code ?? signal}`));
    };
    const onError = (error) => {
      finish(error);
    };
    const timer = setTimeout(
      () => finish(new Error(`holder не прислал "${expected}" за ${timeoutMs} мс`)),
      timeoutMs
    );
    child.stdout?.on('data', onData);
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

/** Общие проверки после запуска с isolate: пусто в worktrees и в git. */
function assertCleanIsolate(dir, captureDir, expectedWorktreesRoot, label) {
  const captures = readRunCaptures(captureDir);
  assert.ok(captures.length >= 1, `${label}: не было ни одного запуска агента`);
  for (const capture of captures) {
    assert.ok(
      isInside(expectedWorktreesRoot, capture.cwd),
      `${label}: cwd вне реального корня .consilium/worktrees: ${capture.cwd}`
    );
    assert.equal(existsSync(capture.cwd), false, `${label}: worktree не удалён: ${capture.cwd}`);
  }
  assert.equal(
    existsSync(join(dir, '.opencode', 'opencode.json')),
    false,
    `${label}: в основном проекте остался временный read-only слой`
  );
  assert.equal(
    existsSync(join(dir, '.consilium', 'read-only.lock')),
    false,
    `${label}: остался read-only.lock`
  );
  assertNoWorktrees(dir, `${label}:`);
  assert.equal(gitWorktreeCount(dir), 1, `${label}: в git остался лишний worktree`);
}

test(
  'win32: проект с пробелами и Unicode — isolate создаёт и убирает worktree',
  skipOptions(process.platform === 'win32', 'только Windows'),
  async () => {
    const dir = initRepo(mkTemp('consilium пробел юникод '));
    const captureDir = join(dir, 'captures');
    mkdirSync(captureDir, { recursive: true });
    const restoreCapture = useCaptureDir(captureDir);
    try {
      const config = makeConfig(dir, createFakeOpenCode(dir), { isolate: true });
      const result = await new Consilium(config).run('проверь задачу');

      assert.equal(result.success, true);
      assert.deepEqual(result.metadata?.safety, { readOnly: false, isolate: true });

      const captures = readRunCaptures(captureDir);
      assert.equal(captures.length, 3, 'два эксперта и председатель');
      assert.equal(new Set(captures.map(capture => capture.cwd)).size, 3);
      for (const capture of captures) {
        assert.equal(capture.marker, true, 'worktree существовал во время вызова');
        assert.ok(
          isInside(worktreesRoot(dir), capture.cwd),
          `cwd не внутри .consilium/worktrees: ${capture.cwd}`
        );
        assert.equal(existsSync(capture.cwd), false, 'worktree удалён после запуска');
      }

      assert.equal(existsSync(join(dir, '.opencode', 'opencode.json')), false);
      assertNoWorktrees(dir);
      assert.equal(gitWorktreeCount(dir), 1);
    } finally {
      restoreCapture();
      await removeTempDir(dir);
    }
  }
);

test(
  'win32: занятый дочерним процессом файл — remove() не бросает, уборка завершается после снятия блокировки',
  skipOptions(process.platform === 'win32', 'только Windows'),
  async (t) => {
    const dir = initRepo(mkTemp('consilium busy пробел '));
    const logs = [];
    let worktree;
    let holder;
    try {
      worktree = createIsolatedWorktree({
        cwd: dir,
        label: 'busy',
        onLog: (level, message) => logs.push({ level, message })
      });
      const heldFile = join(worktree.path, 'held.txt');
      writeFileSync(heldFile, 'held\n', 'utf8');

      holder = startExclusiveFileHolder(heldFile);
      try {
        await waitForLine(holder, 'ready');
      } catch (error) {
        if (error && error.code === 'ENOENT') {
          t.skip('powershell.exe недоступен для эксклюзивного handle');
          return;
        }
        throw error;
      }

      assert.doesNotThrow(
        () => worktree.remove(),
        'remove() не должен бросать при занятом файле'
      );

      const leftAfterRemove = existsSync(worktree.path);
      const warned = logs.some(
        entry =>
          entry.level === 'warn' &&
          entry.message.includes('Не удалось удалить изолированный worktree')
      );
      // Эксклюзивный handle не даёт удалить каталог: remove() обязан
      // сообщить предупреждение и оставить восстановимое состояние.
      assert.equal(leftAfterRemove, true, 'каталог с занятым файлом не может быть удалён');
      assert.equal(warned, true, 'фолбэк rmSync должен попасть в onLog как warn');

      const exited = new Promise(resolve => holder.once('exit', resolve));
      holder.stdin.end();
      holder = undefined;
      await exited;

      assert.equal(
        await forceRemoveWorktree(dir, worktree.path),
        true,
        'после снятия блокировки каталог должен удалиться'
      );
      assertNoWorktrees(dir);
      assert.equal(gitWorktreeCount(dir), 1, 'в git остался только основной worktree');
    } finally {
      if (
        holder !== undefined &&
        holder.pid !== undefined &&
        holder.exitCode === null &&
        holder.signalCode === null
      ) {
        const exited = new Promise(resolve => holder.once('exit', resolve));
        holder.kill();
        await exited;
      }
      await removeTempDir(dir);
    }
  }
);

test(
  'win32: длинный путь внутри worktree удаляется (git-фолбэк или rmSync)',
  skipOptions(process.platform === 'win32', 'только Windows'),
  async (t) => {
    const dir = initRepo(mkTemp('consilium long path '));
    let worktree;
    try {
      worktree = createIsolatedWorktree({ cwd: dir, label: 'long' });
      let deep = worktree.path;
      try {
        let index = 0;
        while (deep.length < 320) {
          deep = join(deep, `segment-${String(index).padStart(3, '0')}-padding`);
          mkdirSync(deep);
          index += 1;
        }
        writeFileSync(join(deep, 'leaf.txt'), 'leaf\n', 'utf8');
      } catch (error) {
        t.skip(
          `длинные пути недоступны на этой ФС: ` +
            `${error instanceof Error && 'code' in error ? String(error.code) : String(error)}`
        );
        return;
      }

      assert.ok(deep.length > 260, `путь должен превышать MAX_PATH: ${deep.length}`);
      worktree.remove();
      assert.equal(existsSync(worktree.path), false, `worktree не удалён: ${worktree.path}`);
      assertNoWorktrees(dir);
      assert.equal(gitWorktreeCount(dir), 1);
    } finally {
      await removeTempDir(dir);
    }
  }
);

test(
  'darwin: корень через симлинк, пробелы/Unicode — ошибка и отмена очищают worktree',
  skipOptions(process.platform === 'darwin', 'только macOS'),
  async () => {
    const realDir = initRepo(mkTemp('consilium реальный пробел '));
    const linkParent = mkTemp('consilium ссылка ');
    const linkDir = join(linkParent, 'проект link');
    symlinkSync(realDir, linkDir, 'dir');

    const opencodePath = createFakeOpenCode(realDir);
    const realRoot = realpathSync(realDir);
    const expectedWorktreesRoot = join(realRoot, '.consilium', 'worktrees');

    try {
      assert.equal(realpathSync(linkDir), realRoot, 'симлинк должен вести в проект');

      // 1. Ошибка агента (exit code 1) с isolate + read-only.
      const errorCaptures = join(realDir, 'captures-error');
      mkdirSync(errorCaptures, { recursive: true });
      const restoreErrorCapture = useCaptureDir(errorCaptures);
      const restoreExit = useEnv('FAKE_EXIT_CODE', '1');
      try {
        const config = makeConfig(linkDir, opencodePath, { isolate: true, readOnly: true });
        const result = await new Consilium(config).run('проверь задачу');
        assert.equal(result.success, false);
        assertCleanIsolate(realDir, errorCaptures, expectedWorktreesRoot, 'ошибка');
      } finally {
        restoreExit();
        restoreErrorCapture();
      }

      // 2. Отмена во время работы агентов.
      const cancelCaptures = join(realDir, 'captures-cancel');
      mkdirSync(cancelCaptures, { recursive: true });
      const restoreCancelCapture = useCaptureDir(cancelCaptures);
      const restoreHang = useEnv('FAKE_HANG', '1');
      try {
        const config = makeConfig(linkDir, opencodePath, { isolate: true, readOnly: true });
        const consilium = new Consilium(config);
        const runPromise = consilium.run('ALL_SLOW проверь задачу');

        await waitForCaptures(cancelCaptures, 2, 15000);
        for (const capture of readRunCaptures(cancelCaptures)) {
          assert.equal(existsSync(capture.cwd), true, 'worktree существует во время работы');
          assert.ok(
            isInside(expectedWorktreesRoot, capture.cwd),
            `cwd вне реального корня: ${capture.cwd}`
          );
        }

        consilium.cancel();
        const result = await runPromise;
        assert.equal(result.success, false);
        assert.equal(result.metadata?.cancelled, true);
        assertCleanIsolate(realDir, cancelCaptures, expectedWorktreesRoot, 'отмена');
      } finally {
        restoreHang();
        restoreCancelCapture();
      }

      assert.equal(realpathSync(linkDir), realRoot, 'симлинк не должен быть затронут');
      assert.equal(existsSync(join(linkDir, 'note.txt')), true);
    } finally {
      await removeTempDir(linkParent);
      await removeTempDir(realDir);
    }
  }
);

test(
  'linux: ошибка и отмена очищают worktree и read-only слой',
  skipOptions(process.platform === 'linux', 'только Linux'),
  async () => {
    const dir = initRepo(mkTemp('consilium linux тест '));
    const opencodePath = createFakeOpenCode(dir);
    const realDir = realpathSync(dir);
    const expectedWorktreesRoot = join(realDir, '.consilium', 'worktrees');

    try {
      // 1. Ошибка агента.
      const errorCaptures = join(dir, 'captures-error');
      mkdirSync(errorCaptures, { recursive: true });
      const restoreErrorCapture = useCaptureDir(errorCaptures);
      const restoreExit = useEnv('FAKE_EXIT_CODE', '1');
      try {
        const config = makeConfig(dir, opencodePath, { isolate: true, readOnly: true });
        const result = await new Consilium(config).run('проверь задачу');
        assert.equal(result.success, false);
        assertCleanIsolate(dir, errorCaptures, expectedWorktreesRoot, 'ошибка');
      } finally {
        restoreExit();
        restoreErrorCapture();
      }

      // 2. Отмена.
      const cancelCaptures = join(dir, 'captures-cancel');
      mkdirSync(cancelCaptures, { recursive: true });
      const restoreCancelCapture = useCaptureDir(cancelCaptures);
      const restoreHang = useEnv('FAKE_HANG', '1');
      try {
        const config = makeConfig(dir, opencodePath, { isolate: true, readOnly: true });
        const consilium = new Consilium(config);
        const runPromise = consilium.run('ALL_SLOW проверь задачу');

        await waitForCaptures(cancelCaptures, 2, 15000);
        consilium.cancel();
        const result = await runPromise;
        assert.equal(result.success, false);
        assert.equal(result.metadata?.cancelled, true);
        assertCleanIsolate(dir, cancelCaptures, expectedWorktreesRoot, 'отмена');
      } finally {
        restoreHang();
        restoreCancelCapture();
      }

      assert.equal(existsSync(join(dir, 'note.txt')), true);
      assert.equal(READ_ONLY_OVERLAY_RELATIVE_PATH, '.opencode/opencode.json');
    } finally {
      await removeTempDir(dir);
    }
  }
);
