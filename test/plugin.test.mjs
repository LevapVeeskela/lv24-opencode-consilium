import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONSILIUM_TOOL_INPUT,
  TOOL_NAME,
  TOOL_NAMESPACE,
  registerConsilium
} from '../dist/plugin.js';
import { formatToolResult, runConsiliumTool } from '../dist/tool-run.js';

function createFakeContext() {
  const captured = {};
  const editor = {
    namespace(value) {
      captured.namespace = value;
    },
    add(tool) {
      captured.tool = tool;
    }
  };
  const ctx = {
    tool: {
      async transform(cb) {
        cb(editor);
        return { dispose: async () => {} };
      }
    }
  };
  return { ctx, captured };
}

test('registers namespace and tool with codemode disabled', async () => {
  const { ctx, captured } = createFakeContext();
  await registerConsilium(ctx);

  assert.equal(captured.namespace.name, TOOL_NAMESPACE);
  assert.ok(typeof captured.namespace.description === 'string');
  assert.equal(captured.tool.name, TOOL_NAME);
  assert.ok(typeof captured.tool.description === 'string');
  assert.deepEqual(CONSILIUM_TOOL_INPUT.required, ['task']);
  assert.deepEqual(captured.tool.input.required, ['task']);
  assert.equal(captured.tool.options.codemode, false);
});

test('schema documents all run properties', () => {
  const properties = CONSILIUM_TOOL_INPUT.properties;
  for (const key of [
    'task',
    'experts',
    'chair',
    'timeout_ms',
    'consensus',
    'smart_experts',
    'max_cost',
    'fallback_models',
    'session',
    'artifacts',
    'preset'
  ]) {
    assert.ok(properties[key], `missing schema property: ${key}`);
  }
  assert.equal(properties.preset.type, 'string');
  assert.equal(properties.preset.enum, undefined);
});

test('execute with empty task throws a tool error without spawning', async () => {
  const { ctx, captured } = createFakeContext();
  await registerConsilium(ctx);

  await assert.rejects(() => captured.tool.execute({ task: '' }, {}), /task/);
});

test('execute with bad types throws a tool error without spawning', async () => {
  const { ctx, captured } = createFakeContext();
  await registerConsilium(ctx);

  await assert.rejects(() => captured.tool.execute({ task: 42 }, {}), /task/);
  await assert.rejects(
    () => captured.tool.execute({ task: 'ok', max_cost: '0.001' }, {}),
    /max_cost/
  );
  await assert.rejects(
    () => captured.tool.execute({ task: 'ok', preset: 'nope' }, {}),
    /пресет|preset/i
  );
  await assert.rejects(() => captured.tool.execute('not an object', {}));
});

test('runConsiliumTool не запускает консилиум при уже отменённом сигнале', async () => {
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    () => runConsiliumTool({ task: 'never runs' }, undefined, { signal: controller.signal }),
    /aborted/i
  );
});

test('formatToolResult renders chair text, experts, json summary and artifacts', () => {
  const result = {
    text: 'chair verdict',
    experts: [
      { agent: 'arch', model: 'provider/arch-model', text: 'a'.repeat(5000), success: true },
      { agent: 'sec', text: 'short opinion', success: false }
    ],
    chair: { agent: 'consilium', text: 'chair verdict', success: true },
    totalTime: 1234,
    parallelTime: 1000,
    success: true,
    usage: { inputTokens: 10, outputTokens: 5, cost: 0.001 },
    metadata: {
      cost: { spent: 0.001 },
      consensus: { agreement: 'high', averageSimilarity: 0.9, extra: 'dropped' },
      artifacts: { id: 'run-1', dir: '.consilium/runs/run-1' }
    }
  };

  const text = formatToolResult(result);
  assert.ok(text.startsWith('chair verdict'));
  assert.ok(text.includes('## Мнения экспертов'));
  assert.ok(text.includes('short opinion'));
  // Per-expert text is truncated to 4000 chars.
  assert.ok(!text.includes('a'.repeat(5000)));
  assert.ok(text.includes('**Artifacts:** `.consilium/runs/run-1`'));

  const jsonBlock = text.split('```json')[1].split('```')[0];
  const summary = JSON.parse(jsonBlock);
  assert.equal(summary.success, true);
  assert.equal(summary.totalTime, 1234);
  assert.deepEqual(summary.usage, { inputTokens: 10, outputTokens: 5, cost: 0.001 });
  assert.deepEqual(summary.cost, { spent: 0.001 });
  assert.deepEqual(summary.consensus, { agreement: 'high', averageSimilarity: 0.9 });
  assert.deepEqual(summary.models, { arch: 'provider/arch-model' });
});

test('formatToolResult omits artifacts line when no dir is stored', () => {
  const result = {
    text: 'verdict',
    experts: [],
    chair: { agent: 'consilium', text: 'verdict', success: true },
    totalTime: 10,
    parallelTime: 5,
    success: true,
    metadata: {}
  };

  const text = formatToolResult(result);
  assert.ok(!text.includes('**Artifacts:**'));
});
