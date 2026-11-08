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
- [OpenCode CLI](https://opencode.ai) installed and authenticated (`npm install -g opencode-ai`), **V1 or V2**
- Optional: `OPENROUTER_API_KEY` to use OpenRouter's free models

## OpenCode V1 and V2 compatibility

The package supports both OpenCode branches and picks the right config shape itself:

| Area | OpenCode V1 | OpenCode V2 |
| --- | --- | --- |
| `opencode.json` agents | `agent` + `prompt` | `agents` + `system` |
| MCP servers | `mcp.<name>` + `enabled` | `mcp.servers.<name>` + `disabled` |
| Commands | `command` + `subtask` | `commands` + `subagent` |
| Agent model on `run --agent` | applied from config | **ignored**, `--model` required |

In practice:

- **V1 shape is the safe default.** Both versions read it, so `consilium init --free` writes it unless you ask otherwise.
- **Native V2 agents** (`agents` + `system`) are written only with `consilium init --free --native-v2` or when the file already uses V2 keys. MCP registration is separate: `consilium mcp --install`.
- **Models are always passed explicitly** via `--model`, so V2 cannot silently fall back to the root model.
- **Agents are read from both sections.** `opencode.json(c)`, `.opencode/opencode.json(c)`, and parent directories are merged in OpenCode's own order (`.opencode` wins).
- **`RATE_LIMITED`** from V2 structured errors retries short limits (up to 30 s) and fails fast with the retry delay for long ones.
- **`doctor` checks compatibility**: CLI major, config flavor, `agent`/`agents` duplicates, V2-ignored fields, flat MCP entries.

One-command MCP registration (shape follows the installed OpenCode version):

```bash
consilium mcp --install            # ./opencode.json
consilium mcp --install --global   # ~/.config/opencode/opencode.json
opencode mcp list                  # verify
```

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

Write native V2 agents (`agents` + `system`):

```bash
consilium init --free --native-v2
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

The `opencode-go` provider is no longer excluded wholesale: its free models (`*-free`, `iceman-contributor-free`, and similar) take part in ranking. Paid models of that provider, such as `opencode-go/muse-spark-1.3-contributor`, are not selected by `--free`; set them manually in `experts[].model` or `chair.model`.

Ranking (0-1.2) is transparent and deterministic: context window 30%, tool calling 20%, structured output 10%, reasoning 10%, recency 10%, output limit 10%, family prior 10%, paid-sibling "shadow price" 15%; alpha/preview/stealth penalties.

## MCP server (any harness)

Start it over stdio:

```bash
consilium mcp
# or directly:
consilium-mcp
```

OpenCode V1/V2 — install into config (shape detected automatically):

```bash
consilium mcp --install            # ./opencode.json → mcp.servers.consilium or mcp.consilium
consilium mcp --install --global   # global OpenCode config
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

`consilium_run` also accepts `consensus`, `smart_experts`, `max_cost`, `fallback_models`, `session`, and `artifacts`. Its response includes `cost` and a consensus summary in the JSON metadata plus an `**Artifacts:**` line with the saved run path.

## CLI reference

```
consilium [options] <task>
consilium <task> -                 # read the task from stdin
consilium init [--free] [--dry-run] [--force] [--no-verify] [--native-v2]
consilium models [--available] [--verify] [--limit N] [--refresh] [--json]
consilium doctor
consilium mcp [--install] [--global]
consilium watch [--debounce <ms>] [task]
consilium hooks install|uninstall
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
| `--consensus` / `--no-consensus` | Lexical expert-agreement analysis (term overlap, Jaccard); compact summary goes into the chair prompt, full report into the result |
| `--smart-experts` | Heuristically pick 2–3 relevant roles from the task/diff (dropped roles are logged) |
| `--max-cost <usd>` | Cost limit in USD; when exceeded before the chair starts, it is skipped (`COST_LIMIT`, partial result with consensus) |
| `--fallback-models a,b` | Fallback models: on `RATE_LIMITED` / `MODEL_UNAVAILABLE` / `EMPTY_RESPONSE` the same expert is retried on the next model (chain capped at 2) |
| `--session <id>` | Base OpenCode session id; each agent gets its own `ses_<base>-<agent>` (parallel agents never share a session) |
| `--artifacts` / `--no-artifacts` | Save / don't save run artifacts (off by default) |
| `--artifacts-dir <path>` | Save artifacts to a custom directory (instead of `.consilium/runs/<id>/`) |
| `--replay <id>` | Rerun a saved run (restores the chair agent/model, expert models, and the artifact's consensus/smartExperts/fallbackModels/session flags) |
| `--report <format>` | Report after the run: `html`, `pr`, `markdown` (`markdown` = PR variant) |
| `--report-file <file>` | Write the report to a file (`.html` → html, `.md` → pr; without a file prints to stdout, except with `-f json`) |
| `--variant <name>` | Model variant for all agents (`provider/model` → `provider/model#variant`); invalid variant exits 2 |
| `--debounce <ms>` | Watch-mode debounce delay (default 400) |
| `watch [--debounce <ms>] [task]` | Watch the project and rerun the council on changes (until Ctrl+C) |
| `hooks install\|uninstall` | Install/remove a git pre-commit hook (staged review before commit) |
| `--diff-runs <a> <b>` | Print a markdown comparison of two saved runs |
| `--native-v2` | Write native V2 config (`agents`/`system`) |
| `--install`, `--global` | Register the MCP server in the project or global config |
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
consilium --smart-experts --consensus "Design the subscriptions DB schema"
consilium --artifacts --max-cost 0.5 "Design the migration plan"
consilium --replay 2026-11-08-abc123
consilium --diff-runs 2026-11-08-abc123 2026-11-08-def456
consilium --report pr --report-file review.md "Review the current changes"
consilium --variant high "Design the subscriptions DB schema"
consilium watch --debounce 500 "Review the current changes"
consilium hooks install
```

## Analysis, artifacts, and cost

`--consensus` computes lexical expert agreement: shared significant terms (Jaccard, RU+EN stopwords) per pair, an average score, and an `agreement` level (`high`/`medium`/`low`). This is a deterministic count over answer texts, not an LLM judgement. A compact summary is injected into the chair prompt; the full report is appended to the result and stored in `metadata.consensus` (`agreement`, `averageSimilarity`, `pairs`, `sharedTerms`, `uniqueTerms`).

`--smart-experts` picks 2–3 relevant roles with a heuristic (arch/ux/ba/sec lexicons, RU+EN) over the task and diff; dropped roles are logged to progress. The selection is stored in `metadata.smartExperts`.

`--max-cost <usd>` tracks accumulated expert+chair cost. When the limit is exceeded before the chair starts, the chair is skipped: a partial result with expert opinions and consensus is returned with `errorCode: COST_LIMIT`. The breakdown lives in `metadata.cost` (`limit`/`spent`/`exceeded`/`byAgent`); `metadata.costExceeded` is added on overrun.

`--fallback-models a,b` sets spare models: on `RATE_LIMITED`, `MODEL_UNAVAILABLE`, or `EMPTY_RESPONSE` the same expert is retried on the next model in the chain (max 2 substitutions per expert), usage is summed. The list is stored in `metadata.fallbackModels`.

Artifacts are plain files, no database. `--artifacts` saves a run to `.consilium/runs/<id>/`: `run.json` (task, expert answers, models, usage, consensus), `report.md` (readable report), and `experts/<agent>.md` (each expert's answer). `--artifacts-dir <path>` changes the directory, `--no-artifacts` disables saving. The id and directory are visible in `metadata.artifacts: { id, dir }`. `consilium --replay <id>` reruns a saved run (restores the chair agent/model, expert models, and the artifact's consensus/smartExperts/fallbackModels/session flags); `consilium --diff-runs <a> <b>` prints a markdown comparison of two runs.

`--session <id>` sets the base OpenCode session id: the chair continues it as-is, and each expert gets its own `ses_<base>-<agent>` (OpenCode requires the `ses_` prefix). Parallel agents never share one session — otherwise some prompts are lost (see `docs/session-and-plugin.md`). Unknown agents from `opencode.json` are detected and run on the default agent with a separate `ses_<base>-default-<agent>` session instead of polluting someone else's session. The flag does not hide sessions from lists: archived sessions still show up in `opencode session list`.

## Reports, watch, and git hooks

```bash
# HTML report to a file / PR markdown to stdout
consilium --report html --report-file report.html "Review the current changes"
consilium --report pr "Review the current changes"

# --report-file infers the format itself: .html → html, .md → pr
# Without --report-file the report goes to stdout, except with -f json (then --report-file is required)
consilium --report-file notes.md "Design the subscriptions DB schema"

# Rerun on file changes (ignores .git/node_modules/dist/.consilium/coverage/*.tmp/*.log,
# 400 ms debounce, the current git diff is appended to the task)
consilium watch "Review the current changes"
consilium watch --debounce 800

# Pre-commit hook: reviews staged changes before every git commit and blocks the commit on failure
consilium hooks install
consilium hooks uninstall   # removes only the managed block, leaves the rest of the hook alone
```

The PR report is GitHub-comment markdown with an `<!-- consilium:report -->` marker and collapsible `<details>` blocks of expert opinions; the HTML report is a self-contained file with escaped text. The hook writes only its own block (`# >>> consilium >>>` … `# <<< consilium <<<`) into the git hooks directory (`git rev-parse --git-path hooks`: `.git/hooks`, `core.hooksPath`, worktrees) and preserves the rest.

## OpenCode V2 plugin

A native plugin that runs the council **inside the OpenCode V2 TUI** without MCP or an external CLI — via the `consilium.run` tool. It does not work in OpenCode V1 (the V1 plugin API is incompatible).

Register in `opencode.json` (V2):

```json
{
  "plugins": [{ "package": "opencode-consilium" }]
}
```

The package publishes the server part as `./server` (`dist/plugin.js`); the plugin has no runtime dependencies (`@opencode/plugin` is needed only for types at build time). The tool accepts `task`, `experts`, `chair`, `timeout_ms`, `consensus`, `smart_experts`, `max_cost`, `fallback_models`, `session`, `artifacts`, `preset`.

When to use what:

| Way | When |
| --- | --- |
| Plugin (`consilium.run`) | Working inside the OpenCode V2 TUI, advice needed right in the conversation |
| MCP server | External harnesses (Claude Desktop, Codex, Cursor, VS Code, custom agents) |
| CLI | Terminal, scripts, CI, hooks, watch |

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
| `retry.jitter` | `false` | Randomized retry delay (50–100%) so experts don't hit the limit together |
| `retry.maxConcurrency` | 3 | 1–8 parallel agents |
| `output.file` | `false` | `false` disables saving; a string enables it |
| `standalone` | `true` | `--standalone` private server; avoids port conflicts when OpenCode is already running |
| `autoApprove` | `false` | `--auto`; only enable if you trust the agents/tools |
| `autoDiscoverAgents` | `true` | Reuse agents from `opencode.json` |
| `artifacts` | `false` | `true` saves to `.consilium/runs/<id>/`; a string sets a custom directory |
| `consensus` | `false` | Lexical expert-agreement analysis |
| `smartExperts` | `false` | Heuristically pick 2–3 roles for the task |
| `maxCost` | — | Cost limit in USD (number >= 0); unset means no limit |
| `fallbackModels` | — | Array of `provider/model` strings for model-error retries |
| `session` | — | Base OpenCode session id (non-empty string) |
| `report` | — | Report format: `html`, `pr`, `markdown` |
| `reportFile` | — | Report file path (`.html`/`.md` extension picks the format) |
| `variant` | - | Model variant for models without `#variant` (explicit variants win) |
| `debounceMs` | 400 | Watch-mode delay, ms (integer >= 0) |
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
opencode run --standalone --format json [--auto] [--agent=NAME] [--model=provider/model]
```

The prompt is written to the child's **stdin** (UTF-8), so arbitrary task text is safe and never hits shell/command-line limits. NDJSON events are decoded incrementally (`text`, `step_finish` usage/cost, `error` with `type`/`status`/`retryAfterMs`). The model is always passed as `--model` so behavior is identical on V1 and V2, where `--agent` does not apply the configured agent model. Exit codes, stderr tails, and structured errors are reported with typed `errorCode`s (`RATE_LIMITED`, `MODEL_UNAVAILABLE`, `AGENT_NOT_FOUND`, ...). If an agent name is missing in your OpenCode config, the call is retried once with the same model and the default agent; the run keeps working even without persona agents.

## Security

- Task text is never interpolated into a shell command; it is passed via stdin.
- Agent names and model IDs are validated before use.
- `--auto` (auto-approve permissions) is **off** by default.
- `--standalone` isolates the child server; no port takeover.
- API keys are never printed or written by Consilium; `doctor` only checks whether expected environment variables are present, and OpenCode handles auth.
- `doctor` warns about missing keys and risky configuration.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `OpenCode CLI не найден` | `npm install -g opencode-ai` or set `opencodePath` |
| `Model unavailable` | Model rotated out/region-blocked; run `consilium models --verify --refresh` |
| `Agent not found` | Persona agent missing; Consilium falls back to the default agent + your model. Add agents via `consilium init --free` |
| Timeouts | Free models can be slow; raise `--expert-timeout` or use `--preset fast` |
| `RATE_LIMITED` / 429 | Free-model quota exhausted; the error shows the retry delay. Switch the model/provider |
| Agent model ignored on V2 | Consilium already passes `--model`; run `consilium doctor` (the `opencode-v2-compat` check) |
| `COST_LIMIT` (`--max-cost` exceeded) | Chair skipped by design; expert opinions and consensus are in the partial result, spend in `metadata.cost.byAgent`. Raise the limit or drop the flag |
| Fallbacks still hit 429 | Spare models often share the same free quotas; switch providers or wait for the retry delay in the error |
| Sessions pile up in `session list` | By design: each agent owns a session and `--session` does not hide them (`--archived` doesn't either). Clean up with `opencode session delete <id>` |
| `replay` can't find the id | Ids resolve under `.consilium/runs/`; check the directory or pass that run's `--artifacts-dir` |
| MCP server missing on V2 | Flat `mcp.<name>` is ignored; run `consilium mcp --install --force` |
| `Managed service port ... in use` | Keep `standalone: true` (default) |
| Empty result | `consilium doctor`, then rerun with `-V` |

## What's next (feature ideas)

Remaining ideas (1.3.0 shipped artifacts, consensus, smart-experts, model fallback, `--max-cost`, `--session`; 1.4.0 shipped reports, model variants, `watch`, git hooks, and the native V2 plugin):

| Idea | Value | Size |
| --- | --- | --- |
| `consilium` slash command for the TUI | Invoke the council with one command inside OpenCode | S |
| Report export to ticket systems | Ready-made artifact for Jira/Linear | S |

## 1.4.0 changes

- Reports: `--report html|pr|markdown`, `--report-file <path>` (`.html` → html, `.md` → pr; without a file prints to stdout, except with `-f json`); `renderHtmlReport` (self-contained escaped HTML), `renderPrMarkdown` (GitHub comment with an `<!-- consilium:report -->` marker and `<details>` blocks), `renderReport`.
- `--variant high`: appends `#high` to expert and chair models; an invalid variant exits 2. Config key `variant`.
- `consilium watch [--debounce <ms>] [task]`: watches the project (ignores `.git`/`node_modules`/`dist`/`.consilium`/`coverage`/`*.tmp`/`*.log`), debounces 400 ms, appends `git diff`, reruns until Ctrl+C.
- `consilium hooks install`: writes a managed pre-commit block (`# >>> consilium >>>` … `# <<< consilium <<<`) that runs `npx -y opencode-consilium --staged -s "Ревью staged-изменений" || exit 1` on every `git commit`; preserves existing hook content; `uninstall` removes only its block.
- Native OpenCode V2 plugin: server part `./server` → `dist/plugin.js`, registration `{"plugins": [{"package": "opencode-consilium"}]}`, a `consilium.run` tool (task, experts, chair, timeout_ms, consensus, smart_experts, max_cost, fallback_models, session, artifacts, preset). No runtime dependencies; `@opencode/plugin` is only needed for types. V2 only, does not work in V1.
- `--replay <id>` now restores the chair agent/model, expert models, and the artifact's consensus/smartExperts/fallbackModels/session flags (previously models only).
- New config keys: `report`, `reportFile`, `variant`, `debounceMs` (schema updated).
- 224 tests; OpenCode V1/V2 compatibility unchanged.

## 1.3.0 changes

- Run artifacts: `--artifacts` / `--artifacts-dir <path>` / `--no-artifacts` save runs to `.consilium/runs/<id>/` (`run.json`, `report.md`, `experts/<agent>.md`); `consilium --replay <id>` reruns a saved run, `consilium --diff-runs <a> <b>` prints a markdown comparison.
- `--consensus` / `--no-consensus`: lexical agreement analysis (Jaccard, RU+EN stopwords); summary into the chair prompt, full report into the result and `metadata.consensus`.
- `--smart-experts`: heuristic role selection for the task/diff (2 by default, max 3, dropped roles logged); stored in `metadata.smartExperts`.
- `--max-cost <usd>`: cost tracker; when exceeded before the chair, the chair is skipped (`errorCode: COST_LIMIT`, partial result with consensus); details in `metadata.cost`.
- `--fallback-models a,b`: retry the same expert on a fallback model on `RATE_LIMITED` / `MODEL_UNAVAILABLE` / `EMPTY_RESPONSE` (chain capped at 2, usage summed).
- `--session <id>`: the chair continues the base session, each expert gets its own `ses_<base>-<agent>`; unknown agents run on the default agent with `ses_<base>-default-<agent>`.
- MCP `consilium_run`: new `consensus`, `smart_experts`, `max_cost`, `fallback_models`, `session`, `artifacts` args; response includes `cost`, a consensus summary, and an `**Artifacts:**` line.
- New config keys: `artifacts`, `consensus`, `smartExperts`, `maxCost`, `fallbackModels`, `session` (schema updated).
- 149 tests; OpenCode V1/V2 compatibility unchanged.

## 1.2.0 changes

- OpenCode V2 compatibility while keeping V1 support: reads `agent` and `agents`, `.opencode/opencode.json(c)`, parent directories, and merges config layers in OpenCode's order.
- The agent model is passed via `--model`, so V2 no longer loses it with `--agent`.
- `consilium mcp --install [--global]` writes `mcp.servers` for V2 and `mcp.<name>` for V1, preserving an existing entry's `environment`/`cwd`/`timeout`.
- `init --free --native-v2` writes native V2 agents; duplicate `agent`/`agents` entries are updated together. Agents with V1-only restrictions (`tools`, `permission`, `temperature`) are not migrated automatically, to avoid losing them.
- `opencodeConfigPath` is no longer set by default: discovery works out of the box, and a missing configured path warns and falls back.
- `RATE_LIMITED` + `retryAfterMs` from V2 events: short limits are retried, long ones fail fast with the retry time.
- Retry jitter (`retry.jitter`), resilient decoder (`properties`, delta text), `opencode-v2-compat` doctor check.
- 81 test, including the new `test/compat.test.mjs` (149 as of 1.3.0).

## Development

```bash
npm install
npm run build       # tsc
npm test            # build + node:test (224 tests)
npm run typecheck   # tsc --noEmit
```

## License

MIT
