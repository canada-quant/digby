#!/usr/bin/env bash
#
# Build a SIGNED + NOTARIZED macOS app (Digby.dmg) — a native WKWebView wrapper
# around digby.ai. Real .app, dock icon, native menus; no Xcode project needed.
#
# ⚠️  Run on a Mac with Xcode Command Line Tools (swiftc) + your Developer ID
#     Application cert + the `digby-notary` notarytool profile (same setup as
#     macos-pkg). It cannot run in CI/Linux.
#
# Usage:  cd macos-app && ./build-app.sh
#
set -euo pipefail

TEAM_ID="${TEAM_ID:-Z5U9T5PUJ3}"
BUNDLE_ID="${BUNDLE_ID:-ai.digby.desktop}"
# 0.1.13 (2026-10-27, ticket 61823826): the app binary is now signed WITH the
# microphone entitlement (macos-app/Digby.entitlements —
# com.apple.security.device.audio-input). 0.1.12 fixed the ASK ORDER (mic-first,
# 8b13ec2b) but the ask itself was being auto-denied: notarization's hardened
# runtime (`--options runtime`) requires the audio-input entitlement for
# microphone capture, and without it the request API returns granted=false
# immediately with NO TCC prompt and NO Microphone-list entry — the AUTO_DENY
# the owner reproduced on both Macs after `tccutil reset`. 0.1.12 and every
# earlier DMG were entitlement-less, so 0.1.12 must be superseded.
# 0.1.14 (2026-10-27, ticket 9255c3f0): voice dictation no longer leaks the
# transcript into the window title (status is text-free — word count only) and
# long dictation is no longer truncated to its last few words (the recognizer
# session now seals+rotates every 45s with a short audio-overlap ring and a
# seam dedupe, and a mid-utterance isFinal keeps the session alive).
# 0.1.12 (2026-10-23, ticket 8b13ec2b): mic permission requests MIC FIRST and
# unconditionally (a denied Speech record no longer blocks the microphone TCC
# request, so Digby now appears in Privacy & Security → Microphone), denial
# alerts deep-link to the exact sub-pane (Privacy_Microphone /
# Privacy_SpeechRecognition), and ⌃⇧Space aliases Push to Talk.
# 0.1.11 (ticket ce014662, never published) also carries: target=_blank /
# window.open to an external host opens the default browser instead of
# replacing the app's only web view.
# Owner step: build + notarize on the mini, then publish Digby.dmg and bump
# frontend/public/desktop-latest.json to 0.1.13 (left at 0.1.12 until the DMG exists).
VERSION="${VERSION:-0.1.14}"
NODE_VERSION="${NODE_VERSION:-v20.18.1}"
APP_IDENTITY="${APP_IDENTITY:-Developer ID Application: Paul Cozzolino ($TEAM_ID)}"
NOTARY_PROFILE="${NOTARY_PROFILE:-digby-notary}"

[ "$(uname)" = "Darwin" ] || { echo "✗ Run this on macOS." >&2; exit 1; }
command -v swiftc >/dev/null || { echo "✗ swiftc not found — run: xcode-select --install" >&2; exit 1; }

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
SRCS=("$HERE/Sources/Digby/main.swift" "$HERE/Sources/Digby/VoiceMode.swift")
BUILD="$(mktemp -d)"
APP="$BUILD/Digby.app"
OUT_DMG="$ROOT/Digby.dmg"
trap 'rm -rf "$BUILD"' EXIT

APP_HASH="$(security find-identity -v -p codesigning | awk -v n="$APP_IDENTITY" 'index($0,n){print $2; exit}')"
[ -n "$APP_HASH" ] || { echo "✗ Missing/invalid signing identity: $APP_IDENTITY"; echo "  (see macos-pkg/README.md → Troubleshooting if codesign misbehaves)"; exit 1; }
echo "▶ Signing identity: $APP_HASH"

