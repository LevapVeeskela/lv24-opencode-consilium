# lv24-opencode-consilium (Python launcher)

A thin Python launcher for **Consilium**, the multi-agent review and audit CLI
for the [OpenCode](https://opencode.ai/) ecosystem. Consilium itself is a
Node.js command-line tool published on npm as
[`lv24-opencode-consilium`](https://www.npmjs.com/package/lv24-opencode-consilium).
This package does not reimplement Consilium and does not bundle Node.js: the
`consilium` command delegates to the npm package through `npx`.

The npm package remains the canonical distribution. The PyPI package only
contains this launcher.

## Prerequisites

- **Node.js 18 or newer**, including npm and npx
  ([nodejs.org](https://nodejs.org/)).
- The **OpenCode CLI** installed and available on `PATH`
  ([OpenCode docs](https://opencode.ai/docs/)).
- Network access on first run, or an npm cache that already contains the
  requested package, because `npx` may download it.
- Python 3.9 or newer.

## Installation

```bash
pip install lv24-opencode-consilium
```

This installs two equivalent console scripts:

- `consilium`
- `lv24-opencode-consilium`

## Usage

```bash
consilium --help
consilium "review this repository"
consilium review --model opencode/gpt-5
```

All arguments are forwarded unchanged to the npm CLI. The child process
inherits the terminal, environment, and exit code. You can also run:

```bash
python -m lv24_opencode_consilium --help
```

If `npx` cannot be found, the launcher exits with code `127` and prints an
installation hint. An interrupted run exits with code `130`.

## Version pinning

By default the launcher runs the npm package version matching its own version
(currently `1.10.0`). Override it with `CONSILIUM_NPM_VERSION` to use any npm
version or tag:

```bash
CONSILIUM_NPM_VERSION=latest consilium --help
CONSILIUM_NPM_VERSION=1.9.0 consilium --help
```

PowerShell:

```powershell
$env:CONSILIUM_NPM_VERSION = "latest"; consilium --help
```

## Links

- Main repository and documentation:
  <https://github.com/LevapVeeskela/lv24-opencode-consilium>
- Documentation:
  <https://github.com/LevapVeeskela/lv24-opencode-consilium/tree/master/docs>
- Issues:
  <https://github.com/LevapVeeskela/lv24-opencode-consilium/issues>
- npm package:
  <https://www.npmjs.com/package/lv24-opencode-consilium>

## License

MIT
