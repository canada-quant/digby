# syntax=docker/dockerfile:1
# Build stage
FROM node:20-alpine AS build

WORKDIR /app

ARG NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
# Thinking stays hidden (2026-10-04, lib/reasoning-visibility.ts): '1' restores the reasoning rows at build time.
ARG NEXT_PUBLIC_HIDE_REASONING_DISABLED=
ENV NEXT_PUBLIC_HIDE_REASONING_DISABLED=$NEXT_PUBLIC_HIDE_REASONING_DISABLED
ARG NEXT_PUBLIC_MINIMAL_VIEW_DISABLED=
ENV NEXT_PUBLIC_MINIMAL_VIEW_DISABLED=$NEXT_PUBLIC_MINIMAL_VIEW_DISABLED
# Google Ads tag (2026-10-04, lib/google-ads.ts): '1' turns the site-wide tag + the Sign-up conversion off.
ARG NEXT_PUBLIC_GOOGLE_ADS_TAG_DISABLED=
ENV NEXT_PUBLIC_GOOGLE_ADS_TAG_DISABLED=$NEXT_PUBLIC_GOOGLE_ADS_TAG_DISABLED
# Google Analytics GA4 on the same tag (2026-10-06, ticket 4bb5fe23): '1' drops only the G-NK7XPHC7FE config.
ARG NEXT_PUBLIC_GOOGLE_ANALYTICS_DISABLED=
ENV NEXT_PUBLIC_GOOGLE_ANALYTICS_DISABLED=$NEXT_PUBLIC_GOOGLE_ANALYTICS_DISABLED
# First-party visitor analytics (2026-10-07, lib/visitor-analytics.ts): '1' turns the web capture off (no visitor id, no requests).
ARG NEXT_PUBLIC_VISITOR_ANALYTICS_DISABLED=
ENV NEXT_PUBLIC_VISITOR_ANALYTICS_DISABLED=$NEXT_PUBLIC_VISITOR_ANALYTICS_DISABLED
# Client UI error capture (ticket d4e643a5, lib/client-error-reporter.ts): '1' installs no window.onerror /
# unhandledrejection listeners and posts nothing.
ARG NEXT_PUBLIC_CLIENT_ERROR_REPORT_DISABLED=
ENV NEXT_PUBLIC_CLIENT_ERROR_REPORT_DISABLED=$NEXT_PUBLIC_CLIENT_ERROR_REPORT_DISABLED
# Meta Pixel kill switch (2026-10-07, frontend/lib/meta-pixel.ts): =1 → no pixel, no browser events.
ARG NEXT_PUBLIC_META_PIXEL_DISABLED=
ENV NEXT_PUBLIC_META_PIXEL_DISABLED=$NEXT_PUBLIC_META_PIXEL_DISABLED
# Wall-of-text repair on the live render (2026-10-06, ticket 6ee7a779): '1' turns it off.
ARG NEXT_PUBLIC_MARKDOWN_WALL_REPAIR_DISABLED=
ENV NEXT_PUBLIC_MARKDOWN_WALL_REPAIR_DISABLED=$NEXT_PUBLIC_MARKDOWN_WALL_REPAIR_DISABLED
# Stream drops (2026-10-20): '1' = a guest's dropped answer is "send again" (no reconnect through
# /session/:id/stream, app/crossmodel/guest-reconnect.ts); no window 'online' resync; no stream_drop /
# stream_resume beacons (lib/stream-drop-beacon.ts).
ARG NEXT_PUBLIC_GUEST_STREAM_RECONNECT_DISABLED=
ENV NEXT_PUBLIC_GUEST_STREAM_RECONNECT_DISABLED=$NEXT_PUBLIC_GUEST_STREAM_RECONNECT_DISABLED
ARG NEXT_PUBLIC_ONLINE_RESYNC_DISABLED=
ENV NEXT_PUBLIC_ONLINE_RESYNC_DISABLED=$NEXT_PUBLIC_ONLINE_RESYNC_DISABLED
ARG NEXT_PUBLIC_STREAM_DROP_BEACON_DISABLED=
ENV NEXT_PUBLIC_STREAM_DROP_BEACON_DISABLED=$NEXT_PUBLIC_STREAM_DROP_BEACON_DISABLED
# Ghost composer toggle (2026-10-22, lib/ghost-composer.ts): '1' hides the signed-in Ghost toggle beside the composer
# (no "start this chat in ghost mode" on home, no flip on an open chat); the side-panel switch and the guest toggle stay.
ARG NEXT_PUBLIC_GHOST_COMPOSER_TOGGLE_DISABLED=
ENV NEXT_PUBLIC_GHOST_COMPOSER_TOGGLE_DISABLED=$NEXT_PUBLIC_GHOST_COMPOSER_TOGGLE_DISABLED
# Instance kind for the pre-rendered public site (2026-10-20, lib/site/instance.ts):
# unset / 'prod' = production; 'selfhost' hides the digby.ai desktop installers.
ARG DIGBY_INSTANCE=
ENV DIGBY_INSTANCE=$DIGBY_INSTANCE

