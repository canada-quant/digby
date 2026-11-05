/**
 * Verified-close evidence gate (audit roadmap #7, 2026-09-02).
 *
 * WHY: `update_feedback` let a MACHINE-TRIGGERED run (a dispatched lane brief,
 * a batch session, a schedule firing — any run with no real user message
 * behind it) set status=done on prose alone. Every fabrication cluster in the
 * ticket history (the a8976e11 phantom lifecycle, the ba65163d churn loop, the
 * fictional #577/#594 merge/deploy claims) ended exactly there: a machine run
 * narrating a fix and closing the ticket with nothing checkable behind it.
 * This module is the deterministic bar between a machine run and `done`.
 *
 * WHAT COUNTS (the tool contract — mirrored in update_feedback's schema):
 *   evidence: { commitSha?, prUrl?, deployRunId?, replayTestPath? }
 *   - replayTestPath — DETERMINISTICALLY verified: the file must exist under a
 *     configured repo root (see REPLAY ROOTS below) OR on the platform repo's
 *     origin/main (see ORIGIN/MAIN FALLBACK below), be a test file, and its
 *     content must cite the ticket id prefix (first 8 chars). This is the only
 *     member the backend can prove end-to-end, so it is the gold standard.
 *   - commitSha — FORMAT-verified (7..40 hex) and recorded in the adminNote.
 *     Why not existence-verified: the prod backend has no git checkout
 *     (/opt/crossmodel is rsync-deployed and NOT mounted into the container),
 *     and the GitHub-API lane run-evidence-guard.ts uses (verifyPushClaims)
 *     needs a repo slug + the session user's OAuth token — a feedback ticket
 *     carries neither. Per the audit: no cheap deterministic server-side
 *     check → verify format, record provenance in the adminNote, and REQUIRE
 *     replayTestPath for mishap-class tickets (which rule lives here too).
 *   - prUrl / deployRunId — format-checked SUPPORTING evidence, recorded in
 *     the adminNote; never satisfy the bar alone (a plausible URL or run id
 *     costs a fabricating model nothing).
 *   - repo (ticket cf5f9718) — SUPPORTING evidence naming the repo the fix
 *     lives in ("owner/name"): audited into the adminNote as
 *     `repo <owner/name>` so the done-bar's merged ∧ deployed check
 *     (fix-state.ts) targets THAT repo instead of assuming the platform one.
 *     Supports (never satisfies) the bar; an invalid slug refuses
 *     (invalid_repo) rather than silently downgrading to the platform repo.
 *   Satisfaction: at least one of { replayTestPath (verified), commitSha
 *   (format-verified) } — and every member that IS supplied must pass its own
 *   check (a failing member refuses; it is never silently ignored).
 *
 * MISHAP POLICY (#7b): a ticket of type 'mishap' (or whose title carries the
 * word "mishap" — agents occasionally file mishap-class reports under
 * bug_report) can only be machine-closed with a verified replayTestPath: the
 * whole point of a mishap ticket is a behavior to pin, and the replay test IS
 * the pin.
 *
 * REPLAY ROOTS: candidates are, in order — $REPLAY_TEST_ROOT (explicit ops
 * override; in prod, bind-mount the repo and point this at it), process.cwd()
 * (dev: backend/), and process.cwd()/.. (dev: the repo root). For each root
 * the path is tried verbatim AND with a leading 'backend/' stripped (the
 * backend container's tree is the backend dir itself). No root carries the
 * file → the ORIGIN/MAIN FALLBACK runs before the gate fails closed.
 *
 * ORIGIN/MAIN FALLBACK (ticket 012d3aa2, 2026-09-17; widened by cc7004a7,
 * 2026-09-23): the local roots are an INSTANCE checkout — in prod a bind
 * mount synced by the deploy, which can lag origin/main from merge until the
 * deploy settles (the dd4e20ad close was refused ~2h20m on a replay test
 * that WAS committed on main). So BOTH local-miss shapes now ask GitHub
 * (contents API, ref=main, riding the ticket owner's connected GitHub token
 * — the same token path the fleet pulse and run-evidence-guard use; repo
 * slug $GITHUB_REPO_SLUG resolved per instance — production defaults to
 * example-org/crossmodel, a NON-prod instance has NO default and never
 * falls back (instance-targets.ts boundary)): a local FILE miss (012d3aa2's original case) AND a
 * local CITATION miss on a file that exists (cc7004a7: a pre-existing test
 * file whose citation was appended by a just-merged commit — the stale bind
 * mount serves the pre-append copy and refused replay_test_unciting even
 * though origin/main carried the citation for 37/14 minutes). Found+citing
 * there verifies exactly as a local hit; a GitHub 404 on the file-miss lane
 * is an AUTHORITATIVE absence (never committed / wrong path — the refusal
 * says so); a found-but-unciting origin/main copy is a genuine citation
 * failure (the file exists everywhere and cites nowhere). Any other failure
 * (no token, network, 5xx) degrades to the fail-closed refusal, whose
 * message now names the stale-instance-checkout cause and tells the lane
 * to retry after the deploy settles instead of re-diagnosing its evidence.
 * The lane is a verifier, not an oracle: a fabricated path is absent from
 * origin/main exactly as it is absent locally, and fabricated citations
 * are absent from origin/main's copy of a real file.
 *
 * Human/user-anchored closes never reach this module — the caller
 * (platform-tools update_feedback) gates on ctx.userTurnAt.
 */

