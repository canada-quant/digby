#!/usr/bin/env bash
#
# Publish the Digby mac agent tarball + the backend's release manifest in ONE
# step (ticket 4e75cdea, 2026-10-08).
#
# WHY THIS EXISTS: the served tarball (frontend/public/digby-imessage-agent.tar.gz)
# sat at v0.1.0 for weeks while agents ran 0.7.x — it was rebuilt by hand and
# nothing tied it to a version. The self-update mechanism turns that tarball
# into the FLEET's update source, so it must always match the backend manifest
# (version + sha256). This script builds the tarball from the CURRENT source,
# computes its sha256, rewrites BOTH artifacts together, and refuses to
# publish anything that does not verify.
#
# Usage:  scripts/publish-agent-tarball.sh            # from the repo root
#         notes="What this release ships" scripts/publish-agent-tarball.sh
#
# What it changes (git add these together — never one without the other):
#   frontend/public/digby-imessage-agent.tar.gz       the artifact agents download
#   backend/src/modules/crossmodel/imessage/agent-release.ts   the manifest (version+sha256)
#   imessage-agent/src/config.ts                      AGENT_VERSION (must equal the manifest)
#   imessage-agent/package.json                       version (must equal the manifest)
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENT="$ROOT/imessage-agent"
TARBALL="$ROOT/frontend/public/digby-imessage-agent.tar.gz"
MANIFEST="$ROOT/backend/src/modules/crossmodel/imessage/agent-release.ts"

cd "$AGENT"

# ── The version being released: single source = AGENT_VERSION in config.ts ──
VERSION="$(node -e "console.log(require('./dist/config.js').AGENT_VERSION)")"
PKG_VERSION="$(node -e "console.log(require('./package.json').version)")"
if [[ "$VERSION" != "$PKG_VERSION" ]]; then
  echo "✗ dist/config.js AGENT_VERSION ($VERSION) ≠ package.json version ($PKG_VERSION)." >&2
  echo "  Bump BOTH to the same version (the tarball's own version gate checks it)." >&2
  exit 1
fi
echo "▶ Publishing agent $VERSION"

# ── Build from clean source, then test — a red test suite never ships ────────
npm run build
npm test

# ── Stage the tarball exactly like the one the installer serves (src-only) ───
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/imessage-agent"
cp -R "$AGENT/src" "$STAGE/imessage-agent/src"
cp "$AGENT/package.json" "$AGENT/package-lock.json" "$AGENT/tsconfig.json" "$STAGE/imessage-agent/"
cp -R "$AGENT/launchd" "$STAGE/imessage-agent/launchd"
cp "$AGENT/install.sh" "$STAGE/imessage-agent/install.sh"
chmod +x "$STAGE/imessage-agent/install.sh"
cp "$AGENT/README.md" "$STAGE/imessage-agent/README.md"
mkdir -p "$ROOT/frontend/public"
tar -czf "$TARBALL" -C "$STAGE" imessage-agent

# ── sha256 + verify the artifact we just wrote ───────────────────────────────
SHA="$(shasum -a 256 "$TARBALL" | awk '{print $1}')"
if [[ ! "$SHA" =~ ^[0-9a-f]{64}$ ]]; then
  echo "✗ could not compute sha256" >&2
  exit 1
fi
# Extract-and-check: the tarball must contain a package.json naming $VERSION.
CHECK="$(tar -xzOf "$TARBALL" imessage-agent/package.json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).version))")"
if [[ "$CHECK" != "$VERSION" ]]; then
  echo "✗ tarball carries version $CHECK, expected $VERSION" >&2
  exit 1
fi
# …and its package-lock.json must name $VERSION too (ticket e530220e). The
# lockfile SHIPS INSIDE the tarball, so a lock left behind by an earlier bump
# makes the released artifact misstate its own version — 0.9.22 shipped with a
# lock claiming 0.9.21 because only package.json was bumped and this check only
# looked at package.json. Check BOTH so the publish step cannot emit a
# self-contradicting artifact again.
LOCK_CHECK="$(tar -xzOf "$TARBALL" imessage-agent/package-lock.json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const l=JSON.parse(s);console.log(l.version+' '+l.packages[''].version)})")"
if [[ "$LOCK_CHECK" != "$VERSION $VERSION" ]]; then
  echo "✗ tarball package-lock.json versions are [$LOCK_CHECK], expected [$VERSION $VERSION]." >&2
  echo "  Bump imessage-agent/package-lock.json (both the root \"version\" and" >&2
  echo "  packages[\"\"].version) alongside package.json — the lock ships in the tarball." >&2
  exit 1
fi
echo "✓ tarball $VERSION sha256=$SHA"

# ── Rewrite the backend manifest (version + sha256 + notes) ──────────────────
# ticket 0e4c9601: minUpdaterVersion is a hand-set POLICY field (which updater
# generations may take this release) — the publish step PRESERVES whatever
# floor the manifest carries; it never invents or drops one.
NOTES="${notes:-Self-update: the agent now upgrades itself when the backend advertises a newer release.}"
python3 - "$MANIFEST" "$VERSION" "$SHA" "$NOTES" <<'PY'
import re, sys, json
path, version, sha, notes = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
src = open(path).read()
m = re.search(r"^\s*minUpdaterVersion:\s*'([^']+)'\s*,?\s*$", src, flags=re.M)
floor = f"  minUpdaterVersion: '{m.group(1)}',\n" if m else ""
new_block = (
    "export const AGENT_RELEASE: AgentReleaseManifest = {\n"
    f"  version: '{version}',\n"
    "  url: 'https://digby.ai/digby-imessage-agent.tar.gz',\n"
    f"  sha256: '{sha}',\n"
    f"  notes: {json.dumps(notes)},\n"
    + floor
    + "};"
)
out, n = re.subn(
    r"export const AGENT_RELEASE: AgentReleaseManifest = \{.*?\};",
    # A FUNCTION replacement is inserted literally — a string repl would parse
    # backslash escapes in the notes (json.dumps emits \uXXXX for non-ASCII,
    # and re rejects \u as "bad escape" — bit 0e4c9601's em-dashed notes).
    lambda m: new_block,
    src,
    count=1,
    flags=re.S,
)
if n != 1:
    print("✗ could not rewrite AGENT_RELEASE in", path, file=sys.stderr)
    sys.exit(1)
# FAIL-CLOSED floor check (reviewer note 5, 0e4c9601): a floor that exists in
# the source in ANY spelling but was not preserved (hand-reformat: double
# quotes, trailing comment, changed whitespace) must ABORT the publish, never
# silently drop the updater floor — a dropped floor re-exposes below-floor
# updaters to the release.
had_floor = re.search(r"minUpdaterVersion", src) is not None
kept_floor = re.search(r"^\s*minUpdaterVersion:\s*'", out, flags=re.M) is not None
if had_floor and not kept_floor:
    print(
        "✗ AGENT_RELEASE names minUpdaterVersion but the rewrite could not "
        "preserve it (unsupported format). Normalize the field to "
        "minUpdaterVersion: 'x.y.z', in AGENT_RELEASE and re-run.",
        file=sys.stderr,
    )
    sys.exit(1)
open(path, "w").write(out)
print(f"✓ manifest rewritten: {path} → {version}")
PY

echo ""
echo "✓ Published agent $VERSION (tarball + manifest, verified consistent)."
echo "  Review + commit TOGETHER:"
echo "    git add frontend/public/digby-imessage-agent.tar.gz \\"
echo "        backend/src/modules/crossmodel/imessage/agent-release.ts \\"
echo "        imessage-agent/src/config.ts imessage-agent/package.json"
