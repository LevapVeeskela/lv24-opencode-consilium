import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
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
  writeFileSync(path, '{ "chair": { "agent": "jsonc-chair" }, "session": "keep,}", // comment\n "experts": [{ "name": "x", }] }');
  try {
    const result = loadConfig(path);
    assert.equal(result.config.session, 'keep,}');
    assert.equal(result.errors?.length ?? 0, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('generateExampleConfig — валидный JSON с ключевыми полями', () => {
  const config = JSON.parse(generateExampleConfig());
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(config.version, pkg.version);
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

test('loadConfig: явный chair.model не перекрывается моделью из opencode.json', () => {
  const root = mkdtempSync(join(tmpdir(), 'consilium-chair-model-'));
  const previous = process.cwd();
  const previousXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = join(root, 'xdg');
  try {
    writeFileSync(
      join(root, 'consilium.config.json'),
      JSON.stringify({ chair: { agent: 'consilium', model: 'user/chair-model' } }),
      'utf-8'
    );
    writeFileSync(
      join(root, 'opencode.json'),
      JSON.stringify({
        agents: {
          arch: { mode: 'primary', model: 'opencode/arch-model', system: 's' },
          consilium: { mode: 'primary', model: 'opencode/discovered-chair', system: 's' }
        }
      }),
      'utf-8'
    );

    process.chdir(root);
    const loaded = loadConfig();
    assert.equal(loaded.config.chair.model, 'user/chair-model');
  } finally {
    process.chdir(previous);
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousXdg;
    rmSync(root, { recursive: true, force: true });
  }
});

test('loadConfig: невалидный excludedAgents предупреждает и игнорируется', () => {
  const root = mkdtempSync(join(tmpdir(), 'consilium-excluded-'));
  const previous = process.cwd();
  const previousXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = join(root, 'xdg');
  try {
    writeFileSync(
      join(root, 'consilium.config.json'),
      JSON.stringify({ excludedAgents: {} }),
      'utf-8'
    );
    writeFileSync(
      join(root, 'opencode.json'),
      JSON.stringify({
        agents: { arch: { mode: 'primary', model: 'opencode/arch-model', system: 's' } }
      }),
      'utf-8'
    );

    process.chdir(root);
    const loaded = loadConfig();
    assert.ok(
      loaded.warnings.some(warning => warning.includes('excludedAgents')),
      `warnings: ${loaded.warnings.join(' | ')}`
    );
    assert.deepEqual(loaded.config.experts.map(expert => expert.name), ['arch']);
  } finally {
    process.chdir(previous);
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousXdg;
    rmSync(root, { recursive: true, force: true });
  }
});

test('loadConfig предупреждает о битом проектном opencode.json и продолжает', () => {
  const root = mkdtempSync(join(tmpdir(), 'consilium-broken-opencode-'));
  const previous = process.cwd();
  const previousXdg = process.env.XDG_CONFIG_HOME;
  const xdg = join(root, 'xdg');
  const globalPath = join(xdg, 'opencode', 'opencode.json');
  const projectPath = join(root, 'opencode.json');
  process.env.XDG_CONFIG_HOME = xdg;
  try {
    mkdirSync(join(xdg, 'opencode'), { recursive: true });
    writeFileSync(
      globalPath,
      JSON.stringify({
        agents: { arch: { mode: 'primary', model: 'global/arch-model', system: 's' } }
      }),
      'utf-8'
    );
    writeFileSync(projectPath, '{ "agent": { "arch": ', 'utf-8');

    process.chdir(root);
    const loaded = loadConfig();
    assert.ok(
      loaded.warnings.some(warning => warning.includes(projectPath)),
      `warnings: ${loaded.warnings.join(' | ')}`
    );
    assert.equal(
      loaded.config.experts.find(expert => expert.name === 'arch')?.model,
      'global/arch-model'
    );
  } finally {
    process.chdir(previous);
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousXdg;
    rmSync(root, { recursive: true, force: true });
  }
});
