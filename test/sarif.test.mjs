import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSarifReport, sarifLevel } from '../dist/domain/artifacts/sarif.js';
import { renderReport, renderSarifReport } from '../dist/report.js';
import { parseArgs } from '../dist/interfaces/cli/args.js';
import { inferReportFormat, writeRunReport } from '../dist/interfaces/cli/output.js';

const INFORMATION_URI = 'https://github.com/LevapVeeskela/lv24-opencode-consilium';

function finding(overrides = {}) {
  return {
    fingerprint: 'f_default',
    severity: 'medium',
    category: 'general',
    claim: 'Default claim',
    sources: [],
    contested: false,
    rejectedBy: [],
    ...overrides
  };
}

function summary() {
  return {
    items: [
      finding({
        fingerprint: 'f_high_perf',
        severity: 'high',
        category: 'performance',
        claim: 'High performance issue',
        file: 'src/perf.ts',
        line: 42,
        sources: [{ agent: 'beta' }],
        contested: false,
        rejectedBy: []
      }),
      finding({
        fingerprint: 'f_low',
        severity: 'low',
        category: 'style',
        claim: 'Low style issue',
        file: 'src/style.ts',
        sources: [{ agent: 'alpha', model: 'prov/a' }],
        contested: false,
        rejectedBy: []
      }),
      finding({
        fingerprint: 'f_critical',
        severity: 'critical',
        category: 'security',
        claim: 'Critical security issue',
        file: 'src\\a.ts',
        line: 10,
        evidence: 'Unsafe input reaches the query.',
        confidence: 0.95,
        sources: [
          { agent: 'alpha', model: 'prov/a' },
          { agent: 'beta' }
        ],
        contested: true,
        rejectedBy: ['beta']
      }),
      finding({
        fingerprint: 'f_medium',
        severity: 'medium',
        category: 'quality',
        claim: 'Medium quality issue',
        file: 'src/quality.ts',
        sources: [{ agent: 'alpha' }],
        contested: false,
        rejectedBy: []
      }),
      finding({
        fingerprint: 'f_info',
        severity: 'info',
        category: 'docs',
        claim: 'Info documentation issue',
        sources: [],
        contested: false,
        rejectedBy: []
      }),
      finding({
        fingerprint: 'f_high_arch',
        severity: 'high',
        category: 'architecture',
        claim: 'High architecture issue',
        file: 'src/arch.ts',
        line: 7,
        sources: [],
        contested: false,
        rejectedBy: []
      })
    ],
    counts: { critical: 1, high: 2, medium: 1, low: 1, info: 1 },
    rejected: [],
    parseErrors: []
  };
}

function baseResult(findings = summary()) {
  return {
    text: 'chair verdict',
    experts: [],
    chair: { agent: 'chair', text: 'chair verdict', success: true },
    totalTime: 1,
    parallelTime: 1,
    success: true,
    metadata: findings === undefined ? {} : { findings }
  };
}

function runOf(document) {
  return document.runs[0];
}

function resultByClaim(document, claim) {
  return runOf(document).results.find(result => result.message.text === claim);
}

test('SARIF: схема, версия, run, tool.driver и rules', () => {
  const document = buildSarifReport(summary(), { version: '1.8.0' });
  const run = runOf(document);

  assert.equal(document.$schema, 'https://json.schemastore.org/sarif-2.1.0.json');
  assert.equal(document.version, '2.1.0');
  assert.equal(document.runs.length, 1);
  assert.equal(run.tool.driver.name, 'lv24-opencode-consilium');
  assert.equal(run.tool.driver.version, '1.8.0');
  assert.equal(run.tool.driver.informationUri, INFORMATION_URI);
  assert.deepEqual(run.invocations, [{ executionSuccessful: true }]);
  assert.equal(run.results.length, 6);

  const ruleIds = run.tool.driver.rules.map(rule => rule.id);
  assert.deepEqual(
    ruleIds,
    [
      'consilium/architecture',
      'consilium/docs',
      'consilium/performance',
      'consilium/quality',
      'consilium/security',
      'consilium/style'
    ]
  );
  for (const rule of run.tool.driver.rules) {
    assert.match(rule.id, /^consilium\/[a-z0-9-]+$/);
    assert.equal(typeof rule.shortDescription.text, 'string');
    assert.ok(rule.shortDescription.text.length > 0);
  }

  for (const result of run.results) {
    assert.ok(ruleIds.includes(result.ruleId), `unknown ruleId: ${result.ruleId}`);
  }
});

