import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cloneConfig,
  generateExampleConfig,
  loadConfig,
  mergeWithDefaults,
  validateConfig
} from '../dist/config.js';
import { DEFAULT_CONFIG } from '../dist/defaults.js';
import { MAX_DEADLINE_MS } from '../dist/application/run.js';
import {
  PRESETS,
  listPresets
} from '../dist/domain/council/presets.js';
import {
  COMMANDS,
  UsageError,
  parseArgs
} from '../dist/interfaces/cli/args.js';
import { applyCliOverrides } from '../dist/interfaces/cli/overrides.js';
import { commandModels } from '../dist/interfaces/cli/commands/models.js';
import { commandPresets } from '../dist/interfaces/cli/commands/presets.js';
import { printHelp } from '../dist/interfaces/cli/help.js';

const TRUSTED_PROJECT_CONFIG = Symbol.for('lv24-opencode-consilium.trustedProjectConfig');

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), `consilium-${prefix}-`));
}

function cleanup(directory) {
  rmSync(directory, { recursive: true, force: true });
}

function writeConfig(directory, config) {
  const path = join(directory, 'consilium.config.json');
  writeFileSync(
    path,
    JSON.stringify({ autoDiscoverAgents: false, ...config }, null, 2),
    'utf8'
  );
  return path;
}

function captureLogs(t) {
  const logs = [];
  t.mock.method(console, 'log', (...args) => {
    logs.push(args.join(' '));
  });
  return logs;
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : '',
    json: async () => body
  };
}

async function withFetch(handler, run) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function model(id, overrides = {}) {
  const slash = id.indexOf('/');
  return {
    id,
    providerID: slash === -1 ? id : id.slice(0, slash),
    modelID: slash === -1 ? id : id.slice(slash + 1),
    name: id,
    context: 128000,
    outputLimit: 32000,
    reasoning: true,
    toolCall: true,
    structuredOutput: true,
    releaseDate: '2026-10-01',
    canonicalID: id,
    score: 0.9,
    available: true,
    source: 'builtin',
    ...overrides
  };
}

function catalogResult(models) {
  return { models, sources: [], fromCache: false, fetchedAt: 0 };
}

test('DEFAULT_CONFIG: localOnly=false и без пустых presets', () => {
  assert.equal(DEFAULT_CONFIG.localOnly, false);
  assert.equal('presets' in DEFAULT_CONFIG, false);

  const merged = mergeWithDefaults({});
  assert.equal(merged.localOnly, false);
  assert.equal(merged.presets, undefined);
});

test('validateConfig: deadlineMs — положительное целое, 0/отрицательные игнорируются, 24 ч clamp', () => {
  const valid = mergeWithDefaults({ deadlineMs: 1500 });
  assert.deepEqual(validateConfig(valid), []);
  assert.equal(valid.deadlineMs, 1500);

  const zero = mergeWithDefaults({ deadlineMs: 0 });
  assert.ok(validateConfig(zero).some(warning => warning.includes('deadlineMs')));
  assert.equal(zero.deadlineMs, undefined);

  const negative = mergeWithDefaults({ deadlineMs: -5 });
  assert.ok(validateConfig(negative).some(warning => warning.includes('deadlineMs')));
  assert.equal(negative.deadlineMs, undefined);

  const fractional = mergeWithDefaults({ deadlineMs: 1500.5 });
  assert.ok(validateConfig(fractional).some(warning => warning.includes('deadlineMs')));
  assert.equal(fractional.deadlineMs, undefined);

  const tooLong = mergeWithDefaults({ deadlineMs: MAX_DEADLINE_MS + 1 });
  assert.ok(validateConfig(tooLong).some(warning => warning.includes('24')));
  assert.equal(tooLong.deadlineMs, MAX_DEADLINE_MS);
});

test('loadConfig: невалидный localOnly игнорируется с предупреждением', () => {
  const root = tempDir('local-only-config');
  try {
    const path = writeConfig(root, { localOnly: 'yes' });
    const loaded = loadConfig(path, { trustProjectConfig: true });

    assert.equal(loaded.config.localOnly, false);
    assert.ok(loaded.warnings.some(warning => warning.includes('localOnly')));
  } finally {
    cleanup(root);
  }
});