# Shared branding core (2026-11-05, todo d2d32b57 — lib/branding/index.ts):
# a self-hosted operator rebrands by setting DIGBY_BRAND_* + DIGBY_BRANDING_DIR
# in .env; docker-compose.selfhost.yml forwards them here. They are read at
# BUILD time by the static routes (metadata, PWA manifest, login/site chrome),
# so a change needs `docker compose up -d --build frontend`. Asset FILES in the
# operator directory are served live at /branding/asset/* and can be swapped
# without a rebuild. Unset = the shipped Digby identity, byte-for-byte.
ARG DIGBY_BRAND_NAME=
ENV DIGBY_BRAND_NAME=$DIGBY_BRAND_NAME
ARG DIGBY_BRAND_NAME_SHORT=
ENV DIGBY_BRAND_NAME_SHORT=$DIGBY_BRAND_NAME_SHORT
ARG DIGBY_BRAND_TAGLINE=
ENV DIGBY_BRAND_TAGLINE=$DIGBY_BRAND_TAGLINE
ARG DIGBY_BRAND_DESCRIPTION=
ENV DIGBY_BRAND_DESCRIPTION=$DIGBY_BRAND_DESCRIPTION
ARG DIGBY_BRAND_TITLE=
ENV DIGBY_BRAND_TITLE=$DIGBY_BRAND_TITLE
ARG DIGBY_BRAND_TITLE_SUFFIX=
ENV DIGBY_BRAND_TITLE_SUFFIX=$DIGBY_BRAND_TITLE_SUFFIX
ARG DIGBY_BRAND_LOGO_ALT=
ENV DIGBY_BRAND_LOGO_ALT=$DIGBY_BRAND_LOGO_ALT
ARG DIGBY_BRAND_LOGO=
ENV DIGBY_BRAND_LOGO=$DIGBY_BRAND_LOGO
ARG DIGBY_BRAND_LOGO_COMPACT=
ENV DIGBY_BRAND_LOGO_COMPACT=$DIGBY_BRAND_LOGO_COMPACT
ARG DIGBY_BRAND_LOGO_LIGHT=
ENV DIGBY_BRAND_LOGO_LIGHT=$DIGBY_BRAND_LOGO_LIGHT
ARG DIGBY_BRAND_LOGO_DARK=
ENV DIGBY_BRAND_LOGO_DARK=$DIGBY_BRAND_LOGO_DARK
ARG DIGBY_BRAND_SPINNER=
ENV DIGBY_BRAND_SPINNER=$DIGBY_BRAND_SPINNER
ARG DIGBY_BRAND_SPINNER_STATIC=
ENV DIGBY_BRAND_SPINNER_STATIC=$DIGBY_BRAND_SPINNER_STATIC
ARG DIGBY_BRAND_FAVICON_16=
ENV DIGBY_BRAND_FAVICON_16=$DIGBY_BRAND_FAVICON_16
ARG DIGBY_BRAND_FAVICON_32=
ENV DIGBY_BRAND_FAVICON_32=$DIGBY_BRAND_FAVICON_32
ARG DIGBY_BRAND_ICON_192=
ENV DIGBY_BRAND_ICON_192=$DIGBY_BRAND_ICON_192
ARG DIGBY_BRAND_ICON_512=
ENV DIGBY_BRAND_ICON_512=$DIGBY_BRAND_ICON_512
ARG DIGBY_BRAND_APPLE_TOUCH_ICON=
ENV DIGBY_BRAND_APPLE_TOUCH_ICON=$DIGBY_BRAND_APPLE_TOUCH_ICON
ARG DIGBY_BRAND_THEME_COLOR=
ENV DIGBY_BRAND_THEME_COLOR=$DIGBY_BRAND_THEME_COLOR
ARG DIGBY_BRAND_THEME_COLOR_DARK=
ENV DIGBY_BRAND_THEME_COLOR_DARK=$DIGBY_BRAND_THEME_COLOR_DARK
ARG DIGBY_BRAND_BACKGROUND_COLOR=
ENV DIGBY_BRAND_BACKGROUND_COLOR=$DIGBY_BRAND_BACKGROUND_COLOR
ARG DIGBY_BRAND_BACKGROUND_COLOR_DARK=
ENV DIGBY_BRAND_BACKGROUND_COLOR_DARK=$DIGBY_BRAND_BACKGROUND_COLOR_DARK
# The mounted operator asset directory (served live at /branding/asset/*).
ARG DIGBY_BRANDING_DIR=
ENV DIGBY_BRANDING_DIR=$DIGBY_BRANDING_DIR

