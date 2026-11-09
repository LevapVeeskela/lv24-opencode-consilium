# Audit and roadmap — 2026-11-09

Audit of `lv24-opencode-consilium@1.4.2` (commit `1b347fd`): security, correctness,
data delivery, public API/tests/packaging, product opportunities, plus two live
experiments — tool parity for council experts and MCP interoperability with
non-OpenCode harnesses.

## Method

- 5 parallel audit agents (security, core correctness, artifacts/reports/MCP, API/tests/packaging, product), each with file:line evidence and repros where practical.
- Live tool-parity test on the `opencode-go` subscription: `deepseek-v4.1-flash`, `glm-5.3-flash`, `muse-spark-1.3-contributor`; 9 inference sessions total.
- Live MCP test with the official `@modelcontextprotocol/sdk` client over stdio.
- Baseline: `tsc` clean, 224/224 tests, public API identical to npm 1.4.2 on 22 subpaths.

Confidence tags: **[verified]** = reproduced by an agent or in this document;
**[code]** = confirmed by reading the code path, no exploit executed.

## Verdicts

| Area | Verdict |
| --- | --- |
| Security | **Needs a patch release.** Two critical issues (repo-config executable, Windows argument injection) and two high issues (unconfined writes, repo-controlled `autoApprove`). |
| Core correctness | 9 medium + 7 low confirmed defects; retry/spawn core itself is clean. |
| Artifacts/reports/MCP | 1 high (MCP trusts workspace config), 7 medium, 12 low; HTML escaping is solid, PR inline code is not. |
| Public API/tests | Root barrel leaks 102 symbols; 8 core modules have no tests; packaging has drift (maps, version literals, `./server` types). |
| Product | Strong wedge (model-diverse council + free models), but output is prose, not a gate. Top theme: structured findings + baseline + eval. |
| Tool parity | **Conditional yes.** Experts inherit the full OpenCode toolset; the shipped prompts explicitly forbid tool use. Restrictions come from agent config, not Consilium. |
| MCP interop | **Yes.** Works end-to-end with a generic MCP client; Claude Desktop/Codex configs are valid, Cursor/VS Code are undocumented. |

---

## P0 — security patch (target 1.4.3)

