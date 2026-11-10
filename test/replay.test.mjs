import test from 'node:test';
import assert from 'node:assert/strict';
import { planReplay } from '../dist/replay.js';
import { applyReplayPlan } from '../dist/application/replay.js';
import { mergeWithDefaults } from '../dist/config.js';

function makeRun(overrides = {}) {
  return {
    version: 1,
    id: 'test-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    task: 'Explain X',
    success: true,
    text: 'final',
    experts: [
      { agent: 'arch', model: 'a/model1', success: true, text: 't1' },
      { agent: 'sec', model: 's/model2', success: true, text: 't2' }
    ],
    models: { arch: 'a/model1', sec: 's/model2', consilium: 'c/model3' },
    metadata: {
      consensus: { winner: 'arch' },
      smartExperts: { order: ['arch', 'sec'] },
      fallbackModels: ['f/m1', 'f/m2'],
      session: 'ses_123'
    },
    ...overrides
  };
}

test('applyReplayPlan переносит план в конфигурацию (общая семантика CLI и MCP)', () => {
  const config = mergeWithDefaults({
    experts: [{ name: 'arch' }, { name: 'ux' }],
    chair: { agent: 'general' }
  });
  const applied = applyReplayPlan(
    config,
    makeRun({ chairAgent: 'consilium' }),
    { chairAgent: config.chair.agent }
  );

  assert.deepEqual(config.experts.map(expert => expert.name), ['arch', 'sec']);
  assert.equal(config.experts[0].model, 'a/model1');
  assert.equal(config.experts[1].model, 's/model2');
  assert.equal(config.chair.agent, 'consilium');
  assert.equal(config.chair.model, 'c/model3');
  assert.equal(config.consensus, true);
  assert.equal(config.smartExperts, true);
  assert.deepEqual(config.fallbackModels, ['f/m1', 'f/m2']);
  assert.equal(config.session, 'ses_123');
  assert.equal(config.artifacts, true);
  assert.deepEqual(applied.missing, []);
  assert.equal(applied.emptySelection, false);

  const filteredConfig = mergeWithDefaults({
    experts: [{ name: 'arch' }, { name: 'sec' }],
    chair: { agent: 'consilium' }
  });
  const filtered = applyReplayPlan(filteredConfig, makeRun(), { experts: ['arch'] });
  assert.deepEqual(filteredConfig.experts.map(expert => expert.name), ['arch']);
  assert.deepEqual(filtered.missing, []);
  assert.equal(filtered.emptySelection, false);
});

test('полные метаданные: все поля плана и пустые warnings', () => {
  const plan = planReplay(makeRun({ chairAgent: 'consilium' }));
  assert.equal(plan.task, 'Explain X');
  assert.deepEqual(plan.experts, [
    { name: 'arch', model: 'a/model1' },
    { name: 'sec', model: 's/model2' }
  ]);
  assert.deepEqual(plan.chair, { agent: 'consilium', model: 'c/model3' });
  assert.equal(plan.options.consensus, true);
  assert.equal(plan.options.smartExperts, true);
  assert.deepEqual(plan.options.fallbackModels, ['f/m1', 'f/m2']);
  assert.equal(plan.options.session, 'ses_123');
  assert.equal(plan.options.artifacts, true);
  assert.deepEqual(plan.warnings, []);
});

test('chairAgent артефакта побеждает defaults.chairAgent', () => {
  const plan = planReplay(makeRun({ chairAgent: 'arch' }), { chairAgent: 'sec' });
  assert.deepEqual(plan.chair, { agent: 'arch', model: 'a/model1' });
});

test('defaults.chairAgent используется при отсутствии поля в артефакте', () => {
  const plan = planReplay(makeRun(), { chairAgent: 'sec' });
  assert.deepEqual(plan.chair, { agent: 'sec', model: 's/model2' });
});

test('дефолтный председатель — consilium', () => {
  const plan = planReplay(makeRun());
  assert.deepEqual(plan.chair, { agent: 'consilium', model: 'c/model3' });
});

test('модель председателя: fallback на эксперта-тёзку', () => {
  const run = makeRun({ chairAgent: 'arch' });
  delete run.models.arch;
  const plan = planReplay(run);
  assert.deepEqual(plan.chair, { agent: 'arch', model: 'a/model1' });
});

test('модель эксперта: fallback на карту models', () => {
  const run = makeRun();
  delete run.experts[0].model;
  const plan = planReplay(run);
  assert.equal(plan.experts[0].model, 'a/model1');
});

