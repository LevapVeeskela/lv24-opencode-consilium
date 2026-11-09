import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PRESETS,
  applyPreset,
  formatPresets,
  listPresets,
  mergePresets
} from '../dist/presets.js';
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

test('applyPreset применяет новый пользовательский пресет', () => {
  const custom = {
    custom: {
      description: 'Мой пресет',
      experts: ['sec', 'arch'],
      chair: 'custom-chair',
      retries: 2,
      expertTimeout: 45_000,
      chairTimeout: 90_000
    }
  };

  const config = applyPreset(mergeWithDefaults({}), 'custom', custom);

  assert.deepEqual(config.experts.map(expert => expert.name), ['sec', 'arch']);
  assert.equal(config.chair.agent, 'custom-chair');
  assert.equal(config.chair.timeout, 90_000);
  assert.equal(config.retry.expertRetries, 2);
  assert.equal(config.retry.chairRetries, 2);
  assert.equal(config.timeouts.expert, 45_000);
  assert.equal(config.timeouts.chair, 90_000);
});

test('пользовательский пресет переопределяет поля fast, сохраняя остальные', () => {
  const { presets } = mergePresets({
    fast: { experts: ['ux'], retries: 3, chair: 'lead' }
  });

  assert.deepEqual(presets.fast.experts, ['ux']);
  assert.equal(presets.fast.retries, 3);
  assert.equal(presets.fast.chair, 'lead');
  assert.equal(presets.fast.description, PRESETS.fast.description);
  assert.equal(presets.fast.expertTimeout, PRESETS.fast.expertTimeout);
  assert.equal(presets.fast.chairTimeout, PRESETS.fast.chairTimeout);

  const config = applyPreset(mergeWithDefaults({}), 'fast', {
    fast: { experts: ['ux'], retries: 3 }
  });
  assert.deepEqual(config.experts.map(expert => expert.name), ['ux']);
  assert.equal(config.retry.expertRetries, 3);
  assert.equal(config.timeouts.expert, PRESETS.fast.expertTimeout);
});

test('mergePresets отбрасывает некорректное имя и неверные поля с warnings', () => {
  const { presets, warnings } = mergePresets({
    'bad name': { experts: ['arch'] },
    fast: {
      experts: 'arch',
      retries: -1,
      expertTimeout: 1.5,
      chairTimeout: -5
    }
  });

  assert.equal(Object.prototype.hasOwnProperty.call(presets, 'bad name'), false);
  assert.deepEqual(presets.fast.experts, PRESETS.fast.experts);
  assert.equal(presets.fast.retries, PRESETS.fast.retries);
  assert.equal(presets.fast.expertTimeout, PRESETS.fast.expertTimeout);
  assert.equal(presets.fast.chairTimeout, PRESETS.fast.chairTimeout);

  assert.ok(warnings.some(warning => warning.includes('bad name') && warning.includes('имя')));
  assert.ok(warnings.some(warning => warning.includes('experts')));
  assert.ok(warnings.some(warning => warning.includes('retries')));
  assert.ok(warnings.some(warning => warning.includes('expertTimeout')));
  assert.ok(warnings.some(warning => warning.includes('chairTimeout')));
});

test('mergePresets пропускает не-объектные записи с warning', () => {
  const { presets, warnings } = mergePresets({ broken: null });

  assert.equal(Object.prototype.hasOwnProperty.call(presets, 'broken'), false);
  assert.ok(warnings.some(warning => warning.includes('broken')));
});

test('mergePresets игнорирует неизвестные поля и не мутирует PRESETS', () => {
  const snapshot = JSON.parse(JSON.stringify(PRESETS));
  const { presets, warnings } = mergePresets({
    fast: { experts: ['ba'], unexpected: true },
    brand: { experts: ['arch'], extra: 42 }
  });

  assert.deepEqual(PRESETS, snapshot);
  assert.equal(Object.prototype.hasOwnProperty.call(PRESETS, 'brand'), false);
  assert.deepEqual(presets.fast.experts, ['ba']);
  assert.equal(presets.fast.unexpected, undefined);
  assert.equal(presets.brand.extra, undefined);
  assert.deepEqual(warnings, []);
});

test('mergePresets клонирует встроенные пресеты', () => {
  const { presets, warnings } = mergePresets();

  assert.deepEqual(warnings, []);
  assert.notEqual(presets.fast, PRESETS.fast);
  assert.notEqual(presets.fast.experts, PRESETS.fast.experts);

  presets.fast.experts.push('mutant');
  assert.equal(PRESETS.fast.experts.includes('mutant'), false);
});

test('новый пресет без необязательных полей получает имя и описание', () => {
  const { presets } = mergePresets({ minimal: {} });

  assert.equal(presets.minimal.name, 'minimal');
  assert.equal(typeof presets.minimal.description, 'string');
  assert.ok(presets.minimal.description.length > 0);
  assert.equal(presets.minimal.experts, undefined);
});

test('listPresets: встроенные первыми, пользовательские по алфавиту и стабильно', () => {
  const custom = {
    zebra: { experts: ['arch'] },
    alpha: { experts: ['sec'] },
    fast: { retries: 2 }
  };
  const builtins = Object.keys(PRESETS);
  const names = listPresets(custom).map(preset => preset.name);

  assert.deepEqual(names.slice(0, builtins.length), builtins);
  assert.deepEqual(names.slice(builtins.length), ['alpha', 'zebra']);
  assert.deepEqual(listPresets(custom).map(preset => preset.name), names);
});

test('applyPreset на неизвестном имени перечисляет объединённые пресеты', () => {
  const custom = { alpha: { experts: ['arch'] } };

  assert.throws(
    () => applyPreset(mergeWithDefaults({}), 'nope', custom),
    error => {
      assert.match(error.message, /Неизвестный пресет: nope/);
      assert.match(error.message, /alpha/);
      assert.match(error.message, /fast/);
      return true;
    }
  );
});

test('пользовательский пресет не обнуляет совет из кастомных экспертов', () => {
  const config = mergeWithDefaults({
    experts: [{ name: 'custom-a' }]
  });
  const applied = applyPreset(config, 'custom', {
    custom: { experts: ['arch', 'sec'] }
  });

  assert.deepEqual(applied.experts.map(expert => expert.name), ['custom-a']);
});

test('пользовательские prompt и focus сохраняются при слиянии', () => {
  const custom = {
    custom: {
      description: 'С фокусом',
      experts: ['sec'],
      focus: 'security',
      prompt: 'Только факты'
    },
    security: { description: 'Обновлённый аудит' }
  };
  const { presets, warnings } = mergePresets(custom);

  assert.deepEqual(warnings, []);
  assert.equal(presets.custom.focus, 'security');
  assert.equal(presets.custom.prompt, 'Только факты');
  assert.equal(presets.security.description, 'Обновлённый аудит');
  assert.equal(presets.security.focus, PRESETS.security.focus);
});

test('formatPresets выводит компактные строки и стабилен', () => {
  const custom = { alpha: { description: 'Альфа', experts: ['arch', 'sec'] } };
  const presets = listPresets(custom);
  const text = formatPresets(presets);
  const lines = text.split('\n');

  assert.equal(lines.length, Object.keys(PRESETS).length + 1);
  assert.equal(lines.at(-1), 'alpha — Альфа (experts: arch, sec)');
  assert.match(lines[0], /^fast — .+ \(experts: arch, sec\)$/);
  assert.equal(formatPresets(listPresets(custom)), text);
  assert.equal(formatPresets(mergePresets(custom).presets), text);
});
