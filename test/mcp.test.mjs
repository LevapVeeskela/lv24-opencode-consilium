import test from 'node:test';
import assert from 'node:assert/strict';
import { handleMcpRequest, getMcpTools } from '../dist/mcp.js';

test('getMcpTools содержит все пять инструментов', () => {
  const names = getMcpTools().map(tool => tool.name).sort();
  assert.deepEqual(names, [
    'consilium_doctor',
    'consilium_free_models',
    'consilium_init_free',
    'consilium_list_agents',
    'consilium_run'
  ]);
});

test('initialize возвращает совместимый протокол и serverInfo', async () => {
  const response = await handleMcpRequest({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } }
  });
  assert.equal(response.id, 1);
  assert.equal(response.result.serverInfo.name, 'opencode-consilium');
  assert.equal(response.result.protocolVersion, '2025-06-18');
  assert.ok(Array.isArray(Object.keys(response.result.capabilities)));
});

test('initialize с неизвестной версией отдаёт актуальную', async () => {
  const response = await handleMcpRequest({
    jsonrpc: '2.0',
    id: 'x',
    method: 'initialize',
    params: { protocolVersion: '1999-01-01' }
  });
  assert.equal(response.result.protocolVersion, '2025-06-18');
});

test('ping возвращает пустой результат', async () => {
  const response = await handleMcpRequest({ jsonrpc: '2.0', id: 2, method: 'ping' });
  assert.deepEqual(response.result, {});
});

test('notification не получает ответ', async () => {
  const response = await handleMcpRequest({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(response, null);
});

test('неизвестный метод даёт -32601', async () => {
  const response = await handleMcpRequest({ jsonrpc: '2.0', id: 3, method: 'nope' });
  assert.equal(response.error.code, -32601);
});

test('некорректный запрос даёт -32600', async () => {
  const response = await handleMcpRequest('not an object');
  assert.equal(response.error.code, -32600);
});

test('tools/list отдаёт схемы с required', async () => {
  const response = await handleMcpRequest({ jsonrpc: '2.0', id: 4, method: 'tools/list' });
  const run = response.result.tools.find(tool => tool.name === 'consilium_run');
  assert.deepEqual(run.inputSchema.required, ['task']);
});
