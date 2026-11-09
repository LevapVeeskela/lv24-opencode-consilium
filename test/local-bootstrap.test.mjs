import test from 'node:test';
import assert from 'node:assert/strict';
import { probeLocalProviders } from '../dist/infrastructure/local-models.js';
import {
  DEFAULT_LOCAL_CHAIR,
  DEFAULT_LOCAL_ROLES,
  buildLocalBootstrap,
  buildLocalConfig,
  formatLocalBootstrap
} from '../dist/application/local-bootstrap.js';

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : status === 500 ? 'Internal Server Error' : '',
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

function probeResult(provider, modelIds, overrides = {}) {
  return {
    provider,
    url:
      provider === 'ollama'
        ? 'http://127.0.0.1:11434/api/tags'
        : 'http://127.0.0.1:1234/v1/models',
    ok: true,
    models: modelIds.length,
    modelIds,
    ...overrides
  };
}

test('probeLocalProviders извлекает modelIds Ollama и LM Studio', async () => {
  await withFetch(
    async url =>
      String(url).includes('11434')
        ? jsonResponse({
            models: [
              { name: 'llama3:latest' },
              { name: ' qwen ' },
              { name: 42 },
              { name: '' },
              null
            ]
          })
        : jsonResponse({
            data: [{ id: 'qwen2.5' }, { id: 'mistral' }, { id: 7 }, { id: '   ' }]
          }),
    async () => {
      const results = await probeLocalProviders({ timeoutMs: 1000 });
      const ollama = results.find(result => result.provider === 'ollama');
      const lmstudio = results.find(result => result.provider === 'lmstudio');

      assert.ok(ollama.ok);
      assert.equal(ollama.models, 5);
      assert.deepEqual(ollama.modelIds, ['llama3:latest', 'qwen']);

      assert.ok(lmstudio.ok);
      assert.equal(lmstudio.models, 4);
      assert.deepEqual(lmstudio.modelIds, ['qwen2.5', 'mistral']);
    }
  );
});

test('probeLocalProviders терпит некорректные payload без modelIds', async () => {
  await withFetch(
    async url =>
      String(url).includes('11434')
        ? jsonResponse({ models: 'not-an-array' })
        : jsonResponse({ data: { id: 'qwen' } }),
    async () => {
      const results = await probeLocalProviders({ timeoutMs: 1000 });

      for (const result of results) {
        assert.equal(result.ok, true);
        assert.equal(result.models, 0);
        assert.deepEqual(result.modelIds, []);
      }
    }
  );

  await withFetch(
    async url =>
      String(url).includes('11434')
        ? jsonResponse([{ name: 'array-ollama' }])
        : jsonResponse([{ id: 'array-lmstudio' }]),
    async () => {
      const results = await probeLocalProviders({ timeoutMs: 1000 });
      const ollama = results.find(result => result.provider === 'ollama');
      const lmstudio = results.find(result => result.provider === 'lmstudio');

      assert.deepEqual(ollama.modelIds, ['array-ollama']);
      assert.deepEqual(lmstudio.modelIds, ['array-lmstudio']);
    }
  );
});

test('probeLocalProviders ограничивает modelIds двумястами', async () => {
  const ollamaModels = Array.from({ length: 250 }, (_, index) => ({ name: `m${index}` }));
  const lmstudioModels = Array.from({ length: 220 }, (_, index) => ({ id: `lm${index}` }));

  await withFetch(
    async url =>
      String(url).includes('11434')
        ? jsonResponse({ models: ollamaModels })
        : jsonResponse({ data: lmstudioModels }),
    async () => {
      const results = await probeLocalProviders({ timeoutMs: 1000 });
      const ollama = results.find(result => result.provider === 'ollama');
      const lmstudio = results.find(result => result.provider === 'lmstudio');

      assert.equal(ollama.models, 250);
      assert.equal(ollama.modelIds.length, 200);
      assert.equal(ollama.modelIds[0], 'm0');
      assert.equal(ollama.modelIds[199], 'm199');

      assert.equal(lmstudio.models, 220);
      assert.equal(lmstudio.modelIds.length, 200);
      assert.equal(lmstudio.modelIds[199], 'lm199');
    }
  );
});

