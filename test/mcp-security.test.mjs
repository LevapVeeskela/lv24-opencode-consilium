import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { handleMcpRequest, startMcpServer } from '../dist/mcp.js';
import { PathContainmentError, isInside, resolveInside } from '../dist/shared/paths.js';

function makeTemp(prefix = 'consilium-security-') {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

async function runServer(messages) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let output = '';
  stdout.on('data', chunk => {
    output += chunk.toString('utf8');
  });

  const running = startMcpServer({ stdin, stdout, version: 'test' });
  const payload = messages.map(message => JSON.stringify(message)).join('\n');
  stdin.end(`${payload}\n`);
  await running;

  return output
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line));
}

test('id-less tools/call отклоняется с -32600 и не выполняется', async () => {
  const responses = await runServer([
    {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'consilium_list_agents', arguments: {} }
    }
  ]);

  assert.equal(responses.length, 1);
  assert.equal(responses[0].id, null);
  assert.equal(responses[0].error.code, -32600);
  assert.match(responses[0].error.message, /requires an id/i);
});

test('очередь tool-call ограничена 16 запросами', async () => {
  const messages = [];
  for (let index = 1; index <= 17; index += 1) {
    messages.push({
      jsonrpc: '2.0',
      id: index,
      method: 'tools/call',
      params: { name: 'consilium_list_agents', arguments: {} }
    });
  }

  const responses = await runServer(messages);
  const busy = responses.filter(response => response.error?.code === -32000);
  assert.equal(busy.length, 1);
  assert.equal(busy[0].id, 17);
  assert.match(busy[0].error.message, /busy/i);
  assert.equal(responses.filter(response => response.result !== undefined).length, 16);
});

test('отменённый до старта tool-call не выполняется', async () => {
  const responses = await runServer([
    {
      jsonrpc: '2.0',
      id: 'queued-cancel',
      method: 'tools/call',
      params: { name: 'consilium_list_agents', arguments: {} }
    },
    {
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: 'queued-cancel' }
    }
  ]);

  assert.equal(responses.length, 0);
});

test('init_free с force без confirm отклоняется без записи', async () => {
  const response = await handleMcpRequest({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'consilium_init_free',
      arguments: { apply: true, force: true }
    }
  });

  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /confirm/i);
});

function writeModelCache(file) {
  const model = {
    id: 'opencode/security-test-model',
    providerID: 'opencode',
    modelID: 'security-test-model',
    name: 'Security Test Model',
    context: 200000,
    outputLimit: 8192,
    reasoning: false,
    toolCall: true,
    structuredOutput: false,
    releaseDate: '2026-01-01',
    canonicalID: 'security-test-model',
    score: 0,
    available: true,
    source: 'builtin'
  };
  writeFileSync(
    file,
    JSON.stringify({ fetchedAt: Date.now(), models: [model], sources: [] }),
    'utf8'
  );
}

test('init_free с confirm создаёт .bak перед перезаписью opencode.json', async () => {
  const dir = makeTemp('consilium-init-free-');
  const previousCwd = process.cwd();
  const previousCache = process.env.CONSILIUM_MODELS_CACHE;
  const previousXdg = process.env.XDG_CONFIG_HOME;
  const opencodePath = path.join(dir, 'opencode.json');
  const original = `${JSON.stringify({ agent: { custom: { model: 'keep/me' } } }, null, 2)}\n`;

  try {
    writeFileSync(opencodePath, original, 'utf8');
    writeModelCache(path.join(dir, 'models-cache.json'));
    process.env.CONSILIUM_MODELS_CACHE = path.join(dir, 'models-cache.json');
    process.env.XDG_CONFIG_HOME = path.join(dir, 'xdg');
    process.chdir(dir);

    const response = await handleMcpRequest({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'consilium_init_free',
        arguments: { apply: true, force: true, confirm: true }
      }
    });

    assert.ok(response.result, JSON.stringify(response));
    assert.notEqual(response.result.isError, true, response.result.content?.[0]?.text);
    assert.ok(existsSync(`${opencodePath}.bak`));
    assert.equal(readFileSync(`${opencodePath}.bak`, 'utf8'), original);
  } finally {
    process.chdir(previousCwd);
    if (previousCache === undefined) delete process.env.CONSILIUM_MODELS_CACHE;
    else process.env.CONSILIUM_MODELS_CACHE = previousCache;
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousXdg;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveInside отклоняет .. и абсолютный путь вне базы', () => {
  const base = makeTemp('consilium-paths-');
  const outside = makeTemp('consilium-outside-');
  try {
    assert.throws(
      () => resolveInside(base, '../escape.txt', 'candidate'),
      PathContainmentError
    );
    assert.throws(
      () => resolveInside(base, path.join(outside, 'escape.txt'), 'candidate'),
      PathContainmentError
    );
    assert.equal(isInside(base, path.join('nested', 'file.txt')), true);
    assert.equal(isInside(base, '../escape.txt'), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('resolveInside отклоняет симлинк, ведущий наружу', t => {
  const base = makeTemp('consilium-paths-link-');
  const outside = makeTemp('consilium-outside-link-');
  const link = path.join(base, 'link');
  try {
    try {
      symlinkSync(outside, link, 'junction');
    } catch (error) {
      const code = error && error.code;
      if (code === 'EPERM' || code === 'EACCES' || code === 'UNKNOWN') {
        t.skip(`symlink creation is not permitted: ${code}`);
        return;
      }
      throw error;
    }

    assert.throws(
      () => resolveInside(base, path.join('link', 'escape.txt'), 'candidate'),
      PathContainmentError
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
