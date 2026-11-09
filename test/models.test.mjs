import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BUILTIN_FREE_MODELS,
  isExcludedFreeProvider,
  rankFreeModels,
  selectCouncilModels,
  buildCouncilAgents,
  buildConsiliumConfigFromModels
} from '../dist/models.js';

test('opencode-go и contributor-модели не исключаются из бесплатного подбора', () => {
  assert.equal(isExcludedFreeProvider('opencode-go'), false);
  assert.equal(isExcludedFreeProvider('opencode'), false);
  assert.equal(isExcludedFreeProvider('acme-coding-plan'), true);
  assert.equal(isExcludedFreeProvider('acme-subscription'), true);
});

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

test('minContext применяется и при свежем ранжировании', () => {
  const small = model({
    id: 'opencode/small-context-free',
    modelID: 'small-context-free',
    context: 8000
  });
  const large = model({
    id: 'opencode/large-context-free',
    modelID: 'large-context-free',
    context: 400000
  });
  const ranked = rankFreeModels([small, large], { minContext: 32768 });
  assert.deepEqual(
    ranked.map(item => item.id),
    ['opencode/large-context-free']
  );
});

test('дедупликация предпочитает доступную копию недоступной с более высоким score', () => {
  const unavailable = model({
    id: 'zeta/shared-free',
    providerID: 'zeta',
    modelID: 'shared-free',
    canonicalID: 'shared-model',
    context: 1_000_000,
    outputLimit: 200_000,
    available: false,
    score: 1.2
  });
  const available = model({
    id: 'alpha/shared-free',
    providerID: 'alpha',
    modelID: 'shared-free',
    canonicalID: 'shared-model',
    context: 128_000,
    outputLimit: 32_000,
    available: true,
    score: 0.2
  });

  const ranked = rankFreeModels([unavailable, available], { includeUnavailable: true });
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].id, 'alpha/shared-free');

  const selected = selectCouncilModels([unavailable, available], 5);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].id, 'alpha/shared-free');
});

test('buildCouncilAgents всегда создаёт consilium при 1–4 моделях', () => {
  for (const count of [1, 2, 3, 4]) {
    const models = ['a', 'b', 'c', 'd'].slice(0, count).map((name, index) =>
      model({
        id: `opencode/${name}-free`,
        modelID: `${name}-free`,
        score: 1 - index * 0.01
      })
    );
    const selected = selectCouncilModels(models, 5);
    const agents = buildCouncilAgents(models);
    const chair = selected[Math.min(4, selected.length - 1)];

    assert.ok(agents.consilium, `нет consilium при ${count} моделях`);
    assert.equal(agents.consilium.model, chair.id);
    assert.match(agents.consilium.prompt, /председател/i);
    for (const [name, agent] of Object.entries(agents)) {
      if (name !== 'consilium') {
        assert.doesNotMatch(agent.prompt, /председател/i);
      }
    }
    for (const item of selected) {
      assert.ok(
        Object.values(agents).some(agent => agent.model === item.id),
        `модель ${item.id} потеряна при ${count} моделях`
      );
    }
  }
});
