#!/usr/bin/env bash
#
# Build a SIGNED + NOTARIZED macOS installer (.pkg) for the Digby iMessage agent.
#
# ⚠️  Run this ON A MAC. It needs your Developer ID private keys (in your login
#     Keychain) and notarization credentials — it cannot run in CI/Linux.
#
# Prereqs (one time):
#   • In your login keychain: a valid "Developer ID Application" identity AND a
#     valid "Developer ID Installer" identity (cert + private key).
#   • Apple's "Developer ID Certification Authority" intermediate installed
#     (double-click http://certs.apple.com/devidg2.der). Needed so both certs
#     validate and so productsign can embed the chain. This script does NOT
#     modify your keychain.
#   • Notarization credentials stored once:
#       xcrun notarytool store-credentials digby-notary \
#         --apple-id "YOUR_APPLE_ID" --team-id Z5U9T5PUJ3 --password "APP-SPECIFIC-PW"
#
# Usage:  cd macos-pkg && ./build-pkg.sh
#
set -euo pipefail

# ── Config (override via env if your cert names differ) ───────────────────────
TEAM_ID="${TEAM_ID:-Z5U9T5PUJ3}"
BUNDLE_ID="${BUNDLE_ID:-ai.digby.imessage-agent}"
# 405927c9: the pkg version comes FROM THE AGENT SOURCE, never a hand-set
# default — a hardcoded 0.1.0 shipped for four months and made every
# "what version is this?" surface lie (System Settings showed "Digby
# iMessage Agent 0.1.0" while the agent inside was 0.9.1). An explicit
# VERSION env still wins (release pinning). Computed after ROOT (below).
VERSION="${VERSION:-}"
INSTALL_DIR="${INSTALL_DIR:-/Library/Digby/imessage-agent}"
NODE_VERSION="${NODE_VERSION:-v20.18.1}"
NOTARY_PROFILE="${NOTARY_PROFILE:-digby-notary}"
APP_IDENTITY="${APP_IDENTITY:-Developer ID Application: Paul Cozzolino ($TEAM_ID)}"
INSTALLER_IDENTITY="${INSTALLER_IDENTITY:-Developer ID Installer: Paul Cozzolino ($TEAM_ID)}"