COPY package*.json ./
# npm cache mount: package downloads persist across deploys on the box's
# builder (bounded by deploy-blue-green.sh's until=24h prune) — a lockfile
# change no longer means a full re-download.
RUN --mount=type=cache,id=npm-frontend,target=/root/.npm npm ci

# DEPLOY_SHA (2026-09-08 split-brain incident): busts the source layers on
# every deploy so BOTH web boxes rebuild from the same rsync'd source — a
# stale cached copy layer on one box served an OLD bundle whose chunk names
# the other box didn't have, and the ALB mixed them (unstyled pages, ~50% of
# asset requests 404). npm deps caching above is untouched (still fast).
ARG DEPLOY_SHA=dev
ENV NEXT_PUBLIC_DEPLOY_SHA=$DEPLOY_SHA
COPY . .
# NO Next incremental-cache mount here (removed 2026-09-08): a per-box
# persistent .next/cache made chunk output box-dependent — the OTHER half of
# the split-brain. Determinism across boxes beats incremental build speed.
RUN npm run build

# Production stage — uses Next.js standalone output (minimal footprint)
FROM node:20-alpine AS production

WORKDIR /app

ENV NODE_ENV=production
# Shared branding core (2026-11-05, todo d2d32b57) — RUNTIME half only.
# Every DIGBY_BRAND_* VALUE is baked at BUILD time in the build stage above
# (page metadata, PWA manifest, social cards). The one runtime knob is the
# operator asset DIRECTORY: /branding/asset/* streams files from it per
# request, so a logo or spinner can be swapped without rebuilding the image.
#
# ARG must be re-declared IN THIS STAGE: a build-stage ARG does not cross a
# `FROM` boundary, so without this line the ENV expands to empty in a plain
# `docker build` (docker-compose supplies it, which is why it looked fine).
ARG DIGBY_BRANDING_DIR=
ENV DIGBY_BRANDING_DIR=$DIGBY_BRANDING_DIR

COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
# /help reads the synced docs from disk at request time (content/help is
# generated-but-committed; standalone tracing can't see the runtime fs reads)
COPY --from=build /app/content ./content

RUN addgroup -g 1001 -S nodejs && \
    adduser -S nextjs -u 1001 && \
    chown -R nextjs:nodejs /app

USER nextjs

EXPOSE 3000

CMD ["node", "server.js"]
