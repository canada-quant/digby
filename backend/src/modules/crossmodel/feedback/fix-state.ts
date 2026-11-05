/**
 * Fix-state resolver (ticket 208ad03d — "Re-opened tickets re-dispatched
 * without checking whether the fix already merged").
 *
 * THE MISHAP IT KILLS (2026-09-18, ticket 5ba5f03e): a new sighting matched a
 * recently-closed agent ticket and the reopen-on-recurrence path flipped it
 * back to open and re-dispatched it at 21:48Z — even though its fix had
 * ALREADY merged ~2h earlier (PR #859, mergeCommit a471ce03, mergedAt
 * 19:48:40Z) and its deploy wave had concluded success at 21:02Z. The
 * re-dispatch burned a full lane run re-fixing already-live work.
 *
 * WHAT THIS MODULE ANSWERS for the reopen path in feedback.service.ts: "is
 * the fix this CLOSED ticket recorded at machine-close time already live?"
 * fixLive=true requires BOTH halves, each POSITIVELY verified:
 *   (a) MERGED — the recorded fix commitSha (7-40 hex, parsed from the
 *       adminNote's `[machine-close evidence: …]` audit note that
 *       closure-evidence.ts writes via platform-tools update_feedback) is an
 *       ANCESTOR of origin/main: GitHub compare API `<sha>...main` reporting
 *       'identical' or 'ahead' ('behind'/'diverged' = not merged; 404 = the
 *       sha is not in the repo at all). Caveat, deliberate: a close that
 *       recorded a PR HEAD sha later squash-merged resolves NOT-merged and
 *       the reopen proceeds — the sanctioned evidence is the merge commit
 *       the PR-merge response returned (closure-evidence.ts's refusal text
 *       says exactly that), and a false reopen is the cheap direction.
 *   (b) DEPLOYED — the recorded deployRunId's Actions run concluded success,
 *       or `box_health` loop_metrics telemetry (the same source the fleet
 *       deploy view reads — infra-watch.service.ts latestBoxHealthRows) shows
 *       a box/process running the fix sha itself, or running main head (a
 *       DESCENDANT wave: ancestry was already proven in (a), so a box on
 *       head carries the fix), or — ticket 36b8c979 — a recorded
 *       `live-probe` livenessProbe (the live surface + expected strings the
 *       close cited) that THIS resolver re-fetches server-side and asserts
 *       (the proof path for a repo that deploys WITHOUT Actions and is not a
 *       Digby box; kill switch FIX_STATE_LIVENESS_PROBE_DISABLED=1).
 *
 * FAIL-SAFE BY CONSTRUCTION: any missing/unparseable evidence, no connected
 * token, any check error/timeout, or any negative answer ⇒ fixLive=false —
 * the caller falls through to the legacy reopen. This module NEVER
 * suppresses a reopen on incomplete data, and it never throws.
 *
 * Token (ticket b165cfdb — mirrors the abc76ebc / PR #1527 fix in
 * closure-evidence.ts): the ticket OWNER's connected GitHub token first,
 * then — when that owner has none — the LANE-HOME owner's
 * (feedback/lane-home.ts: TICKET_LANE_PROJECT_ID's owner, else the standing
 * lane chat's project owner). The nightly query suite files its tickets from
 * a tokenless bench account, so the owner-token-only shape left this whole
 * merged ∧ deployed lane dead for the nightly-suite class. Kill switch
 * FEEDBACK_FIX_STATE_FALLBACK_TOKEN_DISABLED=1 restores owner-token-only.
 * The token-manager import stays DYNAMIC (closure-evidence.ts's origin/main
 * lane discipline — a bare test/env context never pays the import-chain
 * cost). Every fetch is 8s-bounded (the closure-evidence origin/main
 * budget). Repo slug: $GITHUB_REPO_SLUG resolved per instance — production
 * defaults to example-org/crossmodel, a NON-prod instance has NO default
 * (unset ⇒ no GitHub fetch, configured to prod ⇒ hard fail — the
 * instance-targets.ts boundary).
 *
 * Repo scope (ticket cf5f9718 — the done-bar was PLATFORM-repo-scoped): the
 * evidence may name the repo the fix lives in — evidence.repo ("owner/name",
 * validated + audited into the `[machine-close evidence: …]` note by
 * closure-evidence.ts, parsed here) — and every GitHub read in this module
 * (the merge compare, the Actions run, the head + box-ancestry descendant
 * check) then targets THAT repo. The default (no repo member) stays the
 * instance's own slug, so a platform fix's proof is byte-identical to the
 * pre-cf5f9718 behavior; a cross-repo fix (the 2026-10-27 deckpose close on
 * ticket 4e818bb9 — merged + live in example-org/optcg, refused forever by the
 * hardcoded compare) machine-closes under the SAME merged ∧ deployed bar.
 * The box_health telemetry half still reads THIS fleet's boxes either way —
 * a foreign repo's deploy proves itself through its own recorded Actions run
 * (b-i), never through this instance's telemetry (b-ii). A NON-prod instance
 * may not name the PRODUCTION repo (the c75b5f34 boundary applies to the
 * scope too — refused verbatim). Kill switch
 * FIX_STATE_EVIDENCE_REPO_DISABLED=1 ignores a supplied repo entirely
 * (restores the pre-cf5f9718 all-platform behavior).
 */

