#!/bin/sh
# Builds CCBeaconNotifier.app as a universal (arm64 + x86_64), ad-hoc signed bundle.
#   BUNDLE_ID=...  build under another bundle ID (permission-flow testing; the real ID must never change)
#   BUILD_DIR=...  write the bundle somewhere other than ./build
set -eu
if [ "$(uname -s)" != "Darwin" ]; then
  echo "Skipping the CCBeaconNotifier.app build: not macOS."
  exit 0
fi
HERE=$(cd "$(dirname "$0")" && pwd)
PKG_JSON="$HERE/../../package.json"
BUILD="${BUILD_DIR:-$HERE/build}"
OUT="$BUILD/CCBeaconNotifier.app"
VERSION=$(plutil -extract version raw -o - "$PKG_JSON")
BUNDLE_ID="${BUNDLE_ID:-local.ccbeacon.notifier}"

rm -rf "$OUT"
mkdir -p "$OUT/Contents/MacOS" "$OUT/Contents/Resources"
swiftc -O -target arm64-apple-macos13 -o "$BUILD/notifier-arm64" "$HERE/main.swift"
swiftc -O -target x86_64-apple-macos13 -o "$BUILD/notifier-x86_64" "$HERE/main.swift"
lipo -create "$BUILD/notifier-arm64" "$BUILD/notifier-x86_64" -output "$OUT/Contents/MacOS/ccbeacon-notifier"
rm "$BUILD/notifier-arm64" "$BUILD/notifier-x86_64"

cp "$HERE/Info.plist" "$OUT/Contents/Info.plist"
plutil -replace CFBundleShortVersionString -string "$VERSION" "$OUT/Contents/Info.plist"
plutil -replace CFBundleVersion -string "$VERSION" "$OUT/Contents/Info.plist"
plutil -replace CFBundleIdentifier -string "$BUNDLE_ID" "$OUT/Contents/Info.plist"

codesign --force --sign - "$OUT"
codesign --verify --verbose=2 "$OUT"
echo "Built $OUT ($BUNDLE_ID $VERSION, $(lipo -archs "$OUT/Contents/MacOS/ccbeacon-notifier"))"