test('probeLocalProviders возвращает пустые modelIds при HTTP-ошибке', async () => {
  await withFetch(
    async () => jsonResponse({}, 500),
    async () => {
      const results = await probeLocalProviders({ timeoutMs: 1000 });

      for (const result of results) {
        assert.equal(result.ok, false);
        assert.equal(result.models, 0);
        assert.deepEqual(result.modelIds, []);
      }
    }
  );
});

test('buildLocalBootstrap: одна модель на все роли и председателя', () => {
  const result = buildLocalBootstrap({
    providers: [probeResult('ollama', ['llama3'])]
  });

  assert.equal(result.ok, true);
  assert.deepEqual(
    result.experts.map(expert => expert.name),
    [...DEFAULT_LOCAL_ROLES]
  );
  assert.ok(result.experts.every(expert => expert.model === 'ollama/llama3'));
  assert.deepEqual(result.chair, { agent: DEFAULT_LOCAL_CHAIR, model: 'ollama/llama3' });
  assert.deepEqual(result.models, ['ollama/llama3']);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /reuse/i);
});

test('buildLocalBootstrap: две модели распределяются по кругу', () => {
  const result = buildLocalBootstrap({
    providers: [probeResult('ollama', ['a', 'b'])]
  });

  assert.equal(result.ok, true);
  assert.deepEqual(
    result.experts.map(expert => expert.model),
    ['ollama/a', 'ollama/b', 'ollama/a', 'ollama/b']
  );
  assert.equal(result.chair.model, 'ollama/a');
  assert.deepEqual(result.models, ['ollama/a', 'ollama/b']);
  assert.equal(result.warnings.length, 1);
});

test('buildLocalBootstrap: пяти моделей хватает на роли и председателя', () => {
  const result = buildLocalBootstrap({
    providers: [probeResult('ollama', ['m1', 'm2', 'm3', 'm4', 'm5'])]
  });

  assert.equal(result.ok, true);
  assert.deepEqual(
    result.experts.map(expert => expert.model),
    ['ollama/m1', 'ollama/m2', 'ollama/m3', 'ollama/m4']
  );
  assert.equal(result.chair.model, 'ollama/m5');
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.models, [
    'ollama/m1',
    'ollama/m2',
    'ollama/m3',
    'ollama/m4',
    'ollama/m5'
  ]);
});

