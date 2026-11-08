/**
 * @fileoverview Умный выбор экспертов консилиума по тексту задачи и диффу.
 * @module lv24-opencode-consilium/smart-experts
 */

import type { ExpertConfig } from './types.js';

/**
 * Результат умного выбора экспертов.
 */
export interface SmartExpertSelection {
  /** Выбранные эксперты (в исходном порядке). */
  experts: ExpertConfig[];
  /** Имена отсеянных экспертов (в исходном порядке). */
  dropped: string[];
  /** Очки каждого включённого эксперта по имени. */
  scores: Record<string, number>;
  /** Причины выбора на русском (только для выбранных со счётом > 0). */
  reasons: Record<string, string>;
}

/**
 * Ключевые слова ролей (RU-основы + EN-термины) для скоринга задачи.
 *
 * Ключ `generic` — общий запасной лексикон для интеграторов;
 * неизвестные имена экспертов всегда получают счёт 0 и не используют его.
 */
export const ROLE_KEYWORDS: Record<string, string[]> = {
  arch: [
    'архитектур',
    'слой',
    'модул',
    'масштаб',
    'миграц',
    'схем',
    'рефактор',
    'монолит',
    'микросервис',
    'зависимо',
    'структур',
    'проектир',
    'migration',
    'schema',
    'api',
    'refactor',
    'design',
    'monolith',
  ],
  ux: [
    'интерфейс',
    'пользов',
    'доступн',
    'экран',
    'форм',
    'кнопк',
    'макет',
    'дизайн',
    'верстк',
    'навигац',
    'ui',
    'ux',
    'layout',
    'screen',
    'button',
    'form',
    'a11y',
    'accessibility',
  ],
  ba: [
    'бизнес',
    'требован',
    'ценност',
    'процесс',
    'метрик',
    'выгод',
    'доход',
    'риск',
    'стейкхолдер',
    'заказчик',
    'приоритет',
    'тз',
    'cost',
    'stakeholder',
    'metric',
    'business',
    'requirement',
    'value',
  ],
  sec: [
    'безоп',
    'уязв',
    'инъекц',
    'секрет',
    'парол',
    'шифр',
    'аутентиф',
    'авторизац',
    'атак',
    'доступ',
    'xss',
    'csrf',
    'sqli',
    'sql',
    'auth',
    'permission',
    'injection',
    'secret',
    'password',
    'vulnerability',
  ],
  generic: [
    'код',
    'качеств',
    'ревью',
    'тест',
    'покрыт',
    'читаем',
    'стандарт',
    'практик',
    'code',
    'review',
    'quality',
    'test',
    'readability',
    'best',
  ],
};

/**
 * Экранирует строку для использования в регулярном выражении.
 *
 * @param value - Исходная строка.
 * @returns Экранированная строка.
 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Проверяет, встречается ли ключевое слово в тексте.
 *
 * Латиница — приближённо по границам слов (не часть длинного слова),
 * кириллические основы — подстрокой (стемминг усечением).
 *
 * @param haystack - Текст задачи в нижнем регистре.
 * @param keyword - Ключевое слово в нижнем регистре.
 * @returns true при совпадении.
 */
function matchesKeyword(haystack: string, keyword: string): boolean {
  if (/^[a-z0-9]+$/.test(keyword)) {
    const pattern = new RegExp(`(?:^|[^a-z0-9_])${escapeRegExp(keyword)}(?![a-z0-9_])`);
    return pattern.test(haystack);
  }
  return haystack.includes(keyword);
}

/**
 * Подсчитывает очки эксперта: число различных совпавших ключевых слов.
 *
 * @param haystack - Текст задачи (+ дифф) в нижнем регистре.
 * @param keywords - Лексикон роли.
 * @returns Счёт и список совпавших слов (в порядке лексикона).
 */
function scoreKeywords(haystack: string, keywords: string[]): { score: number; matched: string[] } {
  const matched: string[] = [];
  for (const keyword of keywords) {
    if (matchesKeyword(haystack, keyword.toLowerCase())) {
      matched.push(keyword);
    }
  }
  return { score: matched.length, matched };
}

