import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  COMMANDS,
  UsageError,
  parseArgs
} from '../dist/interfaces/cli/args.js';
import { applyCliOverrides } from '../dist/interfaces/cli/overrides.js';
import {
  generateExampleConfig,
  mergeWithDefaults,
  validateConfig
} from '../dist/config.js';
import { getMcpTools } from '../dist/mcp.js';
import { commandInit } from '../dist/interfaces/cli/commands/init.js';
import { commandAudit } from '../dist/interfaces/cli/commands/audit.js';

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), `consilium-${prefix}-`));
}

function cleanup(directory) {
  rmSync(directory, { recursive: true, force: true });
}

function captureLogs(t) {
  const logs = [];
  t.mock.method(console, 'log', (...args) => {
    logs.push(args.join(' '));
  });
  return logs;
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Internal Server Error',
    json: async () => body
  };
}

async function withFetch(handler, run) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
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

function ollamaFetch(modelNames, { lmStudioOk = false } = {}) {
  return async url => {
    if (String(url).includes('11434')) {
      return jsonResponse({ models: modelNames.map(name => ({ name })) });
    }
    return lmStudioOk
      ? jsonResponse({ data: [{ id: 'lmstudio-model' }] })
      : jsonResponse({}, 500);
  };
}

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

function createRepoWithCommits(t) {
  const root = tempDir('audit-command');
  t.after(() => cleanup(root));

  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'audit@example.test']);
  git(root, ['config', 'user.name', 'Audit Test']);
  git(root, ['config', 'commit.gpgsign', 'false']);

  writeFileSync(join(root, 'app.ts'), 'export const version = 1;\n', 'utf8');
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'initial']);

  writeFileSync(
    join(root, 'app.ts'),
    'export const version = 2;\nexport const hello = "Привет, мир";\n',
    'utf8'
  );
  writeFileSync(join(root, 'new.ts'), 'export const added = true;\n', 'utf8');
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'second']);

  return root;
}

test('rounds: CLI parsing, overrides, validation, example and MCP schema', () => {
  assert.equal(parseArgs(['run', '--rounds', '2', 'задача']).rounds, 2);
  assert.equal(parseArgs(['watch', '--rounds', '1']).rounds, 1);
  assert.throws(() => parseArgs(['run', '--rounds', '0', 'задача']), UsageError);
  assert.throws(() => parseArgs(['run', '--rounds', '3', 'задача']), UsageError);
  assert.throws(() => parseArgs(['run', '--rounds', 'two', 'задача']), UsageError);

  const applied = applyCliOverrides(
    mergeWithDefaults({}),
    parseArgs(['run', '--rounds', '2', 'задача'])
  );
  assert.equal(applied.rounds, 2);

  const invalid = mergeWithDefaults({ rounds: 7 });
  const warnings = validateConfig(invalid);
  assert.equal(invalid.rounds, 1);
  assert.ok(warnings.some(warning => /rounds/.test(warning)));

  const valid = mergeWithDefaults({ rounds: 2 });
  assert.deepEqual(validateConfig(valid), []);
  assert.equal(valid.rounds, 2);

  const generated = JSON.parse(generateExampleConfig());
  assert.equal(generated.rounds, 1);

  const schema = JSON.parse(
    readFileSync(new URL('../schema/config.schema.json', import.meta.url), 'utf8')
  );
  assert.equal(schema.properties.rounds.type, 'integer');
  assert.deepEqual(schema.properties.rounds.enum, [1, 2]);

  const exampleText = readFileSync(
    new URL('../consilium.config.example.json', import.meta.url),
    'utf8'
  ).replace(/^\uFEFF/, '');
  assert.equal(JSON.parse(exampleText).rounds, 1);

  const runTool = getMcpTools().find(tool => tool.name === 'consilium_run');
  assert.ok(runTool);
  assert.equal(runTool.inputSchema.properties.rounds.type, 'integer');
  assert.equal(runTool.inputSchema.properties.rounds.minimum, 1);
  assert.equal(runTool.inputSchema.properties.rounds.maximum, 2);
});

