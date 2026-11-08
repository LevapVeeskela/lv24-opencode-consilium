/**
 * @fileoverview Анализ консенсуса экспертов: токенизация, сходство Жаккара, общий отчёт.
 * @module opencode-consilium/consensus
 */

/** Входной результат одного эксперта для анализа консенсуса. */
export interface ConsensusInput {
  /** Имя агента-эксперта. */
  agent: string;
  /** Текст ответа эксперта. */
  text: string;
  /** Модель эксперта (опционально). */
  model?: string;
  /** Признак успеха; `false` исключает результат из анализа. */
  success?: boolean;
}

/** Попарное сходство двух экспертов. */
export interface ConsensusPair {
  /** Имя первого эксперта. */
  left: string;
  /** Имя второго эксперта. */
  right: string;
  /** Сходство Жаккара в диапазоне [0, 1]. */
  similarity: number;
}

/** Итоговый отчёт о консенсусе экспертов. */
export interface ConsensusReport {
  /** Число учтённых экспертов. */
  experts: number;
  /** Среднее попарное сходство в диапазоне [0, 1]. */
  averageSimilarity: number;
  /** Уровень согласия: high (>= 0.5), medium (>= 0.25), low (< 0.25). */
  agreement: 'high' | 'medium' | 'low';
  /** Все неупорядоченные пары экспертов со сходством. */
  pairs: ConsensusPair[];
  /** Общие термины (встречаются минимум у половины экспертов), до 15. */
  sharedTerms: string[];
  /** Уникальные термины каждого эксперта (нет ни у кого другого), до 8 на эксперта. */
  uniqueTerms: Record<string, string[]>;
  /** Компактное русскоязычное резюме в markdown. */
  summary: string;
}

/** Опции анализа консенсуса. */
export interface ConsensusOptions {
  /** Минимальная длина токена (по умолчанию 4). */
  minTokenLength?: number;
}

/**
 * Встроенный стоп-словарь RU+EN (~120 слов).
 * Сравнение идёт по нижнему регистру после токенизации.
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  // Русские служебные (включая короткие — для полноты)
  'и', 'в', 'на', 'что', 'это', 'для', 'как', 'или', 'при', 'нет', 'уже',
  'было', 'была', 'были', 'быть', 'есть', 'если', 'когда', 'который',
  'которая', 'которое', 'которые', 'такой', 'такая', 'такое', 'такие',
  'можно', 'надо', 'нужно', 'меня', 'тебя', 'себя', 'всего', 'этом',
  'этой', 'этим', 'этих', 'того', 'этот', 'будет', 'будут', 'должен',
  'должны', 'может', 'могут', 'также', 'тоже', 'пока', 'хотя', 'чтобы',
  'потому', 'поэтому', 'однако', 'именно', 'здесь', 'туда', 'сюда',
  'тогда', 'сейчас', 'сегодня', 'всех', 'всем', 'сами', 'один', 'одна',
  'одно', 'более', 'менее', 'только', 'даже', 'очень', 'самый', 'между',
  'через', 'после', 'перед', 'него', 'нее', 'неё', 'нас', 'вас', 'все',
  'весь', 'они', 'она', 'оно', 'по', 'со', 'из', 'от', 'до', 'без',
  'над', 'под', 'же', 'ли',
  // Английские служебные
  'the', 'and', 'for', 'with', 'this', 'that', 'these', 'those', 'from',
  'have', 'has', 'had', 'were', 'was', 'are', 'been', 'being', 'will',
  'would', 'should', 'could', 'their', 'they', 'them', 'then', 'than',
  'when', 'where', 'which', 'what', 'your', 'about', 'into', 'over',
  'after', 'before', 'between', 'under', 'again', 'further', 'once',
  'here', 'there', 'why', 'both', 'each', 'more', 'most', 'other',
  'some', 'such', 'only', 'same', 'very', 'just', 'now'
]);

const WORD_RE = /[\p{L}\p{N}_-]+/gu;
const DEFAULT_MIN_TOKEN_LENGTH = 4;
const MAX_SHARED_TERMS = 15;
const MAX_UNIQUE_TERMS = 8;
const PROMPT_SECTION_LIMIT = 1200;

/**
 * Внутренняя токенизация с настраиваемой минимальной длиной.
 * @param text Произвольный текст.
 * @param minTokenLength Минимальная длина токена.
 * @returns Уникальные токены в порядке первого появления.
 */