import prisma from '../../../config/database';
import logger from '../../../utils/logger';
// Instance isolation boundary (ticket c75b5f34) — import-free leaf, so this
// module's static graph stays prisma + logger (+ nothing else). The cf5f9718
// repo-scope check rides the same leaf's pure predicates (isProdInstance /
// isProdRepoTarget / instanceKind).
import {
  resolveInstanceRepoTarget,
  IsolationBoundaryError,
  isProdInstance,
  isProdRepoTarget,
  instanceKind,
} from '../platform/instance-targets';
// Ticket 36b8c979 — the liveness-probe leaf (import-free of the app; Node
// URL/dns only): the deployed leg's THIRD path re-fetches the recorded probe
// server-side.
import { parseLivenessProbeFromNote, probeLiveness, type LivenessProbeEvidence, type DnsLookupAll } from './liveness-probe';

export interface TicketFixStateEvidence {
  commitSha?: string;
  deployRunId?: string;
}

export interface TicketFixState {
  fixLive: boolean;
  reason: string;
  evidence?: TicketFixStateEvidence;
}

/** The row fields the resolver reads (the reopen scan returns full rows). */
export interface TicketFixRow {
  id: string;
  adminNote?: string | null;
  userId?: string | null;
}

/** The recorded closure evidence parsed from the adminNote. */
export interface ClosureEvidenceNote {
  commitSha?: string;
  prUrl?: string;
  deployRunId?: string;
  /**
   * The repo the fix lives in ("owner/name") — ticket cf5f9718. Absent = the
   * instance's own repo (the pre-cf5f9718 behavior, unchanged).
   */
  repo?: string;
  /**
   * A server-side liveness probe (ticket 36b8c979): the deployed leg
   * re-fetches this url itself and asserts the expected strings — the proof
   * path for a fix whose repo deploys WITHOUT GitHub Actions and has no
   * Digby box telemetry. Recorded by closure-evidence.ts, never trusted from
   * a lane-pasted curl output.
   */
  livenessProbe?: LivenessProbeEvidence;
}