test('SARIF: сопоставление серьёзности уровню', () => {
  const document = buildSarifReport(summary(), { version: '1.8.0' });

  assert.equal(sarifLevel('critical'), 'error');
  assert.equal(sarifLevel('high'), 'error');
  assert.equal(sarifLevel('medium'), 'warning');
  assert.equal(sarifLevel('low'), 'note');
  assert.equal(sarifLevel('info'), 'note');

  assert.equal(resultByClaim(document, 'Critical security issue').level, 'error');
  assert.equal(resultByClaim(document, 'High performance issue').level, 'error');
  assert.equal(resultByClaim(document, 'High architecture issue').level, 'error');
  assert.equal(resultByClaim(document, 'Medium quality issue').level, 'warning');
  assert.equal(resultByClaim(document, 'Low style issue').level, 'note');
  assert.equal(resultByClaim(document, 'Info documentation issue').level, 'note');
});

test('SARIF: locations с прямыми слэшами, startLine только при line > 0', () => {
  const document = buildSarifReport(summary(), { version: '1.8.0' });

  const critical = resultByClaim(document, 'Critical security issue');
  assert.equal(critical.locations.length, 1);
  assert.equal(
    critical.locations[0].physicalLocation.artifactLocation.uri,
    'src/a.ts'
  );
  assert.equal(critical.locations[0].physicalLocation.region.startLine, 10);
  assert.ok(!critical.locations[0].physicalLocation.artifactLocation.uri.includes('\\'));

  const medium = resultByClaim(document, 'Medium quality issue');
  assert.equal(medium.locations[0].physicalLocation.artifactLocation.uri, 'src/quality.ts');
  assert.equal('region' in medium.locations[0].physicalLocation, false);

  const info = resultByClaim(document, 'Info documentation issue');
  assert.equal('locations' in info, false);
});

test('SARIF: fingerprint и properties находки', () => {
  const document = buildSarifReport(summary(), { version: '1.8.0' });
  const critical = resultByClaim(document, 'Critical security issue');

  assert.deepEqual(critical.partialFingerprints, {
    primaryLocationLineHash: 'f_critical'
  });
  assert.equal(critical.properties.category, 'security');
  assert.equal(critical.properties.confidence, 0.95);
  assert.deepEqual(critical.properties.sources, [
    { agent: 'alpha', model: 'prov/a' },
    { agent: 'beta' }
  ]);
  assert.equal(critical.properties.contested, true);
  assert.deepEqual(critical.properties.rejectedBy, ['beta']);
  assert.equal(critical.properties.severity, 'critical');
  assert.equal(critical.message.text, 'Critical security issue');
  assert.match(critical.message.markdown, /Unsafe input reaches the query\./);

  const info = resultByClaim(document, 'Info documentation issue');
  assert.equal(info.properties.contested, false);
  assert.deepEqual(info.properties.sources, []);
});

