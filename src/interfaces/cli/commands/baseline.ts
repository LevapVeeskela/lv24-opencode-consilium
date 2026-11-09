/**
 * @fileoverview Команда baseline: принятие находок и очистка baseline.
 * @module lv24-opencode-consilium/cli/commands/baseline
 */

import { statSync } from 'node:fs';
import { join } from 'node:path';
import type { CLIOptions } from '../../../domain/types.js';
import type { ArtifactRun } from '../../../domain/artifacts/artifacts.js';
import {
  acceptFindings,
  artifactFindings,
  DEFAULT_PRUNE_DAYS,
  loadBaseline,
  pruneBaseline,
  saveBaseline
} from '../../../domain/artifacts/baseline.js';
import {
  listArtifacts,
  loadArtifact,
  resolveArtifactRoot
} from '../../../infrastructure/artifacts/store.js';
import { errorMessage } from '../../../shared/errors.js';
import { EXIT_CODES, UsageError } from '../args.js';

/** Находит самый свежий артефакт по mtime run.json (список — через listArtifacts) */
function latestArtifactPath(root: string): string {
  const refs = listArtifacts(root);
  if (refs.length === 0) {
    throw new UsageError(`Артефакты не найдены: ${root}`);
  }

  let latest = refs[0];
  let latestTime = -Infinity;
  for (const ref of refs) {
    let mtime = -Infinity;
    try {
      mtime = statSync(join(ref.dir, 'run.json')).mtimeMs;
    } catch {
      // Битый/удалённый артефакт не должен ломать поиск остальных
    }
    if (mtime > latestTime) {
      latest = ref;
      latestTime = mtime;
    }
  }
  return latest.dir;
}

function warn(options: CLIOptions, warning: string | undefined): void {
  if (warning !== undefined && !options.silent) {
    console.error(`⚠️ ${warning}`);
  }
}

async function acceptBaseline(options: CLIOptions, cwd: string): Promise<number> {
  const target = options.baselineTarget?.trim() ?? '';
  if (target.length === 0) {
    throw new UsageError(
      'Укажите runId или latest: consilium baseline accept <runId|latest>'
    );
  }

  const root = resolveArtifactRoot({ artifacts: options.artifacts ?? true, cwd });
  let artifact: ArtifactRun;
  try {
    const source = target === 'latest' ? latestArtifactPath(root) : target;
    artifact = loadArtifact(source, root);
  } catch (error) {
    if (error instanceof UsageError) throw error;
    throw new UsageError(errorMessage(error));
  }

  const loaded = loadBaseline(cwd);
  warn(options, loaded.warning);

  const accepted = acceptFindings(loaded.baseline, artifactFindings(artifact));
  const total = accepted.baseline.findings.length;
  if (options.dryRun) {
    console.log(
      `[dry-run] Baseline: добавлено ${accepted.added}, обновлено ${accepted.updated}, ` +
        `всего ${total} (файл не изменён).`
    );
    return EXIT_CODES.success;
  }

  saveBaseline(cwd, accepted.baseline);
  console.log(
    `✅ Baseline обновлён: добавлено ${accepted.added}, обновлено ${accepted.updated}, ` +
      `всего ${total}.`
  );
  return EXIT_CODES.success;
}

function pruneBaselineCommand(options: CLIOptions, cwd: string): number {
  const extra = options.baselineTarget?.trim() ?? '';
  if (extra.length > 0) {
    throw new UsageError('baseline prune не принимает позиционные аргументы');
  }
  if (options.all === true && options.yes !== true) {
    throw new UsageError('Флаг --all удаляет весь baseline; подтвердите действие флагом --yes');
  }

  const loaded = loadBaseline(cwd);
  warn(options, loaded.warning);

  const pruned = pruneBaseline(loaded.baseline, {
    all: options.all === true,
    olderThanDays: options.olderThan ?? DEFAULT_PRUNE_DAYS
  });
  const remaining = pruned.baseline.findings.length;

  if (options.dryRun) {
    console.log(
      `[dry-run] Baseline: будет удалено ${pruned.removed}, останется ${remaining} ` +
        `(файл не изменён).`
    );
    return EXIT_CODES.success;
  }

  if (pruned.removed > 0) {
    saveBaseline(cwd, pruned.baseline);
  }
  console.log(`🧹 Baseline: удалено ${pruned.removed}, осталось ${remaining}.`);
  return EXIT_CODES.success;
}

/** Выполняет `baseline accept` или `baseline prune` в текущем каталоге проекта */
export async function commandBaseline(options: CLIOptions): Promise<number> {
  const cwd = process.cwd();

  if (options.baselineAction === undefined) {
    const action = options.task.trim();
    throw new UsageError(
      action.length > 0
        ? `Неизвестное действие baseline: ${action}. Доступны: accept, prune`
        : 'Укажите действие: consilium baseline accept <runId|latest> | ' +
          'consilium baseline prune [--older-than <дни>] [--all] [--yes]'
    );
  }

  return options.baselineAction === 'accept'
    ? acceptBaseline(options, cwd)
    : pruneBaselineCommand(options, cwd);
}
