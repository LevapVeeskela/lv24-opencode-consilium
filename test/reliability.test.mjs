import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  formatReliabilityTable,
  loadReliability,
  recordModelAttempt,
  reliabilityBonus
} from '../dist/infrastructure/models/reliability.js';
import { rankFreeModels } from '../dist/domain/models/ranking.js';
import { callAgent } from '../dist/infrastructure/opencode/calls.js';

const TRUSTED_PROJECT_CONFIG = Symbol.for('lv24-opencode-consilium.trustedProjectConfig');

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), `consilium-${prefix}-`));
}

function makeEntry(overrides = {}) {
  return {
    attempts: 0,
    successes: 0,
    rateLimited: 0,
    timeouts: 0,
    unavailable: 0,
    empty: 0,
    otherErrors: 0,
    totalLatencyMs: 0,
    lastUsedAt: new Date(0).toISOString(),
    ...overrides
  };
}

function writeStore(dir, models) {
  const target = join(dir, '.consilium');
  mkdirSync(target, { recursive: true });
  writeFileSync(
    join(target, 'reliability.json'),
    `${JSON.stringify({ version: 1, models }, null, 2)}\n`,
    'utf8'
  );
}

function makeModel(overrides = {}) {
  return {
    id: 'opencode/test-free',
    providerID: 'opencode',
    modelID: 'test-free',
    name: 'Test Free',
    context: 128000,
    outputLimit: 32000,
    reasoning: true,
    toolCall: true,
    structuredOutput: true,
    releaseDate: '2026-10-01',
    score: 0,
    available: true,
    source: 'builtin',
    ...overrides
  };
}

function makeFakeOpenCode(dir) {
  const script = join(dir, 'fake-opencode.js');
  const source = [
    "let input = '';",
    "process.stdin.setEncoding('utf8');",
    'process.stdin.on("data", chunk => { input += chunk; });',
    'process.stdin.on("end", () => {',
    '  process.stdout.write(JSON.stringify({ type: "text", part: { text: "ok" } }) + "\\n");',
    '});',
    ''
  ].join('\n');
  writeFileSync(script, source, 'utf8');

  if (process.platform === 'win32') {
    const shim = join(dir, 'fake-opencode.cmd');
    writeFileSync(
      shim,
      `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`,
      'utf8'
    );
    return shim;
  }

  const shim = join(dir, 'fake-opencode');
  writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, 'utf8');
  chmodSync(shim, 0o755);
  return shim;
}

function makeConfig(dir, opencodePath, hooks) {
  const config = {
    opencodePath,
    cwd: dir,
    standalone: true,
    experts: [],
    chair: { agent: 'consilium' },
    retry: { expertRetries: 0, chairRetries: 0, delay: 1 },
    timeouts: { expert: 10000, chair: 10000 },
    output: { format: 'text', file: false, progress: false, logLevel: 'info' },
    hooks
  };
  config[TRUSTED_PROJECT_CONFIG] = true;
  return config;
}

