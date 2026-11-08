import test from 'node:test';
import assert from 'node:assert/strict';
import {
  renderHtmlReport,
  renderPrMarkdown,
  renderReport
} from '../dist/report.js';

const FIXED_DATE = new Date('2026-01-01T00:00:00.000Z');

function baseResult() {
  return {
    text: 'chair verdict <b>bold</b>',
    experts: [
      {
        agent: 'alpha',
        model: 'prov/a',
        text: 'answer one <script>alert(1)</script>',
        success: true,
        duration: 1500,
        usage: { inputTokens: 10, outputTokens: 20, cost: 0.001 }
      },
      {
        agent: 'beta',
        model: 'prov/b',
        text: '',
        success: false,
        duration: 50,
        errorCode: 'TIMEOUT',
        errorMessage: 'timed out <oops>'
      }
    ],
    chair: { agent: 'chair', model: 'prov/c', text: 'chair verdict', success: true },
    totalTime: 2000,
    parallelTime: 1600,
    success: false,
    usage: { inputTokens: 100, outputTokens: 50, cost: 0.005 },
    metadata: {
      consensus: {
        agreement: 'high',
        averageSimilarity: 0.8,
        pairs: [{ left: 'alpha', right: 'beta', similarity: 0.8 }],
        sharedTerms: ['postgres', 'redis'],
        uniqueTerms: { alpha: ['kafka'] }
      },
      artifacts: { dir: '/tmp/runs/abc', id: 'abc' }
    }
  };
}

test('HTML: XSS экранирован, сырой <script> отсутствует', () => {
  const html = renderHtmlReport(baseResult(), { title: 'T <task>', generatedAt: FIXED_DATE });
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(html.includes('lang="ru"'));
  assert.ok(html.includes('@media print'));
  assert.ok(html.includes('<style>'));
});

test('HTML: все секции присутствуют', () => {
  const html = renderHtmlReport(baseResult(), { generatedAt: FIXED_DATE });
  for (const h of ['Сводка', 'Модели', 'Консенсус', 'Мнения экспертов', 'Итог председателя', 'Артефакты']) {
    assert.ok(html.includes(h), `missing: ${h}`);
  }
  assert.ok(html.includes('opencode-consilium'));
  assert.ok(html.includes('ошибка'));
  assert.ok(html.includes('TIMEOUT'));
});

test('HTML: обрезка 6000 символов с маркером', () => {
  const r = baseResult();
  r.experts[0].text = 'x'.repeat(7000);
  const html = renderHtmlReport(r, { generatedAt: FIXED_DATE });
  assert.ok(html.includes('…текст обрезан до 6000 символов…'));
});

test('HTML: без консенсуса нет заголовка Консенсус; без usage нет undefined/NaN', () => {
  const r = baseResult();
  delete r.metadata.consensus;
  delete r.usage;
  delete r.experts[0].usage;
  const html = renderHtmlReport(r, { generatedAt: FIXED_DATE });
  assert.ok(!html.includes('<h2>Консенсус</h2>'));
  assert.ok(!html.includes('undefined'));
  assert.ok(!html.includes('NaN'));
});

test('HTML: детерминирован при фиксированной дате', () => {
  const a = renderHtmlReport(baseResult(), { generatedAt: FIXED_DATE });
  const b = renderHtmlReport(baseResult(), { generatedAt: FIXED_DATE });
  assert.equal(a, b);
});

test('PR: маркер, details сбалансированы, компактность', () => {
  const md = renderPrMarkdown(baseResult());
  assert.ok(md.includes('<!-- consilium:report -->'));
  assert.ok(md.startsWith('## Консилиум:'));
  const open = (md.match(/<details>/g) || []).length;
  const close = (md.match(/<\/details>/g) || []).length;
  assert.equal(open, 2);
  assert.equal(open, close);
  assert.ok(md.includes('Консенсус:'));
  assert.ok(md.includes('Артефакты:'));
  assert.ok(!md.includes('undefined'));
  assert.ok(!md.includes('NaN'));
});

test('PR: текст с тройными кавычками не ломает fences', () => {
  const r = baseResult();
  r.experts[0].text = 'has ``` fence inside';
  const md = renderPrMarkdown(r);
  const open = (md.match(/<details>/g) || []).length;
  const close = (md.match(/<\/details>/g) || []).length;
  assert.equal(open, close);
  assert.ok(md.includes('````text'));
});

test('PR: инъекция заголовка/картинки остаётся внутри fence', () => {
  const r = baseResult();
  r.experts[0].text = 'before ```\n# injected heading\n![x](http://evil/p.png)\n``` after';
  const md = renderPrMarkdown(r);
  const fenceStart = md.indexOf('````text');
  const fenceEnd = md.indexOf('````', fenceStart + 4);
  assert.ok(fenceStart >= 0 && fenceEnd > fenceStart);
  const injected = md.indexOf('# injected heading');
  assert.ok(injected > fenceStart && injected < fenceEnd);
  assert.ok(md.trim().endsWith('<!-- consilium:report -->'));
});

test('PR: итог председателя и безопасная ошибка', () => {
  const r = baseResult();
  const md = renderPrMarkdown(r);
  assert.ok(md.includes('### Итог председателя'));
  assert.ok(md.includes('chair verdict'));
  assert.ok(md.includes('Ошибка: `timed out <oops>`'));
});

test('renderReport: dispatch и unknown format throw', () => {
  const r = baseResult();
  assert.equal(renderReport(r, 'html', { generatedAt: FIXED_DATE }), renderHtmlReport(r, { generatedAt: FIXED_DATE }));
  assert.equal(renderReport(r, 'pr'), renderPrMarkdown(r));
  assert.equal(renderReport(r, 'markdown'), renderPrMarkdown(r));
  assert.throws(() => renderReport(r, 'pdf'), /Неизвестный формат/);
});
