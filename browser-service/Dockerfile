# syntax=docker/dockerfile:1
# digby-browser-service (ticket ea3ad8a8): the hosted hardened browser — ONE
# pinned Chromium, per-session Playwright CONTEXTS with persisted storage state.
#
# Base image = the OFFICIAL Playwright image (pinned, Debian) — it ships the
# exact Chromium build matching the playwright npm pin plus every OS
# dependency. Pinned on purpose (the yt-dlp rule): `latest` makes deploy
# builds nondeterministic and this wants a deliberate bump.
# 1.55.1 (2026-10-17): CVE-2025-59288 — Playwright browser downloads did not
# verify the SSL certificate's authenticity; fixed in ≥1.55.1.
#
# NOTE (review B2): the playwright base image ships NO tini — zombie reaping
# is handled by `init: true` on the compose service (Docker's built-in
# docker-init), NOT an ENTRYPOINT here.
FROM mcr.microsoft.com/playwright:v1.55.1-noble

WORKDIR /app

# Non-root app user: the playwright base image ALREADY ships pwuser at
# uid/gid 1001 — exactly the backend-image convention this service wanted.
# Do NOT create another fixed-1001 account: groupadd -g 1001 exits 4 (GID in
# use) and broke the first live deploy attempt of this image (2026-10-17,
# deploy run 39046707050, "base image rebuild failed" pre-switch). We run as
# the base image's own pwuser instead.

# Build with dev deps (typescript is one — review B1: --omit=dev left `tsc`
# absent and `npm run build` exited 127 in the image), then prune to prod.
# src/ MUST be copied in before the build: tsc compiles src/**→dist inside
# the image (2026-10-17 live-deploy probe caught TS18003 "no inputs found"
# when only package*.json/tsconfig were copied — the CI job builds from the
# checkout, so this class only surfaces on a real docker build).
COPY package*.json tsconfig.json ./
COPY src ./src
RUN npm install --no-audit --no-fund \
    && npm run build \
    && npm prune --omit=dev \
    && rm -rf src
# Belt-and-braces: the built service must not need anything beyond prod deps.
RUN node -e "require('./dist/core.js'); console.log('dist loads OK')"

# Persistent context storage (compose mounts a named volume here).
RUN mkdir -p /data/contexts && chown -R pwuser:pwuser /app /data

USER pwuser
EXPOSE 3100
ENV NODE_ENV=production

CMD ["node", "dist/server.js"]
