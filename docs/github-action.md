# Consilium GitHub Action for pull request reviews

A composite GitHub Action that runs the Consilium council on a pull request
diff, posts or updates **one** sticky review comment, and can fail the job when
new findings reach a severity threshold.

It is designed to be zero-spend:

- The action runs on the caller's GitHub Actions runner.
- It installs the public npm package and, if needed, the OpenCode CLI.
- It talks only to the GitHub API and the model provider you already use.
- There is no hosted Consilium app, no GitHub App installation, and no paid
  Consilium service.

You still pay for GitHub Actions minutes according to your plan, and model
providers may apply quotas or charges. See [Cost and quotas](#cost-and-quotas).

## Files

| Path | Purpose |
| --- | --- |
| `.github/actions/consilium/action.yml` | Composite action: setup, install, run, comment, gate |
| `.github/actions/consilium/comment.mjs` | Node 20 ESM script that creates or updates the PR comment |
| `examples/consilium-review.yml` | Example caller workflow. **Not enabled by default** |

The example deliberately lives under `examples/`. GitHub Actions only runs
workflows under `.github/workflows/`, so copying the repository does not start
any review or spend any quota.

## Requirements

- A GitHub Actions runner with `bash` (`ubuntu-latest` is recommended).
- Outbound network access to npm, the GitHub API, and your model provider.
- `actions/checkout` with `fetch-depth: 0`, so the base branch is available for
  `git diff`.
- An authenticated OpenCode CLI and at least one model configuration.
  - The action installs `opencode-ai` when `opencode` is not on `PATH`, but it
    does not authenticate it for you.
  - Provide credentials through repository or environment secrets, for example
    `OPENCODE_API_KEY` or `OPENROUTER_API_KEY` (Settings -> Secrets and
    variables -> Actions), or configure the provider key your OpenCode setup
    expects. A self-hosted runner can also use its existing OpenCode login.
  - For predictable reviews, commit a `consilium.config.json` with the models
    and experts you want. Generate it locally with
    `consilium init --free` (or `npx -y lv24-opencode-consilium init --free`)
    and review the generated files before committing them. The action does not
    run `init` automatically because it writes project files and probes models.
- `pull-requests: write` for the comment. See [Permissions](#permissions).
- `security-events: write` when SARIF upload is enabled (the default), and code
  scanning must be enabled for the repository. See
  [SARIF and code scanning](#sarif-and-code-scanning).

## Installation

### Option A: use the action from this repository

Pin the action to a commit SHA (recommended) or a release tag:

```yaml
- name: Run Consilium
  uses: LevapVeeskela/lv24-opencode-consilium/.github/actions/consilium@<full-commit-sha>
  with:
    version: '1.12.0'
  env:
    OPENCODE_API_KEY: ${{ secrets.OPENCODE_API_KEY }}
```

Replace `<full-commit-sha>` with the commit you reviewed. If the repository is
private, the caller workflow must have access to it.

### Option B: vendor the action

Copy `.github/actions/consilium/` into the caller repository and use a local
path. This is what `examples/consilium-review.yml` does:

```yaml
- name: Run Consilium
  uses: ./.github/actions/consilium
  with:
    fail-on: high
  env:
    OPENCODE_API_KEY: ${{ secrets.OPENCODE_API_KEY }}
```

For a local action, check out the repository before the `uses` step.

### Minimal workflow

```yaml
name: Consilium PR review

on:
  pull_request:

permissions:
  contents: read
  pull-requests: write
  security-events: write

jobs:
  review:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: ./.github/actions/consilium
        with:
          fail-on: high
          comment: 'true'
        env:
          OPENCODE_API_KEY: ${{ secrets.OPENCODE_API_KEY }}
```

## Inputs and outputs

| Input | Default | Description |
| --- | --- | --- |
| `task` | Review instructions | Task passed to Consilium. Defaults to a focused correctness/security/regression review. |
| `base` | empty | Git ref to diff against. Empty means `origin/<github.base_ref>`. The action validates the ref before running. |
| `fail-on` | `none` | Gate threshold: `critical`, `high`, `medium`, `low`, `info`, or `none`. |
| `comment` | `true` | Post or update the sticky comment. `false` still applies the gate. |
| `github-token` | `${{ github.token }}` | Token for the comment API. Needs `pull-requests: write`. |
| `node-version` | `20` | Node.js version used by the action. |
| `max-cost` | empty | Optional soft cost cap in USD, passed to `--max-cost`. |
| `read-only` | `true` | Pass `--read-only`: experts may only read/glob/grep; write/edit/shell/subagent/MCP tools are denied. Set to `false` to pass `--allow-write`. |
| `version` | `latest` | npm version of `lv24-opencode-consilium` to install. Pin an exact version for reproducibility. |
| `sarif` | `true` | Export findings as SARIF 2.1.0 and upload them to GitHub code scanning. Requires `security-events: write` and code scanning enabled for the repository. Set to `false` to skip both SARIF steps. |
| `sarif-file` | `consilium.sarif` | Path to the generated SARIF file, relative to the workspace or absolute. |
| `category` | `consilium` | Category passed to `github/codeql-action/upload-sarif`, so several SARIF reports can coexist in one repository. |

Outputs:

| Output | Description |
| --- | --- |
| `exit-code` | Consilium CLI exit code (`0`, `1`, `2`, or `3`). |
| `report-file` | Absolute path to `consilium-review.md` in the workspace. |

When `fail-on` is not `none` or `sarif` is `true`, the action adds
`--findings` automatically. The CLI requires structured findings for the gate
and for a non-empty SARIF report; without this, the gate would exit `2` before
producing a report.

## Permissions

The workflow needs at least:

```yaml
permissions:
  contents: read
  pull-requests: write
  security-events: write
```

`contents: read` lets `actions/checkout` fetch the repository and lets the
action compute the diff. `pull-requests: write` allows listing issue comments
on the PR and creating or updating the Consilium comment. `security-events:
write` is required only for SARIF uploads (the default `sarif: true`); remove it
when `sarif: false`.

Set permissions at the workflow or job level. If your organization sets a
restricted default `GITHUB_TOKEN` policy, grant `pull-requests: write` and
`security-events: write` in the workflow or repository settings. The action does
not need `contents: write`, `issues: write`, `actions: write`, or a personal
access token.

The `github-token` input defaults to `${{ github.token }}`. Prefer that scoped
token to a long-lived PAT. A PAT is only useful if your organization's policy
prevents the workflow token from commenting, and it increases the blast radius
if leaked.

## Comment behavior

Consilium writes a GitHub-ready report with `--report pr --report-file
consilium-review.md`. The report ends with the hidden marker:

```html
<!-- consilium:report -->
```

`comment.mjs`:

1. Reads `GITHUB_EVENT_PATH` and takes `pull_request.number`.
2. Lists the PR's issue comments and looks for the marker.
3. `PATCH`es the existing comment, or `POST`s a new one.
4. Caps the body at about 60,000 characters. The marker and a truncation note
   are preserved, so the next run still finds and updates the same comment.
5. Treats `403` and `404` as warnings and exits `0`. This covers missing
   `pull-requests: write`, read-only fork PR tokens, deleted PRs, and rate
   limits. Other comment/API/network failures are also warnings so they cannot
   hide the review gate.
6. Never logs `GITHUB_TOKEN`.

The script posts only on pull request events. If the event has no
`pull_request.number`, it warns and exits `0`.

Set `comment: false` to run the review and enforce the gate without touching the
PR. The action skips the script when `comment` is not `true` or when
`github-token` is empty, and the gate still runs.

Comment failures do not turn a passing review into a failing job, and they do
not replace exit code `3`. If the comment matters for branch protection, monitor
the workflow warnings or add a separate check for the comment step's outcome.

## Read-only reviews

The action enables `--read-only` by default. The review can read files, glob and
grep, but cannot write, edit, patch, run a shell, fetch the web, launch
subagents or call MCP tools. This is enforced with a temporary project
`.opencode/opencode.json` layer that is restored after the run; an existing
`.opencode/opencode.jsonc` fails closed.

Set `read-only: false` to pass `--allow-write` when a workflow intentionally
lets the council modify the workspace. The effective policy is recorded in
`metadata.safety` and in the run artifacts.

## SARIF and code scanning

The review run always writes artifacts with `--artifacts`, so
`.consilium/runs/<id>/run.json` exists. When `sarif` is `true` (the default), the
action also adds `--findings` so `run.json` contains `metadata.findings`.

After the review, the action:

1. Runs `consilium sarif --run latest --output consilium.sarif` (or the path in
   `sarif-file`). This step uses `continue-on-error: true`.
2. Uploads the file with `github/codeql-action/upload-sarif`, passing
   `sarif_file` and `category`. This step also uses `continue-on-error: true`.

Both SARIF steps are independent of the gate. A missing permission, a disabled
code scanning setup, or an upload failure produces a warning or a failed step,
but it does not replace exit code `3` and does not turn a passing review into a
failing job. The comment and gate steps still run.

Requirements for SARIF upload:

- `security-events: write` on the workflow or job.
- Code scanning must be enabled for the repository. Public repositories can use
  code scanning directly; private repositories may require GitHub Advanced
  Security depending on your plan. If code scanning is unavailable, set
  `sarif: false` and keep the review comment and gate.
- On fork pull requests the token is read-only, so uploads fail; that is
  expected and does not affect the gate.

Use a Consilium package version that includes the `consilium sarif` command. If
the example pins an older version, either upgrade it or set `sarif: false`.

The SARIF file contains every finding from the run. Findings accepted in
`.consilium/baseline.json` still appear there; the baseline only changes the
gate result. Use `consilium sarif` locally to inspect the same document:

```bash
consilium sarif --run latest --output consilium.sarif
```

## Fork pull request caveat

Pull requests from forks do **not** receive repository secrets, and GitHub gives
their workflow a read-only `GITHUB_TOKEN`. That means:

- `OPENCODE_API_KEY`, `OPENROUTER_API_KEY`, and other model credentials are
  unavailable, so Consilium usually cannot run.
- The comment API returns `403` (or `404` in some configurations). The script
  warns and exits `0`; the action still applies the review gate.
- The example workflow skips fork PRs with:

  ```yaml
  if: >-
    github.event.pull_request.draft == false &&
    github.event.pull_request.head.repo.full_name == github.repository
  ```

Do not switch to `pull_request_target` just to obtain secrets while checking out
and running untrusted pull request code. That combination is a well-known
secret-exfiltration risk. If you need fork reviews, use a separately designed
trusted workflow, require maintainer approval before exposing credentials, or
run on a self-hosted runner with an explicit security boundary. Consilium
reviews a diff and does not execute pull request code, but the workflow, project
config, and installed dependencies are still part of your trust boundary.

A maintainer can also run the review manually from a trusted branch after
reviewing the diff.

## Cost and quotas

The action itself is free software and uses no paid Consilium backend. The main
costs are:

- **GitHub Actions minutes.** Public repositories get free minutes; private
  repositories consume the plan's included minutes. A review can take several
  minutes because it waits for multiple models.
- **Model provider usage.** Free models may be rate-limited or time out. If you
  configure paid models, their provider bills you directly.
- **npm downloads.** The action installs the Consilium package and, when
  missing, the OpenCode CLI. This is ordinary npm traffic, not a paid service.

`max-cost` is a **soft** cap. Consilium tracks reported spend and skips the chair
when the expert phase exceeds the limit, returning a partial result. It cannot
stop a provider from charging more if the provider does not report cost; in that
case Consilium warns that the limit cannot be verified. Treat it as a guardrail,
not a hard budget. Start with free models and a small `max-cost` while testing.

## Gate behavior and exit code 3

Exit codes come from the Consilium CLI:

| Code | Meaning |
| --- | --- |
| `0` | Review completed and the gate passed. |
| `1` | The review run failed. |
| `2` | Usage error, invalid input, or missing base ref. |
| `3` | Policy gate failed: new findings at or above `fail-on` remain. |

The gate compares findings with `.consilium/baseline.json`. Fingerprints in the
baseline are accepted and ignored. To accept known findings, run locally:

```bash
consilium baseline accept latest
```

Commit `.consilium/baseline.json` if the whole team should share the accepted
set. Otherwise every PR starts with an empty baseline.

The action order is deliberate:

1. Run Consilium and capture its exit code with `set +e`.
2. Write `consilium-review.md`.
3. Export `consilium.sarif` and upload it when `sarif` is `true`.
4. Post or update the comment.
5. Re-exit with the captured code.

A failing gate therefore never skips the comment or the SARIF upload. A failing
comment or SARIF upload never replaces the gate code. If `comment: false` is
set, the review, report, SARIF, and gate steps still run.

`fail-on` levels, from most to least severe: `critical`, `high`, `medium`, `low`,
`info`. The default `none` disables the gate and keeps the job green. To make the
gate blocking in branch protection, require the workflow check and keep the
threshold meaningful for your repository.

## Pinning versions

Three things can move independently:

1. **The action ref.** Pin `uses:` to a full commit SHA (or a reviewed release
   tag) instead of `@main`.
2. **The npm package.** Pass an exact `version`, for example `1.12.0`, instead
   of the default `latest`.
3. **The OpenCode CLI.** The action installs `opencode-ai@latest` only when
   `opencode` is not already on `PATH`. To pin it, install a specific version in
   an earlier step:

   ```yaml
   - name: Pin OpenCode CLI
     run: npm install --global opencode-ai@1.19.5

   - name: Run Consilium
     uses: ./.github/actions/consilium
     with:
       version: '1.12.0'
   ```

   Also pin `actions/checkout` to a commit SHA in production workflows.

Example remote pin:

```yaml
- uses: LevapVeeskela/lv24-opencode-consilium/.github/actions/consilium@<full-commit-sha>
  with:
    version: '1.12.0'
    fail-on: high
```

Avoid `@main` and `version: latest` for required checks. They make a review
change without a commit in your repository.

## Troubleshooting

### `Base ref 'origin/...' was not found`

The most common cause is a shallow checkout. Set `fetch-depth: 0` on
`actions/checkout`. Make sure the base branch is fetched (a full checkout does
this) or pass it explicitly:

```yaml
with:
  base: origin/develop
```

If the workflow does not run on a `pull_request` event, `github.base_ref` is
empty. Pass `base` explicitly or restrict the action to pull request events.
The action validates `${base}^{commit}` before running and exits `2` with a
clear error if it cannot resolve the ref.

### The comment is missing, or HTTP 403/404

Check:

- The workflow has `pull-requests: write`.
- The PR is not from a fork. Fork PRs use a read-only token and receive no
  secrets.
- Your organization has not restricted `GITHUB_TOKEN` to read-only.
- The run did not hit GitHub API rate limits.
- `comment` is `true` and `github-token` is non-empty.
- `consilium-review.md` exists and contains the report. A missing report is
  reported as a warning, and the gate still runs.

The action logs the HTTP status and a warning but does not fail the job for
comment problems. Inspect the "Post or update the Consilium review comment"
step.

### The comment is not updated

The report must contain `<!-- consilium:report -->`. The action uses
`--report pr`, which writes the marker. If the report is longer than about
60,000 characters, the script truncates it but keeps the marker and a note.
If multiple comments contain the marker, the script updates the first one it
finds.

### `OpenCode CLI` or model errors

The action installs the CLI if it is missing, but it cannot supply credentials
or a model catalog. Check:

- The secret is passed to the action's `env` (for example
  `OPENCODE_API_KEY`).
- A `consilium.config.json` exists with enabled experts and models, or OpenCode
  has a usable default model.
- The provider is reachable from the runner and the model is available in your
  region.
- Run `consilium doctor` locally with the same config.

### The gate fails unexpectedly

Reproduce the review locally with the same command:

```bash
consilium --diff --base origin/main --report pr \
  --report-file consilium-review.md --fail-on high \
  --findings -s "Review this pull request"
```

Check `.consilium/baseline.json` and whether the finding is new. Remember that
`--fail-on` gates only on findings not present in the baseline. Use
`fail-on: none` if you want a comment-only review.

### `max-cost` did not stop the run

The provider may not report cost. Consilium can only enforce the cap from
reported usage; it warns when telemetry is missing. Switch to a provider that
reports cost or use free models with external quota monitoring.

### The action fails during install

Check npm registry access on the runner, Node compatibility, and global install
permissions on self-hosted runners. On a self-hosted runner, preinstall pinned
`lv24-opencode-consilium` and `opencode-ai` versions to avoid network and
permission surprises.

## Security notes

- The token is passed only to `comment.mjs` through `GITHUB_TOKEN`. The script
  never prints it and never writes it to the report.
- Use the default scoped `GITHUB_TOKEN` with `contents: read` and
  `pull-requests: write`; avoid broad PATs.
- Review model output before treating it as authoritative. The report is
  posted as markdown and may contain arbitrary text produced from the diff.
- Do not run untrusted pull request code with repository secrets. The
  `pull_request` trigger plus the example's fork guard avoids that pattern.
- Consilium ignores process/path keys from an untrusted project config unless
  the config is explicitly trusted; keep `autoApprove` off.
- No secrets belong in `.github/actions/consilium/`, `examples/`, or this
  document. Use repository or environment secrets in the caller workflow.
