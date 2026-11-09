import test from 'node:test';
import assert from 'node:assert/strict';
import {
  tokenize,
  jaccardSimilarity,
  analyzeConsensus,
  formatConsensusReport,
  buildConsensusPromptSection
} from '../dist/consensus.js';

test('jaccard: два пустых набора дают 0', () => {
  assert.equal(jaccardSimilarity([], []), 0);
});

test('jaccard: идентичные наборы дают 1, дубликаты игнорируются', () => {
  assert.equal(jaccardSimilarity(['a', 'b'], ['a', 'b']), 1);
  assert.equal(jaccardSimilarity(['a', 'a', 'b'], ['a', 'b', 'b']), 1);
});

test('jaccard: непересекающиеся наборы дают 0', () => {
  assert.equal(jaccardSimilarity(['postgres'], ['docker']), 0);
});

test('идентичные тексты: сходство 1.0 и согласие high', () => {
  const text = 'Микросервисная архитектура на Kubernetes с Postgres и Redis';
  const report = analyzeConsensus([
    { agent: 'alpha', text },
    { agent: 'beta', text }
  ]);
  assert.equal(report.experts, 2);
  assert.equal(report.averageSimilarity, 1);
  assert.equal(report.agreement, 'high');
  assert.equal(report.pairs.length, 1);
  assert.equal(report.pairs[0].similarity, 1);
});

test('разрозненные тексты: сходство 0 и согласие low', () => {
  const report = analyzeConsensus([
    { agent: 'alpha', text: 'postgres kubernetes' },
    { agent: 'beta', text: 'docker redis' }
  ]);
  assert.equal(report.averageSimilarity, 0);
  assert.equal(report.agreement, 'low');
});

test('частичное пересечение: согласие medium', () => {
  const report = analyzeConsensus([
    { agent: 'alpha', text: 'postgres kubernetes docker redis' },
    { agent: 'beta', text: 'postgres kubernetes nginx kafka' }
  ]);
  assert.ok(report.averageSimilarity >= 0.25 && report.averageSimilarity < 0.5);
  assert.equal(report.agreement, 'medium');
});

test('граница 0.5 даёт high', () => {
  const report = analyzeConsensus([
    { agent: 'alpha', text: 'postgres docker' },
    { agent: 'beta', text: 'postgres docker redis kafka' }
  ]);
  assert.equal(report.averageSimilarity, 0.5);
  assert.equal(report.agreement, 'high');
});

test('tokenize фильтрует стоп-слова и короткие токены', () => {
  assert.deepEqual(tokenize('это и в на the and for with'), []);
  assert.deepEqual(tokenize('a bb ccc я ты'), []);
});

test('tokenize поддерживает кириллицу и латиницу', () => {
  const tokens = tokenize('Архитектура микросервисов Architecture');
  assert.ok(tokens.includes('архитектура'));
  assert.ok(tokens.includes('микросервисов'));
  assert.ok(tokens.includes('architecture'));
});

test('tokenize убирает дубликаты с сохранением порядка', () => {
  assert.deepEqual(tokenize('Postgres docker postgres Docker'), ['postgres', 'docker']);
});

test('один эксперт: нет данных вместо 100% и high', () => {
  const report = analyzeConsensus([{ agent: 'solo', text: 'postgres kubernetes docker' }]);
  assert.equal(report.experts, 1);
  assert.equal(report.averageSimilarity, null);
  assert.equal(report.agreement, 'insufficient');
  assert.deepEqual(report.pairs, []);
  assert.match(report.summary, /нет данных/i);
  assert.doesNotMatch(report.summary, /100|высокое/);
  const text = formatConsensusReport(report);
  assert.match(text, /нет данных/);
  assert.doesNotMatch(text, /NaN|100%/);
  assert.match(buildConsensusPromptSection(report), /нет данных/);
});

test('ноль экспертов: пустой отчёт с пометкой нет данных', () => {
  const empty = analyzeConsensus([]);
  assert.equal(empty.experts, 0);
  assert.equal(empty.averageSimilarity, null);
  assert.equal(empty.agreement, 'none');
  assert.match(empty.summary, /нет данных/);
  assert.doesNotMatch(formatConsensusReport(empty), /NaN|0%/);
  assert.match(buildConsensusPromptSection(empty), /нет данных/);

  const failed = analyzeConsensus([
    { agent: 'x', text: 'postgres docker', success: false },
    { agent: 'y', text: '   ' }
  ]);
  assert.equal(failed.experts, 0);
  assert.equal(failed.averageSimilarity, null);
  assert.equal(failed.agreement, 'none');
  assert.match(failed.summary, /нет данных/);
});

