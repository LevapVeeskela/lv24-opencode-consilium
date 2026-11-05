import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, main } from '../dist/cli.js';

test('задача из позиционных аргументов', () => {
  const options = parseArgs(['оцени', 'архитектуру']);
  assert.equal(options.task, 'оцени архитектуру');
  assert.equal(options.command, undefined);
});

test('команда models с флагами', () => {
  const options = parseArgs(['models', '--available', '--limit', '5']);
  assert.equal(options.command, 'models');
  assert.equal(options.available, true);
  assert.equal(options.limit, 5);
});

test('-- разделитель позволяет задачу с дефиса', () => {
  const options = parseArgs(['--preset', 'fast', '--', '-weird', 'task']);
  assert.equal(options.preset, 'fast');
  assert.equal(options.task, '-weird task');
});

test('--json включает json-формат', () => {
  const options = parseArgs(['--json', 'задача']);
  assert.equal(options.format, 'json');
  assert.equal(options.json, true);
});

test('одиночный - включает чтение stdin вместе с задачей', () => {
  const options = parseArgs(['сделай', 'ревью', '-']);
  assert.equal(options.taskFile, '-');
  assert.equal(options.task, 'сделай ревью');
});

test('--init включает команду init', () => {
  const options = parseArgs(['--init']);
  assert.equal(options.command, 'init');
});

test('неизвестный флаг — ошибка', () => {
  assert.throws(() => parseArgs(['--wat']), /Неизвестный флаг/);
});

test('флаг без значения — ошибка', () => {
  assert.throws(() => parseArgs(['--config']), /требует значение/);
});

test('некорректный retries — ошибка', () => {
  assert.throws(() => parseArgs(['-r', 'abc']), /целое число/);
  assert.throws(() => parseArgs(['-r', '-1']), /целое число/);
});

test('некорректный формат — ошибка', () => {
  assert.throws(() => parseArgs(['-f', 'yaml']), /Неизвестный формат/);
});

test('неизвестный пресет — код выхода 2', async (t) => {
  t.mock.method(console, 'error', () => {});
  const code = await main(['--preset', 'nope', '--dry-run', 'task']);
  assert.equal(code, 2);
});

test('неизвестный эксперт — код выхода 2', async (t) => {
  t.mock.method(console, 'error', () => {});
  const code = await main(['-e', 'nope', '--dry-run', 'task']);
  assert.equal(code, 2);
});