/**
 * Приводит опцию min/max к конечному целому >= 1.
 *
 * @param value - Значение опции.
 * @param fallback - Значение по умолчанию.
 * @returns Корректное целое число.
 */
function toPositiveInt(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.floor(value));
}

/**
 * Выбирает релевантных экспертов по тексту задачи и опциональному диффу.
 *
 * Учитывает только экспертов с `enabled !== false`, порядок вывода —
 * исходный (приоритет уже применён вызывающей стороной).
 * Неизвестные имена получают счёт 0 без причины.
 * Входной массив и объекты экспертов не мутируются.
 *
 * @param experts - Кандидаты в исходном приоритетном порядке.
 * @param task - Текст задачи.
 * @param options - Лимиты совета и дифф (`max` по умолчанию 3, `min` — 2).
 * @returns Выборка, отсеянные, очки и русские причины.
 */
export function selectSmartExperts(
  experts: ExpertConfig[],
  task: string,
  options?: { max?: number; min?: number; diff?: string },
): SmartExpertSelection {
  const haystack = `${task} ${options?.diff ?? ''}`.toLowerCase();
  const enabled: Array<{ expert: ExpertConfig; index: number }> = [];
  experts.forEach((expert, index) => {
    if (expert.enabled !== false) {
      enabled.push({ expert, index });
    }
  });

  const scores: Record<string, number> = {};
  const matchedBy: Record<string, string[]> = {};
  for (const { expert } of enabled) {
    const hasLexicon = Object.prototype.hasOwnProperty.call(ROLE_KEYWORDS, expert.name);
    const lexicon = hasLexicon ? ROLE_KEYWORDS[expert.name] : undefined;
    if (lexicon === undefined) {
      scores[expert.name] = 0;
      continue;
    }
    const { score, matched } = scoreKeywords(haystack, lexicon);
    scores[expert.name] = score;
    matchedBy[expert.name] = matched;
  }

  if (enabled.length === 0) {
    return { experts: [], dropped: [], scores, reasons: {} };
  }

  const max = Math.min(toPositiveInt(options?.max, 3), enabled.length);
  const min = Math.min(toPositiveInt(options?.min, 2), max);

  // Сортировка по счёту (убыв.), затем по исходному индексу.
  const ranked = [...enabled].sort(
    (a, b) => (scores[b.expert.name] ?? 0) - (scores[a.expert.name] ?? 0) || a.index - b.index,
  );
  const positives = ranked.filter(({ expert }) => (scores[expert.name] ?? 0) > 0);

  let picked: Array<{ expert: ExpertConfig; index: number }>;
  if (positives.length === 0) {
    // Все нули — держим первые min, чтобы совет не был пустым.
    picked = ranked.slice(0, min);
  } else if (positives.length < min) {
    // Положительных меньше min — не роняем ни одного из них, добираем нулями до min.
    const zeroes = ranked.filter(({ expert }) => (scores[expert.name] ?? 0) === 0);
    picked = [...positives, ...zeroes.slice(0, min - positives.length)];
  } else {
    picked = ranked.slice(0, max);
  }

  // Возвращаем в исходном порядке.
  picked.sort((a, b) => a.index - b.index);
  const pickedIndexes = new Set(picked.map((item) => item.index));

  const reasons: Record<string, string> = {};
  for (const { expert } of picked) {
    const matched = Object.prototype.hasOwnProperty.call(matchedBy, expert.name)
      ? matchedBy[expert.name]
      : [];
    if (Array.isArray(matched) && matched.length > 0) {
      reasons[expert.name] = `совпадения: ${matched.join(', ')}`;
    }
  }

  return {
    experts: picked.map((item) => item.expert),
    dropped: enabled
      .filter(({ index }) => !pickedIndexes.has(index))
      .map(({ expert }) => expert.name),
    scores,
    reasons,
  };
}