[ "$(uname)" = "Darwin" ] || { echo "✗ Run this on macOS." >&2; exit 1; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
AGENT_SRC="$ROOT/imessage-agent"
if [[ -z "$VERSION" ]]; then
  VERSION="$(node -p "require(\"$AGENT_SRC/package.json\").version" 2>/dev/null || echo "")"
  [[ -n "$VERSION" ]] || { echo "✗ could not read the agent version from $AGENT_SRC/package.json — pass VERSION=x.y.z explicitly." >&2; exit 1; }
fi
OUT="$ROOT/DigbyAgent.pkg"
BUILD="$(mktemp -d)"
PAYLOAD="$BUILD/payload"
APP_ROOT="$PAYLOAD$INSTALL_DIR"
SCRIPTS="$BUILD/scripts"
trap 'rm -rf "$BUILD"' EXIT

echo "▶ Building Digby agent installer  (team $TEAM_ID, $BUNDLE_ID v$VERSION)"

# ── Preflight: resolve both identities to their SHA-1 hash ────────────────────
# Sign by hash (not name) so a cert duplicated across login+System keychains
# can't trigger "ambiguous identity". Policies differ:
#   • Developer ID Application → code-signing policy
#   • Developer ID Installer   → basic policy (installer certs aren't code-signing)
APP_HASH="$(security find-identity -v -p codesigning | awk -v n="$APP_IDENTITY" 'index($0,n){print $2; exit}')"
[ -n "$APP_HASH" ] || { echo "✗ Missing/invalid signing identity: $APP_IDENTITY"; echo "  Ensure the cert+key are in login and the Developer ID intermediate is installed."; exit 1; }
INST_HASH="$(security find-identity -v -p basic | awk -v n="$INSTALLER_IDENTITY" 'index($0,n){print $2; exit}')"
[ -n "$INST_HASH" ] || { echo "✗ Missing/invalid signing identity: $INSTALLER_IDENTITY"; echo "  If this cert was recreated, make sure you did not revoke the one in your keychain,"; echo "  and that the Developer ID intermediate is installed (open http://certs.apple.com/devidg2.der)."; exit 1; }
echo "  Application identity: $APP_HASH"
echo "  Installer identity:   $INST_HASH"

# ── 0. Staleness guard (ticket 405927c9) ──────────────────────────────────────
# The served DigbyAgent.pkg froze agent 0.1.0 for four months because the
# .pkg is built by hand and nothing tied it to the release tarball agents
# actually download. Refuse to build a .pkg whose agent predates the RELEASE
# MANIFEST version — a stale .pkg is a silent fleet regression machine (it
# installs a never-self-updating agent that flaps agentVersion forever).
MANIFEST_SRC="$ROOT/backend/src/modules/crossmodel/imessage/agent-release.ts"
MANIFEST_VERSION="$(sed -n "s/.*version: '\([0-9.]*\)'.*/\1/p" "$MANIFEST_SRC" | head -1)"
# Fail CLOSED (review advisory 3): a manifest rename/format change that makes the
# sed extract nothing must abort the build, not silently disable the guard.
[[ -n "$MANIFEST_VERSION" ]] || { echo "✗ could not read the release manifest version from $MANIFEST_SRC — the staleness guard cannot run." >&2; exit 1; }
if [[ "$MANIFEST_VERSION" != "$VERSION" ]]; then
  echo "✗ Agent version mismatch: the tree's agent is $VERSION but the release" >&2
  echo "  manifest ($MANIFEST_SRC) says $MANIFEST_VERSION." >&2
  echo "  A .pkg that bundles an agent older than the released tarball installs a" >&2
  echo "  never-self-updating agent that flaps this Mac's version forever." >&2
  echo "  Fix: run scripts/publish-agent-tarball.sh (bumps agent + manifest" >&2
  echo "  together), then rebuild the .pkg." >&2
  exit 1
fi
echo "  Release manifest $MANIFEST_VERSION matches agent $VERSION ✓"

# ── 1. Build the agent (TypeScript → dist/) ───────────────────────────────────
echo "▶ Building the agent…"
( cd "$AGENT_SRC" && (npm ci || npm install) && npm run build )

# ── 2. Assemble the payload at INSTALL_DIR ────────────────────────────────────
mkdir -p "$APP_ROOT" "$SCRIPTS"
cp -R "$AGENT_SRC/dist" "$APP_ROOT/dist"
cp "$AGENT_SRC/package.json" "$APP_ROOT/package.json"

# Production-only node_modules (compiles better-sqlite3 for THIS arch)
echo "▶ Installing runtime dependencies…"
PKGTMP="$BUILD/pkgtmp"; mkdir -p "$PKGTMP"
cp "$AGENT_SRC/package.json" "$AGENT_SRC/package-lock.json" "$PKGTMP/"
( cd "$PKGTMP" && npm ci --omit=dev )
cp -R "$PKGTMP/node_modules" "$APP_ROOT/node_modules"

# ── 3. Bundle a Node runtime (so end users need nothing installed) ────────────
case "$(uname -m)" in
  arm64)  NARCH=arm64 ;;
  x86_64) NARCH=x64 ;;
  *) echo "✗ Unsupported arch $(uname -m)"; exit 1 ;;
esac
# The DISTRIBUTION schema's hostArchitectures wants Apple arch names (x86_64),
# not the node-tarball names (x64) — a separate mapping (review advisory 1:
# an Intel build embedding hostArchitectures="x64" would fail at INSTALL time
# on a user's Mac, not at build time).
case "$(uname -m)" in
  arm64)  PKG_ARCH=arm64 ;;
  x86_64) PKG_ARCH=x86_64 ;;
esac
echo "▶ Bundling Node $NODE_VERSION ($NARCH)…"
curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-darwin-$NARCH.tar.gz" -o "$BUILD/node.tgz"
tar -xzf "$BUILD/node.tgz" -C "$BUILD"
# Ship the Node runtime under a recognizable name — this is the binary the user
# adds to Full Disk Access, so "DigbyAgent" reads far better than "node"
# (51d8dbe0: TCC lists the executable's name; the CLI installer ships the
# same name, ~/Library/Application Support/Digby/bin/DigbyAgent).
cp "$BUILD/node-$NODE_VERSION-darwin-$NARCH/bin/node" "$APP_ROOT/DigbyAgent"

# ── 4. Sign every Mach-O binary (Developer ID Application + hardened runtime) ──
echo "▶ Code-signing binaries…"
while IFS= read -r -d '' f; do
  codesign --force --options runtime --timestamp --sign "$APP_HASH" "$f"
done < <(find "$APP_ROOT" \( -name 'DigbyAgent' -o -name '*.node' -o -name '*.dylib' \) -type f -print0)

# ── 5. postinstall script ─────────────────────────────────────────────────────
cp "$ROOT/macos-pkg/scripts/postinstall" "$SCRIPTS/postinstall"
chmod +x "$SCRIPTS/postinstall"

