/**
 * Which COMMIT built this container (ticket b37bf85f, 2026-11-06).
 *
 * WHY THIS EXISTS. Asking "is this self-hosted Edge up to date?" had no
 * container-answerable form: the self-host images carried no OCI revision label
 * and set no DEPLOY_SHA, so a verification lane had to infer the running
 * revision from a host-side `git rev-parse`, dist mtimes and dist content
 * (lane 9f6300b5 on digby.cql.ca). Those are proxies, not evidence: a container
 * can run an image built from a different commit than the checkout sits on, and
 * mtime comparisons say nothing about which source produced the bytes.
 *
 * THE ONE RULE. `DEPLOY_SHA` is the fleet's existing passthrough (deploy.yml
 * writes `.deploy-sha`; docker-compose.app.yml passes it through). Rather than
 * introduce a second variable and a second validator, this module delegates to
 * `shortDeploySha` from ./process-tag — the SAME leaf the fleet's `deploySha()`
 * and the metric `proc` tag use. A build-directory default like `dev`, or a
 * padded/partial value, is therefore reported as "unknown" here exactly as it
 * is there, never as a sha. There is deliberately NO second regex in this file:
 * two acceptance rules is precisely how the health surface and the metric tags
 * would come to disagree about what a revision is.
 *
 * EXACT, NOT SHORT. This reports the FULL commit sha, because the question it
 * answers is "does the running container match the commit I just checked out?"
 * — the operator compares it with `git rev-parse HEAD` directly. The 8-char
 * form stays where truncation is for compactness (metric tags, log lines).
 *
 * HOW IT GETS INTO THE CONTAINER. Two independent paths, both pinned by
 * `backend/scripts/selfhost/selfhost-revision-provenance.test.ts`:
 *   • from-source self-host: docker-compose.selfhost.yml passes
 *     `DEPLOY_SHA=${DEPLOY_SHA:-}` as a BUILD ARG, backend/Dockerfile bakes it
 *     into the production stage with `ENV DEPLOY_SHA=…`, and
 *     scripts/selfhost/auto-update.sh exports the exact checked-out sha before
 *     `docker compose up -d --build`;
 *   • published images: .digby/publish/publish-images.yml builds with
 *     `DEPLOY_SHA=${{ github.sha }}` — the same commit the tag points at.
 *
 * Nothing here needs credentials, a network call or a repo checkout: it reads
 * the process environment, so it also answers inside the worker and relay
 * containers, which share the backend image.
 */

import { shortDeploySha } from './process-tag';

/**
 * The full commit sha this process was BUILT from, or null when the build
 * genuinely does not know one (an unstamped local `docker build`, or an image
 * older than this ticket). Null is an honest "unknown", never a guess.
 *
 * Acceptance is `shortDeploySha`'s decision, so this can never report a
 * revision the fleet's own rule would reject — or reject one it accepts.
 */
export function buildRevision(env: NodeJS.ProcessEnv = process.env): string | null {
  if (!shortDeploySha(env)) return null;
  return String(env.DEPLOY_SHA).trim().toLowerCase();
}