test('validateConfig: localOnly проверяется как boolean', () => {
  const config = mergeWithDefaults({});
  config.localOnly = 'yes';
  assert.ok(validateConfig(config).some(warning => warning.includes('localOnly')));
});

test('loadConfig: presets валидируются через mergePresets и в конфиг попадают только custom-записи', () => {
  const root = tempDir('presets-config');
  try {
    const path = writeConfig(root, {
      presets: {
        docs: {
          description: 'Документация: arch и ba',
          experts: ['arch', 'ba']
        },
        fast: { description: 'Мой быстрый пресет' },
        'bad name': { description: 'Неверное имя' },
        broken: 'not-an-object'
      }
    });
    const loaded = loadConfig(path, { trustProjectConfig: true });

    assert.ok(loaded.config.presets);
    assert.equal(loaded.config.presets.docs.description, 'Документация: arch и ba');
    assert.deepEqual(loaded.config.presets.docs.experts, ['arch', 'ba']);
    assert.equal(loaded.config.presets.fast.description, 'Мой быстрый пресет');
    assert.equal('bad name' in loaded.config.presets, false);
    assert.equal('broken' in loaded.config.presets, false);
    // Встроенные пресеты не копируются в конфиг целиком.
    assert.equal('deep' in loaded.config.presets, false);
    assert.ok(loaded.warnings.some(warning => warning.includes('Пресет')));

    const custom = listPresets(loaded.config.presets);
    assert.equal(custom.find(preset => preset.name === 'docs')?.description, 'Документация: arch и ba');
    assert.equal(custom.find(preset => preset.name === 'fast')?.description, 'Мой быстрый пресет');
    assert.ok(custom.some(preset => preset.name === 'deep'));
    assert.equal(PRESETS.fast.description === 'Мой быстрый пресет', false);
  } finally {
    cleanup(root);
  }
});

test('cloneConfig/mergeWithDefaults: presets клонируются без мутаций и сохраняют trusted symbol', () => {
  const root = tempDir('presets-clone');
  try {
    const sourcePresets = {
      docs: { description: 'Docs', experts: ['arch'] }
    };
    const merged = mergeWithDefaults({ presets: sourcePresets });
    merged.presets.docs.experts.push('ba');
    assert.deepEqual(sourcePresets.docs.experts, ['arch']);

    const cloned = cloneConfig(merged);
    assert.notEqual(cloned.presets, merged.presets);
    assert.notEqual(cloned.presets.docs, merged.presets.docs);
    assert.notEqual(cloned.presets.docs.experts, merged.presets.docs.experts);
    cloned.presets.docs.experts.push('sec');
    assert.deepEqual(merged.presets.docs.experts, ['arch', 'ba']);

    const path = writeConfig(root, { localOnly: false });
    const trusted = loadConfig(path, { trustProjectConfig: true }).config;
    assert.equal(trusted[TRUSTED_PROJECT_CONFIG], true);
    assert.equal(cloneConfig(trusted)[TRUSTED_PROJECT_CONFIG], true);
    assert.equal(mergeWithDefaults(trusted)[TRUSTED_PROJECT_CONFIG], true);
  } finally {
    cleanup(root);
  }
});

test('generateExampleConfig, schema и example: localOnly, deadlineMs и custom presets', () => {
  const generated = JSON.parse(generateExampleConfig());
  assert.equal(generated.localOnly, false);
  assert.equal(generated.deadlineMs, 900000);
  assert.deepEqual(generated.presets.docs.experts, ['arch', 'ba']);
  assert.match(generated.presets.docs.description, /архитектор/i);

  const schema = JSON.parse(
    readFileSync(new URL('../schema/config.schema.json', import.meta.url), 'utf8')
  );
  assert.equal(schema.properties.localOnly.type, 'boolean');
  assert.equal(schema.properties.deadlineMs.type, 'integer');
  assert.equal(schema.properties.deadlineMs.maximum, 86400000);
  assert.ok(schema.properties.presets);
  assert.equal(schema.definitions.preset.additionalProperties, false);

  const exampleText = readFileSync(
    new URL('../consilium.config.example.json', import.meta.url),
    'utf8'
  ).replace(/^\uFEFF/, '');
  const example = JSON.parse(exampleText);
  assert.equal(example.localOnly, false);
  assert.equal(example.deadlineMs, 900000);
  assert.deepEqual(example.presets.docs.experts, ['arch', 'ba']);
  for (const preset of Object.values(example.presets)) {
    for (const key of Object.keys(preset)) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(schema.definitions.preset.properties, key),
        `schema не описывает поле пресета ${key}`
      );
    }
  }
});

