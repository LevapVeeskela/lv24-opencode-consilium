import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Consilium, mergeWithDefaults } from '../dist/application/consilium.js';
import { main } from '../dist/cli.js';
import { parseArgs, UsageError } from '../dist/interfaces/cli/args.js';
import { applyCliOverrides } from '../dist/interfaces/cli/overrides.js';
import { commandAudit } from '../dist/interfaces/cli/commands/audit.js';
import { getMcpTools, handleMcpRequest } from '../dist/mcp.js';
import { CONSILIUM_TOOL_INPUT } from '../dist/interfaces/plugin/plugin.js';
import { runConsiliumTool } from '../dist/interfaces/plugin/tool-run.js';
import { buildRunArgs } from '../dist/infrastructure/opencode/args.js';
import {
  READ_ONLY_OVERLAY_RELATIVE_PATH,
  READ_ONLY_PERMISSIONS,
  applyReadOnlyOverlay
} from '../dist/infrastructure/opencode/read-only.js';
import { shouldIgnore } from '../dist/watch.js';

const TRUSTED_PROJECT_CONFIG = Symbol.for('lv24-opencode-consilium.trustedProjectConfig');

const EXPECTED_RULES = [
  ['*', '*', 'deny'],
  ['read', '*', 'allow'],
  ['glob', '*', 'allow'],
  ['grep', '*', 'allow'],
  ['read', '*.env', 'deny'],
  ['read', '*.env.*', 'deny'],
  ['read', '*.env.example', 'allow']
];

const FAKE_OPENCODE = `import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const agentArg = args.find(arg => arg.startsWith('--agent='));
const agent = agentArg === undefined ? 'default' : agentArg.slice('--agent='.length);

if (args.includes('--version')) {
  process.stdout.write('fake-opencode 1.0.0\\n');
  process.exit(0);
}

const overlayPath = join(process.cwd(), '.opencode', 'opencode.json');
let overlay = null;
if (existsSync(overlayPath)) {
  overlay = JSON.parse(readFileSync(overlayPath, 'utf8'));
}
const captureDir = process.env.FAKE_CAPTURE_DIR;
if (captureDir) {
  writeFileSync(
    join(captureDir, agent + '-' + process.pid + '.json'),
    JSON.stringify({ args, overlay, cwd: process.cwd() }),
    'utf8'
  );
}

const chunks = [];
process.stdin.on('data', chunk => chunks.push(chunk));
await new Promise(resolve => process.stdin.on('end', resolve));

if (process.env.FAKE_HANG === '1') {
  setInterval(() => {}, 1000);
} else {
  process.stdout.write(
    JSON.stringify({ type: 'text', part: { type: 'text', text: 'OK ' + agent } }) + '\\n'
  );
}
`;

function mkTemp(prefix = 'consilium-read-only-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

function createFakeOpenCode(dir) {
  const script = join(dir, 'fake-opencode.mjs');
  writeFileSync(script, FAKE_OPENCODE, 'utf8');

  if (process.platform === 'win32') {
    const shim = join(dir, 'fake-opencode.cmd');
    writeFileSync(shim, `@"${process.execPath}" "%~dp0fake-opencode.mjs" %*\r\n`, 'utf8');
    return shim;
  }

  const shim = join(dir, 'fake-opencode');
  writeFileSync(
    shim,
    `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/fake-opencode.mjs" "$@"\n`,
    'utf8'
  );
  chmodSync(shim, 0o755);
  return shim;
}

function markTrusted(config) {
  Object.defineProperty(config, TRUSTED_PROJECT_CONFIG, {
    value: true,
    enumerable: true,
    configurable: true
  });
  return config;
}

function makeConfig(dir, opencodePath, overrides = {}) {
  return markTrusted(
    mergeWithDefaults({
      cwd: dir,
      opencodePath,
      autoDiscoverAgents: false,
      experts: [{ name: 'arch' }, { name: 'sec' }],
      chair: { agent: 'consilium', timeout: 5000 },
      timeouts: { expert: 5000, chair: 5000, shutdown: 500 },
      retry: {
        expertRetries: 0,
        chairRetries: 0,
        delay: 1,
        exponentialBackoff: false,
        jitter: false,
        maxConcurrency: 2
      },
      output: { file: false, format: 'text', progress: false, logLevel: 'silent' },
      artifacts: false,
      ...overrides
    })
  );
}

/** Любой capture запуска агента (не --version): имя агента зависит от слоя. */
function readRunCapture(dir) {
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const parsed = JSON.parse(readFileSync(join(dir, name), 'utf8'));
    if (Array.isArray(parsed.args) && parsed.args.includes('run')) {
      return parsed;
    }
  }
  throw new Error(`нет capture запуска агента в ${dir}`);
}

