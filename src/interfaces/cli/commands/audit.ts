/**
 * @fileoverview Команда audit: аудит изменений с указанного git ref
 * @module lv24-opencode-consilium/cli/commands/audit
 */

import type { CLIOptions } from '../../../domain/types.js';
import {
  buildAuditRequest,
  formatAuditSummary,
  type AuditRequest
} from '../../../application/audit.js';
import { EXIT_CODES, UsageError } from '../args.js';
import { commandRun } from './run.js';

/** Зависимости команды audit, подменяемые в тестах */
export interface AuditCommandDependencies {
  /** Запуск консилиума (по умолчанию настоящая команда run) */
  run?: typeof commandRun;
}

/** Печатает сводку dry-run без вызова моделей */
function printAuditDryRun(request: AuditRequest): void {
  console.log(formatAuditSummary(request));
  console.log(`ref: ${request.ref}`);
  console.log(`files: ${request.files.length}`);
  console.log(`truncated: ${request.truncated}`);
  console.log(`task length: ${request.task.length}`);
}

export async function commandAudit(
  options: CLIOptions,
  deps: AuditCommandDependencies = {}
): Promise<number> {
  const since = typeof options.since === 'string' ? options.since.trim() : '';
  if (since.length === 0) {
    throw new UsageError('Флаг --since <ref> обязателен для команды audit.');
  }

  let request: AuditRequest;
  try {
    const instruction = typeof options.task === 'string' ? options.task.trim() : '';
    request = await buildAuditRequest({
      since,
      cwd: process.cwd(),
      task: instruction.length > 0 ? instruction : undefined
    });
  } catch (error) {
    if (error instanceof UsageError) throw error;
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }

  if (options.dryRun) {
    if (options.json) {
      console.log(
        JSON.stringify(
          {
            ref: request.ref,
            files: request.files.length,
            truncated: request.truncated,
            taskLength: request.task.length
          },
          null,
          2
        )
      );
    } else {
      printAuditDryRun(request);
    }
    return EXIT_CODES.success;
  }

  const run = deps.run ?? commandRun;
  const runOptions: CLIOptions = {
    ...options,
    command: 'run',
    task: request.task,
    diff: false,
    diffStaged: false,
    diffBase: undefined,
    artifacts: true,
    // Аудит — ревью: по умолчанию без права записи. --allow-write снимает запрет.
    readOnly: options.readOnly ?? true
  };

  // Политика --fail-on требует находок: для audit включаем их автоматически,
  // иначе commandRun отклонит запуск без явного --findings.
  if (options.failOn !== undefined && options.failOn !== 'none') {
    runOptions.findings = true;
    runOptions.noFindings = false;
  }

  return run(runOptions);
}