test('parseArgs: deadline, local-only, models local/probe-local и команда presets', () => {
  const run = parseArgs(['run', '--deadline', '5000', '--local-only', 'проверь']);
  assert.equal(run.command, 'run');
  assert.equal(run.deadlineMs, 5000);
  assert.equal(run.localOnly, true);
  assert.equal(run.task, 'проверь');

  const watch = parseArgs(['watch', '--deadline', '2500', '--local-only']);
  assert.equal(watch.command, 'watch');
  assert.equal(watch.deadlineMs, 2500);
  assert.equal(watch.localOnly, true);

  assert.throws(() => parseArgs(['run', '--deadline', '0']), UsageError);
  assert.throws(() => parseArgs(['run', '--deadline', '1.5']), UsageError);

  const models = parseArgs(['models', '--local', '--probe-local', '--json']);
  assert.equal(models.command, 'models');
  assert.equal(models.local, true);
  assert.equal(models.probeLocal, true);
  assert.equal(models.json, true);

  const presets = parseArgs(['presets', '--json']);
  assert.equal(presets.command, 'presets');
  assert.equal(presets.task, '');
  assert.equal(presets.json, true);
  assert.ok(COMMANDS.has('presets'));

  // presets — команда только в самом начале argv.
  const asTask = parseArgs(['--json', 'presets']);
  assert.equal(asTask.command, undefined);
  assert.equal(asTask.task, 'presets');

  assert.equal(parseArgs(['--preset', 'docs', 'task']).preset, 'docs');
});

test('help перечисляет presets, --deadline, --local-only, --local и --probe-local', t => {
  const logs = captureLogs(t);
  printHelp();
  const text = logs.join('\n');
  assert.match(text, /consilium presets/);
  assert.match(text, /--deadline <мс>/);
  assert.match(text, /--local-only/);
  assert.match(text, /--probe-local/);
  assert.match(text, /--local — только локальные/);
});

test('commandModels --local фильтрует рейтинг до limit и сохраняет порядок', async t => {
  const root = tempDir('models-local');
  t.after(() => cleanup(root));
  const logs = captureLogs(t);
  const catalog = [
    model('openai/gpt-4o'),
    model('ollama/llama3'),
    model('anthropic/claude'),
    model('lmstudio/qwen'),
    model('vllm/mistral')
  ];

  const code = await commandModels(
    { task: '', command: 'models', local: true, json: true, limit: 2 },
    { cwd: root, fetchModels: async () => catalogResult(catalog) }
  );

  assert.equal(code, 0);
  const parsed = JSON.parse(logs.join('\n'));
  assert.deepEqual(parsed.models.map(item => item.id), ['ollama/llama3', 'lmstudio/qwen']);
});

test('commandModels --probe-local: JSON localProviders и текстовая таблица (fetch заглушён)', async t => {
  const root = tempDir('models-probe');
  t.after(() => cleanup(root));
  const logs = captureLogs(t);
  const deps = {
    cwd: root,
    fetchModels: async () =>
      catalogResult([
        model('openai/gpt-4o'),
        model('ollama/llama3'),
        model('lmstudio/qwen')
      ])
  };

  await withFetch(
    async url => {
      if (String(url).includes('11434')) {
        return jsonResponse({ models: [{ name: 'llama3' }] });
      }
      return jsonResponse({ data: [{ id: 'qwen' }, { id: 'mistral' }] });
    },
    async () => {
      const code = await commandModels(
        { task: '', command: 'models', local: true, probeLocal: true, json: true },
        deps
      );
      assert.equal(code, 0);
      const parsed = JSON.parse(logs.join('\n'));
      assert.deepEqual(parsed.localProviders.map(item => item.provider), ['ollama', 'lmstudio']);
      assert.deepEqual(parsed.localProviders.map(item => item.models), [1, 2]);
      assert.ok(parsed.localProviders.every(item => item.ok === true));
      assert.deepEqual(
        parsed.models.map(item => item.id),
        ['ollama/llama3', 'lmstudio/qwen']
      );

      logs.length = 0;
      await commandModels(
        { task: '', command: 'models', local: true, probeLocal: true },
        deps
      );
      const text = logs.join('\n');
      assert.match(text, /provider\tstatus\tmodels\turl/);
      assert.match(text, /ollama\tok\t1/);
      assert.match(text, /lmstudio\tok\t2/);
      assert.match(text, /Бесплатные модели/);
    }
  );
});

