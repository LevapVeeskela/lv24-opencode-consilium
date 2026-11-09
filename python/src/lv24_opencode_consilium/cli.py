"""Command-line entry point that delegates to the npm Consilium CLI."""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from typing import Optional, Sequence

from . import __version__

NPM_PACKAGE = "lv24-opencode-consilium"
NPM_VERSION_ENV = "CONSILIUM_NPM_VERSION"

_NPX_MISSING_MESSAGE = """\
consilium: npx was not found on PATH.

This package is a Python launcher for the Node.js Consilium CLI; it does not
bundle Node.js. Install Node.js 18 or newer (npm and npx are included) from
https://nodejs.org/ and make sure the OpenCode CLI is installed and available:
https://opencode.ai/docs/
"""


def npm_spec() -> str:
    """Return the npm package spec, honoring CONSILIUM_NPM_VERSION."""
    version = os.environ.get(NPM_VERSION_ENV, "").strip() or __version__
    return "{0}@{1}".format(NPM_PACKAGE, version)


def main(argv: Optional[Sequence[str]] = None) -> int:
    """Run the npm CLI through npx and return its exit code."""
    args = list(sys.argv[1:] if argv is None else argv)

    npx = shutil.which("npx")
    if npx is None:
        sys.stderr.write(_NPX_MISSING_MESSAGE)
        return 127

    command = [npx, "--yes", npm_spec(), *args]

    try:
        completed = subprocess.run(command, check=False)
        return completed.returncode
    except KeyboardInterrupt:
        return 130
    except OSError as exc:
        sys.stderr.write(
            "consilium: failed to start {0}: {1}\n".format(npx, exc)
        )
        return 127
