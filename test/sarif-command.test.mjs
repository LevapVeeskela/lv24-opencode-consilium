import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, UsageError } from '../dist/interfaces/cli/args.js';
import { commandSarif } from '../dist/interfaces/cli/commands/sarif.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

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
    claim: 'The alpha bug is real',
    sources: [{ agent: 'arch' }],
    contested: false,
    rejectedBy: [],
    ...overrides
  };
}

function makeRun(id, createdAt, findings) {
  return {
    version: 1,
    id,
    createdAt,
    task: `Task ${id}`,
    success: true,
    text: `Result ${id}`,
    experts: [],
    models: {},
    metadata: findings === undefined ? {} : { findings }
  };
}

function writeRun(runsDir, run, mtime) {
  const directory = join(runsDir, run.id);
  mkdirSync(directory, { recursive: true });
  const file = join(directory, 'run.json');
  writeFileSync(file, `${JSON.stringify(run, null, 2)}\n`, 'utf8');
  if (mtime !== undefined) {
    utimesSync(file, mtime, mtime);
  }
  return file;
}

function summary(items) {
  return {
    items,
    counts: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
    rejected: [],
    parseErrors: []
  };
}

function makeProject(root, items, id = '20260101-000000-aaaa') {
  const runsDir = join(root, '.consilium', 'runs');
  writeRun(
    runsDir,
    makeRun(id, '2026-01-01T00:00:00.000Z', summary(items))
  );
  return runsDir;
}

function captureConsole(t) {
  const logs = [];
  const errors = [];
  t.mock.method(console, 'log', (...args) => {
    logs.push(args.join(' '));
  });
  t.mock.method(console, 'error', (...args) => {
    errors.push(args.join(' '));
  });
  return { logs, errors };
}

test('parseArgs: sarif регистрируется только первым аргументом и понимает --run/--output', () => {
  const options = parseArgs(['sarif', '--run', 'latest', '--output', 'out.sarif']);
  assert.equal(options.command, 'sarif');
  assert.equal(options.run, 'latest');
  assert.equal(options.output, 'out.sarif');

  // Не в начале argv слово "sarif" остаётся частью задачи.
  const asTask = parseArgs(['--run', 'latest', 'sarif']);
  assert.equal(asTask.command, undefined);
  assert.equal(asTask.task, 'sarif');

  assert.throws(() => parseArgs(['sarif', '--run']), UsageError);
});

test('commandSarif --output: пишет SARIF атомарно и печатает сводку в stderr', async t => {
  const root = tempDir('sarif-output');
  t.after(() => cleanup(root));
  makeProject(root, [
    finding({ severity: 'critical', claim: 'Critical issue', file: 'src/a.ts', line: 7 }),
    finding({ fingerprint: 'f_bbbbbbbb', severity: 'low', claim: 'Low issue' })
  ]);
  const { logs, errors } = captureConsole(t);

  const code = await commandSarif(
    { task: '', command: 'sarif', output: 'consilium.sarif' },
    { cwd: root }
  );

  assert.equal(code, 0);
  assert.deepEqual(logs, []);

  const target = join(root, 'consilium.sarif');
  assert.equal(existsSync(target), true);
  const document = JSON.parse(readFileSync(target, 'utf8'));
  assert.equal(document.$schema, 'https://json.schemastore.org/sarif-2.1.0.json');
  assert.equal(document.version, '2.1.0');
  assert.equal(document.runs.length, 1);
  assert.equal(document.runs[0].tool.driver.version, pkg.version);
  assert.equal(document.runs[0].results.length, 2);
  assert.deepEqual(
    document.runs[0].results.map(result => result.message.text),
    ['Critical issue', 'Low issue']
  );

  assert.equal(errors.length, 1);
  assert.match(errors[0], /SARIF: находок 2/);
  assert.match(errors[0], /consilium\.sarif/);
});

