#!/usr/bin/env bash
# Build browser-input — the macOS OS-level input driver for Browser Agent.
#
# Requires the Xcode command-line tools (`xcode-select --install`).
# Run once after cloning; the resulting binary is written to ignored bin/.

set -euo pipefail

cd "$(dirname "$0")"

if ! command -v swiftc >/dev/null 2>&1; then
  echo "swiftc not found. Install the Xcode command-line tools:" >&2
  echo "  xcode-select --install" >&2
  exit 1
fi

mkdir -p bin
swiftc -O -o bin/browser-input main.swift
echo "Built: $(pwd)/bin/browser-input"
