import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadConfig,
  mergeWithDefaults,
  validateConfig,
  generateExampleConfig,
  cloneConfig
} from '../dist/config.js';
import { DEFAULT_CONFIG } from '../dist/defaults.js';

test('loadConfig читает явный файл', () => {
  const dir = mkdtempSync(join(tmpdir(), 'consilium-test-'));
  const path = join(dir, 'consilium.json');
  writeFileSync(path, JSON.stringify({ chair: { agent: 'custom-chair' }, experts: [{ name: 'one' }] }));
  try {
    const result = loadConfig(path);
    assert.equal(result.config.chair.agent, 'custom-chair');
    assert.equal(result.config.experts[0].name, 'one');
    assert.equal(result.configPath, path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadConfig предупреждает о несуществующем явном файле', () => {
  const result = loadConfig('definitely-missing-consilium-config.json');
  assert.equal(result.configPath, null);
  assert.ok(result.warnings.some(warning => warning.includes('не найден')));
});

test('mergeWithDefaults не делит массивы с DEFAULT_CONFIG', () => {
  const merged = mergeWithDefaults({});
  merged.experts[0].name = 'mutated';
  assert.notEqual(DEFAULT_CONFIG.experts[0].name, 'mutated');
  const cloned = cloneConfig(merged);
  cloned.timeouts.expert = 1;
  assert.notEqual(merged.timeouts.expert, 1);
});

test('JSON с __proto__ не загрязняет прототип', () => {
  const parsed = JSON.parse('{"__proto__":{"polluted":true}}');
  const config = mergeWithDefaults(parsed);
  assert.equal({}.polluted, undefined);
  assert.equal(Object.getPrototypeOf(config).polluted, undefined);
});

test('validateConfig ловит некорректную модель и таймауты', () => {
  const config = cloneConfig(DEFAULT_CONFIG);
  config.experts = [{ name: 'arch', model: 'bad model id' }];
  config.timeouts.expert = -1;
  config.chair.model = 'no-slash';
  const warnings = validateConfig(config);
  assert.ok(warnings.some(item => item.includes('Некорректный id модели у эксперта')));
  assert.ok(warnings.some(item => item.includes('Некорректный таймаут expert')));
  assert.ok(warnings.some(item => item.includes('Некорректный id модели председателя')));
});

test('BOM в начале конфига не ломает загрузку', () => {
  const dir = mkdtempSync(join(tmpdir(), 'consilium-bom-'));
  const path = join(dir, 'consilium.json');
  writeFileSync(path, `\uFEFF${JSON.stringify({ chair: { agent: 'bom-chair' } })}`);
  try {
    const result = loadConfig(path);
    assert.equal(result.config.chair.agent, 'bom-chair');
    assert.equal(result.errors?.length ?? 0, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('JSONC-строки с ,} и ,] не повреждаются', () => {
  const dir = mkdtempSync(join(tmpdir(), 'consilium-jsonc-'));
  const path = join(dir, 'consilium.json');
  writeFileSync(path, '{ "chair": { "agent": "keep,}" }, // comment\n "experts": [{ "name": "x", }] }');
  try {
    const result = loadConfig(path);
    assert.equal(result.config.chair.agent, 'keep,}');
    assert.equal(result.errors?.length ?? 0, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('generateExampleConfig — валидный JSON с ключевыми полями', () => {
  const config = JSON.parse(generateExampleConfig());
  assert.equal(config.version, '1.4.0');
  assert.equal(config.output.file, false);
  assert.equal(config.retry.maxConcurrency, 3);
  assert.equal(config.standalone, true);
  assert.equal(config.experts.length, 4);
});

test('validateConfig проверяет report, variant и debounceMs', () => {
  const invalid = mergeWithDefaults({
    report: 'pdf',
    variant: 'bad variant',
    debounceMs: -1
  });
  const warnings = validateConfig(invalid);
  assert.ok(warnings.some(w => w.includes('формат отчёта')));
  assert.ok(warnings.some(w => w.includes('вариант модели')));
  assert.ok(warnings.some(w => w.includes('debounceMs')));

  const valid = mergeWithDefaults({
    report: 'html',
    variant: 'high',
    debounceMs: 250
  });
  assert.deepEqual(validateConfig(valid), []);
});