test('init --local: dry-run prints the bootstrap and writes nothing', async t => {
  const root = tempDir('init-local-dry');
  t.after(() => cleanup(root));
  const logs = captureLogs(t);

  const code = await withCwd(root, () =>
    withFetch(ollamaFetch(['llama3:latest', 'qwen2.5:7b']), () =>
      commandInit({ task: '', command: 'init', local: true, dryRun: true })
    )
  );

  assert.equal(code, 0);
  assert.equal(existsSync(join(root, 'consilium.config.json')), false);
  const text = logs.join('\n');
  assert.match(text, /arch → ollama\/llama3:latest/);
  assert.match(text, /ux → ollama\/qwen2.5:7b/);
  assert.match(text, /chair \(consilium\) → ollama\/llama3:latest/);
});

test('init --local --dry-run --json prints the proposed config and writes nothing', async t => {
  const root = tempDir('init-local-json');
  t.after(() => cleanup(root));
  const logs = captureLogs(t);

  const code = await withCwd(root, () =>
    withFetch(ollamaFetch(['llama3:latest', 'qwen2.5:7b']), () =>
      commandInit({ task: '', command: 'init', local: true, dryRun: true, json: true })
    )
  );

  assert.equal(code, 0);
  assert.equal(existsSync(join(root, 'consilium.config.json')), false);
  const config = JSON.parse(logs.join('\n'));
  assert.equal(config.localOnly, true);
  assert.equal(config.autoDiscoverAgents, false);
  assert.deepEqual(config.experts.map(expert => expert.model), [
    'ollama/llama3:latest',
    'ollama/qwen2.5:7b',
    'ollama/llama3:latest',
    'ollama/qwen2.5:7b'
  ]);
  assert.deepEqual(config.chair, {
    agent: 'consilium',
    model: 'ollama/llama3:latest'
  });
});

test('init --local: writes config, refuses overwrite, --force preserves user settings', async t => {
  const root = tempDir('init-local-write');
  t.after(() => cleanup(root));
  const configPath = join(root, 'consilium.config.json');
  const fetch = ollamaFetch(['llama3:latest', 'qwen2.5:7b']);

  const code = await withCwd(root, () =>
    withFetch(fetch, () => commandInit({ task: '', command: 'init', local: true }))
  );
  assert.equal(code, 0);

  const written = JSON.parse(readFileSync(configPath, 'utf8'));
  assert.equal(written.localOnly, true);
  assert.equal(written.autoDiscoverAgents, false);
  assert.deepEqual(written.experts.map(expert => expert.name), ['arch', 'ux', 'ba', 'sec']);
  assert.deepEqual(written.experts.map(expert => expert.model), [
    'ollama/llama3:latest',
    'ollama/qwen2.5:7b',
    'ollama/llama3:latest',
    'ollama/qwen2.5:7b'
  ]);
  assert.equal(written.chair.model, 'ollama/llama3:latest');

  writeFileSync(
    configPath,
    JSON.stringify(
      {
        timeouts: { expert: 1111, chair: 2222, shutdown: 333 },
        retry: { expertRetries: 4, chairRetries: 2, delay: 10 },
        output: { format: 'text', file: false, progress: false, logLevel: 'error' },
        report: 'html',
        findings: true,
        experts: [{ name: 'old', model: 'openai/old' }],
        chair: { agent: 'old-chair', model: 'openai/old' }
      },
      null,
      2
    ),
    'utf8'
  );

  const refused = await withCwd(root, () =>
    withFetch(fetch, () => commandInit({ task: '', command: 'init', local: true }))
  );
  assert.equal(refused, 1);
  const untouched = JSON.parse(readFileSync(configPath, 'utf8'));
  assert.deepEqual(untouched.experts.map(expert => expert.name), ['old']);

  const forced = await withCwd(root, () =>
    withFetch(fetch, () =>
      commandInit({ task: '', command: 'init', local: true, force: true })
    )
  );
  assert.equal(forced, 0);

  const merged = JSON.parse(readFileSync(configPath, 'utf8'));
  assert.deepEqual(merged.experts.map(expert => expert.name), ['arch', 'ux', 'ba', 'sec']);
  assert.equal(merged.localOnly, true);
  assert.equal(merged.autoDiscoverAgents, false);
  assert.deepEqual(merged.timeouts, { expert: 1111, chair: 2222, shutdown: 333 });
  assert.deepEqual(merged.retry, { expertRetries: 4, chairRetries: 2, delay: 10 });
  assert.deepEqual(merged.output, {
    format: 'text',
    file: false,
    progress: false,
    logLevel: 'error'
  });
  assert.equal(merged.report, 'html');
  assert.equal(merged.findings, true);
});

