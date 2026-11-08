// consilium_free_models tool handler.
import { fetchFreeModels } from '../../../infrastructure/models/sources.js';
import type { FreeModel } from '../../../domain/models/models.js';
import { cell, formatTimestamp } from '../format.js';
import { safeJson } from '../protocol.js';
import { optionalBoolean, optionalInteger, toolText } from './shared.js';
import type { McpToolResult } from './shared.js';

const MODEL_ID_KEYS = ['id', 'model', 'modelId', 'model_id', 'name', 'slug'] as const;
const MODEL_CONTEXT_KEYS = [
  'contextLength',
  'context_length',
  'contextWindow',
  'context_window',
  'context',
  'maxContext',
  'max_context',
  'limit'
] as const;
const MODEL_TOOLS_KEYS = [
  'supportsTools',
  'supports_tools',
  'tools',
  'toolCall',
  'tool_call',
  'functionCalling',
  'function_calling'
] as const;
const MODEL_REASONING_KEYS = [
  'reasoning',
  'supportsReasoning',
  'supports_reasoning',
  'thinking'
] as const;
const MODEL_SCORE_KEYS = [
  'score',
  'quality',
  'rank',
  'rating',
  'benchmarkScore',
  'benchmark_score'
] as const;
const MODEL_AVAILABLE_KEYS = [
  'available',
  'isAvailable',
  'is_available',
  'hasKey',
  'has_key'
] as const;
const MODEL_SOURCE_KEYS = ['source', 'provider', 'origin'] as const;

function readModelValue(model: FreeModel, keys: readonly string[]): unknown {
  const record = model as unknown as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function displayValue(value: unknown): string {
  if (value === undefined || value === null) return '?';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return safeJson(value);
}

function flagValue(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', 'yes', '1', 'available', 'supported'].includes(normalized)) return true;
    if (['false', 'no', '0', 'unavailable', 'unsupported'].includes(normalized)) return false;
  }
  return undefined;
}

function readModelFlag(model: FreeModel, keys: readonly string[]): boolean | undefined {
  return flagValue(readModelValue(model, keys));
}

function renderFlag(model: FreeModel, keys: readonly string[]): string {
  const flag = readModelFlag(model, keys);
  if (flag === undefined) return '?';
  return flag ? 'yes' : 'no';
}

function renderContext(model: FreeModel): string {
  const value = readModelValue(model, MODEL_CONTEXT_KEYS);
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return displayValue(value);
}

export async function toolFreeModels(args: Record<string, unknown>): Promise<McpToolResult> {
  const limit = optionalInteger(args, 'limit', 1, 50) ?? 15;
  const availableOnly = optionalBoolean(args, 'available_only') ?? false;
  const refresh = optionalBoolean(args, 'refresh') ?? false;

  const fetched = await fetchFreeModels({
    forceRefresh: refresh,
    includeUnavailable: !availableOnly
  });
  const filtered = availableOnly
    ? fetched.models.filter((model) => readModelFlag(model, MODEL_AVAILABLE_KEYS) === true)
    : fetched.models;
  const visible = filtered.slice(0, limit);

  const lines: string[] = [];
  lines.push('## Free OpenCode models');
  lines.push('');
  lines.push(
    `Cache: ${fetched.fromCache ? 'hit' : 'miss'}; fetched at ${formatTimestamp(
      fetched.fetchedAt
    )}`
  );
  lines.push('');
  lines.push('### Sources');
  if (fetched.sources.length === 0) {
    lines.push('- (no sources reported)');
  } else {
    for (const source of fetched.sources) {
      const status = source.ok
        ? `ok (${source.count} models)`
        : `failed${source.error !== undefined ? ` — ${source.error}` : ''}`;
      lines.push(`- ${source.source}: ${status}`);
    }
  }
  lines.push('');
  lines.push(`### Models (${visible.length} of ${filtered.length})`);
  lines.push('');
  if (visible.length === 0) {
    lines.push('No models matched the request.');
  } else {
    lines.push('| rank | model id | ctx | tools | reasoning | score | available | source |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
    visible.forEach((model, index) => {
      const id = displayValue(readModelValue(model, MODEL_ID_KEYS));
      const score = displayValue(readModelValue(model, MODEL_SCORE_KEYS));
      const source = displayValue(readModelValue(model, MODEL_SOURCE_KEYS));
      lines.push(
        `| ${index + 1} | ${cell(id)} | ${cell(renderContext(model))} | ${cell(
          renderFlag(model, MODEL_TOOLS_KEYS)
        )} | ${cell(renderFlag(model, MODEL_REASONING_KEYS))} | ${cell(score)} | ${cell(
          renderFlag(model, MODEL_AVAILABLE_KEYS)
        )} | ${cell(source)} |`
      );
    });
  }
  return toolText(lines.join('\n'));
}