| # | Severity | Finding | Evidence | Fix | Effort |
| --- | --- | --- | --- | --- | --- |
| S1 | **critical** | Repo-controlled `consilium.config.json` can set `opencodePath` to an arbitrary executable → code execution on `run`, `doctor`, `mcp --install`, and the installed pre-commit hook. | `spawn.ts:73-92`, `config/load.ts:239-253`, schema allows the key **[verified]** | Accept `opencodePath`/`opencodeArgs` only from user/global config or an explicit CLI flag; `realpath` the binary; reject paths inside the workspace by default. | M |
| S2 | **critical** | Windows: `opencodeArgs` with `"`/`&` breaks out of `cmd /d /s /c` (quote escaping uses `\"`, which cmd does not honor). | `spawn.ts:68-85` **[verified]** | Resolve `.cmd` shims to `node <script>` and spawn without cmd; otherwise reject `" % ! ^ & \| < > CR LF` in args. | S |
| S3 | **high** | Repo config `output.file`, `reportFile`, `artifacts` can write outside the repo (absolute paths, symlink/junction escape). Same for MCP `workspace`. | `run.ts:211-256`, `output.ts:154-191`, `store.ts:36-46`, `handlers/run.ts:91-148` **[verified lexical + symlink repro]** | Resolve against the config dir, require containment after `realpath`, write with `O_NOFOLLOW`/temp+rename; out-of-tree only via explicit CLI. | M |
| S4 | **high** | `autoApprove: true` from a repo config adds `--auto` (unattended tools), while no `--auto` CLI flag exists despite README claims. | `args.ts:43-45`, `args.ts:75-269`, `README.md:448` **[code]** | Honor `autoApprove` only from user/global config or a real `--auto`; hard warn when it comes from the project. | S |
| S5 | **high** | MCP `tools/call` without an `id` bypasses the queue → concurrent councils, racing state and cancel. | `server.ts:136-144`, `dispatch.ts:101-127` **[code]** | Reject id-less tool calls with `-32600`; cap queue bytes and in-flight runs. | S |
| S6 | **high** | MCP handler trusts the workspace config for `opencodePath`/`autoApprove`/paths (same trust boundary as S1/S3). | `handlers/run.ts:155`, `spawn.ts:89-91` **[code]** | Apply the S1/S3 policy at the MCP boundary; ignore project-scope process/path keys unless explicitly enabled. | M |
| S7 | **medium** | `git diff` uses a fixed ``` fence; a changed file can close it and inject instructions into every expert/chair prompt. | `git.ts:97-107` **[code]** | Dynamic fence (as `report.ts:55-59`) + explicit “untrusted data” markers. | S |
| S8 | **medium** | PR report inline code does not handle newlines; an expert error can inject a second `<!-- consilium:report -->` marker and a heading. | `report.ts:62-65,274` **[verified]** | Collapse whitespace or fenced block for multi-line errors. | S |
| S9 | **medium** | MCP `consilium_init_free` can overwrite `opencode.json` / config without confirmation; prompt-injected agent can rewrite definitions. | `handlers/init-free.ts:86,95-96` **[code]** | Require `apply:true` + a confirmation token; `.bak`; refuse `force` over MCP. | M |
| S10 | **medium** | Secrets persist unredacted in `.consilium/runs` (task, prompts, 500-char stderr tail). | `run.ts:278-300`, `store.ts:142` **[code]** | Redact token patterns; generate/append `.consilium/` to `.gitignore`; `artifacts --redact`. | S |
| S11 | **low** | Predictable temp names in atomic writes; symlink-following `writeFileSync`; ANSI/OSC terminal injection; markdown link injection in PR reports; unbounded model-catalog response. | `shared/fs.ts:18-21`, `output.ts:55-143`, `report.ts:247-263`, `sources.ts:284-303` | `randomUUID` + `flag:'wx'` + `mode:0o600`; strip C0/C1 on TTY text; escape `[]()`; 8 MiB response cap + redirect allowlist. | S |

**P0 acceptance criteria**

- Project-scope config cannot choose a binary, redirect writes outside the repo, or enable `--auto`; covered by tests with a temp repo.
- Windows spawn rejects unsafe args and `.cmd` resolution is tested.
- MCP rejects id-less/queued-duplicate calls; one active council per server.
- Diff/report injection tests reproduce the attacks and assert they are neutered.

---

## P1 — correctness (target 1.5.0)

| Area | Defect | Evidence | Fix | Effort |
| --- | --- | --- | --- | --- |
| Config | Project `agent` override loses to global `agents`; `duplicated` false warning. | `config/opencode.ts:91`, `compat/agents.ts:108-111` **[verified]** | Merge per agent name across both keys in layer order. | M |
| Config | Malformed project `opencode.json` silently ignored when a global config parses. | `opencode.ts:172-182` **[verified]** | Surface per-file parse errors in `loadConfig`/`doctor`. | S |
| Config | Explicit `chair.model` overwritten by discovered `opencode.json`. | `load.ts:346-354` **[verified]** | Fill only when the user config has no model. | S |
| Config | `excludedAgents: {}` throws a raw `TypeError`; `new Consilium('typo.json')` silently uses defaults. | `load.ts:332`, `consilium.ts:52-63` | Array validation; throw on explicit-path errors. | S |
| Models | Total network failure overwrites a good cache with builtins; cached fallback branch is unreachable. | `sources.ts:458-488` **[verified]** | Append builtins after fallback; don't cache when all sources fail. | S |
| Models | `minContext` applied from cache but bypassed on fresh fetch. | `sources.ts:396` vs `:479-493` **[verified]** | Apply the filter in final ranking. | S |
| Models | Cost telemetry missing → fabricated `cost: 0`, defeats `--max-cost`. | `calls.ts:65`, `run.ts:178-186` **[verified]** | Track `costKnown`; don't sum unknown as zero. | S |
| Models | Dedupe can keep an unavailable provider copy over an available one. | `ranking.ts:152-168,202-204` **[verified]** | Prefer `available` in the dedupe key. | S |
| Runner | Timeout SIGKILL escalation timer is cleared on settle → SIGTERM-ignoring child survives; session reused by chair. | `spawn.ts:262-275`, `controller.ts:143-149` **[code]** | Don't clear the kill timer on timeout; clear on `close`. | S/M |
| Runner | `RATE_LIMITED` without exact `retryAfterMs` is never retried. | `retry.ts:78-85` **[needs repro]** | Fall back to configured delay for `status:429`. | S |
| Runner | Timeouts > 2 147 483 647 ms overflow → immediate timeout. | `retry.ts:47-53` | Clamp. | S |
| Sessions | Any base starting with `ses` is accepted; README requires `ses_`. | `council/sessions.ts:26,48` **[verified locally]** | Require `ses_`. | S |
| Init | `init --free` with 3–4 models can omit the chair agent while config points at `consilium`. | `ranking.ts:263-274`, `commands/init.ts` **[verified]** | Cap `chairIndex`; always emit the chair agent. | S |
| CLI | A task whose first word is a command (`consilium models should…`) is misparsed. | `args.ts:260-264` | Command only at `argv[0]`. | S |
| CLI | `--no-artifacts` changes the replay lookup root; custom artifacts dirs can't be replayed. | `commands/run.ts:46-53` **[code]** | Compute the read root from config. | S |
| Artifacts | Case-sensitive dedupe loses an expert on Windows/macOS (`Arch`/`arch`). | `store.ts:120-129` **[verified]** | Lowercase dedupe. | S |
| Artifacts | ID collision is TOCTOU; partial run leaves an unlisted directory. | `store.ts:106-142` | Atomic `mkdir` with EEXIST retry; temp dir + rename. | M |
| Reports | Report file written non-atomically; unknown extensions default to HTML. | `output.ts:181-191` | `writeFileAtomic`; explicit fallback/warn. | S |
| Watch | Trigger during an active run is dropped; edits are never reviewed. | `commands/watch.ts:116,126-131` **[verified]** | `pendingRerun` flag. | S |
| Watch | SIGINT handlers registered after the first run → Ctrl+C leaks children. | `commands/watch.ts:140-149` | Register before the first run. | S |
| Watch | `#!/usr/bin/env bash` is rejected by the non-shell hook check. | `watch.ts:342-355` **[verified]** | Handle `env`/`-S`. | S |
| Presets | `applyPreset` replaces experts with the preset list; custom experts can yield “no active experts”. | `presets.ts:78-83` **[verified]** | Merge/keep config experts on empty intersection. | S |
| Consensus | One expert reports `agreement: high, 100%`; zero experts reports low/0% instead of “no data”. | `consensus.ts:156-185` | `null`/dedicated states for <2 experts. | S |
| Smart experts | Unknown/auto-discovered roles score 0 and are picked by config order. | `smart-experts.ts:217-250` **[verified]** | Fall back to all experts or derive keywords. | M |
| Fallback | Chain hard-capped at 2 regardless of configured length. | `calls.ts:175` | Pass the configured limit. | S |
| MCP | Progress `total` ignores smart/disabled filtering → jumps. | `handlers/run.ts:179-181` | Compute from the selected council. | S |
| MCP | Cancel only matches the active run; queued request later executes. | `server.ts:128-134` | Track cancelled ids. | S |
| Watch | `--chair`/`--list-agents` ignored in watch mode. | `commands/watch.ts:104-105` | Pass `RunOptions`. | S |

