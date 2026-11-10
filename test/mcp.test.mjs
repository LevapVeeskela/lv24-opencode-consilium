import test from 'node:test';
import assert from 'node:assert/strict';
import { handleMcpRequest, getMcpTools } from '../dist/mcp.js';
import { mergeWithDefaults } from '../dist/config.js';
import { computeProgressTotal } from '../dist/interfaces/mcp/handlers/run.js';

test('getMcpTools содержит все инструменты', () => {
  const names = getMcpTools().map(tool => tool.name).sort();
  assert.deepEqual(names, [
    'consilium_diff_runs',
    'consilium_doctor',
    'consilium_free_models',
    'consilium_get_run',
    'consilium_init_free',
    'consilium_list_agents',
    'consilium_list_runs',
    'consilium_run',
    'consilium_sarif'
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
  assert.equal(response.result.serverInfo.name, 'lv24-opencode-consilium');
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
  assert.ok(run.inputSchema.properties.max_cost);
  assert.ok(run.inputSchema.properties.artifacts);
});

test('consilium_run отклоняет невалидный max_cost до запуска', async () => {
  const response = await handleMcpRequest({
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: { name: 'consilium_run', arguments: { task: 'test', max_cost: '0.001' } }
  });

  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /max_cost/);
});

test('consilium_run не пишет артефакты вне workspace', async () => {
  const response = await handleMcpRequest({
    jsonrpc: '2.0',
    id: 6,
    method: 'tools/call',
    params: { name: 'consilium_run', arguments: { task: 'test', artifacts: '../outside' } }
  });

  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /inside the workspace/);
});

test('прогресс считает только выбранных экспертов, а не всех enabled', () => {
  const config = mergeWithDefaults({
    experts: [
      { name: 'arch' },
      { name: 'ux' },
      { name: 'ba' },
      { name: 'sec' }
    ]
  });

  // Явный список из двух экспертов: 2 + председатель.
  assert.equal(computeProgressTotal(config, ['arch', 'sec'], 'любая задача'), 3);

  // Отключённый эксперт не попадает в счёт.
  const withDisabled = mergeWithDefaults({
    experts: [{ name: 'arch' }, { name: 'sec', enabled: false }, { name: 'ux' }]
  });
  assert.equal(computeProgressTotal(withDisabled, ['arch', 'sec'], 'любая задача'), 2);

  // Smart-выбор сужает совет: security-задача даёт меньше, чем все 4.
  const smart = mergeWithDefaults({
    experts: [
      { name: 'arch' },
      { name: 'ux' },
      { name: 'ba' },
      { name: 'sec' }
    ],
    smartExperts: true
  });
  const smartTotal = computeProgressTotal(
    smart,
    undefined,
    'Найди уязвимости и проблемы безопасности, проверь auth'
  );
  assert.ok(smartTotal >= 2 && smartTotal < 5, `smart total: ${smartTotal}`);
});
