import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LOCAL_PROVIDERS,
  assertLocalConfig,
  auditLocalOnly,
  filterLocalModels,
  findNonLocalModels,
  formatLocalProviders,
  isLocalModel,
  probeLocalProviders
} from '../dist/infrastructure/local-models.js';
import { rankFreeModels, selectCouncilModels } from '../dist/domain/models/ranking.js';

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

function model(overrides = {}) {
  return {
    id: 'openai/remote-free',
    providerID: 'openai',
    modelID: 'remote-free',
    name: 'Remote Free',
    context: 128000,
    outputLimit: 32000,
    reasoning: true,
    toolCall: true,
    structuredOutput: true,
    releaseDate: '2026-10-01',
    canonicalID: 'remote-free',
    score: 0.9,
    available: true,
    source: 'builtin',
    ...overrides
  };
}

const localPredicate = item => isLocalModel(item.id);

test('LOCAL_PROVIDERS содержит все поддерживаемые локальные провайдеры', () => {
  assert.deepEqual([...LOCAL_PROVIDERS], [
    'ollama',
    'lmstudio',
    'lm-studio',
    'local',
    'llamacpp',
    'llama.cpp',
    'vllm'
  ]);
});

test('isLocalModel определяет провайдера без учёта регистра', () => {
  for (const id of [
    'ollama/llama3',
    'OLLAMA/Llama3',
    'lmstudio/qwen',
    'LMStudio/qwen',
    'LM-Studio/qwen',
    'local/mistral',
    'llamacpp/phi3',
    'Llama.CPP/phi3',
    'vLLM/mistral',
    'ollama'
  ]) {
    assert.equal(isLocalModel(id), true, id);
  }

  for (const id of [
    'openai/gpt',
    'openai/gpt-4o',
    'anthropic/claude',
    'openrouter/ollama/llama3',
    'ollamaish/llama3',
    '/ollama',
    ''
  ]) {
    assert.equal(isLocalModel(id), false, id);
  }
});

test('filterLocalModels сохраняет порядок и не меняет исходный массив', () => {
  const models = [
    { id: 'openai/gpt-4o' },
    { id: 'ollama/llama3' },
    { id: 'lmstudio/qwen' },
    { id: 'vllm/mistral' },
    { id: 'anthropic/claude' }
  ];
  const before = models.map(item => item.id);

  const local = filterLocalModels(models);

  assert.deepEqual(local.map(item => item.id), [
    'ollama/llama3',
    'lmstudio/qwen',
    'vllm/mistral'
  ]);
  assert.equal(local[0], models[1]);
  assert.deepEqual(models.map(item => item.id), before);
});

test('filterLocalModels понимает объекты providerID/modelID без id', () => {
  const local = filterLocalModels([
    { providerID: 'ollama', modelID: 'llama3' },
    { providerID: 'openai', modelID: 'gpt-4o' }
  ]);
  assert.deepEqual(local, [{ providerID: 'ollama', modelID: 'llama3' }]);
});

test('probeLocalProviders считает модели Ollama и LM Studio', async () => {
  const calls = [];

  await withFetch(
    async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).includes('11434')) {
        return jsonResponse({ models: [{ name: 'llama3' }, { name: 'qwen' }, { name: 'phi3' }] });
      }
      return jsonResponse({ data: [{ id: 'qwen2.5' }, { id: 'mistral' }] });
    },
    async () => {
      const results = await probeLocalProviders({ timeoutMs: 1000 });

      assert.deepEqual(results.map(result => result.provider), ['ollama', 'lmstudio']);
      assert.deepEqual(results.map(result => result.url), [
        'http://127.0.0.1:11434/api/tags',
        'http://127.0.0.1:1234/v1/models'
      ]);
      assert.deepEqual(results.map(result => result.models), [3, 2]);
      assert.ok(results.every(result => result.ok));
      assert.ok(results.every(result => result.error === undefined));
      assert.equal(calls.length, 2);
      assert.ok(calls.every(call => call.init?.signal instanceof AbortSignal));
    }
  );
});

test('probeLocalProviders не бросает при HTTP 500', async () => {
  await withFetch(
    async url =>
      String(url).includes('11434')
        ? jsonResponse({}, 500)
        : jsonResponse({ data: [] }),
    async () => {
      const results = await probeLocalProviders({ timeoutMs: 1000 });
      const ollama = results.find(result => result.provider === 'ollama');
      const lmstudio = results.find(result => result.provider === 'lmstudio');

      assert.equal(ollama.ok, false);
      assert.equal(ollama.models, 0);
      assert.match(ollama.error, /HTTP 500/);

      assert.equal(lmstudio.ok, true);
      assert.equal(lmstudio.models, 0);
    }
  );
});

test('probeLocalProviders сообщает о таймауте', async () => {
  await withFetch(
    async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    },
    async () => {
      const results = await probeLocalProviders({ timeoutMs: 25 });

      assert.equal(results.length, 2);
      for (const result of results) {
        assert.equal(result.ok, false);
        assert.equal(result.models, 0);
        assert.match(result.error, /timeout/i);
      }
    }
  );
});

test('probeLocalProviders сообщает об отмене запроса', async () => {
  await withFetch(
    async () => {
      throw new DOMException('The operation was aborted', 'AbortError');
    },
    async () => {
      const results = await probeLocalProviders({ timeoutMs: 1000 });

      assert.equal(results.length, 2);
      for (const result of results) {
        assert.equal(result.ok, false);
        assert.match(result.error, /abort/i);
      }
    }
  );
});

