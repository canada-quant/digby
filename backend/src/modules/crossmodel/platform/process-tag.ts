/**
 * Which PROCESS wrote this metric row (todo c0c0c52a, 2026-11-01).
 *
 * WHY THIS EXISTS. `loop_metrics` columns are exactly id, kind, sessionId,
 * runId, value, unit, meta, createdAt — and sessionId/runId are null on every
 * `rag_rerank_call` row. So a metric row carried NO host, container or colour
 * identity, and "which process wrote this row" was unanswerable by query.
 *
 * That cost a real investigation: two 9,002 ms one-rung rerank rows
 * (loop_metrics de56970c / 15de190c) could not be attributed to a box, so a
 * lane that had correctly merged, deployed and certified p95 = 1,616 ms still
 * could not say WHICH build wrote 71% of its remaining dead wait (todo
 * 1520c1ef). Two readings fit the data and only a process tag separates them.
 *
 * THE TAG. One compact string, `host[/colour]@sha`, e.g. `box-a/green@3efeac28`.
 * One key beats three because the fleet telemetry view truncates meta at
 * TELEMETRY_META_CHARS = 240 (`truncMeta`, fleet-telemetry.ts:213) — a key
 * appended LAST in a long meta object is invisible on the surface the
 * supervisor actually reads. Callers must therefore place `proc` FIRST.
 *
 * `@NOSHA` is reported explicitly rather than omitted: a process with no
 * DEPLOY_SHA passthrough is exactly the blind spot that made `admin-relay-green`
 * invisible to the 4/4 ancestry gate (it carries the RAG stack and reported
 * DEPLOY_SHA=NONE). An absent tag would hide that; a named `@NOSHA` shows it.
 *
 * DELIBERATELY A LEAF: no imports beyond `os`. `rag.service.ts` is imported all
 * over the backend (and its tests mock `./fleet/infra-watch.service`), so this
 * must not pull that module's graph in. The sha rule mirrors `deploySha()`
 * (fleet/infra-watch.service.ts:286); `process-tag.parity.test.ts` pins that the
 * two never drift apart.
 */

import * as os from 'os';

/** Short commit sha from DEPLOY_SHA — the ONE definition; fleet's deploySha() delegates here. */
const DEPLOY_SHA_RE = /^[0-9a-f]{7,40}$/i;

/**
 * Short (8-hex) DEPLOY_SHA, or undefined when the process reports none.
 * Canonical: fleet/infra-watch.service.ts `deploySha()` delegates to this, so
 * the metric tag and the fleet's build-attribution can never disagree about
 * what counts as a sha (a compose `DEPLOY_SHA=dev` default is NOT one).
 */
export function shortDeploySha(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const v = String(env.DEPLOY_SHA || '').trim();
  return DEPLOY_SHA_RE.test(v) ? v.slice(0, 8) : undefined;
}

/**
 * `host[/colour]@sha` — the process identity a metric row needs.
 *
 * host: BOX_NAME when the box sets it (box-a / box-b / box-c), else the
 *       container hostname prefix — infra-watch's rule.
 * sha:  short DEPLOY_SHA, or the literal `NOSHA` when the process reports none.
 */
export function processTag(env: NodeJS.ProcessEnv = process.env, hostname: string = os.hostname()): string {
  const host = String(env.BOX_NAME || '').trim() || String(hostname || '').slice(0, 12) || 'unknown';
  const colour = String(env.BG_COLOR || '').trim();
  const sha = shortDeploySha(env) ?? 'NOSHA';
  return `${host}${colour ? `/${colour}` : ''}@${sha}`;
}

/**
 * The meta fragment to spread FIRST into a metric's meta:
 * `{ proc: 'box-a/green@3efeac28' }`.
 */
export function processTagMeta(env: NodeJS.ProcessEnv = process.env, hostname?: string): { proc: string } {
  return { proc: processTag(env, hostname) };
}