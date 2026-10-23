#!/usr/bin/env python3
"""One-time source migration: preserve the existing MAIN-world closure byte for byte.

Each component is a contiguous group of top-level declarations, kept in their
original order. They must be assembled before loading into Chrome: the shared
closure is security-sensitive and must never become multiple page scripts.
"""
from __future__ import annotations

import argparse
import hashlib
from pathlib import Path
import re


MAX_PART = 18700
SOURCE = Path(__file__).resolve().parents[1] / "extension" / "fiber.js"
DEST = SOURCE.parent / "fiber-src"
TOP_LEVEL = re.compile(rb"^  (?:function|async function|const|let|class)\s+")
IDENT = re.compile(rb"\b(?:function|const|let|class)\s+([a-zA-Z_$][\w$]*)")


def parts(raw: bytes):
    lines = raw.splitlines(keepends=True)
    positions = sorted({0, len(lines), *(i for i, line in enumerate(lines) if TOP_LEVEL.match(line))})
    segments = [b"".join(lines[a:b]) for a, b in zip(positions, positions[1:])]
    groups = []
    current = b""
    for segment in segments:
        if len(segment) > MAX_PART:
            raise ValueError(f"single declaration exceeds {MAX_PART} bytes: {len(segment)}")
        if current and len(current) + len(segment) > MAX_PART:
            groups.append(current)
            current = b""
        current += segment
    if current:
        groups.append(current)
    if b"".join(groups) != raw:
        raise ValueError("the generated source does not exactly reproduce the input bytes")
    return groups


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    source = SOURCE.read_bytes()
    groups = parts(source)
    names = []
    for index, chunk in enumerate(groups):
        found = IDENT.search(chunk)
        label = found.group(1).decode("ascii", "ignore") if found else "closing"
        filename = f"{index:02d}-{label}.part.js"
        names.append(filename)
        print(f"{filename}: {len(chunk)} bytes")
    print(f"parts={len(groups)}, original_sha256={hashlib.sha256(source).hexdigest()}")
    if args.apply:
        if DEST.exists():
            raise FileExistsError(f"migration destination already exists: {DEST}")
        DEST.mkdir()
        for name, chunk in zip(names, groups):
            (DEST / name).write_bytes(chunk)
        if b"".join((DEST / name).read_bytes() for name in names) != source:
            raise ValueError("round-trip verification failed")


if __name__ == "__main__":
    main()
