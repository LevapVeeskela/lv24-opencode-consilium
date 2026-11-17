/**
 * @fileoverview Состояние policy gate (`--fail-on`): passed / failed / inconclusive.
 *
 * Гейт считается несостоявшимся (inconclusive), если проверка была неполной:
 * эксперт не дал пригодного ответа либо блок находок не удалось разобрать.
 * Чистая логика без I/O; тексты ответов моделей в причины не попадают —
 * только имена агентов и машинные коды.
 *
 * @module lv24-opencode-consilium
 */

import { stripControlSequences } from '../../shared/redact.js';
import type { AgentResult } from '../types.js';
import type { FailOnLevel } from './baseline.js';
import { FAIL_ON_LEVELS } from './baseline.js';

/** Итог проверки политики */
export type PolicyGateState = 'passed' | 'failed' | 'inconclusive';

/** Почему проверка считается неполной */
export type PolicyGateReasonKind =
  | 'expert_failed'
  | 'chair_failed'
  | 'parse_error'
  | 'diff_truncated';

/** Одна причина неполной проверки: агент и машинный код, без текста ответа */
export interface PolicyGateReason {
  kind: PolicyGateReasonKind;
  agent: string;
  code: string;
}

/** Состояние гейта в `metadata.policyGate` */
export interface PolicyGateStatus {
  state: PolicyGateState;
  /** Порог `--fail-on` */
  threshold: FailOnLevel;
  /** Число новых находок не ниже порога */
  violations: number;
  /** Причины неполной проверки (пусто, если ответили и разобрались все) */
  reasons: PolicyGateReason[];
  /** Запуск разрешил неполную проверку флагом `--gate-allow-partial` */
  allowPartial: boolean;
}

/** Минимальный срез результата запуска, нужный гейту */
export interface PolicyGateRunView {
  experts: ReadonlyArray<Pick<AgentResult, 'agent' | 'success' | 'errorCode'>>;
  chair?: Pick<AgentResult, 'agent' | 'success' | 'errorCode'>;
  metadata?:
    | { findings?: { parseErrors?: unknown }; diff?: { truncated?: unknown } }
    | undefined;
}

const MAX_REASON_FIELD_LENGTH = 80;
const REASON_KINDS: readonly PolicyGateReasonKind[] = [
  'expert_failed',
  'chair_failed',
  'parse_error',
  'diff_truncated'
];
const STATES: readonly PolicyGateState[] = ['passed', 'failed', 'inconclusive'];

/** Однострочное безопасное поле: без управляющих символов и переводов строк */
function reasonField(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const flat = stripControlSequences(value).replace(/\s+/g, ' ').trim();
  return flat.length > 0 ? flat.slice(0, MAX_REASON_FIELD_LENGTH) : fallback;
}

/** Код ошибки разбора: только машинный идентификатор, не текст модели */
function parseErrorCode(value: string): string {
  const code = value.trim();
  return /^[A-Za-z0-9_-]{1,40}$/.test(code) ? code : 'parse-error';
}

/**
 * Собирает причины неполной проверки: эксперты без пригодного ответа
 * (ошибка, тайм-аут, пустой ответ, лимит), упавший председатель, ошибки
 * разбора блока находок (`metadata.findings.parseErrors`) и обрезанный diff
 * (`metadata.diff.truncated`): часть изменений модели не видели.
 */
export function collectPolicyGateReasons(run: PolicyGateRunView): PolicyGateReason[] {
  const reasons: PolicyGateReason[] = [];

  for (const expert of run.experts) {
    if (expert.success === true) continue;
    reasons.push({
      kind: 'expert_failed',
      agent: reasonField(expert.agent, 'unknown'),
      code: reasonField(expert.errorCode, 'NO_RESPONSE')
    });
  }

  if (run.chair !== undefined && run.chair.success !== true) {
    reasons.push({
      kind: 'chair_failed',
      agent: reasonField(run.chair.agent, 'chair'),
      code: reasonField(run.chair.errorCode, 'NO_RESPONSE')
    });
  }

  const parseErrors = run.metadata?.findings?.parseErrors;
  if (Array.isArray(parseErrors)) {
    for (const entry of parseErrors) {
      if (typeof entry !== 'string') continue;
      const separator = entry.indexOf(': ');
      const agent = separator === -1 ? entry : entry.slice(0, separator);
      const code = separator === -1 ? '' : entry.slice(separator + 2);
      reasons.push({
        kind: 'parse_error',
        agent: reasonField(agent, 'unknown'),
        code: parseErrorCode(code)
      });
    }
  }

  if (run.metadata?.diff?.truncated === true) {
    reasons.push({ kind: 'diff_truncated', agent: 'diff', code: 'TRUNCATED' });
  }

  return reasons;
}