---

## P2 — product roadmap (1.6+)

Theme: **from advice to gate** — structured findings, a baseline policy and an
eval harness that proves the council catches more than one model.

### 1. Structured findings contract + dissent ledger (M)

Experts end with a validated `findings[]` block (severity, category, file, line,
claim, evidence, confidence). Merge by stable fingerprint, vote across roles,
keep `contested`; persist the minority positions and render “rejected and why”
in the chair section and reports. Fall back to prose on parse failure.

**Why first:** unlocks gates, inline PR comments, SARIF, comparable runs, and
gives the council's disagreement a product surface. Reuses `prompts.ts`,
`run.ts`, `consensus.ts`, `report.ts`, artifacts.

### 2. Baseline + policy gate (S/M)

`.consilium/baseline.json` with line-independent fingerprints; `--fail-on
high|medium|any`; `baseline accept|prune`; wire into `hooks install` and the PR
report. Makes the existing pre-commit hook enforceable instead of “anything
failed”.

### 3. `consilium eval` harness (M)

20–30 fixtures with planted bugs and clean hunks; deterministic must-catch /
must-not-flag signatures (no LLM judging); report catch rate, false positives,
contested rate, latency and cost per model set. Publish the table in the README.
This is the evidence the product needs.

### Quick wins (parallel)

