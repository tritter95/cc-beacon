#!/bin/sh
# Phase 0: build CCBeaconNotifier.app as a universal (arm64 + x86_64), ad-hoc signed bundle.
set -eu
cd "$(dirname "$0")"
OUT=build/CCBeaconNotifier.app
rm -rf build && mkdir -p "$OUT/Contents/MacOS" "$OUT/Contents/Resources"
swiftc -O -target arm64-apple-macos13 -o build/notifier-arm64 main.swift
swiftc -O -target x86_64-apple-macos13 -o build/notifier-x86_64 main.swift
lipo -create build/notifier-arm64 build/notifier-x86_64 -output "$OUT/Contents/MacOS/ccbeacon-notifier"
rm build/notifier-arm64 build/notifier-x86_64
cp Info.plist "$OUT/Contents/Info.plist"
codesign --force --sign - "$OUT"
codesign --verify --verbose=2 "$OUT"
lipo -archs "$OUT/Contents/MacOS/ccbeacon-notifier"
echo "built $OUT"
