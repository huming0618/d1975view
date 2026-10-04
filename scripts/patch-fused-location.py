#!/usr/bin/env python3
"""
Patch Capacitor Android Geolocation so follow-me does not freeze on the first fix.

Hypothesis (from xibaoview):
  - watchPosition maps the JS timeout (often 30s) onto setMaxUpdateDelayMillis,
    so Fused Location batches updates and the marker sits still.
  - getCurrentPosition with maximumAge 0 rejects the last fused fix, so polling
    never advances the marker either.

This script rewrites those two call sites after `npx cap sync` (and in
node_modules so the next sync stays patched).
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

SEARCH_ROOTS = [
    ROOT / "node_modules" / "@capacitor" / "geolocation",
    ROOT / "android",
]

MAX_DELAY_PATTERNS = [
    (
        re.compile(r"\.setMaxUpdateDelayMillis\(\s*timeout\s*\)"),
        ".setMaxUpdateDelayMillis(0)",
    ),
    (
        re.compile(r"\.setMaxUpdateDelayMillis\(\s*options\.getInt\(\s*\"timeout\"[^)]*\)\s*\)"),
        ".setMaxUpdateDelayMillis(0)",
    ),
]

MAX_AGE_PATTERNS = [
    (
        re.compile(r"\.setMaxUpdateAgeMillis\(\s*0\s*\)"),
        ".setMaxUpdateAgeMillis(2_000)",
    ),
    (
        re.compile(r"\.setMaxUpdateAgeMillis\(\s*maximumAge\s*\)"),
        ".setMaxUpdateAgeMillis(maximumAge == 0 ? 2_000 : maximumAge)",
    ),
    (
        re.compile(
            r"(?<!if \(maximumAge == 0\) \{ maximumAge = 2000; \}\n {16})long maximumAgeNanoSec = maximumAge \* 1000000L;"
        ),
        "if (maximumAge == 0) { maximumAge = 2000; }\n                long maximumAgeNanoSec = maximumAge * 1000000L;",
    ),
]


def patch_text(text: str) -> tuple[str, int]:
    if ".setMaxUpdateDelayMillis(0)" in text and "if (maximumAge == 0) { maximumAge = 2000; }" in text:
        return text, 0
    n = 0
    for pat, repl in MAX_DELAY_PATTERNS + MAX_AGE_PATTERNS:
        text, c = pat.subn(repl, text)
        n += c
    return text, n


def iter_java() -> list[Path]:
    files: list[Path] = []
    for root in SEARCH_ROOTS:
        if not root.exists():
            continue
        files.extend(root.rglob("*.java"))
        files.extend(root.rglob("*.kt"))
    return files


def main() -> int:
    changed = 0
    scanned = 0
    for path in iter_java():
        raw = path.read_text(encoding="utf-8")
        if "setMaxUpdateDelayMillis" not in raw and "maximumAge" not in raw and "MaxUpdateAge" not in raw:
            continue
        scanned += 1
        patched, n = patch_text(raw)
        if n and patched != raw:
            path.write_text(patched, encoding="utf-8")
            print(f"patched {path.relative_to(ROOT)} ({n} edits)")
            changed += 1
    if scanned == 0:
        print("No Capacitor Geolocation Android sources found yet (run after npm install / cap sync).")
        return 0
    print(f"Done. {changed} file(s) patched.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
