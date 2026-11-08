import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFallbackChain,
  createCostTracker,
  formatCostReport,
  shouldFallback
} from '../dist/fallback.js';

test('трекер накапливает расходы и раскладку по агентам', () => {
  const tracker = createCostTracker();
  tracker.add('arch', { cost: 0.1 });
  const report = tracker.add('sec', { cost: 0.05 });
  assert.equal(report.spent, 0.15);
  assert.deepEqual(report.byAgent, { arch: 0.1, sec: 0.05 });
  assert.equal(report.exceeded, false);
  assert.equal(tracker.exceeded(), false);
});

test('add игнорирует undefined usage и невалидный cost', () => {
  const tracker = createCostTracker();
  tracker.add('arch');
  tracker.add('arch', {});
  tracker.add('arch', { cost: NaN });
  tracker.add('arch', { cost: Infinity });
  tracker.add('arch', { cost: -1 });
  const report = tracker.report();
  assert.equal(report.spent, 0);
  assert.deepEqual(report.byAgent, {});
});

test('exceeded только при строгом превышении лимита', () => {
  const tracker = createCostTracker(0.1);
  tracker.add('arch', { cost: 0.1 });
  assert.equal(tracker.exceeded(), false);
  assert.equal(tracker.report().exceeded, false);
  tracker.add('arch', { cost: 0.0001 });
  assert.equal(tracker.exceeded(), true);
  assert.equal(tracker.report().exceeded, true);
});

test('невалидный лимит игнорируется', () => {
  for (const bad of [NaN, Infinity, -1, -0.5]) {
    const tracker = createCostTracker(bad);
    tracker.add('arch', { cost: 1000 });
    assert.equal(tracker.exceeded(), false);
    assert.ok(!('limit' in tracker.report()));
  }
  const noLimit = createCostTracker();
  noLimit.add('arch', { cost: 5 });
  assert.ok(!('limit' in noLimit.report()));
});

test('report возвращает копию', () => {
  const tracker = createCostTracker(1);
  tracker.add('arch', { cost: 0.2 });
  const first = tracker.report();
  first.byAgent.arch = 999;
  first.spent = 999;
  const second = tracker.report();
  assert.equal(second.spent, 0.2);
  assert.equal(second.byAgent.arch, 0.2);
});

test('shouldFallback: матрица кодов', () => {
  for (const code of ['RATE_LIMITED', 'MODEL_UNAVAILABLE', 'EMPTY_RESPONSE']) {
    assert.equal(shouldFallback(code), true);
  }
  for (const code of [
    'CANCELLED',
    'PARSE_ERROR',
    'AGENT_NOT_FOUND',
    'TIMEOUT',
    'SPAWN_ERROR',
    'EXIT_ERROR',
    undefined
  ]) {
    assert.equal(shouldFallback(code), false);
  }
});

test('цепочка: дедупликация, исключение primary, trim', () => {
  const chain = buildFallbackChain('openai/gpt', [
    ' openai/gpt ',
    'anthropic/claude',
    'anthropic/claude',
    'deepseek/chat'
  ]);
  assert.deepEqual(chain, ['anthropic/claude', 'deepseek/chat']);
});

test('цепочка: cap max и границы', () => {
  const pool = ['a/1', 'b/2', 'c/3', 'd/4'];
  assert.deepEqual(buildFallbackChain(undefined, pool), ['a/1', 'b/2']);
  assert.deepEqual(buildFallbackChain(undefined, pool, { max: 1 }), ['a/1']);
  assert.deepEqual(
    buildFallbackChain(undefined, pool, { max: 100 }).length <= 10,
    true
  );
  assert.deepEqual(buildFallbackChain(undefined, pool, { max: 0 }), ['a/1']);
});

test('цепочка: невалидные id отбрасываются', () => {
  const chain = buildFallbackChain(undefined, [
    '',
    '   ',
    'noslash',
    '/leading',
    'a/1',
    'bad id/x',
    'b/2'
  ]);
  assert.deepEqual(chain, ['a/1', 'b/2']);
});

test('цепочка: не мутирует входной pool', () => {
  const pool = ['b/2', 'a/1', 'b/2'];
  const before = [...pool];
  buildFallbackChain('a/1', pool, { max: 5 });
  assert.deepEqual(pool, before);
});

test('формат: нулевые расходы и маркеры', () => {
  const empty = formatCostReport(createCostTracker().report());
  assert.ok(empty.includes('$0.0000'));
  assert.ok(empty.includes('Расходы отсутствуют'));

  const tracker = createCostTracker(0.1);
  tracker.add('arch', { cost: 0.2 });
  tracker.add('sec', { cost: 0.05 });
  const text = formatCostReport(tracker.report());
  assert.ok(text.includes('$0.2500'));
  assert.ok(text.includes('превышен'));
  assert.ok(text.includes('Лимит'));
  // сортировка по убыванию: arch выше sec
  assert.ok(text.indexOf('arch') < text.indexOf('sec'));

  const okTracker = createCostTracker(10);
  okTracker.add('arch', { cost: 0.5 });
  const okText = formatCostReport(okTracker.report());
  assert.ok(!okText.includes('превышен'));
  assert.ok(okText.includes('Лимит'));
});