test('неуспешные результаты исключаются из анализа', () => {
  const report = analyzeConsensus([
    { agent: 'alpha', text: 'postgres kubernetes docker' },
    { agent: 'beta', text: 'совсем другой вывод про очереди', success: false }
  ]);
  assert.equal(report.experts, 1);
});

test('uniqueTerms: общие токены исключены, сортировка по длине', () => {
  const report = analyzeConsensus([
    { agent: 'alpha', text: 'postgres kubernetes микросервисная' },
    { agent: 'beta', text: 'postgres docker redis' }
  ]);
  assert.ok(!report.uniqueTerms['alpha'].includes('postgres'));
  assert.ok(report.uniqueTerms['alpha'].includes('kubernetes'));
  assert.ok(report.uniqueTerms['beta'].includes('docker'));
  assert.ok(report.uniqueTerms['alpha'].length <= 8);
});

test('sharedTerms: только реально общие термины (два эксперта)', () => {
  const report = analyzeConsensus([
    { agent: 'a', text: 'postgres kubernetes docker' },
    { agent: 'b', text: 'postgres redis kafka' }
  ]);
  assert.deepEqual(report.sharedTerms, ['postgres']);
  assert.ok(report.uniqueTerms['a'].includes('kubernetes'));
  assert.ok(report.uniqueTerms['b'].includes('redis'));
});

test('sharedTerms: минимум у половины экспертов, кап 15', () => {
  const report = analyzeConsensus([
    { agent: 'a', text: 'postgres kubernetes docker' },
    { agent: 'b', text: 'postgres kubernetes redis' },
    { agent: 'c', text: 'postgres nginx kafka' }
  ]);
  assert.ok(report.sharedTerms.includes('postgres'));
  assert.ok(report.sharedTerms.length <= 15);
});

test('summary компактный: без дампа текстов, пары только с similarity > 0', () => {
  const report = analyzeConsensus([
    { agent: 'alpha', text: 'postgres kubernetes' },
    { agent: 'beta', text: 'docker redis' }
  ]);
  assert.match(report.summary, /Консенсус/);
  assert.ok(!report.summary.includes('↔') || report.pairs.some(p => p.similarity > 0) === false);
});

test('formatConsensusReport содержит ключевые разделы', () => {
  const report = analyzeConsensus([
    { agent: 'alpha', text: 'postgres kubernetes docker redis' },
    { agent: 'beta', text: 'postgres kubernetes nginx kafka' }
  ]);
  const text = formatConsensusReport(report);
  assert.match(text, /Отчёт о консенсусе/);
  assert.match(text, /postgres/);
  assert.match(text, /alpha/);
});

test('prompt-секция короткая и содержательная', () => {
  const long = Array.from({ length: 20 }, (_, i) => `уникальныйтермин${i} postgres kubernetes`).join(' ');
  const report = analyzeConsensus([
    { agent: 'alpha', text: long },
    { agent: 'beta', text: `${long} docker redis` },
    { agent: 'gamma', text: `${long} nginx kafka` }
  ]);
  const section = buildConsensusPromptSection(report);
  assert.ok(section.length < 1200, `длина ${section.length} >= 1200`);
  assert.match(section, /Консенсус/);
  assert.match(section, /postgres/);
});

test('детерминизм: повторный вызов даёт тот же результат', () => {
  const input = [
    { agent: 'alpha', text: 'postgres kubernetes docker redis' },
    { agent: 'beta', text: 'postgres nginx kafka docker' },
    { agent: 'gamma', text: 'микросервисы очереди события' }
  ];
  const first = analyzeConsensus(input);
  const second = analyzeConsensus(input);
  assert.deepEqual(second, first);
});

test('minTokenLength из опций учитывается', () => {
  const input = [
    { agent: 'alpha', text: 'ооп бэк' },
    { agent: 'beta', text: 'ооп бэк' }
  ];

  const report = analyzeConsensus(input, { minTokenLength: 3 });
  assert.equal(report.averageSimilarity, 1);

  const strict = analyzeConsensus(input);
  assert.equal(strict.averageSimilarity, 0);
});
