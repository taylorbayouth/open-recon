#!/usr/bin/env bash
# Release script for recon-input.
#
# Builds the binary, signs it with a Developer ID certificate, submits it to
# Apple's notarization service, staples the ticket into a .dmg, and produces
# a zip of the .dmg ready to attach to a GitHub release.
#
# Why .dmg and not a bare binary zip?
#   xcrun stapler can only attach a notarization ticket to an app bundle,
#   .dmg, or .pkg — not a bare Mach-O binary. Distributing via .dmg lets us
#   staple so Gatekeeper verification works offline (no OCSP network call).
#
# Usage:
#   bash release.sh [version]
#
# Prerequisites:
#   - Xcode command-line tools (swiftc, codesign, xcrun, hdiutil)
#   - Developer ID Application certificate installed in your keychain
#     (Xcode → Settings → Accounts → Manage Certificates → Developer ID Application)
#   - Notarytool credentials stored in your keychain (one-time setup):
#       xcrun notarytool store-credentials "open-recon" \
#         --apple-id "you@example.com" \
#         --team-id "XXXXXXXXXX" \
#         --password "xxxx-xxxx-xxxx-xxxx"
#
# Outputs (in dist/):
#   recon-input-<version>-macos-universal.dmg   — notarized, stapled disk image
#   recon-input-<version>-macos-universal.zip   — zip of the .dmg for GitHub release

set -euo pipefail
cd "$(dirname "$0")"

VERSION="${1:-$(date +%Y%m%d)}"
DIST="$(pwd)/dist"
BIN="$DIST/recon-input"
ARCH_SUFFIX="macos"
DMG=""   # set after build so the name reflects universal vs native

SIGN_IDENTITY="Developer ID Application: Taylor Bayouth (R2L9P58JDK)"
KEYCHAIN_PROFILE="open-recon"

# ─── Sanity checks ────────────────────────────────────────────────────────────

if ! command -v swiftc >/dev/null 2>&1; then
  echo "error: swiftc not found. Install Xcode command-line tools: xcode-select --install" >&2
  exit 1
fi

# ─── Build ────────────────────────────────────────────────────────────────────

echo "→ Building recon-input …"
mkdir -p "$DIST"

# Try a universal binary (arm64 + x86_64). Falls back to native arch if the
# SDK doesn't support the other slice (older Xcode / cross-compile missing).
if swiftc -target arm64-apple-macos11 -O -o "$DIST/recon-input-arm64" main.swift 2>/dev/null && \
   swiftc -target x86_64-apple-macos10.15 -O -o "$DIST/recon-input-x86_64" main.swift 2>/dev/null; then
  lipo -create -output "$BIN" "$DIST/recon-input-arm64" "$DIST/recon-input-x86_64"
  rm "$DIST/recon-input-arm64" "$DIST/recon-input-x86_64"
  echo "  universal binary (arm64 + x86_64)"
  ARCH_SUFFIX="macos-universal"
else
  swiftc -O -o "$BIN" main.swift
  ARCH_SUFFIX="macos-$(uname -m)"
  echo "  native arch only ($(uname -m))"
fi

DMG="$DIST/recon-input-${VERSION}-${ARCH_SUFFIX}.dmg"
ZIP="$DIST/recon-input-${VERSION}-${ARCH_SUFFIX}.zip"

# ─── Sign ─────────────────────────────────────────────────────────────────────

echo "→ Signing …"
# --options runtime enables the Hardened Runtime, required for notarization.
# recon-input doesn't need additional entitlements: CGEvent posting is gated
# at runtime by the user granting Accessibility in System Settings, not by a
# compile-time entitlement.
codesign \
  --force \
  --options runtime \
  --sign "$SIGN_IDENTITY" \
  --timestamp \
  "$BIN"

echo "  verifying signature …"
codesign --verify --deep --strict --verbose=1 "$BIN"

# ─── Package into .dmg ────────────────────────────────────────────────────────

echo "→ Creating disk image …"
# Stage the binary in a temp dir so hdiutil only sees what belongs in the dmg.
STAGING="$(mktemp -d)"
cp "$BIN" "$STAGING/recon-input"
rm -f "$DMG"
hdiutil create \
  -volname "recon-input" \
  -srcfolder "$STAGING" \
  -ov -format UDZO \
  "$DMG"
rm -rf "$STAGING"

# ─── Notarize ─────────────────────────────────────────────────────────────────

echo "→ Submitting to Apple notarization service (this takes 1–5 minutes) …"
xcrun notarytool submit "$DMG" \
  --keychain-profile "$KEYCHAIN_PROFILE" \
  --wait

# ─── Staple ───────────────────────────────────────────────────────────────────

# Embeds the notarization ticket into the .dmg so Gatekeeper can verify it
# offline (no OCSP network call required when the user mounts the image).
echo "→ Stapling notarization ticket …"
xcrun stapler staple "$DMG"
xcrun stapler validate "$DMG"

# Zip the .dmg for GitHub release upload.
rm -f "$ZIP"
zip -j "$ZIP" "$DMG"

# ─── Done ─────────────────────────────────────────────────────────────────────

echo ""
echo "✓  Release artifact: $ZIP"
echo "   (contains: $(basename "$DMG"))"
echo ""
echo "Next steps:"
echo "  1. Verify Gatekeeper acceptance on a clean machine:"
echo "       spctl --assess --type execute -v dist/recon-input"
echo "  2. Attach $ZIP to the GitHub release for v${VERSION}."
echo "  3. In the release notes, remind users to grant Accessibility permission"
echo "     to Terminal (or their shell) in System Settings → Privacy & Security."
