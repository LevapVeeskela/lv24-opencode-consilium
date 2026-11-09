import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acceptFindings,
  artifactFindings,
  emptyBaseline,
  evaluatePolicyGate,
  formatPolicyGate,
  loadBaseline,
  pruneBaseline,
  resolveBaselinePath,
  saveBaseline
} from '../dist/domain/artifacts/baseline.js';
import { EXIT_CODES, parseArgs } from '../dist/interfaces/cli/args.js';
import { main } from '../dist/interfaces/cli/main.js';
import { commandBaseline } from '../dist/interfaces/cli/commands/baseline.js';

function makeTemp() {
  return mkdtempSync(join(tmpdir(), 'consilium-baseline-'));
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

function finding(overrides = {}) {
  return {
    fingerprint: 'f_aaaaaaaa',
    severity: 'high',
    claim: 'Проблема',
    ...overrides
  };
}

function baselineOf(findings) {
  return {
    version: 1,
    updatedAt: '2026-01-01T00:00:00.000Z',
    findings
  };
}

function runFixture(id, findings, createdAt = '2026-01-01T00:00:00.000Z') {
  return {
    version: 1,
    id,
    createdAt,
    task: 'Задача',
    success: true,
    text: 'Итог',
    experts: [],
    models: {},
    metadata: {
      findings: {
        items: findings,
        counts: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
        rejected: [],
        parseErrors: []
      }
    }
  };
}

function writeRun(root, id, findings, createdAt) {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'run.json'),
    `${JSON.stringify(runFixture(id, findings, createdAt), null, 2)}\n`,
    'utf8'
  );
  return dir;
}

test('baseline: путь фиксирован в .consilium/baseline.json', () => {
  const cwd = makeTemp();
  try {
    assert.equal(
      resolveBaselinePath(cwd),
      join(cwd, '.consilium', 'baseline.json')
    );
    assert.equal(
      resolveBaselinePath(join(cwd, '.consilium', 'baseline.json')),
      join(cwd, '.consilium', 'baseline.json')
    );
  } finally {
    cleanup(cwd);
  }
});

test('baseline: round-trip и идемпотентный accept', () => {
  const cwd = makeTemp();
  try {
    const missing = loadBaseline(cwd);
    assert.deepEqual(missing.baseline.findings, []);
    assert.match(missing.warning ?? '', /baseline/i);

    const firstAt = new Date('2026-01-01T00:00:00.000Z');
    const first = acceptFindings(
      missing.baseline,
      [
        finding({ fingerprint: 'f_one', severity: 'high', claim: 'Первый' }),
        finding({ fingerprint: 'f_two', severity: 'low', claim: 'Второй' })
      ],
      firstAt
    );
    assert.equal(first.added, 2);
    assert.equal(first.updated, 0);

    const saved = saveBaseline(cwd, first.baseline, firstAt);
    assert.equal(saved.version, 1);
    assert.equal(saved.updatedAt, firstAt.toISOString());

    const reread = loadBaseline(cwd);
    assert.equal(reread.warning, undefined);
    assert.equal(reread.baseline.findings.length, 2);
    const acceptedAt = reread.baseline.findings[0].acceptedAt;
    assert.equal(acceptedAt, firstAt.toISOString());

    const second = acceptFindings(
      reread.baseline,
      [
        finding({ fingerprint: 'f_one', severity: 'critical', claim: 'Первый уточнён' }),
        finding({ fingerprint: 'f_two', severity: 'low', claim: 'Второй' })
      ],
      new Date('2026-02-01T00:00:00.000Z')
    );
    assert.equal(second.added, 0);
    assert.equal(second.updated, 2);
    assert.equal(second.baseline.findings[0].acceptedAt, acceptedAt);
    assert.equal(second.baseline.findings[0].severity, 'critical');
    assert.equal(second.baseline.findings[0].claim, 'Первый уточнён');
  } finally {
    cleanup(cwd);
  }
});

test('baseline: битый файл и некорректные записи не роняют чтение', () => {
  const cwd = makeTemp();
  try {
    mkdirSync(join(cwd, '.consilium'), { recursive: true });
    writeFileSync(join(cwd, '.consilium', 'baseline.json'), '{ broken', 'utf8');

    const corrupt = loadBaseline(cwd);
    assert.deepEqual(corrupt.baseline.findings, []);
    assert.match(corrupt.warning ?? '', /Некорректный baseline/);

    writeFileSync(
      join(cwd, '.consilium', 'baseline.json'),
      JSON.stringify({
        version: 1,
        updatedAt: '2026-01-01T00:00:00.000Z',
        findings: [
          {
            fingerprint: 'f_good',
            severity: 'medium',
            claim: 'Хорошая',
            acceptedAt: '2026-01-01T00:00:00.000Z'
          },
          { fingerprint: 'f_bad' }
        ]
      }),
      'utf8'
    );

    const partial = loadBaseline(cwd);
    assert.equal(partial.baseline.findings.length, 1);
    assert.equal(partial.baseline.findings[0].fingerprint, 'f_good');
    assert.match(partial.warning ?? '', /пропущено/);
  } finally {
    cleanup(cwd);
  }
});