import fs from 'fs';
import path from 'path';
import prisma from '../../../config/database';
import logger from '../../../utils/logger';
import { modelToolName } from '../coding/tool-scope';
// Instance isolation boundary (ticket c75b5f34) — import-free leaf (pure
// functions + one Error subclass), so this module's static graph is unchanged.
import { resolveInstanceRepoTarget, IsolationBoundaryError } from '../platform/instance-targets';
// Ticket 36b8c979 — the liveness-probe leaf (import-free, Node URL/dns only):
// the close gate validates + serializes the probe the lane cites; the
// done-bar's deployed leg (fix-state.ts) re-fetches it server-side.
import { validateLivenessProbe, serializeLivenessProbe, type LivenessProbeEvidence } from './liveness-probe';

export interface CloseEvidence {
  commitSha?: string;
  prUrl?: string;
  deployRunId?: string;
  replayTestPath?: string;
  /**
   * The repo the fix lives in ("owner/name") — ticket cf5f9718. Optional:
   * absent = the platform repo (the instance's own target), the pre-existing
   * behavior. When supplied it is validated here, audited into the
   * `[machine-close evidence: …]` note (`repo <owner/name>`), and the
   * done-bar's merged ∧ deployed check (fix-state.ts) resolves against it.
   */
  repo?: string;
  /**
   * A server-side liveness probe (ticket 36b8c979) for a fix whose repo
   * deploys WITHOUT GitHub Actions and is not a Digby box (no deploy run, no
   * box_health telemetry — e.g. example-org/optcg → deckpose.com): the live
   * surface the fix ships on + the strings that prove it. SUPPORTING only —
   * it never satisfies the bar alone (it proves nothing about a merge), but
   * the done-bar's deployed leg re-fetches it server-side at resolve time
   * (fix-state.ts probeLiveness — the lane-pasted curl is never trusted).
   */
  livenessProbe?: LivenessProbeEvidence;
}

export type CloseEvidenceReason =
  | 'ticket_not_found'
  | 'evidence_required'
  | 'replay_required_for_mishap'
  | 'replay_test_missing'
  | 'replay_test_not_a_test'
  | 'replay_test_unciting'
  | 'invalid_commit_sha'
  | 'invalid_pr_url'
  | 'invalid_deploy_run_id'
  | 'invalid_repo'
  | 'invalid_liveness_probe'
  | 'unverifiable_evidence';

export type CloseEvidenceVerdict =
  | { ok: true; auditNote: string; verified: string[] }
  | { ok: false; reason: CloseEvidenceReason; message: string };

const SHA_RE = /^[0-9a-f]{7,40}$/;
const PR_URL_RE = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/;
const DEPLOY_RUN_ID_RE = /^\d{4,20}$/;
/** "owner/name" GitHub repo slug — ticket cf5f9718's evidence.repo. */
const REPO_SLUG_RE = /^[\w.-]+\/[\w.-]+$/;
const REPLAY_READ_CAP_BYTES = 1_000_000; // a replay test is small; cap the cite scan
const TICKET_PREFIX_LEN = 8;

