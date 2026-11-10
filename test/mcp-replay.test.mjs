import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { getMcpTools, handleMcpRequest } from '../dist/mcp.js';
import { cancelActiveConsilium } from '../dist/interfaces/mcp/handlers.js';
import {
  getNotificationSink,
  setNotificationSink
} from '../dist/interfaces/mcp/protocol.js';

const RUN_ID = '20260101-120000-abcd';

// Запускается как preload (Windows) или как отдельный скрипт (POSIX):
// печатает version, иначе читает prompt из stdin и пишет capture-файл.
const FAKE_OPENCODE = `const fs = require('node:fs');
const { join } = require('node:path');

const args = process.argv.slice(2);
if (args.includes('--version')) {
  process.stdout.write('fake-opencode 1.0.0\\n');
  process.exit(0);
}

// На Windows скрипт выполняется как preload копии node.exe (opencode.exe),
// поэтому stdin читается синхронно до резолва несуществующего main-скрипта.
const prompt = fs.readFileSync(0, 'utf8');
const agentArg = args.find(arg => arg.startsWith('--agent='));
const agent = agentArg === undefined ? 'default' : agentArg.slice('--agent='.length);
const overlayPath = join(process.cwd(), '.opencode', 'opencode.json');
const overlay = fs.existsSync(overlayPath)
  ? JSON.parse(fs.readFileSync(overlayPath, 'utf8'))
  : null;
const captureDir = process.env.FAKE_CAPTURE_DIR;
if (captureDir) {
  const name =
    agent + '-' + process.pid + '-' + Math.random().toString(16).slice(2) + '.json';
  fs.writeFileSync(
    join(captureDir, name),
    JSON.stringify({ agent, args, prompt, overlay, cwd: process.cwd() }),
    'utf8'
  );
}
if (process.env.FAKE_HANG === '1') {
  // Блокирует preload/main до kill от RunController (как зависший opencode).
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);
}
process.stdout.write(
  JSON.stringify({ type: 'text', part: { type: 'text', text: 'ANSWER ' + agent } }) + '\\n'
);
process.exit(0);
`;

function createFakeOpenCode() {
  const dir = mkdtempSync(join(tmpdir(), 'consilium-mcp-replay-bin-'));
  const script = join(dir, 'fake-opencode.cjs');
  writeFileSync(script, FAKE_OPENCODE, 'utf8');

  if (process.platform === 'win32') {
    const exe = join(dir, 'opencode.exe');
    try {
      linkSync(process.execPath, exe);
    } catch {
      copyFileSync(process.execPath, exe);
    }
    const previousOptions = process.env.NODE_OPTIONS;
    // NODE_OPTIONS съедает обратные слэши, поэтому путь передаётся через `/`.
    const preload = script.split('\\').join('/');
    process.env.NODE_OPTIONS = [previousOptions, `--require "${preload}"`]
      .filter(Boolean)
      .join(' ');
    return {
      dir,
      restore: () => {
        if (previousOptions === undefined) delete process.env.NODE_OPTIONS;
        else process.env.NODE_OPTIONS = previousOptions;
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    };
  }

  const shim = join(dir, 'opencode');
  writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, 'utf8');
  chmodSync(shim, 0o755);
  return {
    dir,
    restore: () => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  };
}

const fake = createFakeOpenCode();
const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === 'path') ?? 'PATH';
const previousPath = process.env[pathKey];
process.env[pathKey] = `${fake.dir}${delimiter}${previousPath ?? ''}`;

after(() => {
  if (previousPath === undefined) delete process.env[pathKey];
  else process.env[pathKey] = previousPath;
  fake.restore();
});

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function artifact(overrides = {}) {
  return {
    version: 1,
    id: RUN_ID,
    createdAt: '2026-01-01T12:00:00.000Z',
    task: 'Replay the saved auth review',
    success: true,
    text: 'Old saved answer',
    experts: [
      { agent: 'arch', model: 'openai/arch-model', success: true, text: 'old arch' },
      { agent: 'sec', model: 'openai/sec-model', success: true, text: 'old sec' }
    ],
    models: {
      arch: 'openai/arch-model',
      sec: 'openai/sec-model',
      consilium: 'anthropic/chair-model'
    },
    chairAgent: 'consilium',
    metadata: {
      consensus: true,
      fallbackModels: ['backup/model'],
      session: 'saved-session'
    },
    ...overrides
  };
}