# ── Staleness guard (ticket 405927c9) ────────────────────────────────────────
# The DMG's BUNDLED helper is frozen at this build and never self-updates; a
# DMG bundling an agent older than the release tarball ships a downgrade that
# clobbers newer self-managed installs via the one-click setup (the exact
# "still says I have old 0.63" report). Refuse to bundle a stale agent.
# Both reads fail closed (review advisories 3/4): an unreadable version aborts
# the build with the explanatory message instead of skipping the guard or
# dying on a raw set -e error.
AGENT_TREE_VERSION="$(node -p "require('$ROOT/imessage-agent/package.json').version" 2>/dev/null || echo "")"
[[ -n "$AGENT_TREE_VERSION" ]] || { echo "✗ could not read the tree's agent version from $ROOT/imessage-agent/package.json — is node on PATH?" >&2; exit 1; }
MANIFEST_VERSION="$(sed -n "s/.*version: '\([0-9.]*\)'.*/\1/p" "$ROOT/backend/src/modules/crossmodel/imessage/agent-release.ts" | head -1)"
[[ -n "$MANIFEST_VERSION" ]] || { echo "✗ could not read the release manifest version — the staleness guard cannot run." >&2; exit 1; }
if [[ "$MANIFEST_VERSION" != "$AGENT_TREE_VERSION" ]]; then
  echo "✗ Bundled agent is stale: tree agent $AGENT_TREE_VERSION ≠ release manifest" >&2
  echo "  $MANIFEST_VERSION. The one-click setup would install a downgrade that" >&2
  echo "  clobbers newer self-managed agents (ticket 405927c9)." >&2
  echo "  Fix: run scripts/publish-agent-tarball.sh (bumps agent + manifest together)," >&2
  echo "  then rebuild the DMG." >&2
  exit 1
fi
echo "  Bundled agent $AGENT_TREE_VERSION matches the release manifest ✓"

echo "▶ Compiling (universal: arm64 + x86_64)…"
# Deployment target is macOS 12.0 — WKDownloadDelegate (native in-app downloads)
# requires 11.3+, and 12.0 is a safe modern floor.
swiftc -O -target arm64-apple-macos12.0 "${SRCS[@]}" -o "$BUILD/Digby-arm64" -framework Cocoa -framework WebKit -framework Speech -framework AVFoundation
if swiftc -O -target x86_64-apple-macos12.0 "${SRCS[@]}" -o "$BUILD/Digby-x86_64" -framework Cocoa -framework WebKit -framework Speech -framework AVFoundation 2>/dev/null; then
  UNIVERSAL=1
else
  echo "  (x86_64 cross-compile unavailable — building arm64-only)"
  UNIVERSAL=0
fi

echo "▶ Assembling Digby.app…"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
if [ "$UNIVERSAL" = "1" ]; then
  lipo -create "$BUILD/Digby-arm64" "$BUILD/Digby-x86_64" -output "$APP/Contents/MacOS/Digby"
else
  cp "$BUILD/Digby-arm64" "$APP/Contents/MacOS/Digby"
fi
chmod +x "$APP/Contents/MacOS/Digby"
sed -e "s|__BUNDLE_ID__|$BUNDLE_ID|g" -e "s|__VERSION__|$VERSION|g" "$HERE/Info.plist" > "$APP/Contents/Info.plist"

# App icon from the web app's PNG (optional, best-effort)
ICON_SRC="$ROOT/frontend/public/icon-512x512.png"
if [ -f "$ICON_SRC" ]; then
  ICONSET="$BUILD/Digby.iconset"; mkdir -p "$ICONSET"
  for s in 16 32 128 256 512; do
    sips -z $s $s "$ICON_SRC" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null 2>&1 || true
    d=$((s*2)); sips -z $d $d "$ICON_SRC" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null 2>&1 || true
  done
  iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/Digby.icns" 2>/dev/null || echo "  (icon generation skipped)"
fi

# ── Bundle the iMessage helper agent INTO the app ─────────────────────────────
# One download: the app ships the Node agent and sets it up in-place (writes a
# LaunchAgent) from "Set up on this Mac" — no separate .pkg, no Installer GUI.
# Mirrors macos-pkg/build-pkg.sh, but the payload lands inside the .app bundle.
AGENT_SRC="$ROOT/imessage-agent"
AGENT_DEST="$APP/Contents/Resources/imessage-agent"

