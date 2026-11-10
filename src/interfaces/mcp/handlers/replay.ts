// consilium_replay tool handler: re-run a saved artifact with streaming progress.
import { canonicalizePath, resolveInside } from '../../../shared/paths.js';
import { loadConfig } from '../../../application/consilium.js';
import { applyReplayPlan } from '../../../application/replay.js';
import type { RunOptions } from '../../../domain/types.js';
import type { ProgressToken, RequestId } from '../protocol.js';
import { artifactRoot, loadRun } from './artifacts.js';
import { runConsiliumWithProgress } from './execution.js';
import {
  ToolInputError,
  optionalBoolean,
  optionalInteger,
  optionalNonNegativeNumber,
  optionalPositiveNumber,
  optionalString,
  resolveWorkspaceOutput,
  toolError
} from './shared.js';
import type { McpToolResult } from './shared.js';

/** Опции consilium_run, которые нельзя переопределить при повторе артефакта. */
const NON_REPLAYABLE_OPTIONS = [
  'task',
  'experts',
  'chair',
  'format',
  'preset',
  'local_only',
  'consensus',
  'smart_experts',
  'fallback_models'
] as const;

function rejectUnsupportedOptions(args: Record<string, unknown>): void {
  const provided = NON_REPLAYABLE_OPTIONS.filter(key => args[key] !== undefined);
  if (provided.length === 0) return;

  const taskHint = provided.includes('task')
    ? ' The saved task is used; task overrides are not supported.'
    : '';
  throw new ToolInputError(
    `Unsupported option(s) for consilium_replay: ${provided.join(', ')}.${taskHint} ` +
      'Replay restores these values from the saved run.'
  );
}

export async function toolConsiliumReplay(
  args: Record<string, unknown>,
  progressToken: ProgressToken | undefined,
  requestId?: RequestId
): Promise<McpToolResult> {
  rejectUnsupportedOptions(args);

  const runSelector = optionalString(args, 'run');
  const readOnly = optionalBoolean(args, 'read_only');
  const isolate = optionalBoolean(args, 'isolate');
  const outputFile = optionalString(args, 'output_file');
  const maxCost = optionalNonNegativeNumber(args, 'max_cost');
  const deadlineMs = optionalInteger(args, 'deadline_ms', 1, Number.MAX_SAFE_INTEGER);
  const rounds = optionalInteger(args, 'rounds', 1, 2);
  const findings = optionalBoolean(args, 'findings');
  const session = optionalString(args, 'session');
  const timeoutMs = optionalPositiveNumber(args, 'timeout_ms');

  const workspace = canonicalizePath(process.cwd());
  const artifactsArg = args['artifacts'];
  let artifacts: boolean | string | undefined;
  if (typeof artifactsArg === 'boolean') {
    artifacts = artifactsArg;
  } else if (typeof artifactsArg === 'string') {
    try {
      artifacts = resolveInside(workspace, artifactsArg, 'artifacts');
    } catch {
      throw new ToolInputError('"artifacts" must stay inside the workspace');
    }
  } else if (artifactsArg !== undefined) {
    throw new ToolInputError('"artifacts" must be a boolean or a string path');
  }

  const outputPath = resolveWorkspaceOutput(outputFile, 'output_file');
  if (outputPath.error !== undefined) {
    return toolError(outputPath.error);
  }

  const artifact = loadRun(runSelector, artifactRoot());
  if (artifact.task.trim().length === 0) {
    return toolError(
      `Saved run "${artifact.id}" has no task (task is missing or empty); cannot replay it.`
    );
  }

  const loaded = loadConfig();
  const config = loaded.config;
  const replay = applyReplayPlan(config, artifact, {
    chairAgent: config.chair.agent,
    artifacts: artifacts !== undefined ? artifacts : config.artifacts
  });

  if (replay.plan.experts.length === 0) {
    return toolError(
      `Saved run "${artifact.id}" has no experts; cannot replay it. ` +
        'Record at least one expert in the artifact first.'
    );
  }

  if (readOnly !== undefined) config.readOnly = readOnly;
  if (isolate !== undefined) config.isolate = isolate;
  if (findings !== undefined) config.findings = findings;
  if (maxCost !== undefined) config.maxCost = maxCost;
  if (deadlineMs !== undefined) config.deadlineMs = deadlineMs;
  if (rounds !== undefined) config.rounds = rounds;
  if (session !== undefined) config.session = session;
  if (outputPath.value !== undefined) {
    config.output.file = outputPath.value;
  }

  const runOptions: RunOptions = { metadata: { replayOf: artifact.id } };
  if (timeoutMs !== undefined) runOptions.timeout = timeoutMs;
  if (outputPath.value !== undefined) runOptions.outputFile = outputPath.value;

  return runConsiliumWithProgress({
    config,
    task: replay.plan.task,
    runOptions,
    progressToken,
    requestId,
    warningSections: [
      { heading: 'Config warnings', items: loaded.warnings },
      { heading: 'Replay warnings', items: replay.plan.warnings }
    ],
    errorPrefix: 'Consilium replay'
  });
}