test('record/load: круговой обход и счётчики всех категорий', () => {
  const dir = tempDir('reliability-roundtrip');
  try {
    recordModelAttempt({ model: 'opencode/model-a', ok: true, latencyMs: 120, dir });
    recordModelAttempt({
      model: 'opencode/model-a',
      ok: false,
      errorCode: 'RATE_LIMITED',
      latencyMs: 80,
      dir
    });
    recordModelAttempt({
      model: 'opencode/model-a',
      ok: false,
      errorCode: 'TIMEOUT',
      latencyMs: 30,
      dir
    });
    recordModelAttempt({
      model: 'opencode/model-a',
      ok: false,
      errorCode: 'MODEL_UNAVAILABLE',
      latencyMs: 10,
      dir
    });
    recordModelAttempt({
      model: 'opencode/model-a',
      ok: false,
      errorCode: 'EMPTY_RESPONSE',
      latencyMs: 5,
      dir
    });
    recordModelAttempt({
      model: 'opencode/model-a',
      ok: false,
      errorCode: 'EXIT_ERROR',
      latencyMs: 5,
      dir
    });

    const file = join(dir, '.consilium', 'reliability.json');
    assert.equal(existsSync(file), true);
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(raw.version, 1);

    const store = loadReliability(dir);
    assert.equal(store.version, 1);
    const entry = store.models['opencode/model-a'];
    assert.ok(entry);
    assert.equal(entry.attempts, 6);
    assert.equal(entry.successes, 1);
    assert.equal(entry.rateLimited, 1);
    assert.equal(entry.timeouts, 1);
    assert.equal(entry.unavailable, 1);
    assert.equal(entry.empty, 1);
    assert.equal(entry.otherErrors, 1);
    assert.equal(entry.totalLatencyMs, 250);
    assert.equal(new Date(entry.lastUsedAt).toISOString(), entry.lastUsedAt);

    const table = formatReliabilityTable(store);
    assert.match(table, /opencode\/model-a/);
    assert.match(table, /Успешность/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('load: отсутствующий и повреждённый файл дают пустую статистику', () => {
  const dir = tempDir('reliability-corrupt');
  try {
    assert.deepEqual(loadReliability(dir), { version: 1, models: {} });

    const consiliumDir = join(dir, '.consilium');
    mkdirSync(consiliumDir, { recursive: true });
    writeFileSync(join(consiliumDir, 'reliability.json'), '{ это не JSON', 'utf8');
    assert.deepEqual(loadReliability(dir), { version: 1, models: {} });

    writeFileSync(
      join(consiliumDir, 'reliability.json'),
      JSON.stringify({ version: 1, models: [] }),
      'utf8'
    );
    assert.deepEqual(loadReliability(dir), { version: 1, models: {} });

    // Повреждённый файл перезаписывается следующей успешной попыткой.
    recordModelAttempt({ model: 'opencode/recovered', ok: true, latencyMs: 1, dir });
    const store = loadReliability(dir);
    assert.equal(store.models['opencode/recovered'].attempts, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('LRU: в файле остаётся не больше 200 моделей, новые вытесняют старые', () => {
  const dir = tempDir('reliability-lru');
  try {
    const base = Date.parse('2026-01-01T00:00:00.000Z');
    const models = {};
    for (let index = 0; index < 201; index += 1) {
      models[`opencode/model-${String(index).padStart(3, '0')}`] = makeEntry({
        attempts: 1,
        successes: 1,
        lastUsedAt: new Date(base + index * 1000).toISOString()
      });
    }
    writeStore(dir, models);

    // Загрузка сама применяет лимит: самая старая запись отбрасывается.
    const loaded = loadReliability(dir);
    assert.equal(Object.keys(loaded.models).length, 200);
    assert.equal(loaded.models['opencode/model-000'], undefined);

    recordModelAttempt({
      model: 'opencode/newest',
      ok: true,
      latencyMs: 1,
      dir
    });
    const after = loadReliability(dir);
    assert.equal(Object.keys(after.models).length, 200);
    assert.ok(after.models['opencode/newest']);
    assert.equal(after.models['opencode/model-001'], undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reliabilityBonus: нет данных → 0, успех > 0, rate limit < 0, диапазон зажат', () => {
  const empty = { version: 1, models: {} };
  assert.equal(reliabilityBonus('opencode/model-a', empty), 0);
  assert.equal(reliabilityBonus('opencode/model-a'), 0);
  assert.equal(
    reliabilityBonus('opencode/model-a', {
      version: 1,
      models: {
        'opencode/model-a': makeEntry({ attempts: 2, successes: 2 })
      }
    }),
    0
  );

  const high = reliabilityBonus('opencode/model-a', {
    version: 1,
    models: {
      'opencode/model-a': makeEntry({ attempts: 10, successes: 10 })
    }
  });
  assert.ok(high > 0, `ожидался положительный бонус, получено ${high}`);
  assert.equal(high, 0.05);

  const smallSample = reliabilityBonus('opencode/model-a', {
    version: 1,
    models: {
      'opencode/model-a': makeEntry({ attempts: 3, successes: 3 })
    }
  });
  assert.ok(smallSample > 0);
  assert.ok(smallSample < high);

  const rateLimited = reliabilityBonus('opencode/model-a', {
    version: 1,
    models: {
      'opencode/model-a': makeEntry({ attempts: 10, rateLimited: 10 })
    }
  });
  assert.ok(rateLimited < 0);
  assert.equal(rateLimited, -0.05);

  const mixed = reliabilityBonus('opencode/model-a', {
    version: 1,
    models: {
      'opencode/model-a': makeEntry({
        attempts: 4,
        successes: 1,
        rateLimited: 3
      })
    }
  });
  assert.ok(mixed < 0);
  assert.ok(mixed > -0.05);

  const extreme = reliabilityBonus('opencode/model-a', {
    version: 1,
    models: {
      'opencode/model-a': makeEntry({
        attempts: 100000,
        successes: 99999,
        timeouts: 1,
        unavailable: 1,
        rateLimited: 100000
      })
    }
  });
  assert.ok(extreme >= -0.05 && extreme <= 0.05);
});

test('атомарная запись: валидный JSON без временных файлов', () => {
  const dir = tempDir('reliability-atomic');
  try {
    recordModelAttempt({ model: 'opencode/atomic', ok: true, latencyMs: 10, dir });
    recordModelAttempt({ model: 'opencode/atomic', ok: true, latencyMs: 20, dir });

    const consiliumDir = join(dir, '.consilium');
    assert.deepEqual(readdirSync(consiliumDir), ['reliability.json']);
    const raw = readFileSync(join(consiliumDir, 'reliability.json'), 'utf8');
    const parsed = JSON.parse(raw);
    assert.equal(parsed.models['opencode/atomic'].attempts, 2);
    assert.equal(parsed.models['opencode/atomic'].totalLatencyMs, 30);
    assert.ok(raw.endsWith('\n'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ranking: бонус применяется только при переданной статистике', () => {
  const first = makeModel({
    id: 'one/one-free',
    providerID: 'one',
    modelID: 'one-free',
    name: 'One Free'
  });
  const second = makeModel({
    id: 'two/two-free',
    providerID: 'two',
    modelID: 'two-free',
    name: 'Two Free'
  });

  const baseline = rankFreeModels([first, second]);
  assert.deepEqual(
    baseline.map(model => model.id),
    ['one/one-free', 'two/two-free']
  );
  assert.equal(baseline[0].score, baseline[1].score);

  const store = {
    version: 1,
    models: {
      'one/one-free': makeEntry({ attempts: 10, rateLimited: 10 }),
      'two/two-free': makeEntry({ attempts: 10, successes: 10 })
    }
  };
  const ranked = rankFreeModels([first, second], { reliability: store });
  assert.deepEqual(
    ranked.map(model => model.id),
    ['two/two-free', 'one/one-free']
  );

  const firstBaseline = baseline.find(model => model.id === 'one/one-free');
  const firstRanked = ranked.find(model => model.id === 'one/one-free');
  const secondBaseline = baseline.find(model => model.id === 'two/two-free');
  const secondRanked = ranked.find(model => model.id === 'two/two-free');
  assert.ok(Math.abs(firstRanked.score - (firstBaseline.score - 0.05)) < 1e-9);
  assert.ok(Math.abs(secondRanked.score - (secondBaseline.score + 0.05)) < 1e-9);
});

test('calls: успешная попытка записывается, ошибка записи не ломает запуск', async () => {
  const dir = tempDir('reliability-calls');
  try {
    const opencodePath = makeFakeOpenCode(dir);
    const result = await callAgent('', 'task', makeConfig(dir, opencodePath), {
      retries: 0,
      model: 'opencode/stub-model'
    });
    assert.equal(result.success, true);

    const store = loadReliability(dir);
    const entry = store.models['opencode/stub-model'];
    assert.ok(entry);
    assert.equal(entry.attempts, 1);
    assert.equal(entry.successes, 1);
    assert.ok(entry.totalLatencyMs >= 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('calls: запись статистики best-effort не бросает при недоступном каталоге', async () => {
  const dir = tempDir('reliability-readonly');
  try {
    const opencodePath = makeFakeOpenCode(dir);
    // Файл вместо каталога .consilium надёжно ломает запись на любой ОС.
    writeFileSync(join(dir, '.consilium'), 'blocked', 'utf8');

    const logged = [];
    const config = makeConfig(dir, opencodePath, {
      onLog: (level, message) => logged.push({ level, message })
    });
    const result = await callAgent('', 'task', config, {
      retries: 0,
      model: 'opencode/stub-model'
    });
    assert.equal(result.success, true);
    assert.ok(
      logged.some(item => item.level === 'warn' && /статистик/i.test(item.message)),
      'ошибка записи должна логироваться как предупреждение'
    );

    let recordedError;
    assert.doesNotThrow(() => {
      recordModelAttempt({
        model: 'opencode/stub-model',
        ok: true,
        latencyMs: 1,
        dir,
        onError: error => {
          recordedError = error;
        }
      });
    });
    assert.ok(recordedError, 'ошибка записи должна передаваться в onError');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
