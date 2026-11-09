import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseFindingsBlock,
  mergeFindings,
  fingerprintFinding,
  findingsAtLeast,
  maxSeverity,
  countBySeverity
} from '../dist/domain/council/findings.js';

const block = (payload) => '```json\n' + JSON.stringify(payload, null, 2) + '\n```';

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
