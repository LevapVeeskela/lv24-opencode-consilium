import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getMcpTools, handleMcpRequest } from '../dist/mcp.js';
import { mergeWithDefaults } from '../dist/config.js';
import { checkLocalProviders, runDoctor } from '../dist/doctor.js';
import { formatConsiliumResult } from '../dist/interfaces/mcp/handlers/run.js';

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), `consilium-${prefix}-`));
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

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : status === 500 ? 'Internal Server Error' : '',
    json: async () => body
  };
}

function cachedModel(id) {
  const slash = id.indexOf('/');
  return {
    id,
    providerID: slash === -1 ? id : id.slice(0, slash),
    modelID: slash === -1 ? id : id.slice(slash + 1),
    name: id,
    context: 128000,
    outputLimit: 32000,
    reasoning: false,
    toolCall: true,
    structuredOutput: false,
    releaseDate: '2026-10-01',
    canonicalID: id,
    score: 0.5,
    available: true,
    source: 'builtin'
  };
}

async function withCwd(directory, run) {
  const previous = process.cwd();
  process.chdir(directory);
  try {
    return await run();
  } finally {
    process.chdir(previous);
  }
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

function callTool(name, args = {}) {
  return handleMcpRequest({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name, arguments: args }
  });
}

test('MCP-схемы 1.7: deadline_ms/local_only и local_only/probe_local', () => {
  const tools = getMcpTools();
  const run = tools.find(tool => tool.name === 'consilium_run');
  const freeModels = tools.find(tool => tool.name === 'consilium_free_models');

  assert.ok(run);
  assert.equal(run.inputSchema.properties.deadline_ms.type, 'integer');
  assert.equal(run.inputSchema.properties.deadline_ms.minimum, 1);
  assert.equal(run.inputSchema.properties.local_only.type, 'boolean');

  assert.ok(freeModels);
  assert.equal(freeModels.inputSchema.properties.local_only.type, 'boolean');
  assert.equal(freeModels.inputSchema.properties.probe_local.type, 'boolean');
});

test('consilium_run: local_only отклоняет облачные модели до запуска', async t => {
  const dir = tempDir('mcp-local-only');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeConfig(dir, {
    opencodePath: join(dir, 'missing-opencode'),
    experts: [{ name: 'arch', model: 'openai/gpt-4o' }],
    chair: { agent: 'consilium', model: 'anthropic/claude-3-7-sonnet' }
  });

  await withCwd(dir, async () => {
    const response = await callTool('consilium_run', {
      task: 'проверь локальный режим',
      local_only: true
    });

    assert.equal(response.result.isError, true);
    const text = response.result.content[0].text;
    assert.match(text, /local/i);
    assert.match(text, /openai\/gpt-4o/);
    assert.match(text, /anthropic\/claude-3-7-sonnet/);
    // Если бы запуск начался, он упал бы на отсутствующем OpenCode CLI,
    // а не перечислил бы обе нелокальные модели.
    assert.doesNotMatch(text, /OpenCode CLI не найден/);
  });
});

test('consilium_run: local_only требует явную модель у каждого агента', async t => {
  const dir = tempDir('mcp-local-missing');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeConfig(dir, {
    opencodePath: join(dir, 'missing-opencode'),
    experts: [{ name: 'arch', model: 'ollama/llama3' }, { name: 'sec' }],
    chair: { agent: 'consilium' }
  });

  await withCwd(dir, async () => {
    const response = await callTool('consilium_run', {
      task: 'проверь локальный режим',
      local_only: true
    });

    assert.equal(response.result.isError, true);
    const text = response.result.content[0].text;
    assert.match(text, /Missing/i);
    assert.match(text, /sec/);
    assert.match(text, /consilium/);
  });
});

test('consilium_run: custom preset из конфига распознаётся, неизвестный — отклоняется', async t => {
  const dir = tempDir('mcp-custom-preset');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeConfig(dir, {
    opencodePath: join(dir, 'missing-opencode'),
    experts: [
      { name: 'arch', model: 'ollama/llama3' },
      { name: 'ba', model: 'ollama/qwen' }
    ],
    chair: { agent: 'consilium', model: 'ollama/llama3' },
    presets: {
      docs: { description: 'Documentation review', experts: ['arch', 'ba'] }
    }
  });

  await withCwd(dir, async () => {
    const unknown = await callTool('consilium_run', {
      task: 'проверь пресеты',
      preset: 'nope'
    });
    assert.equal(unknown.result.isError, true);
    assert.match(unknown.result.content[0].text, /Unknown preset/);
    assert.match(unknown.result.content[0].text, /docs/);

    const custom = await callTool('consilium_run', {
      task: 'проверь пресеты',
      preset: 'docs'
    });
    assert.doesNotMatch(custom.result.content[0].text, /Unknown preset/);
  });
});

test('formatConsiliumResult включает deadlineMs и localOnly в JSON-сводку', () => {
  const config = mergeWithDefaults({ deadlineMs: 4500, localOnly: true });
  const result = {
    text: 'Готово',
    experts: [],
    chair: { agent: 'consilium', text: 'Готово', success: true },
    totalTime: 10,
    parallelTime: 5,
    success: true
  };

  const text = formatConsiliumResult(result, config);
  const match = /```json\n([\s\S]*?)\n```/.exec(text);
  assert.ok(match, text);

  const summary = JSON.parse(match[1]);
  assert.equal(summary.deadlineMs, 4500);
  assert.equal(summary.localOnly, true);
});

