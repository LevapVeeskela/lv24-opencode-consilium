# Evaluation results

The repository ships the **22-fixture** corpus in [`eval/fixtures`](../eval/fixtures)
and the deterministic harness described in [`eval/README.md`](../eval/README.md).
The harness does not call an LLM judge.

## Status

No model benchmark numbers are committed. The environment used to prepare this
file has no usable model provider (the configured providers returned region or
quota errors), and CI deliberately runs no model calls. Publishing a table from
a stub or from a different model set would be misleading, so this file ships the
reproducible procedure and the corpus coverage instead.

The single-vs-debate comparison and the automated report generator are in place.
A results table must be produced by a real run and reviewed before it is added
here. When that happens, [`scripts/eval-report.mjs`](../scripts/eval-report.mjs)
writes the metrics directly from the recorded JSON; no values are edited by
hand.

## Corpus coverage

| Fixtures | Area |
| --- | --- |
| 01–10 | Seed corpus from 1.6.0: correctness, security, UX, architecture, docs, tests |
| 11 | SQL injection through `ORDER BY` |
| 12 | Authorization bypass on an admin route |
| 13 | Race condition in coupon redemption |
| 14 | Unbounded retry / retry storm |
| 15 | Missing cancellation propagation |
| 16 | SSRF through a webhook URL |
| 17 | Path traversal in ZIP extraction |
| 18 | Data-loss migration (dropped column) |
| 19 | Broken pagination |
| 20 | Incorrect cache invalidation |
| 21 | Prompt injection inside a diff |
| 22 | Error swallowing in async code |

## Producing real numbers

```bash
npm install
npm run build

# Full run: single and debate over the same 22 fixtures
node bin/cli.js eval --compare-rounds --json > eval-compare.json

# Optional single-only run
node bin/cli.js eval --json > eval-single.json

# Optional gate: exit 3 below 80% catch rate
node bin/cli.js eval --fail-under 80
```

An installed package uses `consilium eval` instead of `node bin/cli.js eval`.
The JSON contains per-fixture `caught`, `missed`, `falsePositives`,
`catchRate`, `falsePositiveRate`, `latencyMs`, `cost`, plus the aggregate
summary and `errors`.

## Automated reporting

[`scripts/eval-report.mjs`](../scripts/eval-report.mjs) is dependency-free and
lives in the repository checkout. It validates the JSON shape, reads
`eval/fixtures` for the coverage table and renders the markdown report. It
aborts before writing when a required field is missing, so it cannot publish
placeholder or estimated numbers.

```bash
# Full single-vs-debate report; writes docs/eval-results.md by default.
node scripts/eval-report.mjs --compare eval-compare.json \
  --date 2026-11-10 --commit <sha> --version <version>

# Single-run report.
node scripts/eval-report.mjs --single eval-single.json

# Validate only; print a summary and write nothing.
node scripts/eval-report.mjs --check --compare eval-compare.json

# Equivalent npm script.
npm run eval:report -- --compare eval-compare.json
```

The generated report contains the date/commit/version header, the exact eval and
report commands, the aggregate single/debate/delta table, per-fixture metrics,
missed findings, false positives, runner errors and the on-disk fixture count.
Use `--out <file>`, `--date <YYYY-MM-DD>`, `--commit <sha>`, `--version <version>`
and `--fixtures <dir>` to override the defaults.

The eval JSON does not record model or provider ids. Keep the configured expert
set next to the report, and do not compare runs with different fixtures, models
or provider settings.

## Fallback template

The generator is the canonical path. If it cannot be used, fill this table only
from a real run and keep the date, commit, model set and exact command next to
it. Never replace the dashes with estimates.

| Metric | Single pass | Debate (2 rounds) | Delta |
| --- | ---: | ---: | ---: |
| Catch rate | — | — | — |
| False-positive rate | — | — | — |
| p50 latency | — | — | — |
| Total cost | — | — | — |
