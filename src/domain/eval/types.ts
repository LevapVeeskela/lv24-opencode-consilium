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

/** Ответ инжектированного runner-а: без вызовов моделей внутри харнесса */
export interface EvalRunnerOutput {
  findings: Finding[];
  latencyMs: number;
  cost?: number;
  error?: string;
}

/** Функция прогона одной фикстуры; в тестах подменяется заглушкой */
export type EvalRunner = (fixture: EvalFixture) => Promise<EvalRunnerOutput>;

/** Входные данные запуска eval-набора */
export interface EvalRunInput {
  /** Каталог с подкаталогами фикстур */
  fixturesDir: string;
  /** Инжектируемый runner; харнесс сам модели не вызывает */
  runner: EvalRunner;
  /** Необязательный фильтр по именам фикстур */
  names?: string[];
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