| Feature | Value | Effort | Note |
| --- | --- | --- | --- |
| OpenCode slash command | high | S | Ship `.opencode/commands/council.md` → `consilium_run`; `init --commands`. |
| GitHub composite action | high | S/M | `--diff --base --report pr`, one comment with the existing marker; opt-in, no secrets on forks. Do not enable in this repo's CI. |
| Context pack (`--context auto`) | high | S/M | Changed files + nearest `AGENTS.md` + related tests + recent commits, token-budgeted. |
| Model reliability memory | high | S/M | Persist attempts/latency/error codes; reliability factor in ranking; `models --reliability`. |
| Deadline-aware partial synthesis | high (CI) | S | `--deadline` cancels stragglers; chair synthesizes finished experts. |
| Local/privacy mode | medium-high | S/M | Detect Ollama/LM Studio; `privacy` preset refuses non-local models. |
| History/stats | medium | S | `consilium history|stats` over `.consilium/runs` + static HTML index. |
| Debate round (`--rounds 2`) | medium-high | M | Anonymized peer critique, chair sees both rounds. |
| Custom roles/presets | medium-high | S/M | Config-defined presets merged over built-ins; prompt overrides. |

### Explicit non-goals for this cycle

VS Code extension (MCP already reaches it), web dashboard, telemetry backend,
multi-repo workspaces, generic cost-aware routing (free models make quota and
wall-clock the scarce resources, not dollars).

### MCP surface gap

MCP exposes 5 tools but not `replay`, `diff-runs`, `report`, `watch` or `hooks`.
Add `consilium_replay` / `consilium_diff_runs` (read-only artifact tools) if MCP
is positioned as a full remote surface; otherwise document CLI-only features.

---

## P3 — engineering quality

