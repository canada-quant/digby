#!/bin/bash
#
# Digby iMessage agent — one-line installer for macOS.
#
# Usage (the Digby website shows this with your pairing code already filled in):
#   curl -fsSL https://digby.example.com/install-digby-agent.sh | bash -s -- YOUR-CODE
#
# It downloads the agent, builds it, pairs it with your Digby account, and sets it
# up to run in the background 24/7. The only manual step is flipping one macOS
# permission switch at the end (the script opens it for you).
#
set -euo pipefail

# Ticket 31fd8440: `--update-only` — re-install the CURRENT agent over an
# existing (possibly app-bundled / stale) install WITHOUT a pairing code. The
# web card's "Agent update available" hint shows this one-liner; the target is
# a Mac that is ALREADY paired (config.json exists → install.sh skips pairing).
# Without the flag the script exits early on a missing code — which made
# "re-download and reinstall" impossible for an already-paired Mac: the only
# no-code path was re-downloading the .app, whose BUNDLED agent is 0.6.3.
UPDATE_ONLY=0
ARGS=()
for arg in "$@"; do
  if [[ "$arg" == "--update-only" ]]; then UPDATE_ONLY=1; else ARGS+=("$arg"); fi
done
PAIR_CODE="${ARGS[0]:-${DIGBY_PAIR_CODE:-}}"
API_URL="${ARGS[1]:-${DIGBY_API_URL:-https://digby.example.com/api}}"
# Self-host setup hardening (2026-10-20): a self-hosted Digby serves this script,
# the tarball and the pairing API from ITS OWN origin — the "Your Mac" card emits
#   curl -fsSL <origin>/install-digby-agent.sh | DIGBY_INSTALL_HOST=<origin> bash -s -- <code> <origin>/api
# so nothing here falls back to production for a self-host user. Production keeps
# the digby.example.com defaults.
TARBALL_URL="${DIGBY_INSTALL_HOST:-https://digby.example.com}/digby-imessage-agent.tar.gz"
DEST="$HOME/Library/Application Support/Digby"
# An update needs no code; install.sh's pair guard sees the existing config and
# skips pairing. The placeholder only keeps the "no pairing code" early-exit
# below from firing on the update path.
if [[ "$UPDATE_ONLY" = "1" && -z "$PAIR_CODE" ]]; then PAIR_CODE="__update_only__"; fi
# --update-only on a Mac that was never paired cannot work (there is no
# existing pairing to keep) — fail fast with the right next step instead of
# downloading the world and dying at the pair step with a bogus code.
if [[ "$UPDATE_ONLY" = "1" && ! -f "$HOME/.config/digby-agent/config.json" ]]; then
  echo "✗ --update-only: this Mac has no Digby agent pairing to update." >&2
  echo "  In Digby go to Account → Integrations → iMessage → Connect your Mac" >&2
  echo "  and use the one-line command it shows (that one pairs AND installs)." >&2
  exit 1
fi

echo "▶ Digby iMessage agent installer"

# ── macOS only ───────────────────────────────────────────────────────────────
if [ "$(uname)" != "Darwin" ]; then
  echo "✗ This installer is for macOS only." >&2
  exit 1
fi

if [ -z "$PAIR_CODE" ]; then
  echo "✗ No pairing code provided. In Digby go to Account → Integrations → iMessage" >&2
  echo "  → Connect your Mac, then copy the one-line command shown there." >&2
  echo "  (Already paired and just updating? Append --update-only.)" >&2
  exit 1
fi

# ── Ensure Node.js is available ──────────────────────────────────────────────
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v node >/dev/null 2>&1; then
  if command -v brew >/dev/null 2>&1; then
    echo "▶ Installing Node.js via Homebrew (this can take a couple of minutes)…"
    brew install node
    export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
  else
    echo ""
    echo "⚠ Node.js is required but isn't installed."
    echo "  Opening the Node.js download page — install the macOS 'LTS' .pkg, then"
    echo "  paste the same command into Terminal again."
    open "https://nodejs.org/en/download/" 2>/dev/null || true
    exit 1
  fi
fi
echo "  Node: $(command -v node) ($(node -v))"
# a9a74086: fail fast on a Node major the agent cannot install (better-sqlite3
# 12.x supports Node 20–26: prebuilt for 22/24/25/26, EOL 20/23 build from
# source) instead of dying later inside a native build.
NODE_MAJOR="$(node -v | sed 's/^v//' | cut -d. -f1)"
if [[ ! "$NODE_MAJOR" =~ ^[0-9]+$ ]] || [[ "$NODE_MAJOR" -lt 20 ]]; then
  echo "✗ Node.js 20 or newer is required (found $(node -v)) — the agent's database" >&2
  echo "  engine (better-sqlite3) cannot build under an older Node. (Prebuilt for" >&2
  echo "  Node 22/24/25/26; Node 20/23 compile from source.)" >&2
  if command -v brew >/dev/null 2>&1; then
    echo "  Fix: brew upgrade node, then re-run the same command." >&2
  else
    echo "  Fix: install the Node.js LTS from https://nodejs.org, then re-run." >&2
  fi
  exit 1
fi

# ── Download + extract the agent ─────────────────────────────────────────────
echo "▶ Digby agent update — this updates the BACKGROUND AGENT only (not the"
echo "  Digby desktop app; they update separately)."
echo "  Note: macOS ties Screen Recording / Accessibility / Full Disk Access"
echo "  grants to the exact binary. If this install replaces the helper binary,"
echo "  its grants may be invalidated — check System Settings → Privacy &"
echo "  Security afterwards and re-add the binary it names if needed, then"
echo "  quit and relaunch Digby."
mkdir -p "$DEST"
cd "$DEST"
curl -fsSL "$TARBALL_URL" -o digby-imessage-agent.tar.gz
tar -xzf digby-imessage-agent.tar.gz
rm -f digby-imessage-agent.tar.gz
cd imessage-agent

# ── Build, pair, install service (delegates to the bundled installer) ─────────
chmod +x install.sh
DIGBY_PAIR_CODE="$PAIR_CODE" DIGBY_API_URL="$API_URL" ./install.sh