test('buildLocalBootstrap: префиксы провайдеров, роли и председатель настраиваются', () => {
  const providers = [
    probeResult('ollama', ['a']),
    probeResult('lmstudio', ['ignored'], { ok: false, error: 'HTTP 500' }),
    probeResult('ollama', [], { models: 0 }),
    probeResult('lmstudio', ['c'])
  ];

  const result = buildLocalBootstrap({
    providers,
    roles: ['alpha', 'beta', 'gamma'],
    chair: 'moderator'
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.models, ['ollama/a', 'lmstudio/c']);
  assert.deepEqual(result.experts, [
    { name: 'alpha', model: 'ollama/a' },
    { name: 'beta', model: 'lmstudio/c' },
    { name: 'gamma', model: 'ollama/a' }
  ]);
  assert.deepEqual(result.chair, { agent: 'moderator', model: 'lmstudio/c' });
});

test('buildLocalBootstrap: без доступных моделей возвращает typed error', () => {
  const providers = [
    probeResult('ollama', [], { models: 0 }),
    probeResult('lmstudio', [], { ok: false, models: 0, error: 'HTTP 500' })
  ];

  const result = buildLocalBootstrap({ providers });

  assert.deepEqual(result, {
    ok: false,
    reason: 'no-local-models',
    providers
  });
  assert.equal(result.providers, providers);
});

test('buildLocalConfig: experts, chair, localOnly и autoDiscoverAgents', () => {
  const result = buildLocalBootstrap({
    providers: [probeResult('lmstudio', ['qwen', 'mistral'])]
  });

  assert.equal(result.ok, true);
  const config = buildLocalConfig(result);

  assert.equal(config.localOnly, true);
  assert.equal(config.autoDiscoverAgents, false);
  assert.deepEqual(config.experts, [
    { name: 'arch', model: 'lmstudio/qwen' },
    { name: 'ux', model: 'lmstudio/mistral' },
    { name: 'ba', model: 'lmstudio/qwen' },
    { name: 'sec', model: 'lmstudio/mistral' }
  ]);
  assert.deepEqual(config.chair, { agent: DEFAULT_LOCAL_CHAIR, model: 'lmstudio/qwen' });
});

test('buildLocalConfig сохраняет base и не изменяет его', () => {
  const result = buildLocalBootstrap({
    providers: [probeResult('ollama', ['a', 'b', 'c', 'd', 'e'])]
  });
  assert.equal(result.ok, true);

  const base = {
    version: '1.0.0',
    experts: [{ name: 'old', model: 'openai/old', prompt: 'old prompt' }],
    chair: { agent: 'old-chair', model: 'openai/old', timeout: 123 },
    timeouts: { expert: 1000, chair: 2000, shutdown: 3000 },
    retry: {
      expertRetries: 1,
      chairRetries: 1,
      delay: 10,
      exponentialBackoff: false,
      maxConcurrency: 2
    },
    output: { file: false, format: 'text', progress: false, logLevel: 'error' },
    localOnly: false,
    autoDiscoverAgents: true
  };
  const snapshot = structuredClone(base);

  const config = buildLocalConfig(result, base);

  assert.notEqual(config, base);
  assert.equal(config.version, '1.0.0');
  assert.equal(config.timeouts, base.timeouts);
  assert.equal(config.retry, base.retry);
  assert.equal(config.output, base.output);
  assert.equal(config.localOnly, true);
  assert.equal(config.autoDiscoverAgents, false);
  assert.deepEqual(config.experts, result.experts);
  assert.deepEqual(config.chair, result.chair);
  assert.notEqual(config.experts, base.experts);
  assert.notEqual(config.chair, base.chair);

  assert.deepEqual(base, snapshot);
  assert.equal(base.localOnly, false);
  assert.equal(base.autoDiscoverAgents, true);
  assert.equal(base.experts[0].model, 'openai/old');
  assert.equal(base.chair.agent, 'old-chair');
});

test('formatLocalBootstrap выводит роли, модели и предупреждения', () => {
  const result = buildLocalBootstrap({
    providers: [probeResult('ollama', ['a']), probeResult('lmstudio', ['b'])]
  });
  assert.equal(result.ok, true);

  const text = formatLocalBootstrap(result);

  assert.match(text, /arch → ollama\/a/);
  assert.match(text, /ux → lmstudio\/b/);
  assert.match(text, /ba → ollama\/a/);
  assert.match(text, /sec → lmstudio\/b/);
  assert.match(text, /chair \(consilium\) → ollama\/a/);
  assert.match(text, /Warnings:/);
  assert.match(text, /reuse/i);

  const noWarnings = buildLocalBootstrap({
    providers: [probeResult('ollama', ['m1', 'm2', 'm3', 'm4', 'm5'])]
  });
  assert.equal(noWarnings.ok, true);
  assert.doesNotMatch(formatLocalBootstrap(noWarnings), /Warnings:/);
});

test('formatLocalBootstrap объясняет отсутствие локальных моделей', () => {
  const result = buildLocalBootstrap({
    providers: [
      probeResult('ollama', [], { models: 0 }),
      probeResult('lmstudio', [], { ok: false, models: 0, error: 'HTTP 500' })
    ]
  });
  assert.equal(result.ok, false);

  const text = formatLocalBootstrap(result);

  assert.match(text, /no-local-models/);
  assert.match(text, /ollama: ok, 0 model\(s\)/);
  assert.match(text, /lmstudio: fail, 0 model\(s\): HTTP 500/);
});