| Item | Finding | Fix | Effort |
| --- | --- | --- | --- |
| Root API | `src/index.ts` re-exports 16 modules → 102 symbols, including internals (`saveArtifact`, `upsertAgents`, `installPreCommitHook`). Every rename is a major bump. | Curate an explicit root export list; internals stay subpath-only. | M |
| Plugin types | `dist/interfaces/plugin/plugin.d.ts` imports `Plugin` from `@opencode/plugin` (devDependency only) → TS2307 for consumers with `skipLibCheck:false`. | `peerDependencies` + `peerDependenciesMeta`, or a structural public type. | S |
| Tests | No tests for `Consilium` lifecycle, `application/run`, `verifyModels`, MCP server/handlers, CLI commands/output, spawn/retry/calls, prompts/sessions, shared. | 10-item shortlist below. | M |
| Version drift | `1.4.2` literals in 6 places; container workflow default still `1.4.1`; `DEFAULT_VERSION`/`config.version` can drift. | Single source from `package.json`; test all copies; update workflow default. | S |
| Packaging | Source maps point to excluded `src` (442 KB unusable); `prepare` missing for git installs; bins not +x in git; `npm test` glob needs Node ≥20 while engines say ≥18. | Ship `src` or `inlineSources`; add `prepare`; `chmod +x`; fix test glob or engines. | S |
| Schema/example | Schema allows `output.file: true` (TS: string/false); unknown keys ignored; no `default`s; example pins rotating free models and differs from `generateExampleConfig()`. | One builder, `oneOf`, unknown-key warning, `$schema` URL, drift test. | M |
| Types | `RunOptions.preset` is `string`; `metadata` untyped; defaults are mutable singletons. | Preset union, typed metadata, frozen defaults. | S |
| Errors | Public error surface is `errorMessage()`; `ToolInputError` unexported; `run()` throws plain `Error`. | Error classes with stable codes; map to exit codes. | M |
| Docs | README claims `--auto` (missing), “types-only” (conflicts with plugin types), retry.jitter/debounce defaults not in `DEFAULT_CONFIG`; no `AGENTS.md`. | Fix in the release cycle; add contributor guide. | S |

**Test shortlist (max 10)**

