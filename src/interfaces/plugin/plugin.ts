/**
 * @fileoverview Native OpenCode V2 plugin entrypoint: registers the
 * `consilium run` tool via `ctx.tool.transform`.
 * @module lv24-opencode-consilium/plugin
 */

import { isRecord } from '../../shared/record.js';
import type { ConsiliumConfig } from '../../domain/types.js';
import { runConsiliumTool, type ToolRunArgs } from './tool-run.js';

export const TOOL_NAMESPACE = 'consilium';
export const TOOL_NAME = 'run';

const TOOL_DESCRIPTION =
  'Run a council of expert AI agents through the OpenCode CLI. ' +
  'Experts analyze the task in parallel and the chair synthesizes the final answer.';

const PRESET_VALUES = ['fast', 'deep', 'security', 'review', 'free'] as const;

/**
 * JSON Schema for the `consilium run` tool input. Kept as a plain object
 * (no Effect Schema needed — the tool API accepts JsonSchema).
 */
export const CONSILIUM_TOOL_INPUT: Record<string, unknown> = {
  type: 'object',
  properties: {
    task: {
      type: 'string',
      minLength: 1,
      description: 'Task for the expert council.'
    },
    experts: {
      type: 'array',
      items: { type: 'string' },
      description: 'Expert agent names to use (default: all enabled experts).'
    },
    chair: {
      type: 'string',
      description: 'Chair agent name (default: from configuration).'
    },
    timeout_ms: {
      type: 'number',
      exclusiveMinimum: 0,
      description: 'Timeout per expert in milliseconds.'
    },
    consensus: {
      type: 'boolean',
      description: 'Include expert agreement analysis in the chair prompt and the report.'
    },
    smart_experts: {
      type: 'boolean',
      description: 'Pick 2-3 relevant experts for the task instead of running all enabled experts.'
    },
    max_cost: {
      type: 'number',
      minimum: 0,
      description: 'Maximum run cost in USD. When exceeded, the chair is not started.'
    },
    fallback_models: {
      type: 'array',
      items: { type: 'string' },
      description: 'Models tried in order when an expert hits RATE_LIMITED or MODEL_UNAVAILABLE.'
    },
    session: {
      type: 'string',
      description: 'OpenCode session base id; each agent continues its own session.'
    },
    artifacts: {
      type: ['boolean', 'string'],
      description: 'Save the run to .consilium/runs (true) or to the given directory.'
    },
    preset: {
      type: 'string',
      enum: [...PRESET_VALUES],
      description: 'Configuration preset applied before the run.'
    }
  },
  required: ['task']
};

/**
 * Structural subset of the real plugin context, narrow enough for fakes in tests.
 */
export interface PluginContextLike {
  tool: { transform(cb: (editor: ToolEditorLike) => void): Promise<unknown> };
  /** Активный проект OpenCode V2 */
  location?: { directory?: string };
}

/**
 * Structural plugin contract: enough for the OpenCode V2 host and for fakes.
 * Kept local so the published .d.ts has no dependency on `@opencode/plugin`.
 */
export interface ConsiliumPluginDefinition {
  id: string;
  setup: (ctx: PluginContextLike) => unknown;
}

/**
 * Structural subset of the real tool editor.
 */
export interface ToolEditorLike {
  namespace?(value: { name: string; description: string }): void;
  add(tool: {
    name: string;
    description: string;
    input: Record<string, unknown>;
    execute: (
      input: unknown,
      context: { signal?: AbortSignal }
    ) => Promise<{
      content: Array<{ type: 'text'; text: string }>;
      metadata?: Record<string, unknown>;
    }>;
    options?: Record<string, unknown>;
  }): void;
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new Error(`"${key}" must be a string`);
  }
  return value;
}

function requireNonEmptyString(args: Record<string, unknown>, key: string): string {
  const value = optionalString(args, key);
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`"${key}" is required and must be a non-empty string`);
  }
  return value;
}

