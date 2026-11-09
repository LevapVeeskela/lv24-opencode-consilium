import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../dist/cli.js';
import { saveArtifact } from '../dist/artifacts.js';
import {
  buildAgentSession,
  buildChairSession
} from '../dist/domain/council/sessions.js';
import { parseArgs } from '../dist/interfaces/cli/args.js';
import {
  MAX_TIMEOUT_MS,
  isRetryable,
  sanitizeTimeout
} from '../dist/infrastructure/opencode/retry.js';
import { executeOpenCode } from '../dist/infrastructure/opencode/spawn.js';
import { buildConfiguredFallbackChain } from '../dist/infrastructure/opencode/calls.js';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

test('таймаут оставляет SIGKILL-таймер: потомок, игнорирующий SIGTERM, добивается', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'consilium-kill-timer-'));
  const pidFile = join(dir, 'child.pid');
  const previousPidFile = process.env.CONSILIUM_TEST_PID_FILE;
  process.env.CONSILIUM_TEST_PID_FILE = pidFile;
  let pid;
  try {
    // Дочерний node-процесс игнорирует SIGTERM. Если settle снимает таймер
    // эскалации, он переживёт таймаут и останется висеть после запуска совета.
    const script = [
      "const fs = require('node:fs');",
      "process.on('SIGTERM', () => {});",
      'fs.writeFileSync(process.env.CONSILIUM_TEST_PID_FILE, String(process.pid));',
      'setInterval(() => {}, 1000);'
    ].join('\n');

    const outcome = await executeOpenCode({
      opencodePath: process.execPath,
      args: ['-e', script],
      cwd: dir,
      timeoutMs: 1000
    });

    assert.equal(outcome.timedOut, true);
    assert.ok(existsSync(pidFile), 'дочерний процесс должен записать pid');
    pid = Number(readFileSync(pidFile, 'utf8'));
    assert.ok(Number.isInteger(pid) && pid > 0);

    // На Windows taskkill /F убивает сразу; на POSIX SIGKILL приходит через 2 с.
    const deadline = Date.now() + 3500;
    while (Date.now() < deadline && isProcessAlive(pid)) {
      await sleep(100);
    }
    assert.equal(
      isProcessAlive(pid),
      false,
      'процесс, игнорирующий SIGTERM, должен получить SIGKILL после таймаута'
    );
  } finally {
    if (pid !== undefined && isProcessAlive(pid)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Процесс уже завершился
      }
    }
    if (previousPidFile === undefined) delete process.env.CONSILIUM_TEST_PID_FILE;
    else process.env.CONSILIUM_TEST_PID_FILE = previousPidFile;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('RATE_LIMITED без retryAfterMs повторяется с настроенной задержкой', () => {
  // По умолчанию берётся DEFAULT_RETRY_DELAY.
  assert.equal(isRetryable('RATE_LIMITED'), true);
  assert.equal(isRetryable('RATE_LIMITED', undefined, 2500), true);
  // Нулевая/отрицательная задержка провайдера означает «точного значения нет».
  assert.equal(isRetryable('RATE_LIMITED', 0, 2500), true);
  assert.equal(isRetryable('RATE_LIMITED', -1, 2500), true);
  // Длинный явный лимит по-прежнему не ждём.
  assert.equal(isRetryable('RATE_LIMITED', 30_001), false);
  assert.equal(isRetryable('RATE_LIMITED', undefined, 60_000), false);
  assert.equal(isRetryable('MODEL_UNAVAILABLE'), false);
  assert.equal(isRetryable('CANCELLED'), false);
});

test('sanitizeTimeout зажимает значения выше предела setTimeout', () => {
  assert.equal(MAX_TIMEOUT_MS, 2_147_483_647);
  assert.equal(sanitizeTimeout(MAX_TIMEOUT_MS + 1, 500), MAX_TIMEOUT_MS);
  assert.equal(sanitizeTimeout(Number.MAX_SAFE_INTEGER, 500), MAX_TIMEOUT_MS);
  assert.equal(sanitizeTimeout(500, Number.MAX_SAFE_INTEGER), 500);
  assert.equal(sanitizeTimeout(1500.5, 500), 1501);
});

