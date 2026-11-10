"""Command-line entry point that delegates to the npm Consilium MCP server."""

from __future__ import annotations

import sys
from typing import Optional, Sequence

from .cli import _run_npx, npm_spec

MCP_BIN = "consilium-mcp"


def main(argv: Optional[Sequence[str]] = None) -> int:
    """Run the npm MCP server through npx and return its exit code."""
    args = list(sys.argv[1:] if argv is None else argv)
    return _run_npx(
        ["--yes", "--package", npm_spec(), MCP_BIN, *args],
        program=MCP_BIN,
    )


if __name__ == "__main__":
    raise SystemExit(main())
