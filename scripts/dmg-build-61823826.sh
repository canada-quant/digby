#!/bin/bash
# Ticket 61823826 (dispatch 1, lane 974bcdd2) — build + notarize + publish
# Digby.dmg 0.1.13 on the build Mac. Modeled on the 2689fa04 build script
# (dmg-build-2689fa04.sh — a lane-branch-only script, not merged; its publish
# landed as commit 86e128d38e "chore: publish Digby.dmg 0.1.12 (mic
# permission fix, ticket 2689fa04) (#1997)"): REPO discovery (env →
# mdfind → find → fresh-clone fallback), dirty-tree + ff-only guards,
# agent version read from the tree (never hard-coded), lane-branch push so a
# mid-build main advance can't strand the fix, PUSH-FAILED recovery path.
#
# The 0.1.13 build is the FIX ITSELF: build-app.sh now signs the app with
# macos-app/Digby.entitlements (com.apple.security.device.audio-input) and
# self-verifies the entitlement landed in the signed binary. Without the
# rebuild the owner's Macs keep running the entitlement-less 0.1.12 and the
# mic TCC prompt never appears — merging the code alone changes nothing on
# any Mac.
set -e
# The launcher may pre-set REPO (a verified path); otherwise discover via mdfind.
if [ -z "${REPO:-}" ]; then
  for B in $(mdfind -name build-app.sh 2>/dev/null | grep -v '/\.Trash/'); do
    D=$(cd "$(dirname "$B")/.." 2>/dev/null && pwd) || continue
    R=$(git -C "$D" rev-parse --show-toplevel 2>/dev/null) || continue
    if git -C "$R" remote get-url origin 2>/dev/null | grep -q crossmodel; then REPO="$R"; break; fi
  done
fi
# Fallback 1: filesystem find — Spotlight can miss dev folders entirely.
if [ -z "${REPO:-}" ]; then
  for B in $(find /Users /Volumes -maxdepth 6 \( -path '*/Library' -o -path '*/node_modules' -o -name '.Trash' \) -prune -o -name build-app.sh -print 2>/dev/null); do
    D=$(cd "$(dirname "$B")/.." 2>/dev/null && pwd) || continue
    R=$(git -C "$D" rev-parse --show-toplevel 2>/dev/null) || continue
    if git -C "$R" remote get-url origin 2>/dev/null | grep -q crossmodel; then REPO="$R"; break; fi
  done
fi
# Fallback 2: fresh clone (private repo — needs GitHub credentials). A foreground
# run may auth interactively; a nohup run must fail fast, never hang on a prompt.
if [ -z "${REPO:-}" ]; then
  echo "NO-CHECKOUT-FOUND — attempting a fresh clone of example-org/crossmodel…"
  if [ -t 0 ]; then
    git clone https://github.com/example-org/crossmodel.git "$HOME/crossmodel" \
      || { echo "CLONE-FAILED — clone once by hand (git clone https://github.com/example-org/crossmodel.git ~/crossmodel), auth, then re-run"; exit 1; }
  else
    GIT_TERMINAL_PROMPT=0 git clone https://github.com/example-org/crossmodel.git "$HOME/crossmodel" \
      || { echo "CLONE-FAILED (unattended run, no cached credentials) — a human must clone once by hand, then re-run"; exit 1; }
  fi
  REPO="$HOME/crossmodel"
fi
[ -n "$REPO" ] || { echo "NO-REPO-FOUND"; exit 1; }
cd "$REPO"
[ -z "$(git status --porcelain)" ] || { echo "DIRTY-TREE-ABORT"; exit 1; }
git fetch origin main
git checkout main 2>/dev/null || git checkout -b main origin/main
git merge --ff-only origin/main || { echo "FF-PULL-FAILED"; exit 1; }
echo "BUILDING-AT: $(git rev-parse --short HEAD)"
# The release notes must name the agent this tree ACTUALLY bundles — the same
# read build-app.sh stamps into desktop-latest.json, never a hard-coded number.
AGENT_VERSION="$(node -p "require('$PWD/imessage-agent/package.json').version")"
[ -n "$AGENT_VERSION" ] || { echo "AGENT-VERSION-READ-FAILED — is node on PATH?"; exit 1; }
echo "BUNDLING-AGENT: $AGENT_VERSION"
cd macos-app
export NOTES="Microphone permission fix (the real one): the app now ships the macOS audio-input entitlement, so pressing Ctrl+Shift+Space finally shows the actual macOS microphone permission prompt and Digby appears in Privacy & Security → Microphone. Also carries multi-display capture with owner-presence facts and the one-time Accessibility, Screen Recording and Full Disk Access permission re-grant a re-signed app needs. Bundles Mac agent $AGENT_VERSION — the current agent release."
./build-app.sh
cd ..
git add frontend/public/Digby.dmg frontend/public/desktop-latest.json
git commit -m "chore: publish Digby.dmg 0.1.13 (mic entitlement fix, ticket 61823826)"
if git push origin main:refs/heads/digby/dmg-0.1.13-61823826; then
  echo "DMG-LANE-BRANCH-PUSHED: $(git rev-parse HEAD)"
else
  echo "PUSH-FAILED — build + staging COMPLETE at $REPO (commit $(git rev-parse --short HEAD)); retry: cd $REPO && git push origin main:refs/heads/digby/dmg-0.1.13-61823826"
fi