test('сессии требуют префикс ses_, а не любое начало ses', () => {
  assert.equal(buildAgentSession('session-42', 'arch'), 'ses_session-42-arch');
  assert.equal(buildAgentSession('ses', 'arch'), 'ses_ses-arch');
  assert.equal(buildAgentSession('ses_abc', 'arch'), 'ses_abc-arch');

  assert.equal(buildChairSession('session-42'), 'ses_session-42');
  assert.equal(buildChairSession('ses'), 'ses_ses');
  assert.equal(buildChairSession('ses_abc'), 'ses_abc');
  assert.match(buildChairSession('ses_'), /^ses_/);
});

test('командное слово не распознаётся внутри задачи', () => {
  // Ровно исходный баг: задача, начинающаяся со слова-команды.
  const firstWord = parseArgs(['models', 'should', 'be', 'cached']);
  assert.equal(firstWord.command, undefined);
  assert.equal(firstWord.task, 'models should be cached');

  const prefixed = parseArgs(['consilium', 'models', 'should', 'be', 'cached']);
  assert.equal(prefixed.command, undefined);
  assert.equal(prefixed.task, 'consilium models should be cached');

  // Флаги до команды/задачи продолжают разбираться как раньше.
  const flagsFirst = parseArgs(['--silent', 'models', 'should', 'be', 'cached']);
  assert.equal(flagsFirst.command, undefined);
  assert.equal(flagsFirst.silent, true);
  assert.equal(flagsFirst.task, 'models should be cached');
  assert.equal(parseArgs(['--silent', 'models']).command, 'models');

  // Настоящая команда перед своими флагами продолжает работать.
  assert.equal(parseArgs(['models', '--available']).command, 'models');
  assert.equal(parseArgs(['init', '--free']).command, 'init');
  assert.equal(parseArgs(['watch', '--debounce', '100', 'ревью']).command, 'watch');
  assert.equal(parseArgs(['hooks', 'install']).hookAction, 'install');

  // Слово-команда внутри текста задачи не перехватывает управление.
  const inside = parseArgs(['проверь', 'models', 'should', 'be', 'cached']);
  assert.equal(inside.command, undefined);
  assert.equal(inside.task, 'проверь models should be cached');

  // После -- команда — часть задачи.
  const afterTerminator = parseArgs(['--', 'models', 'should', 'be', 'cached']);
  assert.equal(afterTerminator.command, undefined);
  assert.equal(afterTerminator.task, 'models should be cached');
});

test('--no-artifacts не меняет корень чтения --diff-runs', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'consilium-replay-root-'));
  const configPath = join(dir, 'consilium.json');
  const runsDir = join(dir, 'custom-runs');
  const logged = [];
  t.mock.method(console, 'log', (...args) => {
    logged.push(args.join(' '));
  });
  t.mock.method(console, 'error', () => {});

  try {
    writeFileSync(
      configPath,
      JSON.stringify({
        cwd: dir,
        artifacts: 'custom-runs',
        experts: [{ name: 'arch' }],
        chair: { agent: 'consilium' }
      }),
      'utf8'
    );

    const makeRun = (id, text) => ({
      version: 1,
      id,
      createdAt: '2026-01-01T00:00:00.000Z',
      task: 'Задача',
      success: true,
      text,
      experts: [{ agent: 'arch', model: 'p/a', success: true, text }],
      models: { arch: 'p/a' }
    });
    const leftId = '20260101-000000-aaaa';
    const rightId = '20260101-000001-bbbb';
    saveArtifact(makeRun(leftId, 'первый ответ'), { root: runsDir });
    saveArtifact(makeRun(rightId, 'второй ответ'), { root: runsDir });

    const code = await main([
      '-c',
      configPath,
      '--no-artifacts',
      '--diff-runs',
      leftId,
      rightId
    ]);

    assert.equal(code, 0);
    assert.ok(logged.join('\n').includes(`Сравнение запусков: ${leftId}`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fallback-цепочка использует весь настроенный список с разумным пределом', () => {
  const pool = ['a/1', 'b/2', 'c/3', 'd/4'];
  assert.deepEqual(buildConfiguredFallbackChain(undefined, pool), pool);
  assert.deepEqual(buildConfiguredFallbackChain('a/1', pool), ['b/2', 'c/3', 'd/4']);

  const many = Array.from({ length: 12 }, (_, index) => `provider/model-${index}`);
  assert.equal(buildConfiguredFallbackChain(undefined, many).length, 10);
});
