/**
 * @fileoverview Структурированные находки совета: парсинг JSON-блока эксперта,
 * стабильные отпечатки, слияние мнений и учёт отклонённых позиций.
 * @module lv24-opencode-consilium
 */

/** Уровни серьёзности находки */
export type FindingSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

/** Источник находки: роль и модель, которые её сформулировали */
export interface FindingSource {
  agent: string;
  model?: string;
}

/** Находка в том виде, в каком её вернул эксперт */
export interface RawFinding {
  severity?: FindingSeverity;
  category?: string;
  file?: string;
  line?: number;
  claim: string;
  evidence?: string;
  confidence?: number;
}

/** Позиция, которую председатель отклонил, с причиной */
export interface RejectedPosition {
  claim: string;
  reason?: string;
  agent: string;
}

/** Результат разбора одного ответа */
export interface FindingsParseResult {
  findings: RawFinding[];
  rejected: RejectedPosition[];
  error?: 'no-block' | 'invalid-json' | 'invalid-shape';
}

/** Слитая находка с голосами и признаком спорности */
export interface Finding {
  fingerprint: string;
  severity: FindingSeverity;
  category: string;
  file?: string;
  line?: number;
  claim: string;
  evidence?: string;
  confidence?: number;
  sources: FindingSource[];
  contested: boolean;
  rejectedBy: string[];
}

/** Сводка находок запуска */
export interface FindingsSummary {
  items: Finding[];
  counts: Record<FindingSeverity, number>;
  rejected: RejectedPosition[];
  parseErrors: string[];
}

const SEVERITIES: readonly FindingSeverity[] = ['critical', 'high', 'medium', 'low', 'info'];
const SEVERITY_RANK: Record<FindingSeverity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  info: 0
};
const MAX_FINDINGS = 50;
const MAX_CLAIM = 500;
const MAX_EVIDENCE = 1200;
const MAX_CATEGORY = 60;
const MAX_FILE = 300;
const CLAIM_SIMILARITY_THRESHOLD = 0.62;
const MIN_TOKEN_LENGTH = 3;
const MIN_CONTAINMENT_TOKENS = 4;
const CONTAINMENT_RATIO = 0.8;

/** Небольшой встроенный набор служебных слов RU/EN для сравнения claim */
const CLAIM_STOPWORDS: ReadonlySet<string> = new Set([
  'без', 'более', 'будет', 'был', 'была', 'были', 'было', 'быть',
  'все', 'всё', 'где', 'для', 'его', 'её', 'если', 'есть', 'ещё',
  'или', 'их', 'как', 'какая', 'какие', 'какой', 'когда', 'которая',
  'которые', 'который', 'которых', 'между', 'может', 'можно', 'над',
  'него', 'неё', 'они', 'она', 'оно', 'при', 'про', 'так', 'также',
  'такая', 'такие', 'такой', 'там', 'тогда', 'того', 'тоже', 'только',
  'уже', 'чего', 'чем', 'через', 'что', 'чтобы', 'эта', 'эти', 'это',
  'этот', 'эту',
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'these', 'those',
  'when', 'where', 'which', 'while', 'into', 'than', 'then', 'there',
  'their', 'them', 'they', 'have', 'has', 'had', 'are', 'was', 'were',
  'been', 'being', 'will', 'would', 'could', 'should', 'can', 'may',
  'might', 'must', 'not', 'but', 'its', 'our', 'your', 'all', 'any',
  'also', 'such', 'only', 'over', 'under', 'about', 'after', 'before',
  'does', 'did', 'done', 'how', 'why', 'what', 'who', 'whom', 'whose'
]);

/** Отпечаток стабилен между запусками: без номера строки, регистра и пунктуации */
export function fingerprintFinding(input: {
  category: string;
  file?: string;
  claim: string;
}): string {
  const normalized = [
    normalizeToken(input.category),
    normalizeToken(input.file ?? ''),
    normalizeClaim(input.claim)
  ].join('|');
  return `f_${fnv1a(normalized)}`;
}

