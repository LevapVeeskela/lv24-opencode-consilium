import test from 'node:test';
import assert from 'node:assert/strict';
import {
  VARIANT_PATTERN,
  applyVariant,
  applyVariantList,
  isValidVariant,
  stripVariant,
  variantOf,
  withVariant
} from '../dist/variants.js';

test('VARIANT_PATTERN и isValidVariant: корректные и некорректные', () => {
  assert.equal(VARIANT_PATTERN.source, '^[A-Za-z0-9][A-Za-z0-9._-]*$');
  for (const valid of ['high', 'x', 'A1', 'v1.2', 'a-b_c', 'Z9.-_0', '  high  ']) {
    assert.equal(isValidVariant(valid), true, valid);
  }
  for (const invalid of ['', '   ', '-x', '.x', '_x', 'a b', 'a/b', 'a#', '#high', 'вариант', 'a!b']) {
    assert.equal(isValidVariant(invalid), false, JSON.stringify(invalid));
  }
});

test('variantOf: часть после первого #, пустая — undefined', () => {
  assert.equal(variantOf('anthropic/claude-sonnet-5-5#high'), 'high');
  assert.equal(variantOf('openrouter/meta/muse-spark#high'), 'high');
  assert.equal(variantOf('a/b/c#low'), 'low');
  assert.equal(variantOf('a/b'), undefined);
  assert.equal(variantOf('a/b#'), undefined);
  assert.equal(variantOf('a/b#x#y'), 'x#y');
});

test('stripVariant: убирает #..., остальное как есть', () => {
  assert.equal(stripVariant('anthropic/claude-sonnet-5-5#high'), 'anthropic/claude-sonnet-5-5');
  assert.equal(stripVariant('openrouter/meta/muse-spark#high'), 'openrouter/meta/muse-spark');
  assert.equal(stripVariant('a/b/c#low'), 'a/b/c');
  assert.equal(stripVariant('a/b'), 'a/b');
  assert.equal(stripVariant('a/b#'), 'a/b');
  assert.equal(stripVariant('p/m #v'), 'p/m ');
});

test('withVariant: добавить/заменить/снять, мульти-слэш', () => {
  assert.equal(withVariant('a/b', 'high'), 'a/b#high');
  assert.equal(withVariant('a/b#old', 'new'), 'a/b#new');
  assert.equal(withVariant('openrouter/meta/muse-spark', 'high'), 'openrouter/meta/muse-spark#high');
  assert.equal(withVariant('openrouter/meta/muse-spark#low', 'high'), 'openrouter/meta/muse-spark#high');
  assert.equal(withVariant('a/b/c', 'low'), 'a/b/c#low');
  assert.equal(withVariant('a/b#high', undefined), 'a/b');
  assert.equal(withVariant('a/b#high', ''), 'a/b');
  assert.equal(withVariant('a/b', '  high  '), 'a/b#high');
});

test('withVariant: некорректный вариант и база бросают', () => {
  assert.throws(() => withVariant('a/b', 'bad variant!'), /Некорректный вариант модели/);
  assert.throws(() => withVariant('a/b', 'a/b'), /Некорректный вариант модели/);
  assert.throws(() => withVariant('a/b', '   '), /Некорректный вариант модели/);
  assert.throws(() => withVariant('no-slash', 'high'), /Некорректная модель/);
  assert.throws(() => withVariant('', 'high'), /Некорректная модель/);
  assert.throws(() => withVariant('no-slash', undefined), /Некорректная модель/);
});

test('applyVariant: существующий вариант цел, некорректный id untouched', () => {
  const out = applyVariant(
    {
      keep: 'anthropic/claude-sonnet-5-5#low',
      add: 'anthropic/claude-sonnet-5-5',
      nested: 'openrouter/meta/muse-spark',
      bad: 'no-slash'
    },
    'high'
  );
  assert.deepEqual(out, {
    keep: 'anthropic/claude-sonnet-5-5#low',
    add: 'anthropic/claude-sonnet-5-5#high',
    nested: 'openrouter/meta/muse-spark#high',
    bad: 'no-slash'
  });
});

test('applyVariant: некорректный вариант бросает, вход не мутирует', () => {
  const input = { a: 'p/m', b: 'p/m#old' };
  const snapshot = JSON.parse(JSON.stringify(input));
  assert.throws(() => applyVariant(input, 'bad variant!'), /Некорректный вариант модели/);
  const out = applyVariant(input, 'high');
  assert.deepEqual(input, snapshot);
  assert.notEqual(out, input);
  assert.deepEqual(out, { a: 'p/m#high', b: 'p/m#old' });
});

test('applyVariantList: добавить, сохранить, дедуп по порядку', () => {
  assert.deepEqual(applyVariantList(['a/b', 'a/b', 'a/b#x'], 'high'), ['a/b#high', 'a/b#x']);
  assert.deepEqual(applyVariantList(['a/b', 'a/b#high'], 'high'), ['a/b#high']);
  assert.deepEqual(
    applyVariantList(['openrouter/meta/muse-spark', 'no-slash', 'a/b/c'], 'high'),
    ['openrouter/meta/muse-spark#high', 'no-slash', 'a/b/c#high']
  );
  assert.deepEqual(applyVariantList([], 'high'), []);
  assert.throws(() => applyVariantList(['a/b'], 'bad!'), /Некорректный вариант модели/);
});
