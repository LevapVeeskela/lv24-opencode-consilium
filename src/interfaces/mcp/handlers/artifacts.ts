// Read-only artifact tools: list saved runs, read one, export SARIF, diff two runs.
import { diffArtifacts } from '../../../domain/artifacts/artifacts.js';
import type { ArtifactRun } from '../../../domain/artifacts/artifacts.js';
import { ID_PATTERN } from '../../../domain/artifacts/artifacts/types.js';
import { findingsSummaryFromMetadata } from '../../../domain/artifacts/report.js';
import { buildSarifReport } from '../../../domain/artifacts/sarif.js';
import {
  listArtifacts,
  loadArtifact,
  resolveArtifactRoot
} from '../../../infrastructure/artifacts/store.js';
import { writeFileAtomic } from '../../../shared/fs.js';
import { DEFAULT_VERSION } from '../protocol.js';
import {
  ToolInputError,
  describeError,
  optionalInteger,
  optionalString,
  requireNonEmptyString,
  resolveWorkspaceOutput,
  toolError,
  toolText
} from './shared.js';
import type { McpToolResult } from './shared.js';

interface RunSummary {
  id: string;
  createdAt: string;
  task: string;
  success: boolean;
  findings?: {
    total: number;
    counts: Record<string, number>;
  };
  path: string;
}

/** Стандартный корень артефактов текущего проекта: `.consilium/runs`. */
export function artifactRoot(): string {
  return resolveArtifactRoot({ cwd: process.cwd() });
}

function normalizeRunSelector(value: string | undefined): string {
  const selector = (value ?? 'latest').trim();
  return selector.length === 0 ? 'latest' : selector;
}

function loadRunById(id: string, root: string): ArtifactRun {
  try {
    return loadArtifact(id, root);
  } catch (error) {
    throw new Error(`Cannot load run "${id}": ${describeError(error)}`);
  }
}

/**
 * Загружает запуск по id или `latest`.
 * Идентификатор проверяется до чтения: пути и `..` не принимаются.
 */
export function loadRun(selectorValue: string | undefined, root: string): ArtifactRun {
  const selector = normalizeRunSelector(selectorValue);
  if (selector === 'latest') {
    const [latest] = listArtifacts(root);
    if (latest === undefined) {
      throw new ToolInputError(
        `No saved runs found in ${root}. Run the council with artifacts enabled first.`
      );
    }
    return loadRunById(latest.id, root);
  }

  if (
    !ID_PATTERN.test(selector) ||
    selector === '.' ||
    selector === '..' ||
    selector.includes('..')
  ) {
    throw new ToolInputError('"run" must be a saved run id or "latest"');
  }
  return loadRunById(selector, root);
}

function summarizeRun(artifact: ArtifactRun, path: string): RunSummary {
  const summary: RunSummary = {
    id: artifact.id,
    createdAt: artifact.createdAt,
    task: artifact.task,
    success: artifact.success,
    path
  };
  const findings = findingsSummaryFromMetadata(artifact.metadata);
  if (findings !== null) {
    summary.findings = {
      total: findings.items.length,
      counts: findings.counts
    };
  }
  return summary;
}

/** `consilium_list_runs`: новые запуски первыми. */
export async function toolListRuns(args: Record<string, unknown>): Promise<McpToolResult> {
  const limit = optionalInteger(args, 'limit', 1, 100) ?? 10;
  const root = artifactRoot();
  const refs = listArtifacts(root).slice(0, limit);
  const runs: RunSummary[] = [];

  for (const ref of refs) {
    try {
      runs.push(summarizeRun(loadArtifact(ref.id, root), ref.dir));
    } catch {
      // Битый артефакт не должен скрывать остальные запуски.
    }
  }

  return toolText(JSON.stringify({ runs }, null, 2));
}

/** `consilium_get_run`: полный run.json как JSON-текст. */
export async function toolGetRun(args: Record<string, unknown>): Promise<McpToolResult> {
  const run = optionalString(args, 'run');
  const artifact = loadRun(run, artifactRoot());
  return toolText(JSON.stringify(artifact, null, 2));
}

/** `consilium_sarif`: SARIF 2.1.0 в ответ или атомарно в файл внутри workspace. */
export async function toolSarif(args: Record<string, unknown>): Promise<McpToolResult> {
  const run = optionalString(args, 'run');
  const outputFile = optionalString(args, 'output_file');
  const artifact = loadRun(run, artifactRoot());

  const findings = findingsSummaryFromMetadata(artifact.metadata) ?? undefined;
  const document = buildSarifReport(findings, { version: DEFAULT_VERSION });
  const json = `${JSON.stringify(document, null, 2)}\n`;
  const count = findings?.items.length ?? 0;

  if (outputFile === undefined || outputFile.trim().length === 0) {
    return toolText(json.trimEnd());
  }

  const resolved = resolveWorkspaceOutput(outputFile, 'output_file');
  if (resolved.error !== undefined || resolved.value === undefined) {
    return toolError(resolved.error ?? '"output_file" must stay inside the workspace');
  }

  try {
    writeFileAtomic(resolved.value, json);
  } catch (error) {
    return toolError(`Cannot write SARIF: ${describeError(error)}`);
  }

  return toolText(
    JSON.stringify(
      {
        path: resolved.value,
        run: artifact.id,
        findings: count
      },
      null,
      2
    )
  );
}

/** `consilium_diff_runs`: markdown-сравнение двух сохранённых запусков. */
export async function toolDiffRuns(args: Record<string, unknown>): Promise<McpToolResult> {
  const leftSelector = requireNonEmptyString(args, 'left');
  const rightSelector = requireNonEmptyString(args, 'right');
  const root = artifactRoot();
  const left = loadRun(leftSelector, root);
  const right = loadRun(rightSelector, root);
  return toolText(diffArtifacts(left, right));
}
