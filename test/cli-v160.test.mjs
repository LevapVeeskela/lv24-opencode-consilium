import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, UsageError } from '../dist/interfaces/cli/args.js';
import { applyCliOverrides } from '../dist/interfaces/cli/overrides.js';
import { mergeWithDefaults, validateConfig } from '../dist/config.js';
import { commandEval } from '../dist/interfaces/cli/commands/eval.js';
import { commandModels } from '../dist/interfaces/cli/commands/models.js';
import { buildTask } from '../dist/interfaces/cli/task.js';
import { printHelp } from '../dist/interfaces/cli/help.js';

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), `consilium-${prefix}-`));
}

function cleanup(directory) {
  rmSync(directory, { recursive: true, force: true });
}

function finding(overrides = {}) {
  return {
    fingerprint: 'f_aaaaaaaa',
    severity: 'high',
    category: 'security',
    claim: 'The project lookup does not filter by owner',
    sources: [],
    contested: false,
    rejectedBy: [],
    ...overrides
  };
}

function writeFixture(root, name, expected, options = {}) {
  const directory = join(root, name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'task.md'), options.task ?? `Review ${name}\n`, 'utf8');
  if (options.diff !== undefined) {
    writeFileSync(join(directory, 'changes.diff'), options.diff, 'utf8');
  }
  writeFileSync(
    join(directory, 'expected.json'),
    `${JSON.stringify(expected, null, 2)}\n`,
    'utf8'
  );
  return directory;
}

function emptyModels() {
  return { models: [], sources: [], fromCache: false, fetchedAt: 0 };
}

function captureLogs(t) {
  const logs = [];
  t.mock.method(console, 'log', (...args) => {
    logs.push(args.join(' '));
  });
  return logs;
}

test('parseArgs: eval и новые флаги', () => {
  const options = parseArgs([
    'eval',
    '--fixtures',
    'custom/fixtures',
    '--json',
    '--fail-under',
    '85.5',
    '--max-cost',
    '0.25',
    '--context',
    'auto',
    '--reliability'
  ]);

  assert.equal(options.command, 'eval');
  assert.equal(options.fixtures, 'custom/fixtures');
  assert.equal(options.json, true);
  assert.equal(options.failUnder, 85.5);
  assert.equal(options.maxCost, 0.25);
  assert.equal(options.context, 'auto');
  assert.equal(options.reliability, true);

  assert.equal(parseArgs(['eval']).command, 'eval');
  // eval — команда только в самом начале argv; слово в задаче остаётся задачей.
  const asTask = parseArgs(['--json', 'eval']);
  assert.equal(asTask.command, undefined);
  assert.equal(asTask.task, 'eval');
});

test('parseArgs: --fail-under принимает 0..100 и отвергает выход за границы', () => {
  assert.equal(parseArgs(['--fail-under', '0']).failUnder, 0);
  assert.equal(parseArgs(['--fail-under', '100']).failUnder, 100);
  assert.throws(() => parseArgs(['--fail-under', '-1']), /0.*100/);
  assert.throws(() => parseArgs(['--fail-under', '101']), /0.*100/);
  assert.throws(() => parseArgs(['--fail-under', 'abc']), /0.*100/);
});

test('parseArgs: --context принимает только off и auto', () => {
  assert.equal(parseArgs(['--context', 'off']).context, 'off');
  assert.equal(parseArgs(['--context', 'auto']).context, 'auto');
  assert.throws(() => parseArgs(['--context', 'sometimes']), /off или auto/);
});

test('applyCliOverrides прокидывает context и конфиг по умолчанию off', () => {
  const base = mergeWithDefaults({});
  assert.equal(base.context, 'off');
  assert.equal(
    applyCliOverrides(base, parseArgs(['--context', 'auto', 'task'])).context,
    'auto'
  );
  assert.equal(
    applyCliOverrides(base, parseArgs(['--context', 'off', 'task'])).context,
    'off'
  );
});

test('validateConfig проверяет context', () => {
  const config = mergeWithDefaults({});
  config.context = 'sometimes';
  assert.ok(validateConfig(config).some(warning => warning.includes('context')));
});

test('help перечисляет eval и новые флаги', t => {
  const logs = captureLogs(t);
  printHelp();
  const text = logs.join('\n');
  assert.match(text, /consilium eval/);
  assert.match(text, /--fixtures/);
  assert.match(text, /--fail-under/);
  assert.match(text, /--context <off\|auto>/);
  assert.match(text, /--reliability/);
});

