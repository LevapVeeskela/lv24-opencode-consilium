// consilium_run tool handler.
import { canonicalizePath, resolveInside } from '../../../shared/paths.js';
import { Consilium, loadConfig } from '../../../application/consilium.js';
import { selectExperts } from '../../../application/run.js';
import { applyPreset } from '../../../domain/council/presets.js';
import { selectSmartExperts } from '../../../domain/council/smart-experts.js';
import type {
  ConsiliumConfig,
  ConsiliumResult,
  ProgressEvent,
  RunOptions
} from '../../../domain/types.js';
import { truncateText } from '../format.js';
import { emitNotification } from '../protocol.js';
import type { ProgressToken, RequestId } from '../protocol.js';
import { OUTPUT_FORMATS, PRESET_NAMES } from '../tools.js';
import type { OutputFormat, PresetName } from '../tools.js';
import {
  ToolInputError,
  clearActiveConsilium,
  describeError,
  optionalBoolean,
  optionalEnum,
  optionalPositiveNumber,
  optionalString,
  optionalStringArray,
  requireNonEmptyString,
  setActiveConsilium,
  toolError
} from './shared.js';
import type { McpToolResult } from './shared.js';

function formatConsiliumResult(result: ConsiliumResult): string {
  const sections: string[] = [result.text, '---', '## Мнения экспертов'];

  for (const expert of result.experts) {
    sections.push(`### ${expert.agent} (${expert.model ?? 'default'})`);
    sections.push(truncateText(expert.text, 4000));
  }

  sections.push('---');
  const summary = {
    success: result.success,
    totalTime: result.totalTime,
    parallelTime: result.parallelTime,
    usage: result.usage,
    cost: result.metadata?.cost,
    consensus:
      result.metadata?.consensus !== null && typeof result.metadata?.consensus === 'object'
        ? (() => {
            const report = result.metadata.consensus as {
              agreement?: unknown;
              averageSimilarity?: unknown;
            };
            return {
              agreement: report.agreement,
              averageSimilarity: report.averageSimilarity
            };
          })()
        : undefined,
    experts: result.experts.map((expert) => ({
      agent: expert.agent,
      model: expert.model,
      success: expert.success,
      duration: expert.duration,
      errorCode: expert.errorCode,
      usage: expert.usage
    }))
  };
  sections.push('```json');
  sections.push(JSON.stringify(summary, null, 2));
  sections.push('```');

  const savedFile = result.metadata?.savedFile;
  const saveError = result.metadata?.saveError;
  if (typeof savedFile === 'string') {
    sections.push(`**Saved to:** \`${savedFile}\``);
  } else if (typeof saveError === 'string') {
    sections.push(`**Save failed:** ${saveError}`);
  }

  const artifacts = result.metadata?.artifacts;
  if (artifacts !== null && typeof artifacts === 'object' && !Array.isArray(artifacts)) {
    const dir = (artifacts as { dir?: unknown }).dir;
    if (typeof dir === 'string') {
      sections.push(`**Artifacts:** \`${dir}\``);
    }
  }

  return sections.join('\n\n');
}

function resolveOutputFile(
  outputFile: string | undefined,
  workspace: string
): { value?: string; error?: string } {
  if (outputFile === undefined || outputFile.trim().length === 0) {
    return {};
  }
  try {
    const resolved = resolveInside(workspace, outputFile, 'output_file');
    if (resolved === workspace) {
      return { error: '"output_file" must stay inside the workspace' };
    }
    return { value: resolved };
  } catch {
    // Не показываем абсолютные пути за пределами workspace.
    return { error: '"output_file" must stay inside the workspace' };
  }
}

function applyPresetFor(config: ConsiliumConfig, name: PresetName): ConsiliumConfig {
  return applyPreset(config, name as Parameters<typeof applyPreset>[1]);
}

/**
 * Считает фактический размер совета для прогресса: явные эксперты, disabled
 * и smart-выбор уже применены. Возвращает число экспертов + председатель.
 */
