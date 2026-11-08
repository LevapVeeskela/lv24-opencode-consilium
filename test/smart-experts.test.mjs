import test from 'node:test';
import assert from 'node:assert/strict';
import { ROLE_KEYWORDS, selectSmartExperts } from '../dist/smart-experts.js';

const BASE = [
  { name: 'arch' },
  { name: 'ux' },
  { name: 'ba' },
  { name: 'sec' },
];

test('ROLE_KEYWORDS покрывает arch, ux, ba, sec и запасной лексикон', () => {for (const key of ['arch', 'ux', 'ba', 'sec', 'generic']) {
    assert.ok(Array.isArray(ROLE_KEYWORDS[key]), `нет ключа ${key}`);
    assert.ok(
      ROLE_KEYWORDS[key].length >= 10 && ROLE_KEYWORDS[key].length <= 20,
      `у ${key} должно быть 10-20 терминов`,
    );
  }
});

test('задача про безопасность включает sec', () => {
  const result = selectSmartExperts(
    BASE,
    'Найди уязвимости и проблемы безопасности, проверь auth и возможные XSS',
  );
  assert.ok(result.experts.some(expert => expert.name === 'sec'), 'sec должен быть выбран');
  assert.ok((result.scores.sec ?? 0) > 0, 'у sec должен быть положительный счёт');
  assert.match(result.reasons.sec ?? '', /совпадения:/);
});

test('задача про интерфейс включает ux', () => {
  const result = selectSmartExperts(
    BASE,
    'Сделай интерфейс формы и экрана удобнее для пользователей',
  );
  assert.ok(result.experts.some(expert => expert.name === 'ux'), 'ux должен быть выбран');
  assert.ok((result.scores.ux ?? 0) > 0, 'у ux должен быть положительный счёт');
});

test('задача про бизнес включает ba', () => {
  const result = selectSmartExperts(
    BASE,
    'Оцени бизнес-ценность требований и процессные метрики, стоимость (cost) и мнение stakeholder',
  );
  assert.ok(result.experts.some(expert => expert.name === 'ba'), 'ba должен быть выбран');
  assert.ok((result.scores.ba ?? 0) > 0, 'у ba должен быть положительный счёт');
});

test('задача про архитектуру включает arch', () => {
  const result = selectSmartExperts(
    BASE,
    'Спроектируй архитектуру модулей и слоёв, миграцию схемы API (migration, schema, refactor)',
  );
  assert.ok(result.experts.some(expert => expert.name === 'arch'), 'arch должен быть выбран');
  assert.ok((result.scores.arch ?? 0) > 0, 'у arch должен быть положительный счёт');
});

test('дифф тоже участвует в скоринге', () => {
  const result = selectSmartExperts(BASE, 'Посмотри изменения', { diff: 'XSS и auth' });
  assert.ok(result.experts.some(expert => expert.name === 'sec'), 'sec должен найтись через diff');
});

test('все нули — держим первые min (по умолчанию 2)', () => {
  const result = selectSmartExperts(BASE, 'Обсуди погоду и котиков');
  assert.deepEqual(result.experts.map(expert => expert.name), ['arch', 'ux']);
  assert.deepEqual(result.dropped, ['ba', 'sec']);
  assert.deepEqual(Object.keys(result.reasons), []);
});

test('max ограничивает размер совета', () => {
  const experts = [...BASE, { name: 'extra-a' }, { name: 'extra-b' }];
  const result = selectSmartExperts(experts, 'Обсуди погоду и котиков', { max: 2, min: 2 });
  assert.equal(result.experts.length, 2);
  assert.equal(result.dropped.length, experts.length - 2);
});

test('позитивные совпадения не роняются при малом min', () => {
  const result = selectSmartExperts(
    BASE,
    'Найди уязвимости и проблемы безопасности, проверь auth',
    { max: 3, min: 2 },
  );
  assert.ok(result.experts.some(expert => expert.name === 'sec'), 'sec нельзя ронять');
  assert.ok(result.experts.length >= 2, 'совет не меньше min');
});

test('отключённые эксперты исключаются', () => {
  const experts = [{ name: 'ux', enabled: false }, { name: 'arch' }, { name: 'ba' }];
  const result = selectSmartExperts(
    experts,
    'Сделай интерфейс формы и экрана удобнее для пользователей',
  );
  assert.ok(result.experts.every(expert => expert.enabled !== false), 'disabled не в совете');
  assert.ok(!result.dropped.includes('ux'), 'disabled нет и в dropped');
  assert.ok(!('ux' in result.scores), 'disabled нет в scores');
});

test('неизвестное имя: счёт 0 и нет причины', () => {
  const result = selectSmartExperts(
    [{ name: 'sec' }, { name: 'custom-guru' }],
    'Найди уязвимости и проблемы безопасности, проверь auth',
  );
  assert.equal(result.scores['custom-guru'], 0);
  assert.ok(!('custom-guru' in result.reasons), 'у custom-guru не должно быть причины');
});

test('не мутирует входной массив и объекты', () => {
  const experts = [{ name: 'sec' }, { name: 'arch' }, { name: 'ux' }];
  const before = JSON.stringify(experts);
  const lengthBefore = experts.length;
  selectSmartExperts(experts, 'Найди уязвимости, архитектуру и интерфейс');
  assert.equal(experts.length, lengthBefore);
  assert.equal(JSON.stringify(experts), before);
});

test('пустой список экспертов', () => {
  const result = selectSmartExperts([], 'Что угодно');
  assert.deepEqual(result.experts, []);
  assert.deepEqual(result.dropped, []);
  assert.deepEqual(result.scores, {});
  assert.deepEqual(result.reasons, {});
});

test('min > max ужимается до max', () => {
  const result = selectSmartExperts(BASE, 'Обсуди погоду и котиков', { min: 5, max: 2 });
  assert.equal(result.experts.length, 2);
});

test('имена из Object.prototype не роняют выбор', () => {
  const result = selectSmartExperts(
    [{ name: 'constructor' }, { name: 'toString' }, { name: 'arch' }],
    'Оцени архитектуру и слои'
  );

  assert.equal(result.scores['constructor'], 0);
  assert.equal(result.scores['toString'], 0);
  assert.ok(result.experts.some(expert => expert.name === 'arch'));
});
