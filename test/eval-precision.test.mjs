import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { matchFindings } from '../dist/domain/eval/matcher.js';
import { commandEval, packagedFixturesDir } from '../dist/interfaces/cli/commands/eval.js';
import { UsageError } from '../dist/interfaces/cli/args.js';

function finding(overrides = {}) {
  return {
    fingerprint: `fp-${Math.random().toString(16).slice(2)}`,
    severity: 'high',
    category: 'security',
    file: 'src/api/projects.ts',
    claim: 'The lookup does not filter by owner',
    sources: [{ agent: 'sec' }],
    contested: false,
    rejectedBy: [],
    ...overrides
  };
}

function writeFixture(root, name, expected) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'task.md'), 'Review the change.\n');
  fs.writeFileSync(path.join(dir, 'changes.diff'), '--- a/x\n+++ b/x\n@@\n+x\n');
  fs.writeFileSync(path.join(dir, 'expected.json'), JSON.stringify(expected));
}

test('matchFindings: выдуманные находки попадают в unexpected и снижают precision', () => {
  const expected = {
    mustFind: [{ claimIncludes: 'does not filter by owner' }],
    mustNotFind: [{ claimIncludes: 'the response should use status 204' }]
  };
  const findings = [
    finding(),
    finding({ claim: 'Possible timing attack in a helper that was not changed' }),
    finding({ claim: 'Variable naming is inconsistent', severity: 'low', category: 'style' })
  ];

  const result = matchFindings(findings, expected);
  assert.equal(result.caught.length, 1);
  assert.equal(result.falsePositives.length, 0, 'чучело mustNotFind не сработало');
  assert.equal(result.falsePositiveRate, 0, 'старая метрика шум не видит');
  assert.equal(result.unexpected.length, 2);
  assert.equal(result.precision, 1 / 3);
});

test('matchFindings: без находок precision равна 0, а не NaN', () => {
  const result = matchFindings([], { mustFind: [{ claimIncludes: 'x' }], mustNotFind: [] });
  assert.equal(result.precision, 0);
  assert.deepEqual(result.unexpected, []);
});

test('matchFindings: все находки ожидаемые — precision 1', () => {
  const result = matchFindings([finding()], {
    mustFind: [{ file: 'src/api/projects.ts', minSeverity: 'high' }],
    mustNotFind: []
  });
  assert.equal(result.precision, 1);
  assert.equal(result.unexpected.length, 0);
});

test('commandEval --json: сводка содержит findings, unexpected и precision', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'consilium-eval-prec-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fixtures = path.join(root, 'fixtures');
  writeFixture(fixtures, '01-idor', {
    mustFind: [{ claimIncludes: 'does not filter by owner' }],
    mustNotFind: []
  });

  const logs = [];
  t.mock.method(console, 'log', (...args) => logs.push(args.join(' ')));
  t.mock.method(console, 'error', () => {});

  const code = await commandEval(
    { task: '', command: 'eval', fixtures: 'fixtures', json: true },
    {
      cwd: root,
      runner: async () => ({
        findings: [finding(), finding({ claim: 'Unrelated guess one' }), finding({ claim: 'Unrelated guess two' }), finding({ claim: 'Unrelated guess three' })],
        latencyMs: 5
      })
    }
  );
  assert.equal(code, 0);

  const summary = JSON.parse(logs.join('\n'));
  assert.equal(summary.catchRate, 1);
  assert.equal(summary.findings, 4);
  assert.equal(summary.unexpected, 3);
  assert.equal(summary.precision, 0.25);
  assert.equal(summary.fixtures[0].unexpected.length, 3);
});

test('commandEval: без фикстур — ошибка с путём к набору из пакета, без запуска моделей', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'consilium-eval-none-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  let called = false;
  await assert.rejects(
    () =>
      commandEval(
        { task: '', command: 'eval' },
        {
          cwd: root,
          runner: async () => {
            called = true;
            return { findings: [], latencyMs: 1 };
          }
        }
      ),
    error =>
      error instanceof UsageError &&
      /--fixtures <dir>/.test(error.message) &&
      error.message.includes(packagedFixturesDir())
  );
  assert.equal(called, false);
  assert.ok(fs.existsSync(path.join(packagedFixturesDir(), '01-authz-idor', 'expected.json')));
});