/** Входные данные для итогового состояния гейта */
export interface PolicyGateStatusInput {
  threshold: FailOnLevel;
  /** Число новых находок не ниже порога */
  violations: number;
  reasons: PolicyGateReason[];
  allowPartial?: boolean;
}

/**
 * Итог: находки выше порога — failed; иначе неполная проверка — inconclusive;
 * иначе passed. `allowPartial` не меняет состояние, только код выхода CLI.
 */
export function resolvePolicyGateStatus(input: PolicyGateStatusInput): PolicyGateStatus {
  const violations =
    Number.isFinite(input.violations) && input.violations > 0 ? Math.floor(input.violations) : 0;
  const state: PolicyGateState =
    violations > 0 ? 'failed' : input.reasons.length > 0 ? 'inconclusive' : 'passed';
  return {
    state,
    threshold: input.threshold,
    violations,
    reasons: input.reasons.map(reason => ({ ...reason })),
    allowPartial: input.allowPartial === true
  };
}

/** Нужно ли завершать CLI кодом policy gate из-за неполной проверки */
export function isBlockingInconclusive(status: PolicyGateStatus): boolean {
  return status.state === 'inconclusive' && !status.allowPartial;
}

function formatReason(reason: PolicyGateReason): string {
  if (reason.kind === 'parse_error') return `${reason.agent}: findings block ${reason.code}`;
  if (reason.kind === 'chair_failed') return `chair ${reason.agent}: ${reason.code}`;
  if (reason.kind === 'diff_truncated') return 'diff: truncated, part of the change was not reviewed';
  return `${reason.agent}: ${reason.code}`;
}

/** Перечень причин одной строкой: `sec: RATE_LIMITED; ux: findings block no-block` */
export function formatPolicyGateReasons(reasons: readonly PolicyGateReason[]): string {
  return reasons.map(formatReason).join('; ');
}

/** Строка для stderr: `policy gate inconclusive: <причины>` */
export function formatInconclusiveGate(status: PolicyGateStatus): string {
  const allowed = status.allowPartial ? ' (allowed by --gate-allow-partial)' : '';
  return `policy gate inconclusive${allowed}: ${formatPolicyGateReasons(status.reasons)}`;
}

/** Короткое описание состояния гейта для отчётов */
export function describePolicyGate(status: PolicyGateStatus): string {
  const head = `${status.state} (fail-on ${status.threshold})`;
  const reasons = formatPolicyGateReasons(status.reasons);
  if (status.state === 'failed') {
    const incomplete = reasons.length > 0 ? `; incomplete review: ${reasons}` : '';
    return `${head}: ${status.violations} new finding(s) at or above the threshold${incomplete}`;
  }
  if (status.state === 'inconclusive') {
    const allowed = status.allowPartial ? ' — allowed by --gate-allow-partial' : '';
    return `${head}: ${reasons}${allowed}`;
  }
  return head;
}

function isReason(value: unknown): value is PolicyGateReason {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record['agent'] === 'string' &&
    typeof record['code'] === 'string' &&
    (REASON_KINDS as readonly unknown[]).includes(record['kind'])
  );
}

/** Достаёт состояние гейта из `metadata.policyGate`, если оно корректно */
export function policyGateStatusFromMetadata(metadata: unknown): PolicyGateStatus | null {
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const value = (metadata as Record<string, unknown>)['policyGate'];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!(STATES as readonly unknown[]).includes(record['state'])) return null;
  if (!(FAIL_ON_LEVELS as readonly unknown[]).includes(record['threshold'])) return null;
  const rawReasons = Array.isArray(record['reasons']) ? record['reasons'] : [];
  return {
    state: record['state'] as PolicyGateState,
    threshold: record['threshold'] as FailOnLevel,
    violations:
      typeof record['violations'] === 'number' && Number.isFinite(record['violations'])
        ? record['violations']
        : 0,
    reasons: rawReasons.filter(isReason).map(reason => ({
      kind: reason.kind,
      agent: reasonField(reason.agent, 'unknown'),
      code: reasonField(reason.code, 'unknown')
    })),
    allowPartial: record['allowPartial'] === true
  };
}
