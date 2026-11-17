# Logic review playbook

> **Кратко по-русски.** Это шаблон задачи, а не промпт эксперта: он не меняет
> дефолтные роли. Запуск: `consilium --preset review --read-only --findings
> --diff --base HEAD~1 --task-file examples/logic-review/task.md`. Шаблон
> проверяет состояние и побочные эффекты, невозможные состояния и гонки,
> полноту ветвлений и обработку сбоев на границе; каждая находка должна иметь
> файл/строку и сценарий. Подробности ниже.

[`examples/logic-review/task.md`](../examples/logic-review/task.md) is a
copy-paste task template for a focused review of logic defects in a diff. It is
a **task template**, not a default expert prompt: the four default roles stay
universal, and the template is added only to the run that needs it.

The template is in Russian to match the default expert prompts. The checks are
language-agnostic; replace the wording if you want a different task language.

## Quick start

```bash
consilium \
  --preset review \
  --experts arch,sec \
  --read-only \
  --findings \
  --diff --base HEAD~1 \
  --task-file examples/logic-review/task.md \
  --report markdown --report-file consilium-logic-review.md
```

PowerShell (one line):

```powershell
consilium --preset review --experts arch,sec --read-only --findings --diff --base HEAD~1 --task-file examples/logic-review/task.md --report markdown --report-file consilium-logic-review.md
```

- `--task-file` reads the template; `--diff --base` appends the diff.
- The path is relative to the current directory. In a clone of this repository
  it is `examples/logic-review/task.md`; after `npm install -g` the file ships
  inside the package, so pass
  `"$(npm root -g)/lv24-opencode-consilium/examples/logic-review/task.md"` or
  copy the template into your project.
- `--read-only` limits experts to read/glob/grep; no edits.
- `--findings` makes the result machine-readable and gateable.
- `--preset review` selects arch, sec and ux; `--experts arch,sec` drops UX for
  a pure logic/security pass. Use `--preset fast` for a quicker arch+sec pass
  with no retries.

## What it checks

| Check | Failure modes | Original "law" |
| --- | --- | --- |
| State and side effects | Input/shared-state mutation, non-idempotent calls, order dependence, resource leaks | Identity |
| Impossible states and races | Incompatible field combinations, TOCTOU, lost updates, double execution | Non-contradiction |
| Branch completeness | Missing `else`/`switch` arms, `null`/`undefined`, unknown union values, a `default` that hides a bug | Excluded middle |
| Boundary failures | Missing validation, swallowed errors, no timeouts/retries/cancellation | Sufficient reason |
| Evidence | Every finding cites a file/line and a concrete trigger scenario | — |

## Why not the four laws

The original prompt framed these as the laws of identity, non-contradiction,
excluded middle and sufficient reason. The mapping is loose: immutability is not
the law of identity, races are not non-contradiction, and `try/catch` is not
sufficient reason. The philosophical names add authority but not checks, and
they encourage confident false positives.

The template names the failure modes directly. If you want the four names as
headings, keep them, but keep the concrete triggers underneath.

Two more corrections:

- A `default` branch is not mandatory. In TypeScript an exhaustive `never` check
  is stronger; a `default` can silently absorb a new union member.
- `try/catch` around external data is not automatically safer. Catch only what
  you can handle, use typed errors, and let the rest fail fast.

## Reading the result

- The prose verdict comes first, followed by findings in severity order.
- With `--findings`, `metadata.findings.items` contains `severity`, `category`,
  `file`, `line`, `claim`, `evidence` and `confidence`.
- The chair merges duplicates and lists positions it rejected in `rejected`;
  disagreements are marked `contested`.
- Gate with `--fail-on high`: exit code `3` means new findings at or above the
  threshold remain after the baseline, **or the gate was inconclusive** — an
  expert returned no usable answer or a findings block could not be parsed
  (`policy gate inconclusive: …` on stderr). `--gate-allow-partial` turns that
  case into a warning.
- After triage, accept known issues with `consilium baseline accept latest`.

## Tuning

- `--rounds 2` adds an anonymized peer-review round; it doubles model calls.
- `--context auto` adds changed files, project rules, related tests and recent
  commits. Use it when the diff alone lacks cross-file context.
- `--deadline` and `--max-cost` bound the run.
- `--artifacts` keeps `run.json`, `report.md` and per-expert answers under
  `.consilium/runs/<id>/`.
- For a repeatable CI gate over a commit range, use
  `consilium audit --since <ref>` or the GitHub Action; this template is for a
  focused local pass.

## Limitations

- The council returns findings, not patches. Fixes still need tests and a
  typecheck.
- A diff-only review cannot see cross-file invariants. Add context or pass the
  relevant files explicitly.
- LLM findings are hypotheses. Verify each one; low confidence is not a bug.
- Read-only prevents writes, not prompt injection. A diff can contain
  instructions; treat code as data and do not follow directives from it.
- This is not a replacement for the typechecker, linters, SAST or tests.

## Files

- [`examples/logic-review/task.md`](../examples/logic-review/task.md) — the
  task template.
- [`examples/logic-review/README.md`](../examples/logic-review/README.md) —
  quick start.