function optionalStringArray(
  args: Record<string, unknown>,
  key: string
): string[] | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`"${key}" must be an array of strings`);
  }
  const items: string[] = [];
  for (const item of value as unknown[]) {
    if (typeof item !== 'string') {
      throw new Error(`"${key}" must be an array of strings`);
    }
    items.push(item);
  }
  return items;
}

function optionalPositiveNumber(
  args: Record<string, unknown>,
  key: string
): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`"${key}" must be a positive number`);
  }
  return value;
}

function optionalNonNegativeNumber(
  args: Record<string, unknown>,
  key: string
): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`"${key}" must be a number >= 0`);
  }
  return value;
}

function optionalBoolean(
  args: Record<string, unknown>,
  key: string
): boolean | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') {
    throw new Error(`"${key}" must be a boolean`);
  }
  return value;
}

function optionalPreset(args: Record<string, unknown>, key: string): string | undefined {
  const value = optionalString(args, key);
  if (value === undefined) return undefined;
  if (!(PRESET_VALUES as readonly string[]).includes(value)) {
    throw new Error(`"${key}" must be one of: ${PRESET_VALUES.join(', ')}`);
  }
  return value;
}

function optionalArtifacts(
  args: Record<string, unknown>,
  key: string
): boolean | string | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'boolean' || typeof value === 'string') return value;
  throw new Error(`"${key}" must be a boolean or a string path`);
}

/**
 * Validates raw tool input into typed {@link ToolRunArgs}.
 * Throws a plain Error on bad types (never `any`).
 */
function parseToolArgs(input: unknown): ToolRunArgs {
  if (!isRecord(input)) {
    throw new Error('Tool input must be an object');
  }
  return {
    task: requireNonEmptyString(input, 'task'),
    experts: optionalStringArray(input, 'experts'),
    chair: optionalString(input, 'chair'),
    timeoutMs: optionalPositiveNumber(input, 'timeout_ms'),
    consensus: optionalBoolean(input, 'consensus'),
    smartExperts: optionalBoolean(input, 'smart_experts'),
    maxCost: optionalNonNegativeNumber(input, 'max_cost'),
    fallbackModels: optionalStringArray(input, 'fallback_models'),
    session: optionalString(input, 'session'),
    artifacts: optionalArtifacts(input, 'artifacts'),
    preset: optionalPreset(input, 'preset')
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Registers the `consilium run` native tool on the given plugin context.
 * An optional base config is reused (cloned) for every run; when omitted,
 * each run loads the config via `loadConfig()`.
 */
export async function registerConsilium(
  ctx: PluginContextLike,
  config?: ConsiliumConfig
): Promise<void> {
  const workspace = ctx.location?.directory;
  await ctx.tool.transform(editor => {
    editor.namespace?.({
      name: TOOL_NAMESPACE,
      description: 'Council of expert AI agents (Consilium)'
    });
    editor.add({
      name: TOOL_NAME,
      description: TOOL_DESCRIPTION,
      input: CONSILIUM_TOOL_INPUT,
      options: { codemode: false },
      execute: async (input, context) => {
        const args = parseToolArgs(input);
        const run = await runConsiliumTool(args, config, {
          signal: context.signal,
          workspace
        });
        if (run.isError) {
          // В Tool.Result нет isError: ошибка должна быть Tool.Error/исключением.
          throw new Error(`Consilium run failed: ${run.text.slice(0, 1000)}`);
        }
        const metadata = run.metadata ?? {};
        return {
          content: [{ type: 'text' as const, text: run.text }],
          metadata: {
            consilium: {
              success: true,
              cost: metadata['cost'],
              consensus: metadata['consensus']
            }
          }
        };
      }
    });
  });
}

const plugin: ConsiliumPluginDefinition = {
  id: 'consilium',
  setup: ctx => registerConsilium(ctx)
};

export default plugin;