const SHA_RE = /^[0-9a-f]{7,40}$/; // closure-evidence.ts's SHA_RE — the close gate lowercases the sha before recording it
const FETCH_TIMEOUT_MS = 8_000; // the closure-evidence origin/main budget
// The literal kind string (loop-metrics.service.ts LOOP_METRIC_KINDS.BOX_HEALTH)
// — infra-watch.service.ts latestBoxHealthRows is the read this mirrors; kept
// literal so this module's static graph stays at prisma + logger.
const BOX_HEALTH_KIND = 'box_health';
const BOX_HEALTH_WINDOW_MS = 24 * 3600_000; // latestBoxHealthRows' 24h window
/** Distinct box shas the ancestry check compares (one GitHub compare call each). */
const FIX_STATE_BOX_ANCESTRY_MAX = 4;
/**
 * The GitHub repo the evidence's fix-state reads target (ticket cf5f9718):
 * a repo NAMED in the evidence envelope wins — validated as an owner/name
 * slug and, on a NON-prod instance, never the production repo (the c75b5f34
 * isolation boundary applies to the scope too: a self-hosted/edge instance
 * cannot point ticket-closure proof at production). Absent/invalid/kill-
 * switched repo ⇒ undefined = the instance's own slug (the pre-cf5f9718
 * behavior, byte-identical). Returns a refusal string instead of a slug when
 * the named repo is boundary-forbidden — the caller fails closed with it
 * VERBATIM (never a production read).
 */
export function resolveEvidenceRepoScope(
  note: Pick<ClosureEvidenceNote, 'repo' | 'prUrl'>,
  env: NodeJS.ProcessEnv = process.env,
): { slug?: string; refusal?: string } {
  const named = String(note?.repo ?? '').trim().toLowerCase();
  if (!named || env.FIX_STATE_EVIDENCE_REPO_DISABLED === '1') return {};
  if (!/^[\w.-]+\/[\w.-]+$/.test(named)) return {}; // invalid → unscoped (the verifier refuses malformed input before it ever reaches here)
  if (!isProdInstance(env) && isProdRepoTarget(named)) {
    return {
      refusal: `ISOLATION BOUNDARY (DIGBY_INSTANCE=${instanceKind(env)}): evidence repo "${named}" is the PRODUCTION Digby repo — a non-prod instance must never resolve ticket-closure proof against production. Scope this closure to this instance's own repo (omit evidence.repo, or set it to your fork).`,
    };
  }
  // Ticket cf5f9718 review: the repo is lane-supplied, so the NAMEABLE set is
  // pinned by box env the lane cannot write — FIX_STATE_EVIDENCE_REPO_ALLOWLIST
  // (comma-separated owner/name slugs; UNSET = the instance's own repo only,
  // i.e. naming the platform repo is the pre-cf5f9718 behavior and naming
  // anything else is REFUSED until the owner allows it). A repo whose merge
  // and Actions history a lane controls must never become its own trust
  // anchor: a scratch repo + a 3-line workflow would otherwise launder a
  // merged ∧ deployed proof. Fail closed with ZERO GitHub reads.
  let allowlist = String(env.FIX_STATE_EVIDENCE_REPO_ALLOWLIST ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (!allowlist.length) {
    const own = resolveInstanceRepoTarget(env);
    allowlist = own.ok ? [own.slug.toLowerCase()] : [];
  }
  if (!allowlist.includes(named)) {
    return {
      refusal: `REPO NOT ALLOWED: evidence repo "${named}" is not in FIX_STATE_EVIDENCE_REPO_ALLOWLIST (default: the platform repo only). A machine close may only scope its proof to a repo the instance operator has allow-listed in box env — set FIX_STATE_EVIDENCE_REPO_ALLOWLIST="owner/a,owner/b" (owner action) to permit this repo.`,
    };
  }
  // Evidence-substitution guard (ticket cf5f9718 review): a prUrl that names a
  // DIFFERENT repo than the scope would let one call prove a foreign PR as
  // this close's own — refuse before any read.
  const pr = String(note?.prUrl ?? '').trim();
  if (pr) {
    const m = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/\d+$/.exec(pr);
    if (m && `${m[1]}/${m[2]}`.toLowerCase() !== named) {
      return {
        refusal: `EVIDENCE MISMATCH: prUrl "${pr}" names ${m[1]}/${m[2]} but evidence.repo scopes the proof to "${named}" — the same close cannot cite a PR from a different repo. Point prUrl at the named repo's PR (or drop it).`,
      };
    }
  }
  return { slug: named };
}

const FIX_STATE_GITHUB_SLUG = () => {
  // Isolation boundary (c75b5f34): non-prod instance with no configured repo
  // ⇒ '' (the fix-state fetches 404 → "not live" — never a production read);
  // configured to the production repo ⇒ IsolationBoundaryError (hard fail —
  // the resolver's belt catches and renders it as the not-live reason).
  const r = resolveInstanceRepoTarget(process.env);
  if (r.ok) return r.slug;
  if (!String(process.env.GITHUB_REPO_SLUG ?? '').trim()) return '';
  throw new IsolationBoundaryError(r.refusal);
};

const GH_HEADERS = (token: string) => ({
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'User-Agent': 'digby-fix-state',
});

/**
 * Parse the adminNote's LAST `[machine-close evidence: …]` block into its
 * structured members — a reopened-then-reclosed ticket accrues one block per
 * close (platform-tools.ts appends, never replaces), and only the most recent
 * describes the CURRENT closure. Returns null when no block exists; members
 * absent from the block stay undefined. Pure — the unit-test seam for the
 * note shape closure-evidence.ts's noteParts produce
 * (`commit <sha> (…)`, `PR <url>`, `deploy run <id>`).
 */
export function parseClosureEvidenceNote(adminNote: string | null | undefined): ClosureEvidenceNote | null {
  const note = String(adminNote ?? '');
  const blocks = [...note.matchAll(/\[machine-close evidence: ([^\]]+)\]/g)];
  if (!blocks.length) return null;
  const last = blocks[blocks.length - 1][1];
  const out: ClosureEvidenceNote = {};
  const sha = /\bcommit ([0-9a-fA-F]{7,40})\b/.exec(last)?.[1]?.toLowerCase();
  if (sha && SHA_RE.test(sha)) out.commitSha = sha;
  const pr = /\bPR (https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+)\b/.exec(last)?.[1];
  if (pr) out.prUrl = pr;
  const run = /\bdeploy run (\d{4,20})\b/.exec(last)?.[1];
  if (run) out.deployRunId = run;
  // Ticket cf5f9718: the repo scope the close recorded (`repo <owner/name>`
  // — written by closure-evidence.ts only when the evidence named one).
  const repo = /\brepo ([\w.-]+\/[\w.-]+)\b/.exec(last)?.[1]?.toLowerCase();
  if (repo) out.repo = repo;
  // Ticket 36b8c979: the liveness probe (`live-probe <url> (expects "a|b")`).
  const probe = parseLivenessProbeFromNote(last);
  if (probe) out.livenessProbe = probe;
  return out;
}

