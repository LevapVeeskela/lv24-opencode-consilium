# Architecture

`lv24-opencode-consilium` is a TypeScript ESM package (`module`/`moduleResolution`
set to `NodeNext`), so every relative import ends in `.js`. Source lives in
`src/`; compiled output in `dist/`; tests are plain `.mjs` files under `test/`
and import from `dist/`.

## Layer map

| Layer | Location | Responsibility |
| --- | --- | --- |
| shared | `src/shared/` | Dependency-free primitives used by every layer: JSON record checks (`record.ts`), error text extraction (`errors.ts`), and atomic file writing (`fs.ts`). No business logic. |
| domain | `src/domain/` | Entities, config types, defaults, and pure policies: council (`presets`, `variants`, `consensus`, `fallback`, `smart-experts`, `prompts`, `sessions`), models (`catalog`, `ranking`, `sources`, `verify`), artifacts (`artifacts/*`, `replay`, `report`), diagnostics (`checks`, `doctor`, `report`). |
| application | `src/application/` | Use cases and orchestration: `Consilium` (`consilium.ts`), the run pipeline (`run.ts`), and prompt/usage helpers (`helpers.ts`). It coordinates domain policies and infrastructure adapters. |
| infrastructure | `src/infrastructure/` | Adapters to the outside world: config loading/merging/validation (`config/`), OpenCode CLI process control (`opencode/`), git (`git.ts`), and filesystem watching (`watch.ts`). |
| interfaces | `src/interfaces/` | Delivery mechanisms: CLI (`cli/`), MCP stdio server (`mcp/`), and the OpenCode plugin (`plugin/`). They parse input, call application services, and format output. |

Domain currently contains a few direct `fs`/`path` calls (`domain/artifacts/artifacts/store.ts`,
`domain/models/sources.ts`, `domain/diagnostics/checks/config.ts`). Treat these as
known debt: new file, process, or network I/O belongs in `infrastructure/`.

## Dependency direction

```
interfaces ──> application ──> domain
      │              │
      └──────────────┴──────> infrastructure ──> domain
every layer ──> shared
```

- `shared` imports nothing from the other layers.
- `domain` imports only `shared`.
- `application` may import `domain` and `infrastructure` (it loads config and
  starts OpenCode runs), never `interfaces`.
- `infrastructure` may import `domain` types/helpers, never `application` or
  `interfaces`.
- `interfaces` may import `application`, `domain`, and `infrastructure`. One
  entry-point composition is intentional: `cli/main.ts` imports
  `interfaces/mcp/mcp.ts` to serve the `mcp` command.
- `interfaces/mcp/handlers/shared.ts` is a slice-local helper, not part of the
  `src/shared/` kernel.
- Never import another slice's internals; use its barrel. Avoid cycles: shared
  code moves down a layer, not sideways.

## Barrels and compatibility shims

- Each layer and slice has an `index.ts` barrel: `shared/index.ts`,
  `domain/index.ts`, `application/index.ts`, `infrastructure/index.ts`,
  `interfaces/cli/index.ts`, `interfaces/mcp/index.ts`,
  `interfaces/plugin/index.ts`.
- `interfaces/cli/cli.ts` is the CLI slice's public entry and exports exactly
  `parseArgs` and `main`. `interfaces/mcp/mcp.ts` is the MCP slice entry.
- The files directly under `src/` are compatibility shims kept for the package
  `exports` map: each one re-exports its implementation, e.g. `src/mcp.ts` →
  `./interfaces/mcp/mcp.js`, `src/config.ts` → `./infrastructure/config/config.js`,
  `src/agents.ts` → `./infrastructure/opencode/agents.js`. Add new public
  subpaths the same way rather than moving implementations back to `src/`.
- `src/index.ts` is the public library API and exports `application/consilium.js`.
- `src/cli.ts` is both a shim and the executable compatibility entry: it
  re-exports `interfaces/cli/cli.js` and auto-runs `main()` only when
  `process.argv[1]` resolves to its own module file. `bin/cli.js` imports it and
  calls `main` explicitly, so the guard stays false there.

## Adding a CLI command

1. Extend the `command` union in `CLIOptions` (`domain/types.ts`) and add the
   name to `COMMANDS` in `interfaces/cli/args.ts`.
2. Parse the command's flags in `parseArgs` (`interfaces/cli/args.ts`) into
   `CLIOptions`; throw `UsageError` for invalid input.
3. Create `interfaces/cli/commands/<name>.ts` exporting
   `command<Name>(options: CLIOptions): Promise<number>`; return the exit code.
4. Add the `case '<name>'` to the switch in `interfaces/cli/main.ts`.
5. Document flags in `interfaces/cli/help.ts`; reuse printers from
   `interfaces/cli/output.ts`.
6. Add coverage in `test/cli.test.mjs` (tests run against `dist/`).

## Adding an MCP tool

1. Append an `McpToolDef` to `MCP_TOOLS` in `interfaces/mcp/tools.ts`
   (`MCP_TOOL_NAMES` and `getMcpTools()` derive from it automatically).
2. Implement the handler in `interfaces/mcp/handlers/<name>.ts`, returning
   `McpToolResult` from `handlers/shared.js`; validate input with
   `interfaces/mcp/validation.ts` helpers and call application services.
3. Route it in the `executeTool` switch in `handlers/dispatch.ts` and export it
   from `handlers/index.ts` when it is part of the slice API.
4. Wrap failures with `toolError(...)`; `executeTool` already catches exceptions.
5. Add coverage in `test/mcp.test.mjs`.

## Adding a config key

1. Add the field to `ConsiliumConfig` in `domain/types.ts` (and to `CLIOptions`
   if a flag overrides it).
2. Set its default in `DEFAULT_CONFIG` (`domain/defaults.ts`).
3. Handle it in `infrastructure/config/load.ts`: `cloneConfig` and
   `mergeWithDefaults` for nested objects/arrays, plus a warning in
   `validateConfig` when the value is out of range.
4. For a CLI flag, parse it in `interfaces/cli/args.ts`, apply it in
   `interfaces/cli/overrides.ts`, and document it in `help.ts`. Work on the
   already-cloned config; never mutate `DEFAULT_CONFIG`.
5. Update `consilium.config.example.json`, `schema/config.schema.json`, and
   `generateExampleConfig()` in `infrastructure/config/generate.ts`.
6. Read the value from `application/` code (usually `Consilium`), not from
   interface code, so every entry point gets the same behavior.

## Verification

Run from the repository root:

```
npm run build      # tsc -> dist/ (required by the .mjs tests)
npm test           # build, then node --test "test/*.test.mjs"
npm run typecheck  # tsc --noEmit (same check as npm run lint)
```
