/**
 * @fileoverview Команда sarif: экспорт находок сохранённого запуска в SARIF 2.1.0.
 * @module lv24-opencode-consilium/cli/commands/sarif
 */

import { readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CLIOptions } from '../../../domain/types.js';
import type { FindingsSummary } from '../../../domain/council/findings.js';
import { buildSarifReport } from '../../../domain/artifacts/sarif.js';
import { findingsSummaryFromMetadata } from '../../../domain/artifacts/report.js';
import type { ArtifactRef, ArtifactRun } from '../../../domain/artifacts/artifacts/types.js';
import {
  listArtifacts,
  loadArtifact,
  resolveArtifactRoot
} from '../../../infrastructure/artifacts/store.js';
import { writeFileAtomic } from '../../../shared/fs.js';
import { errorMessage } from '../../../shared/errors.js';
import { EXIT_CODES, UsageError } from '../args.js';

/** Зависимости команды sarif, подменяемые в тестах. */
export interface SarifCommandDependencies {
  /** Рабочая директория проекта (по умолчанию process.cwd()). */
  cwd?: string;
}

/** Версия пакета для `tool.driver.version` (fallback — 0.0.0). */
function packageVersion(): string {
  try {
    const packagePath = fileURLToPath(new URL('../../../../package.json', import.meta.url));
    const parsed = JSON.parse(readFileSync(packagePath, 'utf8')) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** Каталог артефактов: --artifacts-dir, строка --artifacts или .consilium/runs. */
function artifactRoot(options: CLIOptions, cwd: string): string {
  const configured =
    options.artifactsDir ??
    (typeof options.artifacts === 'string' ? options.artifacts : undefined);
  return resolveArtifactRoot({
    artifacts: configured ?? true,
    cwd
  });
}

/** Находит самый свежий артефакт по mtime run.json (список — через listArtifacts). */
function latestArtifact(root: string): ArtifactRef {
  const refs = listArtifacts(root);
  if (refs.length === 0) {
    throw new UsageError(
      `Артефакты не найдены в ${root}. Запустите consilium с флагом --artifacts, ` +
        'чтобы сохранить run.json.'
    );
  }

  let latest = refs[0];
  let latestTime = -Infinity;
  for (const ref of refs) {
    let mtime = -Infinity;
    try {
      mtime = statSync(join(ref.dir, 'run.json')).mtimeMs;
    } catch {
      // Битый/удалённый артефакт не должен ломать поиск остальных.
    }
    if (mtime > latestTime) {
      latest = ref;
      latestTime = mtime;
    }
  }
  return latest;
}

/** Достаёт `metadata.findings`, если оно похоже на FindingsSummary. */
function readFindings(artifact: ArtifactRun): FindingsSummary | undefined {
  return findingsSummaryFromMetadata(artifact.metadata) ?? undefined;
}

function assertNoPositionals(options: CLIOptions): void {
  const extra = options.task.trim();
  if (extra.length > 0) {
    throw new UsageError(`Команда sarif не принимает позиционные аргументы: ${extra}`);
  }
}

/** Выполняет `consilium sarif [--run <id|latest>] [--output <файл>]`. */
export async function commandSarif(
  options: CLIOptions,
  dependencies: SarifCommandDependencies = {}
): Promise<number> {
  assertNoPositionals(options);

  const cwd = dependencies.cwd ?? process.cwd();
  const root = artifactRoot(options, cwd);
  const target = typeof options.run === 'string' ? options.run.trim() : '';
  const runSelector = target.length > 0 ? target : 'latest';

  let artifact: ArtifactRun;
  try {
    artifact =
      runSelector === 'latest'
        ? loadArtifact(latestArtifact(root).dir, root)
        : loadArtifact(runSelector, root);
  } catch (error) {
    if (error instanceof UsageError) throw error;
    throw new UsageError(errorMessage(error));
  }

  const findings = readFindings(artifact);
  const document = buildSarifReport(findings, { version: packageVersion() });
  const json = `${JSON.stringify(document, null, 2)}\n`;
  const count = findings?.items.length ?? 0;

  const output = typeof options.output === 'string' ? options.output.trim() : '';
  if (output.length === 0) {
    console.log(json.trimEnd());
    if (count === 0) {
      console.error('SARIF: находок нет — записан пустой отчёт.');
    }
    return EXIT_CODES.success;
  }

  const outputPath = resolve(cwd, output);
  try {
    writeFileAtomic(outputPath, json);
  } catch (error) {
    throw new UsageError(`Не удалось записать SARIF: ${errorMessage(error)}`);
  }

  const emptyNote = count === 0 ? ' (пустой отчёт: находок нет)' : '';
  console.error(`SARIF: находок ${count}${emptyNote} → ${outputPath}`);
  return EXIT_CODES.success;
}