function ruleTuples(rules) {
  return rules.map(rule => [rule.action, rule.resource, rule.effect]);
}

function lockPath(dir) {
  return join(dir, '.consilium', 'read-only.lock');
}

function overlayPath(dir) {
  return join(dir, '.opencode', 'opencode.json');
}

test('parseArgs: --read-only, --allow-write и --isolate', () => {
  assert.equal(parseArgs(['--read-only', 'task']).readOnly, true);
  assert.equal(parseArgs(['--allow-write', 'task']).readOnly, false);
  assert.equal(parseArgs(['--isolate', 'task']).isolate, true);
  assert.equal(parseArgs(['task']).readOnly, undefined);
  assert.equal(parseArgs(['task']).isolate, undefined);
  assert.throws(
    () => parseArgs(['--read-only', '--allow-write', 'task']),
    error => error instanceof UsageError && /--read-only.*--allow-write/.test(error.message)
  );
});

test('applyCliOverrides: флаги перекрывают конфиг, без флагов конфиг сохраняется', () => {
  const makeBase = (readOnly, isolate = false) =>
    mergeWithDefaults({
      experts: [{ name: 'arch' }],
      readOnly,
      isolate
    });

  assert.equal(
    applyCliOverrides(makeBase(true), parseArgs(['--allow-write', 'task'])).readOnly,
    false
  );
  assert.equal(
    applyCliOverrides(makeBase(true), parseArgs(['--isolate', 'task'])).isolate,
    true
  );
  assert.equal(applyCliOverrides(makeBase(true), parseArgs(['task'])).readOnly, true);
  assert.equal(
    applyCliOverrides(makeBase(false), parseArgs(['--read-only', 'task'])).readOnly,
    true
  );
  assert.equal(applyCliOverrides(makeBase(false), parseArgs(['task'])).readOnly, false);
});

test('--help документирует read-only, allow-write и isolate', async t => {
  const lines = [];
  t.mock.method(console, 'log', (...args) => lines.push(args.join(' ')));
  const code = await main(['--help']);
  assert.equal(code, 0);
  const text = lines.join('\n');
  assert.match(text, /--read-only/);
  assert.match(text, /--allow-write/);
  assert.match(text, /--isolate/);
  assert.match(text, /read-only/);
  assert.match(text, /worktree/);
});

