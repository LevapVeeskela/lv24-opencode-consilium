# Consilium evaluation fixtures

This directory contains the small, self-contained corpus used by the
deterministic eval harness. The harness does **not** call an LLM judge: it runs
an injected review runner and checks the returned `Finding[]` against the
phrases planted in each fixture.

## Layout

```text
eval/fixtures/<fixture-name>/
  task.md        # review request shown to the council
  changes.diff   # optional unified diff containing the planted bug
  expected.json  # mustFind / mustNotFind signatures
```

Fixture directories are loaded in lexicographic order, so a run is reproducible
across machines. `changes.diff` may be omitted for a task that needs no diff.

## `expected.json`

```json
{
  "mustFind": [
    {
      "file": "src/api/projects.ts",
      "minSeverity": "high"
    }
  ],
  "mustNotFind": [
    {
      "claimIncludes": "the response should use status 204"
    }
  ]
}
```

- `file` is the most robust signal and is recommended for every fixture: paths
  are lowercased, `\` is treated as `/`, a leading `./` is ignored, and a finding
  may use a longer root-relative path.
- `minSeverity` is optional. The finding severity must be at least this level
  (`critical` > `high` > `medium` > `low` > `info`).
- `claimIncludes` is optional and may be a string or an array of alternatives.
  Each alternative is compared as a case-insensitive substring against
  `normalizeClaim(finding.claim)`, so punctuation, quotes and repeated whitespace
  do not matter. Omit it when the model may answer in another language — the
  council's default prompts are Russian, so file + severity is language-neutral.
- `category` is optional and must match the finding category case-insensitively.
  Models often use descriptive categories, so prefer `file` + `minSeverity`.
- `mustNotFind` entries use the same shape. A finding that matches one is
  counted as a false positive. Keep these claims clearly benign or
  out-of-scope so they measure noise rather than legitimate extra findings.

## Metrics

For each fixture the matcher reports:

- `caught` — `mustFind` entries with at least one matching finding.
- `missed` — `mustFind` entries with no match.
- `falsePositives` — `mustNotFind` entries that a finding matched.
- `catchRate` — `caught / (caught + missed)`; `0` when there is nothing to find.
- `falsePositiveRate` — `falsePositives / (caught + falsePositives)`; `0` when the
  denominator is empty.

The suite summary aggregates those counts, reports the p50 latency (the mean of
the two middle values for an even number of fixtures), totals runner cost, and
lists runner errors. A fixture whose runner throws still counts as a miss.

## Adding a fixture

1. Create a directory named `<number>-<short-category>` under `eval/fixtures/`.
2. Write a short `task.md` that gives the reviewer enough context.
3. Add a 5–15 line unified diff in `changes.diff` with exactly one planted bug.
4. Add `expected.json` with one distinctive `mustFind` phrase a reviewer would
   naturally use, plus one benign `mustNotFind` phrase for noise.
5. Add the fixture to the stub runner scenario in `test/eval.test.mjs` if the
   suite-level behavior changes.

## Current corpus

| Fixture | Category | Planted bug |
| --- | --- | --- |
| `01-authz-idor` | authz / IDOR | project lookup drops the owner filter |
| `02-sql-injection` | injection | search term interpolated into SQL |
| `03-off-by-one` | off-by-one | page end index excludes the last item |
| `04-race-condition` | race condition | stale read-modify-write on the balance |
| `05-secret-leak` | secret leak | raw request headers are logged |
| `06-path-traversal` | path traversal | user filename joined without containment check |
| `07-n-plus-one` | N+1 | one customer query per order |
| `08-missing-validation` | missing validation | client body inserted without schema validation |
| `09-unsafe-deserialization` | unsafe deserialization | untrusted webhook payload passed to `unserialize` |
| `10-error-swallowing` | error swallowing | catch block reports success on payment failure |