function tokenizeInner(text: string, minTokenLength: number): string[] {
  const matches = text.toLowerCase().match(WORD_RE) ?? [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of matches) {
    if ([...raw].length < minTokenLength) continue;
    if (STOPWORDS.has(raw)) continue;
    if (seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
  }
  return out;
}

/**
 * Токенизирует текст: нижний регистр, Unicode-слова, фильтр длины (>= 4)
 * и стоп-слов RU+EN, дедупликация с сохранением порядка.
 */
export function tokenize(text: string): string[] {
  return tokenizeInner(text, DEFAULT_MIN_TOKEN_LENGTH);
}

/**
 * Сходство Жаккара двух наборов токенов (дубликаты игнорируются через множества).
 * Два пустых набора дают 0.
 */
export function jaccardSimilarity(a: string[], b: string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size === 0 && setB.size === 0) return 0;
  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection += 1;
  }
  const union = setA.size + setB.size - intersection;
  if (union === 0) return 0;
  return intersection / union;
}

/** Округляет до 4 знаков для детерминированного отчёта. */
function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

/** Русская подпись уровня согласия. */
function agreementLabel(agreement: ConsensusReport['agreement']): string {
  if (agreement === 'high') return 'высокое';
  if (agreement === 'medium') return 'среднее';
  return 'низкое';
}

/**
 * Анализирует консенсус экспертов.
 * Учитываются только успешные (`success !== false`) результаты с непустым текстом.
 */
export function analyzeConsensus(
  results: ConsensusInput[],
  options?: { minTokenLength?: number }
): ConsensusReport {
  const minTokenLength = options?.minTokenLength ?? DEFAULT_MIN_TOKEN_LENGTH;
  const valid = results.filter(r => r.success !== false && r.text.trim().length > 0);
  const names = valid.map(r => r.agent);
  const tokenSets = valid.map(r => tokenizeInner(r.text, minTokenLength));

  if (valid.length === 0) {
    return {
      experts: 0,
      averageSimilarity: 0,
      agreement: 'low',
      pairs: [],
      sharedTerms: [],
      uniqueTerms: {},
      summary: '## Консенсус: нет данных\n\nНет успешных ответов экспертов для анализа.'
    };
  }

  if (valid.length === 1) {
    const name = names[0];
    const tokens = tokenSets[0];
    const unique: Record<string, string[]> = {
      [name]: [...tokens].sort((x, y) => y.length - x.length || (x < y ? -1 : x > y ? 1 : 0)).slice(0, MAX_UNIQUE_TERMS)
    };
    const report: ConsensusReport = {
      experts: 1,
      averageSimilarity: 1,
      agreement: 'high',
      pairs: [],
      sharedTerms: [],
      uniqueTerms: unique,
      summary: ''
    };
    report.summary = `## Консенсус: высокое (1 эксперт)\n\nОдин эксперт (${name}), среднее сходство 100%. Пар для сравнения нет.`;
    return report;
  }

  // Попарные сходства (все неупорядоченные пары, детерминированный порядок).
  const pairs: ConsensusPair[] = [];
  let sum = 0;
  for (let i = 0; i < valid.length; i++) {
    for (let j = i + 1; j < valid.length; j++) {
      const similarity = round4(jaccardSimilarity(tokenSets[i], tokenSets[j]));
      pairs.push({ left: names[i], right: names[j], similarity });
      sum += similarity;
    }
  }
  const averageSimilarity = round4(sum / pairs.length);
  const agreement: ConsensusReport['agreement'] =
    averageSimilarity >= 0.5 ? 'high' : averageSimilarity >= 0.25 ? 'medium' : 'low';

  // Частота документов: в скольких наборах встречается токен.
  const docFreq = new Map<string, number>();
  for (const set of tokenSets) {
    for (const token of new Set(set)) {
      docFreq.set(token, (docFreq.get(token) ?? 0) + 1);
    }
  }
  const threshold = Math.max(2, Math.ceil(valid.length / 2));
  const sharedTerms = [...docFreq.entries()]
    .filter(([, freq]) => freq >= threshold)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([token]) => token)
    .slice(0, MAX_SHARED_TERMS);

  // Уникальные термины: токен ровно в одном наборе.
  const uniqueTerms: Record<string, string[]> = {};
  for (let i = 0; i < valid.length; i++) {
    const other = new Set<string>();
    for (let k = 0; k < valid.length; k++) {
      if (k !== i) for (const token of tokenSets[k]) other.add(token);
    }
    uniqueTerms[names[i]] = tokenSets[i]
      .filter(token => !other.has(token))
      .sort((x, y) => y.length - x.length || (x < y ? -1 : x > y ? 1 : 0))
      .slice(0, MAX_UNIQUE_TERMS);
  }

  const report: ConsensusReport = {
    experts: valid.length,
    averageSimilarity,
    agreement,
    pairs,
    sharedTerms,
    uniqueTerms,
    summary: ''
  };
  report.summary = buildSummary(report);
  return report;
}

