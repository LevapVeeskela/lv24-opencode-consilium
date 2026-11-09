/**
 * @fileoverview Подготовка задачи аудита изменений с указанного git ref
 * @module lv24-opencode-consilium
 */

import {
  formatDiffForPrompt,
  getCommitRangeDiff,
  type CommitRangeDiffResult
} from '../infrastructure/git.js';

export { GitRefError as AuditRefError } from '../infrastructure/git.js';
export type { GitRefErrorCode as AuditRefErrorCode } from '../infrastructure/git.js';

/** Инструкция аудита по умолчанию: баги, безопасность, тесты */
export const DEFAULT_AUDIT_TASK =
  'Проведи ревью изменений ниже. Найди баги, проблемы безопасности и отсутствующие тесты. '
  + 'Для каждой проблемы укажи файл, серьёзность и конкретное исправление. '
  + 'Не выдумывай проблемы, которых нет в diff.';

/** Входные данные для buildAuditRequest */
export interface BuildAuditRequestInput {
  /** Git ref, с которого начинается аудит (например, HEAD~1 или main) */
  since: string;
  /** Рабочая директория git-репозитория */
  cwd?: string;
  /** Дополнительная инструкция; заменяет DEFAULT_AUDIT_TASK */
  task?: string;
  /** Лимит символов diff (для тестов и интеграции) */
  maxChars?: number;
  /** Таймаут git, мс */
  timeoutMs?: number;
}

/** Готовый запрос аудита */
export interface AuditRequest {
  ref: string;
  task: string;
  diff: string;
  files: string[];
  truncated: boolean;
}

/** Выбирает инструкцию аудита: пользовательскую или по умолчанию */
function resolveAuditInstruction(task: string | undefined): string {
  const trimmed = task?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : DEFAULT_AUDIT_TASK;
}

/**
 * Собирает задачу аудита изменений с указанного ref до HEAD
 */
export async function buildAuditRequest(input: BuildAuditRequestInput): Promise<AuditRequest> {
  const ref = (input.since ?? '').trim();
  const result: CommitRangeDiffResult = await getCommitRangeDiff(ref, {
    cwd: input.cwd,
    maxChars: input.maxChars,
    timeoutMs: input.timeoutMs
  });

  const instruction = resolveAuditInstruction(input.task);
  const diffBlock = formatDiffForPrompt({
    diff: result.diff,
    truncated: result.truncated,
    filesChanged: result.files.length
  });

  const task = [
    `Audit the changes since ${ref}.`,
    '',
    instruction,
    '',
    diffBlock
  ].join('\n');

  return {
    ref,
    task,
    diff: result.diff,
    files: result.files,
    truncated: result.truncated
  };
}

/**
 * Краткая сводка запроса аудита для CLI/логов
 */
export function formatAuditSummary(request: AuditRequest): string {
  const state = request.truncated ? 'diff обрезан' : 'diff полный';
  return `Аудит изменений с ${request.ref}: файлов — ${request.files.length}, ${state}.`;
}