test('commandPresets: текст и JSON с пользовательским пресетом', async t => {
  const root = tempDir('presets-command');
  t.after(() => cleanup(root));
  const path = writeConfig(root, {
    presets: {
      docs: { description: 'Документация: arch и ba', experts: ['arch', 'ba'] }
    }
  });
  const logs = captureLogs(t);

  const code = await commandPresets({ task: '', command: 'presets', config: path });
  assert.equal(code, 0);
  const text = logs.join('\n');
  assert.match(text, /^fast — /m);
  assert.match(text, /^docs — Документация: arch и ba \(experts: arch, ba\)$/m);

  logs.length = 0;
  await commandPresets({ task: '', command: 'presets', config: path, json: true });
  const parsed = JSON.parse(logs.join('\n'));
  assert.ok(Array.isArray(parsed));
  const docs = parsed.find(preset => preset.name === 'docs');
  assert.equal(docs.description, 'Документация: arch и ba');
  assert.deepEqual(docs.experts, ['arch', 'ba']);
  assert.ok(parsed.some(preset => preset.name === 'deep'));
});

test('applyCliOverrides --local-only: отклоняет внешние модели и принимает ollama/lmstudio', () => {
  const cloud = mergeWithDefaults({
    experts: [{ name: 'arch', model: 'openai/gpt-4o' }],
    chair: { agent: 'consilium', model: 'openai/gpt-4o' }
  });
  assert.throws(
    () => applyCliOverrides(cloud, parseArgs(['--local-only', 'задача'])),
    error =>
      error instanceof UsageError &&
      /openai\/gpt-4o/.test(error.message) &&
      /Нелокальные модели/.test(error.message)
  );

  const chairOnly = mergeWithDefaults({
    experts: [{ name: 'arch', model: 'ollama/llama3' }],
    chair: { agent: 'consilium', model: 'anthropic/claude' }
  });
  assert.throws(
    () => applyCliOverrides(chairOnly, parseArgs(['--local-only', 'задача'])),
    error => error instanceof UsageError && /anthropic\/claude/.test(error.message)
  );

  const local = mergeWithDefaults({
    experts: [
      { name: 'arch', model: 'ollama/llama3' },
      { name: 'ux', model: 'LMStudio/qwen' }
    ],
    chair: { agent: 'consilium', model: 'vllm/mistral' }
  });
  const applied = applyCliOverrides(local, parseArgs(['--local-only', 'задача']));
  assert.equal(applied.localOnly, true);
});

test('applyCliOverrides --deadline прокидывается в конфигурацию', () => {
  const applied = applyCliOverrides(
    mergeWithDefaults({}),
    parseArgs(['run', '--deadline', '4500', 'задача'])
  );
  assert.equal(applied.deadlineMs, 4500);
});

test('applyCliOverrides --preset docs применяет пользовательский пресет', () => {
  const config = mergeWithDefaults({
    experts: [{ name: 'arch' }, { name: 'ux' }, { name: 'ba' }],
    presets: {
      docs: { description: 'Документация', experts: ['arch', 'ba'] }
    }
  });

  const applied = applyCliOverrides(config, parseArgs(['--preset', 'docs', 'задача']));
  assert.deepEqual(applied.experts.map(expert => expert.name), ['arch', 'ba']);

  assert.throws(
    () => applyCliOverrides(config, parseArgs(['--preset', 'missing', 'задача'])),
    error => error instanceof UsageError && /docs/.test(error.message)
  );
});
