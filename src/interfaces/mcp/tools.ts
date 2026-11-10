export const OUTPUT_FORMATS = ['text', 'markdown', 'json'] as const;
export const PRESET_NAMES = ['fast', 'deep', 'security', 'review', 'free'] as const;

export type OutputFormat = (typeof OUTPUT_FORMATS)[number];
export type PresetName = (typeof PRESET_NAMES)[number];

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
  };
}

export const MCP_TOOLS: McpToolDef[] = [
  {
    name: 'consilium_run',
    description:
      'Run a council of expert AI agents through the OpenCode CLI. Experts analyze the task in parallel and the chair synthesizes the final answer.',
    inputSchema: {
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
        deadline_ms: {
          type: 'integer',
          minimum: 1,
          description: 'Overall wall-clock deadline for the expert phase in milliseconds.'
        },
        local_only: {
          type: 'boolean',
          description: 'Allow only local model providers (Ollama, LM Studio, vLLM, llama.cpp, ...).'
        },
        read_only: {
          type: 'boolean',
          default: false,
          description:
            'Run experts and the chair read-only: only read/glob/grep are allowed; write, edit, shell, webfetch, subagent, skill, question and MCP tools are denied; .env files stay blocked.'
        },
        isolate: {
          type: 'boolean',
          default: false,
          description:
            'Run each agent in its own disposable OpenCode worktree (--worktree). Read-only rules apply to the main project; worktree changes never reach it.'
        },
        output_file: {
          type: 'string',
          description: 'Optional path for saving the result (must stay inside the workspace).'
        },
        format: {
          type: 'string',
          enum: [...OUTPUT_FORMATS],
          description: 'Format used when the result is saved.'
        },
        preset: {
          type: 'string',
          description:
            'Configuration preset applied before the run: a built-in name (fast, deep, security, review, free) or a custom preset from consilium.config.json.'
        },
        consensus: {
          type: 'boolean',
          description: 'Include expert agreement analysis in the chair prompt and the report.'
        },
        findings: {
          type: 'boolean',
          description:
            'Collect structured findings (severity, category, file, line, claim, evidence, confidence) into metadata.findings.'
        },
        smart_experts: {
          type: 'boolean',
          description: 'Pick 2-3 relevant experts for the task instead of running all enabled experts.'
        },
        rounds: {
          type: 'integer',
          enum: [1, 2],
          minimum: 1,
          maximum: 2,
          description:
            'Debate rounds: 1 (default, single expert round) or 2 (anonymous peer review before the chair).'
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
        }
      },
      required: ['task']
    }
  },
  {
    name: 'consilium_list_agents',
    description:
      'List configured consilium experts, the chair agent, the active config path and available presets.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'consilium_free_models',
    description:
      'List free OpenCode models discovered from provider catalogs with context length, tool support, reasoning, score and availability.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 50,
          default: 15,
          description: 'Maximum number of models to show.'
        },
        available_only: {
          type: 'boolean',
          default: false,
          description: 'Show only models marked as available.'
        },
        refresh: {
          type: 'boolean',
          default: false,
          description: 'Ignore the cache and refresh the model catalog.'
        },
        local_only: {
          type: 'boolean',
          default: false,
          description: 'Show only models from local providers (Ollama, LM Studio, vLLM, llama.cpp, ...).'
        },
        probe_local: {
          type: 'boolean',
          default: false,
          description: 'Probe local Ollama and LM Studio endpoints (2s timeout) and include their status.'
        },
        format: {
          type: 'string',
          enum: ['text', 'json'],
          default: 'text',
          description: 'Response format: a text table or a JSON payload.'
        }
      },
      required: []
    }
  },
  {
    name: 'consilium_doctor',
    description: 'Run environment and configuration diagnostics for lv24-opencode-consilium.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'consilium_init_free',
    description:
      'Propose (dry run) or apply a free-model council setup. Apply merges agents into opencode.json and writes consilium.config.json.',
    inputSchema: {
      type: 'object',
      properties: {
        apply: {
          type: 'boolean',
          default: false,
          description: 'Write the proposal to opencode.json and consilium.config.json.'
        },
        force: {
          type: 'boolean',
          default: false,
          description: 'Overwrite existing agent models and consilium.config.json.'
        },
        confirm: {
          type: 'boolean',
          default: false,
          description: 'Required together with "force": true to confirm overwriting existing files.'
        },
        verify: {
          type: 'boolean',
          default: false,
          description: 'Probe candidate models with a tiny real request before selecting.'
        }
      },
      required: []
    }
  }
];

export const MCP_TOOL_NAMES = new Set(MCP_TOOLS.map((tool) => tool.name));

export function getMcpTools(): McpToolDef[] {
  return MCP_TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: {
      type: tool.inputSchema.type,
      properties: { ...tool.inputSchema.properties },
      required: [...tool.inputSchema.required]
    }
  }));
}