test('baseline: prune по возрасту и удаление всех записей', () => {
  const now = new Date('2026-04-01T00:00:00.000Z');
  const baseline = baselineOf([
    {
      fingerprint: 'f_old',
      severity: 'high',
      claim: 'Старая',
      acceptedAt: '2025-01-01T00:00:00.000Z'
    },
    {
      fingerprint: 'f_new',
      severity: 'high',
      claim: 'Новая',
      acceptedAt: '2026-03-25T00:00:00.000Z'
    }
  ]);

  const byAge = pruneBaseline(baseline, { olderThanDays: 90, now });
  assert.equal(byAge.removed, 1);
  assert.deepEqual(byAge.baseline.findings.map(entry => entry.fingerprint), ['f_new']);

  const all = pruneBaseline(baseline, { all: true, now });
  assert.equal(all.removed, 2);
  assert.deepEqual(all.baseline.findings, []);
});

test('gate: порог, фильтрация baseline и код выхода 3', () => {
  const baseline = baselineOf([
    {
      fingerprint: 'f_known',
      severity: 'critical',
      claim: 'Уже принято',
      acceptedAt: '2026-01-01T00:00:00.000Z'
    }
  ]);
  const items = [
    finding({ fingerprint: 'f_known', severity: 'critical', claim: 'Уже принято' }),
    finding({
      fingerprint: 'f_high',
      severity: 'high',
      claim: 'Новая высокая',
      file: 'src/api.ts',
      line: 10
    }),
    finding({ fingerprint: 'f_medium', severity: 'medium', claim: 'Средняя' }),
    finding({ fingerprint: 'f_info', severity: 'info', claim: 'Инфо' })
  ];

  const gate = evaluatePolicyGate(items, baseline, 'high');
  assert.equal(gate.total, 4);
  assert.equal(gate.accepted, 1);
  assert.equal(gate.remaining, 3);
  assert.equal(gate.failed, true);
  assert.deepEqual(gate.violations.map(item => item.fingerprint), ['f_high']);
  assert.equal(gate.violationCounts.high, 1);
  assert.match(formatPolicyGate(gate), /src\/api\.ts:10/);

  const medium = evaluatePolicyGate(items, baseline, 'medium');
  assert.deepEqual(medium.violations.map(item => item.fingerprint), ['f_high', 'f_medium']);

  const disabled = evaluatePolicyGate(items, baseline, 'none');
  assert.equal(disabled.failed, false);
  assert.equal(disabled.violations.length, 0);
  assert.equal(EXIT_CODES.policyGate, 3);
});

test('gate: отчёт печатает не больше 10 находок', () => {
  const items = Array.from({ length: 12 }, (_unused, index) =>
    finding({
      fingerprint: `f_${index}`,
      severity: 'high',
      claim: `Находка ${index}`,
      file: 'src/a.ts',
      line: index + 1
    })
  );
  const gate = evaluatePolicyGate(items, emptyBaseline(), 'high');
  const text = formatPolicyGate(gate);
  const printed = text.split('\n').filter(line => line.startsWith('  - '));
  assert.equal(printed.length, 10);
  assert.match(text, /src\/a\.ts:1\b/);
  assert.match(text, /ещё 2/);
});

test('artifactFindings: читает items из metadata.findings и пропускает мусор', () => {
  const run = runFixture('20260101-000000-abcd', [
    finding({ fingerprint: 'f_high', severity: 'high', claim: 'Находка', file: 'a.ts', line: 3 }),
    { fingerprint: 'f_bad', severity: 'nope', claim: 'Плохая' }
  ]);
  const items = artifactFindings(run);
  assert.equal(items.length, 1);
  assert.equal(items[0].fingerprint, 'f_high');
});