test('probeLocalProviders не бросает при неожиданном ответе', async () => {
  await withFetch(
    async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => {
        throw new Error('invalid json');
      }
    }),
    async () => {
      const results = await probeLocalProviders({ timeoutMs: 1000 });
      assert.equal(results.length, 2);
      assert.ok(results.every(result => !result.ok));
      assert.ok(results.every(result => /invalid json/.test(result.error)));
    }
  );
});

test('formatLocalProviders выводит провайдеров, статус, модели и ошибку', () => {
  const text = formatLocalProviders([
    {
      provider: 'ollama',
      url: 'http://127.0.0.1:11434/api/tags',
      ok: true,
      models: 3
    },
    {
      provider: 'lmstudio',
      url: 'http://127.0.0.1:1234/v1/models',
      ok: false,
      models: 0,
      error: 'HTTP 500 Internal Server Error'
    }
  ]);

  const lines = text.split('\n');
  assert.equal(lines.length, 3);
  assert.match(lines[0], /provider/i);
  assert.match(lines[1], /ollama/);
  assert.match(lines[1], /\bok\b/);
  assert.match(lines[1], /\b3\b/);
  assert.match(lines[1], /http:\/\/127\.0\.0\.1:11434\/api\/tags/);
  assert.match(lines[2], /lmstudio/);
  assert.match(lines[2], /\bfail\b/);
  assert.match(lines[2], /HTTP 500/);
  assert.equal(formatLocalProviders([]), 'No local providers.');
});

test('findNonLocalModels возвращает нелокальные ссылки в исходном порядке', () => {
  assert.deepEqual(
    findNonLocalModels([
      'ollama/llama3',
      'openai/gpt-4o',
      'LMStudio/qwen',
      'anthropic/claude'
    ]),
    ['openai/gpt-4o', 'anthropic/claude']
  );
  assert.deepEqual(findNonLocalModels(['ollama/llama3', 'vllm/mistral']), []);
});

test('assertLocalConfig пропускает локальные и отклоняет нелокальные модели', () => {
  assert.doesNotThrow(() =>
    assertLocalConfig(['ollama/llama3', 'LMStudio/qwen', 'llama.cpp/phi3'])
  );
  assert.throws(
    () => assertLocalConfig(['ollama/llama3', 'openai/gpt-4o']),
    /openai\/gpt-4o/
  );
});

test('rankFreeModels фильтрует по localOnly и предикату', () => {
  const remote = model({
    id: 'openai/gpt-4o',
    providerID: 'openai',
    modelID: 'gpt-4o',
    name: 'GPT 4o',
    canonicalID: 'gpt-4o',
    context: 400000,
    score: 2
  });
  const ollama = model({
    id: 'ollama/llama3',
    providerID: 'ollama',
    modelID: 'llama3',
    name: 'Llama 3',
    canonicalID: 'llama3',
    context: 8192,
    score: 0.5
  });
  const lmstudio = model({
    id: 'lmstudio/qwen',
    providerID: 'lmstudio',
    modelID: 'qwen',
    name: 'Qwen',
    canonicalID: 'qwen',
    context: 8192,
    score: 0.4
  });

  const ranked = rankFreeModels([remote, ollama, lmstudio], {
    localOnly: true,
    local: localPredicate
  });
  assert.deepEqual(
    ranked.map(item => item.id).sort(),
    ['lmstudio/qwen', 'ollama/llama3']
  );

  const predicateOnly = rankFreeModels([remote, ollama], { local: localPredicate });
  assert.deepEqual(predicateOnly.map(item => item.id), ['ollama/llama3']);

  const unfiltered = rankFreeModels([remote, ollama]);
  assert.ok(unfiltered.some(item => item.id === 'openai/gpt-4o'));
  assert.ok(unfiltered.some(item => item.id === 'ollama/llama3'));
});

test('selectCouncilModels не выбирает удалённые модели при локальном фильтре', () => {
  const remote = model({
    id: 'openai/gpt-4o',
    providerID: 'openai',
    modelID: 'gpt-4o',
    name: 'GPT 4o',
    canonicalID: 'gpt-4o',
    score: 2
  });
  const ollama = model({
    id: 'ollama/llama3',
    providerID: 'ollama',
    modelID: 'llama3',
    name: 'Llama 3',
    canonicalID: 'llama3',
    score: 0.5
  });
  const lmstudio = model({
    id: 'lmstudio/qwen',
    providerID: 'lmstudio',
    modelID: 'qwen',
    name: 'Qwen',
    canonicalID: 'qwen',
    score: 0.4
  });

  const selected = selectCouncilModels([remote, ollama, lmstudio], 2, {
    localOnly: true,
    local: localPredicate
  });

  assert.equal(selected.length, 2);
  assert.ok(selected.every(item => isLocalModel(item.id)));
  assert.deepEqual(selected.map(item => item.providerID).sort(), ['lmstudio', 'ollama']);

  const onlyOneLocal = selectCouncilModels([remote, ollama], 2, {
    local: localPredicate
  });
  assert.deepEqual(onlyOneLocal.map(item => item.id), ['ollama/llama3']);
});

test('auditLocalOnly: missing-модели и нелокальные провайдеры', () => {
  assert.deepEqual(auditLocalOnly([]), { missing: [], nonLocal: [] });

  const audit = auditLocalOnly([
    { label: 'arch', model: 'ollama/llama3' },
    { label: 'sec', model: 'openai/gpt-4o' },
    { label: 'ba' },
    { label: 'chair', model: '   ' }
  ]);

  assert.deepEqual(audit.missing, ['ba', 'chair']);
  assert.deepEqual(audit.nonLocal, ['openai/gpt-4o']);
});
