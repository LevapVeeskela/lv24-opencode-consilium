import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, main } from '../dist/cli.js';
import { printSummary } from '../dist/interfaces/cli/output.js';

test('задача из позиционных аргументов', () => {
  const options = parseArgs(['оцени', 'архитектуру']);
  assert.equal(options.task, 'оцени архитектуру');
  assert.equal(options.command, undefined);
});

test('команда models с флагами', () => {
  const options = parseArgs(['models', '--available', '--limit', '5']);
  assert.equal(options.command, 'models');
  assert.equal(options.available, true);
  assert.equal(options.limit, 5);
});

test('-- разделитель позволяет задачу с дефиса', () => {
  const options = parseArgs(['--preset', 'fast', '--', '-weird', 'task']);
  assert.equal(options.preset, 'fast');
  assert.equal(options.task, '-weird task');
});

test('--json включает json-формат', () => {
  const options = parseArgs(['--json', 'задача']);
  assert.equal(options.format, 'json');
  assert.equal(options.json, true);
});

test('одиночный - включает чтение stdin вместе с задачей', () => {
  const options = parseArgs(['сделай', 'ревью', '-']);
  assert.equal(options.taskFile, '-');
  assert.equal(options.task, 'сделай ревью');
});

test('--init включает команду init', () => {
  const options = parseArgs(['--init']);
  assert.equal(options.command, 'init');
});

test('--native-v2 и --install --global разбираются', () => {
  const init = parseArgs(['init', '--free', '--native-v2']);
  assert.equal(init.command, 'init');
  assert.equal(init.nativeV2, true);

  const install = parseArgs(['mcp', '--install', '--global']);
  assert.equal(install.command, 'mcp');
  assert.equal(install.mcpInstall, true);
  assert.equal(install.globalConfig, true);
});

test('флаги артефактов, консенсуса и стоимости разбираются', () => {
  const options = parseArgs([
    '--artifacts',
    '--consensus',
    '--smart-experts',
    '--max-cost',
    '0.5',
    '--fallback-models',
    'a/b, c/d',
    '--session',
    'council-1',
    '--replay',
    'run-1',
    'задача'
  ]);

  assert.equal(options.artifacts, true);
  assert.equal(options.consensus, true);
  assert.equal(options.smartExperts, true);
  assert.equal(options.maxCost, 0.5);
  assert.deepEqual(options.fallbackModels, ['a/b', 'c/d']);
  assert.equal(options.session, 'council-1');
  assert.equal(options.replay, 'run-1');

  const diff = parseArgs(['--diff-runs', 'a', 'b']);
  assert.deepEqual(diff.diffRuns, ['a', 'b']);

  const dir = parseArgs(['--artifacts-dir', 'runs']);
  assert.equal(dir.artifacts, 'runs');
  assert.equal(dir.artifactsDir, 'runs');

  const off = parseArgs(['--no-artifacts', '--no-consensus']);
  assert.equal(off.noArtifacts, true);
  assert.equal(off.noConsensus, true);
});

test('неизвестный флаг — ошибка', () => {
  assert.throws(() => parseArgs(['--wat']), /Неизвестный флаг/);
});

test('флаг без значения — ошибка', () => {
  assert.throws(() => parseArgs(['--config']), /требует значение/);
});

test('некорректный retries — ошибка', () => {
  assert.throws(() => parseArgs(['-r', 'abc']), /целое число/);
  assert.throws(() => parseArgs(['-r', '-1']), /целое число/);
});

test('некорректный формат — ошибка', () => {
  assert.throws(() => parseArgs(['-f', 'yaml']), /Неизвестный формат/);
});

test('неизвестный пресет — код выхода 2', async (t) => {
  t.mock.method(console, 'error', () => {});
  const code = await main(['--preset', 'nope', '--dry-run', 'task']);
  assert.equal(code, 2);
});

test('неизвестный эксперт — код выхода 2', async (t) => {
  t.mock.method(console, 'error', () => {});
  const code = await main(['-e', 'nope', '--dry-run', 'task']);
  assert.equal(code, 2);
});

test('флаги отчёта, варианта и watch разбираются', () => {
  const options = parseArgs([
    '--report',
    'html',
    '--report-file',
    'out/report.html',
    '--variant',
    'high',
    '--debounce',
    '250',
    'задача'
  ]);

  assert.equal(options.report, 'html');
  assert.equal(options.reportFile, 'out/report.html');
  assert.equal(options.variant, 'high');
  assert.equal(options.debounceMs, 250);

  assert.throws(() => parseArgs(['--report', 'pdf']), /Неизвестный формат отчёта/);
  assert.throws(() => parseArgs(['--debounce', '-5']), /целое число/);
});

test('команды watch и hooks разбираются', () => {
  assert.equal(parseArgs(['watch']).command, 'watch');
  assert.equal(parseArgs(['watch', '--debounce', '100', 'ревью']).debounceMs, 100);

  const install = parseArgs(['hooks', 'install']);
  assert.equal(install.command, 'hooks');
  assert.equal(install.hookAction, 'install');
  assert.equal(install.task, '');

  const uninstall = parseArgs(['hooks', 'uninstall']);
  assert.equal(uninstall.hookAction, 'uninstall');
});

test('hooks с неизвестным действием — код 2 и без установки', async (t) => {
  t.mock.method(console, 'error', () => {});
  assert.equal(await main(['hooks', 'remove']), 2);
  assert.equal(await main(['hooks']), 2);
});

test('printSummary: консенсус без данных не печатает NaN и проценты', (t) => {
  const lines = [];
  t.mock.method(console, 'error', (...args) => {
    lines.push(args.join(' '));
  });

  const result = {
    text: 'готово',
    experts: [],
    chair: { agent: 'consilium', text: 'готово', success: true },
    totalTime: 1000,
    parallelTime: 0,
    success: true,
    metadata: {
      consensus: {
        experts: 1,
        averageSimilarity: null,
        agreement: 'insufficient'
      }
    }
  };

  printSummary(result, {});
  const output = lines.join('\n');
  assert.match(output, /Согласие экспертов: нет данных/);
  assert.doesNotMatch(output, /NaN|100%|insufficient/);
});