test('SARIF: пустые и отсутствующие находки дают валидный документ', () => {
  const empty = buildSarifReport(
    { items: [], counts: { critical: 0, high: 0, medium: 0, low: 0, info: 0 }, rejected: [], parseErrors: [] },
    { version: '1.8.0' }
  );
  assert.deepEqual(runOf(empty).results, []);
  assert.deepEqual(runOf(empty).tool.driver.rules, []);
  assert.deepEqual(runOf(empty).invocations, [{ executionSuccessful: true }]);

  const missing = buildSarifReport(undefined, { version: '1.8.0' });
  assert.deepEqual(runOf(missing).results, []);
  assert.deepEqual(runOf(missing).tool.driver.rules, []);

  const rendered = renderSarifReport(baseResult(empty), '1.8.0');
  const parsed = JSON.parse(rendered);
  assert.equal(parsed.version, '2.1.0');
  assert.deepEqual(parsed.runs[0].results, []);
});

test('SARIF: детерминированный порядок severity desc, затем claim', () => {
  const forward = buildSarifReport(summary(), { version: '1.8.0' });
  const reversedSummary = summary();
  reversedSummary.items.reverse();
  const reversed = buildSarifReport(reversedSummary, { version: '1.8.0' });

  assert.equal(JSON.stringify(forward), JSON.stringify(reversed));
  assert.deepEqual(
    runOf(forward).results.map(result => result.message.text),
    [
      'Critical security issue',
      'High architecture issue',
      'High performance issue',
      'Medium quality issue',
      'Low style issue',
      'Info documentation issue'
    ]
  );
});

test('SARIF: renderReport и версия по умолчанию', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const rendered = renderReport(baseResult(), 'sarif', { version: '2.2.2' });
  const document = JSON.parse(rendered);

  assert.equal(document.version, '2.1.0');
  assert.equal(document.runs[0].tool.driver.version, '2.2.2');

  const defaultDocument = JSON.parse(renderSarifReport(baseResult()));
  assert.equal(defaultDocument.runs[0].tool.driver.version, pkg.version);
  assert.ok(rendered.endsWith('\n'));
});

test('CLI: --report sarif и вывод формата из .sarif', () => {
  const options = parseArgs(['--report', 'sarif', '--report-file', 'out/report.sarif', 'задача']);
  assert.equal(options.report, 'sarif');
  assert.equal(options.reportFile, 'out/report.sarif');

  assert.equal(inferReportFormat('report.sarif'), 'sarif');
  assert.equal(inferReportFormat('REPORT.SARIF'), 'sarif');
  assert.equal(inferReportFormat('report.sarif.json'), 'sarif');
  assert.equal(inferReportFormat('report.html'), 'html');
  assert.equal(inferReportFormat('report.md'), 'pr');

  assert.throws(() => parseArgs(['--report', 'pdf']), /Неизвестный формат отчёта/);
});

test('CLI: отчёт .sarif записывается атомарно и парсится', () => {
  const dir = mkdtempSync(join(tmpdir(), 'consilium-sarif-'));
  try {
    const target = join(dir, 'report.sarif');
    const printed = writeRunReport(
      baseResult(),
      { cwd: dir, version: '1.8.0', output: { format: 'text' } },
      { task: '', reportFile: target, silent: true }
    );

    assert.equal(printed, false);
    const document = JSON.parse(readFileSync(target, 'utf8'));
    assert.equal(document.$schema, 'https://json.schemastore.org/sarif-2.1.0.json');
    assert.equal(document.version, '2.1.0');
    assert.equal(document.runs[0].tool.driver.version, '1.8.0');
    assert.equal(document.runs[0].results.length, 6);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: --report sarif без файла и -f json предупреждает, stdout чист', t => {
  const dir = mkdtempSync(join(tmpdir(), 'consilium-sarif-'));
  const stdout = [];
  const stderr = [];
  t.mock.method(console, 'log', (...args) => stdout.push(args.join(' ')));
  t.mock.method(console, 'error', (...args) => stderr.push(args.join(' ')));

  try {
    const printed = writeRunReport(
      baseResult(),
      { cwd: dir, version: '1.8.0', output: { format: 'json' } },
      { task: '', report: 'sarif', format: 'json' }
    );

    assert.equal(printed, false);
    assert.deepEqual(stdout, []);
    assert.match(stderr.join('\n'), /--report-file/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