/** Строит компактное markdown-резюме без дампа исходных текстов. */
function buildSummary(report: ConsensusReport): string {
  const lines: string[] = [];
  const percent = Math.round(report.averageSimilarity * 100);
  lines.push(`## Консенсус: ${agreementLabel(report.agreement)} (сходство ${percent}%, экспертов: ${report.experts})`);
  const shown = report.pairs.filter(p => p.similarity > 0);
  if (shown.length > 0) {
    lines.push('', '| Эксперты | Сходство |', '|---|---|');
    for (const p of shown) {
      lines.push(`| ${p.left} ↔ ${p.right} | ${Math.round(p.similarity * 100)}% |`);
    }
  } else {
    lines.push('', 'Общих пересечений между парами нет.');
  }
  lines.push('', report.sharedTerms.length > 0
    ? `Общее: ${report.sharedTerms.join(', ')}.`
    : 'Общих терминов нет.');
  for (const [agent, terms] of Object.entries(report.uniqueTerms)) {
    lines.push(terms.length > 0
      ? `- ${agent}: уникально — ${terms.join(', ')}.`
      : `- ${agent}: уникальных терминов нет.`);
  }
  return lines.join('\n');
}

/**
 * Форматирует полный отчёт в читаемый markdown.
 */
export function formatConsensusReport(report: ConsensusReport): string {
  const lines: string[] = [];
  const percent = Math.round(report.averageSimilarity * 100);
  lines.push(`# Отчёт о консенсусе`);
  lines.push('');
  lines.push(`Экспертов: ${report.experts}. Согласие: ${agreementLabel(report.agreement)}. Среднее сходство: ${percent}%.`);
  lines.push('');
  lines.push('## Пары');
  if (report.pairs.length === 0) {
    lines.push('Пар нет (нужен минимум один эксперт для сравнения, два — для пар).');
  } else {
    lines.push('| Эксперты | Сходство |');
    lines.push('|---|---|');
    for (const p of report.pairs) {
      lines.push(`| ${p.left} ↔ ${p.right} | ${Math.round(p.similarity * 100)}% |`);
    }
  }
  lines.push('');
  lines.push('## Общие термины');
  lines.push(report.sharedTerms.length > 0 ? report.sharedTerms.join(', ') : 'Нет общих терминов.');
  lines.push('');
  lines.push('## Уникальные термины');
  const entries = Object.entries(report.uniqueTerms);
  if (entries.length === 0) {
    lines.push('Нет данных.');
  } else {
    for (const [agent, terms] of entries) {
      lines.push(`- ${agent}: ${terms.length > 0 ? terms.join(', ') : '—'}`);
    }
  }
  return lines.join('\n');
}

/**
 * Строит короткий блок (< 1200 символов) для промпта председателя:
 * уровень согласия, топ общих терминов, разногласия по экспертам.
 */
export function buildConsensusPromptSection(report: ConsensusReport): string {
  const percent = Math.round(report.averageSimilarity * 100);
  const topShared = report.sharedTerms.slice(0, 10);
  const parts: string[] = [];
  parts.push(`Консенсус: согласие ${agreementLabel(report.agreement)} (среднее сходство ${percent}%, экспертов ${report.experts}).`);
  parts.push(topShared.length > 0
    ? `Общие темы: ${topShared.join(', ')}.`
    : 'Общих тем нет.');
  const entries = Object.entries(report.uniqueTerms);
  if (entries.length > 0) {
    const disagreements = entries
      .map(([agent, terms]) => `${agent} — особое мнение: ${terms.slice(0, 3).join(', ') || 'нет'}`)
      .join('; ');
    parts.push(`Разногласия: ${disagreements}.`);
  }
  let text = parts.join(' ');
  if (text.length > PROMPT_SECTION_LIMIT) {
    text = text.slice(0, PROMPT_SECTION_LIMIT - 1) + '…';
  }
  return text;
}
