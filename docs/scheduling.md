# Scheduling Consilium audits

`consilium audit --since <ref>` reviews `<ref>...HEAD`, runs the council, saves run artifacts,
and exits `3` when the gate fails. There is no daemon: cron, Task Scheduler, launchd, or CI starts
an ordinary CLI process; no hosted Consilium service or paid Consilium plan is involved. For
uncommitted changes use `consilium --findings --diff --fail-on high "Review the current changes"`.

## Prerequisites

- Node.js 18 or newer, `git`, and a checkout containing the ref you audit (`git fetch --prune`
  first).
- Install the CLI (`npm install --global lv24-opencode-consilium@1.11.0`) or use
  `npx -y lv24-opencode-consilium@1.11.0`. Pin a release you tested; `latest` makes scheduled
  results change under you. The npx examples use `1.11.0` as the pinned placeholder.
- OpenCode must be installed and authenticated: run `opencode auth login`, or provide provider
  keys such as `OPENCODE_API_KEY` or `OPENROUTER_API_KEY` in the scheduler environment. Commit a
  `consilium.config.json` so the same models run every night; verify it with `consilium doctor`.
- `audit --fail-on` enables structured findings automatically; a plain `run` with `--fail-on`
  also needs `--findings` (or `findings: true` in the config). The default `none` never gates.
- Exit codes: `0` passed, `1` run failed, `2` usage/setup error, `3` policy gate failed (new
  findings at or above the threshold). Treat `1` and `2` as failures too, not "no findings".
- Run from the repository root. A full `audit` run writes `.consilium/runs`; add
  `--report sarif --report-file consilium-audit.sarif` (or `--report pr`) for a report.
- `--deadline` is milliseconds (maximum 24 hours; `900000` is 15 minutes). `--max-cost` is a
  soft USD cap based on provider-reported usage.

## Choosing the `--since` ref

| Ref | Example | Use it for |
| --- | --- | --- |
| `origin/main` | `--since origin/main` | Feature branches and pre-merge audits after a fetch. |
| Date-based tag | `--since audit/2026-11-01` | Nightly audits of a long-lived branch; tag the last reviewed commit and move it only after success. |
| Recent history | `--since HEAD~20` | A sliding window on a laptop or a repo without tags. |

`audit` uses a three-dot diff from the merge base; on the default branch `origin/main...HEAD` is
empty when `HEAD` equals `origin/main`, so use a tag or `HEAD~N`. Diffs are capped at 60,000 chars.

## cron (Linux and macOS)

Add this with `crontab -e` (cron uses local time unless your cron supports `CRON_TZ`). It runs at
03:00, appends to a log, and preserves the CLI exit code:

```cron
SHELL=/bin/bash
PATH=/usr/local/bin:/usr/bin:/bin
0 3 * * * cd /srv/app && git fetch --prune --quiet origin && /usr/local/bin/consilium audit --since origin/main --fail-on high --deadline 900000 --max-cost 2.00 --report pr --report-file consilium-audit.md >> /var/log/consilium-audit.log 2>&1
```

`examples/consilium-audit.sh` adds a timestamped log, a `CONSILIUM_SINCE` override, and a lock.
Cron gives the job a minimal environment: use absolute paths, export provider keys in the wrapper
or a sourced file, and keep logs outside the checkout (or in gitignored `.consilium/logs`).

## Windows Task Scheduler

`examples/consilium-audit.ps1` is the wrapper. Register it once in PowerShell:

```powershell
$repo = 'C:\src\app'; $script = 'C:\tools\consilium-audit.ps1'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -WorkingDirectory $repo `
  -Argument ('-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -RepoDir "{1}"' -f $script, $repo)
$trigger = New-ScheduledTaskTrigger -Daily -At '03:00'
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable `
  -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
Register-ScheduledTask -TaskName 'Consilium nightly audit' `
  -Action $action -Trigger $trigger -Settings $settings
