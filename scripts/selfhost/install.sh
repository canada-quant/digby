#!/bin/sh
# install.sh — install Digby on this machine from PUBLISHED images.
# Phase 1 self-host, todo 9caf3230.
#
# This is the no-source-clone path: it writes the two files the stack needs
# (the published compose file and a .env seeded from the documented example),
# creates the branding directory, pulls the images, and starts the stack.
# You never clone this repository.
#
#   sh install.sh                 # install into ./digby
#   DIGBY_DIR=/opt/digby sh install.sh
#
# WHAT THIS SCRIPT WILL NOT DO
#   - It never writes a secret for you. `.env` starts with EMPTY placeholders;
#     the two JWT secrets and one model key are yours to generate, and the
#     script tells you the exact command for each.
#   - It never overwrites an existing .env, compose file or branding directory.
#     Re-running it is safe and idempotent.
#   - It never touches this machine outside $DIGBY_DIR.
#
# POSIX sh on purpose: this runs on a stranger's box where bash may be absent
# (Alpine, minimal Debian). No bashisms, no arrays, no `local`.

set -eu

REPO="${DIGBY_REPO:-canada-quant/digby}"
BRANCH="${DIGBY_REF:-main}"
DIGBY_DIR="${DIGBY_DIR:-./digby}"
RAW="https://raw.githubusercontent.com/${REPO}/${BRANCH}"

say() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

# ── preflight ────────────────────────────────────────────────────────────────
have docker || die "docker is not installed. See https://docs.docker.com/engine/install/"

# `docker compose` (v2 plugin) is what this stack is written for. `docker-compose`
# (v1) understands the same file but not every v2 key, so we refuse it rather
# than produce a confusing half-working install.
if ! docker compose version >/dev/null 2>&1; then
  die "Docker Compose v2 is required (\`docker compose version\` failed).
      If you have the standalone v1 binary, install the compose plugin:
      https://docs.docker.com/compose/install/linux/"
fi

# `docker compose pull` needs the daemon reachable; a missing group membership
# is the single most common first-install failure, so name it.
docker info >/dev/null 2>&1 || die "cannot talk to the Docker daemon.
      Start it, or add your user to the 'docker' group:
        sudo usermod -aG docker \$USER   # then log out and back in"

# Downloading a file needs one of curl/wget; prefer curl.
if have curl; then
  fetch() { curl -fsSL "$1" -o "$2"; }
elif have wget; then
  fetch() { wget -qO "$2" "$1"; }
else
  die "need either curl or wget to download the install files"
fi

# ── layout ───────────────────────────────────────────────────────────────────
mkdir -p "$DIGBY_DIR"
cd "$DIGBY_DIR"
say "installing Digby into $(pwd)"

# ── 1. the published compose file ────────────────────────────────────────────
# A GENERATED file (scripts/selfhost/render-published-compose.mjs in the repo)
# whose every service pulls an image instead of building one.
COMPOSE=docker-compose.selfhost.published.yml
if [ -f "$COMPOSE" ]; then
  say "  keeping existing $COMPOSE"
else
  fetch "${RAW}/${COMPOSE}" "$COMPOSE" || die "could not download $COMPOSE from ${RAW}"
  say "  wrote $COMPOSE"
fi

# ── 2. Caddyfile ─────────────────────────────────────────────────────────────
# The reverse proxy's config is a FILE the compose mounts, not something baked
# into the image, so it has to be present on disk before the stack starts.
mkdir -p deploy/selfhost
if [ -f deploy/selfhost/Caddyfile ]; then
  say "  keeping existing deploy/selfhost/Caddyfile"
else
  fetch "${RAW}/deploy/selfhost/Caddyfile" deploy/selfhost/Caddyfile \
    || die "could not download deploy/selfhost/Caddyfile from ${RAW}"
  say "  wrote deploy/selfhost/Caddyfile"
fi

# ── 3. .env ──────────────────────────────────────────────────────────────────
# Seeded from the documented example, which ships EMPTY placeholders only.
# Never overwritten: an operator's real secrets must survive a re-run.
if [ -f .env ]; then
  say "  keeping existing .env (not overwritten)"
else
  fetch "${RAW}/selfhost.env.example" .env || die "could not download selfhost.env.example"
  # The example is documentation-shaped: it is entirely comments plus empty
  # values, EXCEPT the handful of non-secret defaults the stack needs to boot.
  # Those are safe to keep as-is; nothing here is a credential.
  say "  wrote .env from selfhost.env.example"
  chmod 600 .env
fi

# ── 4. branding directory (mounted read-only into the frontend) ──────────────
# The compose mounts ./branding; Docker would otherwise create it as root and a
# later operator drop-in would fail on permissions.
mkdir -p branding
say "  ensured branding/"

# ── 5. pull ──────────────────────────────────────────────────────────────────
say ""
say "pulling images (this is the step that needs no source tree)…"
docker compose -f "$COMPOSE" pull || die "image pull failed.
      Check that the release exists: https://github.com/${REPO}/pkgs/container/digby-backend
      and that DIGBY_IMAGE_TAG (if you set it) names a real published tag."

# ── 6. what the operator still has to do ────────────────────────────────────
say ""
say "──────────────────────────────────────────────────────────────"
say " Almost there. Two things are yours to set in .env:"
say ""
say "   1. The two session secrets (generate each one):"
say "        openssl rand -hex 32"
say "      paste one into JWT_SECRET and a DIFFERENT one into JWT_REFRESH_SECRET."
say ""
say "   2. At least ONE model provider key, or the chat has no model to call:"
say "        DEEPSEEK_API_KEY / MOONSHOT_API_KEY / ZAI_API_KEY / DASHSCOPE_API_KEY"
say ""
say "   Optional but recommended: SELFHOST_ADMIN_EMAIL=you@example.com"
say "   — the account that registers with that address becomes ADMIN."
say ""
say " Then start it:"
say "   cd $(pwd) && docker compose -f $COMPOSE up -d"
say "   open http://localhost:8080"
say ""
say " Full operator guide (every credential, branding, TLS, backups):"
say "   https://github.com/${REPO}/blob/${BRANCH}/docs/SELF_HOST.md"
say "──────────────────────────────────────────────────────────────"