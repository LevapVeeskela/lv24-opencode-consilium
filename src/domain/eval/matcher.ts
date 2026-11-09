/**
 * @fileoverview Чистый детерминированный матчер eval-находок. Не вызывает
 * модели и не зависит от времени: только нормализация claim и фильтры.
 * @module lv24-opencode-consilium
 */

import { normalizeClaim } from '../council/findings.js';
import type { Finding, FindingSeverity } from '../council/findings.js';
import type {
  EvalExpectations,
  EvalFindingMatch,
  EvalMatchResult,
  ExpectedFinding
} from './types.js';

const SEVERITY_RANK: Record<FindingSeverity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  info: 0
};

/**
 * Сопоставляет находки с ожиданиями фикстуры.
 * Каждое ожидание ищет первую подходящую находку; находки не «расходуются»,
 * поэтому одна находка может закрыть несколько ожиданий.
 */
export function matchFindings(
  findings: readonly Finding[],
  expected: EvalExpectations
): EvalMatchResult {
  const caught: EvalFindingMatch[] = [];
  const missed: ExpectedFinding[] = [];
  const falsePositives: EvalFindingMatch[] = [];

  for (const target of expected.mustFind ?? []) {
    const finding = findings.find(item => matchesExpected(item, target));
    if (finding === undefined) {
      missed.push(target);
    } else {
      caught.push({ expected: target, finding });
    }
  }

  for (const target of expected.mustNotFind ?? []) {
    const finding = findings.find(item => matchesExpected(item, target));
    if (finding !== undefined) falsePositives.push({ expected: target, finding });
  }

  return {
    caught,
    missed,
    falsePositives,
    catchRate: rate(caught.length, caught.length + missed.length),
    falsePositiveRate: rate(falsePositives.length, caught.length + falsePositives.length)
  };
}

/**
 * Проверяет одну находку против одного ожидания:
 * claim — подстрока нормализованного claim, file/category/minSeverity — фильтры.
 */
export function matchesExpected(finding: Finding, expected: ExpectedFinding): boolean {
  const alternatives = Array.isArray(expected.claimIncludes)
    ? expected.claimIncludes
    : expected.claimIncludes === undefined
      ? []
      : [expected.claimIncludes];

  const filters = alternatives.length > 0 ||
    (expected.file !== undefined && expected.file.trim().length > 0) ||
    (expected.category !== undefined && expected.category.trim().length > 0) ||
    expected.minSeverity !== undefined;
  if (!filters) return false;

  if (alternatives.length > 0) {
    if (typeof finding.claim !== 'string') return false;
    const actualClaim = normalizeClaim(finding.claim);
    const matched = alternatives.some(alternative => {
      const wanted = normalizeClaim(alternative);
      return wanted.length > 0 && actualClaim.includes(wanted);
    });
    if (!matched) return false;
  }

  if (expected.file !== undefined && expected.file.trim().length > 0) {
    if (finding.file === undefined || !fileMatches(finding.file, expected.file)) return false;
  }

  if (expected.category !== undefined && expected.category.trim().length > 0) {
    if (normalizeToken(finding.category ?? '') !== normalizeToken(expected.category)) return false;
  }

  if (expected.minSeverity !== undefined) {
    const minimum = SEVERITY_RANK[expected.minSeverity];
    const actual = SEVERITY_RANK[finding.severity];
    if (minimum === undefined || actual === undefined || actual < minimum) return false;
  }

  return true;
}

function fileMatches(actual: string, expected: string): boolean {
  const left = normalizeFile(actual);
  const right = normalizeFile(expected);
  if (left.length === 0 || right.length === 0) return false;
  if (left === right) return true;
  // Диффы обычно используют путь от корня, а находка может быть относительной.
  return left.endsWith(`/${right}`);
}

function normalizeFile(value: string): string {
  return value
    .toLowerCase()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/{2,}/g, '/')
    .trim();
}

function normalizeToken(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}