/** Нормализует claim для сравнения и отпечатка */
export function normalizeClaim(claim: string): string {
  return claim
    .toLowerCase()
    .replace(/[`"'«»„“”]/g, '')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 400);
}

/** Сравнивает две позиции по нормализованному claim */
export function sameClaim(a: string, b: string): boolean {
  const left = normalizeClaim(a);
  const right = normalizeClaim(b);
  if (left.length === 0 || right.length === 0) return false;
  if (left === right) return true;
  const shorter = left.length <= right.length ? left : right;
  const longer = left.length <= right.length ? right : left;
  return shorter.length >= 24 && longer.includes(shorter);
}

/**
 * Детерминированная похожесть claim по значимым словам.
 * База — Jaccard по наборам токенов; если один набор содержит не менее 80%
 * другого и в коротком наборе не меньше 4 токенов, оценка поднимается до 0.8.
 */
export function claimSimilarity(a: string, b: string): number {
  const left = claimTokens(a);
  const right = claimTokens(b);
  if (left.size === 0 || right.size === 0) return 0;

  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) intersection += 1;
  }
  const union = left.size + right.size - intersection;
  const jaccard = union === 0 ? 0 : intersection / union;
  const shorter = Math.min(left.size, right.size);
  if (shorter >= MIN_CONTAINMENT_TOKENS && intersection >= Math.ceil(shorter * CONTAINMENT_RATIO)) {
    return Math.max(jaccard, CONTAINMENT_RATIO);
  }
  return jaccard;
}

/**
 * Извлекает последний fenced ```json-блок с `findings`/`rejected`.
 * Возвращает пустой результат с причиной, если блока нет или он битый.
 */
export function parseFindingsBlock(text: string): FindingsParseResult {
  const blocks = [...text.matchAll(/```json\s*([\s\S]*?)```/gi)];
  if (blocks.length === 0) {
    return { findings: [], rejected: [], error: 'no-block' };
  }

  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const raw = blocks[index]?.[1] ?? '';
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!isRecord(parsed)) continue;
    if (!Array.isArray(parsed['findings']) && !Array.isArray(parsed['rejected'])) continue;

    const findings = Array.isArray(parsed['findings'])
      ? parsed['findings']
          .slice(0, MAX_FINDINGS)
          .map(normalizeRawFinding)
          .filter((item): item is RawFinding => item !== null)
      : [];
    const rejected = Array.isArray(parsed['rejected'])
      ? parsed['rejected']
          .slice(0, MAX_FINDINGS)
          .map(toRejectedPosition)
          .filter((item): item is { claim: string; reason?: string } => item !== null)
          .map(item => ({ ...item, agent: '' }))
      : [];
    return { findings, rejected };
  }

  return { findings: [], rejected: [], error: 'invalid-json' };
}

/** Сливает находки экспертов и председателя по отпечатку и похожести claim */
export function mergeFindings(
  entries: Array<{
    agent: string;
    model?: string;
    findings: RawFinding[];
    rejected?: Array<{ claim: string; reason?: string }>;
  }>
): FindingsSummary {
  const byFingerprint = new Map<string, Finding>();
  const merged: Finding[] = [];
  const claimsByFinding = new Map<Finding, string[]>();
  const rejected: RejectedPosition[] = [];

  for (const entry of entries) {
    for (const item of entry.rejected ?? []) {
      rejected.push({
        claim: truncate(item.claim, MAX_CLAIM),
        reason: item.reason === undefined ? undefined : truncate(item.reason, MAX_EVIDENCE),
        agent: entry.agent
      });
    }

    for (const raw of entry.findings) {
      const severity = toSeverity(raw.severity);
      const category = truncate((raw.category ?? 'general').trim() || 'general', MAX_CATEGORY);
      const claim = truncate(raw.claim.trim(), MAX_CLAIM);
      if (claim.length === 0) continue;
      const file = raw.file === undefined ? undefined : truncate(raw.file, MAX_FILE);
      const line = normalizeLine(raw.line);
      const fingerprint = fingerprintFinding({ category, file: raw.file, claim });
      const existing =
        byFingerprint.get(fingerprint) ?? findFuzzyMatch(merged, category, file, claim);

      if (existing === undefined) {
        const finding: Finding = {
          fingerprint,
          severity,
          category,
          file,
          line,
          claim,
          evidence: raw.evidence === undefined ? undefined : truncate(raw.evidence, MAX_EVIDENCE),
          confidence: normalizeConfidence(raw.confidence),
          sources: [sourceOf(entry)],
          contested: false,
          rejectedBy: []
        };
        byFingerprint.set(fingerprint, finding);
        merged.push(finding);
        rememberClaim(claimsByFinding, finding, claim);
        continue;
      }

      if (SEVERITY_RANK[severity] > SEVERITY_RANK[existing.severity]) {
        existing.severity = severity;
      }
      if (!existing.sources.some(source => source.agent === entry.agent)) {
        existing.sources.push(sourceOf(entry));
      }
      if (existing.confidence === undefined) existing.confidence = normalizeConfidence(raw.confidence);
      if (existing.evidence === undefined && raw.evidence !== undefined) {
        existing.evidence = truncate(raw.evidence, MAX_EVIDENCE);
      }
      if (line !== undefined) {
        existing.line = existing.line === undefined ? line : Math.min(existing.line, line);
      }
      if (claim.length > existing.claim.length) {
        byFingerprint.delete(existing.fingerprint);
        existing.claim = claim;
        existing.fingerprint = fingerprint;
        byFingerprint.set(fingerprint, existing);
      }
      rememberClaim(claimsByFinding, existing, claim);
    }
  }

  for (const finding of merged) {
    const aliases = claimsByFinding.get(finding) ?? [finding.claim];
    for (const position of rejected) {
      if (!aliases.some(alias => claimsSimilar(alias, position.claim))) continue;
      finding.contested = true;
      if (!finding.rejectedBy.includes(position.agent)) finding.rejectedBy.push(position.agent);
    }
  }

  const items = [...merged].sort((a, b) => {
    const bySeverity = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
    if (bySeverity !== 0) return bySeverity;
    return a.claim.localeCompare(b.claim);
  });

  return { items, counts: countBySeverity(items), rejected, parseErrors: [] };
}

/** Считает находки по уровням */
export function countBySeverity(items: Finding[]): Record<FindingSeverity, number> {
  const counts: Record<FindingSeverity, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    info: 0
  };
  for (const item of items) counts[item.severity] += 1;
  return counts;
}