export function computeProgressTotal(
  config: ConsiliumConfig,
  requestedExperts: string[] | undefined,
  task: string
): number {
  try {
    const selected = selectExperts(config, requestedExperts, undefined);
    const council =
      config.smartExperts === true
        ? selectSmartExperts(selected, task, { onLog: () => {} }).experts
        : selected;
    return Math.max(1, council.length) + 1;
  } catch {
    const enabled = config.experts.filter((expert) => expert.enabled !== false).length;
    return Math.max(1, enabled) + 1;
  }
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
  const outputFile = optionalString(args, 'output_file');
  const format: OutputFormat | undefined = optionalEnum(args, 'format', OUTPUT_FORMATS);
  const preset: PresetName | undefined = optionalEnum(args, 'preset', PRESET_NAMES);
  const consensus = optionalBoolean(args, 'consensus');
  const smartExperts = optionalBoolean(args, 'smart_experts');
  const maxCostRaw = args['max_cost'];
  if (
    maxCostRaw !== undefined &&
    (typeof maxCostRaw !== 'number' || !Number.isFinite(maxCostRaw) || maxCostRaw < 0)
  ) {
    throw new ToolInputError('"max_cost" must be a number >= 0');
  }
  const maxCost = maxCostRaw as number | undefined;
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

  const outputPath = resolveOutputFile(outputFile, workspace);
  if (outputPath.error !== undefined) {
    return toolError(outputPath.error);
  }

  const loaded = loadConfig();
  let config = loaded.config;
  if (preset !== undefined) {
    config = applyPresetFor(config, preset);
  }
  if (format !== undefined) {
    config.output.format = format;
  }
  if (consensus !== undefined) config.consensus = consensus;
  if (smartExperts !== undefined) config.smartExperts = smartExperts;
  if (maxCost !== undefined) config.maxCost = maxCost;
  if (fallbackModels !== undefined) config.fallbackModels = fallbackModels;
  if (session !== undefined) config.session = session;
  if (artifacts !== undefined) config.artifacts = artifacts;
  if (outputPath.value !== undefined) {
    config.output.file = outputPath.value;
  }

  const runOptions: RunOptions = {};
  if (experts !== undefined) runOptions.experts = experts;
  if (chair !== undefined) runOptions.chair = chair;
  if (timeoutMs !== undefined) runOptions.timeout = timeoutMs;
  if (outputPath.value !== undefined) runOptions.outputFile = outputPath.value;

  const total = computeProgressTotal(config, experts, task);

  const consilium = new Consilium(config);
  let unsubscribe: (() => void) | undefined;
  let startedExperts = 0;

  if (progressToken !== undefined) {
    unsubscribe = consilium.onProgress((event: ProgressEvent) => {
      let progress: number;
      let message: string;
      if (event.type === 'expert_start') {
        startedExperts += 1;
        progress = Math.min(startedExperts, total - 1);
        message = `Expert ${event.agent ?? ''} started`.trim();
      } else if (event.type === 'chair_start') {
        progress = Math.max(1, total - 1);
        message = 'Chair is synthesizing the final answer';
      } else if (event.type === 'chair_end') {
        progress = total;
        message = 'Consilium completed';
      } else {
        return;
      }
      emitNotification({
        jsonrpc: '2.0',
        method: 'notifications/progress',
        params: {
          progressToken,
          progress,
          total,
          message
        }
      });
    });
  }

  setActiveConsilium(consilium, requestId);
  try {
    const result = await consilium.run(task, runOptions);
    let text = formatConsiliumResult(result);
    if (loaded.warnings.length > 0) {
      text += `\n\n---\n\n**Config warnings**\n${loaded.warnings.map(w => `- ${w}`).join('\n')}`;
    }
    return {
      content: [{ type: 'text', text }],
      isError: result.success === false
    };
  } catch (error) {
    return toolError(`Consilium run failed: ${describeError(error)}`);
  } finally {
    if (unsubscribe !== undefined) unsubscribe();
    clearActiveConsilium(consilium);
  }
}