test('commandEval: markdown-сводка считает caught/missed и FP', async t => {
  const root = tempDir('eval-cli');
  t.after(() => cleanup(root));
  const fixtures = join(root, 'fixtures');
  mkdirSync(fixtures, { recursive: true });
  writeFixture(fixtures, '01-caught', {
    mustFind: [{ claimIncludes: 'does not filter by owner' }],
    mustNotFind: []
  });
  writeFixture(fixtures, '02-missed', {
    mustFind: [{ claimIncludes: 'path traversal' }],
    mustNotFind: [{ claimIncludes: 'style nit' }]
  });

  const logs = captureLogs(t);
  const calls = [];
  const code = await commandEval(
    { task: '', command: 'eval', fixtures: 'fixtures' },
    {
      cwd: root,
      runner: async fixture => {
        calls.push(fixture.name);
        if (fixture.name === '01-caught') {
          return {
            findings: [finding({ claim: 'The lookup does not filter by owner' })],
            latencyMs: 10,
            cost: 0.1
          };
        }
        return {
          findings: [finding({ claim: 'This style nit is benign', category: 'style' })],
          latencyMs: 20,
          cost: 0.2
        };
      }
    }
  );

  assert.equal(code, 0);
  assert.deepEqual(calls, ['01-caught', '02-missed']);
  const output = logs.join('\n');
  assert.match(output, /^# Consilium eval/m);
  assert.match(output, /Catch rate: 50\.0%/);
  assert.match(output, /False-positive rate: 50\.0%/);
  assert.match(output, /p50 latency: 15 ms/);
  assert.match(output, /\$0\.3000/);
  assert.match(output, /01-caught/);
  assert.match(output, /02-missed/);
});

test('commandEval: --json возвращает summary JSON', async t => {
  const root = tempDir('eval-json');
  t.after(() => cleanup(root));
  const fixtures = join(root, 'fixtures');
  mkdirSync(fixtures, { recursive: true });
  writeFixture(fixtures, 'only', {
    mustFind: [{ claimIncludes: 'sql injection' }],
    mustNotFind: []
  });

  const logs = captureLogs(t);
  const code = await commandEval(
    { task: '', command: 'eval', fixtures: 'fixtures', json: true },
    {
      cwd: root,
      runner: async () => ({
        findings: [finding({ claim: 'SQL injection in query' })],
        latencyMs: 5,
        cost: 0.01
      })
    }
  );

  assert.equal(code, 0);
  const parsed = JSON.parse(logs.join('\n'));
  assert.equal(parsed.totalFixtures, 1);
  assert.equal(parsed.catchRate, 1);
  assert.equal(parsed.fixtures[0].name, 'only');
});

test('commandEval: --fail-under ниже порога даёт код 3', async t => {
  const root = tempDir('eval-fail-under');
  t.after(() => cleanup(root));
  const fixtures = join(root, 'fixtures');
  mkdirSync(fixtures, { recursive: true });
  writeFixture(fixtures, 'misse', {
    mustFind: [{ claimIncludes: 'path traversal' }],
    mustNotFind: []
  });

  captureLogs(t);
  const runner = async () => ({ findings: [], latencyMs: 1 });
  assert.equal(
    await commandEval(
      { task: '', command: 'eval', fixtures: 'fixtures', failUnder: 1, json: true },
      { cwd: root, runner }
    ),
    3
  );
  assert.equal(
    await commandEval(
      { task: '', command: 'eval', fixtures: 'fixtures', failUnder: 0, json: true },
      { cwd: root, runner }
    ),
    0
  );
});

test('commandEval: ошибка фикстуры считается missed и показывается', async t => {
  const root = tempDir('eval-error');
  t.after(() => cleanup(root));
  const fixtures = join(root, 'fixtures');
  mkdirSync(fixtures, { recursive: true });
  writeFixture(fixtures, 'broken-run', {
    mustFind: [{ claimIncludes: 'payment error' }],
    mustNotFind: []
  });

  const logs = captureLogs(t);
  const code = await commandEval(
    { task: '', command: 'eval', fixtures: 'fixtures', json: true, failUnder: 1 },
    {
      cwd: root,
      runner: async () => {
        throw new Error('model unavailable');
      }
    }
  );

  assert.equal(code, 3);
  const parsed = JSON.parse(logs.join('\n'));
  assert.equal(parsed.fixtures[0].missed.length, 1);
  assert.equal(parsed.fixtures[0].error, 'model unavailable');
  assert.match(parsed.errors[0].message, /model unavailable/);
});

test('commandEval: --max-cost останавливает прогон и помечает skipped', async t => {
  const root = tempDir('eval-budget');
  t.after(() => cleanup(root));
  const fixtures = join(root, 'fixtures');
  mkdirSync(fixtures, { recursive: true });
  writeFixture(fixtures, '01-first', { mustFind: [], mustNotFind: [] });
  writeFixture(fixtures, '02-second', { mustFind: [], mustNotFind: [] });

  const logs = captureLogs(t);
  let calls = 0;
  const code = await commandEval(
    { task: '', command: 'eval', fixtures: 'fixtures', json: true, maxCost: 0.5 },
    {
      cwd: root,
      runner: async () => {
        calls += 1;
        return { findings: [], latencyMs: 3, cost: 1 };
      }
    }
  );

  assert.equal(code, 0);
  assert.equal(calls, 1);
  const parsed = JSON.parse(logs.join('\n'));
  assert.equal(parsed.totalFixtures, 2);
  assert.equal(parsed.fixtures[1].name, '02-second');
  assert.match(parsed.fixtures[1].error, /skipped/);
  assert.match(parsed.errors[0].message, /skipped/);
});

test('commandEval: отсутствующий каталог фикстур — UsageError с подсказкой', async t => {
  const root = tempDir('eval-missing');
  t.after(() => cleanup(root));
  captureLogs(t);

  await assert.rejects(
    () => commandEval({ task: '', command: 'eval' }, { cwd: root }),
    error => error instanceof UsageError && /--fixtures/.test(error.message)
  );
});

test('commandModels --reliability: пустое хранилище в text и JSON', async t => {
  const root = tempDir('models-reliability-empty');
  t.after(() => cleanup(root));
  const logs = captureLogs(t);

  const deps = { cwd: root, fetchModels: async () => emptyModels() };
  await commandModels(
    { task: '', command: 'models', reliability: true, json: true },
    deps
  );
  const parsed = JSON.parse(logs.join('\n'));
  assert.deepEqual(parsed.reliability, []);
  assert.deepEqual(parsed.models, []);

  logs.length = 0;
  await commandModels({ task: '', command: 'models', reliability: true }, deps);
  const text = logs.join('\n');
  assert.match(text, /Бесплатные модели/);
  assert.match(text, /Надёжность моделей: нет данных\./);
});

test('commandModels --reliability: повреждённый файл не ломает вывод', async t => {
  const root = tempDir('models-reliability-corrupt');
  t.after(() => cleanup(root));
  mkdirSync(join(root, '.consilium'), { recursive: true });
  writeFileSync(join(root, '.consilium', 'reliability.json'), '{ broken', 'utf8');

  const logs = captureLogs(t);
  await commandModels(
    { task: '', command: 'models', reliability: true, json: true },
    { cwd: root, fetchModels: async () => emptyModels() }
  );

  const parsed = JSON.parse(logs.join('\n'));
  assert.deepEqual(parsed.reliability, []);
});

test('commandModels --reliability: записи попадают в JSON и text-таблицу', async t => {
  const root = tempDir('models-reliability-data');
  t.after(() => cleanup(root));
  mkdirSync(join(root, '.consilium'), { recursive: true });
  writeFileSync(
    join(root, '.consilium', 'reliability.json'),
    `${JSON.stringify({
      version: 1,
      models: {
        'opencode/model-a': {
          attempts: 4,
          successes: 3,
          rateLimited: 1,
          timeouts: 0,
          unavailable: 0,
          empty: 0,
          otherErrors: 0,
          totalLatencyMs: 400,
          lastUsedAt: '2026-01-01T00:00:00.000Z'
        }
      }
    }, null, 2)}\n`,
    'utf8'
  );

  const logs = captureLogs(t);
  const deps = { cwd: root, fetchModels: async () => emptyModels() };
  await commandModels(
    { task: '', command: 'models', reliability: true, json: true },
    deps
  );
  const parsed = JSON.parse(logs.join('\n'));
  assert.equal(parsed.reliability.length, 1);
  assert.equal(parsed.reliability[0].model, 'opencode/model-a');
  assert.equal(parsed.reliability[0].attempts, 4);

  logs.length = 0;
  await commandModels({ task: '', command: 'models', reliability: true }, deps);
  assert.match(logs.join('\n'), /opencode\/model-a/);
});

test('buildTask: context off не меняет задачу, auto добавляет блок', async t => {
  const root = tempDir('task-context');
  t.after(() => cleanup(root));
  const config = mergeWithDefaults({ cwd: root });

  assert.equal(
    await buildTask({ task: 'review', context: 'off' }, config),
    'review'
  );
  assert.equal(await buildTask({ task: 'review' }, config), 'review');

  const errors = [];
  t.mock.method(console, 'error', (...args) => {
    errors.push(args.join(' '));
  });
  const task = await buildTask({ task: 'review', context: 'auto' }, config);
  assert.match(task, /^review\n\n<context>\n/);
  assert.match(task, /<\/context>$/);
  assert.match(task, /# Context pack/);
  assert.ok(errors.some(line => /files=.*rules=.*tests=.*chars=/.test(line)));
});
