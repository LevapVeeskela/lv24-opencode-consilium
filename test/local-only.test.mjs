import test from 'node:test';
import assert from 'node:assert/strict';
import { Consilium } from '../dist/application/consilium.js';

test('localOnly: библиотека отклоняет облачную модель до запуска', async () => {
  const council = new Consilium({
    localOnly: true,
    autoDiscoverAgents: false,
    experts: [{ name: 'arch', model: 'openai/gpt-4o' }],
    chair: { agent: 'consilium', model: 'ollama/llama3' },
    output: { file: false },
    artifacts: false
  });

  await assert.rejects(() => council.run('проверь приватность'), /localOnly|локальн/i);
});

test('localOnly: библиотека отклоняет агента без явной модели', async () => {
  const council = new Consilium({
    localOnly: true,
    autoDiscoverAgents: false,
    experts: [{ name: 'arch' }],
    chair: { agent: 'consilium', model: 'ollama/llama3' },
    output: { file: false },
    artifacts: false
  });

  await assert.rejects(() => council.run('проверь приватность'), /Без модели|missing/i);
});

test('localOnly: все локальные модели проходят проверку (спавн не требуется)', async () => {
  const council = new Consilium({
    localOnly: true,
    autoDiscoverAgents: false,
    experts: [{ name: 'arch', model: 'ollama/llama3' }],
    chair: { agent: 'consilium', model: 'lmstudio/qwen' },
    opencodePath: 'definitely-missing-opencode-binary',
    output: { file: false },
    artifacts: false,
    retry: { expertRetries: 0, chairRetries: 0 }
  });

  // Проверка localOnly проходит; запуск падает уже на отсутствующем CLI,
  // а не на приватности.
  await assert.rejects(
    () => council.run('проверь приватность'),
    error => !/localOnly|локальн|Без модели/i.test(String(error?.message ?? error))
  );
});