/** The contract sentence every refusal carries — tells the model EXACTLY what to supply. */
export function closeEvidenceContract(ticketIdPrefix: string, isMishap: boolean): string {
  return (
    `Machine-triggered runs may only close a ticket to done with verifiable evidence: re-call ${modelToolName('update_feedback')} with ` +
    `evidence: { replayTestPath?: "<repo-relative test file that exists and contains the ticket id prefix '${ticketIdPrefix}'>", ` +
    `commitSha?: "<7-40 hex sha merged to origin/main>", prUrl?: "https://github.com/<owner>/<repo>/pull/<n>", deployRunId?: "<numeric Actions run id>", ` +
    `repo?: "<owner/name> — the repo the fix lives in (ticket cf5f9718); omit it for a fix in THIS platform repo", ` +
    `livenessProbe?: { url: "<https url the fix ships on>", expect: ["<strings it must contain>"] } (refetched server-side at close, ticket 36b8c979) }. ` +
    (isMishap
      ? `This is a MISHAP-class ticket: replayTestPath is REQUIRED — commit it first (a test that replays the mishap and cites '${ticketIdPrefix}'), then close. `
      : `At least one of replayTestPath (deterministically verified) or commitSha (format-verified, recorded) must be supplied; prUrl/deployRunId alone never satisfy the bar. `) +
    `If you cannot produce the evidence, do NOT close the ticket — leave it in_progress with an adminNote describing the state instead.`
  );
}

function isMishapClass(ticket: { type: string; title: string }): boolean {
  return ticket.type === 'mishap' || /\bmishap\b/i.test(ticket.title);
}

/** Candidate repo roots for replay-test resolution (see module header). */
function replayRootCandidates(): string[] {
  const roots: string[] = [];
  const env = String(process.env.REPLAY_TEST_ROOT ?? '').trim();
  if (env) roots.push(env);
  const cwd = process.cwd();
  roots.push(cwd, path.resolve(cwd, '..'));
  return roots;
}

/**
 * Resolve a repo-relative replay-test path against the candidate roots.
 * Traversal-safe: absolute paths and '..' segments are rejected outright
 * (return null) — the caller renders that as replay_test_missing.
 */