test('init --local: no providers is a usage error with statuses and a hint', async t => {
  const root = tempDir('init-local-none');
  t.after(() => cleanup(root));

  await assert.rejects(
    () =>
      withCwd(root, () =>
        withFetch(async () => jsonResponse({}, 500), () =>
          commandInit({ task: '', command: 'init', local: true })
        )
      ),
    error => {
      assert.ok(error instanceof UsageError);
      assert.match(error.message, /ollama/);
      assert.match(error.message, /lmstudio/);
      assert.match(error.message, /Ollama/);
      assert.match(error.message, /LM Studio/);
      return true;
    }
  );
  assert.equal(existsSync(join(root, 'consilium.config.json')), false);
});

test('init --free --local is rejected as a usage error', async () => {
  const local = parseArgs(['init', '--local']);
  assert.equal(local.command, 'init');
  assert.equal(local.local, true);

  assert.throws(() => parseArgs(['init', '--free', '--local']), UsageError);
  await assert.rejects(
    () => commandInit({ task: '', command: 'init', free: true, local: true }),
    UsageError
  );
});

test('audit: parses flags and stays an argv[0]-only command', () => {
  const options = parseArgs([
    'audit',
    '--since',
    'HEAD~1',
    '--max-cost',
    '0.25',
    '--json',
    '--findings',
    '--fail-on',
    'high',
    '-c',
    'consilium.config.json',
    '-s',
    '--dry-run'
  ]);

  assert.equal(options.command, 'audit');
  assert.equal(options.since, 'HEAD~1');
  assert.equal(options.maxCost, 0.25);
  assert.equal(options.json, true);
  assert.equal(options.findings, true);
  assert.equal(options.failOn, 'high');
  assert.equal(options.config, 'consilium.config.json');
  assert.equal(options.silent, true);
  assert.equal(options.dryRun, true);
  assert.ok(COMMANDS.has('audit'));

  const asTask = parseArgs(['--json', 'audit']);
  assert.equal(asTask.command, undefined);
  assert.equal(asTask.task, 'audit');
});

test('audit --dry-run prints ref, file count, truncation and task length', async t => {
  const root = createRepoWithCommits(t);
  const logs = captureLogs(t);

  const code = await withCwd(root, () =>
    commandAudit({ task: '', command: 'audit', since: 'HEAD~1', dryRun: true })
  );

  assert.equal(code, 0);
  const text = logs.join('\n');
  assert.match(text, /ref: HEAD~1/);
  assert.match(text, /files: 2/);
  assert.match(text, /truncated: false/);
  assert.match(text, /task length: \d+/);
});

test('audit: unsafe ref is rejected as a usage error', async t => {
  const root = createRepoWithCommits(t);

  await assert.rejects(
    () =>
      withCwd(root, () =>
        commandAudit({
          task: '',
          command: 'audit',
          since: '--upload-pack=touch /tmp/pwned',
          dryRun: true
        })
      ),
    error => {
      assert.ok(error instanceof UsageError);
      assert.match(error.message, /Недопустимый git ref/);
      return true;
    }
  );

  await assert.rejects(
    () => commandAudit({ task: '', command: 'audit' }),
    error => error instanceof UsageError && /--since/.test(error.message)
  );
});

test('audit delegates to run with the audit task and artifacts enabled', async t => {
  const root = createRepoWithCommits(t);
  let captured;

  const code = await withCwd(root, () =>
    commandAudit(
      { task: '', command: 'audit', since: 'HEAD~1' },
      {
        run: async options => {
          captured = options;
          return 0;
        }
      }
    )
  );

  assert.equal(code, 0);
  assert.equal(captured.command, 'run');
  assert.equal(captured.artifacts, true);
  assert.equal(captured.diff, false);
  assert.equal(captured.diffStaged, false);
  assert.equal(captured.diffBase, undefined);
  assert.match(captured.task, /Audit the changes since HEAD~1/);
  assert.match(captured.task, /\+export const version = 2;/);
  assert.match(captured.task, /\+export const added = true;/);
});

test('audit --fail-on forces findings for the delegated run', async t => {
  const root = createRepoWithCommits(t);
  let captured;

  await withCwd(root, () =>
    commandAudit(
      { task: '', command: 'audit', since: 'HEAD~1', failOn: 'high' },
      {
        run: async options => {
          captured = options;
          return 0;
        }
      }
    )
  );

  assert.equal(captured.failOn, 'high');
  assert.equal(captured.findings, true);
  assert.equal(captured.noFindings, false);
});
