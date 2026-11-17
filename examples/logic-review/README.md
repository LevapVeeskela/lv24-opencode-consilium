# Logic review playbook

A copy-paste task template for a focused logic review with Consilium.

- [`task.md`](task.md) — the task template (Russian, matching the default
  expert prompts).
- [`docs/logic-review.md`](../../docs/logic-review.md) — the full recipe, what
  each check covers, and limitations.

From the repository root (with a global npm install, pass
`"$(npm root -g)/lv24-opencode-consilium/examples/logic-review/task.md"` to
`--task-file`, or copy `task.md` into your project):

```bash
consilium --preset review --experts arch,sec --read-only --findings --diff --base HEAD~1 \
  --task-file examples/logic-review/task.md \
  --report markdown --report-file consilium-logic-review.md
```

This is a task template, not a default expert prompt: it does not change
`DEFAULT_EXPERT_PROMPTS`, and the four roles stay universal. The template is
added only to the run that needs it.
