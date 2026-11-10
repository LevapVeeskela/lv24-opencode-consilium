"""Command-line entry point that delegates to the npm Consilium CLI."""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from typing import List, Optional, Sequence

from . import __version__

NPM_PACKAGE = "lv24-opencode-consilium"
NPM_VERSION_ENV = "CONSILIUM_NPM_VERSION"

# The npm-generated npx.cmd shim runs this script with the bundled Node.js.
_NPX_CLI_RELATIVE_PATH = os.path.join(
    "node_modules", "npm", "bin", "npx-cli.js"
)

_NPX_MISSING_MESSAGE = """\
{0}: npx was not found on PATH.

This package is a Python launcher for the Node.js Consilium CLI and MCP server;
it does not bundle Node.js. Install Node.js 18 or newer (npm and npx are
included) from
https://nodejs.org/ and make sure the OpenCode CLI is installed and available:
https://opencode.ai/docs/
"""


def npm_spec() -> str:
    """Return the npm package spec, honoring CONSILIUM_NPM_VERSION."""
    version = os.environ.get(NPM_VERSION_ENV, "").strip() or __version__
    return "{0}@{1}".format(NPM_PACKAGE, version)


def _node_launcher(
    npx: str, platform: Optional[str] = None
) -> Optional[List[str]]:
    """Return ``[node, npx-cli.js]`` for npm's Windows batch shim.

    Windows runs ``.cmd``/``.bat`` shims through ``cmd.exe``, which re-parses
    the command line: ``&`` splits the command, ``^`` is swallowed and
    ``%NAME%`` expands environment variables. A prompt passed by the user
    would arrive truncated or altered. Starting the npm script with Node.js
    directly keeps every argument intact.
    """
    platform = os.name if platform is None else platform
    if platform != "nt" or not npx.lower().endswith((".cmd", ".bat")):
        return None

    directory = os.path.dirname(npx)
    script = os.path.join(directory, _NPX_CLI_RELATIVE_PATH)
    if not os.path.isfile(script):
        return None

    node = os.path.join(directory, "node.exe")
    if not os.path.isfile(node):
        node = shutil.which("node") or ""
        if not node or node.lower().endswith((".cmd", ".bat")):
            return None
    return [node, script]


def _run_npx(arguments: Sequence[str], program: str = "consilium") -> int:
    """Run npx with the given arguments and return its exit code."""
    npx = shutil.which("npx")
    if npx is None:
        sys.stderr.write(_NPX_MISSING_MESSAGE.format(program))
        return 127

    launcher = _node_launcher(npx) or [npx]
    command = [*launcher, *arguments]

    try:
        completed = subprocess.run(command, check=False)
        return completed.returncode
    except KeyboardInterrupt:
        return 130
    except OSError as exc:
        sys.stderr.write(
            "{0}: failed to start {1}: {2}\n".format(
                program, command[0], exc
            )
        )
        return 127


def main(argv: Optional[Sequence[str]] = None) -> int:
    """Run the npm CLI through npx and return its exit code."""
    args = list(sys.argv[1:] if argv is None else argv)
    return _run_npx(["--yes", npm_spec(), *args])
