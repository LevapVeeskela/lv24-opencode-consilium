# lv24-opencode-consilium (Python launcher)

[![PyPI](https://img.shields.io/pypi/v/lv24-opencode-consilium?label=PyPI&logo=pypi&logoColor=white)](https://pypi.org/project/lv24-opencode-consilium/)
[![PyPI - Python versions](https://img.shields.io/pypi/pyversions/lv24-opencode-consilium?logo=python&logoColor=white)](https://pypi.org/project/lv24-opencode-consilium/)
[![npm](https://img.shields.io/npm/v/lv24-opencode-consilium?label=npm&color=cb3837&logo=npm)](https://www.npmjs.com/package/lv24-opencode-consilium)
[![license](https://img.shields.io/badge/license-MIT-2ea44f)](https://github.com/LevapVeeskela/lv24-opencode-consilium/blob/master/LICENSE)

A thin, dependency-free Python launcher for **Consilium**, the multi-agent
review and audit CLI for the [OpenCode](https://opencode.ai/) ecosystem.
Consilium itself is a Node.js command-line tool published on npm as
[`lv24-opencode-consilium`](https://www.npmjs.com/package/lv24-opencode-consilium).
This package does not reimplement Consilium and does not bundle Node.js: the
`consilium` command delegates to the npm package through `npx`.

The npm package remains the canonical distribution. The PyPI package only
contains this launcher, so both installation routes run the same engine and
stay in lockstep on the same version.

## Prerequisites

- **Node.js 18 or newer**, including npm and npx
  ([nodejs.org](https://nodejs.org/)). The launcher uses `npx` to download and
  run the npm package, so Node.js is required even though the Python package
  has no runtime dependencies.
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

Upgrade with `pip install --upgrade lv24-opencode-consilium`.

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
(currently `1.12.0`). Override it with `CONSILIUM_NPM_VERSION` to use any npm
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
- PyPI package:
  <https://pypi.org/project/lv24-opencode-consilium/>
- Releases and changelog:
  <https://github.com/LevapVeeskela/lv24-opencode-consilium/releases>

## License

MIT
