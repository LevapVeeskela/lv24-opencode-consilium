import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseFindingsBlock,
  mergeFindings,
  fingerprintFinding,
  findingsAtLeast,
  maxSeverity,
  countBySeverity,
  claimSimilarity
} from '../dist/domain/council/findings.js';

const block = (payload) => '```json\n' + JSON.stringify(payload, null, 2) + '\n```';

const PARAPHRASE_A =
  'Функция add выполняет вычитание вместо сложения, нарушая контракт своего имени.';
const PARAPHRASE_B =
  'Функция add выполняет вычитание вместо сложения, нарушая контракт, заданный её именем.';

test('parseFindingsBlock: валидный блок с findings и rejected', () => {
  const text = `Ответ эксперта.\n${block({
    findings: [
      {
        severity: 'high',
        category: 'security',
        file: 'src/auth.ts',
        line: 42,
        claim: 'Нет проверки прав на удаление',
        evidence: 'handler не вызывает authorize()',
        confidence: 0.9
      }
    ],
    rejected: [{ claim: 'Проверка есть в middleware', reason: 'middleware не подключён' }]
  })}`;
  const result = parseFindingsBlock(text);
  assert.equal(result.error, undefined);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].severity, 'high');
  assert.equal(result.findings[0].line, 42);
  assert.equal(result.rejected.length, 1);
  assert.match(result.rejected[0].reason, /middleware/);
});

test('parseFindingsBlock: нет блока / битый JSON / не тот shape', () => {
  assert.equal(parseFindingsBlock('просто текст').error, 'no-block');
  assert.equal(parseFindingsBlock('```json\n{ broken\n```').error, 'invalid-json');
  assert.equal(parseFindingsBlock(block({ answer: 'ok' })).error, 'invalid-json');
});

test('parseFindingsBlock: берёт последний валидный блок', () => {
  const text = `${block({ findings: [{ claim: 'старая' }] })}\n${block({
    findings: [{ claim: 'новая' }]
  })}`;
  const result = parseFindingsBlock(text);
  assert.equal(result.findings[0].claim, 'новая');
});

test('parseFindingsBlock: битые находки отбрасываются, severity/confidence нормализуются', () => {
  const result = parseFindingsBlock(
    block({
      findings: [
        { claim: '' },
        { claim: 'ok', severity: 'BLOCKER', confidence: 42 },
        { claim: 'ok2', severity: 'low', confidence: 0.456 }
      ]
    })
  );
  assert.equal(result.findings.length, 2);
  assert.equal(result.findings[0].severity, 'medium');
  assert.equal(result.findings[0].confidence, undefined);
  assert.equal(result.findings[1].confidence, 0.46);
});

