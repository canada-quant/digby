# Prebuilt Digby shared-tailnet dev-container image (ticket 793f5130).
#
# Optional: point the backend at this via CODING_DEV_IMAGE to skip the
# boot-time `curl | sh` tailscale install (and the netcat apt round-trip).
# The boot script (backend/src/modules/crossmodel/coding/dev-container.service.ts
# bootScript()) guards both installs with `command -v`, so on this image it
# skips straight to starting tailscaled. Without CODING_DEV_IMAGE everything
# still works on plain node:20 — first boot just installs at runtime.
#
# Building/pushing is a MANUAL ops step for now — deliberately NOT wired into
# CI. See README.md alongside this file.

# Match the runner image family (CODING_RUNNER_IMAGE defaults to node:20,
# Debian bookworm).
FROM node:20

# Tailscale via the official apt repo (bookworm) + netcat-openbsd — the
# SOCKS-capable `nc -x` that the tssh helper's ProxyCommand uses (node:20
# ships no nc variant at all).
RUN curl -fsSL https://pkgs.tailscale.com/stable/debian/bookworm.noarmor.gpg -o /usr/share/keyrings/tailscale-archive-keyring.gpg \
 && curl -fsSL https://pkgs.tailscale.com/stable/debian/bookworm.tailscale-keyring.list -o /etc/apt/sources.list.d/tailscale.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends tailscale netcat-openbsd \
 && rm -rf /var/lib/apt/lists/*

# GitHub CLI (ticket ad7a1c3c) — session shells get GITHUB_TOKEN/GH_TOKEN and
# are told to drive GitHub with gh, but stock node:20 ships no gh. Baked in so
# container boots skip the backend's runtime docker-cp provisioning
# (container.service ensureGhCli no-ops on `command -v gh` when present).
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*

# tssh/tcurl helpers (ticket d3a983ca) — byte-identical to what the boot
# script writes, so behavior is the same whether or not the image is prebuilt
# (the boot script harmlessly rewrites them with the same content).
RUN printf '%s\n' '#!/bin/sh' 'exec ssh -o ProxyCommand='\''nc -x localhost:1055 %h %p'\'' "$@"' > /usr/local/bin/tssh \
 && printf '%s\n' '#!/bin/sh' 'exec curl --proxy socks5h://localhost:1055 "$@"' > /usr/local/bin/tcurl \
 && chmod 755 /usr/local/bin/tssh /usr/local/bin/tcurl

# Session user (2026-10-13): session execs run as uid 1001 with HOME=/tmp, and
# OpenSSH refuses to start for a uid with no passwd row ("No user exists for
# uid 1001"). Same row the boot script adds (SESSION_USER_SCRIPT).
RUN echo 'digby:x:1001:1001:Digby session:/tmp:/bin/bash' >> /etc/passwd \
 && echo 'digby:x:1001:' >> /etc/group

# No ENTRYPOINT/CMD override and no tini: the backend always launches this
# container with `--init` and `bash -lc <bootScript>` (dev-container.service).
