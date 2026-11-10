// consilium_run tool handler.
import { canonicalizePath, resolveInside } from '../../../shared/paths.js';
import { loadConfig } from '../../../application/consilium.js';
import { applyPreset, listPresets } from '../../../domain/council/presets.js';
import { auditLocalOnly } from '../../../infrastructure/local-models.js';
import type { ConsiliumConfig, RunOptions } from '../../../domain/types.js';
import type { ProgressToken, RequestId } from '../protocol.js';
import { OUTPUT_FORMATS } from '../tools.js';
import type { OutputFormat } from '../tools.js';
import { runConsiliumWithProgress } from './execution.js';
import {
  ToolInputError,
  optionalBoolean,
  optionalEnum,
  optionalInteger,
  optionalNonNegativeNumber,
  optionalPositiveNumber,
  optionalString,
  optionalStringArray,
  requireNonEmptyString,
  resolveWorkspaceOutput,
  toolError
} from './shared.js';
import type { McpToolResult } from './shared.js';

export { computeProgressTotal, formatConsiliumResult } from './execution.js';

function applyPresetFor(config: ConsiliumConfig, name: string): ConsiliumConfig {
  return applyPreset(config, name, config.presets);
}

export async function toolConsiliumRun(
  args: Record<string, unknown>,
  progressToken: ProgressToken | undefined,
  requestId?: RequestId
): Promise<McpToolResult> {
  const task = requireNonEmptyString(args, 'task');
  const experts = optionalStringArray(args, 'experts');
  const chair = optionalString(args, 'chair');
  const timeoutMs = optionalPositiveNumber(args, 'timeout_ms');
  const deadlineMs = optionalInteger(args, 'deadline_ms', 1, Number.MAX_SAFE_INTEGER);
  const localOnly = optionalBoolean(args, 'local_only');
  const readOnly = optionalBoolean(args, 'read_only');
  const isolate = optionalBoolean(args, 'isolate');
  const outputFile = optionalString(args, 'output_file');
  const format: OutputFormat | undefined = optionalEnum(args, 'format', OUTPUT_FORMATS);
  const preset = optionalString(args, 'preset');
  const consensus = optionalBoolean(args, 'consensus');
  const findings = optionalBoolean(args, 'findings');
  const smartExperts = optionalBoolean(args, 'smart_experts');
  const rounds = optionalInteger(args, 'rounds', 1, 2);
  const maxCost = optionalNonNegativeNumber(args, 'max_cost');
  const fallbackModels = optionalStringArray(args, 'fallback_models');
  const session = optionalString(args, 'session');
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

  const loaded = loadConfig();
  let config = loaded.config;
  if (preset !== undefined) {
    const known = listPresets(config.presets).map(item => item.name);
    if (!known.includes(preset)) {
      return toolError(`Unknown preset: ${preset}. Available: ${known.join(', ')}`);
    }
    config = applyPresetFor(config, preset);
  }
  if (format !== undefined) {
    config.output.format = format;
  }
  if (consensus !== undefined) config.consensus = consensus;
  if (findings !== undefined) config.findings = findings;
  if (smartExperts !== undefined) config.smartExperts = smartExperts;
  if (maxCost !== undefined) config.maxCost = maxCost;
  if (fallbackModels !== undefined) config.fallbackModels = fallbackModels;
  if (session !== undefined) config.session = session;
  if (artifacts !== undefined) config.artifacts = artifacts;
  if (deadlineMs !== undefined) config.deadlineMs = deadlineMs;
  if (rounds !== undefined) config.rounds = rounds;
  if (localOnly !== undefined) config.localOnly = localOnly;
  if (readOnly !== undefined) config.readOnly = readOnly;
  if (isolate !== undefined) config.isolate = isolate;
  if (outputPath.value !== undefined) {
    config.output.file = outputPath.value;
  }

  if (config.localOnly === true) {
    const audit = auditLocalOnly([
      ...config.experts.map(expert => ({ label: expert.name, model: expert.model })),
      { label: config.chair.agent, model: config.chair.model }
    ]);
    if (audit.missing.length > 0) {
      return toolError(
        'Local-only mode requires an explicit local model for every agent. ' +
          `Missing: ${audit.missing.join(', ')}`
      );
    }
    if (audit.nonLocal.length > 0) {
      return toolError(
        'Local-only mode requires local providers. ' +
          `Non-local models: ${audit.nonLocal.join(', ')}`
      );
    }
  }

  const runOptions: RunOptions = {};
  if (experts !== undefined) runOptions.experts = experts;
  if (chair !== undefined) runOptions.chair = chair;
  if (timeoutMs !== undefined) runOptions.timeout = timeoutMs;
  if (outputPath.value !== undefined) runOptions.outputFile = outputPath.value;

  return runConsiliumWithProgress({
    config,
    task,
    runOptions,
    progressToken,
    requestId,
    warningSections: [{ heading: 'Config warnings', items: loaded.warnings }],
    errorPrefix: 'Consilium run'
  });
}
