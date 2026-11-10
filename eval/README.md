# Consilium evaluation fixtures

This directory contains the self-contained corpus used by the deterministic
eval harness. The harness does **not** call an LLM judge: it runs a review
runner (the real council or an injected stub) and checks the returned
`Finding[]` against the phrases planted in each fixture.

The corpus currently has **22 fixtures**. It covers injection, authorization,
concurrency, reliability, SSRF and path traversal, data integrity,
pagination/caching and prompt injection.

## Layout

```text
eval/fixtures/<fixture-name>/
  task.md        # review request shown to the council
  changes.diff   # unified diff containing the planted bug
  expected.json  # mustFind / mustNotFind signatures
```

Fixture directories are loaded in lexicographic order, so a run is reproducible
across machines. `changes.diff` is optional for a task that needs no diff;
every fixture in the current corpus includes one.

## `expected.json`

```json
{
  "mustFind": [
    {
      "claimIncludes": ["sql injection", "untrusted order by"],
      "file": "src/db/users.ts",
      "minSeverity": "high"
    }
  ],
  "mustNotFind": [
    {
      "claimIncludes": "the default sort should remain created_at"
    }
  ]
}
```

- `mustFind` is required and must be a non-empty array. `mustNotFind` is
  optional and defaults to `[]`.
- Every entry must set at least one of `claimIncludes`, `file`, `category` or
  `minSeverity`; an empty filter would match every finding.
- `claimIncludes` may be a string or an array of alternatives. Each alternative
  is compared as a case-insensitive substring against `normalizeClaim(claim)`,
  so punctuation, quotes and repeated whitespace do not matter. This is a
  substring check, not a regex or an LLM judgement.
- `file` is the most robust signal: paths are lowercased, `\` is treated as
  `/`, a leading `./` is ignored, and a finding may use a longer root-relative
  path.
- `category` is an exact case-insensitive match. Models often use descriptive
  categories, so prefer `file` + `minSeverity` unless the category is known.
- `minSeverity` is optional. The finding severity must be at least this level
  (`critical` > `high` > `medium` > `low` > `info`).
- All filters in one entry are ANDed; one finding may satisfy several
  `mustFind` entries.
- `mustNotFind` entries use the same shape. A finding that matches one is
  counted as a false positive. Keep these claims clearly benign or out of scope
  so they measure noise rather than legitimate extra findings.

The 12 fixtures added for 1.11.0 deliberately rely on `claimIncludes` + `file` +
`minSeverity`. That keeps them language-neutral and robust to descriptive
category names; `category` remains supported by the loader and matcher.

## Running the eval

Prerequisites: Node.js 18+ and a configured `consilium.config.json` with
models that can review code. From a checkout:

```bash
npm install
npm run build
```

Run the bundled corpus with the real council:

```bash
# equivalent to the installed `consilium eval`
node bin/cli.js eval

# debate mode: one anonymized peer-review round before the chair
node bin/cli.js eval --rounds 2

# run every fixture twice (rounds=1 and rounds=2) and print the delta table
node bin/cli.js eval --compare-rounds

# machine-readable summary
node bin/cli.js eval --json

# machine-readable single-vs-debate comparison
node bin/cli.js eval --compare-rounds --json
```

When the package is installed, replace `node bin/cli.js` with `consilium`:

```bash
consilium eval
consilium eval --rounds 2
consilium eval --compare-rounds
consilium eval --json
```

Useful options:

| Option | Effect |
| --- | --- |
| `--fixtures <dir>` | Use another fixture directory (default `eval/fixtures`) |
| `--rounds <1\|2>` | Number of debate rounds for every fixture (default `1`) |
| `--compare-rounds` | Run the same fixtures with one and two rounds; mutually exclusive with `--rounds` |
| `--json` | Print the summary or comparison as JSON instead of markdown |
| `--fail-under <pct>` | Exit `3` when the catch rate is below the percentage (debate catch rate in compare mode) |
| `--max-cost <usd>` | Stop the suite when the accumulated cost reaches the budget (both runs in compare mode) |

`--compare-rounds` prints a `single` / `debate` / `delta` table and also lists
errors for each run. A failed fixture runner still counts as a miss and does
not abort the suite. Exit code `3` is the eval policy gate; usage errors are
`2`.

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

## Results

No model benchmark numbers are stored in this directory. Catch rate, latency
and cost depend on the exact model set, provider availability and date, so any
published table must come from a real run rather than an estimate.

To produce a result set, run:

```bash
npm run build
node bin/cli.js eval --json > eval-single.json
node bin/cli.js eval --rounds 2 --json > eval-debate.json
node bin/cli.js eval --compare-rounds --json > eval-compare.json
```

Record the date, fixture count, configured experts and model ids next to the
JSON output. Re-run on the target machine instead of reusing another machine's
numbers.

## Adding a fixture

1. Create a directory named `<number>-<short-category>` under `eval/fixtures/`.
2. Write a short `task.md` that gives the reviewer enough context, including
   the security or correctness property that must hold.
3. Add a small unified diff (roughly 5–15 changed lines) with exactly one
   planted bug. Keep unrelated code boring so a finding points at the bug.
4. Add `expected.json` with a distinctive `claimIncludes` phrase (or a few
   alternatives), the affected `file` and a realistic `minSeverity`. Add one
   benign `mustNotFind` phrase for noise when useful.
5. Update the corpus table below and the fixture count in
   `test/eval.test.mjs` when the total changes.

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
| `11-sql-injection-order-by` | SQL injection | sort column/direction interpolated into `ORDER BY` |
| `12-authz-bypass-admin` | authorization bypass | `x-internal` header bypasses the admin role check |
| `13-race-condition-coupon` | race condition | check-then-act coupon redemption is not atomic |
| `14-unbounded-retry` | unbounded retry | `while (true)` retries a failed delivery forever |
| `15-missing-cancellation` | missing cancellation | batch loop ignores `ctx.cancelled` |
| `16-ssrf-webhook` | SSRF | webhook host allowlist replaced by a syntax check |
| `17-path-traversal-zip` | path traversal | zip entry name joined without a containment check |
| `18-data-loss-migration` | data loss | legacy email column dropped before backfill |
| `19-broken-pagination` | broken pagination | offset cursor with unstable ordering skips/duplicates rows |
| `20-cache-invalidation` | cache invalidation | profile update leaves `profiles:all` stale |
| `21-prompt-injection-diff` | prompt injection | diff comment tries to redirect the reviewer and leak `.env` |
| `22-error-swallowing-async` | error swallowing | notification catch logs and returns success |
