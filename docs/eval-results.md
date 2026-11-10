# Evaluation results

The repository ships the **22-fixture** corpus in [`eval/fixtures`](../eval/fixtures)
and the deterministic harness described in [`eval/README.md`](../eval/README.md).
The harness does not call an LLM judge.

## Status

No model benchmark numbers are committed. The release environment used for
1.11.0 had no usable model provider (the configured providers returned region
or quota errors), and CI deliberately runs no model calls. Publishing a table
from a stub or from a different model set would be misleading, so this file
ships the reproducible procedure and the corpus coverage instead.

The previous 1.9.0 release added the single-vs-debate comparison; the harness
is ready. A results table must be produced by a real run and reviewed before it
is added here.

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

# Single pass over all 22 fixtures
node bin/cli.js eval --json > eval-single.json

# Single vs debate (rounds 1 and 2) on the same fixtures
node bin/cli.js eval --compare-rounds --json > eval-compare.json

# Optional gate: exit 3 below 80% catch rate
node bin/cli.js eval --fail-under 80
```

An installed package uses `consilium eval` instead of `node bin/cli.js eval`.
The JSON contains per-fixture `caught`, `missed`, `falsePositives`,
`catchRate`, `falsePositiveRate`, `latencyMs`, `cost`, plus the aggregate
summary and `errors`.

## Reporting template

Replace the `—` cells only with values from a real run; keep the exact model
set and date next to the table.

| Metric | Single pass | Debate (2 rounds) | Delta |
| --- | ---: | ---: | ---: |
| Catch rate | — | — | — |
| False-positive rate | — | — | — |
| p50 latency | — | — | — |
| Total cost | — | — | — |

Include the model IDs, provider, date, commit and the exact command in the
same document. Do not compare runs with different fixtures or model sets.
