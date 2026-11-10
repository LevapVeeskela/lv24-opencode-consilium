![Consilium — a council of AI experts for OpenCode](https://raw.githubusercontent.com/LevapVeeskela/lv24-opencode-consilium/master/.github/assets/banner.jpg)

# lv24-opencode-consilium

[![npm](https://img.shields.io/npm/v/lv24-opencode-consilium?label=npm&color=cb3837&logo=npm)](https://www.npmjs.com/package/lv24-opencode-consilium)
[![downloads](https://img.shields.io/npm/dm/lv24-opencode-consilium?color=cb3837)](https://www.npmjs.com/package/lv24-opencode-consilium)
[![GHCR](https://img.shields.io/badge/GHCR-ghcr.io%2Flevapveeskela%2Flv24--opencode--consilium-2496ED?logo=docker&logoColor=white)](https://github.com/LevapVeeskela/lv24-opencode-consilium/pkgs/container/lv24-opencode-consilium)
[![license](https://img.shields.io/badge/license-MIT-2ea44f)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D18-339933?logo=node.js&logoColor=white)](package.json)
[![OpenCode](https://img.shields.io/badge/OpenCode-V1%20%7C%20V2-6C5CE7)](https://opencode.ai)

**Languages:** English · [Русский](docs/README.ru.md) · [中文](docs/README.zh.md)

> **Four experts. Four models. One plan.** Consilium runs `arch`, `ux`, `ba` and `sec` in parallel on different models, then a chair model merges their answers into a single actionable plan. Works inside OpenCode, Claude Desktop, Codex, Cursor, VS Code, CI and your own agents.

> **Кратко по-русски.** Консилиум ИИ-экспертов для OpenCode V1 и V2: роли `arch`, `ux`, `ba`, `sec` параллельно отвечают на разных моделях, а председатель синтезирует итоговый план. Бесплатные модели подбираются и проверяются автоматически (`consilium init --free`). В комплекте: CLI, MCP-сервер, нативный плагин V2, артефакты запусков с replay/diff, анализ согласия, HTML/PR-отчёты, watch-режим и git-hooks.
>
> Установка: `npm install -g lv24-opencode-consilium`, затем `consilium doctor` и `consilium "ваша задача"`. Полная документация — [docs/README.ru.md](docs/README.ru.md).

| 🚀 Start | 🧠 Use | 🛠 Build |
| --- | --- | --- |
| [Install](#install) · [Quick start](#quick-start) · [Free models](#free-models-automatically) | [MCP server](#use-it-from-any-harness-mcp) · [For AI agents](#for-ai-agents) · [CLI](#cli-reference) · [Reports & hooks](#artifacts-reports-watch-and-git-hooks) | [V2 plugin](#opencode-v2-plugin) · [Presets](#presets) · [Config](#configuration) · [Library API](#library-api) · [Security](#security) · [Troubleshooting](#troubleshooting) |

## See it work

```bash
$ consilium "Review the authentication design"

  arch  → flint-40b-free          architecture, trade-offs
  ux    → inkling-2-small-free    flows, error states
  ba    → deepseek-v4.1-flash-free  scope, edge cases
  sec   → iceman-free             threats, authz, abuse

  chair → beam-free               ← synthesizes one plan
  ✓ 4 experts in parallel · free models · no API bill
```

The chair does not summarize — it resolves disagreements, drops weak points and returns one plan with explicit trade-offs. Every expert runs on its own model, so blind spots do not overlap.

## Why consilium

- **Different models = different blind spots.** One model misses what another catches; the chair makes the conflict explicit instead of averaging it away.
- **Zero cost by default.** Discovers free, tool-capable models from public catalogs, ranks them, verifies they actually answer in your region, and writes them into your config.
- **Uses what you already have.** OpenCode CLI does auth, providers and agents — no parallel provider stack, no extra keys.
- **Same engine everywhere.** Terminal, MCP server for any harness, native V2 plugin, library API.

## What you get

| | Feature | What it does |
| --- | --- | --- |
| 🧠 | **Parallel council** | Per-expert `agent` + `model`, bounded concurrency, isolated sessions |
| 🪑 | **Chair synthesis** | Configurable prompt template, per-expert text limits, usage and cost accounting |
| 🆓 | **Free-model bootstrap** | `models.dev` + OpenRouter + curated offline list, cached 12 h, optional live probe |
| 🩺 | **`doctor` preflight** | CLI version, config flavor, agents, models, MCP shape, V1/V2 pitfalls |
| 🧾 | **Run artifacts** | `run.json`, `report.md`, `experts/*.md`; `--replay` and `--diff-runs` |
| 📊 | **Reports** | Self-contained HTML, GitHub-ready PR markdown, SARIF 2.1.0, Jira/Linear tickets |
| 🔁 | **Watch mode** | Rerun on file changes with debounce, current git diff appended |
| 🪝 | **Git pre-commit hook** | Reviews staged changes and blocks the commit on failure |
| 🔌 | **MCP server** | stdio JSON-RPC with run, model, doctor and read-only artifact tools |
| 🧩 | **V2 plugin** | `consilium.run` tool inside the OpenCode V2 TUI |
| 🛡 | **Safe review** | `--read-only` denies writes/shell/MCP tools; `--isolate` uses per-agent worktrees |
| 🔒 | **Safe runner** | Prompt via stdin (no shell injection), `--standalone`, retries, timeouts, cost cap |
| 📦 | **Small and strict** | Zero runtime dependencies, TypeScript strict, Node >= 18 |

## Meet the council

| Role | Agent name | Looks at | Typical questions |
| --- | --- | --- | --- |
| 🏛 | `arch` | Architecture and trade-offs | What breaks at 10× load? Which boundary is wrong? |
| 🎨 | `ux` | Flows, API ergonomics, error states | What does the user see on failure? Is this obvious? |
| 📋 | `ba` | Requirements and scope | What is out of scope? Which edge case is unowned? |
| 🛡 | `sec` | Threats, authz, abuse | Who can call this? What leaks? How is it rate-limited? |
| ⚖️ | `consilium` | Chair | Merges answers, resolves conflicts, returns one plan |

Want fewer voices? `-e arch,sec`, `--smart-experts` (heuristic role pick) or a preset.

## Install

```bash
npm install -g lv24-opencode-consilium

# or run without installing
npx -y lv24-opencode-consilium --help

# or install the thin Python launcher from PyPI (still needs Node.js + OpenCode)
pip install lv24-opencode-consilium
```

`pip` installs `consilium` and `consilium-mcp` console scripts that delegate to the npm package via `npx`; npm remains the canonical distribution. Python 3.9+ is required for the launcher. Details: [`docs/pypi.md`](docs/pypi.md).

**Requirements**

| Need | Details |
| --- | --- |
| Node.js | **>= 18** |
| OpenCode CLI | `npm install -g opencode-ai`, authenticated, **V1 or V2** |
| Optional | `OPENROUTER_API_KEY` for OpenRouter's free models |

### Container image (GHCR)

A self-contained image (Node.js, OpenCode CLI, `git`) for `linux/amd64` and `linux/arm64`:

```bash
docker pull ghcr.io/levapveeskela/lv24-opencode-consilium:1.12.1   # or :latest
docker run --rm ghcr.io/levapveeskela/lv24-opencode-consilium:latest --version
# consilium v1.12.1
```

Run it on a project — mount credentials and config, keep the project writable:

```bash
docker run --rm -it \
  -v "$PWD:/workspace" \
  -v "$HOME/.local/share/opencode:/home/node/.local/share/opencode" \
  -v "$HOME/.config/opencode:/home/node/.config/opencode:ro" \
  -u "$(id -u):$(id -g)" \
  ghcr.io/levapveeskela/lv24-opencode-consilium:latest \
  "Design a rate limiter for a public API"
```

The entrypoint is `consilium`, so every flag works (`doctor`, `init --free`, `models`, `mcp`). For the MCP server use `--entrypoint consilium-mcp`. Inside the image `HOME=/home/node`; config mounts to `/home/node/.config/opencode`, credentials to `/home/node/.local/share/opencode`. On Windows omit `-u` and use `%CD%` / `%USERPROFILE%` in `-v`.

## Quick start

```bash
# 1. Check the environment: CLI, config, agents, models
consilium doctor

# 2. Pick the strongest working free models and write the config
consilium init --free

# 3. Run the council
consilium "Design a rate limiter for a public API"
```

`init --free`:

1. downloads `https://models.dev/api.json` and `https://openrouter.ai/api/v1/models`;
2. keeps only free (`cost = 0`), active, chat models with tool calling and >= 32K context;
3. ranks them and probes the top candidates with a tiny real request (unless `--no-verify`);
4. writes the winners into `opencode.json` (agents `arch`, `ux`, `ba`, `sec`, `consilium`) and `consilium.config.json`;
5. never overwrites existing agent models unless you pass `--force`.

```bash
consilium init --free --dry-run      # preview, write nothing
consilium init --free --native-v2    # native V2 agents (agents + system)
```

## Works on OpenCode V1 and V2

Both branches are supported and the config shape is detected automatically.

| Area | OpenCode V1 | OpenCode V2 |
| --- | --- | --- |
| `opencode.json` agents | `agent` + `prompt` | `agents` + `system` |
| MCP servers | `mcp.<name>` + `enabled` | `mcp.servers.<name>` + `disabled` |
| Commands | `command` + `subtask` | `commands` + `subagent` |
| Agent model on `run --agent` | applied from config | **ignored**, `--model` required |

- **V1 shape is the safe default** — both versions read it, so `init --free` writes it.
- **Native V2 agents** only with `--native-v2` or when the file already uses V2 keys.
- **Models are always passed via `--model`**, so V2 cannot silently fall back to the root model.
- **Agents are read from both sections**, including `.opencode/opencode.json(c)` and parent directories.
- `RATE_LIMITED` retries short limits (up to 30 s) and fails fast with the retry delay for long ones.
- `doctor` reports CLI major, config flavor, `agent`/`agents` duplicates, dead V2 fields and flat MCP entries.

One-command MCP registration:

```bash
consilium mcp --install            # ./opencode.json
consilium mcp --install --global   # ~/.config/opencode/opencode.json
opencode mcp list                  # verify
```

## Context pack (`--context auto`)

Experts normally see only the task and the diff. `--context auto` adds the changed files, project rules, related tests and recent commits:

```bash
consilium --context auto --diff "Review the current changes"
```

Priority and budget: rules → changed files → related tests → commits; 48k chars total, 12k per file, 20 files. Binary, lock and generated files are skipped; every section is wrapped in `<untrusted-*>` markers so repo text cannot masquerade as instructions. `--context off` (default) keeps the old behavior.

## Free models, automatically

```bash
consilium models                 # top 20 ranked models
consilium models --available     # only providers you can use
consilium models --verify        # probe the shown models with a real request
consilium models --refresh       # ignore the 12 h cache
consilium models --json          # machine-readable
```

| Source | What it gives |
| --- | --- |
| `https://models.dev/api.json` | Full catalog, cost/limits/capabilities, links to paid siblings |
| `https://openrouter.ai/api/v1/models` | `:free` variants, context, `tools` support, expiry |
| Built-in curated list | Known-good OpenCode free models if a catalog rotates them out |

Cache: `%TEMP%/lv24-opencode-consilium/models-cache.json` (or `CONSILIUM_MODELS_CACHE`), TTL 12 h.

The `opencode-go` provider is not excluded wholesale: its free models (`*-free`, `iceman-contributor-free`, …) take part in ranking. Paid models such as `opencode-go/muse-spark-1.3-contributor` are not selected by `--free`; set them manually in `experts[].model` or `chair.model`.

Current recommended set (catalog as of 2026-11-08):

| Role | Model | Why |
| --- | --- | --- |
| arch | `opencode/flint-40b-free` | coding agent, structured output, 262k |
| ux | `opencode/inkling-2-small-free` | 1M context, multimodal, fast |
| ba | `opencode/deepseek-v4.1-flash-free` | reasoning + agentic coding, 200k |
| sec | `opencode/iceman-free` | newest reasoning model, 262k (stealth) |
| chair | `opencode/beam-free` | top score, 1M, structured, coding/agentic |

Free models rotate: `init --free` re-checks the catalog and real responses. Stealth/alpha models (`iceman`, `crouton`) can disappear — `--refresh` picks replacements.

Ranking (0–1.2) is deterministic: context window 30%, tool calling 20%, structured output 10%, reasoning 10%, recency 10%, output limit 10%, family prior 10%, paid-sibling "shadow price" 15%, plus alpha/preview/stealth penalties.

Call outcomes are remembered in `.consilium/reliability.json` (successes, rate limits, timeouts, latency per model). `consilium models --reliability` prints the table; the ranking accepts an optional reliability bonus once a model has at least 3 attempts. The file is local and safe to delete.

## Local and privacy mode

Run only on local providers (Ollama, LM Studio, llama.cpp, vLLM):

```bash
consilium models --local              # only local models in the ranked catalog
consilium models --probe-local        # are Ollama / LM Studio running?
consilium init --local                # probe and write a localOnly config
consilium init --local --dry-run      # show the assignment without writing
consilium --local-only "Review the changes"
```

`init --local` asks Ollama (`/api/tags`) and LM Studio (`/v1/models`) for their model lists, assigns models round-robin to `arch`, `ux`, `ba`, `sec` and the chair, and writes `consilium.config.json` with `localOnly: true` (refuses to overwrite without `--force`).

`--local-only` is a hard guarantee: every expert and the chair must have an explicit model whose provider is local, otherwise the run is rejected before spawning (exit 2, MCP tool error, or a library error). A missing model is an error, not an implicit cloud fallback. `doctor` adds a `local-providers` check that fails when `localOnly` is on and no local provider is reachable.

## Use it from any harness (MCP)

```bash
consilium mcp          # stdio server
consilium-mcp          # same, direct binary
```

**Claude Desktop** (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "consilium": {
      "command": "npx",
      "args": ["-y", "lv24-opencode-consilium", "mcp"]
    }
  }
}
```

**Codex** (`~/.codex/config.toml`):

```toml
[mcp_servers.consilium]
command = "npx"
args = ["-y", "lv24-opencode-consilium", "mcp"]
```

Any MCP client with stdio JSON-RPC 2.0 works. Logs go to **stderr**; stdout carries only the protocol.

| Tool | Arguments | Result |
| --- | --- | --- |
| `consilium_run` | `task` (required), `experts`, `chair`, `timeout_ms`, `deadline_ms`, `local_only`, `read_only`, `isolate`, `rounds`, `format`, `preset`, `output_file`, `consensus`, `smart_experts`, `max_cost`, `fallback_models`, `session`, `artifacts`, `findings` | Chair synthesis + expert opinions + JSON metadata (time, usage, cost, models, findings, safety, deadline, debate) |
| `consilium_list_agents` | — | Configured experts, models, chair, presets, config path |
| `consilium_free_models` | `limit`, `available_only`, `refresh`, `local_only`, `probe_local` | Ranked free models table + local provider probe |
| `consilium_doctor` | — | Environment/config diagnostics |
| `consilium_init_free` | `apply`, `force`, `confirm`, `verify` | Proposal (default) or writes `opencode.json` + `consilium.config.json` |
| `consilium_replay` | `run` (id or `latest`), optional `read_only`, `isolate`, `artifacts`, `output_file`, `max_cost`, `deadline_ms`, `rounds`, `findings`, `session`, `timeout_ms` | Re-run a saved artifact with its task/models/options and stream progress like `consilium_run` |
| `consilium_list_runs` | `limit` (1–100, default 10) | Saved runs newest first: id, time, task, success, finding counts |
| `consilium_get_run` | `run` (id or `latest`, default `latest`) | Full `run.json` as JSON |
| `consilium_sarif` | `run` (id or `latest`), optional `output_file` | SARIF 2.1.0 JSON, or an atomic workspace-confined file |
| `consilium_diff_runs` | `left`, `right` (ids or `latest`) | Markdown comparison of two saved runs |

`consilium_init_free` is dry-run by default - pass `"apply": true` to write files; `force: true` also requires `"confirm": true` and creates `.bak` copies. `consilium_run` and `consilium_replay` report live progress when the client sends a `progressToken`; their responses include `cost`, a consensus summary and an `**Artifacts:**` line when artifacts are enabled. The artifact inspection tools are read-only, never call a model, and are confined to `.consilium/runs` and the workspace.

## For AI agents

If you are an agent, these are the stable contracts. Prefer them over scraping prose.

```json
{
  "package": "lv24-opencode-consilium",
  "version": "1.12.1",
  "bins": ["consilium", "consilium-mcp", "lv24-opencode-consilium"],
  "mcp": { "command": "npx", "args": ["-y", "lv24-opencode-consilium", "mcp"] },
  "json_mode": "consilium -f json \"<task>\"",
  "findings": "consilium --findings -f json \"<task>\" -> metadata.findings",
  "safety": { "read_only": "--read-only", "isolate": "--isolate", "metadata": "metadata.safety" },
  "report_formats": ["html", "pr", "markdown", "sarif", "jira", "linear"],
  "artifact_tools": ["consilium_list_runs", "consilium_get_run", "consilium_sarif", "consilium_diff_runs"],
  "replay_tool": "consilium_replay",
  "models_json": "consilium models --json",
  "config_files": ["consilium.config.json", "consilium.json", ".consiliumrc", ".consiliumrc.json"],
  "config_schema": "schema/config.schema.json",
  "exit_codes": { "0": "success", "1": "run failed", "2": "usage error", "3": "policy gate failed" },
  "docs_index": "llms.txt"
}
```

Rules that matter when you drive it:

1. **stdout is for data, stderr is for progress.** `-f json` prints one JSON document on stdout; logs and progress stay on stderr.
2. **Do not parse human text.** Use `-f json` (result + `metadata`), `consilium models --json`, or MCP tools.
3. **Errors are typed.** `errorCode` is one of `RATE_LIMITED`, `MODEL_UNAVAILABLE`, `EMPTY_RESPONSE`, `AGENT_NOT_FOUND`, `COST_LIMIT`, `TIMEOUT`, … and exit codes are `0/1/2/3` (`3` = policy gate).
4. **State is files, not a daemon.** Artifacts live in `.consilium/runs/<id>/` (`run.json`, `report.md`, `experts/<agent>.md`); `--replay <id>` restores a run.
5. **No interactive prompts.** Every command is non-interactive; `autoApprove` (OpenCode's `--auto`) is off by default and must be enabled deliberately in a trusted config.
6. **Cheap first.** `consilium doctor` → `consilium models --json` → `consilium -f json "..."`; add `--max-cost` for a hard budget.

Copy-paste prompt for an agent:

```text
Run the consilium council on this task with a hard cost cap:
  npx -y lv24-opencode-consilium --max-cost 0.50 -f json "<task>"
Parse stdout as JSON. If errorCode is COST_LIMIT, report the partial expert
opinions and metadata.cost; do not retry. If RATE_LIMITED, read
metadata.retryAfterMs before retrying. Use --replay <id> to reproduce a run.
```

Full machine index: [`llms.txt`](llms.txt). Deep internals (sessions, plugin API): [`docs/session-and-plugin.md`](docs/session-and-plugin.md).

## CLI reference

```text
consilium [options] <task>
consilium <task> -                  # read the task from stdin
consilium init [--free|--local] [--dry-run] [--force] [--no-verify] [--native-v2]
consilium models [--available] [--verify] [--limit N] [--refresh] [--json]
consilium doctor
consilium mcp [--install] [--global]
consilium watch [--debounce <ms>] [task]
consilium hooks install|uninstall
consilium baseline accept <id|latest> [--dry-run]
consilium baseline prune [--older-than <days>] [--all --yes]
consilium eval [--fixtures <dir>] [--json] [--rounds <1|2>] [--compare-rounds] [--fail-under <pct>] [--max-cost <usd>]
consilium history [--limit N] [--json]
consilium stats [--json] [--html <file>]
consilium presets [--json]
consilium audit --since <ref> [--dry-run] [--fail-on <severity>] [--json]
consilium sarif [--run <id|latest>] [--output <file>]
```

**Core**

| Flag | Meaning |
| --- | --- |
| `-c, --config <file>` | Config file (otherwise auto-discovers) |
| `-e, --experts a,b` | Subset of experts |
| `--chair <agent>` | Chair agent name |
| `--preset <name>` | `fast`, `deep`, `security`, `review`, `free`, or a custom preset from config |
| `--deadline <ms>` | Expert-phase wall-clock budget; stragglers are cancelled and the chair synthesizes partial results (max 24 h) |
| `--rounds <1\|2>` | `2` adds an anonymized peer-review round; applies to run/watch/eval and doubles model calls (default 1) |
| `--compare-rounds` | `eval`: run every fixture with one and two rounds and print the delta table |
| `--local-only` | Require an explicit local model for every agent; reject non-local providers before running |
| `--read-only` | Experts and chair may only read/glob/grep; write/edit/patch/shell/webfetch/subagent/MCP tools are denied |
| `--allow-write` | Opt out of read-only (mutually exclusive with `--read-only`); `audit` is read-only by default |
| `--isolate` | Run each agent in a Consilium-managed git worktree under `.consilium/worktrees`; requires a git repo, includes tracked changes, removes the worktree after the call |
| `--expert-timeout`, `--chair-timeout` | Timeouts in ms (per attempt) |
| `-r, --retries <n>` | Retry count (0 = single attempt) |
| `-o, --output <file>` | Save the result (text/markdown/json by `-f`) |
| `--no-save` | Never write a file |
| `-f, --format <fmt>` | `text`, `markdown`, `json` (pure JSON on stdout) |
| `--task-file <file>` | Read the task from a file (`-` = stdin) |
| `-s, --silent` | Only the final result |
| `-V, --verbose` | Raw progress events |
| `-v, --version`, `-h, --help` | Version / help |

**Analysis and budget**

| Flag | Meaning |
| --- | --- |
| `--consensus` / `--no-consensus` | Lexical expert-agreement analysis (term overlap, Jaccard); summary into the chair prompt, full report into the result |
| `--smart-experts` | Heuristically pick 2–3 relevant roles from the task/diff (dropped roles are logged) |
| `--max-cost <usd>` | Cost limit; when exceeded before the chair, it is skipped (`COST_LIMIT`, partial result with consensus) |
| `--fallback-models a,b` | On `RATE_LIMITED` / `MODEL_UNAVAILABLE` / `EMPTY_RESPONSE` retry the same expert on the next model (chain capped at 2) |
| `--session <id>` | Base OpenCode session id; each agent gets `ses_<base>-<agent>` (parallel agents never share a session) |
| `--variant <name>` | Model variant for all agents (`provider/model` → `provider/model#variant`); invalid variant exits 2 |
| `--verify` / `--no-verify` | Probe models before selecting (`models` / `init --free`) |

**Artifacts, reports, automation**

| Flag | Meaning |
| --- | --- |
| `--artifacts` / `--no-artifacts` | Save / don't save run artifacts (off by default) |
| `--artifacts-dir <path>` | Custom artifact directory (instead of `.consilium/runs/<id>/`) |
| `--replay <id>` | Rerun a saved run (restores chair/expert models and consensus/smartExperts/fallbackModels/session flags) |
| `--diff-runs <a> <b>` | Print a markdown comparison of two saved runs |
| `--report <format>` | Report after the run: `html`, `pr`, `markdown`, `sarif`, `jira`, `linear` |
| `--report-file <file>` | Write the report to a file (`.html` → html, `.md` → pr, `.sarif` → sarif, `.jira` → jira, `.linear` → linear) |
| `--diff [--staged] [--base <ref>]` | Append the current git diff to the task |
| `--debounce <ms>` | Watch-mode debounce delay (default 400) |
| `watch [--debounce <ms>] [task]` | Watch the project and rerun on changes (until Ctrl+C) |
| `hooks install\|uninstall` | Install/remove a git pre-commit hook (staged review before commit) |
| `--native-v2` | Write native V2 config (`agents`/`system`) |
| `--install`, `--global` | Register the MCP server in the project or global config |
| `--findings` / `--no-findings` | Structured findings block in expert/chair answers (off by default) |
| `--fail-on <severity>` | Exit `3` when new findings reach the threshold: `critical`, `high`, `medium`, `low`, `info`, `none` |
| `baseline accept\|prune` | Manage `.consilium/baseline.json` (accepted finding fingerprints) |
| `--context <off\|auto>` | Add changed files, rules, related tests and commits to the task (`auto`; off by default) |
| `eval [--fixtures <dir>]` | Run the planted-bug evaluation suite (default `eval/fixtures`) |
| `--fail-under <pct>` | `eval` gate: exit `3` below the catch-rate percentage |
| `--reliability` | `models`: print per-model success/latency from `.consilium/reliability.json` |
| `history [--limit N]` | Recent runs from `.consilium/runs` |
| `stats [--html <file>]` | Aggregate success/latency/cost/findings/per-model errors |
| `presets [--json]` | List built-in and custom presets |
| `models --local` / `--probe-local` | Local-only ranking and Ollama/LM Studio probe |
| `audit --since <ref>` | Review `<ref>...HEAD` end-to-end; `--dry-run` builds without models |

Exit codes: `0` success, `1` run failed, `2` usage error, `3` policy gate failed.

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

## Artifacts, reports, watch, and git hooks

```bash
# HTML report to a file / PR markdown to stdout
consilium --report html --report-file report.html "Review the current changes"
consilium --report pr "Review the current changes"

# --report-file infers the format: .html → html, .md → pr, .sarif → sarif,
# .jira → jira, .linear → linear
consilium --report-file notes.md "Design the subscriptions DB schema"

# Rerun on file changes (ignores .git/node_modules/dist/.consilium/coverage/*.tmp/*.log,
# 400 ms debounce, the current git diff is appended)
consilium watch "Review the current changes"
consilium watch --debounce 800

# Pre-commit hook: reviews staged changes and blocks the commit on failure
consilium hooks install
consilium hooks uninstall   # removes only the managed block
```

- **Artifacts** are plain files, no database: `run.json`, `report.md`, `experts/<agent>.md` under `.consilium/runs/<id>/`.
- **PR report** is GitHub-comment markdown with an `<!-- consilium:report -->` marker and collapsible `<details>` blocks; the HTML report is self-contained with escaped text.
- **The hook** writes only its own block (`# >>> consilium >>>` … `# <<< consilium <<<`) into the git hooks directory (`.git/hooks`, `core.hooksPath`, worktrees) and preserves the rest.

How the analysis flags behave:

- `--consensus` computes lexical agreement (Jaccard over significant terms, RU+EN stopwords): per-pair scores, an average and an `agreement` level (`high`/`medium`/`low`). It is a deterministic count, not an LLM judgement. Summary → chair prompt; full report → result and `metadata.consensus`.
- `--smart-experts` picks 2–3 roles with a heuristic (role lexicons over task and diff); the selection lands in `metadata.smartExperts`.
- `--max-cost` tracks expert + chair spend. Over the limit before the chair → chair skipped, partial result with `errorCode: COST_LIMIT` and `metadata.cost` (`limit`/`spent`/`exceeded`/`byAgent`).
- `--fallback-models` retries the same expert on the next model (up to the configured list, capped at 10), summing usage into `metadata.fallbackModels`.
- `--session` gives the chair the base session and each expert `ses_<base>-<agent>`; unknown agents run on the default agent with `ses_<base>-default-<agent>`, so nobody else's session is polluted. Sessions are not hidden from `opencode session list` by design.

## Findings and policy gate

Review runs can return structured findings instead of prose only — opt in with `--findings`:

```bash
consilium --findings --artifacts -f json "Review the current changes" > run.json
consilium --findings --fail-on high --diff "Review the current changes"
```

Each expert (and the chair) ends with one fenced `json` block:

````markdown
```json
{
  "findings": [
    {
      "severity": "high",
      "category": "security",
      "file": "src/auth.ts",
      "line": 42,
      "claim": "Deleting a project does not check ownership",
      "evidence": "the handler calls remove() without authorize()",
      "confidence": 0.9
    }
  ],
  "rejected": [
    { "claim": "Ownership is checked in middleware", "reason": "middleware is not mounted on this route" }
  ]
}
```
````

- `severity`: `critical` | `high` | `medium` | `low` | `info`; `claim` is required, everything else is optional.
- Experts report findings; the chair merges them and lists the positions it rejected in `rejected`.
- Findings are deduplicated by a stable fingerprint (category + file + normalized claim, line excluded), so the same issue maps to one entry across runs; severity is the maximum reported.
- `metadata.findings` = `{ items, counts, rejected, parseErrors }`; HTML and PR reports render the table plus a collapsible dissent ledger.
- Missing or malformed JSON never fails the run: prose is kept and the problem lands in `parseErrors`.

Baseline and gate:

```bash
consilium baseline accept latest           # accept the findings of the newest run
consilium baseline accept <runId> --dry-run
consilium baseline prune --older-than 90    # or --all --yes
consilium --findings --fail-on high --diff "Review the current changes"
```

`--fail-on` gates on **new** findings: fingerprints present in `.consilium/baseline.json` are ignored. Exit code `3` means the gate failed. `--fail-on` without `--findings` is a usage error. The baseline file is project-local and can be committed to share accepted findings with the team.

## SARIF and code scanning

```bash
consilium --findings --report sarif --report-file consilium.sarif "Review the current changes"
```

`--report sarif` writes SARIF 2.1.0 for GitHub code scanning and other SARIF viewers: one result per finding, `critical`/`high` → `error`, `medium` → `warning`, `low`/`info` → `note`, file/line locations, stable fingerprints and one rule per category. `--report-file` infers the format from `.sarif`/`.sarif.json`. Upload it with `github/codeql-action/upload-sarif` in CI; findings that were already accepted in the baseline still appear in the file unless you filter them.

Already have artifacts? Export the newest run without re-running the council:

```bash
consilium sarif --run latest --output consilium.sarif
consilium sarif --run 2026-01-15T10-00-00-000Z   # JSON on stdout
```

## Read-only and isolated runs

Review tasks should not be able to modify the repository. `--read-only` restricts every expert and the chair to `read`, `glob` and `grep`; `write`, `edit`, `patch`, `shell`, `webfetch`, `websearch`, `subagent`, `question`, MCP tools and external-directory access are denied. `.env` files stay unreadable (`.env.example` is allowed).

```bash
consilium --read-only "Review the authentication design"
consilium audit --since origin/main --fail-on high   # audit is read-only by default
consilium audit --since origin/main --allow-write   # explicit opt-out
```

The restriction is enforced through a temporary `.opencode/opencode.json` layer, which OpenCode loads after the direct project config. Consilium takes a lock, backs up an existing layer, merges V2 `agents.<name>.permissions` and V1 `agent.<name>.tools`, and restores the original bytes in `finally` (including cancellation). A stale lock is recovered on the next run; an unreadable layer or an existing `.opencode/opencode.jsonc` fails closed instead of silently running without enforcement. With `--isolate --read-only`, the `.jsonc` check runs before any worktree or agent and exits `2`; rename it to `.opencode/opencode.json` or use `--allow-write`. While a read-only run is active, other interactive OpenCode sessions in the same project see the temporary restrictions.

`--isolate` creates a managed git worktree per agent under `.consilium/worktrees`, based on HEAD plus tracked working-tree changes (`git stash create`). Untracked files are not copied. With `--read-only`, the deny overlay is applied inside each worktree; the main project is never used as the agent cwd. Worktrees are removed after every call (success, error or cancellation), and a conservative stale cleanup handles crashed runs. A non-git project fails before any model call.

Both flags are recorded in `metadata.safety` (`readOnly`, `isolate`) and in the run artifacts. The GitHub Action enables `read-only` by default and exposes `read-only: false` for opt-out.

## Ticket-ready reports

```bash
consilium --report jira --report-file ticket.jira "Review the current changes"
consilium --report linear --report-file ticket.md "Review the current changes"
```

`jira` renders Jira wiki markup (`h2.`, `||...||` tables, `{code}` blocks) and `linear` renders clean Markdown. Both include the verdict, models, cost, duration, a findings table (severity, category, file:line, claim, evidence, contested) and rejected positions/parse errors; runs without findings produce a valid “no findings” report. `.jira` and `.linear` are inferred by `--report-file`; an explicit `--report` works with any filename.

## Deadlines and partial synthesis

Long free-model runs should not stall CI or a pre-commit hook:

```bash
consilium --deadline 180000 --diff "Review the current changes"
```

`--deadline <ms>` caps the expert phase (max 24 h; `deadlineMs` in config). When it fires, in-flight experts are cancelled, finished answers are kept, and the chair synthesizes them with an explicit note: how many experts finished and which roles are missing. `metadata.deadline` = `{ limitMs, hit, completed, missing }`. If no expert finished, the chair is skipped and the run fails with `errorCode: DEADLINE` (exit 1); a partial run with at least one expert succeeds.

## Debate rounds

`--rounds 2` adds a second expert round: each expert sees anonymized peer answers (A/B/C), critiques errors and omissions, and states a final position. The chair receives the final positions plus a note listing which experts changed their position; `metadata.debate = { rounds, participants, changed }`.

```bash
consilium --rounds 2 --preset deep "Design the migration plan"
```

Round 2 doubles model calls, so it is opt-in and skipped when fewer than two experts succeeded, when the deadline has fired, or when `--max-cost` is already exceeded. Round 2 continues each expert's session and findings are collected from the final answers. The first-round answer is included for the expert in its own second-round prompt; peer answers are anonymized and marked as data.

## Evaluation harness (`consilium eval`)

Prove the council catches more than a single model, deterministically:

```bash
consilium eval --fixtures eval/fixtures --json
consilium eval --fail-under 70        # exit 3 below 70% catch rate
consilium eval --max-cost 0.50        # stop when the budget is exhausted
```

Each fixture is a task, a small diff with a planted bug, and an `expected.json` (`mustFind` / `mustNotFind` claim substrings, optional `file`, `category`, `minSeverity`). Matching is a normalized claim substring check — no LLM judge — so results are reproducible. The report shows per-fixture caught/missed/false positives, aggregate catch and FP rates, p50 latency and cost. **Twenty-two seed fixtures** ship in [`eval/fixtures`](eval/fixtures), covering injection, authorization, concurrency, reliability, SSRF/path traversal, data integrity, pagination/caching and prompt injection; add your own next to them.

The corpus is production; benchmark numbers must come from a real model run (CI has no model credentials). [`eval/README.md`](eval/README.md#results) documents the exact commands and deliberately ships no invented table; [`docs/eval-results.md`](docs/eval-results.md) is the reporting template for a measured run. Generate the report from recorded JSON with:

```bash
npm run eval:report -- --compare eval-compare.json --date 2026-11-10 --commit <sha>
```

Compare a single pass with debate rounds on the same fixtures:

```bash
consilium eval --compare-rounds
consilium eval --rounds 2 --json
```

`--compare-rounds` runs every fixture twice (one and two rounds) and prints a delta table for catch rate, false-positive rate, p50 latency and total cost, with a verdict. `--fail-under` gates the debate catch rate; `--max-cost` covers both runs.

## History and stats

```bash
consilium history --limit 10       # recent runs: success, cost, findings, agreement
consilium stats                    # success rate, p50/p95, cost, per-model errors
consilium stats --html stats.html  # self-contained static report
```

`history` reads `.consilium/runs/<id>/run.json` newest first (corrupt runs are skipped with a warning). `stats` aggregates success rate, latency percentiles, total cost, findings by severity and contested count, per-model attempts/errors and the top failure codes. Both support `--json`; `stats --html` writes an escaped, script-free page.

## Auditing a commit range

```bash
consilium audit --since v1.7.0 --fail-on high
consilium audit --since HEAD~5 --dry-run
```

`audit` builds an untrusted diff for `<ref>...HEAD`, runs the council on it, and reuses reports, artifacts and the policy gate. `--dry-run` prints the ref, file count and truncation flag without calling models; `--since` is required and validated (no shell metacharacters). Schedule it from cron, Task Scheduler or CI — there is no built-in daemon.

## Running on a schedule

[`docs/scheduling.md`](docs/scheduling.md) has ready recipes for cron, Windows Task Scheduler, launchd and GitHub Actions, using `consilium audit --since <ref>` with `--deadline` and `--max-cost`. Runnable wrappers live in [`examples/consilium-audit.sh`](examples/consilium-audit.sh), [`examples/consilium-audit.ps1`](examples/consilium-audit.ps1) and [`examples/consilium-audit-nightly.yml`](examples/consilium-audit-nightly.yml). The workflow example is deliberately outside `.github/workflows/`, so nothing runs automatically in this repository.

## OpenCode V2 plugin

A native plugin that runs the council **inside the OpenCode V2 TUI**, no MCP or external CLI — via the `consilium.run` tool. It does not work in V1 (the V1 plugin API is incompatible).

```json
{
  "plugins": [{ "package": "lv24-opencode-consilium" }]
}
```

The server part is published as `./server` (`dist/plugin.js`); no runtime dependencies (`@opencode/plugin` is types-only). The tool accepts `task`, `experts`, `chair`, `timeout_ms`, `consensus`, `smart_experts`, `max_cost`, `fallback_models`, `session`, `artifacts`, `preset`.

| Way | When |
| --- | --- |
| Plugin (`consilium.run`) | Inside the OpenCode V2 TUI, advice in the conversation |
| MCP server | External harnesses (Claude Desktop, Codex, Cursor, VS Code, custom agents) |
| CLI | Terminal, scripts, CI, hooks, watch |

### Slash command (OpenCode V2)

The repository includes `.opencode/commands/council.md`, so `/council <task>` asks the current agent to run the council on your task. It calls the `consilium.run` plugin tool and falls back to the MCP `consilium_run` tool when the plugin is not loaded.

- **Project:** `.opencode/commands/council.md` (already in this repository).
- **Global:** copy the file to `~/.config/opencode/commands/council.md`.
- **Usage:** `/council Review the authentication design`.
- **Requires:** the [V2 plugin](#opencode-v2-plugin) **or** the [MCP server](#use-it-from-any-harness-mcp) to be registered. Without either, the agent reports what is missing instead of running a council.

V1 note: OpenCode V1 reads the singular `command/` directory (`.opencode/command/`, `~/.config/opencode/command/`) and has no V2 plugin API. Copy the file there and use the MCP server or CLI fallback.

## GitHub Action

A composite action reviews a pull request diff, posts or updates exactly one comment with the `<!-- consilium:report -->` marker, and uploads findings to GitHub code scanning as SARIF by default:

```yaml
permissions:
  contents: read
  pull-requests: write
  security-events: write   # required for the SARIF upload

- uses: LevapVeeskela/lv24-opencode-consilium/.github/actions/consilium@v1.12.1
  with:
    fail-on: high
    github-token: ${{ github.token }}
    read-only: true          # default; false passes --allow-write
    sarif: true              # default; set false to skip SARIF
```

It runs `consilium --diff --base origin/<base> --artifacts --read-only --report pr --report-file consilium-review.md --fail-on <level>`, comments once, exports `consilium sarif --run latest` and uploads it with `github/codeql-action/upload-sarif`, then propagates the gate exit code (`3`). SARIF and upload failures never mask the gate. Fork PRs are skipped by default because no secrets are available; pin the npm version with the `version` input. It runs on your runner — no hosted app, no paid service. Full guide: [`docs/github-action.md`](docs/github-action.md).

## Presets

| Preset | Experts | Behaviour |
| --- | --- | --- |
| `fast` | arch, sec | 3 min expert timeout, no retries |
| `deep` | all four | doubled timeouts, retries enabled |
| `security` | sec, arch, ba | security-focused review |
| `review` | arch, sec, ux | code review |
| `free` | all four | for a free-model bootstrap |

Custom presets live in `consilium.config.json` and merge over the built-ins:

```json
{
  "presets": {
    "docs": { "description": "Documentation review", "experts": ["arch", "ba"] }
  }
}
```

`consilium presets` lists the merged set (`--json` for scripts); `--preset docs` works in the CLI, MCP `consilium_run` and the V2 plugin. A custom preset can override a built-in name; its fields replace the built-in ones.

## Configuration

Config discovery in the current directory: `consilium.config.json`, `consilium.json`, `.consiliumrc`, `.consiliumrc.json`. Use `-c` for an explicit path. JSONC comments are allowed in `opencode.json`/`opencode.jsonc`.

```json
{
  "experts": [
    { "name": "arch", "model": "opencode/flint-40b-free" },
    { "name": "sec",  "model": "opencode/iceman-free" }
  ],
  "chair": {
    "agent": "consilium",
    "model": "opencode/beam-free"
  },
  "retry": { "maxConcurrency": 3 }
}
```

| Key | Default | Notes |
| --- | --- | --- |
| `experts[].model` | — | `provider/model`; passed as `--model`, overrides the agent's model |
| `chair.model` | — | Chair model override |
| `timeouts.expert` / `.chair` | 300000 / 600000 | Per attempt, ms |
| `retry.expertRetries` / `.chairRetries` | 1 | `0` = single attempt |
| `retry.jitter` | `false` | Randomized retry delay (50–100%) so experts don't hit the limit together |
| `retry.maxConcurrency` | 3 | 1–8 parallel agents |
| `output.file` | `false` | `false` disables saving; a string enables it |
| `standalone` | `true` | Private server; avoids port conflicts when OpenCode is already running |
| `autoApprove` | `false` | Config-only; auto-approves permissions. Ignored from project config unless `-c` |
| `autoDiscoverAgents` | `true` | Reuse agents from `opencode.json` |
| `artifacts` | `false` | `true` → `.consilium/runs/<id>/`; a string sets a custom directory |
| `consensus` | `false` | Lexical expert-agreement analysis |
| `smartExperts` | `false` | Heuristically pick 2–3 roles |
| `maxCost` | — | Cost limit in USD (number >= 0) |
| `fallbackModels` | — | Array of `provider/model` strings for model-error retries |
| `session` | — | Base OpenCode session id |
| `report` | — | Report format: `html`, `pr`, `markdown`, `sarif`, `jira`, `linear` |
| `reportFile` | — | Report file path (`.html`/`.md`/`.sarif`/`.jira`/`.linear` picks the format) |
| `variant` | — | Model variant for models without `#variant` (explicit variants win) |
| `debounceMs` | 400 | Watch-mode delay, ms |
| `findings` | `false` | Structured findings block in expert/chair answers |
| `context` | `off` | `auto` adds changed files, project rules, related tests and commits to the task |
| `deadlineMs` | — | Expert-phase budget in ms (max 24 h); partial synthesis on timeout |
| `rounds` | `1` | `2` = anonymized peer-review round; doubles model calls |
| `localOnly` | `false` | Require an explicit local model for every agent |
| `readOnly` | `false` | Restrict experts/chair to read/glob/grep; `audit` forces it unless `--allow-write` |
| `isolate` | `false` | Run each agent in a managed git worktree under `.consilium/worktrees` (requires git) |
| `presets` | — | Custom presets merged over the built-in set |
| `opencodePath` | `opencode` | Custom CLI path (ignored from project config unless `-c`) |
| `cwd` | current | Working directory for OpenCode (ignored from project config unless `-c`) |

Full schema: [`schema/config.schema.json`](schema/config.schema.json) · example: [`consilium.config.example.json`](consilium.config.example.json).

## Library API

```ts
import { Consilium, runConsilium, fetchFreeModels, selectCouncilModels } from 'lv24-opencode-consilium';

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

`Consilium` instances are reusable: `run()` can be called again after a completed, failed or cancelled run. `cancel()` stops all child processes of the current run.

## How it works

For every expert and the chair, Consilium spawns:

```text
opencode run --standalone --format json [--auto] [--agent=NAME] [--model=provider/model]
```

The prompt goes to the child's **stdin** (UTF-8), so arbitrary task text is safe and never hits shell or command-line limits. NDJSON events are decoded incrementally (`text`, `step_finish` usage/cost, `error` with `type`/`status`/`retryAfterMs`). The model is always passed as `--model`, so behavior is identical on V1 and V2 where `--agent` does not apply the configured model. Exit codes, stderr tails and structured errors become typed `errorCode`s (`RATE_LIMITED`, `MODEL_UNAVAILABLE`, `AGENT_NOT_FOUND`, …). If an agent name is missing, the call is retried once with the same model on the default agent — the run keeps working without persona agents. Read-only runs temporarily add a project `.opencode/opencode.json` layer with deny permissions; isolated runs execute the child with the cwd set to a managed worktree.

## Security

- Task text is never interpolated into a shell command — it is passed via stdin.
- Agent names and model IDs are validated before use.
- **Project config is untrusted by default.** A repo's `consilium.config.json` may define models, experts, prompts and presets, but process/path keys — `opencodePath`, `opencodeArgs`, `autoApprove`, `cwd`, `opencodeConfigPath`, string `output.file`, `reportFile`, string `artifacts` — are ignored with a warning. Pass the file explicitly with `-c` to trust it.
- **Read-only runs** write a temporary `.opencode/opencode.json` layer with deny permissions, hold `.consilium/read-only.lock`, and restore the original bytes on success, error, cancellation and `process.exit`. Invalid JSON, an existing `.opencode/opencode.jsonc`, or a symlinked layer fails closed. Other interactive sessions in the same project see the temporary restrictions while the run is active.
- **`--isolate`** creates a managed git worktree per agent under `.consilium/worktrees`, includes tracked uncommitted changes, does not copy untracked files, and removes the worktree after the call; read-only rules are applied inside each worktree. A conservative stale cleanup handles crashed runs.
- **Windows:** `.cmd`/`.bat` shims run through `cmd.exe` only after every argument passes a strict allowlist (no quotes, `%`, `!`, `^`, `&`, `|`, `<`, `>`, whitespace); `.exe` and POSIX binaries are spawned directly.
- **MCP:** `tools/call` requires an `id`, the queue is capped at 16, `output_file` and artifact paths are confined to the workspace, and `consilium_init_free` writes `.bak` files and requires `confirm: true` together with `force`.
- `autoApprove` (auto-approve permissions) is **off** by default; never enable it for untrusted prompts or tools.
- `--standalone` isolates the child server; no port takeover.
- Artifacts redact common token patterns and `.consilium/.gitignore` is created automatically, so runs are not committed by accident.
- API keys are never printed or written by Consilium; `doctor` only checks whether expected environment variables are present, and OpenCode handles auth.
- `doctor` warns about missing keys and risky configuration.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `OpenCode CLI не найден` | `npm install -g opencode-ai` or set `opencodePath` |
| `Model unavailable` | Model rotated out/region-blocked; run `consilium models --verify --refresh` |
| `Agent not found` | Persona agent missing; Consilium falls back to the default agent + your model. Add agents via `consilium init --free` |
| Timeouts | Free models can be slow; raise `--expert-timeout` or use `--preset fast` |
| `RATE_LIMITED` / 429 | Free-model quota exhausted; the error shows the retry delay. Switch model/provider |
| Agent model ignored on V2 | Consilium already passes `--model`; run `consilium doctor` (`opencode-v2-compat`) |
| `COST_LIMIT` | Chair skipped by design; expert opinions and consensus are in the partial result, spend in `metadata.cost.byAgent` |
| Fallbacks still hit 429 | Spare models often share free quotas; switch providers or wait for the retry delay |
| Sessions pile up in `session list` | By design: each agent owns a session; clean up with `opencode session delete <id>` |
| `replay` can't find the id | Ids resolve under `.consilium/runs/`; check the directory or pass that run's `--artifacts-dir` |
| MCP server missing on V2 | Flat `mcp.<name>` is ignored; run `consilium mcp --install --force` |
| `Managed service port ... in use` | Keep `standalone: true` (default) |
| Empty result | `consilium doctor`, then rerun with `-V` |

## Changelog

**1.12.1** — Python MCP launcher and isolation hardening. `pip install lv24-opencode-consilium` now also installs the `consilium-mcp` console script, which starts the same stdio MCP server through `npx --yes --package lv24-opencode-consilium@<version> consilium-mcp`; arguments, environment and exit codes are forwarded, and `python -m lv24_opencode_consilium.mcp` is supported. `--isolate --read-only` now fails fast with CLI exit `2` when the repository has `.opencode/opencode.jsonc` (rename it to `.opencode/opencode.json` or use `--allow-write`) instead of failing inside every agent. Worktree cleanup is canonicalized and never treats a live worktree as unregistered when git reports a macOS `/private/var` or Windows 8.3/long path; Linux, Windows and macOS cleanup tests run via the manual `worktree-tests` workflow. 601 JavaScript tests (2 platform-skipped) + 16 Python tests.

**1.12.0** — managed isolation and MCP replay. `--isolate` now creates a Consilium-managed git worktree per agent under `.consilium/worktrees`, based on HEAD plus tracked changes, applies the read-only overlay inside each worktree, and removes it after every call; stale worktrees are cleaned conservatively and non-git projects fail before any model call. MCP gains `consilium_replay`, restoring a saved task/models/options and streaming progress through `progressToken`. The eval harness gets `npm run eval:report`, which validates recorded `eval --json`/`--compare-rounds --json` output and renders `docs/eval-results.md` without inventing numbers. 588 JavaScript tests + 9 Python tests.

**1.11.0** — read-only and isolated runs, MCP artifact tools, ticket reports and a larger eval corpus. `--read-only` restricts experts and the chair to read/glob/grep through a temporary `.opencode/opencode.json` layer with lock, backup and byte-exact restore; `audit` and the GitHub Action are read-only by default, and `--allow-write` opts out. `--isolate` runs each agent in an OpenCode worktree. MCP gains `consilium_list_runs`, `consilium_get_run`, `consilium_sarif` and `consilium_diff_runs`; `--report jira|linear` renders Jira wiki/Linear Markdown. V1 `tools`/`permission` now migrate to ordered V2 rules. The eval corpus grows to 22 fixtures; benchmark numbers are generated by a real run, not committed. 561 JavaScript tests + 9 Python tests.

**1.10.0** — PyPI distribution and SARIF upload in the GitHub Action. `pip install lv24-opencode-consilium` installs a thin, dependency-free `consilium` launcher that delegates to the npm CLI via `npx` (Node.js >= 18 and OpenCode remain prerequisites; npm stays canonical). PyPI publishing uses Trusted Publishing (OIDC) from `.github/workflows/pypi-publish.yml`, so a GitHub release publishes npm and PyPI without tokens or OTP. `consilium sarif --run <id|latest> [--output <file>]` exports SARIF from saved artifacts without re-running the council; the composite action now passes `--artifacts`, exports SARIF and uploads it with `github/codeql-action/upload-sarif` (`sarif`, `sarif-file`, `category` inputs; `security-events: write` required), and SARIF failures never mask the gate. 522 JavaScript tests + 5 Python tests.

**1.9.0** — SARIF export, debate evaluation and scheduler recipes. `--report sarif` emits SARIF 2.1.0 (severity mapping, file/line locations, stable fingerprints, rule ids per category) for GitHub code scanning and other SARIF viewers; `.sarif`/`.sarif.json` extensions are inferred. `eval --compare-rounds` runs every fixture with one and two rounds and prints catch/FP/p50/cost deltas; `eval --rounds 2` runs the suite in debate mode. `docs/scheduling.md` plus cron, Task Scheduler, launchd and GitHub Actions examples make commit-range audits schedulable without a daemon. 515 tests.

**1.8.0** — debate rounds, local bootstrap and commit-range audits. `--rounds 2` adds an anonymized peer-review round: each expert critiques the others and states a final position; the chair sees the final positions plus which experts changed, and `metadata.debate` records participants and changes. `consilium init --local` probes Ollama/LM Studio, assigns local models round-robin to every role and the chair, and writes a `localOnly` config. `consilium audit --since <ref>` reviews a commit range end-to-end, reusing reports, artifacts and `--fail-on`; `--dry-run` prints the request without model calls. 491 tests.

**1.7.0** — deadlines and privacy. `--deadline <ms>` caps the expert phase: stragglers are cancelled, the chair synthesizes the finished experts with a missing-roles note, and a run with zero completed experts fails with `DEADLINE`. `--local-only` requires an explicit local model (Ollama, LM Studio, llama.cpp, vLLM) for every agent; `models --local` filters the catalog and `models --probe-local` reports whether local providers are running; `doctor` adds a `local-providers` check. Custom presets in `consilium.config.json` merge over built-ins and work in CLI, MCP and the plugin (`consilium presets` lists them). The trusted-config marker now survives object spreads. 446 tests.

**1.6.0** — evaluation harness, context pack, reliability memory and a GitHub Action. `consilium eval` runs planted-bug fixtures with deterministic claim matching and reports catch/FP/p50 latency/cost (`--fail-under` exits `3`). `--context auto` adds changed files, the nearest `AGENTS.md`, related tests and recent commits under a char budget. Model outcomes and latency are stored in `.consilium/reliability.json` (`models --reliability`). A composite GitHub Action runs a PR diff review and posts/updates one comment. Fuzzy claim merging deduplicates paraphrased findings. `consilium history` and `consilium stats` summarize runs, latency and per-model reliability. 381 tests.

**1.5.0** — structured findings and a policy gate. `--findings` makes experts and the chair return a validated `findings[]` JSON block (`severity`, `category`, `file`, `line`, `claim`, `evidence`, `confidence`); findings are deduplicated by a stable fingerprint, merged across roles, marked `contested` when the chair rejects them, and stored in `metadata.findings`. HTML and PR reports render the findings table and the dissent ledger. `--fail-on <severity>` gates on **new** findings with exit code `3`; `consilium baseline accept|prune` manages `.consilium/baseline.json`. Also: P1 correctness fixes (config V1/V2 precedence, malformed-config warnings, model cache fallback/`minContext`/dedupe, cost telemetry, SIGKILL escalation, `ses_` session prefix, CLI `argv[0]` parsing, watch rerun/signals, preset/consensus/smart-experts edge cases) and the `/council` slash command. 317 tests.

**1.4.3** — security hardening. Project config is untrusted by default: `opencodePath`, `opencodeArgs`, `autoApprove`, `cwd`, `opencodeConfigPath` and string write paths are ignored unless the file is passed with `-c`. Windows `.cmd` spawning validates every argument; `.exe` spawns directly. MCP rejects id-less tool calls, caps the queue, confines output/artifacts to the workspace, and `init_free` makes backups and requires confirmation for `force`. Dynamic diff fences and report escaping block prompt/markdown injection; artifacts redact tokens and get a `.gitignore`. 246 tests.

**1.4.2** — internal refactor into layers (`shared`, `domain`, `application`, `infrastructure`, `interfaces`) with slice barrels. No API or behavior changes: the public export surface is identical to 1.4.1 across all 22 subpaths. Product README, [`llms.txt`](llms.txt) and [`docs/architecture.md`](docs/architecture.md); ru/zh docs synced; `dist` is cleaned before every build. 224 tests.

**1.4.1** — npm package renamed to `lv24-opencode-consilium` (npm cannot rename in place; `opencode-consilium@1.0.2` stays deprecated). npm page shows this README; translations moved to `docs/`. Container image published to GHCR. No functional changes.

**1.4.0** — `--report html|pr|markdown` and `--report-file`; `--variant high`; `consilium watch`; `consilium hooks install|uninstall`; native OpenCode V2 plugin (`consilium.run`); `--replay` restores chair/expert models and run flags; new config keys `report`, `reportFile`, `variant`, `debounceMs`; 224 tests.

**1.3.0** — run artifacts + `--replay`/`--diff-runs`; `--consensus`; `--smart-experts`; `--max-cost`; `--fallback-models`; `--session`; MCP args for all of the above.

**1.2.0** — OpenCode V2 support while keeping V1: dual config sections, `.opencode/` and parent-dir merge, `--model` always passed, `mcp.servers` install, `--native-v2`, `RATE_LIMITED` retry policy, `doctor` V2 checks.

## Roadmap

| Idea | Value | Size |
| --- | --- | --- |
| Publish measured eval results for the 22 fixtures | Catch/FP/p50/cost proof on a real provider; generator is ready | M |
| MCP replay from custom artifact roots | Re-run artifacts saved outside `.consilium/runs` with the same confinement guarantees | S |

1.12.1 shipped the `.opencode/opencode.jsonc` fail-fast preflight and cross-platform worktree cleanup coverage; 1.12.0 shipped managed read-only worktrees, MCP replay and the eval report generator.

## Development

```bash
npm install
npm run build       # tsc
npm test            # build + node:test (601 tests, 2 platform-skipped)
npm run typecheck   # tsc --noEmit
python -m unittest discover -s python/tests   # 16 launcher tests
```

Layout, layer rules, barrels and extension guides (new CLI command / MCP tool / config key): [`docs/architecture.md`](docs/architecture.md). Release process (Trusted Publishing, tags, GHCR): [`docs/releasing.md`](docs/releasing.md).

## License

MIT