# ── 6. Component pkg → DISTRIBUTION pkg (title + version) → sign ─────────────
# 405927c9: `productbuild --package <component>` alone produces an installer
# with NO title — Installer.app shows a generic "Installer", the completion
# line reads "installed ''", and System Settings lists a nameless package
# ("very sketchy looking"). A distribution XML gives the installer its
# identity: <title> is what Installer.app shows in the title bar and what
# System Settings → Installation history lists.
echo "▶ Packaging (title: Digby iMessage Agent)…"
# The component file must be named EXACTLY as the <pkg-ref> text below —
# productbuild resolves the ref against --package-path by filename.
pkgbuild --root "$PAYLOAD" --scripts "$SCRIPTS" \
  --identifier "$BUNDLE_ID" --version "$VERSION" --install-location "/" \
  "$BUILD/$BUNDLE_ID.pkg"
cat > "$BUILD/distribution.xml" <<XML
<?xml version="1.0" encoding="utf-8" standalone="no"?>
<installer-gui-script minSpecVersion="1">
    <title>Digby iMessage Agent</title>
    <options customize="never" allow-external-scripts="no" hostArchitectures="${PKG_ARCH}"/>
    <background file="installer-background.png" mime-type="image/png" alignment="center" scaling="proportional"/>
    <pkg-ref id="$BUNDLE_ID" version="$VERSION" onConclusion="none">${BUNDLE_ID}.pkg</pkg-ref>
    <choices-outline>
        <line choice="default"/>
    </choices-outline>
    <choice id="default" title="Digby iMessage Agent" description="Digby's background iMessage agent — reads and sends iMessages on this Mac and relays them to your Digby account. Installed to /Library/Digby/imessage-agent; runs at login as a LaunchAgent." visible="false">
        <pkg-ref id="$BUNDLE_ID"/>
    </choice>
    <volume-check>
        <allowed-os-versions>
            <os-version min="12.0"/>
        </allowed-os-versions>
    </volume-check>
</installer-gui-script>
XML
# The <background> image ships INSIDE the distribution: productbuild resolves
# its `file` attribute against the --resources dir. The Digby propeller-beanie
# mark (the "no logo" half of ticket 405927c9 — a .pkg's own file icon cannot
# be customized, so the background is Installer.app's one branding surface).
mkdir -p "$BUILD/resources"
cp "$ROOT/macos-pkg/assets/installer-background.png" "$BUILD/resources/installer-background.png"
productbuild --distribution "$BUILD/distribution.xml" \
  --resources "$BUILD/resources" \
  --package-path "$BUILD" --identifier "$BUNDLE_ID" --version "$VERSION" \
  "$BUILD/unsigned.pkg"
productsign --sign "$INST_HASH" --timestamp "$BUILD/unsigned.pkg" "$OUT"

# ── 7. Notarize + staple ──────────────────────────────────────────────────────
echo "▶ Notarizing (this can take a few minutes)…"
xcrun notarytool submit "$OUT" --keychain-profile "$NOTARY_PROFILE" --wait
xcrun stapler staple "$OUT"

# ── 8. Freshness stamp + stage for publish (405927c9 interim, 2026-10-25) ─────
# IMessageCard features the .pkg as the primary install path ONLY while this
# stamp says the served pkg bundles the CURRENT agent release; an unstamped or
# stale pkg is de-featured to the one-line installer (which always installs the
# current release). Same shape as the DMG's desktop-latest.json (31fd8440);
# the .pkg's version IS the agent version (derived from the agent source above).
echo "▶ Staging frontend/public (DigbyAgent.pkg + DigbyAgent.pkg.json @ agent $VERSION)…"
cp "$OUT" "$ROOT/frontend/public/DigbyAgent.pkg"
cat > "$ROOT/frontend/public/DigbyAgent.pkg.json" <<EOF
{
  "version": "$VERSION",
  "url": "DigbyAgent.pkg",
  "agentVersion": "$VERSION"
}
EOF
# url is RELATIVE on purpose (reviewer 2026-10-25): the stamp sits next to the
# pkg, so a bare filename resolves on whatever origin serves it — a hard-coded
# https://digby.example.com/DigbyAgent.pkg would publish a lie on every self-host.

echo ""
echo "✓ Built + notarized: $OUT"
echo "✓ Staged: frontend/public/DigbyAgent.pkg + DigbyAgent.pkg.json (agent $VERSION)"
echo "  Publish so digby.example.com serves them:"
echo "    git add frontend/public/DigbyAgent.pkg frontend/public/DigbyAgent.pkg.json"
echo "    git commit -m 'chore: publish DigbyAgent.pkg $VERSION' && git push origin main"
