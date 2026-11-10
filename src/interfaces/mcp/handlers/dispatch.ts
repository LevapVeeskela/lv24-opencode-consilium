// JSON-RPC dispatch and tool routing for the MCP server.
import { describeError } from '../format.js';
import {
  DEFAULT_VERSION,
  FALLBACK_PROTOCOL_VERSION,
  SERVER_NAME,
  SUPPORTED_PROTOCOL_VERSIONS,
  extractProgressToken,
  jsonRpcError,
  jsonRpcSuccess,
  normalizeRequestId
} from '../protocol.js';
import type {
  InitializeResult,
  ProgressToken,
  RequestId
} from '../protocol.js';
import { MCP_TOOL_NAMES, getMcpTools } from '../tools.js';
import { isRecord } from '../validation.js';
import { toolListAgents } from './agents.js';
import { toolDiffRuns, toolGetRun, toolListRuns, toolSarif } from './artifacts.js';
import { toolDoctor } from './doctor.js';
import { toolInitFree } from './init-free.js';
import { toolFreeModels } from './models.js';
import { toolConsiliumReplay } from './replay.js';
import { toolConsiliumRun } from './run.js';
import { toolError } from './shared.js';
import type { McpToolResult } from './shared.js';

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  progressToken: ProgressToken | undefined,
  requestId?: RequestId
): Promise<McpToolResult> {
  try {
    switch (name) {
      case 'consilium_run':
        return await toolConsiliumRun(args, progressToken, requestId);
      case 'consilium_replay':
        return await toolConsiliumReplay(args, progressToken, requestId);
      case 'consilium_list_agents':
        return await toolListAgents();
      case 'consilium_free_models':
        return await toolFreeModels(args);
      case 'consilium_doctor':
        return await toolDoctor();
      case 'consilium_init_free':
        return await toolInitFree(args);
      case 'consilium_list_runs':
        return await toolListRuns(args);
      case 'consilium_get_run':
        return await toolGetRun(args);
      case 'consilium_sarif':
        return await toolSarif(args);
      case 'consilium_diff_runs':
        return await toolDiffRuns(args);
      default:
        return toolError(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return toolError(describeError(error));
  }
}

function buildInitializeResult(
  params: Record<string, unknown> | undefined,
  version: string
): InitializeResult {
  const requested =
    params !== undefined && typeof params['protocolVersion'] === 'string'
      ? params['protocolVersion']
      : '';
  const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
    ? requested
    : FALLBACK_PROTOCOL_VERSION;

  return {
    protocolVersion,
    capabilities: {
      tools: { listChanged: false },
      logging: {}
    },
    serverInfo: { name: SERVER_NAME, version },
    instructions:
      'lv24-opencode-consilium runs a council of expert AI agents through the OpenCode CLI. Use consilium_run to ask the council a task, consilium_replay to re-run a saved run with its task, models and replayable options, consilium_list_agents to inspect configured experts, consilium_free_models to discover free models, consilium_doctor to diagnose setup issues, and consilium_init_free to propose or apply a free-model configuration. Saved runs are read-only: consilium_list_runs, consilium_get_run, consilium_sarif and consilium_diff_runs inspect them without calling a model. Long runs stream notifications/progress when the request supplies _meta.progressToken; no partial result chunks are returned.'
  };
}

async function dispatchMcpMethod(
  method: string,
  params: Record<string, unknown> | undefined,
  id: RequestId,
  hasId: boolean,
  ctx: { version?: string }
): Promise<object | null> {
  const respond = (result: unknown): object | null =>
    hasId ? jsonRpcSuccess(id, result) : null;

  switch (method) {
    case 'initialize':
      return respond(buildInitializeResult(params, ctx.version ?? DEFAULT_VERSION));

    case 'notifications/initialized':
      return hasId ? jsonRpcSuccess(id, {}) : null;

    case 'ping':
      return respond({});

    case 'tools/list':
      return respond({ tools: getMcpTools() });

    case 'tools/call': {
      if (params === undefined) {
        return hasId ? jsonRpcError(id, -32602, 'Invalid params: expected an object') : null;
      }

      const name = params['name'];
      if (typeof name !== 'string' || !MCP_TOOL_NAMES.has(name)) {
        return hasId
          ? jsonRpcError(
              id,
              -32602,
              `Unknown tool: ${typeof name === 'string' ? name : '(missing)'}`
            )
          : null;
      }

      const rawArguments = params['arguments'];
      if (rawArguments !== undefined && !isRecord(rawArguments)) {
        return hasId
          ? jsonRpcError(id, -32602, 'Invalid params: "arguments" must be an object')
          : null;
      }

      const args = isRecord(rawArguments) ? rawArguments : {};
      const result = await executeTool(name, args, extractProgressToken(params), id);
      return respond(result);
    }

    case 'resources/list':
      return respond({ resources: [] });

    case 'prompts/list':
      return respond({ prompts: [] });

    case 'logging/setLevel':
      return respond({});

    default:
      return hasId ? jsonRpcError(id, -32601, `Method not found: ${method}`) : null;
  }
}

export async function handleMcpRequest(
  request: unknown,
  ctx: { version?: string } = {}
): Promise<object | null> {
  if (!isRecord(request)) {
    return jsonRpcError(null, -32600, 'Invalid Request');
  }

  const hasId = Object.prototype.hasOwnProperty.call(request, 'id');
  const id = normalizeRequestId(request['id']);
  const method = request['method'];

  if (typeof method !== 'string') {
    return jsonRpcError(id, -32600, 'Invalid Request: method must be a string');
  }

  const rawParams = request['params'];
  const params = isRecord(rawParams) ? rawParams : undefined;

  try {
    return await dispatchMcpMethod(method, params, id, hasId, ctx);
  } catch (error) {
    if (!hasId) return null;
    return jsonRpcError(id, -32603, 'Internal error', describeError(error));
  }
}