/** One bounded GitHub GET. Never throws: the abort/network failure surfaces as thrown → the caller's try/catch degrades it. */
async function ghGet(doFetch: typeof fetch, url: string, token: string): Promise<{ status: number; ok: boolean; body: any }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await doFetch(url, { headers: GH_HEADERS(token), signal: ctrl.signal });
    const body: any = await res.json().catch(() => null);
    return { status: res.status, ok: res.ok, body };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * (a) MERGED: is `sha` an ancestor of origin/main? compare API base=sha
 * head=main — 'identical'|'ahead' ⇒ merged ('identical' = the sha IS main's
 * head; 'ahead' = main is ahead of the sha = the sha is an ancestor of main).
 * 'behind' = the sha has commits main lacks (an UNMERGED DESCENDANT of main);
 * 'diverged' = a branch/squash edge — both NOT merged.
 */
async function isFixMergedOnMain(doFetch: typeof fetch, token: string, sha: string, slug: string): Promise<{ merged: boolean; detail: string }> {
  const r = await ghGet(doFetch, `https://api.github.com/repos/${slug}/compare/${sha}...main`, token);
  if (r.status === 404) return { merged: false, detail: `commit ${sha} is not in the repo (GitHub compare 404 — never pushed, or no common base)` };
  if (!r.ok) return { merged: false, detail: `merge check unavailable (GitHub compare HTTP ${r.status})` };
  const status = String(r.body?.status ?? '');
  if (status === 'identical' || status === 'ahead') {
    return { merged: true, detail: `commit ${sha} is an ancestor of origin/main (compare status ${status} — sha is an ancestor of origin/main)` };
  }
  return { merged: false, detail: `commit ${sha} is NOT merged to origin/main (compare status ${status || 'unknown'} — 'behind' = an unmerged descendant of main, 'diverged' = a branch/squash edge)` };
}

