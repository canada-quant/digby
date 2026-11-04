/**
 * Infra-alert STABLE-KEY dedup (ticket fffacaee, 2026-10-20).
 *
 * THE DEFECT: one failed deploy run (39441731823, sha 51946acc, 2026-10-20
 * 14:47:52Z) produced TWO agent-filed tickets ~50s apart — b612be26 from chat
 * 6061a468 ("Deploy run 39441731823 failed (sha 51946acc, CI also red) — fix
 * and re-run") and 9e0c9f5a from chat c0e22e36 ("Deploy run 39441731823
 * failed on main head 51946acc — fix and re-run") — because EVERY dedup pass
 * in fileFeedbackTicket keys on TITLE TEXT (normalized equality, the mishap
 * 60-char class prefix, Jaccard, containment) and two supervisor chats
 * independently composed two differently-worded titles for the SAME alert.
 * infra-watch fans one deploy-failure alert out to up to 10 admin supervisor
 * chats (deliver() loops enqueueDirectWake per target), so two independent
 * "same event, own wording" filings are the DESIGNED shape of this alert
 * class, not an anomaly. Both tickets were then dispatched as ticket_lane —
 * two parallel lanes chartered to fix one failure; the Fleet Supervisor had
 * to de-conflict by hand and one lane's spend was pure duplication.
 *
 * THE KEY: an infra alert names a machine-stable identity — the failed GitHub
 * Actions RUN id (deploy-failure alerts) or the failing commit SHA (CI-red
 * alerts) — that survives any wording. Filing-side, a second alert whose key
 * matches an OPEN agent ticket bumps THAT ticket (occurrences/sighting, the
 * existing bumpDedupedTicket shape) instead of creating a new row;
 * dispatch-side, the drain refuses a second lane while a same-key ticket is
 * already dispatchedTo a live lane.
 *
 * STRICT-ALERT GATING (the false-positive guard): meta-tickets ABOUT a
 * duplicate alert (this very ticket, fffacaee, quotes "39441731823" and
 * "51946acc" in its title and description) must never be deduped into the
 * alert ticket. The extractor therefore recognizes an alert filing only by
 * its SHAPE, never by bare id presence:
 *   - deploy-failure: a title led by "deploy run <id>" (case-insensitive,
 *     any wording tail), PLUS the run id appearing in the body as the raw
 *     GitHub Actions URL (github.com/<owner>/<repo>/actions/runs/<id>) — the
 *     URL is machine-rendered by the alert (infra-watch
 *     renderDeployFailureAlert) and quotes verbatim by every downstream
 *     brief; a meta-ticket's prose never manufactures it for a run it is
 *     only DESCRIBING as already covered. A second run id later in the body
 *     is ignored: the alert is ABOUT the run the title names.
 *   - CI-red: a title led by "ci" + "red|fail" (the renderLaneWakePrompt /
 *     [CI FAILED — owner/repo@sha] family), with the failing sha extracted
 *     from the body's "@<sha>" marker or a bare 7-40 hex run of ≥7 chars
 *     (GitHub short-sha length). The sha, not the run id, is the CI-red key
 *     (the sha is what CI actually failed; a re-run gets a new run id).
 *
 * Repo scope: the key includes the repo when one is derivable
 * (github.com/<owner>/<repo>/actions/runs/<id> in the body, or an
 * owner/repo@sha marker) — the same run id space is shared across repos by
 * GitHub's global counter, so an unqualified deploy key could fold two
 * DIFFERENT repos' alerts; when no repo is derivable the key is
 * repo-qualified "unknown" and still folds (the run id is globally unique in
 * practice; under-folding only risks a duplicate, the pre-fix behavior).
 *
 * All extractors are PURE and exported for tests. Kill switch:
 * FEEDBACK_INFRA_ALERT_DEDUP_DISABLED=1 (fail-safe: back to title-only dedup).
 *
 * The BACKUP class (ticket 253636d6, 2026-10-24) joined later with the same
 * discipline: one stale event on box-a filed two differently-worded tickets
 * 9.3 s apart (437896fb "missed" / cf047f4a "skipped") because the class had
 * no key kind. A backup alert names no run id / sha — its stable identity is
 * the EPISODE: severity + host + the millisecond ISO of the newest dump
 * (stale/failed), or severity + host (missing/lapse). Title gate = the
 * adjacent pair "backup <severity>" (or "backup producer not reporting");
 * body gate = the machine-rendered "INFRA ALERT" marker. The prefilter token
 * is the class word 'backup' — a substring of every backup-shaped title by
 * construction (superset proof holds).
 */

/** The stable identity of an infra-alert filing. Kind is lowercase. */
export interface InfraAlertKey {
  kind: 'deploy-failure' | 'ci-red' | 'backup';
  /** Deploy-failure: the GitHub Actions run id (digits). CI-red: the failing sha (7-40 hex). Backup: the severity ('stale' | 'failed' | 'missing' | 'lapse'). */
  id: string;
  /** Lowercase "owner/repo" when derivable, else 'unknown'. Backup: "<host>" for missing/lapse, "<host>@<newest-dump ms-ISO>" for stale/failed — the millisecond dump timestamp names the EPISODE (the sweep's own "seen hh:mmZ" observation clock is second-precision and moves every sweep, so it is never part of the identity). */
  repo: string;
}