# Download the Node runtime we ship FIRST — it's used both at runtime AND to
# compile the agent's native module (better-sqlite3). Compiling against the
# build machine's system Node instead produces a NODE_MODULE_VERSION mismatch
# (e.g. built for Node 22 / ABI 127, but we ship Node 20 / ABI 115 → load fails).
case "$(uname -m)" in
  arm64)  NARCH=arm64 ;;
  x86_64) NARCH=x64 ;;
  *) echo "✗ Unsupported arch $(uname -m)"; exit 1 ;;
esac
NODE_DIR="$BUILD/node-$NODE_VERSION-darwin-$NARCH"
echo "▶ Fetching bundled Node runtime ($NODE_VERSION darwin-$NARCH)…"
curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-darwin-$NARCH.tar.gz" -o "$BUILD/node.tgz"
tar -xzf "$BUILD/node.tgz" -C "$BUILD"

echo "▶ Bundling iMessage agent (Node $NODE_VERSION)…"
# Build the TypeScript (tsc output is ABI-independent — system Node is fine here).
( cd "$AGENT_SRC" && (npm ci || npm install) && npm run build )
mkdir -p "$AGENT_DEST"
cp -R "$AGENT_SRC/dist" "$AGENT_DEST/dist"
cp "$AGENT_SRC/package.json" "$AGENT_DEST/package.json"
# Production-only node_modules, compiled against the BUNDLED Node's ABI (put it
# first on PATH; --build-from-source forces better-sqlite3 to compile for it
# rather than pulling a prebuilt for the system Node).
AGENT_DEPS="$BUILD/agent-deps"; mkdir -p "$AGENT_DEPS"
cp "$AGENT_SRC/package.json" "$AGENT_SRC/package-lock.json" "$AGENT_DEPS/"
( cd "$AGENT_DEPS" && PATH="$NODE_DIR/bin:$PATH" npm ci --omit=dev --build-from-source )
cp -R "$AGENT_DEPS/node_modules" "$AGENT_DEST/node_modules"
# Ship the Node runtime under a recognizable name — this is the binary the user
# adds to Full Disk Access, so "DigbyHelper" reads far better than "node".
cp "$NODE_DIR/bin/node" "$AGENT_DEST/DigbyHelper"
echo "  (agent runtime darwin-$NARCH; better-sqlite3 compiled for Node $NODE_VERSION ABI)"

echo "▶ Signing app (inside-out: agent binaries → app)…"
# V8 (node) needs JIT entitlements under the hardened runtime, or it crashes at launch.
NODE_ENT="$BUILD/agent-node.entitlements"
cat > "$NODE_ENT" <<'ENT'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>com.apple.security.cs.allow-jit</key><true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
</dict></plist>
ENT
# Native libs first (no entitlements), then node (with JIT entitlements), then the app.
# The APP itself needs com.apple.security.device.audio-input (Digby.entitlements,
# ticket 61823826): under the hardened runtime the mic request APIs
# (AVAudioApplication.requestRecordPermission / AVCaptureDevice.requestAccess)
# auto-deny WITHOUT a TCC prompt when the entitlement is missing — Digby never
# landed in Privacy & Security → Microphone on any entitlement-less build
# (≤0.1.12) no matter how often the app asked.
while IFS= read -r -d '' f; do
  codesign --force --options runtime --timestamp --sign "$APP_HASH" "$f"
done < <(find "$AGENT_DEST" \( -name '*.node' -o -name '*.dylib' \) -type f -print0)
codesign --force --options runtime --timestamp --entitlements "$NODE_ENT" --sign "$APP_HASH" "$AGENT_DEST/DigbyHelper"
codesign --force --options runtime --timestamp --entitlements "$HERE/Digby.entitlements" --sign "$APP_HASH" "$APP"
# Prove the entitlement actually landed in the signature (ticket 61823826): the
# whole bug was an invisible build-config gap, so the build refuses to finish
# without printing the audio-input entitlement from the signed binary.
ENT_DUMP="$(codesign -d --entitlements :- "$APP" 2>/dev/null || true)"
echo "$ENT_DUMP" | grep -q "com.apple.security.device.audio-input" \
  || { echo "✗ App signature lacks com.apple.security.device.audio-input — mic would auto-deny (ticket 61823826)."; exit 1; }