test('commandSarif без --output: печатает чистый JSON в stdout', async t => {
  const root = tempDir('sarif-stdout');
  t.after(() => cleanup(root));
  makeProject(root, [finding({ claim: 'Stdout finding' })]);
  const { logs, errors } = captureConsole(t);

  const code = await commandSarif({ task: '', command: 'sarif' }, { cwd: root });

  assert.equal(code, 0);
  assert.equal(logs.length, 1);
  const document = JSON.parse(logs[0]);
  assert.equal(document.version, '2.1.0');
  assert.equal(document.runs[0].results.length, 1);
  assert.equal(document.runs[0].results[0].message.text, 'Stdout finding');
  assert.deepEqual(errors, []);
  assert.equal(existsSync(join(root, '.consilium', 'runs', 'sarif.sarif')), false);
});

test('commandSarif latest: выбирает самый новый run.json по mtime', async t => {
  const root = tempDir('sarif-latest');
  t.after(() => cleanup(root));
  const runsDir = join(root, '.consilium', 'runs');

  // createdAt новее у первого, но mtime новее у второго:
  // latest обязан ориентироваться на mtime, а не на createdAt/listArtifacts-порядок.
  writeRun(
    runsDir,
    makeRun('20260201-000000-aaaa', '2026-02-01T00:00:00.000Z', summary([
      finding({ claim: 'Older-by-mtime finding' })
    ])),
    new Date('2026-01-01T00:00:00.000Z')
  );
  writeRun(
    runsDir,
    makeRun('20260101-000000-bbbb', '2026-01-01T00:00:00.000Z', summary([
      finding({ fingerprint: 'f_cccccccc', claim: 'Newest-by-mtime finding' })
    ])),
    new Date('2026-03-01T00:00:00.000Z')
  );

  const { logs } = captureConsole(t);
  const code = await commandSarif(
    { task: '', command: 'sarif', output: 'latest.sarif' },
    { cwd: root }
  );

  assert.equal(code, 0);
  assert.equal(logs.length, 0);
  const document = JSON.parse(readFileSync(join(root, 'latest.sarif'), 'utf8'));
  assert.equal(document.runs[0].results.length, 1);
  assert.equal(document.runs[0].results[0].message.text, 'Newest-by-mtime finding');
});

test('commandSarif: отсутствие .consilium/runs и неизвестный run дают UsageError с подсказкой', async t => {
  const root = tempDir('sarif-missing');
  t.after(() => cleanup(root));

  await assert.rejects(
    () => commandSarif({ task: '', command: 'sarif' }, { cwd: root }),
    error =>
      error instanceof UsageError &&
      /--artifacts/.test(error.message) &&
      /\.consilium|runs/.test(error.message)
  );

  makeProject(root, [finding()]);
  await assert.rejects(
    () => commandSarif({ task: '', command: 'sarif', run: 'no-such-run' }, { cwd: root }),
    error => error instanceof UsageError && /не найден/i.test(error.message)
  );
});

test('commandSarif: запуск без находок даёт валидный пустой SARIF и помечает его', async t => {
  const root = tempDir('sarif-empty');
  t.after(() => cleanup(root));
  makeProject(root, []);
  const { logs, errors } = captureConsole(t);

  const code = await commandSarif(
    { task: '', command: 'sarif', output: 'empty.sarif' },
    { cwd: root }
  );

  assert.equal(code, 0);
  assert.deepEqual(logs, []);
  const document = JSON.parse(readFileSync(join(root, 'empty.sarif'), 'utf8'));
  assert.deepEqual(document.runs[0].results, []);
  assert.deepEqual(document.runs[0].tool.driver.rules, []);
  assert.deepEqual(document.runs[0].invocations, [{ executionSuccessful: true }]);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /SARIF: находок 0/);
  assert.match(errors[0], /пустой/);
  assert.match(errors[0], /empty\.sarif/);
});

test('commandSarif: позиционные аргументы запрещены', async () => {
  await assert.rejects(
    () => commandSarif({ task: 'extra', command: 'sarif' }),
    error => error instanceof UsageError && /позиционные/.test(error.message)
  );
});
