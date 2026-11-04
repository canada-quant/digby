# syntax=docker/dockerfile:1
# Build stage
FROM node:20-alpine AS build

WORKDIR /app

COPY package*.json ./
COPY prisma ./prisma/

# npm cache mount (see frontend/Dockerfile) — persists across deploys.
RUN --mount=type=cache,id=npm-backend,target=/root/.npm npm ci

COPY . .

RUN npm run prisma:generate
# Heap headroom for tsc (2026-10-04): the backend program outgrew Node's
# ~2 GB default old-space ceiling (deploy run 37184912588 on 5ff43f4f:
# "FATAL ERROR: Reached heap limit ... 2018.7 (2086.4) MB" — same tree's
# tsc passed on the 2× larger CI runner, so the box-local docker build with
# its default heap is the binding constraint). 4 GB matches the repo's
# selfhost convention (NODE_OPTIONS=--max-old-space-size=2560 there; this
# build stage is the heavier one) and fits the 7.6 GiB prod boxes with room
# for the concurrent frontend image build.
ENV NODE_OPTIONS="--max-old-space-size=4096"
RUN npm run build

# Production stage
FROM node:20-alpine AS production

WORKDIR /app

# git: required by the Digby Code agentic-coding module (repo clone + per-session
# git worktrees). openssh-client lets git use SSH remotes if ever needed.
# su-exec: the entrypoint fixes coding-workspace volume ownership as root, then
# drops to the nodejs app user.
RUN apk add --no-cache git openssh-client su-exec bash docker-cli

# youtube_pipe slow path (audio for videos without captions): yt-dlp needs an
# external JS runtime for YouTube player challenges since 2025-11 — Deno is the
# officially recommended one. musl-native pieces ONLY (Alpine has no glibc —
# the gnu-linked yt-dlp_linux/deno zip binaries will not run here): yt-dlp's
# musllinux static binary + Deno from Alpine community. yt-dlp is PINNED —
# `latest` makes deploy builds nondeterministic, and YouTube breakage means
# this wants a deliberate bump every few months. A failed download fails the
# BUILD on purpose: a silently missing binary degrades the pipe to
# captions-only at runtime, which is much harder to notice than a red build.
ARG YTDLP_VERSION=2026.07.04
RUN apk add --no-cache ca-certificates deno && \
    set -e; \
    arch="$(uname -m)"; \
    case "$arch" in \
      x86_64)  YTDLP_BIN=yt-dlp_musllinux ;; \
      aarch64) YTDLP_BIN=yt-dlp_musllinux_aarch64 ;; \
      *) echo "unsupported arch: $arch"; exit 1 ;; \
    esac; \
    wget -q -O /usr/local/bin/yt-dlp "https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/${YTDLP_BIN}"; \
    chmod +x /usr/local/bin/yt-dlp; \
    yt-dlp --version && deno --version

COPY package*.json ./

# Separate mount id from the build stage — dev vs production dep sets differ.
RUN --mount=type=cache,id=npm-backend-prod,target=/root/.npm npm ci --only=production

# Ownership (deploy_speedups #2, 2026-09-26): the app user is uid/gid 1001
# (created below). Every tree the image ships for the app is COPY --chown'ed
# at copy time (numeric ids — the user need not exist yet), so the old
# `chown -R nodejs:nodejs /app` — a 108-120 s metadata walk over node_modules
# on the 2-vCPU web boxes, ~2 min of every backend build, on every box — is
# gone. node_modules from `npm ci` above stays root-owned: the app only READS
# it (npm installs 755/644; nothing writes there at runtime — prisma engines
# are installed at build time). /app itself and the workspace root are
# chown'ed NON-recursively (one inode each) so the app can create top-level
# entries (uploads/, the volume mount points); the entrypoint still chowns the
# mounted volume roots at boot. BACKEND_CHOWN_RECURSIVE=1 (compose build arg ←
# runner Variable or the box .env) restores the recursive walk.
COPY --chown=1001:1001 prisma ./prisma/
COPY --chown=1001:1001 prisma.config.ts ./
# dist/ carries src/scripts/* too (tsconfig include src/**/*) — the ops CLIs
# that must run INSIDE the image ship here, e.g. the decision-gate readiness
# ruler: `node dist/scripts/decision-gate-fit-temperature.js --stamp`
# (2026-09-25: there is no scripts/ dir and no tsx in this stage on purpose).
COPY --from=build --chown=1001:1001 /app/dist ./dist
COPY --from=build --chown=1001:1001 /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build --chown=1001:1001 /app/openapi.json ./openapi.json

ARG BACKEND_CHOWN_RECURSIVE=0
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 && \
    mkdir -p /app/coding-workspaces && \
    if [ "$BACKEND_CHOWN_RECURSIVE" = "1" ]; then chown -R nodejs:nodejs /app; else chown nodejs:nodejs /app /app/coding-workspaces; fi

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# NOTE: no `USER nodejs` — the entrypoint starts as root to chown the mounted
# workspace volume, then exec's the server as nodejs via su-exec.
EXPOSE 4000

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "dist/server.js"]