/** The canonical string form stored on context.infraAlertKey and compared everywhere. */
export function infraAlertKeyString(k: InfraAlertKey): string {
  return `${k.kind}:${k.id.toLowerCase()}:${k.repo}`;
}

/** True when the env kill switch disables the infra-alert stable-key dedup. */
export function infraAlertDedupDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|on|yes)$/i.test(String(env.FEEDBACK_INFRA_ALERT_DEDUP_DISABLED ?? '').trim());
}

/** The context field the key is stamped on (flat string — never a nested object). */
export const INFRA_ALERT_KEY_FIELD = 'infraAlertKey';

export function infraAlertKeyOfContext(context: unknown): string {
  if (!context || typeof context !== 'object' || Array.isArray(context)) return '';
  const v = (context as Record<string, unknown>)[INFRA_ALERT_KEY_FIELD];
  return typeof v === 'string' ? v.trim() : '';
}

// A GitHub Actions run id: a plain digit run (globally unique, monotonically
// growing — 10 digits by 2026).
const RUN_ID_RE = /^\d{6,}$/;
// The raw run URL in a body: github.com/<owner>/<repo>/actions/runs/<id>.
const RUN_URL_RE = /https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/actions\/runs\/(\d{6,})/i;
// "Deploy run <id>" at the head of a title (case-insensitive, tolerate the
// em-dash/en-dash/hyphen spacing variants the alert texts use).
const DEPLOY_TITLE_RE = /^deploy\s+run\s+(\d{6,})\b/i;
// The ci-watch lane wake / escalation family head: "CI FAILED", "CI red",
// "CI is red", "red CI on ..." — a title ABOUT a red-CI event.
const CI_RED_TITLE_RE = /^(?:\[?\s*ci\b[^a-z0-9]{0,3}(?:failed|fails|red|is\s+red)|red\s+ci\b)/i;
// The ci-watch sha marker: "...@<sha>" (renderLaneWakePrompt: owner/repo@sha12).
const SHA_AT_RE = /@([0-9a-f]{7,40})\b/i;
// A bare hex sha run (GitHub short-sha floor of 7 hex chars).
const BARE_SHA_RE = /\b([0-9a-f]{7,40})\b/i;
// An owner/repo pair adjacent to the sha marker (owner/repo@sha).
const REPO_AT_RE = /([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)@([0-9a-f]{7,40})/;
// Backup-alert title shapes (ticket 253636d6, 2026-10-24): the ADJACENT pair
// "backup <severity>" (optionally " on <host>"), or the lapse family
// "backup producer not reporting (on <host>)" — how every downstream title
// quotes the rendered heads "[INFRA ALERT — backup stale]" / "[INFRA ALERT —
// backup producer not reporting]". Live specimens: "Nightly backup stale on
// box-a — digby-backup.timer missed last night's dump" and "...skipped last
// night's dump (30.1 h old)". A META ticket about the backup-dedup defect
// writes "backup alerts — one stale event" (backup NOT adjacent to a
// severity word) and never matches. The host may not start with a digit (a
// date is not a host).
const BACKUP_TITLE_RE = /backup\s+(?:(stale|failed|missing)|producer\s+not\s+reporting)\b(?:[^a-z0-9]{1,3}on\s+([a-z][a-z0-9.-]*))?/i;
// The machine-rendered body marker: "INFRA ALERT" anywhere in the body. Both
// live specimens carry it (one bracketed "[INFRA ALERT — backup stale,
// fired …]", one paraphrased "INFRA ALERT — the newest…"); prose about
// backups never manufactures the marker.
const BACKUP_BODY_MARKER_RE = /INFRA\s+ALERT/i;
// A millisecond-precision ISO timestamp — the newest dump's newestAt, the
// EPISODE identity for stale/failed. Second-precision stamps (the sweep's
// "fired 2026-10-24T15:19Z") are deliberately excluded: they differ between
// the pair while the dump timestamp is identical.
const BACKUP_DUMP_TS_RE = /\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\b/i;
// Host fallback from the rendered missing/lapse heads ("…on the backup
// producer <host>" / "the backup producer <host> has not reported…").
const BACKUP_PRODUCER_HOST_RE = /backup\s+producer\s+([a-z][a-z0-9.-]*)/i;

/**
 * Extract the infra-alert stable key from a filing's title + description.
 * Returns null when the filing is not alert-SHAPED (no title head match, or
 * the title matches but the body carries no machine-rendered id/sha) — a
 * meta-ticket about an alert, or any ordinary bug report, reads null.
 * Pure; exported for tests.
 */
export function extractInfraAlertKey(title: string, description: string): InfraAlertKey | null {
  const t = String(title ?? '').trim();
  const body = String(description ?? '');

  // ── Deploy-failure alert ──
  const dt = t.match(DEPLOY_TITLE_RE);
  if (dt) {
    const runId = dt[1];
    // The body must corroborate with the machine-rendered run URL — the
    // alert always carries it and every brief quotes it. A meta-ticket's
    // prose mention of the run id never satisfies this (it has no reason to
    // link a run it is only describing as already covered).
    const url = body.match(RUN_URL_RE);
    if (!url) return null;
    // The URL's run id must BE the title's run id — a title naming run A
    // over a body linking run B is not an alert filing about A.
    if (url[3] !== runId) return null;
    const repo = `${url[1].toLowerCase()}/${url[2].toLowerCase().replace(/\.git$/, '')}`;
    return { kind: 'deploy-failure', id: runId, repo };
  }

  // ── Backup alert (ticket 253636d6, 2026-10-24) ──
  // The backup class has NO run id / sha to name it — its stable identity is
  // the EPISODE: the host whose dump is stale + the millisecond ISO of the
  // newest dump (stale/failed) or just the host (missing/lapse — no dump
  // exists to name). STRICT-ALERT GATING per the deploy-failure discipline:
  // the TITLE must carry the ADJACENT pair "backup <severity>" — the
  // machine-rendered head "[INFRA ALERT — backup stale]" is quoted
  // adjacently by every downstream title (both live specimens:
  // "backup stale on box-a", "Backup FAILED on box-a"), while a META ticket
  // about this very defect writes "backup alerts — one stale event" (not
  // adjacent) and must never fold — AND the BODY must corroborate with the
  // machine-rendered "INFRA ALERT" marker anywhere in the description (both
  // live specimens carry it: index 0 as "[INFRA ALERT — backup stale, fired
  // …]" and index 1 as "INFRA ALERT — the newest…"; prose about backups
  // never manufactures the marker).
  const bt = t.match(BACKUP_TITLE_RE);
  if (bt) {
    const severity = (bt[1] ?? 'lapse').toLowerCase();
    if (!BACKUP_BODY_MARKER_RE.test(body)) return null;
    let host = (bt[2] || '').toLowerCase();
    if (!host) {
      const bp = body.match(BACKUP_PRODUCER_HOST_RE);
      if (bp) host = bp[1].toLowerCase();
    }
    // ms-precision ISO only: the episode identity. Second-precision stamps
    // (the sweep's "fired 2026-10-24T15:19Z" head) are deliberately not
    // matched — they differ between the pair while the dump timestamp is
    // identical; a paraphrased-away timestamp degrades to severity@host
    // (under-fold = the pre-fix behavior, never a wrong fold).
    const ts = severity === 'stale' || severity === 'failed' ? body.match(BACKUP_DUMP_TS_RE) : null;
    return { kind: 'backup', id: severity, repo: ts ? `${host}@${ts[1]}` : host };
  }

  // ── CI-red alert ──
  if (CI_RED_TITLE_RE.test(t)) {
    const repoAt = body.match(REPO_AT_RE);
    if (repoAt) {
      return { kind: 'ci-red', id: repoAt[3].toLowerCase(), repo: `${repoAt[1].toLowerCase()}/${repoAt[2].toLowerCase()}` };
    }
    const atSha = body.match(SHA_AT_RE);
    if (atSha) return { kind: 'ci-red', id: atSha[1].toLowerCase(), repo: 'unknown' };
    const bare = body.match(BARE_SHA_RE);
    if (bare) return { kind: 'ci-red', id: bare[1].toLowerCase(), repo: 'unknown' };
    return null;
  }

  return null;
}

/**
 * Does a candidate row (context + title/description for unstamped legacy
 * rows) carry the SAME infra-alert key as a newly filed alert? Unstamped
 * rows are re-derived through the extractor so tickets filed BEFORE this fix
 * (like 9e0c9f5a against b612be26) still fold. Pure; exported for tests.
 */
export function infraAlertKeysEqual(
  candidate: { context?: unknown; title?: string; description?: string },
  newKey: InfraAlertKey,
): boolean {
  const stamped = infraAlertKeyOfContext(candidate.context);
  if (stamped) return stamped === infraAlertKeyString(newKey);
  // The candidate's title must ITSELF be alert-shaped — a stamped-key match
  // is authoritative, but re-derivation from prose is only trusted when the
  // row looks like the alert (a meta-ticket about a duplicate alert quotes
  // the run id but its title is not "Deploy run <id>" — fffacaee itself:
  // "Infra-alert dispatcher double-files/double-dispatches one failed deploy
  // run (two tickets ~50s apart, two lanes)").
  if (!candidate.title || !candidate.description) return false;
  const derived = extractInfraAlertKey(String(candidate.title), String(candidate.description));
  return !!derived && infraAlertKeyString(derived) === infraAlertKeyString(newKey);
}