/** (b-i): the recorded deploy run concluded success? (run-evidence-guard.ts's actions/runs lane shape.) */
async function isDeployRunGreen(doFetch: typeof fetch, token: string, deployRunId: string, slug: string): Promise<{ green: boolean; detail: string }> {
  const r = await ghGet(doFetch, `https://api.github.com/repos/${slug}/actions/runs/${deployRunId}`, token);
  if (r.status === 404) return { green: false, detail: `deploy run ${deployRunId} not found (GitHub 404)` };
  if (!r.ok) return { green: false, detail: `deploy run check unavailable (GitHub HTTP ${r.status})` };
  const status = String(r.body?.status ?? '');
  const conclusion = r.body?.conclusion == null ? null : String(r.body.conclusion);
  if (status === 'completed' && conclusion === 'success') {
    return { green: true, detail: `deploy run ${deployRunId} concluded success` };
  }
  return { green: false, detail: `deploy run ${deployRunId} is ${status}/${conclusion ?? 'unconcluded'} — not a concluded success` };
}

/**
 * (b-ii) TELEMETRY: the fleet's own deploy picture — the latest `box_health`
 * loop_metrics row per host/process (the latestBoxHealthRows read, mirrored
 * on the same kind/window/sha-prefix derivation). Live = a box runs the fix
 * sha itself, or runs origin/main head (a descendant wave — (a) already
 * proved the fix is an ancestor of head).
 */
async function isFixLivePerTelemetry(doFetch: typeof fetch, token: string, sha: string, slug: string): Promise<{ live: boolean; detail: string }> {
  let rows: Array<{ createdAt: Date; meta: any }> = [];
  try {
    rows = (await prisma.loopMetric.findMany({
      where: { kind: BOX_HEALTH_KIND, createdAt: { gte: new Date(Date.now() - BOX_HEALTH_WINDOW_MS) } },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true, meta: true },
      take: 400, // latestBoxHealthRows' bound
    })) as Array<{ createdAt: Date; meta: any }>;
  } catch (err: any) {
    return { live: false, detail: `box_health telemetry read failed (${String(err?.message ?? err).slice(0, 120)})` };
  }
  // Newest row per host/process wins (rows arrive desc) — the fleet deploy
  // view's perProcess shape.
  const seen = new Set<string>();
  const liveShas: string[] = [];
  for (const r of rows) {
    const host = String(r.meta?.host ?? '');
    const key = `${host}/${String(r.meta?.process ?? '')}`;
    if (!host || seen.has(key)) continue;
    seen.add(key);
    if (typeof r.meta?.sha === 'string' && r.meta.sha) liveShas.push(String(r.meta.sha).slice(0, 8));
  }
  if (!liveShas.length) return { live: false, detail: 'no box_health telemetry with a deploy sha in the last 24h' };
  const short = sha.slice(0, 8);
  if (liveShas.includes(short)) {
    return { live: true, detail: `box_health telemetry shows a box running the fix sha ${short}` };
  }
  // Descendant wave: a box on origin/main head runs the fix (ancestry proven).
  try {
    const head = await ghGet(doFetch, `https://api.github.com/repos/${slug}/commits/main`, token);
    const headShort = head.ok && typeof head.body?.sha === 'string' ? String(head.body.sha).slice(0, 8) : '';
    if (headShort && liveShas.includes(headShort)) {
      return { live: true, detail: `box_health telemetry shows a box on origin/main head ${headShort} — a descendant wave carrying ${short}` };
    }
    // Box ancestry (2026-10-06 ticket catch-up): on a busy main the head moves past every deployed wave, so
    // "a box on main head" almost never holds and a deployed fix stayed unproven for good. A box whose running
    // sha DESCENDS from the fix runs it: compare `<fix>...<boxSha>` reporting ahead / identical proves it.
    // Bounded to FIX_STATE_BOX_ANCESTRY_MAX distinct shas. FIX_STATE_BOX_ANCESTRY_DISABLED=1 restores the
    // exact-sha / main-head rule.
    if (process.env.FIX_STATE_BOX_ANCESTRY_DISABLED !== '1') {
      for (const boxSha of [...new Set(liveShas)].slice(0, FIX_STATE_BOX_ANCESTRY_MAX)) {
        const cmp = await ghGet(doFetch, `https://api.github.com/repos/${slug}/compare/${sha}...${boxSha}`, token);
        const st = cmp.ok ? String(cmp.body?.status ?? '') : '';
        if (st === 'ahead' || st === 'identical') {
          return { live: true, detail: `box_health telemetry shows a box on ${boxSha}, which carries the fix ${short} (compare status ${st})` };
        }
      }
    }
    return { live: false, detail: `no box runs the fix sha ${short}, main head (${headShort || 'unavailable'}) or a descendant of the fix; boxes report ${liveShas.join(', ')}` };
  } catch (err: any) {
    return { live: false, detail: `main-head read for the descendant check failed (${String(err?.message ?? err).slice(0, 120)})` };
  }
}