test('CLI: baseline и --fail-on разбираются', () => {
  const accept = parseArgs(['baseline', 'accept', 'latest', '--dry-run']);
  assert.equal(accept.command, 'baseline');
  assert.equal(accept.baselineAction, 'accept');
  assert.equal(accept.baselineTarget, 'latest');
  assert.equal(accept.dryRun, true);

  const prune = parseArgs([
    'baseline',
    'prune',
    '--older-than',
    '30',
    '--all',
    '--yes'
  ]);
  assert.equal(prune.command, 'baseline');
  assert.equal(prune.baselineAction, 'prune');
  assert.equal(prune.olderThan, 30);
  assert.equal(prune.all, true);
  assert.equal(prune.yes, true);

  assert.equal(parseArgs(['задача']).failOn, 'none');

  const failOn = parseArgs(['run', '--fail-on', 'high', '--findings', 'задача']);
  assert.equal(failOn.command, 'run');
  assert.equal(failOn.failOn, 'high');
  assert.equal(failOn.findings, true);
  assert.equal(failOn.task, 'задача');

  assert.throws(() => parseArgs(['--fail-on', 'any']), /--fail-on/);
  assert.throws(() => parseArgs(['--older-than', '-1']), /целое число/);

  // baseline — команда только в начале argv, не после флагов.
  const notCommand = parseArgs(['--silent', 'baseline', 'prune']);
  assert.equal(notCommand.command, undefined);
  assert.equal(notCommand.task, 'baseline prune');
});

test('CLI: --fail-on high без --findings — ошибка использования (2)', async (t) => {
  const cwd = makeTemp();
  const previous = process.cwd();
  try {
    process.chdir(cwd);
    t.mock.method(console, 'error', () => {});
    t.mock.method(console, 'log', () => {});
    const code = await main(['--fail-on', 'high', '--dry-run', 'задача']);
    assert.equal(code, 2);

    const enabled = await main([
      '--fail-on',
      'high',
      '--findings',
      '--dry-run',
      'задача'
    ]);
    assert.equal(enabled, 0);
  } finally {
    process.chdir(previous);
    cleanup(cwd);
  }
});

test('CLI: baseline accept latest берёт самый свежий артефакт по mtime', async (t) => {
  const cwd = makeTemp();
  const previous = process.cwd();
  const runsRoot = join(cwd, '.consilium', 'runs');
  try {
    const olderById = writeRun(
      runsRoot,
      '20260101-000000-aaaa',
      [finding({ fingerprint: 'f_by_id', claim: 'Свежая по createdAt' })],
      '2026-04-01T00:00:00.000Z'
    );
    const newerByMtime = writeRun(
      runsRoot,
      '20260101-000000-bbbb',
      [finding({ fingerprint: 'f_by_mtime', claim: 'Свежая по mtime' })],
      '2026-01-01T00:00:00.000Z'
    );
    utimesSync(join(olderById, 'run.json'), new Date('2026-01-01'), new Date('2026-01-01'));
    utimesSync(join(newerByMtime, 'run.json'), new Date('2026-04-01'), new Date('2026-04-01'));

    process.chdir(cwd);
    const logs = [];
    t.mock.method(console, 'log', (...args) => logs.push(args.join(' ')));
    t.mock.method(console, 'error', () => {});

    const dryRun = await commandBaseline(
      parseArgs(['baseline', 'accept', 'latest', '--dry-run'])
    );
    assert.equal(dryRun, 0);
    assert.equal(existsSync(join(cwd, '.consilium', 'baseline.json')), false);

    const code = await commandBaseline(parseArgs(['baseline', 'accept', 'latest']));
    assert.equal(code, 0);
    const loaded = loadBaseline(cwd);
    assert.deepEqual(
      loaded.baseline.findings.map(entry => entry.fingerprint),
      ['f_by_mtime']
    );
    assert.match(logs.join('\n'), /добавлено 1/);
  } finally {
    process.chdir(previous);
    cleanup(cwd);
  }
});

test('CLI: baseline prune --all без --yes — код 2, файл не тронут', async (t) => {
  const cwd = makeTemp();
  const previous = process.cwd();
  try {
    mkdirSync(join(cwd, '.consilium'), { recursive: true });
    writeFileSync(
      join(cwd, '.consilium', 'baseline.json'),
      JSON.stringify(
        baselineOf([
          {
            fingerprint: 'f_one',
            severity: 'high',
            claim: 'Находка',
            acceptedAt: '2026-01-01T00:00:00.000Z'
          }
        ])
      ),
      'utf8'
    );

    process.chdir(cwd);
    t.mock.method(console, 'log', () => {});
    t.mock.method(console, 'error', () => {});

    assert.equal(await main(['baseline', 'prune', '--all']), 2);
    assert.equal(loadBaseline(cwd).baseline.findings.length, 1);

    assert.equal(await main(['baseline', 'prune', '--all', '--yes']), 0);
    assert.equal(loadBaseline(cwd).baseline.findings.length, 0);
  } finally {
    process.chdir(previous);
    cleanup(cwd);
  }
});
