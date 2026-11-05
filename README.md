# opencode-consilium

A council of AI experts for [OpenCode](https://opencode.ai): several agent personas answer your task **in parallel on different models**, then a chair model synthesizes a final plan. Ships with a zero-config free-model bootstrap, a CLI, a library API, and an **MCP server** that works in any harness (Claude Desktop, Codex, Cursor, VS Code, custom agents).

```
consilium "Review the authentication design"
  arch  → glm-5.3-flash-free
  ux    → mimo-v2.6-flash-free
  ba    → flint-40b-free
  sec   → nemotron-3.5-lightning-free
  chair → deepseek-v4.1-flash-free   ← synthesis
```

## Why

- **Different models = different blind spots.** One model often misses what another catches; the chair resolves disagreements.
- **Zero cost by default.** Discovers free, tool-capable models from public catalogs, ranks them, verifies they actually work in your region, and wires them into your config.
- **Works with what you already have.** Uses the OpenCode CLI (agents, auth, providers), not a parallel provider stack.
- **Works inside any harness.** The same engine is exposed as an MCP server over stdio.

## Features

- Parallel experts with per-expert `agent` and `model` routing, bounded concurrency.
- Chair synthesis with configurable prompt template and per-expert text limits.
- Dynamic free-model discovery: `models.dev` + OpenRouter + curated offline fallback; cached 12 h.
- Quality ranking heuristic (context, tools, structured output, reasoning, recency, family prior, shadow price of the paid sibling).
- Optional real verification: each candidate gets a tiny probe request, region-blocked/unavailable models are dropped.
- Robust runner: prompt via stdin (no shell injection, no Windows 8 KB limit), `--standalone` isolation, retries with backoff, timeouts, cancellation, usage/cost accounting.
- `doctor` preflight, presets, git-diff review mode, clean JSON output.
- MCP tools: run the council, list agents, list free models, diagnose, bootstrap free models.
- TypeScript strict, zero runtime dependencies, Node >= 18.

## Requirements

- Node.js **>= 18**
- [OpenCode CLI](https://opencode.ai) installed and authenticated (`npm install -g opencode-ai`)
- Optional: `OPENROUTER_API_KEY` to use OpenRouter's free models

## Install

```bash
npm install -g opencode-consilium
# or run without installing:
npx -y opencode-consilium --help
```

## Quick start

```bash
# 1. Check the environment (CLI, config, agents, models)
consilium doctor

# 2. Pick the strongest working free models and write the config
consilium init --free

# 3. Run the council
consilium "Design a rate limiter for a public API"
```

`init --free`:

1. downloads `https://models.dev/api.json` and `https://openrouter.ai/api/v1/models`;
2. keeps only free (`cost = 0`), active, chat models with tool calling and >= 32K context;
3. ranks them and probes the top candidates with a tiny request (unless `--no-verify`);
4. writes the winning models into `opencode.json` (agents `arch`, `ux`, `ba`, `sec`, `consilium`) and `consilium.config.json`;
5. never overwrites your existing agent models unless you pass `--force`.

Preview without writes:

```bash
consilium init --free --dry-run
```

## Free models

```bash
consilium models                 # top 20 ranked models
consilium models --available     # only providers you can use
consilium models --verify        # probe the shown models with a real request
consilium models --refresh       # ignore the 12 h cache
consilium models --json          # machine-readable
```

Sources and fallbacks:

| Source | What it gives |
| --- | --- |
| `https://models.dev/api.json` | Full catalog, cost/limits/capabilities, canonical links to paid siblings |
| `https://openrouter.ai/api/v1/models` | `:free` variants, context, `tools` support, expiry |
| Built-in curated list | Known-good OpenCode free models if a catalog rotates them out |

Cache: `%TEMP%/opencode-consilium/models-cache.json` (or `CONSILIUM_MODELS_CACHE`), TTL 12 h.

Ranking (0–1.3) is transparent and deterministic: context window 30%, tool calling 20%, structured output 10%, reasoning 10%, recency 10%, output limit 10%, family prior 10%, paid-sibling “shadow price” 15%; alpha/preview/stealth penalties.

## MCP server (any harness)

Start it over stdio:

```bash
consilium mcp
# or directly:
consilium-mcp
```

Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "consilium": {
      "command": "npx",
      "args": ["-y", "opencode-consilium", "mcp"]
    }
  }
}
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.consilium]
command = "npx"
args = ["-y", "opencode-consilium", "mcp"]
```

Any MCP client that supports stdio JSON-RPC 2.0 works. Logs go to **stderr**; stdout carries only the protocol.

### MCP tools

| Tool | Arguments | Result |
| --- | --- | --- |
| `consilium_run` | `task` (required), `experts`, `chair`, `timeout_ms`, `format`, `preset`, `output_file` | Chair synthesis + expert opinions + JSON metadata (time, usage, models) |
| `consilium_list_agents` | — | Configured experts, models, chair, presets, config path |
| `consilium_free_models` | `limit`, `available_only`, `refresh` | Ranked free models table |
| `consilium_doctor` | — | Environment/config diagnostics |
| `consilium_init_free` | `apply`, `force`, `verify` | Proposal (default) or writes `opencode.json` + `consilium.config.json` |

MCP `consilium_init_free` is dry-run by default; pass `"apply": true` to write files. `consilium_run` reports live progress when the client sends a `progressToken`.

## CLI reference

```
consilium [options] <task>
consilium <task> -                 # read the task from stdin
consilium init [--free] [--dry-run] [--force] [--no-verify]
consilium models [--available] [--verify] [--limit N] [--refresh] [--json]
consilium doctor
consilium mcp
```

Flags:

| Flag | Meaning |
| --- | --- |
| `-c, --config <file>` | Config file (otherwise auto-discovers) |
| `-e, --experts a,b` | Subset of experts |
| `--chair <agent>` | Chair agent name |
| `--preset <name>` | `fast`, `deep`, `security`, `review`, `free` |
| `--expert-timeout`, `--chair-timeout` | Timeouts in ms (per attempt) |
| `-r, --retries <n>` | Retry count (0 = single attempt) |
| `-o, --output <file>` | Save the result (text/markdown/json by `-f`) |
| `--no-save` | Never write a file |
| `-f, --format <fmt>` | `text` (stdout), `markdown`, `json` (pure JSON on stdout) |
| `--diff [--staged] [--base <ref>]` | Append the current git diff to the task |
| `--task-file <file>` | Read the task from a file (`-` = stdin) |
| `--verify` / `--no-verify` | Probe models before selecting (`models` / `init --free`) |
| `-s, --silent` | Only the final result |
| `-V, --verbose` | Raw progress events |
| `-v, --version`, `-h, --help` | Version / help |

Exit codes: `0` success, `1` run failed, `2` usage error.

Examples:

```bash
consilium -e arch,sec "Threat-model the file upload endpoint"
consilium --preset deep "Design the migration plan"
git diff --staged | consilium - --diff "Review these changes"
consilium -f json "..." > council.json
```

## Presets

| Preset | Experts | Behaviour |
| --- | --- | --- |
| `fast` | arch, sec | 3 min expert timeout, no retries |
| `deep` | all four | doubled timeouts, retries enabled |
| `security` | sec, arch, ba | security-focused review |
| `review` | arch, sec, ux | code review |
| `free` | all four | for a free-model bootstrap |

## Configuration

Config is discovered in this order (cwd): `consilium.config.json`, `consilium.json`, `.consiliumrc`, `.consiliumrc.json`. Use `-c` for an explicit path. JSONC comments are allowed in `opencode.json`/`opencode.jsonc`.

Minimal example:

```json
{
  "experts": [
    { "name": "arch", "model": "opencode/glm-5.3-flash-free" },
    { "name": "sec",  "model": "opencode/nemotron-3.5-lightning-free" }
  ],
  "chair": {
    "agent": "consilium",
    "model": "opencode/deepseek-v4.1-flash-free"
  },
  "retry": { "maxConcurrency": 3 }
}
```

Key options:

| Key | Default | Notes |
| --- | --- | --- |
| `experts[].model` | — | `provider/model`; passed as `--model`, overrides the agent's model |
| `chair.model` | — | Chair model override |
| `timeouts.expert` / `.chair` | 300000 / 600000 | Per attempt, ms |
| `retry.expertRetries` / `.chairRetries` | 1 | `0` = single attempt |
| `retry.maxConcurrency` | 3 | 1–8 parallel agents |
| `output.file` | `false` | `false` disables saving; a string enables it |
| `standalone` | `true` | `--standalone` private server; avoids port conflicts when OpenCode is already running |
| `autoApprove` | `false` | `--auto`; only enable if you trust the agents/tools |
| `autoDiscoverAgents` | `true` | Reuse agents from `opencode.json` |
| `opencodePath` | `opencode` | Custom CLI path |
| `cwd` | current | Working directory for OpenCode |

Full schema: [`schema/config.schema.json`](schema/config.schema.json); example: [`consilium.config.example.json`](consilium.config.example.json).

## Library API

```ts
import { Consilium, runConsilium, fetchFreeModels, selectCouncilModels } from 'opencode-consilium';