/**
 * Resolve whether the fix a CLOSED ticket recorded at machine-close time is
 * already live. Returns fixLive=true ONLY on the positive double proof
 * (merged ∧ deployed) in the module header; every other outcome — missing
 * evidence, no token, any error — is fixLive=false with the reason. NEVER
 * throws (the caller also guards, per the 208ad03d fail-safe contract).
 */
export async function resolveTicketFixState(
  row: TicketFixRow,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<TicketFixState> {
  try {
    const note = parseClosureEvidenceNote(row.adminNote);
    if (!note) {
      return { fixLive: false, reason: 'no recorded fix evidence (the adminNote carries no [machine-close evidence] block)' };
    }
    return await resolveFixStateFromEvidence({ id: row.id, userId: row.userId }, note, opts);
  } catch (err: any) {
    // The module-level belt: NOTHING here may throw into the reopen path.
    logger.warn(`fix-state: resolveTicketFixState failed for ticket ${row.id} (fail-safe → not live): ${err?.message ?? err}`);
    return { fixLive: false, reason: `resolver failure (fail-safe): ${String(err?.message ?? err).slice(0, 120)}` };
  }
}

/**
 * The same merged ∧ deployed proof for evidence the CALLER already holds —
 * the closure manifest's evidence-gated entries (backlog audit DOI-27,
 * 2026-09-28) pass `{commitSha, prUrl?, deployRunId?}` straight from the
 * manifest instead of parsing an adminNote. Same fail-safe contract:
 * fixLive=true only on positive proof; never throws.
 */
export async function resolveFixStateFromEvidence(
  row: { id: string; userId?: string | null },
  note: ClosureEvidenceNote,
  opts: { fetchImpl?: typeof fetch; probeFetchImpl?: typeof fetch; doLookup?: DnsLookupAll } = {},
): Promise<TicketFixState> {
  try {
    if (!note.commitSha) {
      return { fixLive: false, reason: 'no recorded fix commitSha in the machine-close evidence (a replay-test-only close proves nothing about the merge/deploy state)' };
    }
    const evidence: TicketFixStateEvidence = { commitSha: note.commitSha, ...(note.deployRunId ? { deployRunId: note.deployRunId } : {}) };

    // Token resolution (ticket b165cfdb — the abc76ebc / PR #1527 pattern):
    // the ticket OWNER's token first, then — when the owner has none — the
    // LANE-HOME owner's (the nightly query suite files its tickets from a
    // synthetic bench account with no connected GitHub token, which left this
    // merged ∧ deployed lane dead for the entire nightly-suite class: the
    // closure-manifest's evidence-gated entries stayed "pending — fix not
    // proven live" and the reopen path degraded to the legacy reopen). The
    // repo is private, so an unauthenticated fetch is NOT an option; the
    // lane-home owner is the platform operator whose account the dispatcher
    // already acts for. Kill switch:
    // FEEDBACK_FIX_STATE_FALLBACK_TOKEN_DISABLED=1 restores owner-token-only.
    // Never throws: every failure degrades to fixLive=false (the fail-safe
    // contract in the module header).
    const fallbackTokenDisabled = process.env.FEEDBACK_FIX_STATE_FALLBACK_TOKEN_DISABLED === '1';
    let token: string | null = null;
    let tokenSource = 'ticket owner';
    try {
      const { getValidToken } = await import('../github/token-manager');
      if (row.userId) token = await getValidToken(row.userId);
      if (!token && !fallbackTokenDisabled) {
        // Lane-home owner (feedback/lane-home.ts — a LEAF so this dynamic
        // import never pulls the dispatcher's config/redis import weight).
        const { resolveTicketLaneHome } = await import('./lane-home');
        const home = await resolveTicketLaneHome().catch(() => null);
        if (home?.userId) {
          const t = await getValidToken(home.userId).catch(() => null);
          if (t) {
            token = t;
            tokenSource = `lane-home owner (ticket owner ${row.userId ? String(row.userId).slice(0, 8) : 'absent'} has no token)`;
            logger.warn(`fix-state: merged ∧ deployed lane riding the ${tokenSource}`);
          }
        }
      }
    } catch (err: any) {
      logger.warn(`fix-state: token lookup failed for ticket ${row.id} (fail-safe → not live): ${err?.message ?? err}`);
      token = null;
    }
    if (!token) {
      return {
        fixLive: false,
        reason: fallbackTokenDisabled
          ? `no connected GitHub token for the ticket owner — merge/deploy state unverifiable (lane-home fallback disabled)`
          : `no connected GitHub token for the ticket owner or the lane-home owner — merge/deploy state unverifiable`,
        evidence,
      };
    }

    const doFetch = opts.fetchImpl ?? fetch;

    // Isolation boundary (c75b5f34, review F4): resolve the GitHub repo
    // target ONCE here, OUTSIDE every try/belt — a non-prod instance
    // configured to read the PRODUCTION repo returns the boundary refusal
    // VERBATIM as its own reason, never truncated to 120 chars inside a
    // generic "fail-safe" merge-check error. (Unset on non-prod keeps the
    // designed degrade: '' slug → the fetches 404 → not live, never a prod
    // read.)
    {
      const isoTarget = resolveInstanceRepoTarget(process.env);
      if (!isoTarget.ok && String(process.env.GITHUB_REPO_SLUG ?? '').trim()) {
        return { fixLive: false, reason: isoTarget.refusal, evidence };
      }
    }

    // Repo scope (ticket cf5f9718): the evidence's named repo wins (the
    // close gate validated it; the non-prod→production boundary refuses
    // VERBATIM, same discipline as the instance target above). Absent =
    // the instance's own slug — byte-identical to the pre-cf5f9718 proof.
    const scope = resolveEvidenceRepoScope(note);
    if (scope.refusal) return { fixLive: false, reason: scope.refusal, evidence };
    const ghSlug = scope.slug ?? FIX_STATE_GITHUB_SLUG();

    // (a) MERGED — hard requirement, checked first (a not-merged fix makes
    // the deploy question moot).
    let merged: { merged: boolean; detail: string };
    try {
      merged = await isFixMergedOnMain(doFetch, token, note.commitSha, ghSlug);
    } catch (err: any) {
      if (err?.name === 'IsolationBoundaryError') return { fixLive: false, reason: String(err.message), evidence };
      return { fixLive: false, reason: `merge check errored (fail-safe): ${String(err?.message ?? err).slice(0, 120)}`, evidence };
    }
    if (!merged.merged) return { fixLive: false, reason: merged.detail, evidence };

    // (b) DEPLOYED — the recorded run id first; without one (or when it did
    // not conclude success), the fleet's box_health telemetry is the fallback.
    let deployDetail = '';
    if (note.deployRunId) {
      try {
        const run = await isDeployRunGreen(doFetch, token, note.deployRunId, ghSlug);
        if (run.green) {
          return { fixLive: true, reason: `${merged.detail}; ${run.detail}`, evidence };
        }
        deployDetail = `${run.detail}; `;
      } catch (err: any) {
        deployDetail = `deploy run check errored (${String(err?.message ?? err).slice(0, 120)}); `;
      }
    }
    let telemetry: { live: boolean; detail: string };
    try {
      telemetry = await isFixLivePerTelemetry(doFetch, token, note.commitSha, ghSlug);
    } catch (err: any) {
      return { fixLive: false, reason: `${merged.detail}; ${deployDetail}telemetry check errored (fail-safe): ${String(err?.message ?? err).slice(0, 120)}`, evidence };
    }
    if (!telemetry.live) {
      // (b-iii) LIVENESS PROBE (ticket 36b8c979) — the last deployed path, for
      // a fix whose repo deploys WITHOUT GitHub Actions and is not a Digby box
      // (no deployRunId exists, no box_health row will ever carry its sha —
      // e.g. example-org/optcg → deckpose.com). The gate RE-FETCHES the
      // recorded probe server-side HERE, at resolve time, and asserts every
      // expected string — a lane-pasted curl output is never trusted, and a
      // surface that has since dropped the strings fails the close. Kill
      // switch FIX_STATE_LIVENESS_PROBE_DISABLED=1 ignores a recorded probe
      // (the pre-36b8c979 behavior). Fail-closed: a probe refusal/error or a
      // missing string is NOT live — the close stays refused with the detail.
      if (note.livenessProbe && process.env.FIX_STATE_LIVENESS_PROBE_DISABLED !== '1') {
        try {
          // The probe fetches the LIVE SURFACE, not the GitHub API: the raw
          // fetch (probeFetchImpl for tests), never the GitHub-wrapped
          // doFetch (its stubs return json-shaped GitHub responses).
          const probeFetch = opts.probeFetchImpl ?? fetch;
          const probe = await probeLiveness(note.livenessProbe, { doFetch: probeFetch, ...(opts.doLookup ? { doLookup: opts.doLookup } : {}) });
          if (probe.live) {
            return { fixLive: true, reason: `${merged.detail}; ${deployDetail}${telemetry.detail}; ${probe.detail}`, evidence };
          }
          return { fixLive: false, reason: `${merged.detail}; ${deployDetail}${telemetry.detail}; ${probe.detail}`, evidence };
        } catch (err: any) {
          return { fixLive: false, reason: `${merged.detail}; ${deployDetail}${telemetry.detail}; liveness probe errored (fail-safe): ${String(err?.message ?? err).slice(0, 120)}`, evidence };
        }
      }
      return { fixLive: false, reason: `${merged.detail}; ${deployDetail}${telemetry.detail}`, evidence };
    }
    return { fixLive: true, reason: `${merged.detail}; ${deployDetail}${telemetry.detail}`, evidence };
  } catch (err: any) {
    // The module-level belt: NOTHING here may throw into a caller.
    logger.warn(`fix-state: resolveFixStateFromEvidence failed for ticket ${row.id} (fail-safe → not live): ${err?.message ?? err}`);
    return { fixLive: false, reason: `resolver failure (fail-safe): ${String(err?.message ?? err).slice(0, 120)}` };
  }
}
