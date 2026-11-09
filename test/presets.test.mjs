import test from 'node:test';
import assert from 'node:assert/strict';
import { applyPreset, listPresets } from '../dist/presets.js';
import { mergeWithDefaults } from '../dist/config.js';

test('listPresets содержит все заявленные пресеты', () => {
  const names = listPresets().map(preset => preset.name);
  for (const name of ['fast', 'deep', 'security', 'review', 'free']) {
    assert.ok(names.includes(name), `нет пресета ${name}`);
  }
});

test('applyPreset fast оставляет arch и sec без retry', () => {
  const config = applyPreset(mergeWithDefaults({}), 'fast');
  assert.deepEqual(config.experts.map(expert => expert.name), ['arch', 'sec']);
  assert.equal(config.retry.expertRetries, 0);
});

test('applyPreset не мутирует исходный конфиг', () => {
  const original = mergeWithDefaults({});
  const before = original.experts.map(expert => expert.name);
  applyPreset(original, 'security');
  assert.deepEqual(original.experts.map(expert => expert.name), before);
});

test('applyPreset на неизвестном имени бросает ошибку', () => {
  assert.throws(() => applyPreset(mergeWithDefaults({}), 'nope'), /Неизвестный пресет/);
});

test('applyPreset не обнуляет совет из кастомных экспертов', () => {
  const config = mergeWithDefaults({
    experts: [{ name: 'custom-a' }, { name: 'custom-b' }]
  });
  const applied = applyPreset(config, 'fast');
  assert.deepEqual(applied.experts.map(expert => expert.name), ['custom-a', 'custom-b']);
});