test('consilium_free_models: local_only + probe_local, таблица и JSON localProviders', async t => {
  const dir = tempDir('mcp-free-local');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cachePath = join(dir, 'models-cache.json');
  writeFileSync(
    cachePath,
    JSON.stringify({
      fetchedAt: Date.now(),
      models: [
        cachedModel('openai/gpt-4o'),
        cachedModel('ollama/llama3'),
        cachedModel('lmstudio/qwen')
      ],
      sources: []
    }),
    'utf8'
  );

  const previousCache = process.env.CONSILIUM_MODELS_CACHE;
  process.env.CONSILIUM_MODELS_CACHE = cachePath;
  t.after(() => {
    if (previousCache === undefined) delete process.env.CONSILIUM_MODELS_CACHE;
    else process.env.CONSILIUM_MODELS_CACHE = previousCache;
  });

  await withFetch(
    async url => {
      if (String(url).includes('11434')) {
        return jsonResponse({ models: [{ name: 'llama3' }] });
      }
      return jsonResponse({}, 500);
    },
    async () => {
      const response = await callTool('consilium_free_models', {
        local_only: true,
        probe_local: true
      });
      assert.notEqual(response.result.isError, true);
      const text = response.result.content[0].text;

      assert.match(text, /ollama\/llama3/);
      assert.match(text, /lmstudio\/qwen/);
      assert.doesNotMatch(text, /openai\/gpt-4o/);
      assert.match(text, /provider\tstatus\tmodels\turl/);
      assert.match(text, /ollama\tok\t1/);
      assert.match(text, /lmstudio\tfail\t0/);
      assert.match(text, /HTTP 500/);

      const jsonResponseResult = await callTool('consilium_free_models', {
        local_only: true,
        probe_local: true,
        format: 'json'
      });
      const payload = JSON.parse(jsonResponseResult.result.content[0].text);

      assert.deepEqual(
        payload.models.map(model => model.id).sort(),
        ['lmstudio/qwen', 'ollama/llama3']
      );
      assert.deepEqual(
        payload.localProviders.map(item => item.provider),
        ['ollama', 'lmstudio']
      );
      assert.deepEqual(
        payload.localProviders.map(item => item.models),
        [1, 0]
      );
      assert.ok(payload.localProviders.every(item => item.ok === false || item.ok === true));
      assert.equal(payload.localProviders[1].ok, false);
      assert.match(payload.localProviders[1].error, /HTTP 500/);
    }
  );

  // Сетевой сбой проб не должен превращать tool-call в ошибку.
  await withFetch(
    async () => {
      throw new Error('offline');
    },
    async () => {
      const response = await callTool('consilium_free_models', {
        local_only: true,
        probe_local: true
      });
      assert.notEqual(response.result.isError, true);
      assert.match(response.result.content[0].text, /offline/);
    }
  );
});

test('consilium_list_agents показывает пользовательский пресет', async t => {
  const dir = tempDir('mcp-presets');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeConfig(dir, {
    presets: {
      docs: { description: 'Документация: arch и ba', experts: ['arch', 'ba'] }
    }
  });

  await withCwd(dir, async () => {
    const response = await callTool('consilium_list_agents');
    assert.notEqual(response.result.isError, true);
    assert.match(response.result.content[0].text, /docs — Документация: arch и ba/);
  });
});

test('checkLocalProviders: ok/warn/fail по результатам инъецированной пробы', async () => {
  const config = mergeWithDefaults({});
  const privacyConfig = mergeWithDefaults({ localOnly: true });

  const up = await checkLocalProviders(config, async () => [
    { provider: 'ollama', url: 'http://127.0.0.1:11434/api/tags', ok: true, models: 3 },
    { provider: 'lmstudio', url: 'http://127.0.0.1:1234/v1/models', ok: false, models: 0 }
  ]);
  assert.equal(up.id, 'local-providers');
  assert.equal(up.status, 'ok');
  assert.match(up.message, /Ollama: 3/);
  assert.match(up.message, /LM Studio/);

  const down = [
    {
      provider: 'ollama',
      url: 'http://127.0.0.1:11434/api/tags',
      ok: false,
      models: 0,
      error: 'ECONNREFUSED'
    },
    {
      provider: 'lmstudio',
      url: 'http://127.0.0.1:1234/v1/models',
      ok: false,
      models: 0,
      error: 'ECONNREFUSED'
    }
  ];

  const warn = await checkLocalProviders(config, async () => down);
  assert.equal(warn.status, 'warn');
  assert.match(warn.hint, /Ollama/);
  assert.match(warn.hint, /LM Studio/);
  assert.match(warn.hint, /localOnly/);

  const fail = await checkLocalProviders(privacyConfig, async () => down);
  assert.equal(fail.status, 'fail');
  assert.match(fail.message, /localOnly/);
  assert.match(fail.hint, /localOnly/);
});

test('runDoctor регистрирует local-providers и сохраняет порядок остальных проверок', async () => {
  await withFetch(
    async () => {
      throw new Error('offline');
    },
    async () => {
      const checks = await runDoctor(mergeWithDefaults({}), { checkModels: false });
      const ids = checks.map(check => check.id);

      assert.ok(ids.includes('local-providers'));
      assert.equal(ids.indexOf('local-providers'), ids.indexOf('opencode-config') + 1);
      assert.ok(ids.indexOf('opencode-v2-compat') > ids.indexOf('local-providers'));
    }
  );
});
