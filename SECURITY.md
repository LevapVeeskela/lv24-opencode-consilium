# Security policy

## Supported versions

Security fixes go into the latest release of `lv24-opencode-consilium` (npm),
the matching PyPI launcher and the `latest` container image. Older versions are
not patched; upgrade to the newest release.

## Reporting a vulnerability

Please do not open a public issue with exploit details.

1. Use GitHub private vulnerability reporting:
   <https://github.com/LevapVeeskela/lv24-opencode-consilium/security/advisories/new>.
2. If that form is unavailable, open an issue that only says you have a
   security report and ask for a private channel.

Include the version, the platform, the OpenCode version, a minimal reproduction
and the impact you expect. You will get an answer as soon as the maintainer has
reproduced the report; there is no guaranteed response time for this project.

## What Consilium does and does not protect

- **Process boundary.** The prompt goes to OpenCode through stdin, never through
  a shell. Agent names, model ids and git refs are validated. Project
  configuration is untrusted for process and path keys unless passed with `-c`.
- **Read-only runs** are enforced by OpenCode from deny rules that Consilium
  writes. Consilium does not sandbox the model: verify the restrictions on your
  OpenCode version. Read-only does not restrict MCP servers, plugins or
  providers defined in the project `opencode.json`.
- **Prompt injection** cannot be ruled out. Diffs and repository text are
  wrapped as untrusted data, but a model may still follow instructions hidden in
  the code it reviews. Treat the council's output as an untrusted suggestion.
- **Secrets in output** are masked by pattern (token prefixes, PEM keys, JWT,
  JSON secret fields). This is a safety net, not a guarantee.
- **Data flow.** The task, the diff and optional context files are sent to the
  model providers configured in OpenCode. Use `--local-only` for code that must
  not leave the machine.
- **GitHub Action.** Run it on `pull_request`, not `pull_request_target`, for
  code you do not control. By default the action takes the review configuration
  from the base ref (`config-from-base`).