test('минимальные метаданные: флаги не заданы, warning о метаданных', () => {
  const run = makeRun();
  delete run.metadata;
  const plan = planReplay(run);
  assert.ok(!('consensus' in plan.options));
  assert.ok(!('smartExperts' in plan.options));
  assert.ok(!('fallbackModels' in plan.options));
  assert.ok(!('session' in plan.options));
  assert.ok(plan.warnings.some(w => w.includes('Метаданные')));
  assert.ok(plan.warnings.some(w => w.includes('consensus')));
});

test('неудачный запуск: warning о failed run', () => {
  const plan = planReplay(makeRun({ success: false, chairAgent: 'consilium' }));
  assert.ok(plan.warnings.some(w => w.includes('success: false')));
});

test('нет экспертов: пустой список и warnings', () => {
  const plan = planReplay(makeRun({ experts: [] }));
  assert.deepEqual(plan.experts, []);
  assert.ok(plan.warnings.some(w => w.includes('нет экспертов')));
  // председатель consilium известен через карту models — warning о модели не нужен
  assert.deepEqual(plan.chair, { agent: 'consilium', model: 'c/model3' });
  const run = makeRun({ experts: [] });
  delete run.models.consilium;
  const plan2 = planReplay(run);
  assert.ok(plan2.warnings.some(w => w.includes('Неизвестная модель')));
});

test('пустая задача: warning', () => {
  for (const task of ['', '   ']) {
    const plan = planReplay(makeRun({ task, chairAgent: 'consilium' }));
    assert.ok(plan.warnings.some(w => w.includes('Пустая задача')), `task=${JSON.stringify(task)}`);
  }
});

test('дубликаты дедуплицируются (первый побеждает), пустые имена пропускаются', () => {
  const run = makeRun({
    experts: [
      { agent: 'arch', model: 'a/first', success: true, text: 't' },
      { agent: 'arch', model: 'a/second', success: true, text: 't' },
      { agent: '', model: 'x/y', success: true, text: 't' },
      { agent: '   ', model: 'x/y', success: true, text: 't' },
      { agent: 'sec', model: 's/model2', success: true, text: 't' }
    ]
  });
  const plan = planReplay(run);
  assert.deepEqual(plan.experts, [
    { name: 'arch', model: 'a/first' },
    { name: 'sec', model: 's/model2' }
  ]);
});

test('неверные типы метаданных: не бросает, поля опускаются', () => {
  const plan = planReplay(
    makeRun({ metadata: { fallbackModels: 'nope', session: 42 }, chairAgent: 'consilium' })
  );
  assert.ok(!('fallbackModels' in plan.options));
  assert.ok(!('session' in plan.options));
  assert.ok(!('consensus' in plan.options));
  assert.ok(!('smartExperts' in plan.options));
});

test('метаданные-строка и смешанный fallbackModels: не бросает', () => {
  const a = planReplay(makeRun({ metadata: 'oops' }));
  assert.ok(a.warnings.some(w => w.includes('Метаданные')));
  const b = planReplay(makeRun({ metadata: { fallbackModels: ['f/m1', 7] } }));
  assert.ok(!('fallbackModels' in b.options));
});

test('defaults.artifacts: false отключает, строка проходит как есть', () => {
  const off = planReplay(makeRun(), { artifacts: false });
  assert.equal(off.options.artifacts, false);
  const custom = planReplay(makeRun(), { artifacts: '.runs/custom' });
  assert.equal(custom.options.artifacts, '.runs/custom');
});

test('детерминизм: повторные вызовы идентичны', () => {
  const run = makeRun({ chairAgent: 'consilium' });
  assert.deepEqual(planReplay(run), planReplay(run));
});

test('вход не мутирует: артефакт и defaults неизменны', () => {
  const run = makeRun({ chairAgent: 'consilium' });
  const defaults = { chairAgent: 'consilium', artifacts: true };
  const beforeRun = JSON.stringify(run);
  const beforeDefaults = JSON.stringify(defaults);
  const plan = planReplay(run, defaults);
  plan.experts.push({ name: 'x' });
  plan.options.fallbackModels.push('z/z');
  plan.warnings.push('x');
  assert.equal(JSON.stringify(run), beforeRun);
  assert.equal(JSON.stringify(defaults), beforeDefaults);
  assert.deepEqual(planReplay(run, defaults).options.fallbackModels, ['f/m1', 'f/m2']);
});
