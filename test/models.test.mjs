import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BUILTIN_FREE_MODELS,
  rankFreeModels,
  selectCouncilModels,
  buildCouncilAgents,
  buildConsiliumConfigFromModels
} from '../dist/models.js';

function model(overrides = {}) {
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

test('rankFreeModels предпочитает большой контекст и доступность', () => {
  const small = model({ id: 'opencode/small-free', modelID: 'small-free', context: 8000, available: false });
  const large = model({ id: 'opencode/large-free', modelID: 'large-free', context: 400000 });
  const ranked = rankFreeModels([small, large]);
  assert.equal(ranked[0].id, 'opencode/large-free');
  assert.ok(ranked[0].score > ranked[1].score);
});

test('selectCouncilModels выбирает разные семейства', () => {
  const qwenA = model({ id: 'opencode/qwen-a-free', modelID: 'qwen-a-free', score: 1.2 });
  const qwenB = model({ id: 'opencode/qwen-b-free', modelID: 'qwen-b-free', score: 1.1 });
  const deepseek = model({ id: 'opencode/deepseek-x-free', modelID: 'deepseek-x-free', score: 1.0 });
  const selected = selectCouncilModels([qwenA, qwenB, deepseek], 2);
  assert.equal(selected.length, 2);
  const ids = selected.map(item => item.id);
  assert.ok(ids.includes('opencode/qwen-a-free'));
  assert.ok(ids.includes('opencode/deepseek-x-free'));
});

test('buildCouncilAgents назначает модель каждому агенту и председателю', () => {
  const models = ['a', 'b', 'c', 'd', 'e'].map((name, index) =>
    model({ id: `opencode/${name}-free`, modelID: `${name}-free`, score: 1 - index * 0.01 })
  );
  const agents = buildCouncilAgents(models);
  for (const name of ['arch', 'ux', 'ba', 'sec', 'consilium']) {
    assert.ok(agents[name]);
    assert.match(agents[name].model, /^opencode\//);
    assert.equal(agents[name].mode, 'primary');
  }
});

test('buildConsiliumConfigFromModels даёт 4 экспертов и председателя', () => {
  const models = ['a', 'b', 'c', 'd', 'e'].map((name, index) =>
    model({ id: `opencode/${name}-free`, modelID: `${name}-free`, score: 1 - index * 0.01 })
  );
  const config = buildConsiliumConfigFromModels(models);
  assert.equal(config.experts.length, 4);
  assert.deepEqual(config.experts.map(item => item.name), ['arch', 'ux', 'ba', 'sec']);
  assert.equal(config.chair.agent, 'consilium');
  assert.match(config.chair.model, /^opencode\//);
});

test('встроенный набор содержит только валидные tool-capable модели', () => {
  assert.ok(BUILTIN_FREE_MODELS.length >= 5);
  for (const item of BUILTIN_FREE_MODELS) {
    assert.match(item.id, /^[^/]+\/.+/);
    assert.equal(item.toolCall, true);
    assert.ok(item.context >= 32768);
  }
});