test('fingerprint стабилен к регистру, пробелам и слэшам, но чувствителен к claim', () => {
  const a = fingerprintFinding({ category: 'Security', file: 'src\\auth.ts', claim: 'Нет  проверки прав' });
  const b = fingerprintFinding({ category: 'security', file: 'src/auth.ts', claim: 'нет проверки прав!' });
  const c = fingerprintFinding({ category: 'security', file: 'src/auth.ts', claim: 'другая проблема' });
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('mergeFindings: дедуп, максимальная severity, голоса и counts', () => {
  const merged = mergeFindings([
    {
      agent: 'arch',
      model: 'm1',
      findings: [{ severity: 'medium', category: 'api', file: 'a.ts', claim: 'Нет лимита' }]
    },
    {
      agent: 'sec',
      model: 'm2',
      findings: [{ severity: 'high', category: 'api', file: 'a.ts', claim: 'нет лимита' }]
    },
    { agent: 'ba', findings: [{ severity: 'low', category: 'api', file: 'a.ts', claim: 'другое' }] }
  ]);
  assert.equal(merged.items.length, 2);
  const limited = merged.items.find(item => /лимит/i.test(item.claim));
  assert.equal(limited.severity, 'high');
  assert.equal(limited.sources.length, 2);
  assert.equal(merged.counts.high, 1);
  assert.equal(merged.counts.low, 1);
});

test('mergeFindings: отклонённая председателем позиция помечается contested', () => {
  const merged = mergeFindings([
    {
      agent: 'sec',
      findings: [{ severity: 'high', claim: 'SQL-инъекция в поиске', category: 'security' }]
    },
    {
      agent: 'consilium',
      findings: [],
      rejected: [{ claim: 'SQL-инъекция в поиске', reason: 'используется параметризованный запрос' }]
    }
  ]);
  assert.equal(merged.items[0].contested, true);
  assert.deepEqual(merged.items[0].rejectedBy, ['consilium']);
  assert.equal(merged.rejected[0].agent, 'consilium');
});

test('findingsAtLeast / maxSeverity работают по порогу', () => {
  const merged = mergeFindings([
    {
      agent: 'arch',
      findings: [
        { severity: 'low', claim: 'a' },
        { severity: 'critical', claim: 'b' }
      ]
    }
  ]);
  assert.equal(maxSeverity(merged.items), 'critical');
  assert.equal(findingsAtLeast(merged.items, 'high').length, 1);
  assert.equal(findingsAtLeast(merged.items, 'info').length, 2);
  assert.deepEqual(countBySeverity([]), { critical: 0, high: 0, medium: 0, low: 0, info: 0 });
});

test('claimSimilarity: перефразировка выше порога, разные проблемы ниже', () => {
  assert.ok(claimSimilarity(PARAPHRASE_A, PARAPHRASE_B) >= 0.62);
  assert.ok(claimSimilarity('SQL-инъекция в поиске', 'Нет проверки прав на удаление') < 0.62);
  assert.equal(claimSimilarity('Нет проверки прав', 'Нет проверки прав!'), 1);
});

test('mergeFindings: перефразировка в одном файле сливается, severity/sources/claim/line корректны', () => {
  const merged = mergeFindings([
    {
      agent: 'arch',
      model: 'm1',
      findings: [
        {
          severity: 'high',
          category: 'logic',
          file: 'src/math.ts',
          line: 42,
          claim: PARAPHRASE_A
        }
      ]
    },
    {
      agent: 'qa',
      model: 'm2',
      findings: [
        {
          severity: 'critical',
          category: 'LOGIC',
          file: 'src\\math.ts',
          line: 17,
          claim: PARAPHRASE_B
        }
      ]
    }
  ]);

  assert.equal(merged.items.length, 1);
  const item = merged.items[0];
  assert.equal(item.severity, 'critical');
  assert.equal(item.sources.length, 2);
  assert.deepEqual(
    item.sources.map(source => source.agent),
    ['arch', 'qa']
  );
  assert.equal(item.claim, PARAPHRASE_B);
  assert.equal(item.line, 17);
  assert.equal(merged.counts.critical, 1);
  assert.equal(merged.counts.high, 0);
});

test('mergeFindings: разные проблемы в одном файле не сливаются', () => {
  const merged = mergeFindings([
    {
      agent: 'sec',
      findings: [
        {
          severity: 'high',
          category: 'security',
          file: 'src/search.ts',
          claim: 'SQL-инъекция в поиске'
        },
        {
          severity: 'high',
          category: 'security',
          file: 'src/search.ts',
          claim: 'Нет проверки прав на удаление'
        }
      ]
    }
  ]);

  assert.equal(merged.items.length, 2);
});

test('mergeFindings: одинаковая перефразировка в разных файлах не сливается', () => {
  const merged = mergeFindings([
    {
      agent: 'arch',
      findings: [
        { severity: 'high', category: 'logic', file: 'src/a.ts', claim: PARAPHRASE_A }
      ]
    },
    {
      agent: 'qa',
      findings: [
        { severity: 'high', category: 'logic', file: 'src/b.ts', claim: PARAPHRASE_B }
      ]
    }
  ]);

  assert.equal(merged.items.length, 2);
});

test('mergeFindings: совпадение только по стоп-словам не сливается', () => {
  const merged = mergeFindings([
    {
      agent: 'arch',
      findings: [
        {
          severity: 'medium',
          category: 'api',
          file: 'src/api.ts',
          claim: 'Метод который также возвращает null'
        },
        {
          severity: 'medium',
          category: 'api',
          file: 'src/api.ts',
          claim: 'Класс который также содержит кэш'
        }
      ]
    }
  ]);

  assert.equal(claimSimilarity('Метод который также возвращает null', 'Класс который также содержит кэш'), 0);
  assert.equal(merged.items.length, 2);
});

test('mergeFindings: точные дубликаты по-прежнему сливаются', () => {
  const merged = mergeFindings([
    {
      agent: 'arch',
      findings: [
        { severity: 'low', category: 'api', file: 'src/a.ts', claim: 'Нет лимита запросов' }
      ]
    },
    {
      agent: 'sec',
      findings: [
        { severity: 'high', category: 'api', file: 'src/a.ts', claim: 'нет лимита запросов!' }
      ]
    }
  ]);

  assert.equal(merged.items.length, 1);
  assert.equal(merged.items[0].severity, 'high');
  assert.equal(merged.items[0].sources.length, 2);
});

test('mergeFindings: порядок находок детерминирован', () => {
  const entries = [
    {
      agent: 'arch',
      findings: [
        {
          severity: 'medium',
          category: 'logic',
          file: 'src/x.ts',
          claim: 'Функция add выполняет вычитание вместо сложения'
        },
        {
          severity: 'critical',
          category: 'security',
          file: 'src/y.ts',
          claim: 'SQL-инъекция в поиске'
        },
        {
          severity: 'low',
          category: 'logic',
          file: 'src/x.ts',
          claim: 'Нет проверки прав на удаление'
        }
      ]
    },
    {
      agent: 'qa',
      findings: [
        {
          severity: 'high',
          category: 'logic',
          file: 'src/x.ts',
          claim: 'Функция add выполняет вычитание вместо сложения, нарушая контракт'
        }
      ]
    }
  ];

  const first = mergeFindings(entries);
  const second = mergeFindings(entries);

  assert.deepEqual(first, second);
  assert.equal(first.items.length, 3);
  assert.equal(first.items[0].severity, 'critical');
  assert.equal(first.items[1].severity, 'high');
  assert.equal(first.items[1].sources.length, 2);
  assert.equal(first.items[2].severity, 'low');
});

test('mergeFindings: отклонённая формулировка делает перефразированную находку contested', () => {
  const merged = mergeFindings([
    {
      agent: 'qa',
      findings: [
        {
          severity: 'high',
          category: 'logic',
          file: 'src/math.ts',
          claim: PARAPHRASE_A
        }
      ]
    },
    {
      agent: 'arch',
      findings: [
        {
          severity: 'high',
          category: 'logic',
          file: 'src/math.ts',
          claim: PARAPHRASE_B
        }
      ]
    },
    {
      agent: 'consilium',
      findings: [],
      rejected: [{ claim: PARAPHRASE_A, reason: 'поведение соответствует контракту' }]
    }
  ]);

  assert.equal(merged.items.length, 1);
  assert.equal(merged.items[0].claim, PARAPHRASE_B);
  assert.equal(merged.items[0].contested, true);
  assert.deepEqual(merged.items[0].rejectedBy, ['consilium']);
});
