#!/usr/bin/env bash
# Build browser-input — the Linux X11 OS-level input driver for Browser Agent.
#
# Requires: gcc, x11, xtst, xscrnsaver dev headers.
#
# Ubuntu/Debian:  sudo apt install gcc libx11-dev libxtst-dev libxss-dev
# Fedora/RHEL:    sudo dnf install gcc libX11-devel libXtst-devel libXScrnSaver-devel
# Arch:           sudo pacman -S gcc libx11 libxtst libxss
#
# Run once after cloning; the resulting binary is written to ignored bin/.

set -euo pipefail

cd "$(dirname "$0")"

if ! command -v gcc >/dev/null 2>&1; then
  echo "gcc not found. Install build tools (e.g. apt install gcc)." >&2
  exit 1
fi

if ! pkg-config --exists x11 xtst xscrnsaver 2>/dev/null; then
  echo "Missing pkg-config entries for x11, xtst, or xscrnsaver." >&2
  echo "Install dev packages — e.g.:" >&2
  echo "  Ubuntu:  sudo apt install libx11-dev libxtst-dev libxss-dev" >&2
  echo "  Fedora:  sudo dnf install libX11-devel libXtst-devel libXScrnSaver-devel" >&2
  echo "  Arch:    sudo pacman -S libx11 libxtst libxss" >&2
  exit 1
fi

mkdir -p bin
gcc -O2 -o bin/browser-input main.c \
    $(pkg-config --cflags --libs x11 xtst xscrnsaver) \
    -lm
echo "Built: $(pwd)/bin/browser-input"
