#!/usr/bin/env python3
"""Create a redistributable source-only Motion keychain companion archive."""
from __future__ import annotations

import argparse
import json
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VERSION = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["version"]
ARCHIVE_NAME = f"motion-keychain-companion-{VERSION}.zip"
FILES = (
    Path("native/keychain_host.py"),
    Path("native/install.py"),
    Path("native/README.md"),
    Path("docs/keychain-companion.md"),
)


def package(destination: Path) -> Path:
    destination = destination.resolve()
    destination.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for relative in FILES:
            source = ROOT / relative
            if not source.is_file():
                raise FileNotFoundError(source)
            archive.write(source, relative.as_posix())
    return destination


def main() -> int:
    parser = argparse.ArgumentParser(description="Package Motion's source-only keychain companion.")
    parser.add_argument("--output", type=Path, default=ROOT / ARCHIVE_NAME)
    args = parser.parse_args()
    print(package(args.output))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
