# Agent notes

Consilium is a TypeScript ESM CLI/library plus a thin Python launcher. Keep the
npm package canonical; PyPI only ships the launcher.

## Repository map

- `src/shared/` — primitives (fs, errors, paths, record).
- `src/domain/` — types, council logic, findings, eval, artifacts/SARIF.
- `src/application/` — use-cases (`Consilium`, run, eval, history, audit).
- `src/infrastructure/` — OpenCode spawn/config, artifacts, model catalog.
- `src/interfaces/` — CLI, MCP server, OpenCode V2 plugin.
- `python/` — `lv24-opencode-consilium` PyPI launcher (delegates via `npx`).
- `eval/fixtures/` — deterministic planted-bug fixtures.
- `docs/` — user and release documentation; ru/zh READMEs live here.

## Commands

```bash
npm install
npm run build       # tsc -> dist
npm test            # build + node:test
npm run typecheck   # tsc --noEmit
npm run eval:report -- --compare eval-compare.json   # render a measured eval report
python -m unittest discover -s python/tests
python -m build     # in python/, for PyPI
```

## Invariants

- No runtime dependencies in the npm package; Node >= 18.
- `.js` extensions in TypeScript imports (NodeNext).
- Public API: keep historical subpath exports working; additive changes only
  unless a major release is planned.
- Project config is untrusted: process/path keys require explicit `-c`.
- Experts must not write outside the project; read-only runs enforce deny
  permissions through the OpenCode config.
- Version is single-sourced: `package.json`, `python/pyproject.toml`,
  `python/src/lv24_opencode_consilium/__init__.py`, version literals and
  `test/version-consistency.test.mjs`.
- Do not commit `dist/`, `python/dist/`, `node_modules/`, `.consilium/`.

## Releases

See [`docs/releasing.md`](docs/releasing.md). A GitHub release publishes npm and
PyPI through Trusted Publishing (OIDC); the container image is dispatched
manually. Update README/ru/zh/llms and the changelog in the same release.
