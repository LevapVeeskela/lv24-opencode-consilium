import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callAgent, sumUsagePair } from '../dist/infrastructure/opencode/calls.js';

const TRUSTED_PROJECT_CONFIG = Symbol.for('lv24-opencode-consilium.trustedProjectConfig');

function makeFakeOpenCode(dir, withCost) {
  const script = join(dir, 'fake-opencode.js');
  const cost = withCost ? 'cost: Number(process.env.FAKE_OPENCODE_COST),' : '';
  const source = [
    "let input = '';",
    "process.stdin.setEncoding('utf8');",
    'process.stdin.on("data", chunk => { input += chunk; });',
    'process.stdin.on("end", () => {',
    '  process.stdout.write(JSON.stringify({ type: "text", part: { text: "ok" } }) + "\\n");',
    '  process.stdout.write(JSON.stringify({',
    '    type: "step_finish",',
    '    part: { tokens: { input: 10, output: 5 }, ' + cost + ' }',
    '  }) + "\\n");',
    '});',
    ''
  ].join('\n');
  writeFileSync(script, source, 'utf8');

  if (process.platform === 'win32') {
    const shim = join(dir, 'fake-opencode.cmd');
    writeFileSync(
      shim,
      `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`,
      'utf8'
    );
    return shim;
  }

  const shim = join(dir, 'fake-opencode');
  writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, 'utf8');
  chmodSync(shim, 0o755);
  return shim;
}

function makeConfig(dir, opencodePath) {
  const config = {
    opencodePath,
    cwd: dir,
    standalone: true,
    experts: [],
    chair: { agent: 'consilium' },
    retry: { expertRetries: 0, chairRetries: 0, delay: 1 },
    timeouts: { expert: 10000, chair: 10000 },
    output: { format: 'text', file: false, progress: false, logLevel: 'info' }
  };
  config[TRUSTED_PROJECT_CONFIG] = true;
  return config;
}

test('sumUsagePair: неизвестная стоимость не превращается в ноль', () => {
  const unknown = sumUsagePair({ inputTokens: 1 }, { outputTokens: 2 });
  assert.ok(unknown);
  assert.equal(unknown.inputTokens, 1);
  assert.equal(unknown.outputTokens, 2);
  assert.equal('cost' in unknown, false);

  const partiallyKnown = sumUsagePair({ inputTokens: 1 }, { cost: 0.25 });
  assert.ok(partiallyKnown);
  assert.equal(partiallyKnown.cost, 0.25);

  const known = sumUsagePair({ cost: 0.25 }, { cost: 0.5 });
  assert.ok(known);
  assert.equal(known.cost, 0.75);

  const zero = sumUsagePair({ cost: 0 }, { cost: 0 });
  assert.ok(zero);
  assert.equal(zero.cost, 0);
});

test('callAgent не подставляет cost: 0 без телеметрии провайдера', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'consilium-calls-usage-'));
  try {
    const opencodePath = makeFakeOpenCode(dir, false);
    const result = await callAgent('', 'task', makeConfig(dir, opencodePath), {
      retries: 0
    });

    assert.equal(result.success, true);
    assert.ok(result.usage);
    assert.equal(result.usage.inputTokens, 10);
    assert.equal(result.usage.outputTokens, 5);
    assert.equal('cost' in result.usage, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('callAgent сохраняет известную стоимость провайдера', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'consilium-calls-usage-'));
  const previous = process.env.FAKE_OPENCODE_COST;
  process.env.FAKE_OPENCODE_COST = '0.25';
  try {
    const opencodePath = makeFakeOpenCode(dir, true);
    const result = await callAgent('', 'task', makeConfig(dir, opencodePath), {
      retries: 0
    });

    assert.equal(result.success, true);
    assert.ok(result.usage);
    assert.equal(result.usage.cost, 0.25);
  } finally {
    if (previous === undefined) delete process.env.FAKE_OPENCODE_COST;
    else process.env.FAKE_OPENCODE_COST = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