const PROJECT_CONFIG = {
  autoDiscoverAgents: false,
  experts: [{ name: 'arch' }, { name: 'sec' }],
  chair: { agent: 'general' },
  timeouts: { expert: 5000, chair: 5000, shutdown: 1000 },
  retry: {
    expertRetries: 0,
    chairRetries: 0,
    delay: 1,
    exponentialBackoff: false,
    jitter: false,
    maxConcurrency: 3
  },
  output: { file: false, format: 'text', progress: false, logLevel: 'silent' },
  artifacts: false
};

function writeRun(project, run) {
  const dir = join(project, '.consilium', 'runs', run.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'run.json'), JSON.stringify(run, null, 2), 'utf8');
  return dir;
}

function tempProject(t) {
  const project = tempDir('consilium-mcp-replay-');
  t.after(() => rmSync(project, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  writeFileSync(
    join(project, 'consilium.config.json'),
    JSON.stringify(PROJECT_CONFIG, null, 2),
    'utf8'
  );
  // Агенты должны существовать в OpenCode, иначе runner намеренно опускает
  // --agent и проверка восстановления имён была бы невозможна.
  mkdirSync(join(project, '.opencode'), { recursive: true });
  writeFileSync(
    join(project, '.opencode', 'opencode.json'),
    JSON.stringify(
      { agents: { arch: {}, sec: {}, consilium: {}, general: {} } },
      null,
      2
    ),
    'utf8'
  );
  mkdirSync(join(project, '.consilium', 'runs'), { recursive: true });
  // --isolate requires a real git repository with a commit; the worktree must
  // also contain the OpenCode agent definitions used by the fake runner.
  const git = (args) =>
    execFileSync('git', args, { cwd: project, stdio: 'ignore' });
  git(['init']);
  git(['config', 'user.email', 'consilium-test@example.com']);
  git(['config', 'user.name', 'Consilium Test']);
  git(['add', '.']);
  git(['commit', '-m', 'fixture']);
  return project;
}

function callTool(name, args = {}, progressToken) {
  const params = { name, arguments: args };
  if (progressToken !== undefined) {
    params._meta = { progressToken };
  }
  return handleMcpRequest({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params
  });
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

function errorText(response) {
  assert.equal(response.result?.isError, true, JSON.stringify(response));
  return response.result.content[0].text;
}

function summaryOf(text) {
  const start = text.indexOf('```json');
  assert.notEqual(start, -1, text);
  const end = text.indexOf('```', start + 7);
  assert.notEqual(end, -1, text);
  return JSON.parse(text.slice(start + 7, end).trim());
}

function readCaptures(directory) {
  return readdirSync(directory).map(name =>
    JSON.parse(readFileSync(join(directory, name), 'utf8'))
  );
}

async function waitFor(predicate, timeoutMs = 5000) {
  const started = Date.now();
  for (;;) {
    if (predicate()) return;
    if (Date.now() - started > timeoutMs) {
      throw new Error('waitFor timed out');
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

function captureDir(t) {
  const dir = tempDir('consilium-mcp-replay-capture-');
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return dir;
}

function agentCapture(captures, agent) {
  const found = captures.find(capture => capture.agent === agent);
  assert.ok(found, `no capture for agent ${agent}: ${captures.map(item => item.agent).join(', ')}`);
  return found;
}

test('consilium_replay: восстанавливает артефакт и стримит прогресс', async t => {
  const project = tempProject(t);
  writeRun(project, artifact());
  const capturesDir = captureDir(t);
  const previousCapture = process.env.FAKE_CAPTURE_DIR;
  process.env.FAKE_CAPTURE_DIR = capturesDir;

  const notifications = [];
  const previousSink = getNotificationSink();
  setNotificationSink(message => notifications.push(message));

  try {
    const response = await withCwd(project, () =>
      callTool(
        'consilium_replay',
        {
          run: RUN_ID,
          read_only: true,
          isolate: true,
          artifacts: false,
          output_file: join('reports', 'replay.md'),
          max_cost: 1,
          deadline_ms: 60000,
          rounds: 1,
          findings: true,
          session: 'replay-session',
          timeout_ms: 4000
        },
        'progress-1'
      )
    );

    assert.notEqual(response.result?.isError, true, response.result?.content?.[0]?.text);
    const text = response.result.content[0].text;
    assert.match(text, /ANSWER consilium/);
    assert.match(text, /## Мнения экспертов/);

    const summary = summaryOf(text);
    assert.equal(summary.success, true);
    assert.equal(summary.replayOf, RUN_ID);
    assert.deepEqual(summary.safety, { readOnly: true, isolate: true });
    assert.equal(summary.rounds, 1);
    assert.equal(summary.models.arch, 'openai/arch-model');
    assert.equal(summary.models.sec, 'openai/sec-model');
    assert.equal(summary.models.consilium, 'anthropic/chair-model');
    assert.equal(summary.deadlineMs, 60000);
    assert.ok(Array.isArray(summary.experts));
    assert.equal(summary.experts.length, 2);

    // output_file сохранён внутри workspace.
    const saved = join(project, 'reports', 'replay.md');
    assert.ok(existsSync(saved));
    assert.match(readFileSync(saved, 'utf8'), /ANSWER consilium/);

    // artifacts: false не создаёт новый запуск.
    assert.deepEqual(readdirSync(join(project, '.consilium', 'runs')), [RUN_ID]);

    const captures = readCaptures(capturesDir);
    assert.deepEqual(
      captures.map(capture => capture.agent).sort(),
      ['arch', 'consilium', 'sec']
    );
    for (const capture of captures) {
      const cwd = capture.cwd.replace(/\\/g, '/');
      assert.match(cwd, /\.consilium\/worktrees\//, JSON.stringify(capture.args));
      assert.match(capture.prompt, /Replay the saved auth review/);
      assert.ok(capture.overlay, 'read_only должен включить временный слой');
      assert.deepEqual(capture.overlay.agents.arch.permissions[0], {
        action: '*',
        resource: '*',
        effect: 'deny'
      });
      assert.equal(capture.overlay.agent.arch.tools.bash, false);
    }
    const arch = agentCapture(captures, 'arch');
    const chair = agentCapture(captures, 'consilium');
    assert.ok(arch.args.includes('--model=openai/arch-model'));
    assert.ok(chair.args.includes('--model=anthropic/chair-model'));
    assert.ok(chair.args.includes('--session=ses_replay-session'));
    assert.ok(arch.args.includes('--session=ses_replay-session-arch'));

    // Прогресс: одинаковый контракт notifications/progress.
    const progress = notifications.filter(item => item.method === 'notifications/progress');
    assert.equal(progress.length, notifications.length);
    assert.ok(progress.length >= 3, JSON.stringify(notifications));
    for (const item of progress) {
      assert.equal(item.params.progressToken, 'progress-1');
      assert.equal(item.params.total, 3);
      assert.equal(typeof item.params.progress, 'number');
      assert.ok(item.params.progress >= 0 && item.params.progress <= 3);
      assert.equal(typeof item.params.message, 'string');
    }
    assert.ok(progress.some(item => /Expert arch started/.test(item.params.message)));
    assert.ok(progress.some(item => /Chair is synthesizing/.test(item.params.message)));
    assert.ok(
      progress.some(
        item => item.params.progress === 3 && /Consilium completed/.test(item.params.message)
      )
    );
  } finally {
    setNotificationSink(previousSink);
    if (previousCapture === undefined) delete process.env.FAKE_CAPTURE_DIR;
    else process.env.FAKE_CAPTURE_DIR = previousCapture;
  }
});

test('consilium_replay: latest, отсутствие progressToken не стримит', async t => {
  const project = tempProject(t);
  writeRun(project, artifact());
  const capturesDir = captureDir(t);
  const previousCapture = process.env.FAKE_CAPTURE_DIR;
  process.env.FAKE_CAPTURE_DIR = capturesDir;

  const notifications = [];
  const previousSink = getNotificationSink();
  setNotificationSink(message => notifications.push(message));

  try {
    const response = await withCwd(project, () =>
      callTool('consilium_replay', { artifacts: false, rounds: 1 })
    );

    assert.notEqual(response.result?.isError, true, response.result?.content?.[0]?.text);
    const summary = summaryOf(response.result.content[0].text);
    assert.equal(summary.replayOf, RUN_ID);
    assert.equal(notifications.length, 0);

    const captures = readCaptures(capturesDir);
    const chair = agentCapture(captures, 'consilium');
    // Сессия из артефакта восстановлена, override не передан.
    assert.ok(chair.args.includes('--session=ses_saved-session'));
    assert.ok(captures.every(capture => !capture.args.includes('--worktree')));
    assert.ok(
      captures.every(
        capture => capture.overlay?.agents?.arch?.permissions === undefined
      ),
      'без read_only временный deny-слой не создаётся'
    );
  } finally {
    setNotificationSink(previousSink);
    if (previousCapture === undefined) delete process.env.FAKE_CAPTURE_DIR;
    else process.env.FAKE_CAPTURE_DIR = previousCapture;
  }
});

test('consilium_replay: активный повтор отменяется через MCP cancel path', async t => {
  const project = tempProject(t);
  writeRun(project, artifact());
  const capturesDir = captureDir(t);
  const previousCapture = process.env.FAKE_CAPTURE_DIR;
  const previousHang = process.env.FAKE_HANG;
  process.env.FAKE_CAPTURE_DIR = capturesDir;
  process.env.FAKE_HANG = '1';

  try {
    const pending = withCwd(project, () =>
      callTool('consilium_replay', { artifacts: false }, 'cancel-token')
    );

    await waitFor(() => readdirSync(capturesDir).length > 0);
    cancelActiveConsilium();
    const response = await pending;

    assert.equal(response.result?.isError, true, JSON.stringify(response));
    assert.match(response.result.content[0].text, /CANCELLED/);
  } finally {
    if (previousCapture === undefined) delete process.env.FAKE_CAPTURE_DIR;
    else process.env.FAKE_CAPTURE_DIR = previousCapture;
    if (previousHang === undefined) delete process.env.FAKE_HANG;
    else process.env.FAKE_HANG = previousHang;
  }
});

test('consilium_replay: ошибки run/artifact/options', async t => {
  const project = tempProject(t);
  writeRun(project, artifact());
  writeRun(project, artifact({ id: '20260102-000000-beef', task: '' }));
  writeRun(project, artifact({ id: '20260103-000000-cafe', experts: [], models: {} }));
  const brokenDir = join(project, '.consilium', 'runs', '20260104-000000-dead');
  mkdirSync(brokenDir, { recursive: true });
  writeFileSync(join(brokenDir, 'run.json'), '{ not json', 'utf8');
  const invalidDir = join(project, '.consilium', 'runs', '20260105-000000-face');
  mkdirSync(invalidDir, { recursive: true });
  writeFileSync(
    join(invalidDir, 'run.json'),
    JSON.stringify({ id: '20260105-000000-face', createdAt: 'x' }),
    'utf8'
  );

  await withCwd(project, async () => {
    assert.match(
      errorText(await callTool('consilium_replay', { run: 'missing' })),
      /Cannot load run "missing"/
    );
    assert.match(
      errorText(await callTool('consilium_replay', { run: '../outside' })),
      /saved run id or "latest"/
    );
    assert.match(
      errorText(await callTool('consilium_replay', { run: '20260104-000000-dead' })),
      /Некорректный JSON артефакта/
    );
    assert.match(
      errorText(await callTool('consilium_replay', { run: '20260105-000000-face' })),
      /Некорректный артефакт/
    );
    assert.match(
      errorText(await callTool('consilium_replay', { run: '20260102-000000-beef' })),
      /has no task/
    );
    assert.match(
      errorText(await callTool('consilium_replay', { run: '20260103-000000-cafe' })),
      /has no experts/
    );

    for (const option of [
      'task',
      'experts',
      'chair',
      'format',
      'preset',
      'local_only',
      'consensus',
      'smart_experts',
      'fallback_models'
    ]) {
      assert.match(
        errorText(await callTool('consilium_replay', { [option]: 'x' })),
        /Unsupported option/
      );
    }

    assert.match(
      errorText(await callTool('consilium_replay', { artifacts: '../outside' })),
      /inside the workspace/
    );
    for (const output of ['../outside.md', join(tmpdir(), 'consilium-replay-outside.md')]) {
      assert.match(
        errorText(await callTool('consilium_replay', { output_file: output })),
        /inside the workspace/
      );
    }
    assert.equal(existsSync(join(project, '..', 'outside.md')), false);

    assert.match(
      errorText(await callTool('consilium_replay', { run: 42 })),
      /"run" must be a string/
    );
    assert.match(
      errorText(await callTool('consilium_replay', { read_only: 'yes' })),
      /read_only/
    );
    assert.match(
      errorText(await callTool('consilium_replay', { rounds: 3 })),
      /rounds/
    );
    assert.match(
      errorText(await callTool('consilium_replay', { deadline_ms: 0 })),
      /deadline_ms/
    );
    assert.match(
      errorText(await callTool('consilium_replay', { timeout_ms: 0 })),
      /timeout_ms/
    );
    assert.match(
      errorText(await callTool('consilium_replay', { max_cost: -1 })),
      /max_cost/
    );
  });
});

test('consilium_replay: пустой каталог артефактов', async t => {
  const project = tempProject(t);

  await withCwd(project, async () => {
    assert.match(
      errorText(await callTool('consilium_replay')),
      /No saved runs found/
    );
  });
});

test('consilium_replay: схема инструмента и полный список tools', () => {
  const tools = getMcpTools();
  const names = tools.map(tool => tool.name).sort();
  assert.deepEqual(names, [
    'consilium_diff_runs',
    'consilium_doctor',
    'consilium_free_models',
    'consilium_get_run',
    'consilium_init_free',
    'consilium_list_agents',
    'consilium_list_runs',
    'consilium_replay',
    'consilium_run',
    'consilium_sarif'
  ]);

  const replay = tools.find(tool => tool.name === 'consilium_replay');
  assert.ok(replay);
  assert.deepEqual(replay.inputSchema.required, []);
  assert.equal(replay.inputSchema.properties.run.default, 'latest');
  for (const key of [
    'run',
    'read_only',
    'isolate',
    'artifacts',
    'output_file',
    'max_cost',
    'deadline_ms',
    'rounds',
    'findings',
    'session',
    'timeout_ms'
  ]) {
    assert.ok(replay.inputSchema.properties[key], `missing property ${key}`);
  }
  assert.match(replay.description, /notifications\/progress/);
  assert.match(replay.description, /progressToken/);
  assert.match(replay.description, /no partial result chunks/);

  // Контракт consilium_run не изменился по required/основным полям.
  const run = tools.find(tool => tool.name === 'consilium_run');
  assert.deepEqual(run.inputSchema.required, ['task']);
  assert.ok(run.inputSchema.properties.read_only);
  assert.ok(run.inputSchema.properties.isolate);
  assert.match(run.description, /progressToken/);

  const initialize = handleMcpRequest({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18' }
  });
  return initialize.then(response => {
    assert.match(response.result.instructions, /consilium_replay/);
  });
});
