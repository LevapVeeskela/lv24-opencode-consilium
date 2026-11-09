import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchFreeModels } from '../dist/models.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function model(overrides = {}) {
  return {
    id: 'cache/keeper-free',
    providerID: 'cache',
    modelID: 'keeper-free',
    name: 'Keeper Free',
    context: 200000,
    outputLimit: 32000,
    reasoning: true,
    toolCall: true,
    structuredOutput: true,
    releaseDate: '2026-10-01',
    canonicalID: 'keeper-free',
    score: 0.9,
    available: true,
    source: 'builtin',
    ...overrides
  };
}

function writeCache(file, models, fetchedAt = Date.now()) {
  writeFileSync(file, JSON.stringify({ fetchedAt, models, sources: [] }), 'utf8');
}

function modelsDevPayload(context) {
  return {
    acme: {
      models: {
        'big-free': {
          id: 'big-free',
          name: 'Big Free',
          tool_call: true,
          type: 'chat',
          cost: { input: 0, output: 0 },
          limit: { context, output: 128000 },
          release_date: '2026-10-01'
        }
      }
    }
  };
}

function sourceFetch(modelsDevData) {
  return async url => {
    const href = typeof url === 'string' ? url : String(url);
    let data;
    if (href.includes('models.dev')) data = modelsDevData;
    else if (href.includes('openrouter.ai')) data = { data: [] };
    else throw new Error(`unexpected URL: ${href}`);
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => data
    };
  };
}

async function offlineFetch() {
  throw new Error('network unavailable');
}

async function withSources(handler, run) {
  const dir = mkdtempSync(join(tmpdir(), 'consilium-models-source-'));
  const cachePath = join(dir, 'models-cache.json');
  const previousCache = process.env.CONSILIUM_MODELS_CACHE;
  const originalFetch = globalThis.fetch;
  process.env.CONSILIUM_MODELS_CACHE = cachePath;
  globalThis.fetch = handler;
  try {
    return await run({ dir, cachePath });
  } finally {
    globalThis.fetch = originalFetch;
    if (previousCache === undefined) delete process.env.CONSILIUM_MODELS_CACHE;
    else process.env.CONSILIUM_MODELS_CACHE = previousCache;
    rmSync(dir, { recursive: true, force: true });
  }
}

test('при сбое обоих источников используется уцелевший кэш', async () => {
  await withSources(offlineFetch, async ({ cachePath }) => {
    const cached = model();
    writeCache(cachePath, [cached], Date.now() - DAY_MS);

    const result = await fetchFreeModels();

    assert.equal(result.fromCache, true);
    assert.ok(result.sources.every(source => !source.ok));
    assert.ok(result.models.some(item => item.id === cached.id));
  });
});

test('forceRefresh при тотальном сбое не затирает кэш', async () => {
  await withSources(offlineFetch, async ({ cachePath }) => {
    const cached = model({
      id: 'cache/precious-free',
      modelID: 'precious-free',
      canonicalID: 'precious-free'
    });
    writeCache(cachePath, [cached], Date.now() - DAY_MS);
    const before = readFileSync(cachePath, 'utf8');

    const result = await fetchFreeModels({ forceRefresh: true });

    assert.equal(readFileSync(cachePath, 'utf8'), before);
    assert.equal(result.fromCache, true);
    assert.ok(result.models.some(item => item.id === cached.id));
  });
});

test('тотальный сбой без кэша возвращает builtins и не создаёт кэш', async () => {
  await withSources(offlineFetch, async ({ cachePath }) => {
    const result = await fetchFreeModels({ forceRefresh: true });

    assert.equal(result.fromCache, false);
    assert.equal(existsSync(cachePath), false);
    assert.ok(result.models.length > 0);
    assert.ok(result.models.every(item => item.source === 'builtin'));
  });
});

test('minContext одинаково применяется при свежей загрузке и из кэша', async () => {
  await withSources(sourceFetch(modelsDevPayload(1_000_000)), async () => {
    const options = { minContext: 500_000 };
    const first = await fetchFreeModels({ ...options, forceRefresh: true });

    assert.equal(first.fromCache, false);
    assert.ok(first.models.length > 0);
    for (const item of first.models) {
      assert.ok(item.context >= options.minContext, `${item.id} ниже minContext`);
    }

    const second = await fetchFreeModels(options);
    assert.equal(second.fromCache, true);
    assert.deepEqual(
      first.models.map(item => item.id).sort(),
      second.models.map(item => item.id).sort()
    );
    for (const item of second.models) {
      assert.ok(item.context >= options.minContext, `${item.id} ниже minContext`);
    }
  });
});
