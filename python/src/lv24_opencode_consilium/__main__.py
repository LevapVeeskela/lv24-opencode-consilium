"""Allow running the launcher with ``python -m lv24_opencode_consilium``."""

from .cli import main

if __name__ == "__main__":
    raise SystemExit(main())
