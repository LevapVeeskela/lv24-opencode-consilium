---
description: Run the Consilium council of expert agents on a task
# OpenCode 2.2.6 command reference: https://opencode.ai/docs/commands/
# Project commands: .opencode/commands/*.md · global: ~/.config/opencode/commands/*.md
# (the legacy singular command/ directory is also discovered in 2.2.6).
# $ARGUMENTS expands to the full argument string; $1, $2, ... are positional.
# Frontmatter supports description, agent, model and subagent; subtask is the
# deprecated alias for subagent. A Markdown command is a prompt template, so it
# cannot call a tool directly: it asks the agent to call one.
---

Run the Consilium council on this task:

$ARGUMENTS

Call the Consilium plugin tool from OpenCode V2 (`consilium.run` in Code Mode; native tool id `consilium_run`) with the task text as its `task` argument. Do not summarize or rewrite the task, and do not answer it yourself.

If the plugin tool is not available, call the MCP tool `consilium_run` with the same `task` argument. When the MCP server is registered as `consilium`, OpenCode V2 may expose the callable name as `consilium_consilium_run`.

If neither tool is available, tell me that the Consilium V2 plugin or the Consilium MCP server must be registered first. Do not invent a council result.

If the task above is empty, ask me for the task instead of calling a tool.
