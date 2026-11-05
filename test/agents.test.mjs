import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRunArgs,
  parseJsonOutput,
  sanitizeTimeout,
  createRunController
} from '../dist/agents.js';

test('buildRunArgs по умолчанию использует standalone и json', () => {
  assert.deepEqual(buildRunArgs({}), ['run', '--standalone', '--format', 'json']);
});

test('buildRunArgs добавляет auto, agent и model', () => {
  const args = buildRunArgs({
    agent: 'arch',
    model: 'opencode/glm-5.3-flash-free',
    config: { standalone: false, autoApprove: true }
  });
  assert.deepEqual(args, [
    'run',
    '--format',
    'json',
    '--auto',
    '--agent=arch',
    '--model=opencode/glm-5.3-flash-free'
  ]);
});

test('buildRunArgs отбрасывает невалидные agent/model', () => {
  const args = buildRunArgs({ agent: 'bad agent!', model: 'bad model' });
  assert.deepEqual(args, ['run', '--standalone', '--format', 'json']);
});

test('buildRunArgs не пропускает значения, похожие на флаги', () => {
  const args = buildRunArgs({ agent: '--auto', model: '--dangerously-skip-permissions' });
  assert.deepEqual(args, ['run', '--standalone', '--format', 'json']);
});

test('в аргументах никогда нет промпта', () => {
  const args = buildRunArgs({ agent: 'sec' });
  assert.ok(!args.some(arg => arg.includes('секретный промпт')));
});

test('sanitizeTimeout отбрасывает NaN, отрицательные и ноль', () => {
  assert.equal(sanitizeTimeout(Number.NaN, 500), 500);
  assert.equal(sanitizeTimeout(-5, 500), 500);
  assert.equal(sanitizeTimeout(0, 500), 500);
  assert.equal(sanitizeTimeout(1000, 500), 1000);
  assert.equal(sanitizeTimeout(1500.5, 500), 1501);
});

test('parseJsonOutput извлекает текст', () => {
  assert.equal(
    parseJsonOutput('{"type":"text","part":{"text":"ok"}}\n{"type":"error","error":{"message":"x"}}'),
    'ok'
  );
});

test('RunController изолирован и сбрасывается', () => {
  const first = createRunController();
  const second = createRunController();
  assert.equal(first.isCancelled(), false);
  first.cancel();
  assert.equal(first.isCancelled(), true);
  assert.equal(second.isCancelled(), false);
  first.reset();
  assert.equal(first.isCancelled(), false);
});