/** Находки не ниже порога (для гейтов) */
export function findingsAtLeast(items: Finding[], threshold: FindingSeverity): Finding[] {
  return items.filter(item => SEVERITY_RANK[item.severity] >= SEVERITY_RANK[threshold]);
}

/** Максимальная серьёзность среди находок */
export function maxSeverity(items: Finding[]): FindingSeverity | null {
  let result: FindingSeverity | null = null;
  for (const item of items) {
    if (result === null || SEVERITY_RANK[item.severity] > SEVERITY_RANK[result]) {
      result = item.severity;
    }
  }
  return result;
}

function sourceOf(entry: { agent: string; model?: string }): FindingSource {
  return entry.model === undefined ? { agent: entry.agent } : { agent: entry.agent, model: entry.model };
}

/** Разбивает нормализованный claim на значимые токены */
function claimTokens(claim: string): Set<string> {
  const tokens = new Set<string>();
  for (const token of normalizeClaim(claim).split(' ')) {
    if (token.length >= MIN_TOKEN_LENGTH && !CLAIM_STOPWORDS.has(token)) tokens.add(token);
  }
  return tokens;
}

/** Ищет самую похожую находку в той же категории и том же файле */
function findFuzzyMatch(
  items: readonly Finding[],
  category: string,
  file: string | undefined,
  claim: string
): Finding | undefined {
  const categoryKey = normalizeToken(category);
  const fileKey = normalizeToken(file ?? '');
  let best: Finding | undefined;
  let bestScore = 0;
  for (const item of items) {
    if (normalizeToken(item.category) !== categoryKey) continue;
    if (normalizeToken(item.file ?? '') !== fileKey) continue;
    const score = claimSimilarity(item.claim, claim);
    if (score >= CLAIM_SIMILARITY_THRESHOLD && score > bestScore) {
      best = item;
      bestScore = score;
    }
  }
  return best;
}

/** Запоминает все формулировки, сведённые в одну находку, для проверки rejected */
function rememberClaim(map: Map<Finding, string[]>, finding: Finding, claim: string): void {
  const claims = map.get(finding);
  if (claims === undefined) {
    map.set(finding, [claim]);
    return;
  }
  if (!claims.includes(claim)) claims.push(claim);
}

/** Позиция считается той же, если совпадает точно или проходит порог похожести */
function claimsSimilar(a: string, b: string): boolean {
  return sameClaim(a, b) || claimSimilarity(a, b) >= CLAIM_SIMILARITY_THRESHOLD;
}

function normalizeRawFinding(value: unknown): RawFinding | null {
  if (!isRecord(value) || typeof value['claim'] !== 'string') return null;
  const claim = value['claim'].trim();
  if (claim.length === 0) return null;
  return {
    claim,
    severity: toSeverity(value['severity']),
    category: typeof value['category'] === 'string' ? value['category'] : undefined,
    file: typeof value['file'] === 'string' ? value['file'] : undefined,
    line: normalizeLine(value['line']),
    evidence: typeof value['evidence'] === 'string' ? value['evidence'] : undefined,
    confidence: normalizeConfidence(value['confidence'])
  };
}

function toRejectedPosition(value: unknown): { claim: string; reason?: string } | null {
  if (!isRecord(value) || typeof value['claim'] !== 'string') return null;
  const claim = value['claim'].trim();
  if (claim.length === 0) return null;
  return {
    claim,
    reason: typeof value['reason'] === 'string' ? value['reason'] : undefined
  };
}

function toSeverity(value: unknown): FindingSeverity {
  if (typeof value !== 'string') return 'medium';
  const normalized = value.trim().toLowerCase();
  return (SEVERITIES as readonly string[]).includes(normalized)
    ? (normalized as FindingSeverity)
    : 'medium';
}

function normalizeLine(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const line = Math.floor(value);
  return line > 0 ? line : undefined;
}

function normalizeConfidence(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  if (value < 0 || value > 1) return undefined;
  return Math.round(value * 100) / 100;
}

function normalizeToken(value: string): string {
  return value.toLowerCase().replace(/\\/g, '/').replace(/\s+/g, ' ').trim();
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