const council = new Consilium();
council.onProgress(event => console.error(event.type, event.agent ?? ''));

const result = await council.run('Design a cache invalidation strategy');
console.log(result.text);           // chair synthesis
console.log(result.usage?.cost);    // total cost (0 for free models)

// one-shot
const oneShot = await runConsilium('...'); // returns ConsiliumResult
console.log(oneShot.text);

// discover + pick models
const { models } = await fetchFreeModels({ includeUnavailable: true });
const top = selectCouncilModels(models, 5);
```

`Consilium` instances are reusable: `run()` can be called again after a completed, failed, or cancelled run. `cancel()` stops all child processes of the current run.

## How it works

For every expert and the chair, Consilium spawns:

```
opencode run --standalone --format json [--auto] [--agent NAME] --model provider/model
```

The prompt is written to the child's **stdin** (UTF-8), so arbitrary task text is safe and never hits shell/command-line limits. NDJSON events are decoded incrementally (`text`, `step_finish` usage/cost, `error`). Exit codes, stderr tails, and error events are reported with typed `errorCode`s. If an agent name is missing in your OpenCode config, the call is retried once with the same model and the default agent; the run keeps working even without persona agents.

## Security

- Task text is never interpolated into a shell command; it is passed via stdin.
- Agent names and model IDs are validated before use.
- `--auto` (auto-approve permissions) is **off** by default.
- `--standalone` isolates the child server; no port takeover.
- API keys are never read, printed, or written by Consilium; OpenCode handles auth.
- `doctor` warns about missing keys and risky configuration.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `OpenCode CLI не найден` | `npm install -g opencode-ai` or set `opencodePath` |
| `Model unavailable` | Model rotated out/region-blocked; run `consilium models --verify --refresh` |
| `Agent not found` | Persona agent missing; Consilium falls back to the default agent + your model. Add agents via `consilium init --free` |
| Timeouts | Free models can be slow; raise `--expert-timeout` or use `--preset fast` |
| 429/rate limits | Lower `retry.maxConcurrency` to 1–2 |
| `Managed service port ... in use` | Keep `standalone: true` (default) |
| Empty result | `consilium doctor`, then rerun with `-V` |

## Development

```bash
npm install
npm run build       # tsc
npm test            # build + node:test (52 tests)
npm run typecheck   # tsc --noEmit
```

## License

MIT
