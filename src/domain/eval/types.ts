/**
 * @fileoverview Типы детерминированного eval-харнесса: фикстуры, матчинг
 * находок, результаты прогона и агрегированная сводка.
 * @module lv24-opencode-consilium
 */

import type { Finding, FindingSeverity } from '../council/findings.js';

/**
 * Ожидаемая находка в фикстуре.
 * `claimIncludes` — фраза (или массив альтернатив), которую должен содержать
 * нормализованный claim. Если не задана, матч идёт по file/category/severity.
 */
export interface ExpectedFinding {
  claimIncludes?: string | string[];
  /** Ожидаемый файл (сравнение по нормализованному пути) */
  file?: string;
  /** Ожидаемая категория (регистронезависимое точное совпадение) */
  category?: string;
  /** Минимальная допустимая серьёзность находки */
  minSeverity?: FindingSeverity;
}

/** Ожидания фикстуры: что совет обязан найти и что не должен выдумывать */
export interface EvalExpectations {
  mustFind: ExpectedFinding[];
  mustNotFind: ExpectedFinding[];
}

/** Одна eval-фикстура, загруженная из каталога */
export interface EvalFixture {
  name: string;
  task: string;
  diff?: string;
  expected: EvalExpectations;
}

/** Находка, сопоставленная ожиданию фикстуры */
export interface EvalFindingMatch {
  expected: ExpectedFinding;
  finding: Finding;
}

/** Результат чистого матчинга находок против ожиданий фикстуры */
export interface EvalMatchResult {
  caught: EvalFindingMatch[];
  missed: ExpectedFinding[];
  falsePositives: EvalFindingMatch[];
  /** caught / (caught + missed); 0, если mustFind пуст */
  catchRate: number;
  /** falsePositives / (caught + falsePositives); 0, если знаменатель пуст */
  falsePositiveRate: number;
}

/** Число раундов дебатов в eval-прогоне: 1 — обычный, 2 — с peer-review */
export type EvalRounds = 1 | 2;

/** Опции, которые харнесс передаёт runner-у для каждой фикстуры */
export interface EvalRunnerOptions {
  /** Раунды дебатов; харнесс всегда передаёт значение, по умолчанию 1 */
  rounds?: EvalRounds;
}

/** Ответ инжектированного runner-а: без вызовов моделей внутри харнесса */
export interface EvalRunnerOutput {
  findings: Finding[];
  latencyMs: number;
  cost?: number;
  error?: string;
}

/** Функция прогона одной фикстуры; в тестах подменяется заглушкой */
export type EvalRunner = (
  fixture: EvalFixture,
  options?: EvalRunnerOptions
) => Promise<EvalRunnerOutput>;

/** Входные данные запуска eval-набора */
export interface EvalRunInput {
  /** Каталог с подкаталогами фикстур */
  fixturesDir: string;
  /** Инжектируемый runner; харнесс сам модели не вызывает */
  runner: EvalRunner;
  /** Необязательный фильтр по именам фикстур */
  names?: string[];
  /** Раунды дебатов для каждой фикстуры; по умолчанию 1 */
  rounds?: EvalRounds;
}

/** Входные данные сравнения одиночного прогона и дебатов */
export interface EvalComparisonInput {
  /** Каталог с подкаталогами фикстур */
  fixturesDir: string;
  /** Один и тот же runner для обоих прогонов */
  runner: EvalRunner;
  /** Необязательный фильтр по именам фикстур */
  names?: string[];
}

/**
 * Разница метрик debate − single в абсолютных единицах:
 * доли — как доли (0.25 = +25 п.п.), latency — мс, стоимость — USD.
 */
export interface EvalComparisonDelta {
  catchRate: number;
  falsePositiveRate: number;
  p50LatencyMs: number;
  totalCost: number;
}

/** Результат сравнения: обе сводки с per-fixture деталями и дельта */
export interface EvalComparison {
  single: EvalSummary;
  debate: EvalSummary;
  delta: EvalComparisonDelta;
}

/** Ошибка выполнения одной фикстуры */
export interface EvalRunError {
  fixture: string;
  message: string;
}

/** Результат одной фикстуры: матчинг, телеметрия и ошибка runner-а */
export interface EvalFixtureResult extends EvalMatchResult {
  name: string;
  task: string;
  expected: EvalExpectations;
  findings: Finding[];
  latencyMs: number;
  cost?: number;
  error?: string;
}

/** Агрегированная сводка eval-прогона */
export interface EvalSummary {
  fixtures: EvalFixtureResult[];
  totalFixtures: number;
  /** Сколько ожидаемых находок поймано (суммарно) */
  caught: number;
  missed: number;
  falsePositives: number;
  /** Суммарный catch rate по всем mustFind */
  catchRate: number;
  /** Суммарная доля ложных срабатываний среди caught + falsePositives */
  falsePositiveRate: number;
  /** Медиана latency по фикстурам, мс (среднее двух центральных значений) */
  p50LatencyMs: number;
  /** Суммарная стоимость runner-ов; 0, если стоимость не передавалась */
  totalCost: number;
  errors: EvalRunError[];
}

/** Опции форматирования сводки */
export interface FormatEvalOptions {
  /** Вывести машиночитаемый JSON вместо markdown */
  json?: boolean;
}
