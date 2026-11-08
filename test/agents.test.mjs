import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAgentSession,
  buildChairSession,
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

test('buildRunArgs добавляет сессию и отбрасывает невалидную', () => {
  assert.deepEqual(buildRunArgs({ session: 'council-1' }), [
    'run',
    '--standalone',
    '--format',
    'json',
    '--session=council-1'
  ]);
  assert.deepEqual(buildRunArgs({ session: '--bad' }), [
    'run',
    '--standalone',
    '--format',
    'json'
  ]);
});

test('buildAgentSession даёт каждому агенту отдельную сессию', () => {
  assert.equal(buildAgentSession('council', 'arch'), 'ses_council-arch');
  assert.equal(buildAgentSession('ses_council', 'sec'), 'ses_council-sec');
  assert.equal(buildAgentSession('council/1', 'sec'), 'ses_council-1-sec');
  assert.equal(buildAgentSession(undefined, 'arch'), undefined);
  assert.equal(buildAgentSession('   ', 'arch'), undefined);
  assert.equal(buildAgentSession('council', ''), 'ses_council-default');
});

test('buildAgentSession сохраняет реальный id и суффикс при длинной базе', () => {
  assert.equal(
    buildAgentSession('ses_e46f6d52:AqTXO', 'arch'),
    'ses_e46f6d52:AqTXO-arch'
  );

  const longBase = `ses_${'x'.repeat(200)}`;
  const first = buildAgentSession(longBase, 'arch');
  const second = buildAgentSession(longBase, 'sec');
  assert.ok(first !== undefined && second !== undefined);
  assert.ok(first.endsWith('-arch'));
  assert.ok(second.endsWith('-sec'));
  assert.ok(first.length <= 128);
});

test('buildChairSession продолжает сессию как есть', () => {
  assert.equal(buildChairSession('ses_e46f6d52:AqTXO'), 'ses_e46f6d52:AqTXO');
  assert.equal(buildChairSession('council'), 'ses_council');
  assert.equal(buildChairSession('  '), undefined);
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