```

The wrapper runs `consilium audit --since origin/main --fail-on high --deadline 900000` (plus a
`$2.00` default `-MaxCost`) from the repository, logs output to a timestamped file under
`.consilium\logs`, and exits with the CLI code. Set `-Consilium` to the absolute `consilium.cmd`
path if the task cannot see npm's global bin directory; `*>> C:\logs\consilium-audit.log` is a
quick manual alternative. Register under the account that owns the OpenCode login; add
`-User`/`-Password` only for an unattended account.

## launchd (macOS)

Save a plist as `~/Library/LaunchAgents/com.example.consilium-audit.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.example.consilium-audit</string><key>ProgramArguments</key><array><string>/Users/me/app/examples/consilium-audit.sh</string></array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string></dict>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>3</integer><key>Minute</key><integer>0</integer></dict>
  <key>StandardOutPath</key><string>/Users/me/Library/Logs/consilium-audit.log</string>
  <key>StandardErrorPath</key><string>/Users/me/Library/Logs/consilium-audit.err.log</string>
</dict></plist>
```

Then `chmod +x examples/consilium-audit.sh` and `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.example.consilium-audit.plist`. launchd ignores your shell profile, so
the wrapper or plist must provide `PATH` and any provider keys. Test with
`launchctl kickstart -k gui/$(id -u)/com.example.consilium-audit`.

## GitHub Actions

`examples/consilium-audit-nightly.yml` is a complete workflow. It deliberately lives under
`examples/`: GitHub only runs files in `.github/workflows/`, and this repository does not enable
it. Copy it to `.github/workflows/` in your repository and review secrets and permissions. It
installs OpenCode, runs the published npm package (not the local composite action), checks out
with `fetch-depth: 0`, and uses `contents: read`. Set the optional `CONSILIUM_SINCE` repository
variable to a tag or `HEAD~20` for real nightly coverage on the default branch:

```yaml
on:
  schedule: [{ cron: '0 3 * * *' }]   # UTC
  workflow_dispatch:
permissions: { contents: read }
concurrency: { group: consilium-audit, cancel-in-progress: false }
# see the example for checkout, setup-node, artifact upload, and gate steps
run: >-
  npx -y lv24-opencode-consilium@1.11.0 audit
  --since "origin/${{ github.event.repository.default_branch }}"
  --fail-on high --deadline 900000 --max-cost 2.00
  --report sarif --report-file consilium-audit.sarif
```

The workflow captures the CLI exit code, uploads `.consilium/runs` and the SARIF 2.1.0 report
with `actions/upload-artifact`, then re-exits with that code. Use `--report pr --report-file
consilium-audit.md` instead if you want a human-readable report; older releases without SARIF
support need the Markdown form. Scheduled workflows run only from the default branch; in a fork
they stay disabled until enabled, and secrets are not copied from the parent repository. Fork
pull requests never receive the base repository's secrets. Keep this schedule on trusted code
and never check out an untrusted fork with secrets present.

## Operating notes

- **Avoid duplicate runs.** Use a concurrency group, a file lock, cron overlap checks, or Task
  Scheduler `MultipleInstances IgnoreNew`. Do not cancel an audit mid-run to start the next one.
- **Keep artifacts, not noise.** `.consilium/runs` holds `run.json`, `report.md`, and per-expert
  files. Retain them for trends and `baseline accept`, but do not commit them. Logs and reports
  contain source diffs and model output; restrict access and set a retention period.
- **Cap cost and time.** Start with free models, set `--max-cost` and `--deadline`, and remember
  that `--max-cost` cannot cap a provider that does not report usage. Set a job timeout too.
- **Alert on failure.** Cron's `MAILTO` only sees unredirected output, so mail the wrapper's
  nonzero status yourself (or leave stderr unredirected). GitHub sends failure notifications and
  Task Scheduler keeps a history. Never map `3` to `0`.
- **Accept known findings deliberately.** Review a run, then run `consilium baseline accept latest`
  (or `accept <runId> --dry-run` first). Commit `.consilium/baseline.json` if the team shares it;
  otherwise every scheduled run starts empty. See [`github-action.md`](github-action.md).