test('audit по умолчанию read-only, --allow-write снимает запрет', async t => {
  const root = mkTemp('consilium-audit-ro-');
  const previous = process.cwd();
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'audit@example.test'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Audit Test'], { cwd: root });
    writeFileSync(join(root, 'file.txt'), 'one\n', 'utf8');
    execFileSync('git', ['add', 'file.txt'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'initial'], { cwd: root });
    process.chdir(root);

    const captured = [];
    const deps = {
      run: async options => {
        captured.push(options);
        return 0;
      }
    };

    assert.equal(await commandAudit(parseArgs(['audit', '--since', 'HEAD']), deps), 0);
    assert.equal(
      await commandAudit(parseArgs(['audit', '--since', 'HEAD', '--allow-write']), deps),
      0
    );
    assert.equal(
      await commandAudit(parseArgs(['audit', '--since', 'HEAD', '--read-only']), deps),
      0
    );

    assert.equal(captured[0].readOnly, true);
    assert.equal(captured[1].readOnly, false);
    assert.equal(captured[2].readOnly, true);
  } finally {
    process.chdir(previous);
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('read-only прогон: слой с deny-правилами, восстановление и удаление lock', async t => {
  const dir = mkTemp();
  const captureDir = join(dir, 'captures');
  mkdirSync(captureDir, { recursive: true });
  const previousCapture = process.env.FAKE_CAPTURE_DIR;
  process.env.FAKE_CAPTURE_DIR = captureDir;
  try {
    const config = makeConfig(dir, createFakeOpenCode(dir), { readOnly: true });
    const result = await new Consilium(config).run('проверь задачу');

    assert.equal(result.success, true);
    assert.deepEqual(result.metadata?.safety, { readOnly: true, isolate: false });

    const capture = readRunCapture(captureDir);
    assert.ok(capture.overlay, 'дочерний процесс должен видеть временный слой');
    for (const agent of ['arch', 'sec', 'consilium', 'build', 'plan']) {
      assert.deepEqual(ruleTuples(capture.overlay.agents[agent].permissions), EXPECTED_RULES);
      assert.equal(capture.overlay.agent[agent].tools.write, false);
      assert.equal(capture.overlay.agent[agent].tools.edit, false);
      assert.equal(capture.overlay.agent[agent].tools.bash, false);
      assert.equal(capture.overlay.agent[agent].tools.webfetch, false);
      assert.equal(capture.overlay.agent[agent].tools.task, false);
    }

    assert.equal(existsSync(overlayPath(dir)), false, 'временный слой должен быть удалён');
    assert.equal(existsSync(lockPath(dir)), false, 'lock должен быть удалён');
    assert.equal(existsSync(join(dir, '.consilium', 'read-only.backup')), false);
  } finally {
    if (previousCapture === undefined) delete process.env.FAKE_CAPTURE_DIR;
    else process.env.FAKE_CAPTURE_DIR = previousCapture;
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('существующий .opencode/opencode.json мержится и восстанавливается байт-в-байт', async t => {
  const dir = mkTemp();
  const captureDir = join(dir, 'captures');
  mkdirSync(captureDir, { recursive: true });
  mkdirSync(join(dir, '.opencode'), { recursive: true });
  const original = [
    '{',
    '  // пользовательский слой',
    '  "agents": {',
    '    "arch": { "model": "p/a", "description": "Arch" }',
    '  },',
    '  "theme": "consilium",',
    '}',
    ''
  ].join('\r\n');
  writeFileSync(overlayPath(dir), original, 'utf8');

  const previousCapture = process.env.FAKE_CAPTURE_DIR;
  process.env.FAKE_CAPTURE_DIR = captureDir;
  try {
    const config = makeConfig(dir, createFakeOpenCode(dir), { readOnly: true });
    const result = await new Consilium(config).run('проверь задачу');
    assert.equal(result.success, true);

    const capture = readRunCapture(captureDir);
    assert.equal(capture.overlay.theme, 'consilium');
    assert.equal(capture.overlay.agents.arch.model, 'p/a');
    assert.deepEqual(ruleTuples(capture.overlay.agents.arch.permissions), EXPECTED_RULES);

    assert.equal(
      readFileSync(overlayPath(dir), 'utf8'),
      original,
      'файл восстановлен байт-в-байт'
    );
    assert.equal(readFileSync(overlayPath(dir)).equals(Buffer.from(original, 'utf8')), true);
    assert.equal(existsSync(lockPath(dir)), false);
  } finally {
    if (previousCapture === undefined) delete process.env.FAKE_CAPTURE_DIR;
    else process.env.FAKE_CAPTURE_DIR = previousCapture;
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('битый .opencode/opencode.json: fail closed и файл не тронут', async t => {
  const dir = mkTemp();
  try {
    mkdirSync(join(dir, '.opencode'), { recursive: true });
    const broken = '{ "agents": { "arch": ';
    writeFileSync(overlayPath(dir), broken, 'utf8');

    const config = makeConfig(dir, createFakeOpenCode(dir), { readOnly: true });
    await assert.rejects(
      () => new Consilium(config).run('проверь задачу'),
      /Не удалось включить read-only/
    );

    assert.equal(readFileSync(overlayPath(dir), 'utf8'), broken);
    assert.equal(existsSync(lockPath(dir)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('ошибка запуска восстанавливает слой и снимает lock', async t => {
  const dir = mkTemp();
  try {
    const config = makeConfig(dir, createFakeOpenCode(dir), {
      readOnly: true,
      hooks: {
        onStart: () => {
          throw new Error('boom');
        }
      }
    });

    await assert.rejects(() => new Consilium(config).run('проверь задачу'), /boom/);
    assert.equal(existsSync(overlayPath(dir)), false);
    assert.equal(existsSync(lockPath(dir)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('отмена восстанавливает слой и снимает lock', async t => {
  const dir = mkTemp();
  const previousHang = process.env.FAKE_HANG;
  process.env.FAKE_HANG = '1';
  try {
    const config = makeConfig(dir, createFakeOpenCode(dir), { readOnly: true });
    const consilium = new Consilium(config);
    const timer = setTimeout(() => consilium.cancel(), 300);
    const result = await consilium.run('ALL_SLOW проверь задачу');
    clearTimeout(timer);

    assert.equal(result.success, false);
    assert.equal(result.metadata?.cancelled, true);
    assert.deepEqual(result.metadata?.safety, { readOnly: true, isolate: false });
    assert.equal(existsSync(overlayPath(dir)), false);
    assert.equal(existsSync(lockPath(dir)), false);
  } finally {
    if (previousHang === undefined) delete process.env.FAKE_HANG;
    else process.env.FAKE_HANG = previousHang;
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('--isolate добавляет --worktree в аргументы дочернего opencode', async t => {
  const dir = mkTemp();
  const captureDir = join(dir, 'captures');
  mkdirSync(captureDir, { recursive: true });
  const previousCapture = process.env.FAKE_CAPTURE_DIR;
  process.env.FAKE_CAPTURE_DIR = captureDir;
  try {
    const config = makeConfig(dir, createFakeOpenCode(dir), {
      readOnly: false,
      isolate: true
    });
    const result = await new Consilium(config).run('проверь задачу');
    assert.equal(result.success, true);
    assert.deepEqual(result.metadata?.safety, { readOnly: false, isolate: true });
    assert.ok(readRunCapture(captureDir).args.includes('--worktree'));
    assert.equal(existsSync(overlayPath(dir)), false, 'без read-only слой не пишется');
  } finally {
    if (previousCapture === undefined) delete process.env.FAKE_CAPTURE_DIR;
    else process.env.FAKE_CAPTURE_DIR = previousCapture;
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('buildRunArgs: --worktree только при isolate', () => {
  assert.ok(buildRunArgs({ config: { isolate: true } }).includes('--worktree'));
  assert.equal(buildRunArgs({ config: { isolate: false } }).includes('--worktree'), false);
  assert.equal(buildRunArgs({}).includes('--worktree'), false);
});

test('временный слой можно исключить из watch-наблюдения', () => {
  assert.equal(READ_ONLY_OVERLAY_RELATIVE_PATH, '.opencode/opencode.json');
  assert.equal(shouldIgnore(READ_ONLY_OVERLAY_RELATIVE_PATH), false);
  assert.equal(
    shouldIgnore(READ_ONLY_OVERLAY_RELATIVE_PATH, [READ_ONLY_OVERLAY_RELATIVE_PATH]),
    true
  );
});

test('stale lock от мёртвого pid восстанавливает backup до нового слоя', async () => {
  const dir = mkTemp();
  try {
    mkdirSync(join(dir, '.opencode'), { recursive: true });
    mkdirSync(join(dir, '.consilium'), { recursive: true });
    const original = '{ "theme": "original" }\n';
    writeFileSync(overlayPath(dir), '{ "agents": { "arch": {} } }\n', 'utf8');
    writeFileSync(join(dir, '.consilium', 'read-only.backup'), original, 'utf8');
    writeFileSync(
      lockPath(dir),
      JSON.stringify({
        version: 1,
        pid: 999999,
        startedAt: '2026-01-01T00:00:00.000Z',
        target: overlayPath(dir),
        backupPath: join(dir, '.consilium', 'read-only.backup'),
        hadOriginal: true
      }),
      'utf8'
    );

    const session = await applyReadOnlyOverlay({ cwd: dir, agents: ['arch'] });
    try {
      const merged = JSON.parse(readFileSync(overlayPath(dir), 'utf8'));
      assert.equal(merged.theme, 'original', 'backup должен быть восстановлен до мержа');
      assert.ok(Array.isArray(merged.agents.arch.permissions));
    } finally {
      session.restore();
    }

    assert.equal(readFileSync(overlayPath(dir), 'utf8'), original);
    assert.equal(existsSync(lockPath(dir)), false);
    assert.equal(existsSync(join(dir, '.consilium', 'read-only.backup')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('MCP consilium_run и plugin consilium.run объявляют read_only/isolate', async () => {
  assert.deepEqual(
    ruleTuples(
      READ_ONLY_PERMISSIONS.map(rule => ({
        action: rule.action,
        resource: rule.resource,
        effect: rule.effect
      }))
    ),
    EXPECTED_RULES
  );

  const tool = getMcpTools().find(item => item.name === 'consilium_run');
  assert.ok(tool);
  assert.equal(tool.inputSchema.properties.read_only.type, 'boolean');
  assert.equal(tool.inputSchema.properties.isolate.type, 'boolean');

  const pluginProperties = CONSILIUM_TOOL_INPUT.properties;
  assert.equal(pluginProperties.read_only.type, 'boolean');
  assert.equal(pluginProperties.isolate.type, 'boolean');

  const invalid = await handleMcpRequest({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'consilium_run', arguments: { task: 'test', read_only: 'yes' } }
  });
  assert.equal(invalid.result.isError, true);
  assert.match(invalid.result.content[0].text, /read_only/);
});

test('plugin consilium.run прокидывает read_only в фактический запуск', async t => {
  const dir = mkTemp();
  const captureDir = join(dir, 'captures');
  mkdirSync(captureDir, { recursive: true });
  const previousCapture = process.env.FAKE_CAPTURE_DIR;
  process.env.FAKE_CAPTURE_DIR = captureDir;
  try {
    const baseConfig = makeConfig(dir, createFakeOpenCode(dir), { readOnly: false });
    const result = await runConsiliumTool({ task: 'проверь задачу', readOnly: true }, baseConfig);

    assert.equal(result.isError, false);
    assert.deepEqual(result.metadata?.safety, { readOnly: true, isolate: false });
    const capture = readRunCapture(captureDir);
    assert.ok(capture.overlay, 'read_only=true должен включить временный слой');
    assert.deepEqual(ruleTuples(capture.overlay.agents.arch.permissions), EXPECTED_RULES);
    assert.equal(existsSync(overlayPath(dir)), false);
    assert.equal(existsSync(lockPath(dir)), false);
  } finally {
    if (previousCapture === undefined) delete process.env.FAKE_CAPTURE_DIR;
    else process.env.FAKE_CAPTURE_DIR = previousCapture;
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
