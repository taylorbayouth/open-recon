#!/usr/bin/env bash
# Build recon-input — the macOS OS-level input driver for Open Recon.
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
swiftc -O -o bin/recon-input main.swift
echo "Built: $(pwd)/bin/recon-input"