1. `Consilium` lifecycle: run/runSimple/dryRun/onProgress/cancel/hook order/cost-limit; stub `callAgent`.
2. Packaging contract: extract `npm pack`, import all 22 subpaths by bare specifier, assert `default` on `./server`, typecheck a consumer with `skipLibCheck:false`.
3. Version single-source across package/config/MCP/example/llms/workflow.
4. Config ↔ schema parity; unknown key warns; `output.file:true` rejected.
5. Artifact store: full-shape rejection, id collision, Windows separators.
6. `startMcpServer` with fake streams: framing, 4 MiB cap, cancel, queue ordering, console redirect.
7. All five MCP tools with malicious/invalid args.
8. CLI commands end-to-end in temp dirs (init/doctor/hooks/stdin/`-f json`).
9. `verifyModels` concurrency/timeout/error classification.
10. Cross-platform: `\`/`C:\`/UNC paths, CRLF `.git` file, direct `bin/cli.js`.

---

## Tool parity: do experts have normal agent tools?

**Verdict: conditional yes.** Consilium passes no tool or permission flags; it
spawns `opencode run` with `--agent` and `--model` only. Experts therefore
inherit the full toolset of their OpenCode agent (read, write, edit, bash, glob,
webfetch, subagent), subject to that agent's V1 `tools`/`permission` or V2
`agents.<id>.permissions`.

The shipped default prompts explicitly say “do not call tools, answer with text”,
which is why experts normally look text-only. A custom `prompt` or a task that
requires tools overrides this.

### Evidence (live, opencode-go subscription)

| Test | Agent / model | Tool calls | Result |
| --- | --- | --- | --- |
| Consilium from a dir without `opencode.json` | fallback `build` / `deepseek-v4.1-flash`, `glm-5.3-flash` | none | Text-only; default prompts forbid tools. |
| Consilium with project agents `arch`/`sec`, task requiring tools | `arch` / `deepseek-v4.1-flash` | `read`, `read`, `shell` — completed | Read two files and `pwd`; correct numbers and cwd. |
| Same | `sec` / `glm-5.3-flash` | `read`, `read`, `shell` — completed | Same evidence. |
| Control `opencode run --agent build` | `build` / same model | `read`, `read`, `shell` | Same behavior. |
| Write/edit probe | `arch` / `deepseek-v4.1-flash` | `write`, `edit`, `read` | File edited to `WORLD`. |
| V1 restriction probe | `arch-ro` with `tools:{write:false,edit:false,bash:false}` | only `read`, `glob` | Restrictions honored; file not created. |

### Risks and recommendations

1. **Parallel experts share one cwd.** Up to `maxConcurrency` experts run in the
   same directory; concurrent write/edit can race. Add `--isolate` (per-expert
   temp worktree) or a read-only default for review tasks.
2. **`autoApprove` removes the only interactive guard.** Same trust issue as S4;
   require explicit user/global opt-in.
3. **A misnamed agent is not a safe fallback:** `arch` missing → default `build`
   agent with full tools. Warn loudly instead of silently upgrading privileges.
4. **V1→V2 migration deliberately drops `tools`/`permission`.** Translating them
   is required before migration; otherwise V2 silently grants full access.
5. **Document the prompt restriction** and provide a `--tools` (or `read-only`)
   policy so users can choose “advice” vs “act” explicitly.

---

## MCP interoperability: other harnesses

**Verdict: yes.** The server speaks standard stdio JSON-RPC 2.0 and works with a
generic MCP client. Live test with `@modelcontextprotocol/sdk`:

| Check | Result |
| --- | --- |
| `initialize` | `serverInfo: {name: lv24-opencode-consilium, version: 1.4.2}` |
| `tools/list` | 5 tools with input schemas |
| `consilium_list_agents` | config + experts + chair + presets |
| `consilium_doctor` | 13 checks, Node/CLI/config/models |
| Unknown method | `-32601 Method not found`, server alive |
| Invalid tool | `-32602 Unknown tool`, server alive |
| Concurrent `tools/call` | both succeed |
| `consilium_run` | completed in ~24 s on `deepseek-v4.1-flash`, 9.8k in / 125 out, cost 0 |
| stdout purity | only JSON-RPC; stderr has the 52-byte startup banner |

### Harness configs

- **Claude Desktop**: documented JSON is valid (`mcpServers.consilium.command/args`).
- **Codex**: documented TOML is valid (`[mcp_servers.consilium] command/args`).
- **Cursor / VS Code**: standard shapes exist (`.cursor/mcp.json`,
  `.vscode/mcp.json`) but are not documented in our README — add snippets.
- **Windows**: prefer `command: "node", args: ["<abs>/bin/mcp.js"]` or
  `cmd /c npx -y …`; bare `npx` may not resolve in GUI clients.
- **Caveats**: long runs need `timeout_ms`; clients that do not send
  `progressToken` get no progress; the workspace-config trust issue (S1/S3)
  applies to every harness.

---

## Release plan

### 1.4.3 — security patch (P0)

Scope: S1–S9 plus the low-cost hardening (S10/S11). No API changes.
Acceptance: new security tests; project-scope config cannot execute or write
outside the repo; Windows spawn test; MCP abuse tests; all existing 224 tests
still green.

### 1.5.0 — correctness + findings contract

Scope: all P1 defects, structured `findings[]` + dissent ledger, baseline +
`--fail-on`, slash command, context pack, deadline-aware synthesis.
Acceptance: findings schema documented; `--fail-on` gates the hook; baseline
round-trip; 20+ new tests; eval fixtures seeded.

### 1.6.0 — proof and distribution

Scope: `consilium eval` with published catch/FP/latency table, GitHub composite
action (opt-in), model reliability memory, local/privacy mode, history/stats.
Acceptance: eval reproducible on a clean machine; README publishes the numbers;
action posts one updating comment on a real PR.

### Parallel quality track

Curate the root API, fix plugin peer types, add the 10-test shortlist, single-source
the version, fix schema/example drift, ship sourcemaps or drop them, add `AGENTS.md`.

---

## Open questions

1. Should project-scope config be allowed to set `opencodePath`/`opencodeArgs` at all (with a warning), or only user/global config + CLI? Recommendation: deny by default, `--allow-project-config` opt-in.
2. Should experts default to read-only tools for review tasks, or keep full tools with prompts as the only guard? Recommendation: read-only default + `--allow-write`.
3. Do we want a `consilium_replay`/`consilium_diff_runs` MCP surface, or keep artifacts CLI-only? Recommendation: add read-only tools in 1.5.0.
4. Is the product goal “advisor” (prose) or “gate” (findings + baseline)? The roadmap assumes gate; if not, the findings contract can be reduced to a severity summary.