export function resolveReplayTestFile(relPath: string): string | null {
  const rel = relPath.replace(/^\.\//, '').replace(/^\/+/, '');
  if (!rel || rel.split(/[\\/]/).includes('..') || path.isAbsolute(relPath)) return null;
  const variants = [rel];
  if (rel.startsWith('backend/')) variants.push(rel.slice('backend/'.length));
  for (const root of replayRootCandidates()) {
    for (const v of variants) {
      const abs = path.resolve(root, v);
      // Containment re-check after resolution (belt-and-braces vs. the '..' filter).
      if (!abs.startsWith(path.resolve(root) + path.sep)) continue;
      try {
        if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return abs;
      } catch { /* unreadable root — try the next */ }
    }
  }
  return null;
}

/** The same traversal filter resolveReplayTestFile applies, exposed so the
 * origin/main lane can tell "unsafe path" (refuse verbatim, never fetch) from
 * "safe but missing locally" (worth a GitHub check). */
function isTraversalSafeRelPath(relPath: string): boolean {
  const rel = relPath.replace(/^\.\//, '').replace(/^\/+/, '');
  return Boolean(rel) && !rel.split(/[\\/]/).includes('..') && !path.isAbsolute(relPath);
}

type OriginMainReplay =
  | { state: 'found'; content: string }
  | { state: 'absent' } // GitHub 404 — authoritative: never committed / wrong path
  | { state: 'unavailable'; reason: string } // no token, network, 5xx — degrade to the legacy refusal
  | { state: 'isolation_boundary'; refusal: string }; // non-prod instance pointed at the PRODUCTION repo — never a read (c75b5f34 review F4)

const REPLAY_GITHUB_SLUG = () => {
  // Isolation boundary (c75b5f34): non-prod instance with no configured repo
  // ⇒ '' (the contents fetch fails → 'unavailable' → the caller fails CLOSED
  // with the stale-checkout refusal — never a production read); configured to
  // the production repo ⇒ IsolationBoundaryError (hard fail — the fetch's own
  // catch renders it as the unavailable reason).
  const r = resolveInstanceRepoTarget(process.env);
  if (r.ok) return r.slug;
  if (!String(process.env.GITHUB_REPO_SLUG ?? '').trim()) return '';
  throw new IsolationBoundaryError(r.refusal);
};

/** The boundary refusal for a non-prod instance whose repo target is unresolvable (unset / prod / unparseable), or null when the target is allowed. */
function replayIsolationRefusal(): string | null {
  // c75b5f34 review F4: EVERY !ok resolution is a configuration problem the
  // operator must fix — including GITHUB_REPO_SLUG unset (the old ''-slug
  // path 404'd and rendered as 'absent': "GitHub confirms it is NOT on
  // origin/main", a claim GitHub never made). All of them now return the
  // resolver's own refusal verbatim.
  const r = resolveInstanceRepoTarget(process.env);
  return r.ok ? null : r.refusal;
}

/**
 * ORIGIN/MAIN FALLBACK (ticket 012d3aa2 — see module header): verify the
 * replay test against the platform repo's origin/main via the GitHub contents
 * API. Rides the ticket owner's connected GitHub token (getValidToken — the
 * fleet-pulse/evidence-guard token path); the token-manager import is DYNAMIC
 * (fleet.service.ts discipline) so a bare test/env context never pays the
 * import-chain cost. Never throws: every failure degrades to 'unavailable',
 * and the caller fails closed with the stale-checkout-named refusal.
 */
async function fetchReplayTestFromOriginMain(
  relPath: string,
  ticketUserId: string | null | undefined,
  fetchImpl?: typeof fetch,
): Promise<OriginMainReplay> {
  // Token resolution (ticket abc76ebc): the ticket OWNER's token first, then
  // — when the owner has none — the LANE-HOME owner's (the nightly query
  // suite files its tickets from a synthetic bench account with no connected
  // GitHub token, which made this whole origin/main tolerance lane dead for
  // exactly the deploy-window closes it was built for: the 2026-10-15
  // 3× refusal streak on tickets afc10e95/6fd4663a). The repo is private, so
  // an unauthenticated fetch is NOT an option; the lane-home owner is the
  // platform operator whose account the dispatcher already acts for.
  // Kill switch: FEEDBACK_CLOSE_FALLBACK_TOKEN_DISABLED=1 restores
  // owner-token-only. Never throws: every failure degrades to 'unavailable'.
  const fallbackTokenDisabled = process.env.FEEDBACK_CLOSE_FALLBACK_TOKEN_DISABLED === '1';
  let token: string | null = null;
  let tokenSource = 'ticket owner';
  try {
    const { getValidToken } = await import('../github/token-manager');
    if (ticketUserId) token = await getValidToken(ticketUserId);
    if (!token && !fallbackTokenDisabled) {
      // Lane-home owner (feedback/lane-home.ts — a LEAF so this dynamic
      // import never pulls the dispatcher's config/redis import weight).
      const { resolveTicketLaneHome } = await import('./lane-home');
      const home = await resolveTicketLaneHome().catch(() => null);
      if (home?.userId) {
        const t = await getValidToken(home.userId).catch(() => null);
        if (t) {
          token = t;
          tokenSource = `lane-home owner (ticket owner ${ticketUserId ? String(ticketUserId).slice(0, 8) : 'absent'} has no token)`;
          logger.warn(`closure-evidence: origin/main fallback riding the ${tokenSource}`);
        }
      }
    }
  } catch (err: any) {
    logger.warn(`closure-evidence: origin/main lane token lookup failed (lane unavailable): ${err?.message ?? err}`);
    token = null;
  }
  if (!token) {
    return {
      state: 'unavailable',
      reason: fallbackTokenDisabled
        ? 'no connected GitHub token for the ticket owner (lane-home fallback disabled)'
        : 'no connected GitHub token for the ticket owner or the lane-home owner',
    };
  }
  const doFetch = fetchImpl ?? fetch;
  // Isolation boundary (c75b5f34, review F4): the boundary is checked BEFORE
  // the fetch — outside the try — so the refusal can never be demoted by the
  // catch into 'unavailable' (whose caller tells the operator to "retry after
  // the deploy settles", the exact opposite of the boundary's message).
  const isoRefusal = replayIsolationRefusal();
  if (isoRefusal) return { state: 'isolation_boundary', refusal: isoRefusal };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const apiPath = relPath.replace(/^\.\//, '').replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/');
    const res = await doFetch(`https://api.github.com/repos/${REPLAY_GITHUB_SLUG()}/contents/${apiPath}?ref=main`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'digby-closure-evidence',
      },
      signal: ctrl.signal,
    });
    if (res.status === 404) return { state: 'absent' };
    if (!res.ok) return { state: 'unavailable', reason: `GitHub HTTP ${res.status}` };
    const body: any = await res.json().catch(() => null);
    if (body?.type !== 'file' || typeof body?.content !== 'string') {
      return { state: 'unavailable', reason: 'unexpected contents payload (not an inline file object)' };
    }
    const content = Buffer.from(body.content.replace(/\s+/g, ''), 'base64').toString('utf8');
    return { state: 'found', content: content.slice(0, REPLAY_READ_CAP_BYTES) };
  } catch (err: any) {
    return { state: 'unavailable', reason: String(err?.message ?? err).slice(0, 120) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Verify a machine-triggered close's evidence for one ticket. Loads the ticket
 * (the mishap rule needs its type/title), validates every supplied member, and
 * demands at least one satisfying member. Never throws for expected refusals;
 * an unexpected error (DB down) fails CLOSED with a generic refusal.
 */
export async function verifyMachineCloseEvidence(opts: {
  ticketId: string;
  evidence: CloseEvidence | undefined | null;
  /**
   * true (default) = a CLOSE to status=done — the mishap→replay-test policy
   * binds. false = the ticket-18086326 machine-MUTATION gate (a non-done
   * status change / priority / adminNote from a machine run on a ticket that
   * is NOT dispatch-bound to the session): the artifact bar still applies,
   * but pinning a mishap's replay test is CLOSE-time policy — noting "fixed
   * in commit X" on a mishap row must not demand the replay test exist first.
   */
  forClose?: boolean;
  /** Test seam for the ORIGIN/MAIN FALLBACK fetch (mirrors verifyPushClaims). */
  fetchImpl?: typeof fetch;
}): Promise<CloseEvidenceVerdict> {
  let ticket: { id: string; type: string; title: string; userId: string | null } | null = null;
  try {
    ticket = await prisma.userFeatureRequest.findUnique({
      where: { id: opts.ticketId },
      select: { id: true, type: true, title: true, userId: true },
    });
    // Prefix parity (ticket e829e28c): the fleet convention cites 8-char
    // prefixes and updateFeedbackTicket now resolves a unique one — the gate
    // must not refuse the same close as ticket_not_found. UNIQUE match only:
    // ambiguous/short/unknown fall through to the fail-closed refusal.
    if (!ticket && opts.ticketId.trim().length >= TICKET_PREFIX_LEN) {
      const byPrefix = await prisma.userFeatureRequest.findMany({
        where: { id: { startsWith: opts.ticketId.trim() } },
        take: 2,
        select: { id: true, type: true, title: true, userId: true },
      });
      if (byPrefix.length === 1) ticket = byPrefix[0];
    }
  } catch (err: any) {
    logger.warn(`closure-evidence: ticket load failed for ${opts.ticketId} (failing closed): ${err?.message ?? err}`);
    return {
      ok: false,
      reason: 'ticket_not_found',
      message: `Could not load feedback ticket "${opts.ticketId}" to verify closure evidence — the close was NOT applied. Retry once; if it persists, leave the ticket alone and report the error.`,
    };
  }
  if (!ticket) {
    return { ok: false, reason: 'ticket_not_found', message: `Feedback ticket "${opts.ticketId}" not found — nothing was closed. Copy the exact id from list_feedback.` };
  }

  const prefix = ticket.id.slice(0, TICKET_PREFIX_LEN);
  const mishap = isMishapClass(ticket);
  const contract = closeEvidenceContract(prefix, mishap);

  const ev = opts.evidence && typeof opts.evidence === 'object' ? opts.evidence : {};
  const commitSha = String(ev.commitSha ?? '').trim().toLowerCase();
  const prUrl = String(ev.prUrl ?? '').trim();
  const deployRunId = String(ev.deployRunId ?? '').trim();
  const replayTestPath = String(ev.replayTestPath ?? '').trim();
  const repo = String(ev.repo ?? '').trim();
  // Ticket 36b8c979: the liveness probe is OPTIONAL supporting evidence. A
  // probe that is SUPPLIED but malformed refuses (junk is never silently
  // dropped into the note) — the empty shape is just absent.
  const probeRaw = (ev as { livenessProbe?: unknown }).livenessProbe;
  const hasProbe = probeRaw !== undefined && probeRaw !== null;
  const probe = hasProbe ? validateLivenessProbe(probeRaw) : null;
  if (hasProbe && probe && !probe.ok) {
    return { ok: false, reason: 'invalid_liveness_probe' as const, message: `evidence.livenessProbe rejected: ${probe.message} ${contract}` };
  }

  if (!commitSha && !prUrl && !deployRunId && !replayTestPath && !hasProbe) {
    return { ok: false, reason: 'evidence_required', message: `No evidence supplied. ${contract}` };
  }
  if (opts.forClose !== false && mishap && !replayTestPath) {
    return { ok: false, reason: 'replay_required_for_mishap', message: `Mishap-class ticket closed without a replay test. ${contract}` };
  }

  // Every SUPPLIED member must pass its own check — a failing member refuses,
  // it is never silently dropped (dropping would launder junk into the note).
  const verified: string[] = [];
  const noteParts: string[] = [];

  if (replayTestPath) {
    const abs = resolveReplayTestFile(replayTestPath);
    if (!abs) {
      // Local roots missed. ORIGIN/MAIN FALLBACK (ticket 012d3aa2): a just-
      // merged replay test is absent from a stale instance checkout for up to
      // the whole deploy window — ask GitHub before failing closed. Unsafe
      // paths skip the lane and refuse exactly as before.
      if (!isTraversalSafeRelPath(replayTestPath)) {
        return {
          ok: false,
          reason: 'replay_test_missing',
          message: `replayTestPath "${replayTestPath}" does not exist under any configured repo root (checked $REPLAY_TEST_ROOT, the backend dir, and its parent; absolute paths and '..' are rejected). The file must be COMMITTED and present on this instance before it counts. ${contract}`,
        };
      }
      const remote = await fetchReplayTestFromOriginMain(replayTestPath, ticket.userId, opts.fetchImpl);
      if (remote.state === 'isolation_boundary') {
        // c75b5f34 review F4: the boundary refusal VERBATIM — never the
        // stale-checkout "retry after the deploy settles" advice (this
        // misconfiguration cannot resolve by waiting).
        return {
          ok: false,
          reason: 'replay_test_missing',
          message: `replayTestPath "${replayTestPath}" cannot be verified: ${remote.refusal} Fix the instance's GITHUB_REPO_SLUG before closing tickets here. ${contract}`,
        };
      }
      if (remote.state === 'absent') {
        return {
          ok: false,
          reason: 'replay_test_missing',
          message: `replayTestPath "${replayTestPath}" does not exist under any configured repo root (checked $REPLAY_TEST_ROOT, the backend dir, and its parent; absolute paths and '..' are rejected), and GitHub confirms it is NOT on origin/main either (HTTP 404) — the file was never committed, or the path is wrong. Commit it first, then close. ${contract}`,
        };
      }
      if (remote.state === 'unavailable') {
        return {
          ok: false,
          reason: 'replay_test_missing',
          message: `replayTestPath "${replayTestPath}" does not exist under any configured repo root (checked $REPLAY_TEST_ROOT, the backend dir, and its parent; absolute paths and '..' are rejected). The file must be COMMITTED and present on this instance before it counts. The origin/main fallback could not check GitHub this attempt (${remote.reason}) — if the test was JUST merged, the likely cause is a STALE INSTANCE CHECKOUT (ticket 012d3aa2): the deploy syncs the mounted repo within minutes, so retry the close after the deploy settles instead of re-diagnosing your evidence. ${contract}`,
        };
      }
      // Found on origin/main — the same test-file + cite checks as a local hit.
      if (!path.basename(replayTestPath).toLowerCase().includes('test')) {
        return {
          ok: false,
          reason: 'replay_test_not_a_test',
          message: `replayTestPath "${replayTestPath}" exists on origin/main but is not a test file (its filename must contain "test", e.g. *.test.ts). Point at the actual replay/regression test. ${contract}`,
        };
      }
      if (!remote.content.toLowerCase().includes(prefix.toLowerCase())) {
        return {
          ok: false,
          reason: 'replay_test_unciting',
          message: `replayTestPath "${replayTestPath}" exists on origin/main but never mentions this ticket's id prefix "${prefix}" — a replay test must cite the ticket it pins (add a comment or test name carrying "${prefix}"). ${contract}`,
        };
      }
      verified.push('replayTestPath');
      noteParts.push(`replay test ${replayTestPath} (verified via origin/main: exists + cites ${prefix}; the instance checkout did not have it — stale-checkout tolerated)`);
    } else {
      if (!path.basename(abs).toLowerCase().includes('test')) {
        return {
          ok: false,
          reason: 'replay_test_not_a_test',
          message: `replayTestPath "${replayTestPath}" is not a test file (its filename must contain "test", e.g. *.test.ts). Point at the actual replay/regression test. ${contract}`,
        };
      }
      let content = '';
      try {
        const fd = fs.openSync(abs, 'r');
        try {
          const buf = Buffer.alloc(Math.min(REPLAY_READ_CAP_BYTES, fs.fstatSync(fd).size));
          fs.readSync(fd, buf, 0, buf.length, 0);
          content = buf.toString('utf8');
        } finally {
          fs.closeSync(fd);
        }
      } catch (err: any) {
        logger.warn(`closure-evidence: replay test read failed for ${abs}: ${err?.message ?? err}`);
        return { ok: false, reason: 'replay_test_missing', message: `replayTestPath "${replayTestPath}" exists but could not be read — the close was NOT applied. ${contract}` };
      }
      let citeNote = `replay test ${replayTestPath} (verified: exists + cites ${prefix})`;
      if (!content.toLowerCase().includes(prefix.toLowerCase())) {
        // cc7004a7 (2026-09-23): the 012d3aa2 fallback ran ONLY on local-file
        // ABSENCE, so a PRE-EXISTING test file whose citation was appended by
        // a just-merged commit resolved locally with STALE content and refused
        // replay_test_unciting without ever consulting origin/main — the
        // citations were already on main for 37/14 minutes at refusal time
        // (05198c8e pins @69d535687 18:14Z; cca4e450 cite @ef42d60e3 18:37Z;
        // breaker filed 18:51Z; the 19:12:19Z close then succeeded via local
        // hit only after wave 35901047857 synced the bind mount). The tool
        // schema (platform-tools.ts) already promised "must exist (on this
        // instance or on origin/main) and mention the ticket id prefix" — a
        // local CITATION miss now engages the same origin/main lane a local
        // FILE miss does. Degraded (no token / GitHub down) keeps the legacy
        // fail-closed refusal: origin/main is a tolerance lane for a stale
        // checkout, never a bypass. (The filename is already verified a test
        // file by the local branch above.)
        const remote = await fetchReplayTestFromOriginMain(replayTestPath, ticket.userId, opts.fetchImpl);
        if (remote.state === 'isolation_boundary') {
          // c75b5f34 review F4: verbatim refusal — never the stale-checkout
          // "retry after the deploy settles" advice.
          return {
            ok: false,
            reason: 'replay_test_unciting',
            message: `replayTestPath "${replayTestPath}" cannot be verified: ${remote.refusal} Fix the instance's GITHUB_REPO_SLUG before closing tickets here. ${contract}`,
          };
        }
        if (remote.state === 'found') {
          if (!remote.content.toLowerCase().includes(prefix.toLowerCase())) {
            // Origin/main ALSO does not cite — genuinely unciting everywhere.
            return {
              ok: false,
              reason: 'replay_test_unciting',
              message: `replayTestPath "${replayTestPath}" exists (both on this instance and on origin/main) but never mentions this ticket's id prefix "${prefix}" — a replay test must cite the ticket it pins (add a comment or test name carrying "${prefix}"). ${contract}`,
            };
          }
          // Origin/main carries the citation — stale local copy tolerated;
          // fall through so the remaining evidence members still validate.
          citeNote = `replay test ${replayTestPath} (verified via origin/main: exists + cites ${prefix}; the instance checkout has a stale copy predating the citation — stale-checkout tolerated)`;
        } else {
          // Degraded (no token / GitHub down / path absent there) — legacy
          // fail-closed refusal, now naming the stale-checkout cause so a
          // lane on a lagging bind mount retries instead of re-diagnosing.
          const why = remote.state === 'absent'
            ? 'GitHub reports the path absent there — the instance copy may be uncommitted local state'
            : remote.reason;
          return {
            ok: false,
            reason: 'replay_test_unciting',
            message: `replayTestPath "${replayTestPath}" exists but never mentions this ticket's id prefix "${prefix}" — a replay test must cite the ticket it pins (add a comment or test name carrying "${prefix}"). The origin/main cross-check could not run this attempt (${why}) — the close was NOT applied. If the citation was JUST merged, the likely cause is a STALE INSTANCE CHECKOUT (tickets 012d3aa2/cc7004a7): the deploy syncs the mounted repo within minutes, so retry the close after the deploy settles instead of re-diagnosing your evidence. ${contract}`,
          };
        }
      }
      verified.push('replayTestPath');
      noteParts.push(citeNote);
    }
  }

  if (commitSha) {
    if (!SHA_RE.test(commitSha)) {
      return { ok: false, reason: 'invalid_commit_sha', message: `commitSha "${ev.commitSha}" is not a 7-40 char hex sha. Supply the exact sha a tool result returned (git_push receipt / ls-remote line / PR merge response). ${contract}` };
    }
    verified.push('commitSha');
    noteParts.push(`commit ${commitSha} (format-verified; existence not checkable server-side — no repo checkout in this process)`);
  }

  if (repo) {
    // Ticket cf5f9718: the repo the fix lives in — validates + audits the
    // scope so the done-bar's merged ∧ deployed check (fix-state.ts) targets
    // THAT repo. Supports (never satisfies) the bar: it only tells the
    // commitSha check where to look. An invalid slug refuses (a malformed
    // scope must not silently downgrade to the platform repo and 404).
    if (!REPO_SLUG_RE.test(repo)) {
      return { ok: false, reason: 'invalid_repo', message: `evidence.repo "${ev.repo}" is not a GitHub "owner/name" repo slug (e.g. "example-org/optcg"). ${contract}` };
    }
    noteParts.push(`repo ${repo.toLowerCase()}`);
  }

  if (prUrl) {
    if (!PR_URL_RE.test(prUrl)) {
      return { ok: false, reason: 'invalid_pr_url', message: `prUrl "${prUrl}" is not a GitHub PR URL (https://github.com/<owner>/<repo>/pull/<n>). ${contract}` };
    }
    noteParts.push(`PR ${prUrl}`);
  }

  if (deployRunId) {
    if (!DEPLOY_RUN_ID_RE.test(deployRunId)) {
      return { ok: false, reason: 'invalid_deploy_run_id', message: `deployRunId "${deployRunId}" is not a numeric GitHub Actions run id. ${contract}` };
    }
    noteParts.push(`deploy run ${deployRunId}`);
  }

  if (hasProbe && probe?.ok) {
    // Ticket 36b8c979: the validated probe is audited into the note as a
    // single line (`live-probe <url> (expects "a|b")`) that fix-state.ts
    // parses back and RE-FETCHES server-side at resolve time. A probe that
    // cannot be serialized (an expect string with `"` or `|`, an oversized
    // url) refuses — a note shape the parser cannot invert is worse than no
    // probe at all.
    const serialized = serializeLivenessProbe({ url: probe.url.toString(), expect: probe.expect });
    if (!serialized) {
      return { ok: false, reason: 'invalid_liveness_probe', message: `evidence.livenessProbe cannot be recorded: the url must be ≤400 chars and no expect string may contain a double quote or a pipe. ${contract}` };
    }
    noteParts.push(serialized);
  }

  if (!verified.length) {
    return {
      ok: false,
      reason: 'unverifiable_evidence',
      message: `Only supporting evidence (prUrl/deployRunId/livenessProbe) was supplied — none of it proves a merge, so none satisfies the machine-close bar alone. ${contract}`,
    };
  }

  return {
    ok: true,
    verified,
    auditNote: `[machine-close evidence: ${noteParts.join('; ')}]`,
  };
}