echo "  App entitlement com.apple.security.device.audio-input present ✓"
codesign --verify --strict --verbose=2 "$APP"

echo "▶ Notarizing app (a few minutes)…"
ditto -c -k --keepParent "$APP" "$BUILD/Digby.zip"
xcrun notarytool submit "$BUILD/Digby.zip" --keychain-profile "$NOTARY_PROFILE" --wait
xcrun stapler staple "$APP"

echo "▶ Building drag-to-Applications DMG…"
rm -f "$OUT_DMG"
STAGE="$BUILD/dmg-stage"
mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/Digby.app"
ln -s /Applications "$STAGE/Applications"          # the drag target
DMG_RW="$BUILD/Digby-rw.dmg"
hdiutil create -volname "Digby" -srcfolder "$STAGE" -fs HFS+ -format UDRW -ov "$DMG_RW" >/dev/null
MNT="$(mktemp -d)"
hdiutil attach "$DMG_RW" -mountpoint "$MNT" -nobrowse -noverify >/dev/null
# Lay the window out so Digby sits next to the Applications folder ("drag me there").
# Best-effort — the Applications symlink alone already makes it a drag-install.
osascript <<'OSA' >/dev/null 2>&1 || echo "  (Finder layout skipped — symlink still present)"
tell application "Finder"
  tell disk "Digby"
    open
    set current view of container window to icon view
    set toolbar visible of container window to false
    set statusbar visible of container window to false
    set the bounds of container window to {300, 150, 840, 470}
    set vo to the icon view options of container window
    set arrangement of vo to not arranged
    set icon size of vo to 112
    set position of item "Digby.app" of container window to {140, 160}
    set position of item "Applications" of container window to {400, 160}
    update without registering applications
    delay 1
    close
  end tell
end tell
OSA
sync
hdiutil detach "$MNT" -force >/dev/null 2>&1 || true
hdiutil convert "$DMG_RW" -format UDZO -imagekey zlib-level=9 -o "$OUT_DMG" >/dev/null
rm -f "$DMG_RW"
echo "▶ Signing DMG…"
codesign --force --timestamp --sign "$APP_HASH" "$OUT_DMG"
echo "▶ Notarizing DMG…"
xcrun notarytool submit "$OUT_DMG" --keychain-profile "$NOTARY_PROFILE" --wait
xcrun stapler staple "$OUT_DMG"

# Stage the published artifacts so the served .dmg and the update feed ALWAYS
# advertise the same version (a mismatched feed = perpetual update prompts).
# Pass NOTES="…" describing THIS release — the update prompt shows it verbatim.
# The fallback is deliberately generic: a stale feature blurb here shipped as the
# 0.1.8 notes (2026-09-08) because the builder forgot to set NOTES.
NOTES="${NOTES:-Bug fixes and improvements.}"
echo "▶ Staging frontend/public (Digby.dmg + desktop-latest.json @ $VERSION)…"
cp "$OUT_DMG" "$ROOT/frontend/public/Digby.dmg"
# 31fd8440: stamp WHICH Mac agent this DMG bundles (from the source tree that
# was just bundled above). The web UI renders it next to the download button
# ("bundles Mac agent vX") — the owner's "re-downloaded but still an older
# agent" report was exactly this being invisible: the DMG bundles 0.6.3 while
# the current release is 0.8.1, and nothing said so.
AGENT_VERSION="$(node -p "require('$ROOT/imessage-agent/package.json').version")"
cat > "$ROOT/frontend/public/desktop-latest.json" <<EOF
{
  "version": "$VERSION",
  "url": "https://digby.ai/Digby.dmg",
  "agentVersion": "$AGENT_VERSION",
  "notes": "$NOTES"
}
EOF

echo ""
echo "✓ Built + notarized: $OUT_DMG"
echo "✓ Staged: frontend/public/Digby.dmg + desktop-latest.json (v$VERSION)"
echo "  Publish so digby.ai serves it:"
echo "    git add frontend/public/Digby.dmg frontend/public/desktop-latest.json"
echo "    git commit -m 'chore: publish Digby.dmg $VERSION' && git push origin main"
