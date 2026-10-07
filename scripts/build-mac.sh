#!/bin/bash
# Builds dist/HarFiddle.app (+ .dmg and .zip) for macOS.
#
#   npm run build:mac                 # universal app: runs natively on Apple Silicon and Intel
#   ARCH=arm64 npm run build:mac      # Apple Silicon only (smaller)
#   ARCH=x86_64 npm run build:mac     # Intel only (smaller)
#   BUNDLE_NODE=0 npm run build:mac   # tiny app that uses the Node.js installed on the machine
#   NODE_MAJOR=24 npm run build:mac   # bundle a different Node.js major version
#
# Needs: Xcode Command Line Tools (swiftc, lipo), curl, and `npm install` done once.
set -euo pipefail
cd "$(dirname "$0")/.."

ARCH="${ARCH:-universal}"
case "$ARCH" in
  universal) ARCHS="arm64 x86_64" ;;
  arm64 | x86_64) ARCHS="$ARCH" ;;
  *) echo "Unsupported ARCH: $ARCH (use universal, arm64 or x86_64)" >&2; exit 1 ;;
esac
NODE_MAJOR="${NODE_MAJOR:-22}"
BUNDLE_NODE="${BUNDLE_NODE:-1}"
VERSION="$(node -p "require('./package.json').version")"
OUT=dist
APP="$OUT/HarFiddle.app"
CACHE=.build-cache
RES="$APP/Contents/Resources"

command -v swiftc >/dev/null || { echo "swiftc not found. Install the Xcode Command Line Tools: xcode-select --install" >&2; exit 1; }
[ -d node_modules/node-forge ] || { echo "Run 'npm install' first." >&2; exit 1; }

echo "› Building HarFiddle $VERSION ($ARCH)"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$RES/app" "$CACHE"

echo "› Compiling the native shell"
SHELLS=()
for a in $ARCHS; do
  swiftc -O -swift-version 5 -target "$a-apple-macos12.0" -o "$CACHE/HarFiddle-$a" macos/main.swift
  SHELLS+=("$CACHE/HarFiddle-$a")
done
lipo -create "${SHELLS[@]}" -output "$APP/Contents/MacOS/HarFiddle"

echo "› Copying the engine and UI"
cp -R server.js lib public package.json "$RES/app/"
mkdir -p "$RES/app/node_modules"
cp -R node_modules/node-forge "$RES/app/node_modules/"
sed "s/__VERSION__/$VERSION/g" macos/Info.plist > "$APP/Contents/Info.plist"
cp macos/AppIcon.icns "$RES/AppIcon.icns"

# Downloads and checksum-verifies an official Node.js build; prints the path of its `node` binary.
fetch_node() {
  local node_arch="$1" name
  name="node-$NODE_VER-darwin-$node_arch"
  if [ ! -f "$CACHE/$name.tar.gz" ]; then
    curl -fsSL -o "$CACHE/$name.tar.gz.part" "https://nodejs.org/dist/$NODE_VER/$name.tar.gz"
    mv "$CACHE/$name.tar.gz.part" "$CACHE/$name.tar.gz"
  fi
  grep " $name.tar.gz\$" "$CACHE/SHASUMS256-$NODE_VER.txt" > "$CACHE/$name.sha256"
  (cd "$CACHE" && shasum -a 256 -c "$name.sha256" >/dev/null) || { echo "Checksum mismatch for $name.tar.gz" >&2; rm -f "$CACHE/$name.tar.gz"; exit 1; }
  rm -rf "${CACHE:?}/$name"
  tar -xzf "$CACHE/$name.tar.gz" -C "$CACHE" "$name/bin/node" "$name/LICENSE"
  echo "$CACHE/$name"
}

if [ "$BUNDLE_NODE" = "1" ]; then
  NODE_VER="$(curl -fsSL https://nodejs.org/dist/index.json | node -e "
    const list = JSON.parse(require('fs').readFileSync(0, 'utf8'));
    const hit = list.find((r) => r.version.startsWith('v$NODE_MAJOR.') && r.files.includes('osx-arm64-tar') && r.files.includes('osx-x64-tar'));
    if (!hit) process.exit(1);
    console.log(hit.version);")"
  echo "› Bundling Node.js $NODE_VER"
  curl -fsSL -o "$CACHE/SHASUMS256-$NODE_VER.txt" "https://nodejs.org/dist/$NODE_VER/SHASUMS256.txt"
  BINS=()
  for a in $ARCHS; do
    dir="$(fetch_node "$([ "$a" = x86_64 ] && echo x64 || echo arm64)")"
    BINS+=("$dir/bin/node")
  done
  mkdir -p "$RES/node"
  # lipo keeps each slice's official Node.js signature
  lipo -create "${BINS[@]}" -output "$RES/node/node"
  cp "$dir/LICENSE" "$RES/node/LICENSE"
else
  echo "› Not bundling Node.js (the app will use the one installed on the Mac)"
fi

echo "› Signing (ad-hoc)"
codesign --force --sign - "$APP"
codesign --verify --deep --strict "$APP"

echo "› Packaging"
SUFFIX="$VERSION-macOS-$ARCH"
rm -f "$OUT/HarFiddle-$SUFFIX.zip" "$OUT/HarFiddle-$SUFFIX.dmg"
ditto -c -k --keepParent "$APP" "$OUT/HarFiddle-$SUFFIX.zip"
STAGE="$CACHE/dmg"
rm -rf "$STAGE" && mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
for attempt in 1 2 3; do # hdiutil occasionally fails with "resource busy"; retry
  hdiutil create -quiet -volname "HarFiddle" -srcfolder "$STAGE" -ov -format UDZO "$OUT/HarFiddle-$SUFFIX.dmg" && break
  [ "$attempt" = 3 ] && { echo "hdiutil failed" >&2; exit 1; }
  sleep 2
done
rm -rf "$STAGE"

echo
echo "✓ $APP ($(du -sh "$APP" | cut -f1), $(lipo -archs "$APP/Contents/MacOS/HarFiddle"))"
echo "✓ $OUT/HarFiddle-$SUFFIX.dmg ($(du -h "$OUT/HarFiddle-$SUFFIX.dmg" | cut -f1))"
echo "✓ $OUT/HarFiddle-$SUFFIX.zip ($(du -h "$OUT/HarFiddle-$SUFFIX.zip" | cut -f1))"
