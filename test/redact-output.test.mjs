import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  redactDeep,
  redactHighConfidenceSecrets,
  redactSecrets
} from '../dist/shared/redact.js';
import { redactResultSecrets } from '../dist/application/run.js';
import { Consilium } from '../dist/application/consilium.js';
import { renderReport } from '../dist/report.js';
import { saveArtifact } from '../dist/infrastructure/artifacts/store.js';
import { cleanupDir, createFakeConfig, createFakeOpenCode } from './helpers/fake-opencode.mjs';

// Assembled at runtime so the repository itself contains no token-shaped literals.
const SECRETS = {
  openai: `sk-${'a1B2c3D4'.repeat(4)}`,
  githubOauth: `gho_${'Z9y8X7w6'.repeat(4)}`,
  githubServer: `ghs_${'Q1w2E3r4'.repeat(4)}`,
  gitlab: `glpat-${'m4N5o6P7'.repeat(3)}`,
  slack: `xoxb-${'1234567890'}-${'abcdefghij'}`,
  google: `AIza${'B'.repeat(35)}`,
  jwt: `eyJ${'hbGciOiJI'.repeat(2)}.eyJ${'zdWIiOiIx'.repeat(2)}.${'SflKxwRJSM'.repeat(2)}`,
  jsonKey: 'p4ssw0rd-value-123'
};

const PEM = [
  '-----BEGIN RSA PRIVATE KEY-----',
  'MIIEowIBAAKCAQEAexamplekeymaterial',
  '-----END RSA PRIVATE KEY-----'
].join('\n');

test('redactHighConfidenceSecrets: токены, PEM, JWT и JSON-поля', () => {
  const text = [
    `openai ${SECRETS.openai}`,
    `oauth ${SECRETS.githubOauth} server ${SECRETS.githubServer}`,
    `gitlab ${SECRETS.gitlab} slack ${SECRETS.slack}`,
    `google ${SECRETS.google}`,
    `jwt ${SECRETS.jwt}`,
    `{"apiKey": "${SECRETS.jsonKey}", "access_token":"${SECRETS.jsonKey}", "password": "${SECRETS.jsonKey}"}`,
    PEM
  ].join('\n');

  const redacted = redactHighConfidenceSecrets(text);
  for (const secret of Object.values(SECRETS)) {
    assert.ok(!redacted.includes(secret), `секрет не замаскирован: ${secret.slice(0, 6)}…`);
  }
  assert.ok(!redacted.includes('MIIEowIBAAKCAQEAexamplekeymaterial'));
  assert.match(redacted, /sk-\*\*\*/);
  assert.match(redacted, /gho_\*\*\*/);
  assert.match(redacted, /glpat-\*\*\*/);
  assert.match(redacted, /"apiKey": "\*\*\*"/);
  assert.match(redacted, /"access_token":"\*\*\*"/);
});

test('redactHighConfidenceSecrets: обычный текст ревью не портится', () => {
  const review = [
    'const token = getToken();',
    'if (!req.headers.authorization) return 401;',
    'api_key = config.apiKey',
    'The `token` field is compared with ==, use a constant-time check.',
    '{"token": "short"}'
  ].join('\n');
  assert.equal(redactHighConfidenceSecrets(review), review);
});

test('redactSecrets: прежние правила артефактов сохранены и дополнены', () => {
  assert.equal(redactSecrets('api_key=abcdef123456'), 'api_key=***');
  assert.equal(redactSecrets('token=abcd1234'), 'token=***');
  assert.equal(redactSecrets(`x ${SECRETS.githubOauth} y`), 'x gho_*** y');
});

test('redactDeep: строки во вложенных объектах и массивах, вход не меняется', () => {
  const source = {
    findings: { items: [{ claim: 'leak', evidence: `token ${SECRETS.openai}` }] },
    count: 2,
    nested: [`a ${SECRETS.gitlab}`, null, { deep: SECRETS.githubServer }]
  };
  const copy = redactDeep(source, redactHighConfidenceSecrets);

  assert.equal(copy.findings.items[0].evidence, 'token sk-***');
  assert.equal(copy.nested[0], 'a glpat-***');
  assert.equal(copy.nested[2].deep, 'ghs_***');
  assert.equal(copy.count, 2);
  assert.ok(source.findings.items[0].evidence.includes(SECRETS.openai), 'исходник не тронут');
});

function leakyResult() {
  return {
    text: `Chair: key ${SECRETS.openai}`,
    experts: [
      { agent: 'sec', text: `Found ${SECRETS.githubOauth} in config`, success: true },
      {
        agent: 'arch',
        text: '',
        success: false,
        errorCode: 'EXIT_ERROR',
        errorMessage: `401 for Bearer ${'t0k3n'.repeat(4)}`
      }
    ],
    chair: { agent: 'consilium', text: `Chair: key ${SECRETS.openai}`, success: true },
    totalTime: 1,
    parallelTime: 1,
    success: true,
    metadata: {
      findings: {
        items: [
          {
            fingerprint: 'fp-1',
            severity: 'high',
            category: 'security',
            file: 'src/config.ts',
            line: 3,
            claim: 'Hardcoded credential',
            evidence: `const key = "${SECRETS.google}"`,
            sources: [{ agent: 'sec' }],
            contested: false,
            rejectedBy: []
          }
        ],
        counts: { critical: 0, high: 1, medium: 0, low: 0, info: 0 },
        rejected: [],
        parseErrors: []
      }
    }
  };
}

test('redactResultSecrets: ни один формат отчёта не содержит секрет', () => {
  const result = leakyResult();
  redactResultSecrets(result);

  assert.equal(result.metadata.findings.items[0].fingerprint, 'fp-1', 'отпечаток не меняется');
  const outputs = [
    JSON.stringify(result),
    ...['pr', 'html', 'sarif', 'jira', 'linear'].map(format => renderReport(result, format))
  ];
  for (const output of outputs) {
    for (const secret of [SECRETS.openai, SECRETS.githubOauth, SECRETS.google, 't0k3nt0k3n']) {
      assert.ok(!output.includes(secret), 'секрет попал в вывод');
    }
  }
});

test('артефакт: metadata.findings маскируется в run.json', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'consilium-redact-')));
  try {
    const source = leakyResult();
    const ref = saveArtifact(
      {
        version: 1,
        id: '20261117-130000-beef',
        createdAt: new Date().toISOString(),
        task: 'Review',
        success: true,
        text: source.text,
        experts: source.experts.map(expert => ({
          agent: expert.agent,
          success: expert.success,
          text: expert.text,
          errorMessage: expert.errorMessage
        })),
        models: {},
        metadata: source.metadata
      },
      { root }
    );
    const stored = readFileSync(join(ref.dir, 'run.json'), 'utf8');
    for (const secret of [SECRETS.openai, SECRETS.githubOauth, SECRETS.google]) {
      assert.ok(!stored.includes(secret), 'секрет попал в run.json');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Consilium.run: секрет из ответа модели маскируется в результате', async () => {
  const body = `emit('answer with ' + ['sk', '${'a1B2c3D4'.repeat(4)}'].join('-'));`;
  const { dir, opencodePath } = createFakeOpenCode(body);
  try {
    const council = new Consilium(createFakeConfig(opencodePath, dir));
    const result = await council.run('Review the config');

    assert.equal(result.success, true);
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes(SECRETS.openai), 'секрет остался в результате');
    assert.match(result.text, /sk-\*\*\*/);
    assert.match(result.experts[0].text, /sk-\*\*\*/);
  } finally {
    cleanupDir(dir);
  }
});
