/**
 * Phantom-fabrication evidence guard (feedback cluster be0b5271 — 19 occurrences).
 *
 * THE BUG: an interrupted scheduled coding run resumes and reconstructs its
 * final summary from PLAN INTENT rather than fresh evidence — it "remembers"
 * the plan's completion state and fabricates PR merges, merge shas, exact
 * timestamps, and box-probe results it never observed (ticket 1b605132:
 * "PR #224 squash-merged at 4:19:21 AM, sha 84fe3ae0 … Box probe 03:07:22 …
 * md5 50dd0c04" — all invented; the real PR was never merged). The phantom
 * signature: a final answer full of completion claims backed by ZERO
 * evidence-bearing tool calls in the run's transcript.
 *
 * THE GUARD (three deterministic layers, wired at the executor finalize seam):
 *   1. extractCompletionClaims / findUnprovenClaims — line-level claim
 *      extraction (PR merges/creates/closes, deploys, box probes, benchmark
 *      tallies, bare commit-sha pushes) + the zero-evidence cross-check.
 *      Negation is WINDOWED for
 *      every kind: only a negation cue in the ~40 chars IMMEDIATELY
 *      PRECEDING the verb/evidence keyword suppresses that match — a
 *      trailing "…though the probe did not pass" still claims, while
 *      "did not merge PR #224", "the deploy is not live" and "probe found
 *      nothing active" are honestly negative and claim nothing. A
 *      MACHINE-triggered run (schedule/hook/auto-resume — never a user
 *      turn) whose claims have no evidence gets an explicit HARNESS
 *      EVIDENCE GUARD notice appended.
 *   2. renderEvidenceGuardNote — the guard-1 notice text (claim-kind counts,
 *      NO FRESH EVIDENCE this turn, every claim marked UNVERIFIED). Evidence
 *      is PER-KIND: delegate/delegate_parallel evidence ALL kinds (subagents
 *      have real tools); pr_merged/pr_created/pr_closed/commit_pushed claims
 *      demand an external-action tool call (run_command, git_*,
 *      open_pull_request, merge_pull_request, github_*); deploy claims take
 *      that same action class, and — for the pure OBSERVATION shape only
 *      ("health check 200", "prod green", "digby.ai healthy", no deploy verb;
 *      F32 2026-10-22, EVIDENCE_GUARD_DEPLOY_OBSERVATION_DISABLED=1 to
 *      restore) — the deploy-health observation reads (get_fleet_telemetry,
 *      scrape_as_markdown, scrape_batch, browser_task); probe/benchmark
 *      claims also accept local reads
 *      (read_file/list_dir/glob/grep) and web reads (search_engine,
 *      scrape_as_markdown, scrape_batch, web_pipe, youtube_pipe,
 *      browser_task) and computer-use observations (computer_task —
 *      ticket 2ab33824). update_plan/search_memory/search_code_semantic/
 *      ask_user evidence NOTHING. GUARD 1 resolves machine-run claims against
 *      tool RECEIPTS first; probe/benchmark claims a receipt cannot match
 *      (observation tools leave none) fall back to this tier (2ab33824), as
 *      does the deploy-OBSERVATION shape (F32).
 *   3. verifyPrClaims / renderVerificationFooter — EVERY claimed PR (any
 *      trigger) is checked against the GitHub API and annotated per CLAIMED
 *      KIND (extractPrClaimKinds): merge claims get the real sha/merged_at
 *      receipt or an UNVERIFIED flag; create claims are CONFIRMED by an
 *      existing open PR; close claims are CONFIRMED by a closed-unmerged
 *      PR; 404s are flagged fabricated. Mixed kinds on one number render
 *      the highest-stakes verdict (pr_merged > pr_closed > pr_created).
 *
 * Hard constraints: NO prisma, NO config/env, NO LLM calls — deterministic
 * pure functions plus best-effort async verifications that NEVER throw (the
 * GitHub primary-source family — pulls/commits/actions-runs — and the
 * INJECTED feedback-ticket existence resolver of guard 6; token missing /
 * network down / non-GitHub provider → 'unavailable', never a run failure).
 * MessagePart is a TYPE-ONLY import: the real agent module graph is too
 * heavy for tests.
 */

import logger from '../../../utils/logger';
import { getValidToken } from '../github/token-manager';
import type { MessagePart } from './agent';
import {
  parseClaimsBlock, parseClaimsBlocks, verifyClaimsBlock, refNamesPrNumber, refNamesSha, isHexRef,
  type ClaimsBlockEntry, type ClaimsBlockType, type VerifiedBlockClaim,
} from './claims-block';
// Re-export for the supervisor chat seam (chat-agent.service.ts imports both
// from here — the guard is the module's public surface).
export { parseClaimsBlock };
import { receiptMatchesClaim, isLocalReceiptTool, type ToolReceipt } from './run-receipts';
import { NON_EVIDENCE_TOOLS, PLATFORM_OBSERVE_TOOLS, INFRA_PROBE_SUBJECT_RE, isEvidenceToolName, isDeployObservationClaimText, DEPLOY_HEALTH_OBSERVATION_TOOLS, DEPLOY_HEALTH_SURFACE_RE, deployObservationTierDisabled } from './evidence-tools';

// ── Layer 1: claim extraction ───────────────────────────────────────────────

export type ClaimKind = 'pr_merged' | 'pr_created' | 'pr_closed' | 'deploy' | 'probe' | 'benchmark' | 'commit_pushed' | 'commit_local';

export interface CompletionClaim {
  kind: ClaimKind;
  prNumber?: number;
  /** The claimed git sha (commit_pushed / commit_local claims only). */
  sha?: string;
  /** The final-answer line the claim was extracted from (trimmed). */
  text: string;
}

/** Cap on GitHub verification calls per final answer (one GET per PR). */
export const MAX_VERIFY_PRS = 5;

// A PR/pull-request number: "PR #224", "PR 224", "pull request 224", "pull/224"
// (the global matching variant lives inside prNumbersOnLine).
// Completion verbs (either order in the clause: "PR #224 was merged" / "merged PR #224").
// COMPLETED-action forms ONLY: a bare "merge" is future/conditional/conflict
// phrasing ("Next step: merge PR #224 once CI passes", "fixed the merge conflict
// in PR #224"), not a completion claim. A negated "did not merge PR #224" then
// simply has NO verb match → no claim → the honest reading.
const MERGE_VERB_RE = /\b(?:squash-merged|merged|merge committed|landed)\b/i;
const CREATE_VERB_RE = /\b(?:created|opened|filed)\b/i;
const CLOSE_VERB_RE = /\bclosed\b/i;
// Negation guard (ALL claim kinds): an HONEST failure/open/negative report is
// not a claim — "did not merge PR #5", "the deploy is not live", "probe found
// nothing active", "PR #224 is still open". WINDOWED: only a negation cue in
// the ~NEGATION_WINDOW_CHARS IMMEDIATELY PRECEDING the matched verb/evidence
// keyword suppresses that match — a negation AFTER the verb ("Merged PR #224,
// though the box probe did not pass") does NOT suppress the claim.
const NEGATION_RE = /\b(?:not|never|didn'?t|did not|couldn'?t|could not|failed to|fails|failed|isn'?t|wasn'?t|still open|unmerged|nothing)\b/i;
const NEGATION_WINDOW_CHARS = 40;

/**
 * Future-INTENT cues scope the pr_* verb that FOLLOWS them (ticket 78b13021
 * case 2): "the completion publish will create PR #264" is a PLAN, not a
 * completion claim — but GitHub 404s the number, which used to brand the
 * honest forward reference a FABRICATED claim. Windowed like the negation
 * guard: only a cue in the ~48 chars immediately BEFORE the verb (never past
 * the clause start) suppresses that occurrence, so "merged PR #263; will
 * create PR #264" still claims #263. Bare "plan" is deliberately NOT a cue
 * ("Plan 6/6 — CLOSED: merged PR #224" is a real claim).
 *
 * TRUE intent markers only (hardened 2026-08-23 — the first cut also listed
 * the past-NARRATIVE connectives after/when/once/next, which erased real
 * claims: "After review, merged PR #999" / "When the tests passed, I merged
 * PR #999" extracted NOTHING, an outright evasion channel). after/next are
 * gone; once/when survive ONLY as participial conditionals — see
 * PARTICIPIAL_INTENT_RE below.
 */
const INTENT_BEFORE_VERB_RE = /\b(?:will|would|pending|to be|scheduled?|awaiting|planned)\b/i;
const INTENT_VERB_WINDOW_CHARS = 48;

/**
 * Participial conditional: once/when scope a verb ONLY when the connective
 * sits IMMEDIATELY before it — "once merged, PR #264 will carry the docs" is
 * a plan; "When the tests passed, I merged PR #999" (words between the
 * connective and the verb) is a completed-action narrative and still claims.
 */
const PARTICIPIAL_INTENT_RE = /\b(?:once|when)\s+$/i;

/** True iff a future-intent cue scopes the verb at matchIndex: a windowed cue
 * in the ~48 chars before it (never past the clause start), or a participial
 * once/when IMMEDIATELY before it. */
function intentBeforeVerb(clause: string, matchIndex: number): boolean {
  const clauseStart = clauseStartBefore(clause, matchIndex);
  const from = Math.max(clauseStart, matchIndex - INTENT_VERB_WINDOW_CHARS);
  if (INTENT_BEFORE_VERB_RE.test(clause.slice(from, matchIndex))) return true;
  return PARTICIPIAL_INTENT_RE.test(clause.slice(clauseStart, matchIndex));
}

/**
 * Negative-probe / non-existence report (ticket 78b13021 case 2): "PR #264 →
 * HTTP 404 (free)", "PR #264 does not exist", "PR #264 not found" assert a
 * number's ABSENCE — the opposite of a completion claim. The cue sits right
 * AFTER the number; per-number (NOT clause-wide), so a fabricated merge line
 * cannot evade the guard by appending "…and PR #999 → 404" to the clause.
 *
 * STRICT SHAPE (hardened 2026-08-23 — the first cut's bare `404\b` /
 * `not found` alternatives let ANY such token within the window suppress:
 * "Merged PR #999, resolving the 404 issue" hid the fabricated #999 from
 * GitHub verification AND, by killing the claim, from guard-3 stamp scanning
 * on that line). The cue must be PREDICATED of the PR number itself: the text
 * between the mention and the cue may hold only CONNECTOR tokens
 * (punctuation/markdown, copulas, probe-context words), and a `404` cue
 * additionally needs an explicit probe MARKER right before it (arrow, colon,
 * equals, or a returns/says/shows-style verb, or an HTTP/GitHub/API prefix)
 * or the "404 when checking" phrase shape. So "→ HTTP 404", "— GitHub
 * returns 404", ": 404 when checking", "is not found", "does not exist"
 * suppress; a bare "404" / "not found" buried in ordinary prose does not.
 */
const ABSENCE_CONNECTOR_SRC = String.raw`(?:[\s*_\x60~()\[\]{}"'|,:=→⇒—–-]|\b(?:the|a|an|it|is|was|are|were|now|currently|still|github|gh|api|https?|get|head|status|state|check(?:s|ed|ing)?|lookup|quer(?:y|ied)|probe[sd]?|probing|fetch(?:ed|ing)?|return(?:s|ed|ing)?|gives?|got|gave|show(?:s|ed|n)?|says?|said|reports?|reported|confirm(?:s|ed)?)\b)*`;
const ABSENCE_404_MARKER_SRC = String.raw`(?:[:=→⇒]|->|=>|\b(?:is|was|github|gh|api|https?|status|get|return(?:s|ed|ing)?|gives?|got|gave|show(?:s|ed|n)?|says?|said|reports?|reported|confirm(?:s|ed)?)\b)`;
const PR_ABSENCE_AFTER_RE = new RegExp(
  '^' + ABSENCE_CONNECTOR_SRC + '(?:'
    + ABSENCE_404_MARKER_SRC + String.raw`\s*(?:an?\s+)?(?:HTTP[\s/]*)?404\b`
    + String.raw`|\b404\s+(?:when|while|on)\s+(?:re-?)?(?:check|quer|fetch|prob|hit|look|get)\w*`
    + String.raw`|\bdoes\s+not\s+exist\b|\bdoesn'?t\s+exist\b|\bnever\s+existed\b`
    + String.raw`|\bno\s+such\s+(?:PR|pull\s+request)\b`
    + String.raw`|\bnot\s+found\b`
  + ')',
  'i',
);
const PR_ABSENCE_WINDOW_CHARS = 48;

/** True iff a non-existence cue sits within ~48 chars AFTER an occurrence of
 * prNumber — and BEFORE the next PR mention, so the cue can only belong to
 * THIS number ("merged PR #263, and PR #999 → HTTP 404" still claims #263). */
function prReportedAbsent(clause: string, prNumber: number): boolean {
  const mentionRe = /(?:\bPR\b|pull request|pulls?\/)\s*#?\d{1,6}/gi;
  const mentions: { n: number; start: number; end: number }[] = [];
  for (const m of clause.matchAll(mentionRe)) {
    mentions.push({ n: parseInt(m[0].replace(/\D+/g, ''), 10), start: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
  }
  for (let i = 0; i < mentions.length; i++) {
    if (mentions[i].n !== prNumber) continue;
    const nextStart = mentions[i + 1]?.start ?? clause.length;
    const after = clause.slice(mentions[i].end, Math.min(mentions[i].end + PR_ABSENCE_WINDOW_CHARS, nextStart));
    if (PR_ABSENCE_AFTER_RE.test(after)) return true;
  }
  return false;
}

/**
 * Strong clause boundaries: claims associate within a clause, so a negation
 * cue in an EARLIER clause must not suppress a later one ("did not merge
 * PR #224; merged PR #225 instead" — the #225 merge is a REAL claim).
 * Commas are deliberately NOT boundaries: "Merged PR #5, superseding PR #4"
 * keeps both numbers associated with the one verb.
 */
const CLAUSE_SPLIT_RE = /[;|•—]|\.\s+/;

/** Index where the clause containing matchIndex starts (0 when no boundary). */
function clauseStartBefore(line: string, matchIndex: number): number {
  let start = 0;
  for (const m of line.slice(0, matchIndex).matchAll(new RegExp(CLAUSE_SPLIT_RE.source, 'g'))) {
    start = (m.index ?? 0) + m[0].length;
  }
  return start;
}

/**
 * True iff a negation cue sits in the ~NEGATION_WINDOW_CHARS immediately
 * BEFORE matchIndex, never looking past the start of the current clause.
 */
function negatedBefore(line: string, matchIndex: number): boolean {
  const from = Math.max(clauseStartBefore(line, matchIndex), matchIndex - NEGATION_WINDOW_CHARS);
  return NEGATION_RE.test(line.slice(from, matchIndex));
}

/**
 * True iff SOME occurrence of the pattern on the line is negation-free.
 * Per-occurrence: a negated first hit must not hide a later clean one
 * ("did not deploy; the deploy is now green" IS a deploy claim).
 */
function anyMatch(line: string, re: RegExp): boolean {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  for (const m of line.matchAll(g)) {
    if (m.index !== undefined && !negatedBefore(line, m.index)) return true;
  }
  return false;
}

/**
 * anyMatch for pr_* completion VERBS: an occurrence counts only when it is
 * neither negated NOR future-intent-scoped ("will be created" claims nothing
 * — the intent form reports a plan, and GitHub 404s the not-yet-existing
 * number into a false FABRICATED verdict).
 */
function verbClaimed(clause: string, re: RegExp): boolean {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  for (const m of clause.matchAll(g)) {
    if (m.index === undefined) continue;
    if (negatedBefore(clause, m.index) || intentBeforeVerb(clause, m.index)) continue;
    return true;
  }
  return false;
}

/** True iff BOTH patterns have a negation-free occurrence on the line. */
function pairMatch(line: string, a: RegExp, b: RegExp): boolean {
  return anyMatch(line, a) && anyMatch(line, b);
}
// Deploy: the verb + a success adjective on the same line…
const DEPLOY_RE = /\bdeploy(?:ed|ment|s)?\b/i;
const DEPLOY_OK_RE = /\b(?:green|healthy|live|succeeded|passed|flipped)\b/i;
// …or a health surface + an OK signal ("health check 200", "prod green", "digby.ai healthy").
// F32: the regex lives in evidence-tools.ts (DEPLOY_HEALTH_SURFACE_RE — the single shared
// home; the boundary predicate isDeployObservationClaimText and this extraction must see
// the SAME surface) — this alias is import-order sugar.
const DEPLOY_ALT_RE = DEPLOY_HEALTH_SURFACE_RE;
// Probe: a box/tailnet/remote-host/probe mention + an observed-evidence noun.
const PROBE_RE = /\b(?:box|tailnet|remote host|probe[sd]?)\b/i;
// Widened 2026-09-08 (a8976e11 draft B's fabricated box probe made NO probe
// claim): "md5s match", "F87_WATCH_CLOCK:" (underscore-glued — \b never
// fires between '_' and 'C'), "Up 4 hours (healthy)", "Exited (0)".
const PROBE_EVIDENCE_RE = /\b(?:HTTP 200|mtime|md5(?:s|sums?)?|sha\d{1,3}(?:sums?)?|lines|active|enabled|healthy|uptime|exited)\b|(?<![A-Za-z])clock\b|\bUp \d+ (?:second|minute|hour|day|week)s?\b/i;
// Benchmark: a tally/benchmark/GPQA mention + a counted verdict ("363 PASS").
const BENCH_RE = /\b(?:tallies|benchmark|gpqa)\b/i;
const BENCH_EVIDENCE_RE = /\b\d+\s*(?:PASS|TRUNC|FAIL)\b/i;
// Commit-push (ticket b8fa321a — "commits 1539fa86/42f4a4a2 live on origin/main"
// named NO PR and NO deploy keyword, so it sailed past every kind above):
// a bare git sha + a COMPLETED push verb in the same clause. Verbs are
// completed-action forms only — a bare "push" is future/failed phrasing
// ("Next: push 1539fa86", "push failed") and claims nothing.
const COMMIT_PUSH_VERB_RE = /\b(?:pushed|force-pushed|landed|live on origin)\b/i;
// commit_local (finding A1, 2026-09-27 — canlaw 710 commits / 1 push; spark
// "fully banked a65e79f4" relayed 3x with the sha 422 on origin): a bare git
// sha + a COMMIT-shaped completion verb in the same clause. "Banked" /
// "committed <sha>" reads to the owner as durable work, yet a git_commit only
// ever proves the WORKTREE has it. The claim requires a git_push receipt
// (ids.sha — this run's, or one observed in a get_run_receipts read this
// run) or an origin resolve; a commits-API 404 is an observe-only "commit not
// on origin — local only, not pushed" strike (verdict.localOnlyShas), never a
// fabrication conviction (the commit may well exist locally). A clause that
// ALSO carries a push verb is a commit_pushed claim for that sha, not a
// commit_local one. Unconditional since RSW-1 2026-11-03 (the kill switch
// that could disable the extraction and the receipt split is gone).
// Review fix (same day): "saved" / "checkpointed" are NOT git verbs — on an
// ML lane ("Saved checkpoint ckpt-1a2b3c4d", "Checkpointed step 2f4e6a8c")
// they mined training artefacts as commit shas, cost a commits-API call each
// and landed a false local_only_commit strike. Only the two git-shaped verbs
// remain; see ARTIFACT_LABEL_BEFORE_RE for the labelled-token exclusion.
const COMMIT_LOCAL_VERB_RE = /\b(?:banked|committed)\b/i;
// An HONEST local marker on the same line ("committed 3f2a1b9c — not pushed
// yet", "checkpointed 9b8c7d6e (local only)") already says what the strike
// would say: no commit_local claim is mined from that line.
const LOCAL_HONEST_RE = /\b(?:not (?:yet )?pushed|unpushed|local(?:ly)? only|not on origin|pending push)\b/i;
// An HONEST BLOCKED marker (ticket 0cea589d, 2026-10-12): a line that reports
// the push as REFUSED or the lane as blocked already says what the strike
// would say. Live incident (chat 837a636a ×4, 12:24–15:23Z): "Still blocked:
// GitHub write gate oq_6fbf2dc6 open … `git_push` → "No connected GitHub
// account/token"; … stays `in_progress` with banked commit `0bf7dda2d`" —
// the lane's receipts held reads + git_push ok:false (an honest blocked
// report), yet GUARD 1 mined commit_local off the genuinely-banked LOCAL sha.
// The platform's verbatim refusal string, push-failure phrasings, the
// write-gate class, and remains/stays blocked all suppress the branch (same
// posture as LOCAL_HONEST_RE: line-scoped, ride the A1 kill switch).
const PUSH_REFUSED_RE = /no connected github account\/token|\b(?:push (?:was )?(?:refused|failed|blocked|rejected)|cannot push|pushes? blocked|failed to push|push unavailable)\b|\bwrite gate\b|\b(?:still|remains?|stays?) blocked\b/i;
/** Origin-bearing sha claim kinds — the pair the local/origin receipt split governs. */
const isOriginShaKind = (kind: ClaimKind): boolean => kind === 'commit_pushed' || kind === 'commit_local';
// Structured receipt-mimicry fields (see the KEY:VALUE row rule in extractCompletionClaims).
const KV_MERGED_TRUE_RE = /\b(?:merged|is_merged)\s*[:=]\s*(?:true|yes|1)\b|\b(?:state|status)\s*[:=]\s*merged\b/i;
const KV_STATE_CLOSED_RE = /\b(?:state|status)\s*[:=]\s*closed\b/i;

/** All PR numbers named on ONE line (fresh regex per call — no lastIndex state). */
function prNumbersOnLine(line: string): number[] {
  const out: number[] = [];
  // "PR #224", "PR 224", "pull request 224", "pull/224" — and since 2026-09-08
  // the receipt-mimicry shapes the a8976e11 fabrications used: "PR520",
  // "F87_PR520: 520 | state: closed | merged: True" (glued digits, a leading
  // underscore label). The PR token must not be the tail of a longer word
  // ("GDPR520" stays out), hence the letter lookbehind instead of \b.
  for (const m of line.matchAll(/(?:(?<![A-Za-z])PR\s*[#_-]?\s*|pull request\s*#?|pulls?\/)(\d{1,6})\b/gi)) {
    out.push(parseInt(m[1], 10));
  }
  return out;
}

/**
 * A GitHub owner/repo path segment as written in prose: first char alnum, then
 * up to 99 chars of the GitHub-legal set. The charset EXCLUDES '/' so a match
 * can never inject extra path segments into the verification URL.
 */
const SLUG_PART_SRC = String.raw`[A-Za-z0-9][A-Za-z0-9._-]{0,99}`;

/**
 * Repo qualifications for PR numbers (tickets 630fadc0 / be8b6939): a session
 * whose work legitimately targets an EXTERNAL repo — the tt-rd workspace lane
 * watching tenstorrent/tt-metal PR #55747 — names that repo next to the
 * number. Verifying a qualified number against the SESSION repo 404s a REAL PR
 * into a false FABRICATED verdict (the deterministic false positive that
 * breaker-tripped session 17f71915: canada-quant/tt-rd has no PR #55747;
 * tenstorrent/tt-metal does). Three qualification shapes, each requiring the
 * owner/repo token ADJACENT to the number:
 *   https://github.com/<owner>/<repo>/pull(s)/<n>
 *   <owner>/<repo>#<n>
 *   <owner>/<repo> PR #<n>  |  <owner>/<repo> pull request (PR )?#?<n>
 * Scanned over the WHOLE final (a number qualified anywhere inherits that repo
 * for every claim on it — first qualification wins). A number with NO
 * qualification anywhere keeps the legacy session-repo lane.
 */
export function extractPrRepoQualifiers(
  text: string,
  /**
   * Cross-repo aliases (rollout watch 2026-09-14): repo NAME → slug, built by
   * the caller from the owner's projects' repoUrls. A note that says
   * "glm53 PR #16" (the spark lanes' sibling-repo idiom) resolves to the real
   * glm53 slug and is verified THERE — before this, the number was looked up
   * in the session repo (404 → "fabricated_pr"; a different PR with the same
   * number → "refuted_merge"): four false strikes on lane 98723a76 in 3 h.
   */
  aliases?: Map<string, { owner: string; repo: string }>,
): Map<number, { owner: string; repo: string }> {
  const out = new Map<number, { owner: string; repo: string }>();
  if (!text) return out;
  const note = (owner: string, repo: string, n: string) => {
    const num = parseInt(n, 10);
    if (!out.has(num)) out.set(num, { owner, repo });
  };
  for (const m of text.matchAll(new RegExp(String.raw`github\.com\/(${SLUG_PART_SRC})\/(${SLUG_PART_SRC})\/pulls?\/(\d{1,6})\b`, 'gi'))) {
    note(m[1], m[2], m[3]);
  }
  for (const m of text.matchAll(new RegExp(String.raw`(?<![\w/.-])(${SLUG_PART_SRC})\/(${SLUG_PART_SRC})#(\d{1,6})\b`, 'g'))) {
    note(m[1], m[2], m[3]);
  }
  for (const m of text.matchAll(new RegExp(String.raw`(?<![\w/.-])(${SLUG_PART_SRC})\/(${SLUG_PART_SRC})\s+(?:PR\s*[#_-]?\s*|pull request\s*#?\s*)(\d{1,6})\b`, 'gi'))) {
    note(m[1], m[2], m[3]);
  }
  if (aliases && aliases.size) {
    for (const [alias, num] of prRepoAliasMentions(text, aliases)) {
      const slug = aliases.get(alias.toLowerCase());
      if (slug) note(slug.owner, slug.repo, String(num));
    }
  }
  return out;
}

/** Words that precede "PR #N" in ordinary prose and are never a repo name. */
const PR_ALIAS_STOPWORDS = new Set([
  'a', 'an', 'the', 'this', 'that', 'these', 'those', 'its', 'our', 'my', 'your', 'their', 'his', 'her',
  'new', 'old', 'same', 'first', 'second', 'last', 'next', 'previous', 'prior', 'earlier', 'latest', 'final', 'draft', 'open', 'opened', 'closed', 'merged', 'merging', 'merge',
  'via', 'in', 'on', 'of', 'and', 'or', 'to', 'for', 'with', 'as', 'by', 'see', 'from', 'per', 'is', 'was', 'be', 'been', 'are', 'were', 'at', 'into', 'onto', 'than', 'then',
  'created', 'create', 'filed', 'pushed', 'landed', 'shipped', 'submitted', 'reviewed', 'approved', 'rebased', 'updated', 'reopened', 'stale', 'pending', 'upstream', 'origin', 'main', 'master',
  'sibling', 'repo', 'repository', 'branch', 'fix', 'feat', 'chore', 'docs', 'test', 'ci', 'wip',
]);

/**
 * `<alias> PR #N` / `<alias> pull request #N` / `PR #N (in|on|of) <alias>` /
 * `<alias>'s PR #N` / `<alias> repo … PR #N` (same clause). Yields the alias
 * token as written and the number. Slug-qualified forms (owner/repo#N, URLs)
 * are handled by extractPrRepoQualifiers itself and never reach here.
 */
// A repo-alias TOKEN: no trailing dot (so "CLOSED. PR #224" never yields
// "CLOSED."), letters/digits with inner . _ - only.
const REPO_ALIAS_TOKEN_SRC = String.raw`[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*`;

/**
 * Does a bare token look like a REPOSITORY name rather than prose? Known
 * aliases always do; otherwise it must carry a digit, hyphen, underscore or
 * dot ("glm53", "tt-rd", "tt-metal", "spark-cluster") and must not be an
 * ALL-CAPS prose word ("CLOSED", "DONE", "MERGED"). Under-broad is the
 * fail-safe direction: a missed alias falls back to the legacy session-repo
 * lane (unchanged behaviour), a false alias would hide a real fabrication.
 */
export function isPlausibleRepoAlias(token: string, aliases?: Map<string, { owner: string; repo: string }>): boolean {
  const a = token.toLowerCase();
  if (aliases?.has(a)) return true;
  if (PR_ALIAS_STOPWORDS.has(a) || !/[a-z]/i.test(token)) return false;
  if (token === token.toUpperCase()) return false; // ALL-CAPS prose word
  return /[0-9_.-]/.test(token);
}

export function prRepoAliasMentions(text: string, aliases?: Map<string, { owner: string; repo: string }>): Array<[string, number]> {
  const out: Array<[string, number]> = [];
  if (!text) return out;
  const seen = new Set<string>();
  const push = (alias: string, n: string) => {
    const a = alias.replace(/['’]s$/i, '');
    if (!a || a.includes('/') || !isPlausibleRepoAlias(a, aliases)) return;
    const key = `${a.toLowerCase()}|${n}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push([a, parseInt(n, 10)]);
  };
  // "<alias> PR #16", "<alias>'s PR #16", "<alias> pull request #16"
  for (const m of text.matchAll(new RegExp(String.raw`(?<![\w/.#-])(${REPO_ALIAS_TOKEN_SRC}(?:['’]s)?)\s+(?:repo(?:sitory)?\s+)?(?:PR\s*[#_-]?\s*|pull request\s*#?\s*)(\d{1,6})\b`, 'gi'))) {
    push(m[1], m[2]);
  }
  // "PR #16 in/on/of <alias>", "PR #16 in the <alias> repo"
  for (const m of text.matchAll(new RegExp(String.raw`(?:PR\s*[#_-]?\s*|pull request\s*#?\s*)(\d{1,6})\s+(?:in|on|of|from|against)\s+(?:the\s+)?(${REPO_ALIAS_TOKEN_SRC})(?:\s+repo(?:sitory)?)?\b`, 'gi'))) {
    push(m[2], m[1]);
  }
  return out;
}

/**
 * PR numbers whose claim names a repo we CANNOT resolve (an alias that is not
 * the session repo and not in the alias map). Such a claim is about a sibling
 * repository — verifying the number against the session repo would read a
 * different PR (or a 404) and convict an honest claim. The verifier treats
 * these as UNVERIFIED with a hint to write owner/repo#N.
 */
export function extractPrRepoHints(
  text: string,
  sessionRepoName?: string | null,
  aliases?: Map<string, { owner: string; repo: string }>,
): Map<number, string> {
  const out = new Map<number, string>();
  const session = (sessionRepoName ?? '').toLowerCase().replace(/\.git$/, '');
  for (const [alias, num] of prRepoAliasMentions(text, aliases)) {
    const a = alias.toLowerCase();
    if (session && (a === session || a === session.replace(/[-_]/g, ''))) continue; // the session repo itself
    if (aliases?.has(a)) continue; // resolved by extractPrRepoQualifiers
    if (!out.has(num)) out.set(num, alias);
  }
  return out;
}

/**
 * EVIDENCE-anchored repo bindings for PR numbers (ticket 6e157e86): a lane
 * monitoring an EXTERNAL repo it never names in an extractable shape — its
 * final says "PR #16 merged … == main head" about "glm53 main", never
 * "canada-quant/glm53-flash-w4a16-fp8-mtp#16" — leaves extractPrRepoQualifiers
 * EMPTY for the number, so it verified against the SESSION repo and a REAL
 * external PR 404'd into a false FABRICATED verdict (three flagged runs on
 * session 98723a76, 2026-09-14: "#16 fabricated; #2/#3 not merged" — all
 * merged=True on the monitored repo, 404/unmerged on the session's origin).
 * The run's OBSERVED TOOL OUTPUTS self-describe the repo the number was read
 * from — GitHub PR payloads carry
 *   "url":      "https://api.github.com/repos/<owner>/<repo>/pulls/<n>"
 *   "html_url": "https://github.com/<owner>/<repo>/pull/<n>"
 * and `gh pr view <n> --repo <o>/<r>` output names the same shapes. A number
 * the run's evidence read from repo X is verified against X — the guard's own
 * journal, not the session's origin, names the repo. Deliberate asymmetries:
 *   - TEXT qualifiers (extractPrRepoQualifiers) WIN on conflict: an explicit
 *     "… PR #n" naming repo Y is what the claim must be judged against, even
 *     when the run also read #n from X.
 *   - A number with NO binding keeps the legacy session-repo lane — an
 *     unobserved phantom still convicts against the session repo (the
 *     anti-phantom lane moves ONLY for numbers the run actually observed).
 *   - Shorthand outputs ("PR16 closed | merged True") name no repo and bind
 *     NOTHING — bindings come only from repo-bearing URL shapes.
 * Scanned over the run's tool-output haystack (parts' tool_result texts +
 * toolTexts + priorToolTexts); first binding per number wins.
 */
export function extractPrRepoEvidenceBindings(haystacks: string[]): Map<number, { owner: string; repo: string }> {
  const out = new Map<number, { owner: string; repo: string }>();
  const note = (owner: string, repo: string, n: string) => {
    const num = parseInt(n, 10);
    if (!out.has(num)) out.set(num, { owner, repo });
  };
  const apiRe = new RegExp(String.raw`api\.github\.com\/repos\/(${SLUG_PART_SRC})\/(${SLUG_PART_SRC})\/pulls\/(\d{1,6})\b`, 'gi');
  const htmlRe = new RegExp(String.raw`github\.com\/(${SLUG_PART_SRC})\/(${SLUG_PART_SRC})\/pull\/(\d{1,6})\b`, 'gi');
  for (const text of haystacks) {
    if (!text) continue;
    for (const m of text.matchAll(apiRe)) note(m[1], m[2], m[3]);
    for (const m of text.matchAll(htmlRe)) note(m[1], m[2], m[3]);
  }
  return out;
}

/**
 * Bare git-sha tokens in ONE clause: 7-40 hex chars containing BOTH a letter
 * and a digit — real sha prefixes virtually always carry both, and the guard
 * keeps hex-alphabet English words ("acceded") and plain numbers ("1234567")
 * out. Each occurrence is windowed-negation checked, so "1539fa86 was not
 * pushed; pushed 42f4a4a2" claims the second sha only.
 */
// A hex token labelled as a CONTENT hash ("doc md5 3a13ba98…", "sha256sum
// e01f828d…") is not a commit sha — without this an honest md5 citation in a
// "landed"/"pushed" clause became a commit_pushed claim that GitHub's commits
// API inevitably 404s (2026-09-08 audit, a8976e11 draft B line L3). Bare "sha"
// stays a commit reference ("merge sha 759e5ebf").
const HASH_LABEL_BEFORE_RE = /\b(?:md5|sha-?(?:1|224|256|384|512)|digest|checksum|blake2b?)(?:sums?)?\s*[:=(]?\s*$/i;
// A hex token labelled as a MESSAGE id ("(msg 1a2b3c4d…)", "message: …") is a
// relay citation, not a commit sha (finding A1, 2026-09-27: commit_local
// claims get no relay skip, so a cited msg id sharing the clause would
// otherwise face the commits API and 404 as "local only"). Same shape as
// RELAY_CITE_RE's label; rides the A1 kill switch with the rest.
const RELAY_LABEL_BEFORE_RE = /\b(?:msgs?|messages?)\s*[:#=]?\s*\(?\s*`?$/i;
// A hex token labelled as a TRAINING / RUN ARTEFACT ("ckpt-1a2b3c4d",
// "run-4c6e8a0b", "job 7b9d1e3f", "step 2f4e6a8c", "loss …") is not a commit
// sha (finding A1 review fix, 2026-09-27 — spark-cluster vocabulary: each such
// token faced the commits API and 404'd as "local only"). Same window as the
// hash-label rule; rides the A1 kill switch.
const ARTIFACT_LABEL_BEFORE_RE = /\b(?:ckpt|checkpoints?|runs?|jobs?|steps?|loss|epochs?|seeds?)\s*[-_:#=]?\s*$/i;
// A hex token labelled as a BOARD ID (ticket 0cea589d class, live 2026-10-11
// 06:13Z chat 6ef785c3: "progressNote is already banked current" beside
// todo-id 198ff490 — a board-id-shaped hex beside the ledger verb "banked"
// mined the TODO ID as a commit sha; the 06:13Z adjudication named this seam,
// and the f22 recurrence probe confirmed it unfixed) is never a commit sha.
// The board nouns name fleet objects (todo/task/goal/schedule/hook/chat/
// session/ticket/lane/row/worker/probe ids — the optional -id / id / Id
// suffix covers "todo-id 198ff490"); training-vocabulary labels (ckpt/run/
// job/step/loss/epoch/seed) stay in ARTIFACT_LABEL_BEFORE_RE. OQ-prefix ids
// are already immune (the '_' glue breaks the \b sha boundary) — this covers
// the bare 8-hex prefix form. Window and kill-switch posture match the family.
const BOARD_LABEL_BEFORE_RE = /\b(?:todos?|tasks?|goals?|schedules?|hooks?|chats?|sessions?|tickets?|lanes?|rows?|workers?|probes?)(?:[-_ ]?ids?)?\s*[-_:#=]?\s*$/i;
// A RECEIPT CITATION is never a sha (finding A1 review fix, 2026-09-27 — a
// pre-existing trap the "cite a git_push receipt" doctrine would have made
// live): the first uuid segment ("9c8b7a6d-1111-…") is an 8-hex token at a
// \b boundary, so "pushed <sha> (receipt <uuid>)" mined a PHANTOM second sha
// that 404'd into fabricatedShas — the citation the doctrine asks for
// convicted the line. A uuid-shaped token, and a token right after the word
// "receipt" (a prefix citation — RECEIPT_CITE_RE already promises those are
// inert), are skipped. Unconditional: no behaviour relies on a uuid head
// being a commit.
const UUID_HEAD_AT_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const RECEIPT_LABEL_BEFORE_RE = /\breceipts?(?:\s+ids?)?\s*[:#=]?\s*\(?\s*`?$/i;

function commitShasInClause(clause: string): string[] {
  const out: string[] = [];
  for (const m of clause.matchAll(/\b[0-9a-f]{7,40}\b/gi)) {
    const tok = m[0];
    if (!/[a-f]/i.test(tok) || !/\d/.test(tok)) continue;
    if (m.index !== undefined && UUID_HEAD_AT_RE.test(clause.slice(m.index, m.index + 36))) continue;
    if (m.index !== undefined && RECEIPT_LABEL_BEFORE_RE.test(clause.slice(Math.max(0, m.index - 20), m.index))) continue;
    if (m.index !== undefined && negatedBefore(clause, m.index)) continue;
    if (m.index !== undefined && HASH_LABEL_BEFORE_RE.test(clause.slice(Math.max(0, m.index - 24), m.index))) continue;
    if (m.index !== undefined && RELAY_LABEL_BEFORE_RE.test(clause.slice(Math.max(0, m.index - 16), m.index))) continue;
    if (m.index !== undefined && ARTIFACT_LABEL_BEFORE_RE.test(clause.slice(Math.max(0, m.index - 16), m.index))) continue;
    if (m.index !== undefined && BOARD_LABEL_BEFORE_RE.test(clause.slice(Math.max(0, m.index - 24), m.index))) continue;
    out.push(tok);
  }
  return out;
}

/**
 * Scan the final answer line-by-line for completion claims. Pure. pr_* and
 * commit_pushed claims associate each number/sha with a completion verb IN THE
 * SAME CLAUSE (strong boundaries: ; | • — and sentence ends) — so "did not
 * merge PR #224; merged PR #225 instead" claims #225 ONLY, and a plan-status
 * marker ("Plan 6/6 — CLOSED.") no longer tags a PR named in the next
 * sentence. Every verb/evidence match is windowed-negation checked per
 * occurrence: a cue in the ~40 chars before it (never past the clause start)
 * suppresses THAT occurrence only.
 */
export function extractCompletionClaims(text: string): CompletionClaim[] {
  const claims: CompletionClaim[] = [];
  if (!text) return claims;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const shasClaimed = new Set<string>(); // one commit_pushed claim per sha per line
    for (const clause of line.split(CLAUSE_SPLIT_RE)) {
      const prNumbers = prNumbersOnLine(clause);
      for (const prNumber of prNumbers) {
        // A number reported ABSENT in this clause ("PR #264 → HTTP 404
        // (free)") makes no claim here — a negative probe is honest evidence,
        // not a completion (ticket 78b13021).
        if (prReportedAbsent(clause, prNumber)) continue;
        if (verbClaimed(clause, MERGE_VERB_RE)) claims.push({ kind: 'pr_merged', prNumber, text: line });
        if (verbClaimed(clause, CREATE_VERB_RE)) claims.push({ kind: 'pr_created', prNumber, text: line });
        if (verbClaimed(clause, CLOSE_VERB_RE)) claims.push({ kind: 'pr_closed', prNumber, text: line });
      }
      // commit_pushed (ticket b8fa321a): a bare sha + a completed push verb in
      // the same clause — "commits 1539fa86/42f4a4a2 are live on origin/main".
      if (anyMatch(clause, COMMIT_PUSH_VERB_RE)) {
        for (const sha of commitShasInClause(clause)) {
          if (shasClaimed.has(sha)) continue;
          shasClaimed.add(sha);
          claims.push({ kind: 'commit_pushed', sha, text: line });
        }
      } else if (anyMatch(clause, COMMIT_LOCAL_VERB_RE) && !LOCAL_HONEST_RE.test(line) && !PUSH_REFUSED_RE.test(line)) {
        // commit_local (finding A1): "fully banked a65e79f4", "committed
        // 3f2a1b9c" — a sha whose only completion verb is commit-shaped. The
        // push-verb branch above wins for a clause carrying both ("committed
        // and pushed 3f2a1b9c" is ONE commit_pushed claim). Artefact-labelled
        // tokens ("job 7b9d1e3f") are excluded in commitShasInClause.
        for (const sha of commitShasInClause(clause)) {
          if (shasClaimed.has(sha)) continue;
          shasClaimed.add(sha);
          claims.push({ kind: 'commit_local', sha, text: line });
        }
      }
    }
    // Receipt-mimicry KEY:VALUE rows (2026-09-08, a8976e11 draft B):
    // "F87_PR520: 520 | state: closed | merged: True | merge_sha: 759e5ebf…" —
    // the '|' clause split keeps the PR number and the "merged" verb in
    // different clauses, so the clause pass above extracts nothing. A literal
    // `merged: true` (or `state: merged`) field on a line that names a PR is a
    // merge claim for every PR on that line; `state: closed` without it is a
    // close claim. `merged: false` / `state: open` claim nothing.
    if (KV_MERGED_TRUE_RE.test(line) || KV_STATE_CLOSED_RE.test(line)) {
      const kind: ClaimKind = KV_MERGED_TRUE_RE.test(line) ? 'pr_merged' : 'pr_closed';
      for (const prNumber of prNumbersOnLine(line)) {
        if (claims.some((c) => c.kind === kind && c.prNumber === prNumber && c.text === line)) continue;
        claims.push({ kind, prNumber, text: line });
      }
    }
    if (pairMatch(line, DEPLOY_RE, DEPLOY_OK_RE) || anyMatch(line, DEPLOY_ALT_RE)) {
      claims.push({ kind: 'deploy', text: line });
    }
    if (pairMatch(line, PROBE_RE, PROBE_EVIDENCE_RE)) {
      claims.push({ kind: 'probe', text: line });
    }
    if (pairMatch(line, BENCH_RE, BENCH_EVIDENCE_RE)) {
      claims.push({ kind: 'benchmark', text: line });
    }
  }
  return claims;
}

/**
 * Per-PR-number claimed kinds, taken from the pr_* CLAIMS themselves — each
 * claim already carries the number its CLAUSE associated with the verb, so a
 * number mentioned in a different (e.g. negated) clause inherits nothing.
 */
export function extractPrClaimKinds(text: string): Map<number, Set<ClaimKind>> {
  const out = new Map<number, Set<ClaimKind>>();
  for (const claim of extractCompletionClaims(text)) {
    if (claim.kind !== 'pr_merged' && claim.kind !== 'pr_created' && claim.kind !== 'pr_closed') continue;
    if (claim.prNumber === undefined) continue;
    let kinds = out.get(claim.prNumber);
    if (!kinds) {
      kinds = new Set();
      out.set(claim.prNumber, kinds);
    }
    kinds.add(claim.kind);
  }
  return out;
}

/**
 * Every PR number named anywhere in pr_* CLAIM LINES, deduped,
 * order-preserving, capped at MAX_VERIFY_PRS. Delegates to
 * extractPrClaimKinds (Map insertion order IS first-appearance order).
 */
export function extractPrNumbers(text: string): number[] {
  return Array.from(extractPrClaimKinds(text).keys()).slice(0, MAX_VERIFY_PRS);
}

// ── Layer 2: evidence cross-check ───────────────────────────────────────────

/**
 * Tools that gather NO external evidence: planning, searching the harness's
 * OWN memory/code index, and asking the user. Evidence for NOTHING.
 */
// NON_EVIDENCE_TOOLS now lives in ./evidence-tools (shared with the agent
// loop's zero-tool pre-final gate — the two gates must agree on what counts as
// an attempt at fresh evidence; owner transcript 2026-09-08).

/**
 * Subagent delegation: workers have the full tool surface, so a delegate
 * call is evidence for EVERY claim kind.
 */
// delegate_status returns a background worker's report (background-delegation.ts) — same evidence as the delegate it completes.
const DELEGATE_TOOLS = new Set(['delegate', 'delegate_parallel', 'delegate_status']);

/**
 * EXTERNAL-ACTION tools: the only calls that can change/observe the outside
 * world directly — shell (run_command), git ops (git_commit/git_push/
 * git_log/git_status/git_diff), PR creation AND merge, and the GitHub
 * integration tools. Required for pr_*, deploy, and commit_pushed claims.
 * F32 (2026-10-22): kept VERBATIM in sync with run-receipts.ts's twin —
 * merge_pull_request joins BOTH (a squash-merge receipt is a world-changing
 * action; this copy had drifted and lacked it, masked on the live
 * receipts-first path, biting on the legacy parts path). Any future member
 * added here must be added there in the same commit.
 */
const EXTERNAL_ACTION_TOOL_RE = /^(run_command|git_|open_pull_request|merge_pull_request|github_)/;

/** Local file reads — evidence for probe/benchmark claims (local tallies). */
const LOCAL_READ_TOOLS = new Set(['read_file', 'view_image', 'list_dir', 'glob', 'grep', 'ast_search']);

/** Web reads — also evidence for probe/benchmark claims. */
const WEB_READ_TOOLS = new Set(['search_engine', 'scrape_as_markdown', 'scrape_batch', 'web_pipe', 'youtube_pipe', 'browser_task']);

/**
 * Computer-use on the owner's own Mac (ticket 2ab33824): screenshots/types are
 * fresh EXTERNAL observations/actions — evidence for probe/benchmark claims on
 * the same footing as its sibling browser_task. Without it, a computer_task-ONLY
 * probe run (e.g. the cbaf3e08 E2E probe schedule's documented fallback —
 * "if the key file is missing, use computer_task-only verification") can never
 * honestly report its result: every probe claim convicted zero-evidence no
 * matter what the run actually observed (run 099f7d41, session 8e2617ca).
 */
const COMPUTER_USE_TOOLS = new Set(['computer_task']);

/**
 * PER-KIND evidence check: does parts hold a tool_call whose EVIDENCE TIER
 * satisfies this claim's kind? A resumed phantom that only re-read local
 * files (read_file) is evidenced for a benchmark tally but NOT for a
 * PR-merge claim — tiers keep it exposed.
 */
export function claimHasEvidence(claim: CompletionClaim, parts: MessagePart[]): boolean {
  const names: string[] = [];
  for (const p of parts) {
    if (p.type === 'tool_call' && typeof p.name === 'string' && !NON_EVIDENCE_TOOLS.has(p.name)) names.push(p.name);
  }
  if (!names.length) return false;
  if (names.some((n) => DELEGATE_TOOLS.has(n))) return true;
  switch (claim.kind) {
    case 'pr_merged':
    case 'pr_created':
    case 'pr_closed':
      return names.some((n) => EXTERNAL_ACTION_TOOL_RE.test(n));
    case 'deploy':
      // F32 (2026-10-22): the DEPLOY_ALT observation shape ("health check
      // 200", "prod green", "digby.ai healthy" — no deploy verb) is ALSO
      // evidenced by the deploy-health observation tools: get_fleet_telemetry
      // (deploy/health view — the deploy doctrine's own mandated verification
      // read, platform-tools.ts:6559) and the web health reads. DEPLOY-ONLY
      // by kind (review F1): pr_merged/pr_created/pr_closed NEVER widen — a
      // merge line with a health clause stays action-only ("Merged PR #1866;
      // prod green" must not ride a health read). A line carrying the deploy
      // verb stays action-only — it asserts the run PERFORMED the deploy.
      // Kill switch: EVIDENCE_GUARD_DEPLOY_OBSERVATION_DISABLED=1.
      return names.some((n) => EXTERNAL_ACTION_TOOL_RE.test(n)
        || (!deployObservationTierDisabled() && isDeployObservationClaimText(claim.text) && DEPLOY_HEALTH_OBSERVATION_TOOLS.has(n)));
    case 'commit_pushed':
    case 'commit_local':
      // Finding A1: a git_commit call is LOCAL — it never evidences that a
      // sha reached origin (git_push / run_command / github_* still do).
      return names.some((n) => EXTERNAL_ACTION_TOOL_RE.test(n) && !isLocalReceiptTool(n));
    case 'probe':
    case 'benchmark':
      // Ticket 212b3aa0: ∪ the read-only platform observation tools — a
      // fleet/platform-state probe is PROVEN by the platform's own reads
      // (get_chat_status, todo_get, list_schedules, …), the exact tools the
      // probe-first doctrine mandates; the action-only class made those
      // claims unprovable. CONTENT BOUNDARY (ticket 4df4bb41): a probe whose
      // line names REMOTE INFRA (box / tailnet / remote host) asserts an
      // observation fleet reads can never produce — the platform observation
      // tools do NOT evidence it. computer_task stays UNGUARDED: it drives
      // the owner's own Mac, where a box's terminal/dashboard may be on
      // screen (ticket 2ab33824).
      return names.some((n) => EXTERNAL_ACTION_TOOL_RE.test(n) || LOCAL_READ_TOOLS.has(n) || WEB_READ_TOOLS.has(n) || COMPUTER_USE_TOOLS.has(n)
        || (!(claim.text && INFRA_PROBE_SUBJECT_RE.test(claim.text)) && PLATFORM_OBSERVE_TOOLS.has(n)));
  }
}

/** The claims whose PER-KIND evidence is missing from parts (possibly some, not all). */
export function findUnprovenClaims(text: string, parts: MessagePart[]): CompletionClaim[] {
  return extractCompletionClaims(text).filter((c) => !claimHasEvidence(c, parts));
}

// ── Layer 2b: future-dated claim detection (ticket 8e814f45) ────────────────

/**
 * Phantom occurrences #21–#32 share ONE deterministic tell: the claimed
 * observation/merge timestamps are LATER than the run's real wall clock
 * ("probes at 19:55 UTC" from a turn that ended 19:49 UTC; a merge "at
 * 2026-08-22T18:23:33Z" claimed 13 minutes before that instant). A model can
 * imitate footers, shas and byte counts, but it cannot move the harness
 * clock — so a timestamp INSIDE a completion-claim line that parses to the
 * future is mechanical proof of confabulation.
 */
export interface FutureDatedClaim {
  /** The claim line the timestamp was lifted from (trimmed). */
  text: string;
  /** The raw timestamp token as written. */
  stamp: string;
  /** How far ahead of `now` the parsed stamp is (ms). */
  aheadMs: number;
}

/**
 * Skew allowance for honest clock drift / second-rounding (90s). Ticket
 * 80dd882d suggested widening to ±15 min; the incident replay gate pins WHY
 * it stays 90s: a8976e11 fabricated a probe +6m38s ahead and #307 fabricated
 * a merge stamp +13m33s ahead — small-ahead phantoms are a REAL evasion
 * class, and a blanket 15-min bar makes the #307 class completely invisible
 * (guards 1/2/4 exonerate there by design). The 80dd882d harm (real work
 * hidden behind full replacements) is relieved instead by warn-inline
 * delivery for timestamp-only verdicts (run-executor.ts) and the quoted-void
 * exemption; honest corroborated skew still clears via evidence-clock
 * calibration (28b9414d).
 */
const FUTURE_SKEW_MS = 90_000;
/**
 * Clock-only stamps (no explicit date) are interpreted on `now`'s date in the
 * claimed zone — but only flagged within this window. "23:50 PDT" claimed at
 * 00:30 PDT reads ~23.5h ahead under that interpretation and almost certainly
 * means YESTERDAY 23:50 — not flagged. Phantom leads are minutes (observed
 * 6–45 min), never hours.
 */
const FUTURE_CLOCK_ONLY_MAX_AHEAD_MS = 3 * 60 * 60 * 1000;

/** Hours BEHIND UTC for the zone tokens the lanes actually write. */
const TZ_OFFSET_HOURS: Record<string, number> = {
  Z: 0, UTC: 0, GMT: 0,
  PST: 8, PDT: 7, MST: 7, MDT: 6, CST: 6, CDT: 5, EST: 5, EDT: 4,
};

/**
 * Future-INTENT words scope the stamp that FOLLOWS them ("next probe at
 * 06:10Z"). Per-stamp windowed, NOT line-scoped (review M2): a line-level
 * skip lets "PR #253 merged at <future>; next probe 20:00Z will confirm"
 * smuggle a fabricated stamp past the guard by appending one intent word.
 * Suffix-tolerant (ticket da1dfa2f): a glued identifier suffix still reads
 * as the intent word itself — verbatim tool tokens like "ETA_UTC=07:15Z"
 * quote a PROJECTION the probe itself printed, but "_" is a word char so
 * the bare-word \b never fired and the stamp flagged as a phantom future
 * observation (run c8c7989c, a probe-cited digest ETA). Under /i the
 * suffix class is effectively case-insensitive too; that only mirrors the
 * intent words' own /i matching — the suppression window stays per-stamp,
 * the 48 chars immediately preceding the stamp (measured from the glued
 * token's END, so a long _SUFFIX token's intent word sits further back).
 *
 * Projection vocabulary (ticket 2884edba): projected/projection(s)/projecting,
 * forecast(s/ed/ing), estimate(s/ed/ing) and expect(s/ed/ing) are inherently
 * FORWARD-looking framings — "projected completion ≈ 18:55Z" asserts nothing
 * about the present, so its stamp is not an observation clock (tt-rd lane
 * a8976e11 run 16ecf6a3 struck "18:55Z (+103m ahead)" on exactly that honest,
 * inline-LABELED projection and blanket-un-verified the final). Bare
 * "project" is DELIBERATELY excluded: fleet status lines carry "project
 * <uuid>" near stamps, so the bare noun would let a fabricated merge stamp
 * inherit the exemption. Same per-stamp window and anti-smuggle reasoning as
 * the standing words — the completion-claim layers still scan the line.
 */
// `firing` is a forward-reference cue ("next firing at 17:29Z") ONLY when it is
// not a numbered run NAME: "Firing-87 summary (… 2026-09-08T11:41:33Z)" names
// the CURRENT run and its stamp is an observation claim (a8976e11 draft B's
// fabricated headline clock rode this exemption, 2026-09-08).
const INTENT_CUE_SRC = String.raw`(?:next|scheduled|will|would|expires?|expiring|deadline|eta|due|reminder|until|window|resume|fires?|firing(?![\s#_-]*\d)|projected|projections?|projecting|forecasts?(?:ed|ing)?|estimat(?:e|ed|es|ing)|expects?(?:ed|ing)?)(?:_(?!(?:CLOCK|TIME|TS)\b)[A-Z0-9]+)*`;
// Glued all-caps labels keep the cue ("NEXT_RUN_AT: 17:29Z" is a receipt
// field) — except a suffix naming an observation CLOCK/TIME/TS
// ("WINDOW_CLOCK:11:41:33Z", "FIRING_87_CLOCK:") which is a reading, not a
// forward reference (2026-09-08 audit).
const INTENT_BEFORE_STAMP_RE = new RegExp(String.raw`\b${INTENT_CUE_SRC}\b[^\n]{0,48}$`, 'i');
const INTENT_CUE_SCAN_RE = new RegExp(String.raw`\b${INTENT_CUE_SRC}\b`, 'gi');

/**
 * Is the stamp intent-scoped (a forward reference)? The cue must sit in the
 * 48 chars before it AND no completed-work verb may govern the stamp AFTER
 * the last cue (2026-09-08 audit): the monitor lane's LABEL vocabulary —
 * "Window discipline:", "Resume:", "Next, probed the box @ …" — used to exempt
 * an observation clock by mere presence ("Window discipline: PR #520 merged
 * at 11:41:33Z" flagged nothing). The override is backward-only and
 * cue-bounded, so an honest "the deploy landed at 11:00Z; next window at
 * 12:30Z" keeps its forward reference: the verb sits BEFORE the cue.
 */
function intentScopedStamp(prefix: string): boolean {
  if (!INTENT_BEFORE_STAMP_RE.test(prefix)) return false;
  INTENT_CUE_SCAN_RE.lastIndex = 0;
  let lastEnd = -1;
  let lastCue = '';
  let m: RegExpExecArray | null;
  while ((m = INTENT_CUE_SCAN_RE.exec(prefix))) { lastEnd = m.index + m[0].length; lastCue = m[0]; }
  // A MODAL/verb cue (will, would, expected, scheduled, projected…) governs
  // the verb after it — "will have been recorded at 01:04Z" is future perfect,
  // not completed work — so the override applies only to the LABEL/noun cues
  // the lane uses as section headers.
  if (!INTENT_LABEL_CUE_RE.test(lastCue)) return true;
  const tail = lastEnd >= 0 ? prefix.slice(lastEnd) : prefix;
  return !COMPLETED_WORK_BEFORE_STAMP_RE.test(tail);
}
const INTENT_LABEL_CUE_RE = /^(?:next|deadline|eta|due|reminder|until|window|resume|fires?|firing)(?:_[A-Z0-9]+)*$/i;

/**
 * Conditional-CLAUSE exemption (ticket c0f5a799): a stamp whose own clause is
 * explicitly hypothetical is a THRESHOLD the run set for the future, not an
 * observation it claims to have made. Real incident (run b536ad83, CanLegal
 * orchestrator, real clock 10:37Z): "if the lane is still 0/7 with a stale
 * heartbeat at ~11:00Z, the next firing steers it; unresponsive by ~11:15Z,
 * it's stood down" — the intent words FOLLOW the stamp (outside the 48-char
 * backward window above), so the guard struck "11:00Z (+23m ahead)" as a
 * fabricated observation and force-un-verified an honest final.
 *
 * Scoped per stamp and CLAUSE-BOUNDED (the M2 anti-smuggle constraint): the
 * conditional word must sit between the stamp and the nearest preceding
 * clause boundary (line start or ; . , : ! ?) with NO boundary in between —
 * a fabricated "PR merged at <future>; if the probe confirms…" never
 * inherits an "if" from a neighbouring clause. A future-dated stamp governed
 * by if/when/whenever/once/unless is definitionally hypothetical: no reader
 * takes "if still 0/7 at ~11:00Z" as a claim that 11:00Z already happened.
 * Reach is 96 chars — the incident clause spans 52 ("if the lane is still
 * 0/7 with a stale heartbeat at ~"); the backward intent window above stays
 * the first-line suppression for the common "next probe at …" shapes.
 */
const CONDITIONAL_BEFORE_STAMP_RE = /\b(?:if|when|whenever|once|unless)\b[^\n;.,:!?]{0,96}$/i;

/**
 * Estimate/deadline-governed stamp (operator iteration 11, 2026-09-25 —
 * VERBATIM twin of platform/action-verifier.ts ESTIMATE_BEFORE_STAMP_RE, the
 * keep-in-sync discipline): an approximation mark ("~", "≈") or a deadline/
 * estimate preposition (by, before, around, about, roughly, circa, toward(s),
 * no later than) DIRECTLY governing the clock is a forward ESTIMATE by
 * construction — nobody observes the world at an approximate time. The chat
 * lane's incidents: the Fleet Supervisor's sweep-table ETA cells "~6:20 PM
 * PDT — tt-rd speed verdict (automatic)" and "Verdict by ~11:45 AM PDT
 * (18:45Z)" struck as impossible observations. Anti-smuggle bounds: per-TOKEN;
 * a completed-work verb earlier on the line keeps convicting ("merged by
 * ~18:45Z"); the bare "at ~<clock>" frame is NOT an estimate frame; an
 * exempted token's same-instant zone gloss inherits via markExempt →
 * inheritsExemptGloss exactly like the intent-scoped exemption.
 */
const ESTIMATE_BEFORE_STAMP_RE = /(?:\b(?:by|before|around|about|roughly|circa|towards?|no later than|nlt|eta)\s+[~≈]?\s*|\b(?:paid|booked|reserved|covered|funded|prepaid|locked|held)\s+thr(?:ough|u)\s+[~≈]?\s*|(?<!\bat\s{0,3})\b(?:block|reservation|lease|coverage|hold|budget|quota|grant|contract|subscription|trial|blackout|cooldown|moratorium)s?\s+ends?(?:\s*date)?\s+(?:at\s+)?[~≈]?\s*|(?<!\bat\s{0,3})[~≈]\s*)$/i;
// Ticket 0e7684e0 (mishap, 2026-09-27 — VERBATIM twin of platform/
// action-verifier.ts, the keep-in-sync discipline): a SPAN-BOUNDARY NOUN +
// "end(s)" — "monitor waits for CanLaw SFT-2 launch or block end
// 2026-10-03T11:30Z" (prod strike 2da8766f 03:42:28Z) — names a reservation's
// END BOUNDARY in noun form, the same reservationEndsAt instant iteration 20
// cleared in verb form. SPAN-NOUN + "end" PAIR only, ADJACENCY-ONLY ("end" is
// never a line-level intent word); the iter20 BOUND and i12 ANTI-SMUGGLE
// pins ("… the end of the quarter <stamp>", "the block end handoff 11:30Z")
// keep convicting; no span noun is a completed-work verb.
// Iteration 21 (FO firing 31, 2026-09-27 — UNION with 0e7684e0 above, which
// landed mid-firing as 0c28eb77d/PR #1095 from the SAME prod strike
// 2da8766f 03:42:28.587Z; the FO lane's independent source-verification
// pulled the chat's own registered premise — goal acc90864: "PURCHASED
// cbe-067018e8…, block end 2026-10-03T11:30Z, value 13953.41" — and folds in
// two shapes the landed arm misses): (a) the INFORMAL span spelling "block
// paid thru <ISO>" (seen verbatim in that chat's state rows) — the
// span-subject pair accepts thr(ough|u); (b) "reservation end date <ISO>"
// (the premise row's own wording) — "end" accepts an optional "date"
// compound. Both keep the "at" lookbehind BEFORE the noun: "idles at block
// end <ISO>" still convicts on the noun arm.
// unchanged (estimate exemption unconditional since 2026-11-02).
// Iteration 20 (FO firing 29, 2026-09-26 — VERBATIM twin of platform/
// action-verifier.ts, the keep-in-sync discipline): a SPAN SUBJECT + "through"
// ("capacity block paid through 2026-10-03T11:30Z" — a present fact about a
// paid window's end, like "valid until") is a governor; bare "through" is NOT
// ("Observations through 15:03:42Z" is the 375c8618 fabrication class).
// Span-subject pair only, ADJACENCY-ONLY (phrase distance false-exempts
// across table-cell pipes — the iter13 pin); no span verb is a completed-work
// verb, so the near-backstop never convicts the honest shape. Prod strike
// c0e22e36 18:44:21Z, ENFORCED. Kill switch unchanged
// (estimate exemption unconditional since 2026-11-02).
// Iteration 12 (FO firing 24, 2026-09-25 — VERBATIM twin of platform/
// action-verifier.ts, the keep-in-sync discipline): a deadline governor at
// DISTANCE behind a bounded noun phrase + date — the prod strike convicted
// "hand both p5s before block end Sep 26 11:30Z" because the adjacency-only
// window sliced mid-word. Phrase span ≤60 chars, no clause boundary; the
// completed-work backstop on the full prefix still convicts; kill switch
// unchanged (estimate exemption unconditional since 2026-11-02).
// Iteration 14 (FO firing 22, 2026-09-25): "eta" joined the vocabulary (twin).
const ESTIMATE_BEFORE_PHRASE_RE = /\b(?:by|before|around|about|roughly|circa|towards?|no later than|nlt|eta)\b[^\n;:.]{0,60}(?<!\bat\s{0,3})[~≈]?\s*$/i;
// Iteration 20 bound (VERBATIM twin of platform/action-verifier.ts):
// "through" is ADJACENCY-ONLY — at phrase distance it false-exempts across
// table-cell pipes (the iter13 pin: "paid through tomorrow | capacity
// decision 12:08Z").
const ESTIMATE_COMPLETED_WORK_RE = /\b(?:merged|landed|completed|finished|done|banked|closed|verified|confirmed|observed|saw|seen|read|checked|delivered|posted|sent|fired|ran|passed|failed|shipped|deployed|recorded|logged|measured|probed|returned)\b/i;
// Iteration 14 range-END inheritance helpers (VERBATIM twin of platform/
// action-verifier.ts): the separator immediately before the end token, and
// the range-START token it skips back over (bare clock or number — a ZONED
// start never matches, so an unmarked range with zoned ends never inherits).
const RANGE_SEP_BEFORE_RE = /(?:[–—-]|\bto\b)\s*$/i;
// Iteration 16 (FO firing 27, 2026-09-26 — twin of platform/action-verifier.ts):
// a MERIDIEM range start ("~11:35 AM–12:05 PM PDT") ends in AM/PM, not digits —
// the digit-anchored token never matched, so the honest range end struck (prod
// strike c0e22e36 12:14:16Z, token "12:05 PM PDT"). Optional meridiem tail; the
// start must still be estimate-governed (exemptAt below).
const RANGE_START_TOKEN_RE = /(?:\d{1,2}:\d{2}|\d{1,4})(?:\s*[AaPp]\.?[Mm]\.?)?\s*$/;
/**
 * Iteration 15 (FO firing 23, 2026-09-25): the completed-work backstop's
 * REACH. A listed verb GOVERNS a stamp only within the SAME clause, ≤24 chars
 * before it (the SCHED_COMPLETED_WORK_GOVERNS_RE discipline). Dashes are
 * ALLOWED in the gap so "merged by ~18:00–19:00Z" still convicts; clause
 * breaks (; : . |) sever governance. The pre-15 LINE-scoped test convicted
 * honest estimates whose EARLIER, unrelated clauses carried receipt-backed
 * completed-work verbs (prod strike f5c2c1f4 20:50:06Z, ENFORCED note replaced).
 */
const ESTIMATE_COMPLETED_WORK_NEAR_RE = /\b(?:merged|landed|completed|finished|done|banked|closed|verified|confirmed|observed|saw|seen|read|checked|delivered|posted|sent|fired|ran|passed|failed|shipped|deployed|recorded|logged|measured|probed|returned)\b[^\n;.|,]{0,40}$/i;
// Iteration 16 (FO firing 27, 2026-09-26 — twin of platform/action-verifier.ts):
// a STATUS PREDICATE fused DIRECTLY to its own estimate marker is a forecast
// LABEL — "Training done ~8:30–9:00 AM PDT" (prod strikes c0e22e36 10:52:41Z /
// 11:18:46Z / 12:14:16Z). The verb there is the forecast's SUBJECT ("done ≈
// when"), not an observation tell; observation frames carry a CONNECTOR
// ("merged BY ~", "verified THROUGH ~"). The label masks the backstop ONLY
// for that fused shape; the pinned connector smuggles still convict. Kill
// exemption unconditional since 2026-11-02.
const ESTIMATE_ATTACHED_PREDICATE_RE = /\b(?:merged|landed|completed|finished|done|banked|closed|verified|confirmed|observed|saw|seen|read|checked|delivered|posted|sent|fired|ran|passed|failed|shipped|deployed|recorded|logged|measured|probed|returned)\b[ \t]{1,2}[~≈]/i;
export function estimateGovernedStamp(line: string, idx: number): boolean {
  const exemptAt = (end: number) =>
    ESTIMATE_BEFORE_STAMP_RE.test(line.slice(Math.max(0, end - 24), end)) ||
    // Iteration 12: the deadline governor at distance (governing a noun phrase
    // + date before the clock). Same completed-work backstop below.
    ESTIMATE_BEFORE_PHRASE_RE.test(line.slice(Math.max(0, end - 64), end));
  // Iteration 15 (FO firing 23, 2026-09-25 — prod strike f5c2c1f4 20:50:06Z,
  // token "22:10Z" +83 min, ENFORCED reject-back REPLACED an honest note):
  // the backstop was LINE-scoped — "report-up sent … capacity landed …
  // TRAIN_DONE re-anchored ≈21:55–22:10Z" struck the honest range END because
  // "sent"/"landed" sat in unrelated, receipt-backed clauses 60+ chars away.
  // A verb now governs only within the SAME clause, ≤24 chars before the
  // stamp (verbGovernStamp). Anti-smuggle intact: "merged by ~18:00–19:00Z"
  // (verb 11 chars before the end token) still convicts; per-TOKEN; kill
  // switch above unchanged.
  // Iteration 16 (FO firing 27): the backstop is masked ONLY for the fused
  // forecast-label subject ("Training done ~8:30–9:00 AM PDT").
  const labelSubject = ESTIMATE_ATTACHED_PREDICATE_RE.test(line);
    const verbGovernStamp = (end: number) =>
      ESTIMATE_COMPLETED_WORK_NEAR_RE.test(line.slice(Math.max(0, end - 56), end)) && !labelSubject;
  if (exemptAt(idx)) return !verbGovernStamp(idx);
  // Iteration 14 (FO firing 22, 2026-09-25 — VERBATIM twin of platform/
  // action-verifier.ts): a RANGE-END token inherits the range start's estimate
  // marker ("ETA ~19:00–19:40Z" — the marker governs the whole envelope). The
  // start must itself be governed; the completed-work backstop on the FULL
  // prefix still convicts; kill switch above.
  // Iteration 16 (FO firing 27): separator window 16 chars so a meridiem
  // range start ("11:35 AM" + en-dash ≈ 11) reaches the inheritance branch.
  const sep = RANGE_SEP_BEFORE_RE.exec(line.slice(Math.max(0, idx - 16), idx));
  if (sep) {
    const sepStart = Math.max(0, idx - 16) + sep.index;
    const tok = RANGE_START_TOKEN_RE.exec(line.slice(Math.max(0, sepStart - 24), sepStart));
    if (tok) {
      const tokStart = Math.max(0, sepStart - 24) + tok.index;
      if (exemptAt(tokStart)) return !verbGovernStamp(idx);
    }
  }
  return false;
}

// Iteration 13 (FO firing 25, 2026-09-25 — coding-lane twin of
// platform/action-verifier.ts, keep VERBATIM in sync): a forward clock that
// PARAPHRASES a real schedule's next firing time ("next tick 11:30Z", an ETA
// cell's "morning nudge 7:31 AM PDT") carries deterministic provenance when
// its instant matches an ENABLED coding_schedules.nextRunAt within ±60s —
// existence arithmetic, never an invented observation (prod strikes
// f5c2c1f4 10:26:33Z + c0e22e36 10:46:17Z/10:53:13Z, all post-iteration-12).
// Per-TOKEN; completed-work backstop on the full prefix still convicts. The
// instant set is INJECTED by the caller (the no-prisma discipline — the
// executor fetches); absent/empty → no exemption. Kill switch:
// Exemption unconditional since 2026-11-02 (kill switch retired).
const SCHEDULE_FIRING_MATCH_MS = 60_000;
// Iteration 13b (supervisor steer 12:19Z — the "After <EVENT>:" forward-plan
// shape, struck twice: 2da8766f 07:05:24Z and f5c2c1f4 10:26:33Z): a line
// LEADING with "After <event>:" is a forward plan, never an observation.
// Line-leading only; event label ≤48 chars, no clause boundary; ANTI-SMUGGLE:
// a completed-work verb anywhere on the line still convicts ("After the
// audit: verified 15:03Z"). VERBATIM twin of platform/action-verifier.ts.
const AFTER_EVENT_CUE_RE = /^(?:> ?|[-*+] |\d{1,9}[.)] )*after\s+[^;\n]{2,48}:\s/i;
export function afterEventCueLine(line: string): boolean {
  if (!AFTER_EVENT_CUE_RE.test(line)) return false;
  return !ESTIMATE_COMPLETED_WORK_RE.test(line);
}
// Connector-governed completed-work tell — VERBATIM twin of
// platform/action-verifier.ts (the two-lane discipline).
const SCHED_COMPLETED_WORK_GOVERNS_RE = /\b(?:merged|landed|completed|finished|done|banked|closed|verified|confirmed|observed|saw|seen|read|checked|delivered|posted|sent|fired|ran|passed|failed|shipped|deployed|recorded|logged|measured|probed|returned)\b[^\n;:.]{0,24}(?:\b(?:at|during|in|into|within)\s+|@\s*)(?:(?:the|this|that|a|an)\s+)?~?\s*$/i;
export function schedFiringGovernedStamp(line: string, idx: number, instantMs: number, schedTimes: number[]): boolean {
  if (!schedTimes.length) return false;
  if (!schedTimes.some((s) => Math.abs(instantMs - s) <= SCHEDULE_FIRING_MATCH_MS)) return false;
  // Completed-work backstop, CONNECTOR-GOVERNED (unlike the estimate lane's
  // full-prefix backstop): the ±60s instant-match against an ENABLED schedule
  // already proves the clock is a real armed firing time, so only a verb
  // DIRECTLY governing the clock through an at/@ connector refuses. A distant
  // narrative verb cannot block a proven firing time; its own claim still
  // faces the action/citation lanes.
  return !SCHED_COMPLETED_WORK_GOVERNS_RE.test(line.slice(Math.max(0, idx - 64), idx));
}

/**
 * Projection-HEADER lines (ticket 63e9a3cb): the fleet evidence discipline
 * mandates future-looking estimates live on a standalone "ETA (projection):"
 * line — but the per-stamp 48-char intent window above misses stamps sitting
 * further down a long line ("ETA (projection): …; cyan restage completes
 * ~02:45Z"), convicting HONEST projections as fabricated observation clocks
 * (Path C lane strikes "02:45Z (+42m)" and "23:20Z (+18m)", 2026-08-27/28 —
 * both on mandated ETA lines, both forcing blanket un-verify of otherwise
 * honest finals). A line OPENING with one of these headers is projection-
 * scoped for EVERY stamp on it. Anti-smuggle: a fabricated "observation" can
 * dodge THIS layer behind an ETA header, but the completion-claim layers
 * (unproven / zero-evidence / fabricated-PR) still scan the line — this
 * layer's job is only impossible observation CLOCKS.
 */
const PROJECTION_LINE_RE = /^(?:ETA|projection|forecast|estimate)\b/i;

/**
 * Schedule-SUBJECT exemption (ticket 2884edba) — INVERTED gate (ticket
 * f1afaa7b, 2026-08-31): a stamp that SUBJECT-labels a scheduled future
 * event — "The 18:05Z tick owns the fold → AIME26 launch sequence", "the
 * monitor collects it at the 6:04 PM PDT checkpoint" — is a forward
 * reference to the lane's own recurring schedule (whose stored nextRunAt IS
 * a real future instant the run legitimately navigates by), not a claim that
 * an observation already happened at that instant. Scoped per stamp and
 * tested against the text immediately FOLLOWING it (decoration-tolerant:
 * backtick/quote/whitespace glue from quote culture).
 *
 * The layer used to ENUMERATE the schedule nouns after the stamp
 * (tick/firing/window/cycle/round/handoff — ticket 2884edba, qualified by
 * scheduled/monitor/audit/checkpoint — then + checkpoint/collection —
 * tickets ca153ef8, 10ee7161). The vocabulary is OPEN: monitor lanes keep
 * inventing new scheduled-event nouns, and every omission shipped as a
 * fabrication strike on a clean answer (three same-family holes produced
 * this ticket). The gate is therefore INVERTED (the ticket's option (a)):
 * any subject-shaped phrase after the stamp exempts, and CONVICTION — not
 * the exemption — is what demands positive evidence of the phantom shape:
 *
 *   1. SHAPE gate (SCHEDULE_SUBJECT_SHAPE_RE): the text after the stamp must
 *      open like a subject noun phrase — a non-empty, letter-starting word
 *      that is NOT a closed-class function word (pronouns, coordinators,
 *      subordinators, prepositions — a CLOSED, stable English class, unlike
 *      the open noun vocabulary) — and must not be a LONE bare word at
 *      end-of-line without article governance (SCHEDULE_SUBJECT_LONE_WORD_RE
 *      + SCHEDULE_SUBJECT_AT_GOVERNED_RE, review F2): "probe tail 19:05Z
 *      clean" / "box probe 19:05Z red" are state fragments asserting RESULT
 *      STATE at the stamped instant, while "collection lands at the 01:04Z
 *      rollup" is article-governed ("at the …") and exempts. An empty
 *      after-text ("Tallies: … at 19:55:38 UTC"), punctuation ("…merged at
 *      <stamp>, sha …"), a parenthetical gloss, or a clause continuation
 *      ("…at ~11:00Z it is wedged", "…at <stamp> as logged", "…19:55:38Z
 *      and looked clean", "…06:29:51Z` vs `GH date: …", "…landed at <stamp>
 *      with sha …") is not a schedule subject — those stamps convict
 *      exactly as they did under the noun list.
 *   2. FORWARD verb gate (COMPLETED_WORK_AFTER_SUBJECT_RE — the standing
 *      adversarial-review #2 F1 constraint): the 48 chars after the stamp
 *      must carry no completed-work verb — "the 19:05Z audit cycle verified
 *      the tally, md5 …" subject-labels the stamp yet asserts COMPLETED
 *      work, and (review-verified) escapes every other layer (no PR number
 *      for GUARD 2, "verified" ∉ COMMIT_PUSH_VERB_RE, no probe/deploy
 *      vocabulary for the claim kinds). Present/future frames stay allowed
 *      ("owns", "should land", "begins", "collects"); honest trailing
 *      clauses are safe — the 2884edba incident line's own "todo and monitor
 *      state verified clean" sits ~70 chars past the stamp, beyond the
 *      gate's reach. The gate also keeps closed the parent commit's accepted
 *      residual (ticket 22efe001: "the 19:30Z tick merged PR #253").
 *   3. BACKWARD verb gate (COMPLETED_WORK_BEFORE_STAMP_RE): a completed-work
 *      verb governing the stamp through "at" inside its own clause —
 *      "squash-merged at <stamp>", "the merge landed at <stamp>", "the tally
 *      was recorded at <stamp>" — pins the work to a future instant (the
 *      phantom clock shape) and still convicts. CLAUSE-BOUNDED (the standing
 *      M2 anti-smuggle constraint) so an honest "… verified clean; the
 *      19:05Z checkpoint collects …" never inherits the neighbouring
 *      clause's verb.
 *
 * The completion-claim layers (unproven / zero-evidence / fabricated-PR)
 * still scan every exempted line — this layer's job is only impossible
 * observation CLOCKS. The inversion flips the residual failure direction:
 * an unlisted NOUN now defaults to no-strike (a miss the other layers can
 * still catch), never a strike on a clean answer — the direction that
 * matters now that convictions block the run at commit (PR #531).
 */
const SCHEDULE_SUBJECT_SHAPE_RE =
  /^[`'"\s]*(?!(?:it|its|this|that|these|those|they|them|he|him|she|her|we|us|i|me|and|but|or|nor|so|yet|as|if|then|when|whenever|while|because|since|although|though|unless|once|with|without|within|at|in|on|of|to|for|from|by|per|via|vs|into|onto|upon|over|under|against|towards?|through|during|before|after|until|till|despite|except|like|near|about|above|below|across|behind|beyond|inside|outside|around|along|between|amongst?|off|out|up|down)\b)[A-Za-z]/i;

/**
 * LONE-WORD rule (adversarial review F2, BLOCKING): a stamp followed by ONE
 * bare word at end-of-line ("probe tail 19:05Z clean", "box probe 19:05Z
 * red") is a state fragment asserting RESULT STATE at the stamped instant —
 * the phantom tally vocabulary — not a subject reference, which always has a
 * continuation ("the 01:04Z rollup owns the digest", "the <stamp> checkpoint.
 * Production …") or is preposition+article-GOVERNED ("collection lands at
 * the 01:04Z rollup", "results get logged during the 01:04Z window" —
 * SCHEDULE_SUBJECT_AT_GOVERNED_RE, at/during/in/into/within; round-7 B3:
 * an at-only class struck every aux-guarded honest frame that governed the
 * stamp through another preposition — and the backward gate widened to the
 * same class so the past-tense reading still convicts). The governance is
 * symmetric with the backward gate so neither half can drift. An earlier
 * draft blocked a state-ADJECTIVE list here instead (clean/green/healthy/…)
 * — that recreated the open-vocabulary hole asymmetrically ("red" exempted
 * while "green" convicted); the lone-word+article rule is structural and
 * symmetric. ACCEPTED RESIDUAL (round-7 B4, adjudicated): the PREDICATED
 * state reading ("the 19:05Z probe was green", "…looked/seemed clean")
 * exempts — no structural boundary separates it from honest schedule
 * metadata ("the 01:04Z rollup was rescheduled"), the -ed/-en participle
 * heuristic fails on the fleet's own state vocabulary ("wedged"), and an
 * adjective list is the open-vocabulary trap above. Sanctioned no-strike
 * direction; the completion-claim layers scan the line regardless.
 */
const SCHEDULE_SUBJECT_LONE_WORD_RE = /^[`'"\s]*[A-Za-z][A-Za-z-]*[.!?…,;:`'"—–\s-]*$/;
const SCHEDULE_SUBJECT_AT_GOVERNED_RE = /\b(?:at|during|in|into|within)\s+(?:the|this|that|a|an)\s+~?$/i;

/**
 * Completed-work verb vocabulary — ONE source for both gates so the two can
 * never drift (the ticket's option-(b) lesson applied to the verb side).
 * Past-tense only: present/future frames ("owns", "should land", "begins",
 * "collects") are the honest schedule-navigation shapes. "landed" joined the
 * list with the backward gate (ticket f1afaa7b): "the merge landed at
 * <stamp>" is the phantom shape; no honest forward frame writes a past-tense
 * "landed" inside the gates' reach. Adversarial review F3 widened the list
 * across the fleet's observed observation/completion verbs (saw/probed/
 * collected/revalidated/rechecked/deployed/promoted/captured/journaled/
 * posted/updated/logged/noted/flagged/polled/fetched/ran); round-6 (C1-C4)
 * added the observation-OUTPUT verbs returned/came/yielded — "probe at
 * <stamp> returned 511 lines" is the phantom output claim, while the honest
 * frames write a present tense ("comes back at") or an aux-guarded passive
 * ("are returned at") — with the noun
 * list gone these gates are the sole conviction path for subject phantoms.
 * The residual failure direction stays no-strike: an unlisted VERB exempts
 * (a miss the completion-claim layers can still catch), never a strike on a
 * clean answer.
 */
const COMPLETED_WORK_VERB_RE_SRC =
  '(?:verified|validated|merged|closed|completed|passed|failed|showed|tallied|confirmed|observed|detected|checked|fixed|shipped|published|launched|landed|folded|deleted|restarted|recorded|found|proved|measured|reported|returned|came|yielded|gave|saw|probed|collected|revalidated|rechecked|deployed|promoted|captured|journaled|posted|updated|logged|noted|flagged|polled|fetched|ran|fired|summarized|synthesized)';

/**
 * FORWARD gate (adversarial review F1, BLOCKING): a completed-work verb
 * inside the stamp's OWN CLAUSE after the stamp, up to 96 chars out. The
 * pre-inversion gate measured 48 chars from the end of the matched noun
 * phrase; the inversion's flat 48-from-stamp window let a LONG subject
 * phrase push the verb out of reach ("the 19:05Z scheduled monitor
 * checkpoint revalidated the arm and verified the tally" — verb at +53 —
 * escaped every layer). 96 chars restores the reach (48 past even a long
 * subject phrase), and the [;:!?] clause bound keeps the standing honest
 * pin exempt ("The 18:05Z tick owns the fold → … sequence; todo and monitor
 * state verified clean" — "verified" sits in the NEXT clause). A verb in a
 * following clause is out of reach by design — the completion-claim layers
 * scan the line regardless.
 */
const COMPLETED_WORK_AFTER_SUBJECT_RE = new RegExp(`\\b${COMPLETED_WORK_VERB_RE_SRC}\\b`, 'i');
/**
 * The forward window's clause bound is [.;!?] — NOT ':' (adversarial
 * review round-3 F1, BLOCKING): the fleet's mandated dual-zone gloss puts a
 * colon-clock in a parenthetical right after the subject ("the 19:05Z rollup
 * (12:05 PM PDT) verified the tally"), and a ':' bound truncated the window
 * at the gloss so the verb behind it escaped — and the gloss twin then
 * INHERITED the exemption. The standing sighting-3 honest pin keeps its
 * exemption without the ':' bound (no completed-work verb within 96 chars of
 * the stamp at all). '.' joined the bound in round-7 (post-merge review B1,
 * BLOCKING): a SENTENCE boundary is a clause boundary — the standing pin's
 * own period-joined variant ("The 18:05Z tick owns the fold → … sequence.
 * Todo and monitor state verified clean.") let the 96-char window cross the
 * full stop to "verified" and struck the honest line (OLD=0 → NEW=1).
 */
const COMPLETED_WORK_FORWARD_WINDOW_RE = /^(?:[^\n.;!?]|\.(?!\s+[A-Z"'(\[]|\s*$|$)){0,96}/;

/**
 * BACKWARD gate: a completed-work verb governing the stamp through "at" in
 * the stamp's own clause — "was recorded at <stamp>", "squash-merged at
 * <stamp>". The verb-to-"at" reach is 24 chars ("the tally was recorded
 * at"); the clause boundary class mirrors the conditional layer.
 *
 * Article-tolerant (adversarial review round-2 F1, BLOCKING): fleet prose
 * writes "at THE <stamp>" — anchoring "at" at the slice end let one
 * inserted article BOTH defeat this gate AND earn the lone-word rule's
 * article governance ("the tally was recorded at the 19:05Z rollup"
 * exempted OLD=1→NEW=0, no other layer coverage). The gate now absorbs an
 * optional the/this/that/a/an between "at" and the stamp.
 *
 * Auxiliary guard (same fix, honest direction): a listed participle can be
 * a FUTURE/ongoing passive instead of a completed-work claim — "results get
 * logged at the 01:04Z checkpoint", "will be verified at the 19:05Z
 * checkpoint" are honest forward frames the pre-inversion list exempted.
 * The lookbehind stack refuses the match when a non-past auxiliary
 * (will/would/shall/should/get/gets/be/is/are, the PRESENT-frame
 * is/are + being/getting, or a 's-contraction of those — ASCII or curly)
 * directly precedes the verb. "was/were" stay CONVICTING — a past passive
 * pinned to a future instant is exactly the phantom clock shape, INCLUDING
 * the past continuous (adversarial review round-4 F1, BLOCKING): bare
 * being/getting lookbehinds laundered "the arm was being folded at the
 * 01:04Z checkpoint" — one inserted word past the was/were conviction — so
 * the stack blocks only the PRESENT frames (is/are being, is/are getting);
 * was/were being/getting fall through and convict. Contractions (round-5
 * F2, BLOCKING): "'s being recorded" is one apostrophe from the pinned
 * "is being recorded" honest frame yet struck it, so 's/'s-forms join the
 * stack — including the bare "'s " (the is/has ambiguity resolves toward
 * no-strike: objectless "'s VERBed" reads as the present passive; the
 * active-perfect reading is the accepted residual). "been" was REMOVED from
 * the stack (adversarial review round-3 F2, BLOCKING): it laundered the
 * COMPLETED perfect — "the tally has been recorded at the 19:05Z rollup" /
 * "had been recorded …" exempted with zero other-layer coverage. The
 * future-perfects the stack exists for ("will have been recorded at the
 * <stamp>") never reach this gate — "will"/"would"/"should" are standing
 * INTENT-layer words, so those stamps exempt earlier.
 *
 * Comma-tolerant span (adversarial review round-5 F1, BLOCKING): the span
 * class excludes sentence/clause boundaries [;.:!?] but NOT commas — a
 * comma between verb and "at" ("the tally was recorded, at the 19:05Z
 * rollup", "…recorded, as expected, at the …") is intra-clause, yet it
 * silenced the gate while the text still ended "at the " — laundering the
 * canonical phantom clock AND earning the lone-word rule's governance.
 *
 * The 24-char reach is bounded AND coordinator-safe (round-7 B2, BLOCKING):
 * the span is a TEMPERED class that refuses to cross and/but/or/nor — the
 * round-6 C5 "honest compound" pin ("…recorded yesterday and the rollup
 * lands at <stamp>") survived by a LENGTH accident (32-char connector); the
 * same compound with a 22-char connector ("…recorded and the rollup lands
 * at <stamp>") false-convicted OLD=0 → NEW=1. Compound VERBS sharing the
 * stamp still convict via the last verb before the preposition ("…recorded
 * and logged at <stamp>"). A LONG aside between verb and preposition
 * ("…recorded, per the nightly operational runbook, at the <stamp>")
 * exempts BY DESIGN — the sanctioned no-strike direction; conviction-
 * tightening must never trade a miss for a strike on a clean answer now
 * that convictions block the run at commit.
 *
 * Preposition class (round-7 B3, BLOCKING): the gate fires on
 * at/during/in/into/within — the lone-word rule's governance widened to the
 * same class for honest frames ("results get logged during the 01:04Z
 * window"), and this gate widens WITH it so the past-tense phantom reading
 * ("the tally was recorded during the 19:05Z window") still convicts; the
 * aux-lookbehind stack protects the honest passives on both.
 */
const COMPLETED_WORK_BEFORE_STAMP_RE = new RegExp(
  `\\b(?<!\\bwill )(?<!\\bwould )(?<!\\bshall )(?<!\\bshould )(?<!\\bget )(?<!\\bgets )(?<!\\bbe )(?<!\\bis )(?<!\\bare )(?<!\\bis being )(?<!\\bare being )(?<!\\bis getting )(?<!\\bare getting )(?<!\\b's )(?<!\\b's being )(?<!\\b's getting )(?<!\\b’s )(?<!\\b’s being )(?<!\\b’s getting )${COMPLETED_WORK_VERB_RE_SRC}\\b(?:(?!\\b(?:and|but|or|nor)\\b(?=\\s+(?:(?:the|this|that|a|an)\\s+)?(?!(?:the|this|that|a|an|at|during|in|into|within)\\b)[A-Za-z][A-Za-z-]*\\s+(?!(?:at|during|in|into|within)\\b)[A-Za-z][A-Za-z-]*\\b))[^\\n;.:!?]){0,24}(?:\\b(?:at|during|in|into|within)\\s+|@\\s*)(?:(?:the|this|that|a|an)\\s+)?~?$`,
  'i',
);

/**
 * Tool-provenance exemption (ticket e409e51e): a future stamp whose time core
 * — ISO date + "HH:MM", else clock "HH:MM" — appears VERBATIM in the run's
 * real tool results (the evidenceHaystacks already plumbed into
 * findFutureDatedClaims: a schedule receipt's next-fire field, an ETA line) is
 * a CITATION of that datum, not a confabulated observation clock. Complements
 * the whole-line honest-quote exemption below: monitor lanes write their own
 * PROSE around a receipt-sourced firing time ("monitor re-armed for collection
 * at 20:05Z", flagged +33m on 2026-08-28 even though that run's
 * update_schedule receipt carried next-fire 20:05:51Z) — the line is not
 * verbatim in the result even though the stamp is. Anti-smuggle: the
 * exemption covers ONLY the stamp tell — any completion CLAIM on the same
 * line still faces the zero-evidence / fabricated-PR extractors — and the
 * observed phantom corpus wrote clocks with NO tool provenance (the
 * a8976e11/#307 incident pins carry no matching haystack times and keep
 * convicting). Clock-context tightening (adversarial review probes P3/P5):
 * the haystack must carry the time as a real CLOCK READING — an ISO
 * date+time prefix, or HH:MM[:SS][.fff] IMMEDIATELY followed by a zone
 * (the zone is mandatory; bare trailing seconds do NOT qualify) — so a
 * "20:05" mm:ss DURATION in output never vouches for a "20:05Z"
 * observation clock. A stamp carrying an explicit DATE (ISO or human-form
 * month-day) additionally requires that date in evidence, so a duration
 * can never launder an explicit-future-date phantom. Accepted residuals
 * (merge review, pinned in tests): date and time are matched
 * INDEPENDENTLY across haystacks (a split clock-in-one-result +
 * date-in-another pair can vouch for an ISO phantom — strictly narrower
 * than the P4 clock-only residual, which needs no date at all);
 * human-form matching is month-day only (year not required); a cross-day
 * log line with a coincidental HH:MM can exempt a clock-only stamp (P4);
 * AM/PM honest citations of 24h receipts still flag (P9).
 */
/** Clock-reading contexts in a haystack: ISO date+time, or HH:MM[:SS][.fff]
 * immediately followed by a zone. A bare "20:05" (mm:ss duration) matches
 * neither. Leading (?<!\d) blocks substring hits inside longer numbers. */
function haystackHasClockContext(h: string, timeKey: string): boolean {
  const esc = timeKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    `(?<!\\d)(?:\\d{4}-\\d{2}-\\d{2}[T ]${esc}|${esc}(?::\\d{2})?(?:\\.\\d+)?\\s*(?:Z|UTC|GMT|[AP]M\\b|[PCEM][SD]T\\b))`,
    'i',
  ).test(h);
}

/** Clock readings whose INSTANT can be computed from a haystack (ticket
 * 9ed46ffe): ISO date+times (zone defaulting to Z, matching parseIsoStamp)
 * and 24h HH:MM[:SS][.fff] readings tagged Z/UTC/GMT — the forms receipts
 * and log lines actually print. Bare unzoned HH:MM stays un-parsed (the P3
 * duration rule: a "20:05" mm:ss duration never vouches for a clock). */
const HAYSTACK_ISO_INSTANT_RE = /\b(\d{4}-\d{2}-\d{2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?\s*(Z|UTC|GMT|[+-]\d{2}:?\d{2})?/g;
const HAYSTACK_CLOCK_INSTANT_RE = /(?<!\d)(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?\s*(?:Z|UTC|GMT)\b/gi;

/**
 * Slack permalink epochs (ticket 71a270d2, 2026-09-24): slack_search — the
 * only surface that reaches DM/MPIM content (channel history cannot list DMs)
 * — renders NO clock text at all; each hit's permalink embeds the message
 * instant as /p<seconds+micros, dot stripped> (16 digits:
 * p1790195999249539 = 2026-09-23T20:39:59.249Z). The incident: the daily
 * Slack-digest machine wake (chat 1ea4621f, run clock 2026-09-24T15:21:04Z)
 * cited a REAL yesterday DM datelessly — "(1:40 PM PDT / 20:40Z)" for that
 * very permalink — so the provenance reader above saw nothing it could match
 * (no clock text, and the µs epoch is not an ISO/Z reading), the
 * nearest-candidate rule resolved the dateless token to TODAY 20:40Z
 * (+319 min, "impossible"), and the whole owner-requested digest was
 * REPLACED pre-delivery. Channel-sourced lines survived ("20:09:00 UTC" in
 * history output vouches via the clock leg) — only the search/permalink
 * surface was blind. The /p prefix keeps this unambiguous (a Slack permalink
 * IS a timestamp by construction; a bare 16-digit run could be an id —
 * pinned in tests). thread_ts query params carry the dotted seconds form and
 * never match. (Verbatim copy of action-verifier.ts — keep in sync.)
 */
const HAYSTACK_PERMALINK_EPOCH_RE = /\/p(\d{16})(?!\d)/g;
/**
 * Time-of-day tolerance for the permalink-epoch leg: the incident's own
 * citations round to the minute (20:39:59→"20:40", 1s; 21:15:29→"21:15",
 * 29s), so 120s absorbs minute-rounding with 4x margin while staying inside
 * "the clock matches a real tool-observed instant" — a fabricated clock must
 * land within 2 minutes of an instant the run's own tool output actually
 * carried to launder through this leg, and every other claim on the line
 * still faces the action/citation lanes (the standing exemption scope).
 */
const EPOCH_TIME_OF_DAY_TOLERANCE_MS = 120_000;

/**
 * Does a haystack carry the stamp's INSTANT in a different clock format?
 * ("4:07 PM PDT" citing a schedule receipt's nextRunAt "…T23:07:42.195Z" —
 * the verbatim timeKey check keys on "4:07" and sees nothing, the P9
 * residual.) ISO readings compare minute-floored instants (date included);
 * clock-only readings compare UTC HH:MM (date-independent — the same
 * semantics as the verbatim clock-context path, P4 accepted residual);
 * Slack permalink epochs compare UTC time-of-day ±120s (date-independent,
 * ticket 71a270d2 — see HAYSTACK_PERMALINK_EPOCH_RE).
 */
function haystackHasInstant(h: string, instantMs: number): boolean {
  const wantMinute = Math.floor(instantMs / 60_000);
  const wantClock = new Date(instantMs).toISOString().slice(11, 16); // "HH:MM" UTC
  HAYSTACK_ISO_INSTANT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = HAYSTACK_ISO_INSTANT_RE.exec(h))) {
    const t = parseIsoStamp(m[1], m[2], m[3], m[4], m[5]);
    if (t !== null && Math.floor(t / 60_000) === wantMinute) return true;
  }
  HAYSTACK_CLOCK_INSTANT_RE.lastIndex = 0;
  while ((m = HAYSTACK_CLOCK_INSTANT_RE.exec(h))) {
    if (parseInt(m[1], 10) > 23 || parseInt(m[2], 10) > 59) continue;
    if (`${m[1].padStart(2, '0')}:${m[2]}` === wantClock) return true;
  }
  // Slack permalink-epoch leg (ticket 71a270d2): a search result's /p<16-digit
  // µs epoch> IS a clock reading this run's tool output carried — encoded.
  // Decode and compare time-of-day date-INDEPENDENTLY (the clock-only stamp
  // asserts no day; the same P4 semantics as the clock leg above), within
  // EPOCH_TIME_OF_DAY_TOLERANCE_MS for the incident's observed minute-
  // rounding (20:39:59.249Z cited as "20:40Z"; 21:15:29.075Z as "21:15Z").
  // Widened residual (accepted, same P4 class): a digest run's many search
  // permalinks raise the odds a fabricated dateless clock coincides with a
  // real observed time-of-day — the exemption still covers ONLY the
  // impossible-observation tell (every claim on the line keeps facing the
  // action/citation lanes), and over-exemption is the fail-safe direction
  // for this detector.
  HAYSTACK_PERMALINK_EPOCH_RE.lastIndex = 0;
  const wantTodMs = ((instantMs % 86_400_000) + 86_400_000) % 86_400_000;
  while ((m = HAYSTACK_PERMALINK_EPOCH_RE.exec(h))) {
    const epochMs = Number(m[1]) / 1000; // µs → ms (16 digits stay < 2^53)
    const todMs = ((epochMs % 86_400_000) + 86_400_000) % 86_400_000;
    const deltaMs = Math.abs(todMs - wantTodMs);
    if (Math.min(deltaMs, 86_400_000 - deltaMs) <= EPOCH_TIME_OF_DAY_TOLERANCE_MS) return true;
  }
  return false;
}

function stampHasToolProvenance(stamp: string, evidence: string[], instantMs?: number): boolean {
  if (!evidence.length) return false;
  const timeKey = /(\d{1,2}:\d{2})/.exec(stamp)?.[1];
  let hasClock = timeKey ? evidence.some((h) => haystackHasClockContext(h, timeKey)) : false;
  if (!hasClock && instantMs !== undefined) {
    // P9 closed (ticket 9ed46ffe): the stamp quotes a receipt instant in a
    // DIFFERENT clock format ("4:07 PM PDT" citing nextRunAt "…T23:07:42.195Z")
    // — compare minute-floored instants instead of verbatim strings. Every
    // stamp the passes parse reaches here with an instant (zoned clocks;
    // zone-less ISO stamps default Z in parseIsoStamp — same UTC reading the
    // guard convicts them by, so the fallback is format normalization, not a
    // zone assumption); a bare "4:07" with no zone still cannot borrow the
    // receipt's 23:07.
    hasClock = evidence.some((h) => haystackHasInstant(h, instantMs));
  }
  if (!hasClock) return false;
  const isoDate = /(\d{4}-\d{2}-\d{2})/.exec(stamp)?.[1];
  if (isoDate) return evidence.some((h) => h.includes(isoDate));
  // Human-form explicit date ("Aug 29 …", "August 29, 2026 …", "Aug-29"): the
  // stamp ASSERTS a date — evidence must carry that month-day literally too,
  // or a bare duration would vouch for an explicit-future-date phantom (probe
  // P5). Separator is space OR dash: the trailing-pin compound pass (ticket
  // 85f8d318) puts dash-form dates into stamps for the first time, and they
  // assert a day exactly like the space form.
  const human = /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)[\s-](\d{1,2})/i.exec(stamp);
  if (human) {
    const litRe = new RegExp(`${human[1]}[\\s-]${human[2]}(?:st|nd|rd|th)?\\b`, 'i');
    return evidence.some((h) => litRe.test(h));
  }
  return true;
}

// Explicit-date ISO-8601: "2026-08-22T18:23:33Z", "2026-08-22 14:11:29 UTC".
// Seconds OPTIONAL (review M1): without that, "2026-08-21 18:23 UTC" fell
// through to the clock pass and got re-dated to TODAY — a false positive on
// an honest yesterday reference.
// (?:\b|(?<=_)): a label-glued stamp ("F87_CLOCK_2026-09-08T11:22:20Z") has no
// word boundary between '_' and the digit — it was invisible to the scan
// (2026-09-08 audit).
const ISO_STAMP_RE = /(?:\b|(?<=_))(\d{4}-\d{2}-\d{2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?\s*(Z|UTC|GMT|[+-]\d{2}:?\d{2})?/g;
// Clock-only with an explicit zone: "12:26:59 AM PDT", "1:39:24 PM PDT", "05:49Z", "19:55:38 UTC".
const CLOCK_STAMP_RE = /(?:\b|(?<=_))(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?\s*(Z|UTC|GMT|P[SD]T|M[SD]T|C[SD]T|E[SD]T)\b/gi;
// Human-form date + clock: "Aug 22 18:37:41Z", "August 22, 2026 11:37:41 AM
// PDT", "Aug 14 9:41 AM PDT" (ticket 78b13021 case 1 — verbatim watchdog-log
// quotes restated on claim lines). The guard's ISO-only date parsing used to
// miss these, so the CLOCK pass re-dated the time portion to TODAY and a
// yesterday-dated log line flagged as hours-ahead.
const HUMAN_DATE_STAMP_RE = /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?,?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?\s*(Z|UTC|GMT|P[SD]T|M[SD]T|C[SD]T|E[SD]T)\b/gi;
// Clock + zone + a TRAILING explicit ISO date, time-first order ("10:55 AM PDT
// 2026-08-24" — ticket 3611ab4a). Neither ISO_STAMP_RE (date-first) nor
// HUMAN_DATE_STAMP_RE (month-name-first) matches this shape, so the clock
// pass used to re-date the time portion to TODAY and a standing yesterday
// reference flagged whenever the delta fell inside the 3h clock-only window.
const CLOCK_ISO_DATE_COMPOUND_RE = /\b(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?\s*(Z|UTC|GMT|P[SD]T|M[SD]T|C[SD]T|E[SD]T)\s+(\d{4})-(\d{2})-(\d{2})\b/gi;
// Clock + zone + a TRAILING HUMAN date pin, time-first order ("10:23:17Z
// Aug-29", "17:01Z on Aug-27" — ticket 85f8d318, the coding-lane parity port
// of chat-lane PR #515/9ed1bf8e, which struck on exactly this postposed-pin
// shape in prod: a truthful 24h-old citation flagged as +6m because only
// LEADING pins governed a clock token's day). Neither HUMAN_DATE_STAMP_RE
// (month-name-first) nor CLOCK_ISO_DATE_COMPOUND_RE (trailing ISO) matches
// this shape, so the bare-clock pass re-dated the time portion to TODAY.
// The connector gap mirrors the chat lane's TRAILING_DATE_GAP_RE — short,
// digit-free, symbol-only plus "on" (never "at/around/about/by": those
// introduce TIMES, not dates). Month-day separator is space or dash (chat
// lane's LINE_DATE_RE parity); the year is optional (year-less keeps the
// clock-only 3h flag window, same as the leading human pass).
const CLOCK_HUMAN_DATE_COMPOUND_RE = /\b(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?\s*(Z|UTC|GMT|P[SD]T|M[SD]T|C[SD]T|E[SD]T)\b[\s,;:()~-]{1,4}(?:on\s{1,2})?(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)[\s-](\d{1,2})(?:st|nd|rd|th)?\b(?:,?\s+(\d{4}))?/gi;

const MONTH_INDEX: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
  sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

function parseIsoStamp(date: string, hh: string, mm: string, ss: string | undefined, zone?: string): number | null {
  let suffix = zone ?? 'Z';
  if (suffix === 'UTC' || suffix === 'GMT') suffix = 'Z';
  if (/^[+-]\d{4}$/.test(suffix)) suffix = `${suffix.slice(0, 3)}:${suffix.slice(3)}`;
  const t = Date.parse(`${date}T${hh.padStart(2, '0')}:${mm}:${ss ?? '00'}${suffix}`);
  return Number.isNaN(t) ? null : t;
}

function parseClockStamp(hRaw: string, mRaw: string, sRaw: string | undefined, ampm: string | undefined, zoneRaw: string, now: Date): number | null {
  let hh = parseInt(hRaw, 10);
  const mm = parseInt(mRaw, 10);
  const ss = sRaw ? parseInt(sRaw, 10) : 0;
  const ap = ampm?.toUpperCase();
  const zone = zoneRaw.toUpperCase();
  if (ap === 'PM' && hh < 12) hh += 12;
  if (ap === 'AM' && hh === 12) hh = 0;
  if (hh > 23 || mm > 59 || ss > 59) return null;
  const offsetH = TZ_OFFSET_HOURS[zone];
  if (offsetH === undefined) return null;
  // "Today" in the claimed zone: shift now by the zone offset, read the date.
  const datePart = new Date(now.getTime() - offsetH * 3_600_000).toISOString().slice(0, 10);
  const wallAsUtc = Date.parse(`${datePart}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}Z`);
  if (Number.isNaN(wallAsUtc)) return null;
  return wallAsUtc + offsetH * 3_600_000;
}

/**
 * A human-form dated stamp ("Aug 22 18:37:41Z", "August 22, 2026 11:37 AM
 * PDT") resolves to a REAL instant — never re-dated to today. A missing year
 * defaults to now's year (in the claimed zone); the flag window then stays
 * the clock-only 3h one, so a year-less "Dec 31 …" honest reference on Jan 1
 * is not flagged as a year-ahead phantom. Strict calendar validation: the
 * parsed components must round-trip (no Feb-31 rollovers).
 */
function parseHumanDateStamp(
  monRaw: string, dRaw: string, yRaw: string | undefined,
  hRaw: string, mRaw: string, sRaw: string | undefined,
  ampm: string | undefined, zoneRaw: string, now: Date,
): { t: number; yearExplicit: boolean } | null {
  const month = MONTH_INDEX[monRaw.toLowerCase()];
  const day = parseInt(dRaw, 10);
  let hh = parseInt(hRaw, 10);
  const mm = parseInt(mRaw, 10);
  const ss = sRaw ? parseInt(sRaw, 10) : 0;
  const ap = ampm?.toUpperCase();
  const zone = zoneRaw.toUpperCase();
  if (ap === 'PM' && hh < 12) hh += 12;
  if (ap === 'AM' && hh === 12) hh = 0;
  if (!month || day < 1 || day > 31 || hh > 23 || mm > 59 || ss > 59) return null;
  const offsetH = TZ_OFFSET_HOURS[zone];
  if (offsetH === undefined) return null;
  const yearExplicit = yRaw !== undefined;
  const year = yearExplicit ? parseInt(yRaw, 10) : parseInt(new Date(now.getTime() - offsetH * 3_600_000).toISOString().slice(0, 4), 10);
  const datePart = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const wallAsUtc = Date.parse(`${datePart}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}Z`);
  if (Number.isNaN(wallAsUtc)) return null;
  if (new Date(wallAsUtc).toISOString().slice(0, 10) !== datePart) return null; // e.g. Feb 31 rolled over
  return { t: wallAsUtc + offsetH * 3_600_000, yearExplicit };
}

/**
 * A clock+zone stamp carrying an EXPLICIT trailing ISO date ("10:55 AM PDT
 * 2026-08-24") resolves to a REAL instant — the date is authoritative, the
 * time is never re-dated to today (ticket 3611ab4a). Same arithmetic and
 * guards as parseHumanDateStamp, with the date always explicit: strict
 * calendar round-trip validation (no 2026-02-31 rollovers), AM/PM
 * normalization, hh/mm/ss range guards, zone from TZ_OFFSET_HOURS.
 */
function parseClockIsoDateCompound(
  hRaw: string, mRaw: string, sRaw: string | undefined,
  ampm: string | undefined, zoneRaw: string,
  yRaw: string, moRaw: string, dRaw: string,
): number | null {
  let hh = parseInt(hRaw, 10);
  const mm = parseInt(mRaw, 10);
  const ss = sRaw ? parseInt(sRaw, 10) : 0;
  const ap = ampm?.toUpperCase();
  const zone = zoneRaw.toUpperCase();
  if (ap === 'PM' && hh < 12) hh += 12;
  if (ap === 'AM' && hh === 12) hh = 0;
  if (hh > 23 || mm > 59 || ss > 59) return null;
  const offsetH = TZ_OFFSET_HOURS[zone];
  if (offsetH === undefined) return null;
  const datePart = `${yRaw}-${moRaw}-${dRaw}`;
  const wallAsUtc = Date.parse(`${datePart}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}Z`);
  if (Number.isNaN(wallAsUtc)) return null;
  if (new Date(wallAsUtc).toISOString().slice(0, 10) !== datePart) return null; // e.g. 2026-02-31 rolled over
  return wallAsUtc + offsetH * 3_600_000;
}

/**
 * Void/strike context (ticket 80dd882d, supervisor steer 2026-08-28): a note
 * that is VOIDING or auditing prior content (its own void notice, or a quote
 * of the guard's struck/audit blocks) treats blockquoted lines as CITATIONS
 * of that content, so their stamps are exempt from future-clock scanning.
 * Gated on this context so bare decoration alone NEVER exempts a fabricated
 * line (review-A1 anti-laundering pin: an unmatched decorated quote in an
 * ordinary note still convicts). Duplicated in action-verifier.ts for the
 * chat lane — keep the two in sync.
 */
const VOID_CONTEXT_RE = /\b(void(?:ed|s|ing)?|struck|fabricat\w+|NOT DONE|UNVERIFIED)\b|---\s*(?:BEGIN|END)\s+(?:STRUCK NOTE|UNVERIFIED RUN OUTPUT)/i;

/**
 * How many non-blank lines ABOVE a blockquote block may carry the void cue
 * that exempts the block (the "Quoting for the record:" / "--- BEGIN … ---"
 * lead-in). The cue used to be tested on the WHOLE final (owner transcript
 * 2026-09-08, a8976e11 firing-87): every redo run echoes the harness's own
 * vocabulary ("the draft was struck as fabricated", "NOT DONE"), so with a
 * text-global gate ANY '> …' line anywhere in the final laundered a future
 * clock. The exemption is now BLOCK-LOCAL: the cue must sit inside the quote
 * block itself or within this many non-blank lines immediately before it.
 */
const VOID_CONTEXT_LOOKBACK_LINES = 3;

/**
 * Per-line quoted-void exemption flags (trimmed lines, original order). A
 * blockquote BLOCK = a maximal run of '>' lines (blank lines inside the run
 * are tolerated when another '>' line follows — markdown quote paragraphs).
 * The block is exempt when VOID_CONTEXT_RE matches inside it or within the
 * VOID_CONTEXT_LOOKBACK_LINES non-blank lines above it. Non-quote lines are
 * never exempt here.
 */
function quotedVoidExemptions(lines: string[]): boolean[] {
  const out: boolean[] = new Array(lines.length).fill(false);
  let i = 0;
  while (i < lines.length) {
    if (!lines[i].startsWith('>')) { i++; continue; }
    let j = i;
    while (j < lines.length) {
      if (lines[j].startsWith('>')) { j++; continue; }
      if (!lines[j]) {
        let k = j;
        while (k < lines.length && !lines[k]) k++;
        if (k < lines.length && lines[k].startsWith('>')) { j = k; continue; }
      }
      break;
    }
    let exempt = false;
    for (let k = i; k < j && !exempt; k++) if (lines[k] && VOID_CONTEXT_RE.test(lines[k])) exempt = true;
    if (!exempt) {
      let seen = 0;
      for (let k = i - 1; k >= 0 && seen < VOID_CONTEXT_LOOKBACK_LINES; k--) {
        if (!lines[k]) continue;
        seen++;
        if (VOID_CONTEXT_RE.test(lines[k])) { exempt = true; break; }
      }
    }
    if (exempt) for (let k = i; k < j; k++) if (lines[k].startsWith('>')) out[k] = true;
    i = j;
  }
  return out;
}

/**
 * The future-dated findings in a final answer. EVERY line is scanned (ticket
 * 375c8618): the old claim-line gate let a deploy-interrupted machine run post
 * a fabricated audit whose future clocks sat on NON-claim status lines (a
 * "tmux storm-watcher RUNNING", an "alive watch.log" tail, journal-entry
 * lines) — none matched a completion-claim kind, so +39m stamps never reached
 * this detector. Two standing exemptions keep honest lines quiet:
 *   - intent-scoped stamps ("next run 06:10Z", "fires at 15:30Z") are skipped
 *     per stamp by INTENT_BEFORE_STAMP_RE below;
 *   - lines that verbatim-appear in the run's REAL tool output
 *     (opts.evidenceHaystacks — e.g. a quoted list_schedules row whose
 *     next-fire ISO stamp is legitimately in the future) are skipped whole.
 * ISO stamps with an explicit date flag at any future distance; clock-only
 * stamps flag only within the 3h window.
 */
export function findFutureDatedClaims(
  text: string,
  now: Date = new Date(),
  opts?: { evidenceHaystacks?: string[]; scheduleFiringTimes?: number[] },
): FutureDatedClaim[] {
  const out: FutureDatedClaim[] = [];
  if (!text) return out;
  // Honest-quote exemption (GUARD 4 haystack semantics): a line verbatim-
  // present in a real tool result is an observation OF that result — its
  // future stamp is the tool's own forward datum (a schedule's next fire, an
  // ETA field), not a confabulated observation clock.
  const evidence = (opts?.evidenceHaystacks ?? []).filter(Boolean).map((h) => h.replace(/\s+/g, ' '));
  // Schedule-firing instants (iteration 13): injected by the caller (the
  // executor's prisma fetch) — the ±60s exemption's existence ground.
  const schedTimes = opts?.scheduleFiringTimes ?? [];
  const rawLines = text.split('\n').map((l) => l.trim());
  const voidQuoteExempt = quotedVoidExemptions(rawLines);
  const seenLines = new Set<string>(); // one finding per distinct line (first non-exempt occurrence)
  for (let li = 0; li < rawLines.length; li++) {
    const line = rawLines[li];
    if (!line) continue;
    // Quoted-void exemption (ticket 80dd882d, supervisor steer 2026-08-28): a
    // blockquoted line inside a note that is VOIDING/auditing prior content
    // is a CITATION of that content, not the run's own observation claim — a
    // recovery audit voiding the prior tick's fabricated reply was flagged
    // for the future stamp inside its quote (the 14:42Z incident). Gated on
    // void-context so bare decoration alone can NEVER launder a fabricated
    // line (review A1 pin: an unmatched decorated quote in an ordinary note
    // still convicts). BLOCK-LOCAL since 2026-09-08 (quotedVoidExemptions):
    // the cue must be in the quote block or its ≤3-line lead-in — a "NOT
    // DONE" three paragraphs away no longer launders an unrelated '> …' line.
    if (voidQuoteExempt[li]) continue;
    if (seenLines.has(line)) continue;
    seenLines.add(line);
    if (evidence.length) {
      const norm = line.replace(/\s+/g, ' ');
      // Decoration-tolerant (adversarial review A1): blockquote/list markers
      // or edge backticks around an honest quote must not defeat the match —
      // the quote culture decorates citations ('> watch.log …', '- `15:03Z`').
      const core = norm.replace(/^(?:> ?|[-*+] |\d{1,9}[.)] )+/, '').replace(/^`+|`+$/g, '');
      const cand = core.length >= 8 ? core : norm;
      if (cand.length >= 8 && evidence.some((h) => h.includes(cand))) continue;
    }
    // Projection-header lines are projection-scoped for ALL their stamps
    // (PROJECTION_LINE_RE, ticket 63e9a3cb): the per-stamp intent window below
    // only reaches 48 chars back, so an honest stamp deep in a long
    // "ETA (projection): …" line would otherwise flag as a fabricated
    // observation clock. Decoration (blockquote/list markers) is stripped
    // before the header test, same as the haystack match above.
    const projCore = line.replace(/^(?:> ?|[-*+] |\d{1,9}[.)] )+/, '').replace(/^`+/, '');
    if (PROJECTION_LINE_RE.test(projCore)) continue;
    // Line-leading "After <EVENT>:" forward plan (iteration 13b, steer
    // 2026-09-25) — whole-line completed-work backstop inside the helper.
    if (afterEventCueLine(projCore)) continue;
    // ISO first, then mask those spans so the clock regex can't re-match the
    // time portion of an ISO stamp ("…T18:23:33Z" → "18:23:33Z").
    let masked = line;
    const seenInstants = new Set<number>(); // one finding per claimed instant per line (review L5)
    /**
     * Zone-conversion GLOSS inheritance (ticket 2884edba sighting 2): the
     * fleet's dual-zone reporting culture renders a forward-referenced
     * instant TWICE — "The 19:05Z tick (12:05 PM PDT) should land …". The
     * primary stamp exempts (intent/conditional/subject), but its PDT gloss
     * re-evaluated bare strikes "12:05 PM PDT" as a fabricated observation
     * (its own backward window holds no intent word; ") should land" matches
     * no subject noun) — the SAME instant, already classified as a forward
     * reference on this line. exemptedGloss records exempted instants (→ END
     * index of the exempted occurrence); a later same-instant stamp inherits
     * the exemption ONLY as an adjacent parenthetical gloss: the gap from
     * the exempted occurrence must be ≤24 chars AND contain an UNCLOSED "("
     * (a closed paren — "(done); the merge landed at 19:00Z" — breaks the
     * inheritance, and >24 chars puts the twin beyond gloss reach entirely).
     * A convicted primary still convicts its twins via seenInstants, and a
     * fabricated stamp far from any intent word gets no relief — the
     * completion-claim layers scan every line regardless.
     */
    const exemptedGloss = new Map<number, number>();
    const markExempt = (t: number, endIdx: number) => { if (!exemptedGloss.has(t)) exemptedGloss.set(t, endIdx); };
    const inheritsExemptGloss = (t: number, idx: number): boolean => {
      const from = exemptedGloss.get(t);
      if (from === undefined) return false;
      const gap = line.slice(from, idx);
      return gap.length <= 24 && gap.lastIndexOf('(') > gap.lastIndexOf(')');
    };
    /**
     * Subject exemption as an INVERTED gate (ticket f1afaa7b): the stamp is a
     * forward reference to a scheduled event UNLESS a conviction gate fires —
     * (1) the text after the stamp does not open like a subject noun phrase
     * (empty / punctuation / parenthetical / closed-class function word), or
     * is a LONE bare word at end-of-line not article-governed through "at"
     * (a state fragment, not a subject reference — review F2); (2) a
     * completed-work verb sits in the stamp's own clause within 96 chars
     * after it (review F1 reach); or (3) a completed-work verb governs the
     * stamp through "at" in its own clause. Unknown nouns default to
     * no-strike; verb-pinned phantom clocks still convict.
     */
    const scheduleSubjectExempt = (startIdx: number, endIdx: number): boolean => {
      const after = line.slice(endIdx);
      if (!SCHEDULE_SUBJECT_SHAPE_RE.test(after)) return false;
      if (SCHEDULE_SUBJECT_LONE_WORD_RE.test(after) && !SCHEDULE_SUBJECT_AT_GOVERNED_RE.test(line.slice(0, startIdx))) return false;
      const fwd = COMPLETED_WORK_FORWARD_WINDOW_RE.exec(after);
      if (fwd && COMPLETED_WORK_AFTER_SUBJECT_RE.test(fwd[0])) return false;
      if (COMPLETED_WORK_BEFORE_STAMP_RE.test(line.slice(0, startIdx))) return false;
      return true;
    };
    ISO_STAMP_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = ISO_STAMP_RE.exec(line))) {
      const t = parseIsoStamp(m[1], m[2], m[3], m[4], m[5]);
      masked = masked.slice(0, m.index) + ' '.repeat(m[0].length) + masked.slice(m.index + m[0].length);
      if (t === null || seenInstants.has(t)) continue;
      if (inheritsExemptGloss(t, m.index)) continue; // zone-conversion gloss twin of an exempted forward reference (sighting 2)
      if (intentScopedStamp(line.slice(0, m.index))) { markExempt(t, m.index + m[0].length); continue; } // intent-scoped stamp ("next probe at …")
      if (CONDITIONAL_BEFORE_STAMP_RE.test(line.slice(0, m.index))) { markExempt(t, m.index + m[0].length); continue; } // hypothetical clause ("if still 0/7 at ~11:00Z …")
      if (estimateGovernedStamp(line, m.index)) { markExempt(t, m.index + m[0].length); continue; } // estimate/deadline-governed stamp ("~6:20 PM PDT", "by ~11:45 AM PDT" — iteration 11)
            if (schedFiringGovernedStamp(line, m.index, t, schedTimes)) { markExempt(t, m.index + m[0].length); continue; } // schedule-firing paraphrase ("next tick 11:30Z", ETA cells — iteration 13); gloss twins inherit
      if (scheduleSubjectExempt(m.index, m.index + m[0].length)) { markExempt(t, m.index + m[0].length); continue; } // stamp subject-labels a scheduled future tick (inverted gate, ticket f1afaa7b)
      if (stampHasToolProvenance(m[0], evidence, t)) { markExempt(t, m.index + m[0].length); continue; } // receipt-sourced stamp (tickets e409e51e/9ed46ffe: time verbatim — or its instant in another clock format — in a same-run tool result)
      seenInstants.add(t);
      const aheadMs = t - now.getTime();
      if (aheadMs > FUTURE_SKEW_MS) out.push({ text: line, stamp: m[0], aheadMs });
    }
    // Human-form dated stamps second ("Aug 22 18:37:41Z"): same handling as
    // ISO, except a year-less stamp keeps the clock-only 3h flag window (an
    // honest "Dec 31 …" reference in early January must not flag as a
    // year-ahead phantom). Masked spans are invisible to the clock pass, so
    // the time portion is never re-dated to today (ticket 78b13021 case 1).
    HUMAN_DATE_STAMP_RE.lastIndex = 0;
    while ((m = HUMAN_DATE_STAMP_RE.exec(masked))) {
      const parsed = parseHumanDateStamp(m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8], now);
      // Mask ONLY when parsing SUCCEEDED (hardened 2026-08-23): an impossible
      // date ("Feb 31 18:37:41Z") used to mask its span anyway, hiding the
      // future clock stamp inside it from the clock pass below.
      if (parsed === null) continue;
      masked = masked.slice(0, m.index) + ' '.repeat(m[0].length) + masked.slice(m.index + m[0].length);
      if (seenInstants.has(parsed.t)) continue;
      if (inheritsExemptGloss(parsed.t, m.index)) continue; // zone-conversion gloss twin of an exempted forward reference
      if (intentScopedStamp(line.slice(0, m.index))) { markExempt(parsed.t, m.index + m[0].length); continue; } // masked shares indices with line
      if (CONDITIONAL_BEFORE_STAMP_RE.test(line.slice(0, m.index))) { markExempt(parsed.t, m.index + m[0].length); continue; } // hypothetical clause
      if (estimateGovernedStamp(line, m.index)) { markExempt(parsed.t, m.index + m[0].length); continue; } // estimate/deadline-governed stamp ("~6:20 PM PDT", "by ~11:45 AM PDT" — iteration 11)
            if (schedFiringGovernedStamp(line, m.index, parsed.t, schedTimes)) { markExempt(parsed.t, m.index + m[0].length); continue; } // schedule-firing paraphrase ("next tick 11:30Z", ETA cells — iteration 13); gloss twins inherit
      if (scheduleSubjectExempt(m.index, m.index + m[0].length)) { markExempt(parsed.t, m.index + m[0].length); continue; } // stamp subject-labels a scheduled future tick (inverted gate)
      if (stampHasToolProvenance(m[0], evidence, parsed.t)) { markExempt(parsed.t, m.index + m[0].length); continue; } // receipt-sourced stamp (tickets e409e51e/9ed46ffe: verbatim or instant-matched)
      seenInstants.add(parsed.t);
      const aheadMs = parsed.t - now.getTime();
      if (aheadMs > FUTURE_SKEW_MS && (parsed.yearExplicit || aheadMs <= FUTURE_CLOCK_ONLY_MAX_AHEAD_MS)) {
        out.push({ text: line, stamp: m[0].trim(), aheadMs });
      }
    }
    // Clock+zone stamps carrying an EXPLICIT trailing ISO date ("10:55 AM PDT
    // 2026-08-24") third (ticket 3611ab4a): the date is authoritative — the
    // time must NOT be re-dated to today by the clock pass below. Same
    // handling as the human pass, except the date is always explicit, so the
    // flag rule is the ISO/yearExplicit one: aheadMs > FUTURE_SKEW_MS at ANY
    // distance (no today/yesterday ambiguity — the 3h clock-only window does
    // not apply). Masked spans are invisible to the clock pass.
    CLOCK_ISO_DATE_COMPOUND_RE.lastIndex = 0;
    while ((m = CLOCK_ISO_DATE_COMPOUND_RE.exec(masked))) {
      const t = parseClockIsoDateCompound(m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8]);
      // Mask ONLY when parsing SUCCEEDED (same hardening as the human pass):
      // an impossible date ("10:55 AM PDT 2026-02-31") must not hide the
      // clock stamp inside it from the clock pass below.
      if (t === null) continue;
      masked = masked.slice(0, m.index) + ' '.repeat(m[0].length) + masked.slice(m.index + m[0].length);
      if (seenInstants.has(t)) continue;
      if (inheritsExemptGloss(t, m.index)) continue; // zone-conversion gloss twin of an exempted forward reference
      if (intentScopedStamp(line.slice(0, m.index))) { markExempt(t, m.index + m[0].length); continue; } // masked shares indices with line
      if (CONDITIONAL_BEFORE_STAMP_RE.test(line.slice(0, m.index))) { markExempt(t, m.index + m[0].length); continue; } // hypothetical clause
      if (estimateGovernedStamp(line, m.index)) { markExempt(t, m.index + m[0].length); continue; } // estimate/deadline-governed stamp ("~6:20 PM PDT", "by ~11:45 AM PDT" — iteration 11)
            if (schedFiringGovernedStamp(line, m.index, t, schedTimes)) { markExempt(t, m.index + m[0].length); continue; } // schedule-firing paraphrase ("next tick 11:30Z", ETA cells — iteration 13); gloss twins inherit
      if (scheduleSubjectExempt(m.index, m.index + m[0].length)) { markExempt(t, m.index + m[0].length); continue; } // stamp subject-labels a scheduled future tick (inverted gate)
      if (stampHasToolProvenance(m[0], evidence, t)) { markExempt(t, m.index + m[0].length); continue; } // receipt-sourced stamp (tickets e409e51e/9ed46ffe: verbatim or instant-matched)
      seenInstants.add(t);
      const aheadMs = t - now.getTime();
      if (aheadMs > FUTURE_SKEW_MS) out.push({ text: line, stamp: m[0].trim(), aheadMs });
    }
    // Clock+zone stamps carrying a TRAILING HUMAN date pin ("10:23:17Z
    // Aug-29", "17:01Z on Aug-27") fourth (ticket 85f8d318 — the coding-lane
    // parity port of chat-lane PR #515/9ed1bf8e): the pinned date is
    // authoritative — the time must NOT be re-dated to today by the
    // bare-clock pass below. Parse + flag semantics mirror the LEADING human
    // pass above (same parseHumanDateStamp: a year-less pin keeps the
    // clock-only 3h flag window — the honest "Dec 31" residual; a
    // year-explicit pin flags at any distance). Masking and the exemption
    // order mirror every other pass; an impossible pin ("Aug-32") masks
    // NOTHING. Exoneration-by-construction: any shape this pass matches would
    // otherwise reach the bare-clock pass and be re-dated to TODAY, so a PAST
    // pin can only remove a base conviction, while a FUTURE pin convicts on
    // the same rules the leading human pass already applies to its dates.
    CLOCK_HUMAN_DATE_COMPOUND_RE.lastIndex = 0;
    while ((m = CLOCK_HUMAN_DATE_COMPOUND_RE.exec(masked))) {
      const parsed = parseHumanDateStamp(m[6], m[7], m[8], m[1], m[2], m[3], m[4], m[5], now);
      // Mask ONLY when parsing SUCCEEDED (same hardening as the human/ISO
      // passes): an impossible pin ("Aug-32") must not hide the clock stamp
      // inside it from the clock pass below.
      if (parsed === null) continue;
      masked = masked.slice(0, m.index) + ' '.repeat(m[0].length) + masked.slice(m.index + m[0].length);
      if (seenInstants.has(parsed.t)) continue;
      if (inheritsExemptGloss(parsed.t, m.index)) continue; // zone-conversion gloss twin of an exempted forward reference
      if (intentScopedStamp(line.slice(0, m.index))) { markExempt(parsed.t, m.index + m[0].length); continue; } // masked shares indices with line
      if (CONDITIONAL_BEFORE_STAMP_RE.test(line.slice(0, m.index))) { markExempt(parsed.t, m.index + m[0].length); continue; } // hypothetical clause
      if (estimateGovernedStamp(line, m.index)) { markExempt(parsed.t, m.index + m[0].length); continue; } // estimate/deadline-governed stamp ("~6:20 PM PDT", "by ~11:45 AM PDT" — iteration 11)
            if (schedFiringGovernedStamp(line, m.index, parsed.t, schedTimes)) { markExempt(parsed.t, m.index + m[0].length); continue; } // schedule-firing paraphrase ("next tick 11:30Z", ETA cells — iteration 13); gloss twins inherit
      if (scheduleSubjectExempt(m.index, m.index + m[0].length)) { markExempt(parsed.t, m.index + m[0].length); continue; } // stamp subject-labels a scheduled future tick (inverted gate)
      if (stampHasToolProvenance(m[0], evidence, parsed.t)) { markExempt(parsed.t, m.index + m[0].length); continue; } // receipt-sourced stamp (tickets e409e51e/9ed46ffe)
      seenInstants.add(parsed.t);
      const aheadMs = parsed.t - now.getTime();
      if (aheadMs > FUTURE_SKEW_MS && (parsed.yearExplicit || aheadMs <= FUTURE_CLOCK_ONLY_MAX_AHEAD_MS)) {
        out.push({ text: line, stamp: m[0].trim(), aheadMs });
      }
    }
    CLOCK_STAMP_RE.lastIndex = 0;
    while ((m = CLOCK_STAMP_RE.exec(masked))) {
      const t = parseClockStamp(m[1], m[2], m[3], m[4], m[5], now);
      if (t === null || seenInstants.has(t)) continue;
      if (inheritsExemptGloss(t, m.index)) continue; // zone-conversion gloss twin of an exempted forward reference
      if (intentScopedStamp(line.slice(0, m.index))) { markExempt(t, m.index + m[0].length); continue; } // masked shares indices with line
      if (CONDITIONAL_BEFORE_STAMP_RE.test(line.slice(0, m.index))) { markExempt(t, m.index + m[0].length); continue; } // hypothetical clause
      if (estimateGovernedStamp(line, m.index)) { markExempt(t, m.index + m[0].length); continue; } // estimate/deadline-governed stamp ("~6:20 PM PDT", "by ~11:45 AM PDT" — iteration 11)
            if (schedFiringGovernedStamp(line, m.index, t, schedTimes)) { markExempt(t, m.index + m[0].length); continue; } // schedule-firing paraphrase ("next tick 11:30Z", ETA cells — iteration 13); gloss twins inherit
      if (scheduleSubjectExempt(m.index, m.index + m[0].length)) { markExempt(t, m.index + m[0].length); continue; } // stamp subject-labels a scheduled future tick (inverted gate)
      if (stampHasToolProvenance(m[0], evidence, t)) { markExempt(t, m.index + m[0].length); continue; } // receipt-sourced stamp (tickets e409e51e/9ed46ffe: verbatim or instant-matched)
      seenInstants.add(t);
      const aheadMs = t - now.getTime();
      if (aheadMs > FUTURE_SKEW_MS && aheadMs <= FUTURE_CLOCK_ONLY_MAX_AHEAD_MS) {
        out.push({ text: line, stamp: m[0].trim(), aheadMs });
      }
    }
  }
  return out;
}

// ── Layer 2c: evidence-clock calibration (ticket 28b9414d) ──────────────────

/**
 * THE SKEW: the future-dated guard compares quoted stamps against the GUARD
 * process's own clock — but a run's honest citations live in OTHER clock
 * domains (the session satellite container, a remote box, a GitHub Date
 * header), and those domains can run minutes AHEAD of the guard host.
 * 2026-08-28 incident (run bdf31a94, ticket 28b9414d): satellite and GitHub
 * agreed within +6..+13s while the guard host ran ~2m20s slow, so four honest
 * ~+2m quotes were convicted as fabricated observation clocks — composite
 * citation lines ("C1 … vs GH date: … (+13s)") never appear verbatim in any
 * single tool result, so the line-level haystack exemption could not save
 * them. (The message row's createdAt is no bound either: CodingMessage rows
 * are inserted at run start and REWRITTEN as partials accumulate —
 * updateCodingMessage — so a final's honest late-run stamps always post-date
 * the row's createdAt.)
 *
 * THE CALIBRATION: a phantom run cannot mint REAL future stamps into its tool
 * output, so the latest explicitly-dated stamp across the run's evidence is a
 * PROVEN-OBSERVED instant — the comparison clock is max(guardNow, that
 * instant). Bounds keep the calibration from becoming the smuggle lane:
 *   - only stamps within EVIDENCE_CLOCK_MAX_LEAD_MS of guardNow count — a
 *     schedule's next-fire or an ETA hours out must not raise the ceiling;
 *   - intent-scoped stamps ("next fire …", "expires …") are excluded per
 *     stamp — the same windowed rule the flag pass uses;
 *   - clock-only stamps are never re-dated (a "23:50 PDT" near midnight would
 *     mint a +23h ceiling).
 * An evidence-free phantom lane (the conviction class — observed leads
 * 6–45 min) has no future stamp in real tool output, so its comparison clock
 * stays the strict guard clock and the 90s FUTURE_SKEW_MS rule convicts it.
 */
export const EVIDENCE_CLOCK_MAX_LEAD_MS = 5 * 60 * 1000;

/**
 * camelCase-glued JSON keys evade the flag pass's \b-bounded intent filter
 * ("nextFireAt", "scheduledFor", "expiresAt" — adversarial review M1): the
 * evidence side therefore ALSO tests a hump-tolerant variant so a third-party
 * JSON next-fire cannot raise the calibration ceiling. Evidence-side ONLY on
 * purpose — the shared flag-pass regex is conviction behavior, unchanged.
 * Over-matching here is the SAFE direction (less calibration, never more).
 */
const EVIDENCE_INTENT_CAMEL_RE = /\b(?:next|scheduled|will|would|expires?|expiring|deadline|eta|due|reminder|until|window|resume|fires?|firing)(?:[A-Z][a-zA-Z0-9]*)+[^\n]{0,48}$/i;

/**
 * RFC-2822 / HTTP-date, day-first ("Fri, 28 Aug 2026 06:29:45 GMT") — the
 * shape curl -i prints in response headers. ISO_STAMP_RE needs dashes and
 * HUMAN_DATE_STAMP_RE is month-first, so without this pass a quoted GitHub
 * Date header — the incident's own ground-truth stamp — cannot calibrate.
 */
const HTTP_DATE_STAMP_RE = /\b(\d{1,2})\s+(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})\s*(Z|UTC|GMT)\b/gi;

/** Day-first HTTP-date → ms epoch, with the same strict round-trip validation as parseHumanDateStamp. */
function parseHttpDateStamp(
  dRaw: string, monRaw: string, yRaw: string,
  hRaw: string, mRaw: string, sRaw: string, zoneRaw: string,
): number | null {
  const mo = MONTH_INDEX[monRaw.toLowerCase()];
  if (mo === undefined) return null;
  const dd = parseInt(dRaw, 10);
  const hh = parseInt(hRaw, 10);
  const mm = parseInt(mRaw, 10);
  const ss = parseInt(sRaw, 10);
  if (hh > 23 || mm > 59 || ss > 59) return null;
  const offsetH = TZ_OFFSET_HOURS[zoneRaw.toUpperCase()];
  if (offsetH === undefined) return null;
  const datePart = `${yRaw}-${String(mo).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
  const wallAsUtc = Date.parse(`${datePart}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}Z`);
  if (Number.isNaN(wallAsUtc)) return null;
  if (new Date(wallAsUtc).toISOString().slice(0, 10) !== datePart) return null; // e.g. "31 Feb 2026" rolled over
  return wallAsUtc + offsetH * 3_600_000;
}

/**
 * The latest PROVEN-OBSERVED instant across the run's evidence texts (ms
 * epoch), bounded to (nowMs, nowMs + EVIDENCE_CLOCK_MAX_LEAD_MS] — undefined
 * when no evidence stamp sits ahead of the guard clock (the common case: the
 * comparison then stays the strict guard clock). See the layer-2c notes above
 * for the bound rules.
 */
export function evidenceClockMs(texts: string[], nowMs: number): number | undefined {
  let max: number | undefined;
  const now = new Date(nowMs);
  const consider = (t: number | null, text: string, index: number) => {
    if (t === null) return;
    if (t <= nowMs || t > nowMs + EVIDENCE_CLOCK_MAX_LEAD_MS) return;
    // Intent-scoped stamp ("next fire …") — the flag pass's own windowed rule
    // PLUS the evidence-side camelCase variant (review M1), applied to the 120
    // chars before the stamp (the intent word plus its 48-char gap can never
    // reach further back).
    const before = text.slice(Math.max(0, index - 120), index);
    if (INTENT_BEFORE_STAMP_RE.test(before) || EVIDENCE_INTENT_CAMEL_RE.test(before)) return;
    if (max === undefined || t > max) max = t;
  };
  let m: RegExpExecArray | null;
  for (const text of texts) {
    if (!text) continue;
    ISO_STAMP_RE.lastIndex = 0;
    while ((m = ISO_STAMP_RE.exec(text))) consider(parseIsoStamp(m[1], m[2], m[3], m[4], m[5]), text, m.index);
    HUMAN_DATE_STAMP_RE.lastIndex = 0;
    while ((m = HUMAN_DATE_STAMP_RE.exec(text))) {
      const parsed = parseHumanDateStamp(m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8], now);
      consider(parsed === null ? null : parsed.t, text, m.index);
    }
    HTTP_DATE_STAMP_RE.lastIndex = 0;
    while ((m = HTTP_DATE_STAMP_RE.exec(text))) consider(parseHttpDateStamp(m[1], m[2], m[3], m[4], m[5], m[6], m[7]), text, m.index);
  }
  return max;
}

/** GUARD_DEFER_PR_PUSH_DISABLED=1 — pr_merged / pr_closed convictions at GUARD 1 again + the legacy "zero evidence-bearing tool calls" sentence (pre audit 2026-10-06 T7-6). Read per call. */
export function guardDeferPrPushDisabled(): boolean {
  const v = String(process.env.GUARD_DEFER_PR_PUSH_DISABLED ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

/** The pr_* kinds whose GUARD-1 conviction waits for the PR API's state (T7-6) — a state fact, not an authorship claim. */
const isDeferredPrClaimKind = (k: ClaimKind): boolean => k === 'pr_merged' || k === 'pr_closed';

/**
 * The guard-1 notice: machine-readable claim-kind counts + the explicit
 * NO-FRESH-EVIDENCE / UNVERIFIED framing that kills the phantom pattern.
 */
export function renderEvidenceGuardNote(claims: CompletionClaim[], ctx: { triggerKind: string; resumed: boolean; evidenceCalls?: number }): string {
  const counts = new Map<ClaimKind, number>();
  for (const c of claims) counts.set(c.kind, (counts.get(c.kind) ?? 0) + 1);
  const countText = Array.from(counts.entries())
    .map(([kind, n]) => `${kind}: ${n}`)
    .join(', ');
  // audit 2026-10-06 T7-6 (stanne.md #8): the sentence used to say "zero
  // evidence-bearing tool calls" for EVERY conviction — on a run that made 13
  // platform reads. With a real count (> 0) it says what is true: calls ran,
  // none of them backs these claims. Omitted / 0 = the original sentence.
  const n = typeof ctx.evidenceCalls === 'number' && Number.isFinite(ctx.evidenceCalls) ? Math.max(0, Math.floor(ctx.evidenceCalls)) : 0;
  return [
    '[HARNESS EVIDENCE GUARD]',
    n > 0
      ? `This run was triggered by '${ctx.triggerKind}'${ctx.resumed ? ' (resumed from a checkpoint)' : ''} and made ${n} evidence-bearing tool call${n === 1 ? '' : 's'}, but none of them evidences the completions below — NO FRESH EVIDENCE for these claims.`
      : `This run was triggered by '${ctx.triggerKind}'${ctx.resumed ? ' (resumed from a checkpoint)' : ''} and made zero evidence-bearing tool calls — NO FRESH EVIDENCE this turn.`,
    `The final answer above asserts external completions (${countText}) that are UNVERIFIED: they were reconstructed from plan intent or prior context, not observed by any tool call this run.`,
    'Do NOT treat the PR merges, pushed commits, deploys, probes, or tallies above as fact. Re-run with real verification (GitHub API, box probes, test runs) before relying on or repeating any of them.',
    // Finding A1: the commit_local sentence names the exact gap — a local
    // git_commit (or a relayed "banked") is not a push.
    ...(counts.has('commit_local')
      ? [`commit_local (${claims.filter((c) => c.kind === 'commit_local' && c.sha).map((c) => c.sha!.slice(0, 12)).join(', ') || 'sha'}): a commit described as banked/committed has NO git_push receipt (this run's, or the lane's via get_run_receipts) and no this-run GitHub read backing it, and origin did not confirm it — a local git_commit is not a push. Treat it as LOCAL ONLY — not pushed — until a git_push receipt or an origin read names the sha.`]
      : []),
  ].join('\n');
}

// ── CARRIED-EVIDENCE tier (tt-rd audit 2026-09-27, finding self-audit-churn-4) ──
// RSW-1 cl30 (2026-11-02): the CARRIED-RECEIPTS release switch expired 2026-11-12
// and was deleted — the tier is now unconditional. A claim naming a STABLE
// artifact that an EARLIER run of this chat receipted, and not phrased as fresh,
// is CARRIED (not UNVERIFIED). Observation kinds (probe / benchmark / deploy)
// never carry: they bind to no artifact, so a prior receipt cannot prove THIS
// firing's observation.

/**
 * A claim line PHRASED AS FRESH asserts an observation of THIS run — "this
 * run / this firing / just now / fresh / re-probed / re-ran", or a clock
 * stamp (HH:MM[:SS]Z, an ISO date-time). Such a line needs a fresh receipt;
 * a prior-run receipt never carries it.
 */
export const FRESH_CLAIM_CUE_RE = /\b(?:this (?:run|turn|firing)|just now|\bnow\b|fresh(?:ly)?|re-?(?:probed|ran|verified|checked|confirmed)|today|moments? ago)\b|\b\d{1,2}:\d{2}(?::\d{2})?\s*Z\b|\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/i;

/** Only STABLE-artifact claims can carry: a PR number, or a pushed sha. Pure. */
export function claimNamesStableArtifact(c: CompletionClaim): boolean {
  if (c.prNumber !== undefined && c.prNumber !== null) return true;
  return c.kind === 'commit_pushed' && !!c.sha;
}

/**
 * The earlier-run ok receipt that evidences this claim, or null: the claim
 * must name a stable artifact, must NOT be phrased as fresh, and one carried
 * receipt (id-matched by receiptMatchesClaim) must prove it. Pure.
 */
export function carriedReceiptFor(c: CompletionClaim, carriedReceipts: ToolReceipt[]): ToolReceipt | null {
  if (!claimNamesStableArtifact(c)) return null;
  if (FRESH_CLAIM_CUE_RE.test(c.text)) return null;
  // ID-BOUND only — never receiptMatchesClaim's coarse tool-class fallback: a
  // prior-run receipt for PR #707 must not carry a claim about PR #706, and no
  // earlier external-action receipt can carry an unrelated artifact.
  const idMatch = (cited: string, actual: string): boolean =>
    actual === cited || (cited.length >= 8 && actual.length >= 8 && (actual.startsWith(cited) || cited.startsWith(actual)));
  for (const r of carriedReceipts) {
    if (!r.ok) continue;
    if (c.prNumber !== undefined && c.prNumber !== null) {
      if (r.ids?.prNumber !== undefined && r.ids?.prNumber !== null && String(r.ids.prNumber) === String(c.prNumber)) return r;
      continue;
    }
    if (c.kind === 'commit_pushed' && c.sha) {
      // Finding A1 ∘ carried tier: a LOCAL receipt (git_commit) proves the
      // worktree has the sha, never that origin does — it cannot carry a
      // pushed claim from an earlier run either.
      if (isLocalReceiptTool(r.tool)) continue;
      if (r.ids?.sha !== undefined && r.ids?.sha !== null && idMatch(String(c.sha).toLowerCase(), String(r.ids.sha).toLowerCase())) return r;
    }
  }
  return null;
}

/** The observe-only CARRIED note: one line per carried claim naming the earlier run + time. Pure. */
export function renderCarriedEvidenceNote(carried: NonNullable<GuardVerdict['carriedClaims']>): string {
  return [
    '[HARNESS EVIDENCE GUARD — CARRIED EVIDENCE]',
    ...carried.slice(0, 8).map((c) => `[CARRIED from run ${c.runId ? c.runId.slice(0, 8) : 'unknown'} ${c.at}] ${c.kind}: ${c.text.slice(0, 160)}`),
    'These claims restate artifacts an EARLIER run of this chat receipted (a PR number / pushed sha) and are not phrased as fresh — they are carried, not unverified. A claim phrased as observed THIS run still needs a fresh receipt.',
  ].join('\n');
}

// ── Layer 2d: quoted-output verification (ticket 7cb26cb0) ──────────────────

/**
 * THE GAP: the guard deterministically verified PUBLISH-CHAIN claims (PRs,
 * shas, evidence tiers, wall-clock stamps) but trusted QUOTED OBSERVATIONS
 * as-written. The 2026-08-26 monitor run (chat a8976e11) passed the guard
 * while quoting on-box log lines that never existed ("[34/55] gpqa-100 r0
 * TRUNC 3719.4s" — gpqa-100 appears nowhere in the real log) plus a
 * fabricated write receipt. A quote presented as verbatim tool/log output is
 * a CLAIM about a tool result — and the run's real tool results are right
 * there in `parts` to check it against.
 *
 * THE CHECK (GUARD 4): every fenced block / blockquote run in the final
 * answer that is INTRODUCED AS OBSERVED OUTPUT (a cue like "output:",
 * "the log shows", "returned", "probe result" in the ~2 lines above it)
 * must line-match some real tool_result of THIS run. The model can only ever
 * quote what a tool actually showed it, so a genuine quote is a 100% line
 * match; a confabulated one matches ~0%. A block whose substantial lines
 * mostly match NOTHING is flagged as fabricated observation.
 *
 * FALSE-POSITIVE DISCIPLINE (same windowed style as layer 1):
 *  - cue-gated: no observation cue before the block → not checked at all
 *    (code the model WROTE, diffs, plans — the vast majority of fences);
 *  - language-tagged code fences (ts/js/py/…) are skipped outright; json
 *    needs a STRONG cue ("returned"/"tool result"/"receipt") — it is how a
 *    write-receipt quote looks, but also how illustrative config looks;
 *  - expectation/intent cues ("expected output", "for example", "would
 *    print") and past-attribution cues ("previous run observed …") suppress;
 *  - trivial lines (short, comments, `$ command` prompts the model retyped)
 *    are not matchable evidence and are excluded from the tally.
 */

/** Max flagged blocks surfaced in the verdict/note (bounded rendering). */
export const MAX_FLAGGED_QUOTES = 5;

/**
 * Observation cue in the lines introducing a block: the block is presented as
 * something a tool/terminal/log PRODUCED. Deliberately excludes people-words
 * (says/wrote/claims) — quoting a PERSON is not an observation claim — and
 * 'observ\w+': "Some prose with no observation words." is not a cue (review
 * round 3 — the bare stem false-fires on prose merely DISCUSSING observation;
 * real observation framings always carry a concrete word from this set).
 * The printed/produced/emitted/yielded/dumped family was ADDED in round 3 and
 * REVERTED in round 4 (review F3): "The migration produced:" + a composed
 * file list, "I dumped the config:" + authored config — honest composed
 * content the model ASSEMBLED, not quoted — convicted at full strength. A
 * miss (fabrication under a cue-less framing) costs less than a false
 * conviction (an honest answer REPLACED + a false integrity ticket).
 */
const QUOTE_OBSERVATION_CUE_RE = /\b(?:output|stdout|stderr|returned?|tool results?|logs?|grep(?:ped)?|probe[sd]?|verbatim|terminal|console|on-?box|receipts?|cat|tail|head|ps aux|df -h|md5(?:sum)?|sha256sum)\b/i;

/** json fences are eligible only on a STRONG receipt-flavoured cue. */
const QUOTE_STRONG_CUE_RE = /\b(?:returned?|tool results?|receipts?|stdout|output)\b/i;

/** Expectation/illustration framing — the block is a sample, not an observation. */
const QUOTE_EXPECTATION_RE = /\b(?:expected?|examples?|samples?|illustrat\w+|would|will|should|hypothetic\w+|fixtures?|e\.g\.|for instance|templates?|placeholders?|like this|something like)\b/i;

/** Past-run attribution — quoting what an EARLIER run observed is honest. */
const QUOTE_PAST_RUN_RE = /\b(?:previous(?:ly)?|earlier|last (?:run|tick|firing|wake)|prior (?:run|tick|wake)|historical|from (?:the|an?) earlier)\b/i;

/**
 * USER-SOURCE windows ("the log you pasted:", "the output you provided"): the
 * block quotes content the USER supplied in the prompt, not a tool
 * observation — a genuine quote of it can never match a tool result (review
 * round-5 F3, a pre-existing FP lane). Residual (accepted): fabricated lines
 * under a user-source framing escape — a fabrication claims the run's OWN
 * observation, so user attribution is an odd vehicle, and a miss costs less
 * than convicting an honest quote of the user's own paste.
 */
const QUOTE_USER_SOURCE_RE = /\byou(?:r)?\s+(?:pasted|provided|gave|sent|shared|attached|uploaded|quoted)\b/i;

/**
 * AUTHORSHIP/instruction framing (adversarial review rounds 1–2): the block
 * is something the model WROTE — "here is the helper script that parses the
 * worker log output:" + ```bash — not something a tool produced. The first
 * cut suppressed on BARE artifact tokens ("the script", "i added", "run
 * this") and re-opened the fabrication lane it meant to protect: "the script
 * returned:", "the function output was:", "here is a snippet of the worker
 * log output:" are canonical OBSERVATION framings (the incident's own
 * phrasing family) and must CHECK. So every alternative here is ANCHORED:
 *  - the artifact noun must be followed by a PRESENTATION continuation —
 *    purpose/relative connector (that, which, to, for, below, as follows) or
 *    end-of-line colon — never by an OBSERVATION verb (returned, output,
 *    printed, …): "the script that returned:" checks, "the script that
 *    parses:" suppresses;
 *  - the i-verb lane requires the artifact noun ("i wrote this helper"
 *    suppresses; "i added this log excerpt" — a quote, not an artifact —
 *    checks);
 *  - "save this" requires "as" (a filename — "save this output for later"
 *    checks); bare "run this"/"usage:" were dropped: command blocks skip
 *    naturally (no matchable lines), and the tokens suppressed anything.
 */
const QUOTE_ARTIFACT_NOUN = String.raw`(?:scripts?|snippets?|functions?|helpers?|aliases?|one-liners?|parsers?)`;
const QUOTE_AUTHORSHIP_RE = new RegExp(
  String.raw`\b(?:here(?:'s| is)\s+(?:a|an|the|this|that|my)\s+(?:[\w-]+\s+)?${QUOTE_ARTIFACT_NOUN}(?=\s*[:.!,]|\s+(?:that|which|to|for|below|as\s+follows)\b|\s*$)`
  + String.raw`|i (?:wrote|created|added|made|put|authored)\s+(?:(?:a|an|the|this|that|my)\s+)?(?:[\w-]+\s+)?${QUOTE_ARTIFACT_NOUN}\b`
  + String.raw`|the following ${QUOTE_ARTIFACT_NOUN}\b`
  + String.raw`|save (?:this|it) as\b`
  + String.raw`|\b${QUOTE_ARTIFACT_NOUN}\s+(?:to|for)\b`
  + String.raw`|(?:this|the|a|an|that|my)\s+(?:[\w-]+\s+)?${QUOTE_ARTIFACT_NOUN}(?=\s*[:.!,]?\s*$|\s+(?:to|for|below|as\s+follows)\b|\s+that\b(?!\s+(?:i\s+)?(?:ran|returned?|output(?:ted)?|printed?|show(?:s|ed|n)?|produced|yielded|gave|emitted|logged|displayed))))`,
  'i',
);

/** Fenced-block info strings that mean "code I wrote", never observed output. */
const QUOTE_CODE_LANGS = new Set([
  'ts', 'typescript', 'tsx', 'js', 'javascript', 'jsx', 'py', 'python', 'java',
  'go', 'rs', 'rust', 'c', 'cpp', 'c++', 'cs', 'csharp', 'rb', 'ruby', 'php',
  'swift', 'kt', 'kotlin', 'scala', 'sql', 'prisma', 'graphql', 'yaml', 'yml',
  'toml', 'xml', 'html', 'css', 'scss', 'dockerfile', 'makefile', 'diff',
]);

/** A quoted block eligible for checking, with its introduction window. */
interface QuotedBlock {
  /** The block's content lines (fence interior / de-prefixed blockquote). */
  content: string;
  /** Up to two non-empty lines immediately above the block (the cue window). */
  window: string;
  /** Fenced info string's FIRST token, lowercased ('' for bare fences, null for blockquotes). */
  info: string | null;
  /** The raw fence-opener line for fenced blocks (null for blockquotes) — needed where the EXACT opener shape matters (claims lane mirror), since `info` is lossy. */
  opener: string | null;
}

/**
 * Fence opener: 3+ backticks or tildes, then an optional info string —
 * CommonMark allows a MULTI-WORD one for ```-fences ("```bash linenos"), and
 * rejecting it (review round 2) left the fence body unchecked prose: a
 * fabricated block hid behind "```log output".
 */
const FENCE_OPEN_RE = /^\s*(```+|~~~+)([^`]*)$/;

/**
 * The EXACT opener shape the claims lane recognizes (claims-block.ts
 * findClaimsFences' opener grammar): up to 3 leading spaces, exactly
 * ```claims, trailing whitespace only. The quote lane skips ONLY this shape
 * — off-shape variants (```CLAIMS, ```claims extra, ~~~claims) are
 * unrecognized by the claims lane, so exempting them here too would open a
 * two-lane hole where fabricated "quoted output" escapes both scanners
 * (independent-review finding, ticket d0597e02 PR).
 */
const CLAIMS_FENCE_OPEN_EXACT_RE = /^[ \t]{0,3}```claims[ \t]*$/;

/**
 * The matching CLOSER: at least the opener's length of the SAME marker char
 * and nothing else on the line (a closing fence cannot carry an info string).
 * The old fixed 3-char close let a ````-fence "close" at any ```/```python
 * line, hiding a fabricated tail behind a code-looking decoy (review round 2).
 */
function fenceCloseRe(marker: string): RegExp {
  return new RegExp('^\\s*' + marker[0] + '{' + marker.length + ',}\\s*$');
}

/**
 * Extract fenced blocks and blockquote runs from a final answer. Fences:
 * standard ``` (and ~~~) with an optional info string; blockquotes: maximal
 * runs of consecutive `> ` lines (de-prefixed). The WINDOW for each block is
 * the up-to-two non-empty PROSE lines above it — pass 1 marks every quoted
 * line (fence markers, fence interiors, blockquote lines) so the window steps
 * OVER an adjacent preceding block instead of collecting its closing fence +
 * last content line (adversarial review finding 2: a real cue line between
 * two blocks — "todo_update returned:" — was crowded out by the first block's
 * closing fence, silently skipping the second block's check). Both passes
 * share scanFence so marking and extraction can never diverge. The guard's
 * OWN chrome is never in the input (the lane runs on originalText) — and a
 * model quoting it is GUARD 0's forgery lane, not this one.
 */
function extractQuotedBlocks(text: string): QuotedBlock[] {
  const lines = text.split('\n');
  const QUOTE_LINE_RE = /^\s*>\s?/;
  /** Fence block at line i (KNOWN opener) → its body lines + the index AFTER the closing fence (lines.length when unterminated). */
  const scanFence = (i: number): { body: string[]; end: number } => {
    const closeRe = fenceCloseRe(lines[i].match(FENCE_OPEN_RE)![1]);
    const body: string[] = [];
    let j = i + 1;
    while (j < lines.length && !closeRe.test(lines[j])) { body.push(lines[j]); j++; }
    return { body, end: Math.min(j + 1, lines.length) };
  };
  // PASS 1: mark lines that ARE quoted material.
  const quotedLine = new Array<boolean>(lines.length).fill(false);
  for (let i = 0; i < lines.length; i++) {
    if (FENCE_OPEN_RE.test(lines[i])) {
      const { end } = scanFence(i);
      for (let k = i; k < end; k++) quotedLine[k] = true;
      i = end - 1;
      continue;
    }
    if (QUOTE_LINE_RE.test(lines[i])) quotedLine[i] = true;
  }
  // PASS 2: extract blocks; window = nearest non-quoted non-empty lines above.
  const blocks: QuotedBlock[] = [];
  const windowAbove = (startIdx: number): string => {
    const collected: string[] = [];
    for (let k = startIdx - 1; k >= 0 && collected.length < 2; k--) {
      if (quotedLine[k]) continue;
      const t = lines[k].trim();
      if (t) collected.unshift(t);
    }
    return collected.join('\n');
  };
  let i = 0;
  while (i < lines.length) {
    const fenceOpen = lines[i].match(FENCE_OPEN_RE);
    if (fenceOpen) {
      const info = (fenceOpen[2].trim().split(/\s+/)[0] || '').toLowerCase();
      const { body, end } = scanFence(i);
      blocks.push({ content: body.join('\n'), window: windowAbove(i), info, opener: lines[i] });
      i = end;
      continue;
    }
    if (QUOTE_LINE_RE.test(lines[i])) {
      const body: string[] = [];
      let j = i;
      while (j < lines.length && QUOTE_LINE_RE.test(lines[j])) {
        body.push(lines[j].replace(QUOTE_LINE_RE, ''));
        j++;
      }
      blocks.push({ content: body.join('\n'), window: windowAbove(i), info: null, opener: null });
      i = j;
      continue;
    }
    i++;
  }
  return blocks;
}

/** Collapse whitespace for alignment-tolerant line comparison. */
function normalizeQuoteLine(line: string): string {
  return line.replace(/\s+/g, ' ').trim();
}

/**
 * Shell-command-shaped lines are AUTHORED content, not observable output: a
 * transcript's evidence is its OUTPUT lines, and a command's presence in a
 * fence proves nothing (the command lives in tool_call args, not results).
 * A line is command-shaped when it STARTS with a common command word AND
 * carries a shell hint (pipe/redirect/flag/path/assignment) — the hint keeps
 * plain-English lines starting with these words ("watch out for …", npm ERR!
 * output) matchable. This is the discriminator intro-regex cannot provide
 * (review round 3): "Run this to reproduce:" + a fabricated LOG line flags,
 * while "Run this to see the error output:" + an authored bash script skips.
 */
const SHELL_CMD_START_RE = /^(?:sudo\s+)?(?:ba?sh|zsh|cd|ls|cat|tac|tail|head|grep|egrep|fgrep|awk|sed|find|xargs|docker(?:-compose)?|git|npm|npx|yarn|pnpm|curl|wget|ssh|scp|rsync|systemctl|journalctl|service|ps|kill(?:all)?|pkill|rm|cp|mv|mkdir|rmdir|chmod|chown|echo|printf|export|env|set|unset|jq|yq|base64|md5sum|sha\d+sum|tar|gzip|gunzip|zip|unzip|python[0-9.]*|pip[0-9.]*|node|deno|bun|source|make|cmake|go|cargo|rustc|apt(?:-get)?|apk|yum|dnf|brew|df|du|free|top|htop|netstat|ss|ping|traceroute|nslookup|dig|hostname|uname|date|uptime|whoami|which|whereis|touch|ln|tee|sort|uniq|wc|diff|patch|crontab|nohup|tmux|screen|watch|kubectl|helm|aws|gcloud|az|wrangler|flyctl|supabase|prisma|tsc|tsx|jest|vitest|mocha|eslint|prettier|nodemon|pm2|nginx|caddy|certbot|openssl|gpg)\s/;
const SHELL_CMD_HINT_RE = /[|>&;`$]|\s--?[\w][\w-]*|\s\/[\w./~-]+|\s~\/|\w+=\S/;

/**
 * INSTRUCTION-flavoured windows ("Run this …", "Save this as …", "the
 * following script …"): the block is being PRESENTED as something to run or
 * keep. The command-line exclusion below applies ONLY here (review round-4
 * evasion close): in a pure OBSERVATION window ("log tail:", "grep
 * returned:") command-shaped lines stay matchable — a fabricated "log" whose
 * lines all happen to start with command words still convicts. Residual
 * (documented): under an instruction framing with every line command-shaped,
 * a fabricated block skips — far from the incident signature (log-shaped
 * lines under observation framings), accepted.
 *
 * Round-5 narrowing (review round-4 F-1): bare `run` and `here(?:'s| is)`
 * classified canonical OBSERVATION framings ("Here is the on-box log tail:",
 * "The monitor run returned:") as instruction windows, letting command-shaped
 * fabrications skip. `here is` is dropped (authorship stays covered by
 * QUOTE_AUTHORSHIP_RE + the artifact nouns below).
 *
 * Round-6 rework (review round-5 F1/F2): `run` matches only IMPERATIVE forms,
 * guarded against past-tense/observation verbs so noun usages ("the monitor
 * run returned:", "run completed successfully") stay observation.
 *
 * Round-7 class-fix (review round-6 B1): the round-6 lanes were example-
 * scoped — connector-less mid-line imperatives ("Simply run npm test:",
 * "Now run curl …:") and bare "Execute:" still convicted honest authored
 * commands. `run` now matches ANY following word as imperative UNLESS the
 * word is an observation/past-tense verb used as a noun ("the run returned",
 * "run completed successfully") — see the tail rule below.
 *
 * Round-8 refinement (review round-7 B1′/M1): a guard word blocks the
 * imperative reading ONLY at phrase end ("the monitor run returned:", "the
 * run failed:") or before an observation particle ("run came back …", "run
 * completed successfully", "the run was clean") — NOT before arbitrary
 * content, so imperative uses of the same words shield honest commands
 * ("run failed tests again:", and round-7's self-inflicted "Run below
 * commands:" — the time/place words below|above|earlier|today|yesterday|
 * tonight were reverted out of the guard for exactly that collision). The
 * `execute` lane is position-independent (there is no noun-"execute" — past
 * tense is "executed", which `execute\s` never matches). Documented
 * miss-direction residuals (the pinned test examples are REPRESENTATIVE, not
 * exhaustive — review round-8 F1: EVERY "run/execute + guard-verb +
 * non-particle continuation" framing classifies instruction, e.g. "the run
 * produced this output:", "the run took 3h.", "the run below:", "the run it
 * produced:", trailing "run:") — command-shaped fabrications skip there,
 * log-shaped still convict.
 */
const QUOTE_RUN_OBSERVED_VERB = String.raw`(?:completed?|failed|finished|returned?|came|ended|succeeded|passed|took|produced|outputs?(?:ted)?|printed?|show(?:s|ed|n)?|yielded|gave|emitted|logged|displayed|was|is|has|had|did|will|would|ran|went|got|itself|logs?)`;
const QUOTE_RUN_OBSERVED_TAIL = String.raw`(?:\s*[,:.]?\s*(?:$|\n)|\s*[.,]\s|\s+(?:back|clean|fine|successfully|miserably|late|early|badly|smoothly|out|off)\b)`;
const QUOTE_INSTRUCTION_RE = new RegExp(
  String.raw`\brun\s+(?!${QUOTE_RUN_OBSERVED_VERB}\b${QUOTE_RUN_OBSERVED_TAIL})\S`
  + String.raw`|\brun\s*:?\s*$`
  + String.raw`|\bexecute\s+(?!${QUOTE_RUN_OBSERVED_VERB}\b${QUOTE_RUN_OBSERVED_TAIL})\S`
  + String.raw`|\bexecute\s*:?\s*$`
  + String.raw`|\b(?:how to run|save|usage|the following|i (?:wrote|created|added|made|put)|reproduce|commands?\s+i\s+(?:ran|used|executed|tried)|scripts?|snippets?|functions?|helpers?|parsers?|aliases?|one-liners?)\b`,
  'i',
);

/**
 * The lines of a quoted block that count as MATCHABLE EVIDENCE: long enough
 * to be distinctive (≥12 normalized chars), not a shell prompt the model
 * retyped (`$ grep …` — commands live in tool_call args, not results), not a
 * bare comment/decorator line — and, ONLY under an instruction-flavoured
 * window, not a command-shaped authored line (SHELL_CMD_START_RE + hint).
 */
function matchableQuoteLines(content: string, instructionWindow: boolean): string[] {
  return content
    .split('\n')
    .map(normalizeQuoteLine)
    .filter((l) => l.length >= 12 && !/^\$\s/.test(l) && !/^(#|\/\/|--)/.test(l) && !/^…?\[truncated/i.test(l))
    .filter((l) => !instructionWindow || !(SHELL_CMD_START_RE.test(l) && SHELL_CMD_HINT_RE.test(l)));
}

export interface UnmatchedQuote {
  /** First unmatched substantial line (the exhibit), ≤120 chars. */
  excerpt: string;
  /** How many substantial lines the block had vs how many matched a real tool result. */
  matched: number;
  total: number;
}

/**
 * GUARD 4 extraction+check: quoted blocks in `text` that are (a) introduced
 * as observed tool/log output and (b) whose substantial lines do NOT ALL
 * appear in this run's tool_results. A genuine quote is a 100% line match —
 * the model can only quote what a tool actually showed it, and whitespace
 * realignment is already normalized away — so ANY unmatched substantial line
 * in an observation-framed "verbatim" block is a lie by construction (review
 * round-3 F2: the old matched*2<total threshold let the incident's own
 * signature through — one fabricated gpqa line padded between two real ones).
 * `extraHaystacks` (the executor's prior-attempt checkpoint tool texts —
 * review round-3 F1) counts as evidence too: a RESUMED run quoting its
 * pre-interrupt log observed those lines in an earlier attempt, and
 * rehydrated `messages` carry them while this attempt's `parts` do not.
 * Empty evidence ⇒ EVERY cued block is unmatched (a zero-tool run quoting
 * observed output is the phantom signature itself).
 */
export function findUnmatchedQuotedOutputs(text: string, parts: MessagePart[], extraHaystacks?: string[]): UnmatchedQuote[] {
  const haystacks: string[] = [];
  for (const p of parts) {
    if (p.type === 'tool_result' && typeof p.result === 'string' && p.result) {
      haystacks.push(p.result.replace(/\s+/g, ' '));
    }
  }
  for (const extra of extraHaystacks ?? []) {
    if (extra) haystacks.push(extra.replace(/\s+/g, ' '));
  }
  const out: UnmatchedQuote[] = [];
  for (const block of extractQuotedBlocks(text)) {
    if (block.info && QUOTE_CODE_LANGS.has(block.info)) continue;
    // The harness-MANDATED ```claims fence is model-authored self-report,
    // never quoted tool output — its truth channel is the claims lane
    // (applyClaimsBlockLane's receipt check), not this quote lane. Scanning it
    // here self-convicts any run whose cue-word line lands above the REQUIRED
    // fence: the {type,ref} JSON can never match a tool result (ticket
    // d0597e02 sightings 1-2 — the strike exhibit was the run's own claims
    // array, scanned because its intro window matched a cue). Skip ONLY the
    // exact opener shape the claims lane recognizes: off-shape variants
    // (```CLAIMS, ```claims extra, ~~~claims) are invisible to the claims
    // lane, so exempting them here too would open a two-lane hole.
    if (block.opener !== null && CLAIMS_FENCE_OPEN_EXACT_RE.test(block.opener)) continue;
    const cue = QUOTE_OBSERVATION_CUE_RE.test(block.window);
    if (!cue) continue;
    if (block.info === 'json' && !QUOTE_STRONG_CUE_RE.test(block.window)) continue;
    if (QUOTE_EXPECTATION_RE.test(block.window) || QUOTE_PAST_RUN_RE.test(block.window) || QUOTE_AUTHORSHIP_RE.test(block.window) || QUOTE_USER_SOURCE_RE.test(block.window)) continue;
    const lines = matchableQuoteLines(block.content, QUOTE_INSTRUCTION_RE.test(block.window));
    if (!lines.length) continue;
    const matched = lines.filter((l) => haystacks.some((h) => h.includes(l))).length;
    if (matched < lines.length) {
      const firstMiss = lines.find((l) => !haystacks.some((h) => h.includes(l)))!;
      out.push({ excerpt: firstMiss.slice(0, 120), matched, total: lines.length });
      if (out.length >= MAX_FLAGGED_QUOTES) break;
    }
  }
  return out;
}

/**
 * Mine a resumed run's checkpoint transcript (OpenAI-format messages) for
 * tool OUTPUT text — the role:'tool' entries' content (string, or text parts
 * of an array). The evidence guard's GUARD 4 haystack is otherwise the
 * CURRENT attempt's parts only (agent.ts rehydrates messages, not parts), so
 * without this a resumed run honestly quoting its pre-interrupt log was
 * convicted (review round-3 F1). Defensive: unknown shapes contribute
 * nothing; never throws.
 */
export function toolTextsFromMessages(messages: unknown): string[] {
  if (!Array.isArray(messages)) return [];
  const out: string[] = [];
  for (const m of messages) {
    if (!m || typeof m !== 'object' || (m as any).role !== 'tool') continue;
    const content = (m as any).content;
    if (typeof content === 'string') {
      if (content) out.push(content);
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (part && typeof part === 'object' && typeof (part as any).text === 'string' && (part as any).text) {
          out.push((part as any).text);
        }
      }
    }
  }
  return out;
}

/**
 * build 2026-10-11 T1 — a RESUMED run's prior-attempt haystack: the checkpoint transcript's tool texts PLUS the
 * original bodies tier-1 context clearing replaced with stubs (`clearedToolTexts`, context-gauge.ts tier1Act — the
 * rehydrated messages carry only the 400-char-head stubs). Without the union a resume honestly quoting a cleared
 * result would be convicted. Defensive; never throws.
 */
export function priorToolTextsFromCheckpoint(cp: { messages?: unknown; clearedToolTexts?: unknown } | null | undefined): string[] {
  if (!cp || typeof cp !== 'object') return [];
  const cleared = Array.isArray(cp.clearedToolTexts) ? cp.clearedToolTexts.filter((t): t is string => typeof t === 'string' && t.length > 0) : [];
  return [...toolTextsFromMessages(cp.messages), ...cleared];
}

/** The GUARD 4 notice: quoted "observations" no tool of this run produced. */
export function renderQuotedOutputNote(unmatched: UnmatchedQuote[]): string {
  const exhibits = unmatched.map((u) => `"${u.excerpt}" (${u.matched}/${u.total} lines matched)`).join('; ');
  return [
    '[HARNESS EVIDENCE GUARD — UNVERIFIED QUOTED OUTPUT]',
    `${unmatched.length} quoted block(s) above are presented as observed tool/log output but match NOTHING in this run's actual tool results: ${exhibits}.`,
    'A quote offered as verbatim observation must exist in a real tool result of the run — an unmatched quote is fabricated evidence. Treat every claim resting on it as NOT DONE until re-observed with a fresh tool call.',
  ].join('\n');
}

// ── Layer 3: GitHub verification (best-effort, NEVER throws) ────────────────

export interface PrVerification {
  number: number;
  state: 'merged' | 'open' | 'closed' | 'missing' | 'unavailable';
  /** The pr_* kinds claimed for this number in the final answer (when provided). */
  claimKinds?: ClaimKind[];
  /**
   * The qualified 'owner/repo' this number was verified against — SET only when
   * the claim text qualified the number with a repo OTHER than the session repo
   * (extractPrRepoQualifiers, ticket 630fadc0); the footer names it.
   */
  repo?: string;
  mergeCommitSha?: string | null;
  mergedAt?: string | null;
  reason?: string;
}

/** https://github.com/o/r(.git) | git@github.com:o/r(.git) | bare 'o/r' → { owner, repo }. */
function parseRepoSlug(repoUrl?: string | null): { owner: string; repo: string } | null {
  const u = (repoUrl ?? '').trim();
  if (!u) return null;
  let m = u.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  if (!m) m = u.match(/^([^/\s]+)\/([^/\s]+)$/); // bare owner/repo
  if (!m) return null;
  return { owner: m[1], repo: m[2] };
}

/** The claimed pr_* kinds for one number as an array, or undefined when no map was provided. */
function claimKindsFor(claimKinds: Map<number, Set<ClaimKind>> | undefined, n: number): ClaimKind[] | undefined {
  const set = claimKinds?.get(n);
  return set && set.size ? Array.from(set) : undefined;
}

const unavailable = (numbers: number[], reason: string, claimKinds?: Map<number, Set<ClaimKind>>): PrVerification[] =>
  numbers.map((n) => ({ number: n, state: 'unavailable' as const, reason, claimKinds: claimKindsFor(claimKinds, n) }));

/**
 * Verify each claimed PR against the GitHub API. Best-effort in every
 * dimension: unparseable/missing repoUrl or non-GitHub provider → 'no GitHub
 * repo'; no stored token → 'no GitHub token'; network/timeout/unexpected
 * status → 'unavailable'. Promise.all over the (≤5) PRs, 8 s per-PR timeout.
 * The optional claimKinds map rides through onto each PrVerification so the
 * footer can render a PER-KIND verdict.
 *
 * repoOverrides (ticket 630fadc0): numbers the claim text qualified with an
 * owner/repo OTHER than the session repo (extractPrRepoQualifiers) are
 * verified against the QUALIFIED repo — an external watch lane's real PR must
 * not 404 into a false FABRICATED verdict against a session repo that never
 * had it. A qualified repo gets ONE existence pre-check per repo (cached): a
 * repo-level 404 (inaccessible/nonexistent) → 'unavailable', NEVER 'missing'
 * — the guard convicts only when the named repo exists AND the PR 404s in it,
 * so the anti-phantom lane is fully preserved for qualified numbers too.
 */
export async function verifyPrClaims(opts: {
  prNumbers: number[];
  claimKinds?: Map<number, Set<ClaimKind>>;
  userId: string;
  repoUrl?: string | null;
  githubLabel?: string | null;
  provider?: string | null;
  repoOverrides?: Map<number, { owner: string; repo: string }>;
  /** Numbers whose claim names an UNRESOLVED sibling repo (extractPrRepoHints) — never adjudicated against the session repo. */
  repoHints?: Map<number, string>;
  fetchImpl?: typeof fetch;
}): Promise<PrVerification[]> {
  const { prNumbers, claimKinds, userId, repoUrl, githubLabel, provider } = opts;
  const numbers = prNumbers.slice(0, MAX_VERIFY_PRS);
  try {
    if (provider !== 'github') return unavailable(numbers, 'no GitHub repo', claimKinds);
    const slug = parseRepoSlug(repoUrl);
    if (!slug) return unavailable(numbers, 'no GitHub repo', claimKinds);

    let token: string | null = null;
    try {
      token = await getValidToken(userId, githubLabel || undefined);
    } catch (err: any) {
      logger.warn(`evidence-guard: getValidToken threw for userId=${userId} (treated as no token): ${err?.message}`);
      token = null;
    }
    if (!token) return unavailable(numbers, 'no GitHub token', claimKinds);

    const doFetch = opts.fetchImpl ?? fetch;
    const ghHeaders = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'digby-evidence-guard',
    };
    const overrides = opts.repoOverrides;
    const sameSlug = (a: { owner: string; repo: string }, b: { owner: string; repo: string }): boolean =>
      a.owner.toLowerCase() === b.owner.toLowerCase() && a.repo.toLowerCase() === b.repo.toLowerCase();
    // External-qualified repos: ONE existence pre-check per repo (cached).
    // true = repo visible (PR 404s inside it may convict); false = repo-level
    // 404 (inaccessible/nonexistent — fail open); null = lookup hiccup (fail open).
    // The cache stores the PROMISE, not the verdict (ticket 6e157e86): the
    // per-PR checks below run CONCURRENTLY via Promise.all, so a result-cache
    // misses for every simultaneous caller and the "ONE pre-check per repo"
    // contract above fired N times for N same-repo numbers (3 duplicate GETs
    // in the incident replay). Promise-caching shares the single in-flight
    // pre-check across all concurrent verifications of the same repo.
    const repoAccessCache = new Map<string, Promise<boolean | null>>();
    const repoAccessible = (owner: string, repo: string): Promise<boolean | null> => {
      const key = `${owner.toLowerCase()}/${repo.toLowerCase()}`;
      const inFlight = repoAccessCache.get(key);
      if (inFlight) return inFlight;
      const check = (async (): Promise<boolean | null> => {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 8000);
        try {
          const res = await doFetch(`https://api.github.com/repos/${owner}/${repo}`, { headers: ghHeaders, signal: ctrl.signal });
          return res.status === 404 ? false : res.ok ? true : null;
        } catch {
          return null;
        } finally {
          clearTimeout(timer);
        }
      })();
      repoAccessCache.set(key, check);
      return check;
    };
    return await Promise.all(numbers.map(async (n): Promise<PrVerification> => {
      const kinds = claimKindsFor(claimKinds, n);
      const qualified = overrides?.get(n);
      // Cross-repo hint without a resolvable slug (rollout watch 2026-09-14):
      // the claim is about a SIBLING repo — the session repo's #n is a different
      // PR or a 404, so adjudicating there convicts honest work. Unverified.
      const hint = !qualified ? opts.repoHints?.get(n) : undefined;
      if (hint) {
        return {
          number: n,
          state: 'unavailable',
          reason: `claim names repo "${hint}" — not this session's repo; write it as owner/repo#${n} (or a github.com/…/pull/${n} link) to verify`,
          claimKinds: kinds,
          repo: hint,
        };
      }
      const external = qualified && !sameSlug(qualified, slug) ? qualified : null;
      const target = external ?? slug;
      const repoTag = external ? `${external.owner}/${external.repo}` : undefined;
      if (external) {
        const accessible = await repoAccessible(external.owner, external.repo);
        if (accessible !== true) {
          return {
            number: n,
            state: 'unavailable',
            reason: accessible === false
              ? `qualified repo ${repoTag} inaccessible (GitHub 404) — cannot adjudicate`
              : `qualified repo ${repoTag} lookup failed — cannot adjudicate`,
            claimKinds: kinds,
            repo: repoTag,
          };
        }
      }
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      try {
        const res = await doFetch(`https://api.github.com/repos/${target.owner}/${target.repo}/pulls/${n}`, {
          headers: ghHeaders,
          signal: ctrl.signal,
        });
        if (res.status === 404) return { number: n, state: 'missing', reason: external ? `GitHub 404 in ${repoTag}` : 'GitHub 404', claimKinds: kinds, repo: repoTag };
        if (!res.ok) return { number: n, state: 'unavailable', reason: `GitHub HTTP ${res.status}`, claimKinds: kinds, repo: repoTag };
        const json: any = await res.json();
        if (json?.merged === true) {
          return {
            number: n,
            state: 'merged',
            claimKinds: kinds,
            repo: repoTag,
            mergeCommitSha: json.merge_commit_sha ?? null,
            mergedAt: json.merged_at ?? null,
          };
        }
        if (json?.state === 'open') return { number: n, state: 'open', claimKinds: kinds, repo: repoTag };
        if (json?.state === 'closed') return { number: n, state: 'closed', claimKinds: kinds, repo: repoTag };
        return { number: n, state: 'unavailable', reason: 'unexpected GitHub payload', claimKinds: kinds, repo: repoTag };
      } catch (err: any) {
        return { number: n, state: 'unavailable', reason: String(err?.message ?? err).slice(0, 120), claimKinds: kinds, repo: repoTag };
      } finally {
        clearTimeout(timer);
      }
    }));
  } catch (err: any) {
    // Belt-and-braces: a verification hiccup must never escape into finalize.
    logger.warn(`evidence-guard: verifyPrClaims failed (treated as unavailable): ${err?.message}`);
    return unavailable(numbers, String(err?.message ?? err).slice(0, 120), claimKinds);
  }
}

/** The pr_* claim kinds, highest-stakes first (merge > close > create). */
type PrClaimKind = Extract<ClaimKind, 'pr_merged' | 'pr_created' | 'pr_closed'>;
const PR_KIND_PRIORITY: PrClaimKind[] = ['pr_merged', 'pr_closed', 'pr_created'];

/** The footer verdict for ONE claimed kind against the REAL GitHub state. */
function prKindVerdict(v: PrVerification, kind: PrClaimKind): { ok: boolean; text: string } {
  const sha = v.mergeCommitSha?.slice(0, 12);
  switch (v.state) {
    case 'merged':
      if (kind === 'pr_merged') return { ok: true, text: `✅ VERIFIED MERGED on GitHub: sha ${sha}…, merged_at ${v.mergedAt}` };
      if (kind === 'pr_created') return { ok: true, text: `✅ VERIFIED — PR exists and is in fact MERGED (sha ${sha}…, merged_at ${v.mergedAt})` };
      return { ok: true, text: '✅ VERIFIED CLOSED (merged)' };
    case 'open':
      if (kind === 'pr_created') return { ok: true, text: '✅ VERIFIED OPEN (create claim confirmed)' };
      if (kind === 'pr_merged') return { ok: false, text: '❌ UNVERIFIED merge claim: GitHub says this PR is still OPEN' };
      return { ok: false, text: '❌ UNVERIFIED close claim: GitHub says this PR is still OPEN' };
    case 'closed':
      if (kind === 'pr_closed') return { ok: true, text: '✅ VERIFIED CLOSED (close claim confirmed; not merged)' };
      if (kind === 'pr_merged') return { ok: false, text: '❌ UNVERIFIED: PR is CLOSED but NOT merged' };
      return { ok: true, text: '✅ VERIFIED — PR exists (closed, not merged)' };
    case 'missing':
      return { ok: false, text: '❌ UNVERIFIED: GitHub has NO such PR (404) — the claim is fabricated' };
    default:
      return { ok: false, text: `⚠︎ could not be verified (${v.reason ?? 'unknown'}) — treat the claim as unverified` };
  }
}

/**
 * The guard-2 footer: ONE line per claimed PR with its verdict against the
 * REAL GitHub state, rendered PER CLAIMED KIND (extractPrClaimKinds — a
 * verification without kinds defaults to a merge claim, the legacy reading).
 * Multiple kinds on one number still render ONE line: if ANY claimed kind
 * mismatches GitHub, the STRONGEST mismatch wins (a merge-claim mismatch is
 * the strongest); otherwise the highest-stakes ✅ confirmation is the receipt.
 */
export function renderVerificationFooter(vs: PrVerification[], now: Date): string {
  const lines = ['---', `🔍 Harness claim verification (verified-at ${now.toISOString()}):`];
  for (const v of vs) {
    const claimed = (v.claimKinds?.filter((k): k is PrClaimKind => k.startsWith('pr_')) ?? []);
    const kinds: PrClaimKind[] = claimed.length ? claimed : ['pr_merged'];
    const verdicts = kinds.map((kind) => ({ kind, ...prKindVerdict(v, kind) }));
    const pickHighestStakes = (pool: typeof verdicts) =>
      PR_KIND_PRIORITY.map((k) => pool.find((x) => x.kind === k)).find((x) => x !== undefined)!;
    const failing = verdicts.filter((x) => !x.ok);
    const chosen = failing.length ? pickHighestStakes(failing) : pickHighestStakes(verdicts);
    lines.push(`• PR #${v.number}${v.repo ? ` (${v.repo})` : ''} — ${chosen.text}`);
  }
  return lines.join('\n');
}

// ── Layer 3b: push-claim verification (commit_pushed shas) ──────────────────

/** Cap on commit-API calls per final answer (one GET per sha). */
export const MAX_VERIFY_SHAS = 5;

export interface PushVerification {
  sha: string;
  state: 'present' | 'missing' | 'unavailable';
  /**
   * What sourced the sha: the claim text, or a harness receipt (softer
   * rendering — a receipt-cited sha that 404s is amended history, not a model
   * fabrication). 'local' (finding A1, 2026-09-27): a commit_local claim
   * ("banked/committed <sha>") — a 404 renders "LOCAL ONLY — not pushed"
   * (verdict.localOnlyShas, observe-only), never a fabrication conviction.
   * Only git_push receipts enter as 'receipt' now; a git_commit receipt is
   * local and is never "confirmed on origin" by the harness.
   */
  source: 'claim' | 'receipt' | 'local';
  reason?: string;
}

/**
 * Verify claimed/receipted push shas against the GitHub COMMITS API
 * (GET /repos/{owner}/{repo}/commits/{sha}) — the primary-source lane
 * commit_pushed never had (run-receipts follow-up: wider re-query). The model
 * can invent a plausible sha prefix; it cannot conjure one INTO the repo.
 * Same discipline as verifyPrClaims: non-GitHub/no-slug/no-token → all
 * 'unavailable'; 404 → 'missing'; a 422 whose body is "No commit found for
 * SHA" on a FULL 40-hex CLAIM-sourced sha → 'missing' (ticket 5200f182: the
 * commits API answers a nonexistent sha in an EXISTING repo with 422 — 404 is
 * the repo-level answer — and the incident's two fabricated full-sha push
 * claims escaped the conviction lane as 'unavailable' advisory; RSW-1 2026-10-30
 * deleted the PUSH_CLAIM_422_CONVICT_DISABLED kill switch — it was NF_INERT,
 * never forwarded in docker-compose.app.yml, so prod only ever ran the
 * conviction branch); any other status
 * (a 422 on a SHORT ref — GitHub refuses to resolve very short prefixes even
 * of existing commits — or a 422 with a different body message, e.g.
 * validation/spam) /network/timeout → 'unavailable'. NEVER throws.
 */
export async function verifyPushClaims(opts: {
  shas: Array<{ sha: string; source: PushVerification['source'] }>;
  userId: string;
  repoUrl?: string | null;
  githubLabel?: string | null;
  provider?: string | null;
  fetchImpl?: typeof fetch;
}): Promise<PushVerification[]> {
  const shas = opts.shas.slice(0, MAX_VERIFY_SHAS);
  const silent = (reason: string): PushVerification[] => shas.map((s) => ({ ...s, state: 'unavailable' as const, reason }));
  try {
    if (opts.provider !== 'github') return silent('no GitHub repo');
    const slug = parseRepoSlug(opts.repoUrl);
    if (!slug) return silent('no GitHub repo');

    let token: string | null = null;
    try {
      token = await getValidToken(opts.userId, opts.githubLabel || undefined);
    } catch (err: any) {
      logger.warn(`evidence-guard: getValidToken threw for userId=${opts.userId} (treated as no token): ${err?.message}`);
      token = null;
    }
    if (!token) return silent('no GitHub token');

    const doFetch = opts.fetchImpl ?? fetch;
    return await Promise.all(shas.map(async ({ sha, source }): Promise<PushVerification> => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      try {
        const res = await doFetch(`https://api.github.com/repos/${slug.owner}/${slug.repo}/commits/${sha}`, {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'digby-evidence-guard',
          },
          signal: ctrl.signal,
        });
        if (res.status === 404) return { sha, state: 'missing', source, reason: 'GitHub 404' };
        // Ticket 5200f182 (2026-10-20): the commits API answers a nonexistent
        // sha in an EXISTING repo with 422 "No commit found for SHA" (404 is
        // the repo-level answer; live-probed 2026-10-21: both incident shas
        // 422, a real main sha 200, and a real sha NOT reachable from main —
        // a pushed session branch — ALSO 200, so 422 is not a
        // reachable-only answer). A FULL 40-hex ref is exact by definition,
        // so a no-such-commit 422 there is definitive nonexistence and
        // convicts like a 404. Guarded on BOTH the exact body message (GitHub
        // also 422s "Validation failed, or the endpoint has been spammed" —
        // a different message must NOT convict) and a kill switch. A SHORT
        // ref's 422 stays 'unavailable': GitHub declines to resolve very
        // short prefixes even of existing commits (live probe: 4-hex prefix
        // of a real commit → 422), so a short-ref 422 is ambiguous, never
        // proof. Receipt/local sources are excluded (amended-history /
        // local-only are softer classes with their own renderings).
        if (
          res.status === 422 && source === 'claim'
          && /^[0-9a-f]{40}$/i.test(sha.trim())
        ) {
          let noSuchCommit = false;
          try {
            const body: unknown = await res.json();
            noSuchCommit = typeof (body as { message?: unknown })?.message === 'string'
              && /^No commit found for SHA/i.test((body as { message: string }).message);
          } catch { /* unparseable body → not provable → unavailable */ }
          if (noSuchCommit) return { sha, state: 'missing', source, reason: 'GitHub 422 — no such commit' };
        }
        if (!res.ok) return { sha, state: 'unavailable', source, reason: `GitHub HTTP ${res.status}` };
        return { sha, state: 'present', source };
      } catch (err: any) {
        return { sha, state: 'unavailable', source, reason: String(err?.message ?? err).slice(0, 120) };
      } finally {
        clearTimeout(timer);
      }
    }));
  } catch (err: any) {
    logger.warn(`evidence-guard: verifyPushClaims failed (treated as unavailable): ${err?.message}`);
    return silent(String(err?.message ?? err).slice(0, 120));
  }
}

/**
 * The push-claim footer: one line per CHECKED sha ('unavailable' shas are
 * filtered by the caller — the lane stays silent on infra failure). A
 * claim-sourced 404 is a fabrication conviction; a receipt-sourced 404 is
 * amended/force-pushed history — rendered as a caution, never a conviction.
 */
export function renderPushVerificationFooter(vs: PushVerification[]): string {
  const lines = ['---', '🔍 Harness push-claim verification (commits API):'];
  for (const v of vs) {
    const short = v.sha.slice(0, 12);
    if (v.state === 'present') {
      lines.push(`• ${short}… — ✅ EXISTS on origin (commit found in the repo)${v.source === 'receipt' ? ' (harness receipt confirmed)' : ''}`);
    } else if (v.state === 'missing' && v.source === 'receipt') {
      lines.push(`• ${short}… — ⚠︎ receipt-cited sha NOT on origin (404) — amended/force-pushed history? The commit WAS recorded by the harness; treat the CLAIM it backs as stale, not fabricated`);
    } else if (v.state === 'missing' && v.source === 'local') {
      lines.push(`• ${short}… — ⚠︎ LOCAL ONLY — commit not on origin (404): described as banked/committed but no push carried it; treat it as NOT PUSHED (the commit may exist only in the session worktree)`);
      // (wording pinned by run-evidence-guard.commit-local.test.ts)
    } else {
      // Ticket 5200f182: a 422-derived 'missing' (full 40-hex sha, existing
      // repo) must render its true status — the parenthetical is the evidence
      // the model and the strike excerpt quote. 404 keeps its pinned wording.
      const code = /422/.test(v.reason || '') ? '422' : '404';
      lines.push(`• ${short}… — ❌ UNVERIFIED: no such commit on origin (${code}) — the push claim is fabricated`);
    }
  }
  return lines.join('\n');
}

// ── Layer 3c: deploy-run + ticket-id cross-checks (ticket 8e9d6496) ─────────

/**
 * The 2026-08-29 nightly-lane cluster (ticket 8e9d6496): FOUR fabrication-class
 * finals in one night, and two classes sailed past every existing lane —
 *   1. "claimed PR #481 / sha 253b7473 / deploy 33236656591" — the Actions run
 *      id was INVENTED (404 on fresh pulls); no lane extracted deploy-run ids.
 *   2. "deploy 33236939738 completed success at 06:30:44Z" claimed at ~06:17Z —
 *      "completed success" matches NO DEPLOY_OK_RE alternative, so the line
 *      produced no ClaimKind and the claims-gate early return skipped every
 *      primary-source lane (only guard 3's future stamp fired).
 *   3. "11-ticket open batch: 01226f89 / 4de4a5ef" — invented FEEDBACK-TICKET
 *      ids; nothing mined or verified ticket citations either.
 * GUARD 5 (deploy runs) and GUARD 6 (ticket ids) close both with the same
 * two-lane discipline: the claim→journal lane first (an id this run's OWN
 * tool evidence carries was OBSERVED, not claimed — receipts/tool outputs
 * vouch for it), then a primary-source check (GitHub Actions API for run
 * ids; the feedback store via an INJECTED resolver for ticket ids — this
 * module keeps its no-prisma discipline). A citation neither the journal nor
 * the primary source vouches for is a fabricated claim.
 */

/**
 * Refutation/audit context (either lane): a line REPORTING someone else's
 * fabrication ("phantom claim: deploy 33236656591 completed success — 404 on
 * fresh pull", "the prior run cited invented ticket ids 01226f89 / …") never
 * asserts a claim of its own. Per-occurrence negation-checked, so an evasive
 * "not phantom: deploy X completed success" does NOT escape (the same
 * anti-laundering discipline as the review-A1 pin on the quoted-void lane).
 * The claimed/reported/stated/asserted/wrote cues (review N1, 9dff051c):
 * the nightly audit loop discusses prior fabrications constantly ("the prior
 * run claimed deploy 33236656591 completed success") — accepted evasion
 * tradeoff, conviction-side precision over recall, same as the phantom|
 * invented|fabricated cues above: a model phrasing EVERY claim as "claimed
 * X" escapes this lane but still faces guards 1/2/2b/3/4.
 */
const REFUTATION_CONTEXT_RE = /\b(?:phantom|invented|fabricat\w+|refut\w+|bogus|fake|nonexistent|non-existent|claimed|reported|stated|asserted|wrote)\b/gi;

/** True iff the line audits/refutes a fabrication (a negation-free cue). */
function lineHasRefutationContext(line: string): boolean {
  for (const m of line.matchAll(new RegExp(REFUTATION_CONTEXT_RE.source, 'gi'))) {
    if (m.index !== undefined && !negatedBefore(line, m.index)) return true;
  }
  return false;
}

/**
 * GitHub Actions run ids in a deploy/run context. 11–12 digits ONLY: current
 * run ids are 11 digits (the repo's own deploys in the incident: 33236656591 /
 * 33236939738), and the floor deliberately excludes 10-digit unix timestamps —
 * an honest "deploy at 1787991318" must never be extracted as a run id and
 * convicted by its inevitable 404. No bare "run <id>" alternative either: only
 * deploy/workflow/actions/ci-qualified ids reach the conviction lane.
 */
const DEPLOY_RUN_ID_RE = /\b(?:deploy(?:ment|ed)?(?:[-\s]run)?|workflow\s+run|actions\/runs\/|actions\s+run|ci\s+run)\s*#?\s*(\d{11,12})\b/i;

/**
 * State cues that turn a run-id MENTION into a state CLAIM (scanned in an
 * ~80-char window around the id; the highest-stakes cue at the closest
 * distance wins). "completed success" is the nightly incident's phrasing; a
 * bare "completed" claims only terminality, not success.
 */
const DEPLOY_SUCCESS_CUE_RE = /\b(?:completed?\s+success(?:fully)?|succeeded|success|green|passed|healthy|live|flipped)\b/i;
const DEPLOY_FAILURE_CUE_RE = /\b(?:failed|failure|cancelled|canceled|timed?[ -]?out)\b/i;
const DEPLOY_COMPLETED_CUE_RE = /\bcompleted\b/i;
const DEPLOY_RUN_STATE_WINDOW_CHARS = 80;
/**
 * Absence-cue suppression (review N1, 9dff051c — GUARD 6 parity): "deploy
 * 33236656591 completed success — 404 on fresh pull" is an absence REPORT
 * about a prior claim, not a claim. Checked in the ~64 chars after the id.
 */
const DEPLOY_ABSENCE_AFTER_RE = /(?:→|⇒|:|=|—|--|\bis\b|\bwas\b|\bare\b|\bstill\b)\s*(?:https?\s*)?(?:all\s+)?(?:404\b|not found|doesn'?t exist|does not exist|no such|phantom|invented|fabricated|missing)\b/i;
/**
 * Watch/wait vocabulary scopes a state cue to the FUTURE ("waiting for deploy
 * 33236939738 to go green") — wider than INTENT_BEFORE_VERB_RE, local to this
 * lane so the house intent set stays untouched. "should" (review N3): "…is
 * still running, should go green soon" is a projection, not an observation.
 */
const DEPLOY_WATCH_CUE_RE = /\b(?:watch(?:ing|es)?|await(?:s|ing)?|wait(?:s|ing)?|until|tracking|poll(?:s|ing|ed)?|should)\b/i;

export type DeployRunClaimedState = 'success' | 'failure' | 'completed';

export interface DeployRunClaim {
  runId: string;
  claimedState: DeployRunClaimedState;
  /** The final-answer line the claim was lifted from (trimmed). */
  text: string;
}

const MAX_DEPLOY_RUN_CLAIMS = 8;

/**
 * The deploy-run state claims in a final answer. Pure. Suppressions mirror
 * the house idiom: windowed negation (~40 chars before the cue), windowed
 * intent (~48 chars before), watch/wait scoping, the quoted-void exemption
 * (ticket 80dd882d), and the refutation-context line skip above.
 */
export function extractDeployRunClaims(text: string): DeployRunClaim[] {
  const out: DeployRunClaim[] = [];
  if (!text) return out;
  const deployLines = text.split('\n').map((l) => l.trim());
  const voidQuoteExempt = quotedVoidExemptions(deployLines); // block-local (2026-09-08), same rule as findFutureDatedClaims
  const seen = new Set<string>();
  const cues: Array<{ state: DeployRunClaimedState; rank: number; re: RegExp }> = [
    { state: 'success', rank: 3, re: DEPLOY_SUCCESS_CUE_RE },
    { state: 'failure', rank: 2, re: DEPLOY_FAILURE_CUE_RE },
    { state: 'completed', rank: 1, re: DEPLOY_COMPLETED_CUE_RE },
  ];
  for (let li = 0; li < deployLines.length; li++) {
    const line = deployLines[li];
    if (!line) continue;
    if (voidQuoteExempt[li]) continue; // quoted-void exemption (block-local)
    if (lineHasRefutationContext(line)) continue; // an audit line, not a claim
    for (const m of line.matchAll(new RegExp(DEPLOY_RUN_ID_RE.source, 'gi'))) {
      const runId = m[1];
      if (seen.has(runId) || out.length >= MAX_DEPLOY_RUN_CLAIMS) continue;
      const idStart = (m.index ?? 0) + m[0].length - runId.length;
      const idEnd = idStart + runId.length;
      // Absence-cue suppression (review N1): "deploy 33236656591 completed
      // success — 404 on fresh pull" is an absence REPORT, not a claim.
      const afterId = line.slice(idEnd, Math.min(line.length, idEnd + 64));
      if (DEPLOY_ABSENCE_AFTER_RE.test(afterId)) continue;
      // Clause scoping (review N2): a state cue must sit in the SAME clause
      // as the id — "All checks passed; watching deploy 33236939738" must not
      // attribute clause-1's "passed" to the id.
      const idClauseStart = clauseStartBefore(line, idStart);
      let idClauseEnd = line.length;
      for (const bm of line.slice(idStart).matchAll(new RegExp(CLAUSE_SPLIT_RE.source, 'g'))) {
        idClauseEnd = idStart + (bm.index ?? 0);
        break;
      }
      const winFrom = Math.max(0, idStart - DEPLOY_RUN_STATE_WINDOW_CHARS);
      const winTo = Math.min(line.length, idEnd + DEPLOY_RUN_STATE_WINDOW_CHARS);
      const win = line.slice(winFrom, winTo);
      let best: { state: DeployRunClaimedState; dist: number; rank: number } | null = null;
      for (const cue of cues) {
        for (const cm of win.matchAll(new RegExp(cue.re.source, 'gi'))) {
          const abs = winFrom + (cm.index ?? 0);
          if (abs < idClauseStart || abs >= idClauseEnd) continue; // another clause's cue (review N2)
          if (negatedBefore(line, abs) || intentBeforeVerb(line, abs)) continue;
          const watchFrom = Math.max(clauseStartBefore(line, abs), abs - INTENT_VERB_WINDOW_CHARS);
          if (DEPLOY_WATCH_CUE_RE.test(line.slice(watchFrom, abs))) continue;
          const dist = Math.abs(abs - idStart);
          if (!best || dist < best.dist || (dist === best.dist && cue.rank > best.rank)) {
            best = { state: cue.state, dist, rank: cue.rank };
          }
        }
      }
      if (!best) continue; // a bare mention ("watching deploy 33236939738") claims nothing
      seen.add(runId);
      out.push({ runId, claimedState: best.state, text: line });
    }
  }
  return out;
}

/** Cap on Actions-API calls per final answer (one GET per run id). */
export const MAX_VERIFY_DEPLOY_RUNS = 5;

/** Cue-association window for deploy-run ids in tool-output haystacks. */
const DEPLOY_HAYSTACK_WINDOW_CHARS = 120;

/**
 * Same-line foreign ids are sought within 4× the cue window: every real gh
 * output shape (compact --json arrays ~26 chars, tables, gh run view blocks)
 * puts a same-line neighbour's id within a few dozen chars of ours, so a
 * "cue belongs to the nearest preceding id" check beyond that distance is
 * meaningless for any real shape while the bound keeps scans O(1)/occurrence.
 */
const FOREIGN_LINE_SPAN_CHARS = 4 * DEPLOY_HAYSTACK_WINDOW_CHARS;

/** Run-id-shaped tokens — GitHub Actions run ids are 9-12 digits — separate records. */
const FOREIGN_RUN_TOKEN_RE = /\b\d{9,12}\b/g;

interface ForeignRunToken { start: number; end: number; }

/**
 * Other run-id-shaped tokens in [from,to) that are NOT the claimed id.
 * Repeats of the claimed id stay same-record (`gh run view` prints it on
 * several lines). 13-digit epoch-ms runs cannot match (\b has no internal
 * edge inside a digit run); 9-12 digit NON-id numbers (epoch seconds, aws
 * account ids) may create phantom records — that only costs an Actions-API
 * call, never a conviction.
 */
function foreignRunIdTokens(h: string, from: number, to: number, runId: string): ForeignRunToken[] {
  const out: ForeignRunToken[] = [];
  // Whole-haystack calls skip the slice copy (per claim × haystack, the copy
  // would dominate); window calls slice (≤ ~480 chars).
  const direct = from === 0 && to >= h.length;
  const scope = direct ? h : h.slice(from, to);
  for (const m of scope.matchAll(FOREIGN_RUN_TOKEN_RE)) {
    if (m[0] === runId) continue;
    out.push({ start: from + (m.index ?? 0), end: from + (m.index ?? 0) + m[0].length });
  }
  return out;
}

/**
 * The INNERMOST {...} object enclosing offset `idx` in `h`, or null when no
 * object opens within the cue window. `end` is null when no closing brace is
 * found within the cue window (long object): the left bound still applies.
 * Structural brace matching — NOT JSON-string aware: a brace inside a quoted
 * value can defeat it, in which case the foreign-run bound still guards the
 * id. Both scans are CLAMPED to the cue window: an object edge beyond ±120
 * can never bound an attributable cue, so the clamp is semantics-preserving
 * and keeps the scan O(1) per id occurrence (an unclamped backward scan is
 * quadratic in the finalize path — review B2, 2026-10-23).
 */
function enclosingJsonObject(h: string, idx: number, fwdClamp: number): { start: number; end: number | null } | null {
  const back = Math.max(0, idx - DEPLOY_HAYSTACK_WINDOW_CHARS);
  let depth = 0;
  let start = -1;
  for (let i = idx - 1; i >= back; i--) {
    const c = h[i];
    if (c === '}') depth++;
    else if (c === '{') {
      if (depth === 0) { start = i; break; }
      depth--;
    }
  }
  if (start === -1) return null;
  depth = 1;
  for (let i = start + 1; i < h.length && i <= fwdClamp; i++) {
    const c = h[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return { start, end: i + 1 };
    }
  }
  return { start, end: null };
}

/**
 * Does a tool-output haystack show this run id together with a cue for the
 * CLAIMED state — in the id's OWN record? (Finding D, 2026-10-23: the window
 * is RECORD-SCOPED, never a raw ±120 chars: a compact `gh run list --json`
 * array puts the NEIGHBOR object ~26 chars from our id, and a `gh run list`
 * table puts the next row one newline away — either way a neighbour record's
 * state cue used to launder the claimed run's "completed success" claim.)
 * Record bounds, tightest wins:
 *   - JSON object bound: when the id occurrence sits inside a {...} object,
 *     only cues inside that (innermost) object count. The foreign-run bound
 *     is SKIPPED here: a real `gh api` object carries other 9-12 digit
 *     fields (check_suite_id) that are not records (review M2).
 *   - Foreign-run bound: when ANY other run-id-shaped token exists in the
 *     haystack (whole haystack, not just the window — a verbose `gh run
 *     view` block puts the neighbour's ID >120 chars away while its CUE
 *     stays inside the window; review B1), the haystack is multi-record:
 *     scope to the id's own line, and a cue is attributable only when no
 *     foreign id sits between it and ours, and no foreign id precedes a cue
 *     that precedes our id (in-window tokens, recomputed AFTER the
 *     narrowing — review M1).
 * Every bound only TIGHTENS: a miss falls through to the Actions-API lane
 * (the primary source, capped at MAX_VERIFY_DEPLOY_RUNS, 'unavailable'
 * silent) — never a lost conviction. All per-occurrence scans are clamped
 * (cue window ±120, same-line foreigns ±480) so the cost is O(1) per
 * occurrence; the whole-haystack foreign scan runs once per call, lazily on
 * the first occurrence (review B2).
 */
export function haystackShowsDeployState(h: string, runId: string, state: DeployRunClaimedState): boolean {
  const cue = state === 'success' ? /\b(?:success|succeeded|completed\W+success|"conclusion"\s*:\s*"success")\b/i
    : state === 'failure' ? /\b(?:failure|failed|cancelled|canceled|timed?[ -]?out|"conclusion"\s*:\s*"(?:failure|cancelled|timed_out)")\b/i
      : /\b(?:completed|"status"\s*:\s*"completed")\b/i;
  const cueRe = new RegExp(cue.source, 'gi');
  let multiRecord: boolean | null = null; // lazy: only once the id actually occurs
  let from = 0;
  for (;;) {
    const idx = h.indexOf(runId, from);
    if (idx === -1) return false;
    if (multiRecord === null) multiRecord = foreignRunIdTokens(h, 0, h.length, runId).length > 0;
    const idEnd = idx + runId.length;
    let fromIdx = Math.max(0, idx - DEPLOY_HAYSTACK_WINDOW_CHARS);
    let toIdx = Math.min(h.length, idEnd + DEPLOY_HAYSTACK_WINDOW_CHARS);
    let betweenForeign: ForeignRunToken[] = [];
    const obj = enclosingJsonObject(h, idx, toIdx);
    if (obj) {
      fromIdx = Math.max(fromIdx, obj.start);
      if (obj.end !== null) toIdx = Math.min(toIdx, obj.end);
    } else if (multiRecord) {
      // Multi-record haystack: the id's own line only. Line scans are
      // clamped to the cue window — a line edge beyond ±120 can never bound
      // an attributable cue (same clamp argument as the brace scans).
      for (let i = idx - 1; i >= fromIdx; i--) if (h[i] === '\n') { fromIdx = i + 1; break; }
      for (let i = idEnd; i < toIdx; i++) if (h[i] === '\n') { toIdx = i; break; }
      betweenForeign = foreignRunIdTokens(h, Math.max(fromIdx, idx - FOREIGN_LINE_SPAN_CHARS), Math.min(toIdx, idEnd + FOREIGN_LINE_SPAN_CHARS), runId);
    }
    const window = h.slice(fromIdx, toIdx);
    for (const cm of window.matchAll(cueRe)) {
      const p = fromIdx + (cm.index ?? 0); // cue position, haystack coords
      // A foreign id between the cue and ours separates the records.
      if (betweenForeign.some((f) => (p < f.start && f.end <= idx) || (idEnd <= f.start && f.start < p))) continue;
      // A cue BEFORE our id belongs to the nearest preceding id — if any
      // foreign id precedes it ("39976709930 success · 39976710021 …"), the
      // cue is that record's state, not ours.
      if (p < idx && betweenForeign.some((f) => f.end <= p)) continue;
      return true;
    }
    from = idEnd;
  }
}

export interface DeployRunVerification {
  runId: string;
  claimedState: DeployRunClaimedState;
  state: 'confirmed' | 'missing' | 'refuted' | 'unavailable';
  /** GitHub's own state for an existing run ("completed/failure", "in_progress"). */
  actual?: string;
  reason?: string;
}

/**
 * Verify deploy-run claims against the GitHub ACTIONS API
 * (GET /repos/{owner}/{repo}/actions/runs/{id}) — the primary-source lane
 * deploy claims never had (ticket 8e9d6496). The model can invent a plausible
 * 11-digit id; it cannot conjure one INTO the repo's Actions history. Same
 * discipline as verifyPushClaims: non-GitHub/no-slug/no-token → all
 * 'unavailable'; 404 → 'missing'; any other status/network/timeout →
 * 'unavailable'. NEVER throws.
 *
 * Refutation rules (a run that EXISTS): a SUCCESS claim is refuted unless the
 * run is completed+success; a bare COMPLETED claim is refuted unless the run
 * is completed (any conclusion — "completed" stays literally true even for a
 * failure); a FAILURE claim is refuted only by an actual success
 * (conservative — failure claims are the honesty direction).
 */
export async function verifyDeployRunClaims(opts: {
  claims: DeployRunClaim[];
  userId: string;
  repoUrl?: string | null;
  githubLabel?: string | null;
  provider?: string | null;
  fetchImpl?: typeof fetch;
}): Promise<DeployRunVerification[]> {
  const claims = opts.claims.slice(0, MAX_VERIFY_DEPLOY_RUNS);
  const silent = (reason: string): DeployRunVerification[] =>
    claims.map((c) => ({ runId: c.runId, claimedState: c.claimedState, state: 'unavailable' as const, reason }));
  try {
    if (opts.provider !== 'github') return silent('no GitHub repo');
    const slug = parseRepoSlug(opts.repoUrl);
    if (!slug) return silent('no GitHub repo');

    let token: string | null = null;
    try {
      token = await getValidToken(opts.userId, opts.githubLabel || undefined);
    } catch (err: any) {
      logger.warn(`evidence-guard: getValidToken threw for userId=${opts.userId} (treated as no token): ${err?.message}`);
      token = null;
    }
    if (!token) return silent('no GitHub token');

    const doFetch = opts.fetchImpl ?? fetch;
    return await Promise.all(claims.map(async (c): Promise<DeployRunVerification> => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      try {
        const res = await doFetch(`https://api.github.com/repos/${slug.owner}/${slug.repo}/actions/runs/${c.runId}`, {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'digby-evidence-guard',
          },
          signal: ctrl.signal,
        });
        if (res.status === 404) return { runId: c.runId, claimedState: c.claimedState, state: 'missing', reason: 'GitHub 404' };
        if (!res.ok) return { runId: c.runId, claimedState: c.claimedState, state: 'unavailable', reason: `GitHub HTTP ${res.status}` };
        const json: any = await res.json();
        const status = String(json?.status ?? '');
        const conclusion = json?.conclusion == null ? '' : String(json.conclusion);
        const actual = conclusion ? `${status}/${conclusion}` : (status || 'unknown');
        const succeeded = status === 'completed' && conclusion === 'success';
        const completed = status === 'completed';
        const refuted = c.claimedState === 'success' ? !succeeded
          : c.claimedState === 'completed' ? !completed
          : succeeded; // failure claim: refuted only by an actual success
        return { runId: c.runId, claimedState: c.claimedState, state: refuted ? 'refuted' : 'confirmed', actual };
      } catch (err: any) {
        return { runId: c.runId, claimedState: c.claimedState, state: 'unavailable', reason: String(err?.message ?? err).slice(0, 120) };
      } finally {
        clearTimeout(timer);
      }
    }));
  } catch (err: any) {
    logger.warn(`evidence-guard: verifyDeployRunClaims failed (treated as unavailable): ${err?.message}`);
    return silent(String(err?.message ?? err).slice(0, 120));
  }
}

/**
 * The deploy-run footer: one line per CHECKED run id ('unavailable' entries
 * are filtered by the caller — the lane stays silent on infra failure).
 */
export function renderDeployVerificationFooter(vs: DeployRunVerification[]): string {
  const lines = ['---', '🔍 Harness deploy-run verification (GitHub Actions API):'];
  for (const v of vs) {
    if (v.state === 'confirmed') {
      lines.push(`• run ${v.runId} — ✅ EXISTS on GitHub Actions (${v.actual ?? 'state unread'})`);
    } else if (v.state === 'missing') {
      lines.push(`• run ${v.runId} — ❌ UNVERIFIED: no such GitHub Actions run (404) — the deploy claim is fabricated`);
    } else if (v.state === 'refuted') {
      lines.push(`• run ${v.runId} — ❌ REFUTED: the claim says "${v.claimedState}" but GitHub Actions shows ${v.actual ?? 'a different state'}`);
    }
  }
  return lines.join('\n');
}

// ── Layer 3d: feedback-ticket-id citations (guard 6, ticket 8e9d6496) ───────

/**
 * Feedback-ticket citations. Incident 3 of the 2026-08-29 cluster: an
 * "11-ticket open batch" citing INVENTED ids 01226f89 / 4de4a5ef — no such
 * rows in the feedback store. Two citation shapes on a /\bticket/i line:
 *   (a) a full uuid anywhere on the line;
 *   (b) an 8-hex PREFIX chain after a "ticket(s) [id(s)/number(s)]" cue —
 *       "tickets 01226f89 / 4de4a5ef", "ticket ids: 01226f89, 4de4a5ef and
 *       be199e93" — tokens consumed while the gap between them is only
 *       separators (, / ; · parens, optional "and").
 * Precision guards (all conviction-side; misses are acceptable, false
 * convictions are not): sha/commit/deploy/run/pr cues IMMEDIATELY before a
 * token keep it out ("merge sha fb4ab3bd" is not a ticket citation); an
 * ABSENCE cue right after a token ("ticket 01226f89 → 404") makes the
 * citation an honest refutation report; an "ALL 404"-style plural cue drops
 * the whole chain; date-shaped 8-DIGIT tokens are not hex ids; and the
 * windowed negation/intent + quoted-void + refutation-context suppressions
 * match guard 5.
 */
const TICKET_LINE_RE = /\bticket/i;
const TICKET_UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
const TICKET_CUE_RE = /\bticket(?:s|ed|ing)?(?:[- ](?:id|number)s?)?\s*[:#]?\s*\(?/i;
const TICKET_TOKEN_AT_RE = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{8})\b/i;
const TICKET_CHAIN_GAP_RE = /^[\s,;/·)]*(?:and\s+)?\(?/i;
const TICKET_PREFIX_NEEDS_LETTER_RE = /[a-f]/i;
const TICKET_ID_EXCLUDE_BEFORE_RE = /(?:sha|commit|merge|deploy|run|pr|pull)\s*[:#]?\s*$/i;
const TICKET_ABSENCE_AFTER_RE = /(?:→|⇒|:|=|—|--|\bis\b|\bwas\b|\bare\b|\bstill\b)\s*(?:https?\s*)?(?:all\s+)?(?:404\b|not found|doesn'?t exist|does not exist|no such|phantom|invented|fabricated|missing)\b/i;
const TICKET_PLURAL_ABSENCE_RE = /(?:→|⇒|:|=|—|--|\bis\b|\bare\b)\s*(?:http\s*)?all\s+(?:404\b|not found|doesn'?t exist|does not exist|no such|phantom|invented|fabricated|missing)\b/i;
const TICKET_CHAIN_WINDOW_CHARS = 160;
const MAX_CITED_TICKET_IDS = 10;

export interface TicketIdCitation {
  /** Lowercased cited id (full uuid or 8-hex prefix). */
  id: string;
  /** The final-answer line the citation was lifted from (trimmed). */
  text: string;
  /**
   * True when this is a TYPED claims-fence ticket_update ref, not prose
   * (ticket dc636d0c). The claims vocabulary (claims-block.ts) documents
   * ticket_update refs as ids.ticketId | ids.goalId | ids.todoId — the
   * closest available type for a lane whose ledger writes were goal/todo
   * mutations. GUARD 6 therefore resolves fence refs against the UNION of
   * the feedback store and the goal/todo boards, while PROSE citations
   * ("tickets 01226f89 / 4de4a5ef" batch claims) stay feedback-store-only
   * so the 8e9d6496 batch-fabrication recall is untouched.
   */
  fromClaimsFence?: boolean;
}

/** The feedback-ticket ids cited in a final answer. Pure. */
export function extractTicketIdCitations(text: string): TicketIdCitation[] {
  const out: TicketIdCitation[] = [];
  if (!text) return out;
  const ticketLines = text.split('\n').map((l) => l.trim());
  const voidQuoteExempt = quotedVoidExemptions(ticketLines); // block-local (2026-09-08)
  const seen = new Set<string>();
  const push = (id: string, line: string, fromClaimsFence = false): void => {
    const k = id.toLowerCase();
    if (out.length >= MAX_CITED_TICKET_IDS) return;
    if (seen.has(k)) {
      // Ticket dc636d0c: the prose scan runs first, so an id cited BOTH in
      // prose and in a claims fence keeps its prose entry — UPGRADE it to the
      // fence classification (GUARD 6 union-resolves fence refs; the strike
      // decision is per-id, and an id legitimately claimable in the fence
      // must not lose that leg to a dedupe ordering artifact).
      if (fromClaimsFence) {
        for (const c of out) if (c.id === k) c.fromClaimsFence = true;
      }
      return;
    }
    seen.add(k);
    out.push({ id: k, text: line, ...(fromClaimsFence ? { fromClaimsFence: true } : {}) });
  };
  // Ticket 00317531 (2026-09-15 false strike): a PARSED claims block is TYPED
  // context, not prose. A single-line block carrying "type":"ticket_update"
  // makes /\bticket/i match the WHOLE line, so shape (a) lifted EVERY other
  // entry's uuid-shaped ref (a dispatch/session receipt id) as a "ticket
  // citation" and the feedback-store existence check struck a real receipt as
  // a fabricated ticket id. When the block parses, its lines are excluded
  // from the generic scan and ONLY ticket_update refs are lifted (below); a
  // MALFORMED block keeps the legacy scan (miss-safe — the claims lane
  // separately flags it and prose mining applies unchanged).
  // Ticket 59ac00bd (F1/F2, reviewer sub-session 783bf716): the exclusion
  // spans come from parseClaimsBlocks — EVERY fenced block, located on the
  // RAW lines with the parser's own fence grammar, span ↔ parse bound by
  // construction. A span computed on TRIMMED lines let a ≥4-space-indented
  // pseudo-fence (an indented code block the parser never sees) vanish from
  // this scan unparsed — a fabricated ticket id hidden there evaded the
  // existence check entirely (F1); and a LAST-block-only span left earlier
  // valid blocks on the prose scan, where the 00317531 false-strike shape
  // persisted (F2).
  const claimsFences = parseClaimsBlocks(text);
  const parsedFences = claimsFences.filter((f) => f.result.claims !== null);
  for (let li = 0; li < ticketLines.length; li++) {
    const line = ticketLines[li];
    if (parsedFences.some((f) => li >= f.startLine && li <= f.endLine)) continue;
    if (!line || !TICKET_LINE_RE.test(line)) continue;
    if (voidQuoteExempt[li]) continue; // quoted-void exemption (block-local)
    if (lineHasRefutationContext(line)) continue; // an audit line, not a claim
    // (a) full-uuid citations anywhere on the line.
    for (const m of line.matchAll(new RegExp(TICKET_UUID_RE.source, 'gi'))) {
      const idx = m.index ?? 0;
      if (negatedBefore(line, idx) || intentBeforeVerb(line, idx)) continue;
      const window = line.slice(idx + m[0].length, Math.min(line.length, idx + m[0].length + 56));
      if (TICKET_ABSENCE_AFTER_RE.test(window)) continue;
      push(m[0], line);
    }
    // (b) 8-hex prefix chains after a ticket cue.
    for (const cue of line.matchAll(new RegExp(TICKET_CUE_RE.source, 'gi'))) {
      let pos = (cue.index ?? 0) + cue[0].length;
      const hardEnd = Math.min(line.length, pos + TICKET_CHAIN_WINDOW_CHARS);
      const chain: Array<{ id: string; start: number; end: number }> = [];
      while (pos < hardEnd && chain.length < MAX_CITED_TICKET_IDS) {
        const tm = new RegExp(TICKET_TOKEN_AT_RE.source, 'i').exec(line.slice(pos, hardEnd));
        if (!tm || tm.index !== 0) break;
        const raw = tm[0];
        // Date-shaped 8-digit tokens ("ticket 20260829") are not hex ids — an
        // 8-char PREFIX citation must carry at least one a-f letter (full
        // uuids need no such proof). A miss, never a false conviction.
        if (raw.length === 8 && !TICKET_PREFIX_NEEDS_LETTER_RE.test(raw)) break;
        chain.push({ id: raw.toLowerCase(), start: pos, end: pos + raw.length });
        const gap = TICKET_CHAIN_GAP_RE.exec(line.slice(pos + raw.length, hardEnd));
        if (!gap || gap.index !== 0 || gap[0].length === 0) break;
        pos = pos + raw.length + gap[0].length;
      }
      // Plural absence ("01226f89 / 4de4a5ef — ALL 404 on fresh pulls"): the
      // whole chain is an honest REFUTATION report, not citations.
      if (chain.length) {
        const last = chain[chain.length - 1];
        const after = line.slice(last.end, Math.min(line.length, last.end + 64));
        if (TICKET_PLURAL_ABSENCE_RE.test(after)) chain.length = 0;
      }
      for (let i = 0; i < chain.length; i++) {
        const tok = chain[i];
        const next = chain[i + 1];
        const window = line.slice(tok.end, next ? next.start : Math.min(line.length, tok.end + 56));
        if (TICKET_ABSENCE_AFTER_RE.test(window)) continue; // "ticket 01226f89 → 404"
        const before = line.slice(Math.max(0, tok.start - 16), tok.start);
        if (TICKET_ID_EXCLUDE_BEFORE_RE.test(before)) continue; // "merge sha fb4ab3bd"
        if (negatedBefore(line, tok.start) || intentBeforeVerb(line, tok.start)) continue;
        push(tok.id, line);
      }
    }
  }
  // Typed claims-block ticket refs (ticket 00317531): ONLY ticket_update
  // entries cite tickets — dispatch/push/pr/deploy/file_change/verify refs
  // never reach the feedback-store existence check. The entry's type IS the
  // context, so an all-digit 8-hex prefix ("00317531") is accepted here even
  // though prose shape (b) requires an a-f letter. Ticket 59ac00bd F2: refs
  // are lifted from EVERY parsed block, not just the last.
  for (const f of parsedFences) {
    for (const entry of f.result.claims ?? []) {
      if (entry.type !== 'ticket_update') continue;
      const ref = entry.ref.trim().toLowerCase();
      if (TICKET_UUID_RE.test(ref) || /^[0-9a-f]{8}$/.test(ref)) push(ref, '```claims ticket_update entry', true);
    }
  }
  return out;
}

// ── GUARD 7: board citations — todo + owner-question ids (ticket 938dac2e) ───

/**
 * Ticket 938dac2e (2026-09-15, mishap): the tt-rd main lane published a WHOLE
 * fabricated run report (its firing-445) — the first end-to-end fabrication,
 * beyond the single-invented-id family. Its cited todo 1c0db1a5 returned
 * "Todo not found" and its cited owner-question oq_8c8b15d4 matched no row on
 * fresh pulls; only that project's self-audit habit caught the report. GUARD 6
 * covers feedback-ticket ids only; these two extractors mine the board-citation
 * classes the report carried. Same house discipline as GUARD 6: per-line,
 * quoted-void exemption, refutation-context skip, parsed-claims-fence exclusion
 * (typed context, receipt-verified by the claims lane — no claims type carries
 * todo/oq refs, so nothing is lifted from fences), absence-cue suppression,
 * windowed negation/intent, and the prefix-needs-letter rule (8-hex form).
 *
 * EXISTENCE_DENIAL_RE (lane-local addition): a line that DENIES an id's
 * existence ("todo 1c0db1a5 returns 'Todo not found'", "oq_8c8b15d4 matches no
 * row") is an audit/absence report, never an existence assertion — the
 * self-audit lane that REPORTED 938dac2e writes exactly those lines, and
 * convicting them would strike the messenger. Directionally safe: a
 * fabrication ASSERTING an id never carries its own denial on the same line.
 */
const EXISTENCE_DENIAL_RE = /\b(?:no such|not found|doesn'?t exist|does not exist|do not exist|no row|404)\b/i;

const TODO_LINE_RE = /\btodo/i;
const TODO_CUE_RE = /\btodo(?:s|ed|ing)?(?:[- ](?:id|number)s?)?\s*[:#]?\s*\(?/i;
const TODO_ID_EXCLUDE_BEFORE_RE = /(?:sha|commit|merge|deploy|run|pr|pull|goal|ticket)\s*[:#]?\s*$/i;
const MAX_CITED_TODO_IDS = 10;
const MAX_CITED_OQ_IDS = 10;
/** oq_<uuid> in full, or the fleet's oq_<8-hex> prefix idiom (row ids are 'oq_<uuid>'). */
const OQ_ID_RE = /\boq_[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b|\boq_[0-9a-f]{8}\b/gi;

export interface BoardIdCitation {
  /** Lowercased cited id (full uuid or 8-hex prefix; oq_ ids keep the prefix). */
  id: string;
  /** The final-answer line the citation was lifted from (trimmed). */
  text: string;
}

/** The project-board todo ids cited in a final answer. Pure. */
export function extractTodoIdCitations(text: string): BoardIdCitation[] {
  const out: BoardIdCitation[] = [];
  if (!text) return out;
  const lines = text.split('\n').map((l) => l.trim());
  const voidQuoteExempt = quotedVoidExemptions(lines); // block-local (2026-09-08)
  const parsedFences = parseClaimsBlocks(text).filter((f) => f.result.claims !== null);
  const seen = new Set<string>();
  const push = (id: string, line: string): void => {
    const k = id.toLowerCase();
    if (seen.has(k) || out.length >= MAX_CITED_TODO_IDS) return;
    seen.add(k);
    out.push({ id: k, text: line });
  };
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    if (parsedFences.some((f) => li >= f.startLine && li <= f.endLine)) continue;
    if (!line || !TODO_LINE_RE.test(line)) continue;
    if (voidQuoteExempt[li]) continue;
    if (lineHasRefutationContext(line)) continue; // an audit line, not a claim
    if (EXISTENCE_DENIAL_RE.test(line)) continue; // an absence report ("…returns 'Todo not found'")
    // Review F1 (PR #811): NO uuid-anywhere path — GUARD 6's shape (a) is
    // deliberately NOT copied. A bare uuid on a todo-word line is
    // family-ambiguous: run/schedule/chat/session ids are uuids too, and
    // machine audit finals write "todo: continue in run 5e61266b-…" /
    // "todo: next firing verifies 824b0d28-…" constantly — lifting those as
    // todo citations convicts REAL prior-run/schedule ids (misses are
    // acceptable, false convictions are not). Only CUE-GOVERNED ids lift
    // (the chain below accepts a full uuid or an 8-hex prefix after a cue).
    // Review F2 (PR #811): the fleet writes backticked/bold ids ("todo
    // `b67d316d`" — action-verifier.ts's 3ed139cd lane allows the same
    // quoting); scan a quote/bold-normalized copy so markdown cannot evade
    // the cue. Position checks stay consistent within the copy; the ORIGINAL
    // line is what gets reported/convicted.
    const scan = line.replace(/[`"']/g, '').replace(/\*\*/g, '');
    for (const cue of scan.matchAll(new RegExp(TODO_CUE_RE.source, 'gi'))) {
      let pos = (cue.index ?? 0) + cue[0].length;
      const hardEnd = Math.min(scan.length, pos + TICKET_CHAIN_WINDOW_CHARS);
      const chain: Array<{ id: string; start: number; end: number }> = [];
      while (pos < hardEnd && chain.length < MAX_CITED_TODO_IDS) {
        const tm = new RegExp(TICKET_TOKEN_AT_RE.source, 'i').exec(scan.slice(pos, hardEnd));
        if (!tm || tm.index !== 0) break;
        const raw = tm[0];
        // Date-shaped 8-digit tokens ("todo 20260915") are not hex ids.
        if (raw.length === 8 && !TICKET_PREFIX_NEEDS_LETTER_RE.test(raw)) break;
        chain.push({ id: raw.toLowerCase(), start: pos, end: pos + raw.length });
        const gap = TICKET_CHAIN_GAP_RE.exec(scan.slice(pos + raw.length, hardEnd));
        if (!gap || gap.index !== 0 || gap[0].length === 0) break;
        pos = pos + raw.length + gap[0].length;
      }
      if (chain.length) {
        const last = chain[chain.length - 1];
        const after = scan.slice(last.end, Math.min(scan.length, last.end + 64));
        if (TICKET_PLURAL_ABSENCE_RE.test(after)) chain.length = 0;
      }
      for (let i = 0; i < chain.length; i++) {
        const tok = chain[i];
        const next = chain[i + 1];
        const window = scan.slice(tok.end, next ? next.start : Math.min(scan.length, tok.end + 56));
        if (TICKET_ABSENCE_AFTER_RE.test(window)) continue; // "todo 1c0db1a5 → 404"
        const before = scan.slice(Math.max(0, tok.start - 16), tok.start);
        if (TODO_ID_EXCLUDE_BEFORE_RE.test(before)) continue; // "merge sha fb4ab3bd"
        if (negatedBefore(scan, tok.start) || intentBeforeVerb(scan, tok.start)) continue;
        push(tok.id, line);
      }
    }
  }
  return out;
}

/**
 * The owner-question ids (oq_<8-hex> prefix or oq_<uuid>) cited in a final
 * answer. Pure. The oq_ prefix is self-identifying — no line cue required.
 */
export function extractOwnerQuestionCitations(text: string): BoardIdCitation[] {
  const out: BoardIdCitation[] = [];
  if (!text) return out;
  const lines = text.split('\n').map((l) => l.trim());
  const voidQuoteExempt = quotedVoidExemptions(lines);
  const parsedFences = parseClaimsBlocks(text).filter((f) => f.result.claims !== null);
  const seen = new Set<string>();
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    if (parsedFences.some((f) => li >= f.startLine && li <= f.endLine)) continue;
    if (!line) continue;
    if (voidQuoteExempt[li]) continue;
    if (lineHasRefutationContext(line)) continue;
    if (EXISTENCE_DENIAL_RE.test(line)) continue; // "oq_8c8b15d4 matches no row"
    for (const m of line.matchAll(new RegExp(OQ_ID_RE.source, 'gi'))) {
      const id = m[0].toLowerCase();
      if (seen.has(id) || out.length >= MAX_CITED_OQ_IDS) continue;
      const idx = m.index ?? 0;
      if (negatedBefore(line, idx) || intentBeforeVerb(line, idx)) continue;
      const window = line.slice(idx + m[0].length, Math.min(line.length, idx + m[0].length + 56));
      if (TICKET_ABSENCE_AFTER_RE.test(window)) continue; // "oq_8c8b15d4 → not found"
      seen.add(id);
      out.push({ id, text: line });
    }
  }
  return out;
}

const SCHEDULE_LINE_RE = /\bschedul/i;
/**
 * Cue-governed ONLY (2026-09-16 learnings convention (c), GUARD 7 review F1
 * parity): schedule ids are uuids — family-ambiguous with run/chat/session
 * ids — so a bare uuid on a schedule-word line is NEVER lifted (GUARD 6's
 * shape (a) is deliberately not copied). The chain cue covers the fleet's
 * schedule-citation idioms ("schedule `824b0d28`", "successor d3b3ba07-…",
 * "chain 73650cc9-…", "watch link f2aed619-…") and only AFTER the
 * SCHEDULE_LINE_RE gate passed, so the generic "chain"/"link" cues can never
 * fire on a non-schedule line.
 */
const SCHEDULE_CUE_RE = /\b(?:schedul\w*|successor|chain|link)(?:[- ](?:id|number)s?)?\s*[:#]?\s*\(?/i;
const SCHEDULE_ID_EXCLUDE_BEFORE_RE = /(?:sha|commit|merge|deploy|run|pr|pull|goal|ticket|todo|msg|message|chat|session|firing|oq)\s*[:#]?\s*$/i;
const MAX_CITED_SCHEDULE_IDS = 10;

/** The coding_schedules ids (full uuid or 8-hex prefix) cited in a final answer. Pure. */
export function extractScheduleIdCitations(text: string): BoardIdCitation[] {
  const out: BoardIdCitation[] = [];
  if (!text) return out;
  const lines = text.split('\n').map((l) => l.trim());
  const voidQuoteExempt = quotedVoidExemptions(lines);
  const parsedFences = parseClaimsBlocks(text).filter((f) => f.result.claims !== null);
  const seen = new Set<string>();
  const push = (id: string, line: string): void => {
    const k = id.toLowerCase();
    if (seen.has(k) || out.length >= MAX_CITED_SCHEDULE_IDS) return;
    seen.add(k);
    out.push({ id: k, text: line });
  };
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    if (parsedFences.some((f) => li >= f.startLine && li <= f.endLine)) continue;
    if (!line || !SCHEDULE_LINE_RE.test(line)) continue;
    if (voidQuoteExempt[li]) continue;
    if (lineHasRefutationContext(line)) continue; // an audit line, not a claim
    if (EXISTENCE_DENIAL_RE.test(line)) continue; // an absence report ("…returned 'No such schedule'")
    // Quote/bold-normalized scan copy (convention (d), GUARD 7 review F2
    // parity): the fleet writes backticked/bold ids ("successor `d3b3ba07-…`");
    // position checks stay consistent within the copy, the ORIGINAL line is
    // what gets reported/convicted.
    const scan = line.replace(/[`"']/g, '').replace(/\*\*/g, '');
    for (const cue of scan.matchAll(new RegExp(SCHEDULE_CUE_RE.source, 'gi'))) {
      const cueStart = cue.index ?? 0;
      // Intent/negation scope the CUE, never the token: the cue word
      // "schedule" is itself an INTENT_BEFORE_VERB_RE token (scheduled?), so a
      // token-level intent check would suppress every honest cue-governed
      // citation. "will schedule d3b3ba07" (intent, the id legitimately does
      // not exist yet) skips at the cue; "armed schedule d3b3ba07" lifts.
      if (negatedBefore(scan, cueStart) || intentBeforeVerb(scan, cueStart)) continue;
      let pos = cueStart + cue[0].length;
      const hardEnd = Math.min(scan.length, pos + TICKET_CHAIN_WINDOW_CHARS);
      const chain: Array<{ id: string; start: number; end: number }> = [];
      while (pos < hardEnd && chain.length < MAX_CITED_SCHEDULE_IDS) {
        const tm = new RegExp(TICKET_TOKEN_AT_RE.source, 'i').exec(scan.slice(pos, hardEnd));
        if (!tm || tm.index !== 0) break;
        const raw = tm[0];
        // Date-shaped 8-digit tokens ("schedule 20260916") are not hex ids.
        if (raw.length === 8 && !TICKET_PREFIX_NEEDS_LETTER_RE.test(raw)) break;
        chain.push({ id: raw.toLowerCase(), start: pos, end: pos + raw.length });
        const gap = TICKET_CHAIN_GAP_RE.exec(scan.slice(pos + raw.length, hardEnd));
        if (!gap || gap.index !== 0 || gap[0].length === 0) break;
        pos = pos + raw.length + gap[0].length;
      }
      if (chain.length) {
        const last = chain[chain.length - 1];
        const after = scan.slice(last.end, Math.min(scan.length, last.end + 64));
        if (TICKET_PLURAL_ABSENCE_RE.test(after)) chain.length = 0;
      }
      for (let i = 0; i < chain.length; i++) {
        const tok = chain[i];
        const next = chain[i + 1];
        const window = scan.slice(tok.end, next ? next.start : Math.min(scan.length, tok.end + 56));
        if (TICKET_ABSENCE_AFTER_RE.test(window)) continue; // "schedule d3b3ba07 → 404"
        const before = scan.slice(Math.max(0, tok.start - 16), tok.start);
        if (SCHEDULE_ID_EXCLUDE_BEFORE_RE.test(before)) continue; // "deploy run 72a9508b"
        if (negatedBefore(scan, tok.start)) continue; // "no d3b3ba07 anywhere"
        push(tok.id, line);
      }
    }
  }
  return out;
}

// ── Orchestrator (the executor finalize seam) ───────────────────────────────

/**
 * Apply the guards to a run's final answer. NEVER throws; bounded time
 * (the ≤5 GitHub GETs carry an 8 s timeout each, in parallel).
 *   - GUARD 0 (all triggers): harness-only markers in the answer → forgedFooter
 *     (the model imitated the guard's own footer/banner/fence).
 *   - GUARD 1 (machine triggers only): zero-evidence claims → guard note.
 *     Claims resolve against receipts when provided, else the legacy parts path.
 *   - GUARD 2 (ALL triggers): claimed PRs verified against GitHub → footer
 *     (a fully-verified claim still gets the footer — the real sha/merged_at
 *     is the receipt).
 * Returns the (possibly annotated) finalText + human-readable notes.
 */
/**
 * Machine-verifiable guard verdict (two-lane hardening, 2026-08-22). The
 * annotated ANSWER TEXT is forgeable — sessions have been caught emitting fake
 * harness footers (tickets dcc51edb / 675c3eb9) — so the executor persists
 * this verdict where a model cannot write: the run journal (harness-owned
 * rows) and a deduped integrity ticket.
 */
export interface GuardVerdict {
  /** Distinct claim kinds asserted with ZERO evidence-bearing tool calls (guard 1, machine runs). */
  unprovenKinds: ClaimKind[];
  /** Claimed PR numbers GitHub 404s on — fabricated outright. */
  fabricatedPrs: number[];
  /** PRs claimed MERGED that GitHub shows open/closed-unmerged — refuted merge claims. */
  refutedMergePrs: number[];
  /** Observation/merge stamps asserted LATER than the run's wall clock (guard 3, ticket 8e814f45). */
  futureDated: string[];
  /** The final answer contains HARNESS-ONLY markers — the model imitated the guard's own output (forgery layer). */
  forgedFooter?: boolean;
  /**
   * fb64368a review (2026-10-15): the receipt ids GUARD 0b judged FORGED
   * (cited in prose, absent from run ∪ carried ∪ observed). Carried apart
   * from forgedFooter so the executor's zero-receipt gate can re-adjudicate
   * EXACTLY this class against its own run ∪ carried pool (guard parity —
   * the executor's pool is computed from the same hoisted inputs, but a
   * future seam change must re-derive, not silently trust, the id list).
   * Empty/undefined when forgedFooter came from the GUARD 0 chrome-mimicry
   * lane (no ids to re-adjudicate — that class stays convicted).
   */
  forgedCitationIds?: string[];
  /** Claim-sourced push shas GitHub 404s on — the commit does not exist on origin (guard 2b). */
  fabricatedShas?: string[];
  /**
   * commit_local claim shas ("banked/committed <sha>") GitHub 404s on — the
   * commit is not on origin: LOCAL ONLY, not pushed (finding A1, 2026-09-27).
   * Observe-only: never a hard finding, never a redaction — the commit may
   * exist in the worktree; the strike says the durable-sounding word was not
   * backed by a push. Enforcement seams read enforceableVerdict(), which
   * strips this field and the commit_local unproven kind.
   */
  localOnlyShas?: string[];
  /** Quoted "verbatim output" blocks matching NO tool result of the run (guard 4, ticket 7cb26cb0) — exhibit lines. */
  fabricatedQuotes?: string[];
  /** Claim-sourced GitHub Actions run ids the API 404s on — the deploy-run claim is fabricated (guard 5, ticket 8e9d6496). */
  fabricatedDeployRuns?: string[];
  /** Deploy-run success/completion claims GitHub Actions itself contradicts — the run exists but is not in the claimed terminal state (guard 5). */
  refutedDeployRuns?: string[];
  /** Cited feedback-ticket ids with NO row in the feedback store — invented ids (guard 6, ticket 8e9d6496). */
  fabricatedTicketIds?: string[];
  /** Cited project-board todo ids with NO project_todos row — invented ids (guard 7, ticket 938dac2e). */
  fabricatedTodoIds?: string[];
  /** Cited owner-question ids (oq_…) with NO owner_questions row — invented ids (guard 7, ticket 938dac2e). */
  fabricatedOwnerQuestionIds?: string[];
  /** Cited schedule ids with NO coding_schedules row — invented ids (guard 8, ticket cae70bfa). */
  fabricatedScheduleIds?: string[];
  /**
   * CARRIED-EVIDENCE tier (tt-rd audit 2026-09-27, finding self-audit-churn-4):
   * GUARD 1 claims that name a STABLE artifact (a PR number, a pushed sha),
   * are NOT phrased as fresh, and match an ok receipt from an EARLIER run of
   * the same chat — rendered '[CARRIED from run <id8> <ts>]' instead of
   * UNVERIFIED and excluded from unprovenKinds / unprovenClaims. Observe-only
   * telemetry (guard_miss seam 'carried_receipt' at the executor).
   */
  carriedClaims?: Array<{ kind: ClaimKind; text: string; runId: string | null; at: string }>;
  /**
   * The GUARD 1 claim OBJECTS whose lines the executor may redact (ticket
   * f8d68167 strip+mark lane): populated ONLY on machine triggers, on both
   * the receipts and legacy paths, alongside unprovenKinds. Each claim's
   * `text` is the whole trimmed final-answer line it was extracted from, so
   * the executor can elide exactly the lines carrying unproven claims.
   */
  unprovenClaims?: CompletionClaim[];
  /**
   * The GUARD 3 claim OBJECTS whose lines the executor may redact (ticket
   * 45edaf25 — the f8d68167 strip+mark lane widened to future-dated clocks):
   * populated on ALL triggers alongside `futureDated`, ONLY when non-empty (a
   * clean verdict keeps the field absent). Each claim's `text` is the whole
   * trimmed final-answer line carrying the struck stamp, so the executor can
   * elide exactly the lines carrying impossible observation clocks.
   */
  futureDatedClaims?: FutureDatedClaim[];
  /**
   * The guard THREW mid-evaluation (2026-09-08 audit): the verdict is PARTIAL
   * — lanes after the throw never ran. Never a finding by itself (an internal
   * error must not convict an honest answer), but the executor records a
   * `guard_error` loop-metric row so a silently-degraded guard is observable
   * instead of indistinguishable from a clean pass.
   */
  guardError?: string;
  /**
   * audit 2026-10-06 T7-6: the evidence-bearing call count the GUARD-1 note
   * was rendered with (set only alongside a conviction) — the claims-block
   * lane's surgical note repair re-renders byte-identically from it.
   */
  evidenceToolCalls?: number;
  /**
   * Typed CLAIMS-block entries (audit #6 phase 1 — claims-block.ts) with NO
   * matching receipt in this run, rendered "type ref". A finding: a block
   * entry IS a completion claim, and one without a receipt is fabricated
   * until re-verified. Set ONLY by applyClaimsBlockLane — never by
   * applyCompletionClaimGuard (the lane is a separate, additive composition).
   */
  unverifiedBlockClaims?: string[];
  /**
   * True when the final's typed claims block was present, parsed, and EVERY
   * entry receipt-verified — the lane's POSITIVE verdict (audit #6 phase 1).
   * Never a finding; recorded so downstream consumers can prefer the typed
   * self-report over prose. Set ONLY by applyClaimsBlockLane.
   */
  claimsBlockVerified?: boolean;
}

export function verdictHasFindings(v: GuardVerdict | undefined | null): boolean {
  return !!v && (v.unprovenKinds.length > 0 || v.fabricatedPrs.length > 0 || v.refutedMergePrs.length > 0 || v.futureDated.length > 0 || v.forgedFooter === true || (v.fabricatedShas?.length ?? 0) > 0 || (v.fabricatedQuotes?.length ?? 0) > 0
    || (v.fabricatedDeployRuns?.length ?? 0) > 0 || (v.refutedDeployRuns?.length ?? 0) > 0 || (v.fabricatedTicketIds?.length ?? 0) > 0
    || (v.fabricatedTodoIds?.length ?? 0) > 0 || (v.fabricatedOwnerQuestionIds?.length ?? 0) > 0
    || (v.fabricatedScheduleIds?.length ?? 0) > 0
    || (v.unverifiedBlockClaims?.length ?? 0) > 0
    || (v.localOnlyShas?.length ?? 0) > 0);
}

/**
 * The verdict the ENFORCEMENT lanes decide on (finding A1 review fix,
 * 2026-09-27): the observe-only commit_local classes — GUARD 1's
 * `commit_local` unproven kind and GUARD 2b's `localOnlyShas` — are stripped
 * so that, even under EVIDENCE_GUARD_ENFORCE=1, a "banked/committed <sha>"
 * line is ANNOTATED and never redacted, replaced, bounced in-loop or
 * ticketed by itself. The FULL verdict still reaches telemetry (guard_strike
 * kinds) and the journal row unchanged. Pure; never mutates its input. A
 * verdict without those classes comes back equivalent (a no-op under the
 * kill switch, which produces neither class).
 */
export function enforceableVerdict(v: GuardVerdict): GuardVerdict {
  const out: GuardVerdict = { ...v };
  delete out.localOnlyShas;
  // Tolerant of a partial verdict (a hand-built or mocked one without the
  // required arrays) — this helper must never be the throw that loses a final.
  if ((v.unprovenKinds ?? []).includes('commit_local')) {
    out.unprovenKinds = v.unprovenKinds.filter((k) => k !== 'commit_local');
    const claims = (v.unprovenClaims ?? []).filter((c) => c.kind !== 'commit_local');
    if (claims.length) out.unprovenClaims = claims;
    else delete out.unprovenClaims;
  }
  return out;
}

/**
 * Machine-readable finding-class names for one verdict — the loop-metrics
 * meta.kinds vocabulary (guard_strike rows). Empty array = clean verdict.
 * Pure; ordering mirrors verdictHasFindings' clause order.
 */
export function guardFindingKinds(v: GuardVerdict | undefined | null): string[] {
  if (!v) return [];
  const kinds: string[] = [];
  if (v.unprovenKinds.length) kinds.push('unproven_completion');
  if (v.fabricatedPrs.length) kinds.push('fabricated_pr');
  if (v.refutedMergePrs.length) kinds.push('refuted_merge');
  if (v.futureDated.length) kinds.push('future_dated');
  if (v.forgedFooter === true) kinds.push('forged_footer');
  if (v.fabricatedShas?.length) kinds.push('fabricated_sha');
  if (v.localOnlyShas?.length) kinds.push('local_only_commit');
  if (v.fabricatedQuotes?.length) kinds.push('fabricated_quote');
  if (v.fabricatedDeployRuns?.length) kinds.push('fabricated_deploy_run');
  if (v.refutedDeployRuns?.length) kinds.push('refuted_deploy_run');
  if (v.fabricatedTicketIds?.length) kinds.push('fabricated_ticket_id');
  if (v.fabricatedTodoIds?.length) kinds.push('fabricated_todo_id');
  if (v.fabricatedOwnerQuestionIds?.length) kinds.push('fabricated_owner_question_id');
  if (v.fabricatedScheduleIds?.length) kinds.push('fabricated_schedule_id');
  if (v.unverifiedBlockClaims?.length) kinds.push('unverified_block_claim');
  return kinds;
}

/**
 * Bounded claim excerpts for the guard_strike meta (R&D firing 20,
 * 2026-10-10 — final_verdict observability): recurrence-2 adjudication of a
 * struck final needed 3 transcript pulls + a receipts pull because the strike
 * row's meta carried only `kinds` while the GuardVerdict already held the
 * struck claim OBJECTS (unprovenClaims, ticket f8d68167) — the excerpt a
 * fleet adjudicator needs to tell honest-work-wrong-receipt-shape (the
 * observed de529489 pair: fresh probes run, outputs quoted, empty ids
 * envelopes) from true fabrication lived nowhere reachable from the metric.
 * Pure, tolerant of partial/mocked verdicts; each excerpt is the claim's kind
 * plus its final-answer line capped at 120 chars (redaction-safe: struck
 * lines already elide from delivered finals under enforcement). Bound: at
 * most 5 excerpts, missing classes are simply absent.
 */
export const GUARD_STRIKE_EXCERPT_TEXT_CAP = 120;
export const GUARD_STRIKE_EXCERPT_MAX = 5;

export interface GuardStrikeClaimExcerpt { kind: ClaimKind | 'future_dated' | 'unverified_block_claim'; text: string }

export function guardStrikeClaimExcerpts(v: GuardVerdict | undefined | null): GuardStrikeClaimExcerpt[] {
  if (!v) return [];
  const out: GuardStrikeClaimExcerpt[] = [];
  const push = (kind: GuardStrikeClaimExcerpt['kind'], text: string): void => {
    if (out.length >= GUARD_STRIKE_EXCERPT_MAX) return;
    const t = String(text ?? '').trim().slice(0, GUARD_STRIKE_EXCERPT_TEXT_CAP);
    if (!t) return;
    out.push({ kind, text: t });
  };
  for (const c of v.unprovenClaims ?? []) push(c.kind, c.text);
  for (const c of v.futureDatedClaims ?? []) push('future_dated', c.text);
  for (const t of v.unverifiedBlockClaims ?? []) push('unverified_block_claim', t);
  return out;
}

/** One-line human rendering of a verdict's findings (suppression notice + hook summaries). */
export function summarizeGuardVerdict(v: GuardVerdict): string {
  const bits: string[] = [];
  if (v.unprovenKinds.length) bits.push(`zero-evidence completion claims: ${v.unprovenKinds.join(', ')}`);
  if (v.fabricatedPrs.length) bits.push(`fabricated PR claims (GitHub 404): ${v.fabricatedPrs.map((n) => `#${n}`).join(', ')}`);
  if (v.refutedMergePrs.length) bits.push(`merge claims refuted by GitHub (PR not merged): ${v.refutedMergePrs.map((n) => `#${n}`).join(', ')}`);
  if (v.futureDated.length) bits.push(`future-dated observation claims: ${v.futureDated.join('; ')}`);
  if (v.forgedFooter) bits.push('forged harness markers in the final answer (the model imitated the guard\'s own output)');
  if (v.fabricatedShas?.length) bits.push(`fabricated push claims (no such commit on origin): ${v.fabricatedShas.map((s) => s.slice(0, 12)).join(', ')}`);
  if (v.fabricatedQuotes?.length) bits.push(`quoted "verbatim output" no tool produced: ${v.fabricatedQuotes.map((q) => `"${q.slice(0, 60)}"`).join(', ')}`);
  if (v.fabricatedDeployRuns?.length) bits.push(`fabricated deploy-run claims (no such GitHub Actions run): ${v.fabricatedDeployRuns.join(', ')}`);
  if (v.refutedDeployRuns?.length) bits.push(`deploy-completion claims refuted by GitHub Actions: ${v.refutedDeployRuns.join(', ')}`);
  if (v.fabricatedTicketIds?.length) bits.push(`fabricated feedback-ticket ids (no such ticket): ${v.fabricatedTicketIds.join(', ')}`);
  if (v.fabricatedTodoIds?.length) bits.push(`fabricated todo ids (no such board todo): ${v.fabricatedTodoIds.join(', ')}`);
  if (v.fabricatedOwnerQuestionIds?.length) bits.push(`fabricated owner-question ids (no such oq_ row): ${v.fabricatedOwnerQuestionIds.join(', ')}`);
  if (v.fabricatedScheduleIds?.length) bits.push(`fabricated schedule ids (no such coding_schedules row): ${v.fabricatedScheduleIds.join(', ')}`);
  if (v.unverifiedBlockClaims?.length) bits.push(`claims-block entries with no matching receipt: ${v.unverifiedBlockClaims.join(', ')}`);
  return bits.join('; ');
}

/**
 * REJECT-BACK lane (ticket dc04deea — f8d68167 option (b)): the message a
 * top-level MACHINE run's agentLoop receives when its would-be final answer is
 * convicted BEFORE submission. The answer is rejected back to the model with
 * the missing-receipt list so the run corrects itself — the durable fix for
 * the zero-tool short-circuit shape (a prompt cannot force a tool call; this
 * gate rejects the answer that lacks one). Bounded by the caller's
 * maxRejections; on exhaustion the executor's replace/redact lane (option (a))
 * applies unchanged.
 *
 * CHROME RULE: this text enters the MODEL's context — it must NEVER contain
 * the harness-only conviction chrome (the FORGED_MARKER_RES patterns), or it
 * teaches the forgery layer the format it convicts (cf. ticket ac835c00).
 */
export function renderGuardRejectBackNotice(v: GuardVerdict): string {
  const cap5 = <T>(arr: T[]): T[] => arr.slice(0, 5);
  const clip = (s: string, n = 120) => (s.length > n ? `${s.slice(0, n)}…` : s);
  const lines: string[] = [
    "[HARNESS NOTICE — not typed by the user] The evidence guard REJECTED your previous answer — it was NOT submitted. Its claims have no matching receipts in this run's tool journal:",
  ];
  if (v.unprovenKinds.length) {
    // Ticket 212b3aa0: name the evidence CLASSES — the old "(no evidence-
    // bearing tool call this run)" was false for runs that probed with the
    // platform read tools (evidence-bearing per the zero-tool gate) and gave
    // no actionable escape, producing repeat identical strikes.
    lines.push(`- zero-evidence completion claims (no successful tool call in each claim's evidence class this run): ${v.unprovenKinds.join(', ')}`);
    if (v.unprovenKinds.some((k) => k === 'probe' || k === 'benchmark')) {
      lines.push('  probe/benchmark evidence = an ok receipt from run_command/git_*, a local read (read_file/grep/glob/list_dir), a web read, or — for FLEET/PLATFORM-state probes only — a platform observation read (get_chat_status, todo_get, list_schedules, schedule_get, get_feedback, …) executed THIS run; box/tailnet/remote-host probes always need run_command/web evidence. Re-observe and cite the fresh output, or remove the claim.');
    }
    // F32: the deploy tier's evidence class, so a deploy-struck lane is told
    // WHICH tool class satisfies it (the 212b3aa0 repeat-strike fix, applied
    // to the deploy kind).
    if (v.unprovenKinds.some((k) => k === 'deploy')) {
      lines.push('  deploy evidence = an ok receipt from run_command/git_*/github_* (or merge_pull_request). If the claim is the pure OBSERVATION shape ("health check 200", "prod green", "digby.ai healthy" — no deploy verb), a get_fleet_telemetry deploy/health read or a web health read (scrape_as_markdown/browser_task) executed THIS run also evidences it; a line saying the deploy itself ran (deploy verb) always needs the action class. Re-observe and cite the fresh output, or remove the claim.');
    }
    for (const c of cap5(v.unprovenClaims ?? [])) lines.push(`  - "${clip(c.text)}"`);
  }
  if (v.fabricatedPrs.length) lines.push(`- fabricated PR claims (GitHub has no such PR): ${v.fabricatedPrs.map((n) => `#${n}`).join(', ')}`);
  if (v.refutedMergePrs.length) lines.push(`- merge claims refuted by GitHub (the PR is not merged): ${v.refutedMergePrs.map((n) => `#${n}`).join(', ')}`);
  if (v.futureDated.length) lines.push(`- future-dated observation claims (later than this run's real clock): ${cap5(v.futureDated).join('; ')}`);
  if (v.forgedFooter) lines.push('- forged harness markers (the answer imitated harness-only output)');
  if (v.fabricatedShas?.length) lines.push(`- fabricated push shas (no such commit on origin): ${cap5(v.fabricatedShas).map((s) => s.slice(0, 12)).join(', ')}`);
  if (v.fabricatedQuotes?.length) lines.push(`- quoted "verbatim output" no tool produced: ${cap5(v.fabricatedQuotes).map((q) => `"${clip(q, 60)}"`).join(', ')}`);
  if (v.fabricatedDeployRuns?.length) lines.push(`- fabricated deploy-run ids (GitHub Actions has no such run): ${cap5(v.fabricatedDeployRuns).join(', ')}`);
  if (v.refutedDeployRuns?.length) lines.push(`- deploy-completion claims refuted by GitHub Actions: ${cap5(v.refutedDeployRuns).join(', ')}`);
  if (v.fabricatedTicketIds?.length) lines.push(`- fabricated feedback-ticket ids (no such ticket exists): ${cap5(v.fabricatedTicketIds).join(', ')}`);
  if (v.fabricatedTodoIds?.length) lines.push(`- fabricated todo ids (no such board todo exists): ${cap5(v.fabricatedTodoIds).join(', ')}`);
  if (v.fabricatedOwnerQuestionIds?.length) lines.push(`- fabricated owner-question ids (no such oq_ row exists): ${cap5(v.fabricatedOwnerQuestionIds).join(', ')}`);
  if (v.fabricatedScheduleIds?.length) lines.push(`- fabricated schedule ids (no such coding_schedules row exists): ${cap5(v.fabricatedScheduleIds).join(', ')}`);
  if (v.unverifiedBlockClaims?.length) lines.push(`- typed claims-block entries with no matching receipt in this run's tool journal: ${cap5(v.unverifiedBlockClaims).map((s) => clip(s, 80)).join(', ')}`);
  lines.push('Do the verification NOW with real tool calls, then answer citing the tool-result artifacts (the PR number/URL from the creation or merge response, the run id and conclusion from the actions/runs output, the quoted probe lines). Any claim you cannot verify with a tool call in THIS run must be marked "attempted, unverified" or removed — do NOT resubmit the rejected claims without receipts.');
  return lines.join('\n');
}

/**
 * The reject-back DECISION for one would-be final answer (the agentLoop
 * clean-finish gate): runs the full guard and renders the rejection when the
 * verdict has findings. USER-triggered runs are never gated (mirrors the
 * executor's triggerKind !== 'user' condition). receipts/priorReceipts are
 * unioned in-process-first exactly like run-executor's finalize guard call (a
 * resumed run's prior attempts count as evidence). Never throws — a guard
 * error must not break the finish path; the executor's post-run guard still
 * applies to whatever the loop finally submits.
 */
export async function evaluateFinalCandidateForRejectBack(opts: {
  finalText: string;
  parts: MessagePart[];
  triggerKind: 'user' | 'schedule' | 'hook' | 'machine';
  resumed: boolean;
  userId: string;
  repoUrl?: string | null;
  githubLabel?: string | null;
  provider?: string | null;
  receipts: ToolReceipt[];
  priorReceipts?: ToolReceipt[];
  priorToolTexts?: string[];
  toolTexts?: string[];
  /** Iteration 13 (2026-09-25): enabled coding_schedules nextRunAt instants (epoch ms) — the ±60s schedule-firing clock exemption's ground. Passthrough to applyCompletionClaimGuard. */
  scheduleFiringTimes?: number[];
  ticketIdsExist?: (ids: string[]) => Promise<Set<string>>;
  /** GUARD 7 resolvers (ticket 938dac2e) — same injected-prisma discipline as ticketIdsExist. */
  todoIdsExist?: (ids: string[]) => Promise<Set<string>>;
  ownerQuestionIdsExist?: (ids: string[]) => Promise<Set<string>>;
  /** GUARD 6 board resolver (ticket dc636d0c) — same injected-prisma discipline as ticketIdsExist. */
  goalIdsExist?: (ids: string[]) => Promise<Set<string>>;
  /** GUARD 8 resolver (ticket cae70bfa) — same injected-prisma discipline as ticketIdsExist. */
  scheduleIdsExist?: (ids: string[]) => Promise<Set<string>>;
  /**
   * OPT-IN (audit #6 phase 1, default OFF — zero behavior change until the
   * sibling wiring flips it): compose the typed claims-block lane
   * (applyClaimsBlockLane) over the guard verdict before the reject-back
   * decision, for parity with a finalize seam that wires the same lane.
   */
  applyClaimsBlock?: boolean;
  /** CARRIED-EVIDENCE tier (2026-09-27) — same value the executor's finalize guard passes (parity). */
  carriedReceipts?: ToolReceipt[];
}): Promise<{ rejected: boolean; notice?: string; summary?: string; kinds?: string[] }> {
  if (opts.triggerKind === 'user') return { rejected: false };
  try {
    const seen = new Set<string>();
    const receipts: ToolReceipt[] = [];
    for (const r of [...opts.receipts, ...(opts.priorReceipts ?? [])]) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      receipts.push(r);
    }
    const guarded = await applyCompletionClaimGuard({
      finalText: opts.finalText,
      parts: opts.parts,
      triggerKind: opts.triggerKind,
      resumed: opts.resumed,
      userId: opts.userId,
      repoUrl: opts.repoUrl,
      githubLabel: opts.githubLabel,
      provider: opts.provider,
      receipts,
      priorToolTexts: opts.priorToolTexts,
      toolTexts: opts.toolTexts,
      scheduleFiringTimes: opts.scheduleFiringTimes,
      ...(opts.ticketIdsExist ? { ticketIdsExist: opts.ticketIdsExist } : {}),
      ...(opts.todoIdsExist ? { todoIdsExist: opts.todoIdsExist } : {}),
      ...(opts.goalIdsExist ? { goalIdsExist: opts.goalIdsExist } : {}),
      ...(opts.ownerQuestionIdsExist ? { ownerQuestionIdsExist: opts.ownerQuestionIdsExist } : {}),
      ...(opts.scheduleIdsExist ? { scheduleIdsExist: opts.scheduleIdsExist } : {}),
      ...(opts.carriedReceipts ? { carriedReceipts: opts.carriedReceipts } : {}),
    });
    // Claims-block composition (opt-in): a fully-verified block may DOWNGRADE
    // guard-1 convictions (no rejection for receipt-proven work); an
    // unverified entry is a finding and rejects like any other. The
    // origin-vouch leg (FO firing 4, 2026-09-22) rides the SAME injected
    // originCheck the executor finalize seam passes — reject-back parity: an
    // honest raw-shell push must not bounce in-loop either.
    const composed = opts.applyClaimsBlock
      ? await applyClaimsBlockLane({
        originalText: opts.finalText, guarded, receipts,
        triggerKind: opts.triggerKind, resumed: opts.resumed,
        // Ticket ed728b87: scope:session/relayed entries verify against the
        // SAME carried pool the prose guard received (reject-back parity with
        // the finalize seam — an honest cross-run claim must not bounce
        // in-loop either).
        ...(opts.carriedReceipts?.length ? { carriedReceipts: opts.carriedReceipts } : {}),
        originCheck: (shas) => verifyPushClaims({
          shas, userId: opts.userId, repoUrl: opts.repoUrl,
          githubLabel: opts.githubLabel, provider: opts.provider,
        }),
      })
      : guarded;
    // Gate flip 2026-09-11 (owner: full steam): two finding classes are
    // NOTE-ONLY and never bounce a final — unverifiedBlockClaims (the typed
    // ```claims lane; every recoverable exhibit was honest work in the wrong
    // receipt shape) and fabricatedQuotes (GUARD 4; 26/28 exhibits were the
    // run's own harness-mandated fence). The decision runs on a copy with
    // those cleared; the FULL verdict still reaches the executor's finalize
    // telemetry (GUARD_STRIKE kinds + journal verdict row) unchanged —
    // opt-in QUOTE_GUARD_ENFORCE=1 restores quote conviction here.
    // Finding A1 review fix (2026-09-27): the commit_local classes are
    // observe-only on this seam too (enforceableVerdict) — a banked/committed
    // line never bounces a draft, even with EVIDENCE_GUARD_ENFORCE=1.
    const rejectable: GuardVerdict = {
      ...enforceableVerdict(composed.verdict),
      unverifiedBlockClaims: undefined,
      ...(process.env.QUOTE_GUARD_ENFORCE === '1' ? {} : { fabricatedQuotes: undefined }),
    };
    if (!verdictHasFindings(rejectable)) return { rejected: false };
    return {
      rejected: true,
      notice: renderGuardRejectBackNotice(rejectable),
      summary: summarizeGuardVerdict(rejectable),
      // The finding classes (guardFindingKinds vocabulary) — the agent loop's
      // reject_back GUARD_STRIKE telemetry row carries them.
      kinds: guardFindingKinds(rejectable),
    };
  } catch {
    return { rejected: false };
  }
}

/**
 * Annotate→REPLACE escalation (ticket be199e93): phantom occurrences #21–#26
 * all POSTDATE the annotate-only guard, and the lane learned to IMITATE the
 * verification footer — so for a machine-triggered run whose verdict has
 * findings, the executor replaces the final answer outright. The TOP of the
 * message (and everything a hook digest or later wake quotes) is the honest
 * harness version; the run's original confabulated text survives BELOW inside
 * a clearly-marked, blockquoted audit section that nothing should restate as
 * fact.
 *
 * Returns { finalText, notice }: finalText is the full replacement (notice +
 * quoted original); notice is the harness-authored top alone (the executor
 * prepends it to result.parts so the parts-rendered transcript ALSO leads
 * honest). `verificationFooter` is the guard-2 GitHub footer, when one was
 * produced — real receipts belong in the honest section, not in the quote.
 */
export function renderSuppressedFinal(opts: {
  originalText: string;
  verdict: GuardVerdict;
  triggerKind: string;
  resumed?: boolean;
  verificationFooter?: string;
}): { finalText: string; notice: string } {
  const notice = [
    "[HARNESS EVIDENCE GUARD — THIS RUN'S FINAL ANSWER WAS REPLACED]",
    `This machine-triggered run ('${opts.triggerKind}'${opts.resumed ? ', resumed from a checkpoint' : ''}) produced a final summary asserting completions its tool log does not support — ${summarizeGuardVerdict(opts.verdict)}.`,
    'Treat EVERYTHING the run claimed as NOT DONE until re-verified with fresh tool evidence (GitHub API, box probes, test runs).',
    "The run's original summary is quoted below for AUDIT ONLY — do not quote, restate, or act on it as fact.",
    ...(opts.verificationFooter ? ['', opts.verificationFooter] : []),
  ].join('\n');
  const quoted = (opts.originalText || '').trim().split('\n').map((l) => `> ${l}`).join('\n');
  const finalText = [
    notice,
    '--- BEGIN UNVERIFIED RUN OUTPUT (quoted for audit — NOT verified, treat as NOT DONE) ---',
    quoted,
    '--- END UNVERIFIED RUN OUTPUT ---',
  ].join('\n\n');
  return { finalText, notice };
}

/**
 * The 1:1 stand-in for an elided claim line (ticket f8d68167). MUST extract
 * ZERO completion claims itself (a test pins extractCompletionClaims on it →
 * []) — otherwise the redacted answer would re-convict on re-extraction.
 */
export const REDACTED_CLAIM_LINE = '[line removed — unproven completion claim]';

/**
 * The 1:1 stand-in for an elided future-dated clock line (ticket 45edaf25).
 * MUST extract ZERO completion claims AND zero future-dated claims itself
 * (tests pin both: extractCompletionClaims → [] and findFutureDatedClaims →
 * []) — otherwise the redacted answer would re-convict on re-extraction.
 */
export const REDACTED_CLOCK_LINE = '[line removed — impossible observation clock]';

/**
 * STRIP+MARK lane (ticket f8d68167, option (a); widened to future-dated clocks
 * by ticket 45edaf25): when a machine run's ONLY findings are zero-evidence
 * completion claims (GUARD 1) and/or future-dated observation clocks (GUARD
 * 3), replacing the whole answer (renderSuppressedFinal) throws away the
 * run's real triage/analysis with the fabrication. This renders the middle
 * lane: every line carrying an unproven claim is elided 1:1 with
 * REDACTED_CLAIM_LINE and every line carrying a struck stamp with
 * REDACTED_CLOCK_LINE (trim-equality, so ALL occurrences of a duplicated
 * claim/stamp line elide — extraction is pure per-line, making duplicates
 * all-claims-or-none; a line carrying BOTH takes REDACTED_CLAIM_LINE, counted
 * once); every other line is delivered byte-identical under an honest harness
 * banner. The banner's "REMOVED]" wording deliberately collides with NO other
 * FORGED_MARKER_RES pattern than the harness-only REMOVED one listed there,
 * and the marker itself is harness-only chrome.
 *
 * Returns null — the caller falls back to full replacement — when redaction
 * cannot be applied safely: (a) BOTH the claim and clock sets are empty; (b)
 * a claim/clock line does NOT appear as a trimmed line of originalText
 * (fail-closed over the UNION: extraction guarantees presence, so a miss
 * means mismatched inputs); (c) the elided share exceeds half the non-empty
 * lines (redaction would gut the answer); (d) zero non-empty lines survive.
 */
export function renderRedactedFinal(opts: {
  originalText: string;
  claims: CompletionClaim[];
  /** The GUARD 3 struck-stamp claim objects (ticket 45edaf25) — optional; absent = the f8d68167 claims-only lane. */
  clockClaims?: FutureDatedClaim[];
  verdict: GuardVerdict;
  triggerKind: string;
  resumed?: boolean;
  verificationFooter?: string;
}): { finalText: string; notice: string } | null {
  const claimLines = new Set(opts.claims.map((c) => c.text));
  const clockLines = new Set((opts.clockClaims ?? []).map((c) => c.text));
  if (!claimLines.size && !clockLines.size) return null; // (a) nothing to elide
  const lines = (opts.originalText || '').split('\n');
  const trimmed = lines.map((l) => l.trim());
  for (const t of claimLines) {
    if (!trimmed.includes(t)) return null; // (b) fail-closed
  }
  for (const t of clockLines) {
    if (!trimmed.includes(t)) return null; // (b) fail-closed — the union must be locatable
  }
  const nonEmpty = trimmed.filter((t) => t.length > 0).length;
  let redacted = 0;
  let claimRedacted = 0;
  let clockRedacted = 0;
  const bodyLines = lines.map((l, i) => {
    if (trimmed[i].length > 0 && claimLines.has(trimmed[i])) {
      redacted++;
      claimRedacted++;
      return REDACTED_CLAIM_LINE; // a line in BOTH sets takes the claim stand-in, counted once
    }
    if (trimmed[i].length > 0 && clockLines.has(trimmed[i])) {
      redacted++;
      clockRedacted++;
      return REDACTED_CLOCK_LINE;
    }
    return l;
  });
  if (redacted === 0) return null; // unreachable given (b); keeps the ratios below honest
  if (nonEmpty - redacted <= 0) return null; // (d) nothing survives
  if (redacted / nonEmpty > 0.5) return null; // (c) redaction would gut the answer
  // Banner + notice per lane: the BANNER names the stand-ins actually used;
  // the SUMMARY/SURVIVOR disclose the VERDICT's finding classes (45edaf25
  // review N2 — a both-carrier-only verdict, where every struck-stamp line
  // also carried an unproven claim and clockRedacted === 0, must still name
  // the clock class). Claims-only (no clock findings) stays BYTE-IDENTICAL
  // to the f8d68167 wording (existing tests pin it).
  const resumedBit = opts.resumed ? ', resumed from a checkpoint' : '';
  const hasClaimFindings = opts.verdict.unprovenKinds.length > 0;
  const hasClockFindings = opts.verdict.futureDated.length > 0;
  let banner: string;
  let summary: string;
  let survivor: string;
  if (clockRedacted > 0 && claimRedacted > 0) {
    banner = `[HARNESS EVIDENCE GUARD — ${redacted} CLAIM+CLOCK LINE(S) REMOVED]`;
  } else if (clockRedacted > 0) {
    banner = `[HARNESS EVIDENCE GUARD — ${redacted} CLOCK LINE(S) REMOVED]`;
  } else {
    banner = `[HARNESS EVIDENCE GUARD — ${redacted} CLAIM LINE(S) REMOVED]`;
  }
  if (hasClaimFindings && hasClockFindings) {
    summary = `This machine-triggered run ('${opts.triggerKind}'${resumedBit}) asserted completions its tool log does not support — zero-evidence completion claims: ${opts.verdict.unprovenKinds.join(', ')} — and cited observation/merge timestamps LATER than this run's wall clock — future-dated observation claims: ${opts.verdict.futureDated.join('; ')}. A completed observation cannot be dated in the future — treat the claims on the removed line(s) as confabulated. The ${redacted} line(s) carrying those claims/stamps were removed from the delivered answer; treat the claimed completions as ATTEMPTED, NOT CONFIRMED until re-verified with fresh tool evidence.`;
    survivor = "The surviving text below is the run's own analysis as written — only the unproven-claim and impossible-clock lines were removed; nothing else was harness-verified.";
  } else if (hasClockFindings) {
    summary = `This machine-triggered run ('${opts.triggerKind}'${resumedBit}) cited observation/merge timestamps LATER than this run's wall clock — future-dated observation claims: ${opts.verdict.futureDated.join('; ')}. A completed observation cannot be dated in the future — treat the claims on the removed line(s) as confabulated. The ${redacted} line(s) carrying those stamps were removed from the delivered answer; re-verify with fresh tool evidence before believing anything they asserted.`;
    survivor = "The surviving text below is the run's own analysis as written — only the impossible-clock lines were removed; nothing else was harness-verified.";
  } else {
    summary = `This machine-triggered run ('${opts.triggerKind}'${resumedBit}) asserted completions its tool log does not support — zero-evidence completion claims: ${opts.verdict.unprovenKinds.join(', ')}. The ${redacted} line(s) carrying those claims were removed from the delivered answer; treat the claimed completions as ATTEMPTED, NOT CONFIRMED until re-verified with fresh tool evidence.`;
    survivor = "The surviving text below is the run's own analysis as written — only the unproven claim lines were removed; nothing else was harness-verified.";
  }
  const notice = [
    banner,
    summary,
    survivor,
    ...(opts.verificationFooter ? ['', opts.verificationFooter] : []),
  ].join('\n');
  return { finalText: `${notice}\n\n${bodyLines.join('\n')}`, notice };
}

/**
 * The 1:1 stand-in for a line elided by the line-level REPLACE lane (P4
 * CanLaw L5). MUST extract ZERO completion claims and zero future-dated
 * claims itself (tests pin both) — otherwise the delivered answer would
 * re-convict on re-extraction.
 */
export const REDACTED_FINDING_LINE = '[line removed — fabricated or unverified content, see the guard verdict]';

/** The last fenced ```claims block's [start, end] LINE indexes in text, or null.
 *  (The claims-block parser keeps no offsets; near-identical fence grammar to
 *  claims-block.ts findClaimsFences — RAW lines only: on trimmed lines a
 *  ≥4-space-indented pseudo-fence would match here while the parser never
 *  sees it, the ticket 59ac00bd F1 hole. One deliberate difference: the
 *  parser's open/close regexes tolerate a trailing \r (CRLF finals) while
 *  this helper's (and guard-4's CLAIMS_FENCE_OPEN_EXACT_RE) do not — a CRLF
 *  block then leaves no span here, fail-CLOSING the REPLACE lane to
 *  whole-final replacement. Pre-existing, probed identical at the ticket
 *  59ac00bd merge-base and branch — reviewer sub-session bba48d63 NIT 3.) */
function lastClaimsFenceLineSpan(lines: string[]): { start: number; end: number } | null {
  let span: { start: number; end: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    if (!/^[ \t]{0,3}```claims[ \t]*$/.test(lines[i])) continue;
    for (let j = i + 1; j < lines.length; j++) {
      if (/^[ \t]*```[ \t]*$/.test(lines[j])) {
        span = { start: i, end: j };
        i = j;
        break;
      }
    }
  }
  return span;
}

/**
 * LINE-LEVEL REPLACE (P4 CanLaw L5): the REPLACE lane used to substitute the
 * WHOLE final whenever any non-redactable finding class fired — throwing away
 * every receipted, verifiable line with the fabrication. When (a) every
 * populated finding class can be LOCATED to specific lines and (b) at least
 * one RECEIPTED line survives the elision (a line citing an ok harness
 * receipt id, or carrying a claim the receipts id-match), this renders the
 * middle lane instead: convicted lines are elided 1:1 with
 * REDACTED_FINDING_LINE under an honest REMOVED banner, everything else is
 * delivered byte-identical, and the caller preserves the pre-strike original
 * as a size-capped `guardOriginal` message-metadata attachment.
 *
 * Returns null — the caller falls back to full replacement — when:
 *   - forgedFooter or fabricatedQuotes is populated (forgery / fabricated
 *     quote blocks are not line-locatable fail-closed — the whole final is
 *     tainted);
 *   - any populated finding class locates NO line (mismatched inputs —
 *     fail-closed, mirroring renderRedactedFinal's rule (b));
 *   - no receipted line survives, or nothing survives at all.
 */
export function renderLineLevelRemovedFinal(opts: {
  originalText: string;
  verdict: GuardVerdict;
  receipts: ToolReceipt[];
  triggerKind: string;
  resumed?: boolean;
  verificationFooter?: string;
}): { finalText: string; notice: string; removedLines: string[] } | null {
  const gv = opts.verdict;
  // Gate flip 2026-09-11 (owner: full steam): a fabricated_quote note no
  // longer forces the WHOLE-final REPLACE for the other classes — quotes are
  // note-only (not line-located below; the notice still names them) —
  // opt-in QUOTE_GUARD_ENFORCE=1 restores the fail-closed null.
  if (gv.forgedFooter === true || (process.env.QUOTE_GUARD_ENFORCE === '1' && (gv.fabricatedQuotes?.length ?? 0) > 0)) return null;
  const lines = (opts.originalText || '').split('\n');
  const trimmed = lines.map((l) => l.trim());
  const convicted = new Set<number>();
  /** Convict every line satisfying pred; false when NONE matched (fail-closed). */
  const convictWhere = (pred: (line: string) => boolean): boolean => {
    let hit = false;
    for (let i = 0; i < trimmed.length; i++) {
      if (trimmed[i] && pred(trimmed[i])) {
        convicted.add(i);
        hit = true;
      }
    }
    return hit;
  };
  // Locate every populated finding class; a class that locates nothing forces
  // the full-replacement fallback (fail-closed — never deliver a final whose
  // convicted content we could not find to remove).
  for (const c of gv.unprovenClaims ?? []) {
    if (!convictWhere((l) => l === c.text)) return null;
  }
  if ((gv.unprovenKinds.length > 0) && !(gv.unprovenClaims?.length ?? 0)) return null; // object parity (45edaf25 N1)
  for (const c of gv.futureDatedClaims ?? []) {
    if (!convictWhere((l) => l === c.text)) return null;
  }
  if ((gv.futureDated.length > 0) && !(gv.futureDatedClaims?.length ?? 0)) return null;
  for (const n of [...gv.fabricatedPrs, ...gv.refutedMergePrs]) {
    if (!convictWhere((l) => prNumbersOnLine(l).includes(n))) return null;
  }
  for (const sha of gv.fabricatedShas ?? []) {
    const s = sha.toLowerCase();
    if (!convictWhere((l) => l.toLowerCase().includes(s))) return null;
  }
  for (const id of [...(gv.fabricatedDeployRuns ?? []), ...(gv.refutedDeployRuns ?? []), ...(gv.fabricatedTicketIds ?? []), ...(gv.fabricatedTodoIds ?? []), ...(gv.fabricatedOwnerQuestionIds ?? []), ...(gv.fabricatedScheduleIds ?? [])]) {
    const s = String(id).toLowerCase();
    if (!convictWhere((l) => l.toLowerCase().includes(s))) return null;
  }
  if (gv.unverifiedBlockClaims?.length) {
    const span = lastClaimsFenceLineSpan(lines);
    if (!span) return null;
    for (let i = span.start; i <= span.end; i++) convicted.add(i);
  }
  if (!convicted.size) return null; // nothing locatable — not this lane's case
  // Surviving-receipted-content gate: ≥1 non-convicted line must be RECEIPTED —
  // it cites an ok harness receipt id (full or ≥8-char prefix), or carries a
  // completion claim the ok receipts id-match (PR number / sha in ids).
  const okReceipts = opts.receipts.filter((r) => r.ok);
  const okIdPrefixes = okReceipts.map((r) => r.id.toLowerCase().slice(0, 8)).filter((p) => p.length === 8);
  const lineIsReceipted = (line: string): boolean => {
    const lower = line.toLowerCase();
    if (okIdPrefixes.some((p) => lower.includes(p))) return true;
    for (const claim of extractCompletionClaims(line)) {
      if (claim.prNumber !== undefined && okReceipts.some((r) => r.ids?.prNumber !== undefined && r.ids?.prNumber !== null && String(r.ids.prNumber) === String(claim.prNumber))) return true;
      // Finding A1: a git_commit receipt never makes a push/banked line "receipted".
      if (isOriginShaKind(claim.kind) && claim.sha && okReceipts.some((r) => typeof r.ids?.sha === 'string' && !isLocalReceiptTool(r.tool) && exonShaMatches(claim.sha!, r.ids.sha))) return true;
    }
    return false;
  };
  let survivors = 0;
  let receiptedSurvivor = false;
  for (let i = 0; i < trimmed.length; i++) {
    if (!trimmed[i] || convicted.has(i)) continue;
    survivors++;
    if (!receiptedSurvivor && lineIsReceipted(trimmed[i])) receiptedSurvivor = true;
  }
  if (!survivors || !receiptedSurvivor) return null;
  const removedLines: string[] = [];
  const bodyLines = lines.map((l, i) => {
    if (!convicted.has(i)) return l;
    if (trimmed[i]) removedLines.push(trimmed[i]);
    return REDACTED_FINDING_LINE;
  });
  const resumedBit = opts.resumed ? ', resumed from a checkpoint' : '';
  const notice = [
    `[HARNESS EVIDENCE GUARD — ${convicted.size} FABRICATED/UNVERIFIED LINE(S) REMOVED]`,
    `This machine-triggered run ('${opts.triggerKind}'${resumedBit}) asserted content its tool log and the primary sources do not support — ${summarizeGuardVerdict(gv)}. The ${convicted.size} line(s) carrying those findings were removed from the delivered answer; treat everything they claimed as NOT DONE until re-verified with fresh tool evidence.`,
    "The surviving text below is the run's own report as written — receipt-backed lines were kept; only the convicted lines were removed. The pre-removal original is preserved on the message record for audit (guardOriginal).",
    ...(opts.verificationFooter ? ['', opts.verificationFooter] : []),
  ].join('\n');
  return { finalText: `${notice}\n\n${bodyLines.join('\n')}`, notice, removedLines };
}

/**
 * FORGERY LAYER markers (run-receipts design): these strings are HARNESS-ONLY
 * output — the guard-2 verification footer's header, the replace lane's banner,
 * the redact lane's banner (ticket f8d68167), and the replace lane's
 * audit-quote fence. A final answer containing one means the MODEL
 * imitated the harness's own conviction chrome (the dcc51edb/675c3eb9 lane).
 * Deliberately NOT the bare '[HARNESS EVIDENCE GUARD]' prefix — that one is
 * legitimate inside quoted journal strings.
 */
const FORGED_MARKER_RES: RegExp[] = [
  /🔍 Harness claim verification \(verified-at/,                    // renderVerificationFooter header
  /🔍 Harness push-claim verification \(commits API\)/,             // renderPushVerificationFooter header (2026-09-08 audit: was forgeable)
  /🔍 Harness deploy-run verification \(GitHub Actions API\)/,      // renderDeployVerificationFooter header (2026-09-08 audit: was forgeable)
  /\[HARNESS EVIDENCE GUARD — [^\]]*REPLACED\]/,                    // renderSuppressedFinal banner
  /\[HARNESS EVIDENCE GUARD — [^\]]*REMOVED\]/,                     // renderRedactedFinal banner (ticket f8d68167 — harness-only chrome, same forgery class as REPLACED)
  /--- BEGIN UNVERIFIED RUN OUTPUT/,                                // renderSuppressedFinal audit fence
  /\[HARNESS EVIDENCE GUARD — UNVERIFIED QUOTED OUTPUT\]/,          // renderQuotedOutputNote (GUARD 4 annotate note)
  /\[HARNESS EVIDENCE GUARD — CLAIMS BLOCK (?:VERIFIED|UNVERIFIED|UNVERIFIABLE|MALFORMED)\]/, // claims-block lane notes (audit #6 phase 1; UNVERIFIABLE tier P4 v1#23)
];

/**
 * Receipt-id citation pinpoint (run-receipts follow-up "citable receipt ids"):
 * a FULL-uuid receipt id cited right after the word "receipt" — the platform
 * envelope carries receiptId so a disciplined model can cite the harness's own
 * record. Only full uuids match: a PREFIX citation is ignored entirely (never
 * half-matched into a conviction, never counted as evidence).
 */
const RECEIPT_CITE_RE = /\breceipts?(?:\s+ids?)?\s*[:#=]?\s*\(?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/gi;

/**
 * Relay citation (ticket 93006fd8 — the coordination-lane recurrence): a
 * message-id citation in the fleet's prescribed relay format ("Path C reports
 * <sha> (msg `16ad4828`)"). A coordination lane's whole job is relaying OTHER
 * chats' freshly-pulled state, yet its platform read tools (get_chat_messages /
 * get_chat_status / todo_list) leave NO receipts and sit in NO evidence tier —
 * so every relayed probe/commit claim convicted as zero-evidence no matter how
 * the prompt was steered (three strikes on session e083ff2e, two of them AFTER
 * prompt-steering closures). A cited id that VERIFIABLY appears in this run's
 * observed tool outputs (the GUARD 3/5/6 haystack union — the model cannot
 * forge the haystack) is anchored to a real pull: claims on that line are
 * grounded relays, not inventions. An UNANCHORED citation (id absent from the
 * haystack) exonerates nothing, and an uncited first-person claim is untouched.
 */
const RELAY_CITE_RE = /\b(?:msgs?|messages?)\s*[:#=]?\s*\(?\s*`?([0-9a-f]{8,40})\b/gi;

/**
 * Where a relay citation may be ANCHORED (2026-09-08 audit): the fleet's
 * platform READ tools — the outputs a coordination lane actually relays. The
 * first cut anchored a cited id against the whole GUARD 3/5/6 haystack, so a
 * sha prefix that appeared in ANY tool output (a local `git log` of an
 * UNPUSHED commit, a `ls` of a build dir) cited as "msg <hex>" exonerated
 * every claim on its line and pulled the sha out of GUARD 2b's commits-API
 * re-query. Outside these tools an id anchors only in message-id SHAPE
 * (`"id":"<id>…`, `id: <id>`, `msg <id>`) — the form a transcript pull prints,
 * never the bare hex of a git log line.
 */
const RELAY_SOURCE_TOOLS = new Set(['get_chat_messages', 'get_chat_status', 'list_chats', 'todo_list', 'goal_list', 'goal_get', 'list_schedules', 'list_feedback', 'schedule_get', 'get_supervisor_state']);
const relayIdShapedIn = (haystackLower: string, idLower: string): boolean =>
  new RegExp(String.raw`(?:"id"\s*:\s*"|\bids?\s*[:=]\s*\`?|\b(?:msgs?|messages?)\s*[:#=]?\s*\(?\s*\`?)${idLower}`, 'i').test(haystackLower);

/**
 * Cross-chat receipt evidence (finding A1 review fix, 2026-09-27): the
 * doctrine tells a supervisor that a relayed sha or "banked" CITES A git_push
 * RECEIPT — read via get_run_receipts on the LANE's chat. That receipt is the
 * lane's harness record, not this run's, so the receipt lanes above never saw
 * it: the guard convicted exactly the wake that followed the doctrine. This
 * reads the `get_run_receipts` tool outputs of THIS run (the platform envelope
 * — JSON, or the display slice of it when truncated) and returns (a) the shas
 * of ok:true git_push rows — a commit_pushed / commit_local claim naming one
 * is receipt-proven, and (b) every receipt uuid printed there — a citation of
 * one is OBSERVED, not forged (GUARD 0b). Only git_push rows count: a lane's
 * git_commit row is as local as this run's own. Tolerant of truncation (a
 * regex walk when the JSON does not parse). Pure.
 */
export function observedRunReceiptEvidence(parts: MessagePart[]): { pushShas: string[]; receiptIds: string[] } {
  const pushShas = new Set<string>();
  const receiptIds = new Set<string>();
  const addRow = (row: any): void => {
    if (!row || typeof row !== 'object') return;
    if (typeof row.id === 'string' && UUID_RE.test(row.id)) receiptIds.add(row.id.toLowerCase());
    if (row.tool === 'git_push' && row.ok === true && typeof row.ids?.sha === 'string' && /^[0-9a-f]{7,40}$/i.test(row.ids.sha)) pushShas.add(row.ids.sha.toLowerCase());
  };
  for (const p of parts) {
    if (p.type !== 'tool_result' || String(p.name) !== 'get_run_receipts' || typeof p.result !== 'string' || !p.result) continue;
    const text = p.result;
    let parsed: any = null;
    try { parsed = JSON.parse(text); } catch { parsed = null; }
    if (parsed && typeof parsed === 'object') {
      for (const run of Array.isArray(parsed.runs) ? parsed.runs : []) for (const r of Array.isArray(run?.receipts) ? run.receipts : []) addRow(r);
      for (const turn of Array.isArray(parsed.chatTurns) ? parsed.chatTurns : []) for (const r of Array.isArray(turn?.receipts) ? turn.receipts : []) addRow(r);
      continue;
    }
    // Truncated / non-JSON display slice: walk the rows by shape.
    for (const m of text.matchAll(/"tool"\s*:\s*"git_push"\s*,\s*"ok"\s*:\s*true\s*,\s*"ids"\s*:\s*\{([^{}]*)\}/g)) {
      const sha = /"sha"\s*:\s*"([0-9a-f]{7,40})"/i.exec(m[1])?.[1];
      if (sha) pushShas.add(sha.toLowerCase());
    }
    for (const m of text.matchAll(UUID_SCAN_RE)) receiptIds.add(m[0].toLowerCase());
  }
  return { pushShas: [...pushShas], receiptIds: [...receiptIds] };
}
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_SCAN_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

// ── Content-bound exoneration (P4 v1#24 / spark B11 / CanLaw B5) ─────────────
//
// The residual after the 3e4612f3 ok-only hardening: exoneration was still
// ID-PRESENCE-scoped — ANY cited ok receipt id (or anchored relay msg id) on a
// line cleared EVERY claim on that line, so one real citation laundered an
// unrelated fabricated claim sharing the line ("sent the digest (receipt
// 3f2a…) and merged PR #999"). Exoneration is now CONTENT-BOUND: the claim's
// own key tokens (PR number, push sha) must be provable by the cited
// receipt's ids (citation lane) or present in this run's observed tool output
// (relay lane). Token-less kinds (deploy/probe/benchmark) bind to the cited
// receipt's TOOL CLASS instead — a cited send_chat_message receipt no longer
// clears a probe claim.

/** Hex-sha prefix match, either direction, both sides ≥7 hex. */
const exonShaMatches = (a: string, b: string): boolean => {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  if (!/^[0-9a-f]{7,40}$/.test(x) || !/^[0-9a-f]{7,40}$/.test(y)) return false;
  return x === y || x.startsWith(y) || y.startsWith(x);
};

/** Tool classes a token-less claim kind may bind to (mirrors claimHasEvidence's tiers). */
function citedToolEvidencesKind(kind: ClaimKind, tool: string, claimText?: string): boolean {
  switch (kind) {
    case 'pr_merged':
    case 'pr_created':
    case 'pr_closed':
      return EXTERNAL_ACTION_TOOL_RE.test(tool);
    case 'deploy':
      // F32: the DEPLOY_ALT observation shape also binds to the deploy-health
      // observation tools (get_fleet_telemetry / web health reads) — the same
      // CONTENT BOUNDARY as claimHasEvidence's tier. DEPLOY-ONLY by kind
      // (review F1): pr_* kinds NEVER widen. A deploy-verb line stays
      // action-only. Kill switch: EVIDENCE_GUARD_DEPLOY_OBSERVATION_DISABLED=1.
      return EXTERNAL_ACTION_TOOL_RE.test(tool)
        || (!deployObservationTierDisabled() && isDeployObservationClaimText(claimText) && DEPLOY_HEALTH_OBSERVATION_TOOLS.has(tool));
    case 'commit_pushed':
    case 'commit_local':
      // Finding A1: the local class (git_commit) is not origin evidence.
      return EXTERNAL_ACTION_TOOL_RE.test(tool) && !isLocalReceiptTool(tool);
    case 'probe':
    case 'benchmark':
      // Ticket 212b3aa0: the read-only platform observation tools are the
      // claim's evidence class too — a cited get_chat_status/todo_get receipt
      // DOES exonerate a fleet-state probe claim on its line. CONTENT
      // BOUNDARY (ticket 4df4bb41): never for infra-subject probes
      // (box / tailnet / remote host) — fleet reads cannot observe a box.
      // computer_task stays UNGUARDED (ticket 2ab33824): it drives the
      // owner's own Mac, where a box's terminal/dashboard may be on screen.
      return EXTERNAL_ACTION_TOOL_RE.test(tool) || LOCAL_READ_TOOLS.has(tool) || WEB_READ_TOOLS.has(tool) || COMPUTER_USE_TOOLS.has(tool)
        || (!(claimText && INFRA_PROBE_SUBJECT_RE.test(claimText)) && PLATFORM_OBSERVE_TOOLS.has(tool));
  }
}

/**
 * Does one of the receipts CITED ON THE CLAIM'S LINE actually prove this
 * claim? Id-bearing claims demand the claim's key token either in the cited
 * receipt's ids OR — when the cited receipt is of the claim's own evidence
 * tool class — verbatim in the run's observed tool OUTPUT (the honest gh-CLI
 * shape: a run_command receipt's ids are empty but the CLI output printed the
 * PR number). No coarse any-ok fallback — that is exactly the laundering
 * hole. Token-less kinds accept a cited ok receipt of the claim's evidence
 * class.
 */
export function citedReceiptProvesClaim(claim: CompletionClaim, citedOk: ToolReceipt[], haystacksLower: string[]): boolean {
  if (!citedOk.length) return false;
  const classCited = citedOk.some((r) => citedToolEvidencesKind(claim.kind, r.tool, claim.text));
  if (claim.prNumber !== undefined && claim.prNumber !== null) {
    if (citedOk.some((r) => r.ids?.prNumber !== undefined && r.ids?.prNumber !== null
      && String(r.ids.prNumber) === String(claim.prNumber))) return true;
    return classCited && prNumberInHaystack(claim.prNumber, haystacksLower);
  }
  if (isOriginShaKind(claim.kind) && claim.sha) {
    // Finding A1: a cited git_commit receipt's sha is LOCAL — it cannot prove a push/banked line.
    if (citedOk.some((r) => typeof r.ids?.sha === 'string' && !isLocalReceiptTool(r.tool) && exonShaMatches(claim.sha!, r.ids.sha))) return true;
    const sha = claim.sha.toLowerCase();
    return classCited && haystacksLower.some((h) => h.includes(sha));
  }
  return classCited;
}

/** PR-number presence in a haystack with digit boundaries ("15205" never vouches for "520"). */
const prNumberInHaystack = (n: number, haystacksLower: string[]): boolean => {
  const re = new RegExp(String.raw`(?<!\d)${n}(?!\d)`);
  return haystacksLower.some((h) => re.test(h));
};

/**
 * Relay-lane content binding: an anchored msg citation exonerates an
 * ID-BEARING claim only when the claim's own token (PR number / sha) ALSO
 * appears in this run's observed tool output — the relayed state must contain
 * the fact being relayed. Token-less claims keep the anchored-citation
 * exoneration (their "content" is the relayed narrative itself).
 */
export function relayBindsClaimContent(claim: CompletionClaim, haystacksLower: string[]): boolean {
  if (claim.prNumber !== undefined && claim.prNumber !== null) return prNumberInHaystack(claim.prNumber, haystacksLower);
  if (isOriginShaKind(claim.kind) && claim.sha) {
    const sha = claim.sha.toLowerCase();
    return haystacksLower.some((h) => h.includes(sha));
  }
  return true;
}

export async function applyCompletionClaimGuard(opts: {
  finalText: string;
  parts: MessagePart[];
  triggerKind: 'user' | 'schedule' | 'hook' | 'machine';
  resumed?: boolean;
  userId: string;
  repoUrl?: string | null;
  githubLabel?: string | null;
  provider?: string | null;
  /**
   * Cross-repo PR claims (rollout watch 2026-09-14): repo NAME → slug for the
   * owner's other repositories, so "glm53 PR #16" verifies against glm53 and
   * an unknown sibling name downgrades to UNVERIFIED instead of "fabricated".
   * Built by run-executor from the owner's projects' repoUrls (pure here).
   */
  repoAliases?: Map<string, { owner: string; repo: string }>;
  /**
   * The run's tool-execution receipts (run-executor passes the in-process ∪
   * prior-attempts union). PROVIDED → GUARD 1 resolves claims against receipts
   * (receiptMatchesClaim — a staged confirmation or a failed tool call proves
   * nothing). ABSENT → the legacy parts-text path (findUnprovenClaims) runs
   * unchanged for non-executor callers.
   */
  receipts?: ToolReceipt[];
  /**
   * Prior-attempt tool OUTPUT texts (run-executor mines them from the resumed
   * checkpoint's messages via toolTextsFromMessages — review round-3 F1).
   * GUARD 4's haystack is otherwise THIS attempt's parts only, and a resumed
   * run's parts hold nothing from earlier attempts — a resume honestly
   * quoting its pre-interrupt log was convicted without this union. Same
   * asymmetry the receipts union already fixes for GUARD 1.
   */
  priorToolTexts?: string[];
  /**
   * This attempt's FULL model-facing tool texts (run-executor passes
   * AgentRunResult.toolTexts — review round-4 B-1). parts carry only the
   * 8000-char display slice of each result, but the model quotes from the
   * full text it was shown — without this union an honest quote past the
   * display cut was convicted by GUARD 4's strict line-match, in exactly the
   * incident's own long-monitor-run class.
   */
  toolTexts?: string[];
  /**
   * Schedule-firing instants (operator iteration 13, 2026-09-25) — the
   * executor's prisma fetch of every ENABLED coding_schedules.nextRunAt in
   * [now−10min, now+24h], passed through to findFutureDatedClaims: a forward
   * clock matching one within ±60s is a paraphrased FIRING TIME ("next tick
   * 11:30Z", an ETA cell), not an invented observation. Same injected-data
   * discipline as the GUARD 7 resolvers — this module never touches prisma
   * directly; absent/empty → the exemption is simply off. Kill switch:
   * Exemption unconditional since 2026-11-02 (read inside the detector).
   */
  scheduleFiringTimes?: number[];
  now?: Date;
  /** Test seam for the GUARD 5 Actions-API calls (mirrors verifyPushClaims). */
  fetchImpl?: typeof fetch;
  /**
   * GUARD 6 existence resolver (ticket 8e9d6496): the EXECUTOR injects its
   * prisma-backed lookup (cited id → a feedback-store row exists); this
   * module keeps its no-prisma discipline. ABSENT or THROWING → the lane
   * stays SILENT (never a conviction on missing/unavailable verification).
   * Returns the subset of the queried ids that exist.
   */
  ticketIdsExist?: (ids: string[]) => Promise<Set<string>>;
  /**
   * GUARD 7 existence resolvers (ticket 938dac2e): the EXECUTOR injects its
   * prisma-backed lookups (cited todo id → a project_todos row; cited oq_ id →
   * an owner_questions row). Same discipline as ticketIdsExist — ABSENT or
   * THROWING → the lane stays SILENT. Returns the subset that exists.
   */
  todoIdsExist?: (ids: string[]) => Promise<Set<string>>;
  ownerQuestionIdsExist?: (ids: string[]) => Promise<Set<string>>;
  /**
   * GUARD 6 board resolver (ticket dc636d0c): the EXECUTOR injects its
   * prisma-backed lookup (cited id → a project_goals row). Used ONLY for
   * TYPED claims-fence ticket_update refs, whose documented vocabulary
   * (claims-block.ts) is ticketId | goalId | todoId — a real goal id cited
   * under ticket_update is legitimate ledger work, not a fabricated ticket
   * id. Same discipline as todoIdsExist — ABSENT or THROWING → exonerates
   * its ids (fail-open). Returns the subset that exists.
   */
  goalIdsExist?: (ids: string[]) => Promise<Set<string>>;
  /**
   * GUARD 8 existence resolver (ticket cae70bfa): the EXECUTOR injects its
   * prisma-backed lookup (cited schedule id/prefix → a coding_schedules row,
   * ANY session, enabled or disabled — a cancelled/paused row is still a real
   * citation; cancellation never deletes the row). Same discipline as
   * ticketIdsExist — ABSENT or THROWING → the lane stays SILENT. Returns the
   * subset that exists.
   */
  scheduleIdsExist?: (ids: string[]) => Promise<Set<string>>;
  /**
   * CARRIED-EVIDENCE tier (tt-rd audit 2026-09-27, finding self-audit-churn-4):
   * ok receipts from EARLIER runs of the SAME chat (the executor passes
   * getRecentChatReceipts over ≤ 7 d, ≤ 200 rows, this run's own rows
   * excluded). A machine-run claim naming a STABLE artifact (PR number /
   * pushed sha) that is NOT phrased as fresh and matches one of these is
   * rendered CARRIED, not UNVERIFIED — lanes were re-probing every closed
   * artifact each firing because the this-run-only scope struck a truthful
   * restatement. (RSW-1 cl30, 2026-11-02: the release switch expired
   * 2026-11-12 and was deleted — the tier is unconditional.) Absent → nothing
   * to carry.
   */
  carriedReceipts?: ToolReceipt[];
}): Promise<{ finalText: string; notes: string[]; verdict: GuardVerdict }> {
  let { finalText } = opts;
  const originalText = finalText;
  const notes: string[] = [];
  const verdict: GuardVerdict = { unprovenKinds: [], fabricatedPrs: [], refutedMergePrs: [], futureDated: [] };
  try {
    // Cross-chat receipt evidence (finding A1 review fix): the git_push shas
    // and receipt uuids this run READ via get_run_receipts (a lane's harness
    // record). Empty under the A1 kill switch — pre-split, no such lane.
    const observedReceipts = observedRunReceiptEvidence(opts.parts);
    const observedPushShaProves = (c: CompletionClaim): boolean =>
      isOriginShaKind(c.kind) && !!c.sha && observedReceipts.pushShas.some((s) => exonShaMatches(c.sha!, s));

    // GUARD 0 — FORGERY (all triggers; on the ORIGINAL text, BEFORE the
    // no-claims early return): a model quoting the harness's own markers is
    // forging evidence chrome, whether or not it also makes extractable claims.
    if (FORGED_MARKER_RES.some((re) => re.test(originalText))) {
      verdict.forgedFooter = true;
      const note = [
        '[HARNESS EVIDENCE GUARD — FORGED HARNESS MARKER]',
        "The final answer above contains text ONLY the harness itself emits (a claim-verification footer header, a replacement banner, or an audit-quote fence) — the model imitated the guard's own conviction chrome (cf. tickets dcc51edb/675c3eb9).",
        "Any verification or evidence the answer SHOWS is fabricated; trust only this run's harness-written verdict row and integrity ticket.",
      ].join('\n');
      finalText += `\n\n${note}`;
      notes.push(note);
    }

    // GUARD 0b — RECEIPT-ID CITATION pinpoint (receipts provided only): a cited
    // id IN the harness receipt set is explicit evidence for claims on the
    // citing line (applied in GUARD 1 below, CONTENT-BOUND since P4 v1#24 —
    // the cited receipt must itself prove the claim's key tokens/kind); one
    // ABSENT from the set is a forged citation — the same conviction lane as
    // footer mimicry.
    // fb64368a review (2026-10-15): knownIds is the union of THIS run's
    // receipts AND the carried pool (opts.carriedReceipts, ≤7d chat
    // receipts). A citation names A RECEIPT — the id is just as real when an
    // earlier run of this chat minted it: an honest zero-tool relay that
    // restates a prior firing's receipt id from injected context (transcript,
    // parent digest, FS relay) is NOT a forger. This mirrors the fence-side
    // re-adjudication in run-executor (run ∪ carried), which was already
    // carried-aware; the prose leg was carried-blind (review finding 1). A
    // carried id still EXONERATES nothing except the citation itself: only
    // citedOkReceipts (this run's ok:true receipts) evidence a claim.
    let citedOkReceipts: ToolReceipt[] = [];
    if (opts.receipts) {
      const knownIds = new Set([...opts.receipts, ...(opts.carriedReceipts ?? [])].map((r) => r.id.toLowerCase()));
      // Only an ok:true receipt can EXONERATE a claim on its citing line
      // (2026-09-08 audit): citing the real id of a FAILED git_push proved the
      // opposite of the claim, yet used to pass GUARD 1. A cited ok:false id is
      // still a KNOWN id (not a forgery) — it simply evidences nothing.
      // Deliberately NOT unioned with the carried pool: a carried receipt is
      // evidence of an EARLIER run's act, never of this run's claims.
      const cited = new Set<string>();
      for (const m of originalText.matchAll(RECEIPT_CITE_RE)) cited.add(m[1].toLowerCase());
      citedOkReceipts = opts.receipts.filter((r) => r.ok && cited.has(r.id.toLowerCase()));
      // Finding A1 review fix: a uuid this run READ in a get_run_receipts
      // output (another lane's receipt) is OBSERVED, not invented — it is
      // never a forgery. It still exonerates nothing by itself (only the
      // git_push-sha lane below proves a claim).
      const observedIds = new Set(observedReceipts.receiptIds);
      const forged = [...cited].filter((id) => !knownIds.has(id) && !observedIds.has(id));
      if (forged.length) {
        verdict.forgedFooter = true;
        verdict.forgedCitationIds = forged;
        const note = [
          '[HARNESS EVIDENCE GUARD — FORGED RECEIPT CITATION]',
          `The final answer cites receipt id(s) this run's harness receipt set does NOT contain: ${forged.join(', ')}.`,
          'A receipt citation is only meaningful when the harness wrote that receipt — an invented id is fabricated evidence, worse than no citation.',
        ].join('\n');
        finalText += `\n\n${note}`;
        notes.push(note);
      }
    }

    // GUARD 4 — QUOTED-OUTPUT verification (all triggers, cheap, no network;
    // ticket 7cb26cb0): a quoted "verbatim" log/tool-output block introduced
    // as an OBSERVATION must line-match a real tool_result of this run. The
    // publish-chain lanes above cannot see this class — the 2026-08-26
    // monitor run passed guard 2 on its PR claim while quoting invented
    // on-box log lines. Runs on the ORIGINAL text, before any guard notes.
    {
      // Haystack union: parts' 8000-char display slices + this attempt's FULL
      // model-facing texts (round-4 B-1) + prior-attempt checkpoint texts (F1).
      const unmatchedQuotes = findUnmatchedQuotedOutputs(originalText, opts.parts, [
        ...(opts.toolTexts ?? []),
        ...(opts.priorToolTexts ?? []),
      ]);
      if (unmatchedQuotes.length) {
        verdict.fabricatedQuotes = unmatchedQuotes.map((u) => u.excerpt);
        const note = renderQuotedOutputNote(unmatchedQuotes);
        finalText += `\n\n${note}`;
        notes.push(note);
      }
    }

    // GUARD 3 — all triggers (cheap, no network): a timestamp ANYWHERE in the
    // final that parses LATER than the run's wall clock is mechanical proof of
    // confabulation (ticket 8e814f45 — the model can imitate footers and shas,
    // but it cannot move the harness clock). The scan is no longer gated to
    // completion-claim lines and runs BEFORE the no-claims early return
    // (ticket 375c8618 — a deploy-interrupted run's fabricated status audit
    // carried its +39m clocks on lines with NO extractable completion claim,
    // so both old gates let it post). Lines verbatim-present in REAL tool
    // output stay exempt (their future stamps are the tool's own forward data
    // — next-fire times, ETAs). Runs against the ORIGINAL text, unaffected by
    // any guard notes/footers appended above.
    const fdHaystacks: string[] = [];
    for (const p of opts.parts) {
      if (p.type === 'tool_result' && typeof p.result === 'string' && p.result) fdHaystacks.push(p.result);
    }
    for (const extra of [...(opts.toolTexts ?? []), ...(opts.priorToolTexts ?? [])]) {
      if (extra) fdHaystacks.push(extra);
    }
    // Grounded-relay ids (ticket 93006fd8): the answer's msg/message citations
    // whose id VERIFIABLY appears in this run's observed tool outputs — an
    // anchored relay of another lane's freshly-pulled state. GUARD 1 and
    // GUARD 2b exonerate claims on lines carrying one; a citation absent from
    // the haystack anchors nothing (the same line-scoped discipline as the
    // receipt-citation lane).
    const observedRelayIds: string[] = [];
    {
      const citedRelayIds = new Set<string>();
      for (const m of originalText.matchAll(RELAY_CITE_RE)) citedRelayIds.add(m[1].toLowerCase());
      // Anchoring (2026-09-08 audit): a platform READ tool's output containing
      // the id, or a message-id-SHAPED occurrence anywhere in the haystack —
      // never a bare substring of arbitrary tool output (RELAY_SOURCE_TOOLS).
      const relaySourceTexts = opts.parts
        .filter((p) => p.type === 'tool_result' && typeof p.result === 'string' && RELAY_SOURCE_TOOLS.has(String(p.name)))
        .map((p) => String(p.result).toLowerCase());
      const lowerHaystacks = fdHaystacks.map((h) => h.toLowerCase());
      for (const id of citedRelayIds) {
        if (relaySourceTexts.some((h) => h.includes(id)) || lowerHaystacks.some((h) => relayIdShapedIn(h, id))) observedRelayIds.push(id);
      }
    }
    // Evidence-clock calibration (ticket 28b9414d): compare against the LATEST
    // instant this run can PROVE it observed, not just this process's clock —
    // an honest composite quote ("C1 … vs GH date: …") never appears verbatim
    // in one tool result, so the haystack exemption cannot save it, but the
    // run's real tool output still proves the evidence domain ran ahead of the
    // guard host. A phantom run has no such proof and gets no relief.
    const guardNow = opts.now ?? new Date();
    const calibratedMs = evidenceClockMs(fdHaystacks, guardNow.getTime());
    if (calibratedMs !== undefined) {
      logger.info(`Evidence guard: future-dated comparison clock calibrated +${Math.round((calibratedMs - guardNow.getTime()) / 1000)}s to the run's latest proven observed instant (${new Date(calibratedMs).toISOString()} > guard clock ${guardNow.toISOString()}) — ticket 28b9414d`);
    }
    const futureDated = findFutureDatedClaims(originalText, calibratedMs !== undefined ? new Date(calibratedMs) : guardNow, { evidenceHaystacks: fdHaystacks, scheduleFiringTimes: opts.scheduleFiringTimes });
    if (futureDated.length) {
      verdict.futureDated = futureDated.map((f) => `${f.stamp} (+${Math.max(1, Math.round(f.aheadMs / 60000))}m ahead)`);
      // Ticket 45edaf25: the claim objects ride the verdict too (non-empty
      // only) so the executor's strip+mark lane can elide the struck lines.
      verdict.futureDatedClaims = futureDated;
      const note = [
        '[HARNESS EVIDENCE GUARD — FUTURE-DATED CLAIMS]',
        `${futureDated.length} line(s) cite observation/merge timestamps LATER than this run's wall clock: ${verdict.futureDated.join('; ')}.`,
        'A completed observation cannot be dated in the future — treat those claims as confabulated regardless of any other evidence shown.',
      ].join('\n');
      finalText += `\n\n${note}`;
      notes.push(note);
    }

    // GUARD 5 — DEPLOY-RUN-ID claim→journal cross-check + GitHub Actions
    // primary source (all triggers; ticket 8e9d6496). Runs BEFORE the claims
    // gate: "deploy 33236939738 completed success" matches NO ClaimKind
    // (DEPLOY_OK_RE lacks 'completed'/'success'), so the 2026-08-29 nightly
    // fabrications reached the final with only guard 3's timestamp firing.
    // Lane A (claim→journal): an id THIS run's tool evidence carries was
    // OBSERVED — the run watched that deploy; skip the API entirely. Lane B:
    // the Actions API — 404 = fabricated; an existing run whose state
    // contradicts the claimed terminal state = refuted. 'unavailable' stays
    // silent (never a conviction on infra).
    {
      // Lane A skips the API only when the evidence shows the id TOGETHER
      // WITH the claimed terminal state nearby (2026-09-08 audit: a `gh run
      // list` row showing the id as in_progress/failure used to count as
      // "observed" and let a "completed success" claim go unverified).
      const deployClaims = extractDeployRunClaims(originalText)
        .filter((c) => !fdHaystacks.some((h) => haystackShowsDeployState(h, c.runId, c.claimedState)));
      if (deployClaims.length) {
        const dvs = await verifyDeployRunClaims({
          claims: deployClaims,
          userId: opts.userId,
          repoUrl: opts.repoUrl,
          githubLabel: opts.githubLabel,
          provider: opts.provider,
          fetchImpl: opts.fetchImpl,
        });
        const checked = dvs.filter((v) => v.state !== 'unavailable');
        if (checked.length) {
          const footer = renderDeployVerificationFooter(checked);
          finalText += `\n\n${footer}`;
          notes.push(footer);
          const fabricated = checked.filter((v) => v.state === 'missing').map((v) => v.runId);
          const refuted = checked.filter((v) => v.state === 'refuted').map((v) => v.runId);
          if (fabricated.length) verdict.fabricatedDeployRuns = fabricated;
          if (refuted.length) verdict.refutedDeployRuns = refuted;
        }
      }
    }

    // GUARD 6 — FEEDBACK-TICKET-ID claim→journal cross-check (all triggers;
    // ticket 8e9d6496 incident 3: an "11-ticket open batch" citing INVENTED
    // ids 01226f89 / 4de4a5ef). Lane A: a cited id this run's evidence carries
    // (a list_feedback row's full uuid CONTAINS the cited prefix; a
    // file_feedback receipt's ids.ticketId matches) is observed-real and never
    // reaches the resolver. Lane B: the INJECTED existence resolver (the
    // executor's prisma-backed lookup); absent or throwing → SILENT. A
    // findings-only note, NO clean-pass footer: triage lanes cite dozens of
    // real ids per final — a ✅ line per id is annotation noise that buries
    // the signal.
    {
      const ticketCitations = extractTicketIdCitations(originalText);
      const citedTicketIds = ticketCitations.map((c) => c.id);
      if (citedTicketIds.length && opts.ticketIdsExist) {
        // Receipt exemption (ticket dc636d0c): the claims vocabulary
        // (claims-block.ts RECEIPT_TOOLS) documents ticket_update refs as
        // ids.ticketId | ids.goalId | ids.todoId — the goal/todo mutation
        // tools (goal_update / goal_premise_set / todo_update) leave
        // receipts with exactly those id keys, so an id this run's receipts
        // carry under ANY of the three keys is observed-real and never
        // reaches a resolver. The incident: a receipt-backed todo_update
        // ids.todoId ref (todo 71c98f40) was checked against the feedback
        // store alone and struck as fabricated.
        const receiptTicketIds = (opts.receipts ?? [])
          .flatMap((r) => [r.ids?.ticketId, r.ids?.goalId, r.ids?.todoId])
          .filter((x): x is string => typeof x === 'string')
          .map((x) => String(x).toLowerCase());
        const toVerify = citedTicketIds.filter((id) =>
          !receiptTicketIds.some((rid) => rid.startsWith(id))
          && !fdHaystacks.some((h) => h.toLowerCase().includes(id)));
        if (toVerify.length) {
          // FENCE-classified ids (ticket dc636d0c): a typed claims-block
          // ticket_update ref is union-resolved — feedback store OR goal
          // board OR todo board. A lane whose ledger writes were goal/todo
          // mutations cites them under ticket_update (the closest type in
          // the lane vocabulary — there is no goal_update/todo_update
          // claims type), so a real todo/goal id there is legitimate
          // receipt-backed ledger work, not a fabricated ticket id. An id
          // lifted BOTH in prose and in a fence takes the union (the
          // exoneration-superset direction — misses are acceptable, false
          // convictions are not). PROSE citations stay ticket-store-only:
          // "tickets 01226f89 / 4de4a5ef" batch claims must still convict
          // when neither board has the id (8e9d6496 recall).
          const fenceIds = toVerify.filter((id) => ticketCitations.some((c) => c.id === id && c.fromClaimsFence));
          let existing: Set<string> | null = null;
          try {
            existing = await opts.ticketIdsExist(toVerify);
          } catch (err: any) {
            logger.warn(`evidence-guard: ticketIdsExist threw (lane stays silent): ${err?.message}`);
            existing = null;
          }
          if (existing) {
            // Review MINOR 2 (sub-session 6bdc4019): never mutate the Set the
            // injected resolver returned — a future frozen/readonly Set (or a
            // shared cache) must not throw or leak exoneration across calls.
            // A copy is cheap; the throw path was already fail-open, this
            // removes the failure mode entirely.
            const existingUnion = new Set(existing);
            for (const resolveBoard of [opts.goalIdsExist, opts.todoIdsExist]) {
              if (!fenceIds.length || !resolveBoard) continue;
              try {
                for (const id of await resolveBoard(fenceIds)) existingUnion.add(id);
              } catch (err: any) {
                // A throwing board resolver exonerates its ids (fail-open,
                // the executor resolvers' own discipline) — a DB hiccup
                // must never re-create the false strike this fix removes.
                logger.warn(`evidence-guard: board resolver threw (its fence ids exonerated): ${err?.message}`);
                for (const id of fenceIds) existingUnion.add(id);
              }
            }
            const fabricated = toVerify.filter((id) => !existingUnion.has(id));
            if (fabricated.length) {
              verdict.fabricatedTicketIds = fabricated;
              const note = [
                '[HARNESS EVIDENCE GUARD — FABRICATED TICKET IDS]',
                `The final answer cites feedback-ticket id(s) that do not exist in the feedback store: ${fabricated.join(', ')}.`,
                'A ticket id is only meaningful when the store has that row — an invented id is a fabricated claim (ticket 8e9d6496: the 2026-08-29 nightly lane cited invented batch ids 01226f89 / 4de4a5ef).',
              ].join('\n');
              finalText += `\n\n${note}`;
              notes.push(note);
            }
          }
        }
      }
    }

    // GUARD 7 — BOARD-CITATION claim→journal cross-check (all triggers; ticket
    // 938dac2e, 2026-09-15: the tt-rd firing-445 lane fabricated a WHOLE run
    // report — cited todo 1c0db1a5 "Todo not found", cited oq_8c8b15d4 no such
    // row — the first end-to-end fabrication; GUARD 6 covered feedback tickets
    // only). Same two-lane discipline: (A) an id this run's OWN evidence carries
    // (a todo_create/todo_update receipt's ids.todoId prefix-match; any cited id
    // present in this run's tool-output haystacks) is observed-real and never
    // reaches the resolver; (B) the INJECTED existence resolvers (the executor's
    // prisma-backed lookups) — absent or throwing → SILENT, never a conviction
    // on missing/unavailable verification. Findings-only notes, NO clean-pass
    // footer (GUARD 6 parity — triage lanes cite dozens of real ids per final).
    {
      const citedTodoIds = extractTodoIdCitations(originalText).map((c) => c.id);
      if (citedTodoIds.length && opts.todoIdsExist) {
        const receiptTodoIds = (opts.receipts ?? [])
          .map((r) => (typeof r.ids?.todoId === 'string' ? String(r.ids.todoId).toLowerCase() : null))
          .filter((x): x is string => !!x);
        const toVerify = citedTodoIds.filter((id) =>
          !receiptTodoIds.some((rid) => rid.startsWith(id))
          && !fdHaystacks.some((h) => h.toLowerCase().includes(id)));
        if (toVerify.length) {
          let existing: Set<string> | null = null;
          try {
            existing = await opts.todoIdsExist(toVerify);
          } catch (err: any) {
            logger.warn(`evidence-guard: todoIdsExist threw (lane stays silent): ${err?.message}`);
            existing = null;
          }
          if (existing) {
            const fabricated = toVerify.filter((id) => !existing.has(id));
            if (fabricated.length) {
              verdict.fabricatedTodoIds = fabricated;
              const note = [
                '[HARNESS EVIDENCE GUARD — FABRICATED TODO IDS]',
                `The final answer cites project-board todo id(s) that do not exist: ${fabricated.join(', ')}.`,
                'A todo id is only meaningful when the board has that row — an invented id is a fabricated claim (ticket 938dac2e: the tt-rd firing-445 lane cited todo 1c0db1a5 — "Todo not found" on a fresh pull).',
              ].join('\n');
              finalText += `\n\n${note}`;
              notes.push(note);
            }
          }
        }
      }
      const citedOqIds = extractOwnerQuestionCitations(originalText).map((c) => c.id);
      if (citedOqIds.length && opts.ownerQuestionIdsExist) {
        const toVerify = citedOqIds.filter((id) =>
          !fdHaystacks.some((h) => h.toLowerCase().includes(id)));
        if (toVerify.length) {
          let existing: Set<string> | null = null;
          try {
            existing = await opts.ownerQuestionIdsExist(toVerify);
          } catch (err: any) {
            logger.warn(`evidence-guard: ownerQuestionIdsExist threw (lane stays silent): ${err?.message}`);
            existing = null;
          }
          if (existing) {
            const fabricated = toVerify.filter((id) => !existing.has(id));
            if (fabricated.length) {
              verdict.fabricatedOwnerQuestionIds = fabricated;
              const note = [
                '[HARNESS EVIDENCE GUARD — FABRICATED OWNER-QUESTION IDS]',
                `The final answer cites owner-question id(s) (oq_…) that match no owner_questions row: ${fabricated.join(', ')}.`,
                'An oq_ id is only meaningful when the owner inbox has that row — an invented id is a fabricated claim (ticket 938dac2e: the tt-rd firing-445 lane cited oq_8c8b15d4 — no such row).',
              ].join('\n');
              finalText += `\n\n${note}`;
              notes.push(note);
            }
          }
        }
      }
    }

    // GUARD 8 — SCHEDULE-CITATION existence check (all triggers; ticket
    // cae70bfa, 2026-09-16: chat b92ef13f's 05:30Z DMG-watch final reported
    // "creating successor d3b3ba07-4585-49c2-bef1-b5b80193224b … verified via
    // schedule_get" — the run's receipts prove schedule_self NEVER executed
    // and no coding_schedules row ever held the id; the fabricated claim
    // sailed through with zero guard telemetry and the 30-min watch chain
    // silently died). Same two-lane discipline: (A) an id this run's OWN
    // evidence carries (a schedule_self/schedule_message/update_schedule
    // receipt's ids.scheduleId prefix-match; the id present in this run's
    // tool-output haystacks — a schedule_get/list_schedules output naming it)
    // is observed-real and never reaches the resolver; (B) the INJECTED
    // existence resolver — absent or throwing → SILENT, never a conviction on
    // missing/unavailable verification. Findings-only note, NO clean-pass
    // footer (GUARD 6/7 parity — watch lanes cite real chain ids per final).
    {
      const citedScheduleIds = extractScheduleIdCitations(originalText).map((c) => c.id);
      if (citedScheduleIds.length && opts.scheduleIdsExist) {
        const receiptScheduleIds = (opts.receipts ?? [])
          .map((r) => (typeof r.ids?.scheduleId === 'string' ? String(r.ids.scheduleId).toLowerCase() : null))
          .filter((x): x is string => !!x);
        const toVerify = citedScheduleIds.filter((id) =>
          !receiptScheduleIds.some((rid) => rid.startsWith(id))
          && !fdHaystacks.some((h) => h.toLowerCase().includes(id)));
        if (toVerify.length) {
          let existing: Set<string> | null = null;
          try {
            existing = await opts.scheduleIdsExist(toVerify);
          } catch (err: any) {
            logger.warn(`evidence-guard: scheduleIdsExist threw (lane stays silent): ${err?.message}`);
            existing = null;
          }
          if (existing) {
            const fabricated = toVerify.filter((id) => !existing.has(id));
            if (fabricated.length) {
              verdict.fabricatedScheduleIds = fabricated;
              const note = [
                '[HARNESS EVIDENCE GUARD — FABRICATED SCHEDULE IDS]',
                `The final answer cites schedule id(s) with no coding_schedules row: ${fabricated.join(', ')}.`,
                'A schedule id is only meaningful when the store has that row — an invented id is a fabricated claim (ticket cae70bfa: chat b92ef13f reported successor schedule d3b3ba07 created+verified — schedule_self never ran and the row never existed).',
              ].join('\n');
              finalText += `\n\n${note}`;
              notes.push(note);
            }
          }
        }
      }
    }

    const claims = extractCompletionClaims(finalText);
    if (!claims.length) return { finalText, notes, verdict };
    // GUARD 1 outcome split (finding A1 review fix): the kinds convicted at
    // GUARD 1 as before, and the commit_local claims held back until the
    // GUARD 2b origin re-query has spoken (present → confirmed, not unproven).
    const unprovenNow: CompletionClaim[] = [];
    const deferredLocalClaims: CompletionClaim[] = [];
    // audit 2026-10-06 T7-6 (stanne.md #8): pr_merged / pr_closed claims
    // naming a PR number are DEFERRED past the GUARD 2 re-check like
    // commit_local — a relayed merge the PR API confirms is a verified FACT and
    // is never "UNVERIFIED … do NOT treat as fact" in the same final that
    // prints "VERIFIED MERGED". Unconfirmed (refuted, unavailable, past the
    // cap) still convict, rendered after the footer. NOT deferred, on purpose:
    // pr_created (claiming to have OPENED a real PR someone else opened is the
    // 630fadc0 / be8b6939 authorship class — existence does not prove it) and
    // commit_pushed (a real sha restated as this-run work, ticket 9a9911bb).
    // Kill switch GUARD_DEFER_PR_PUSH_DISABLED=1.
    const deferExternal = !guardDeferPrPushDisabled();
    const deferredExternalClaims: CompletionClaim[] = [];
    // T7-6: the run's evidence-bearing call count for the note sentence (this
    // attempt's dispatched calls, or the receipts union when larger — a resume).
    const evidenceCalls = Math.max(
      (opts.parts ?? []).filter((p) => p?.type === 'tool_call' && isEvidenceToolName(p.name)).length,
      (opts.receipts ?? []).length,
    );

    // GUARD 1 — machine-triggered runs only: a user-watched turn fabricating
    // completions is a different bug class (the user saw the transcript).
    if (opts.triggerKind !== 'user') {
      // Receipts provided → the conviction basis is claim→receipt resolution
      // (the harness's own execution record — an ok:false push proves NOTHING).
      // A claim whose line cites a KNOWN receipt id is explicitly evidenced —
      // CONTENT-BOUND (P4 v1#24): the cited receipt must itself prove the
      // claim's key tokens (PR number / sha in the receipt's ids) or, for
      // token-less kinds, belong to the claim's evidence tool class. One real
      // citation on a line no longer clears an unrelated claim sharing it.
      // Absent → the legacy parts-text path, unchanged.
      // Ticket 2ab33824 (review B1): the executor ALWAYS passes a receipts
      // array (possibly empty), and the probe/benchmark evidence tools leave
      // NO receipts (computer_task/browser_task/local + web reads are not in
      // RECEIPT_TOOLS) — so a computer_task-ONLY probe run convicted
      // zero-evidence on this lane no matter what it observed (run 099f7d41).
      // For the two OBSERVATION kinds only, a receipts-lane miss falls back
      // to the parts tier; consequential kinds keep receipts-only semantics.
      const lowerFdHaystacks = fdHaystacks.map((h) => h.toLowerCase());
      const citedOkOnLine = (c: CompletionClaim): ToolReceipt[] => {
        const line = c.text.toLowerCase();
        return citedOkReceipts.filter((r) => line.includes(r.id.toLowerCase()));
      };
      const citationExonerates = (c: CompletionClaim): boolean => citedReceiptProvesClaim(c, citedOkOnLine(c), lowerFdHaystacks);
      const unprovenRaw = opts.receipts
        ? claims.filter((c) => {
            if (receiptMatchesClaim(c, opts.receipts!) || citationExonerates(c)) return false;
            // Ticket 2ab33824 (review B1): observation-kind evidence tools
            // leave NO receipts, so a receipts-lane miss says nothing about
            // probe/benchmark claims — fall back to the parts tier for THESE
            // kinds only (claimHasEvidence, now incl. COMPUTER_USE_TOOLS).
            // Consequential kinds (pr_*/deploy/commit_pushed) NEVER fall
            // back: a staged or failed action proves nothing, and no parts
            // entry may launder it.
            if (c.kind === 'probe' || c.kind === 'benchmark') {
              return !claimHasEvidence(c, opts.parts);
            }
            // F32 (2026-10-22): the deploy-OBSERVATION shape (DEPLOY_ALT, no
            // deploy verb) may rest on get_fleet_telemetry — a receipt that
            // SOME callers never see (the reject-back seam passes parts-only),
            // so a receipts-lane miss falls back to the parts tier for exactly
            // that shape. A deploy-verb line NEVER falls back (a staged or
            // failed action proves nothing, and no parts entry may launder
            // it), and neither does any pr_* kind (review F1).
            // Kill switch: EVIDENCE_GUARD_DEPLOY_OBSERVATION_DISABLED=1.
            if (c.kind === 'deploy' && !deployObservationTierDisabled() && isDeployObservationClaimText(c.text)) {
              return !claimHasEvidence(c, opts.parts);
            }
            return true;
          })
        : findUnprovenClaims(finalText, opts.parts);
      // Ticket 93006fd8: a claim line carrying a GROUNDED relay citation (a msg
      // id observed in this run's own tool outputs — computed beside the
      // haystack above) relays ANOTHER lane's freshly-pulled state; it is
      // anchored, not zero-evidence. Line-scoped, same discipline as the
      // receipt-citation exoneration — and CONTENT-BOUND since P4 v1#24: an
      // id-bearing claim's own token (PR number / sha) must also appear in the
      // observed tool output (relayBindsClaimContent), so one anchored msg id
      // cannot launder an unrelated number/sha sharing its line.
      // Finding A1: a commit_local claim gets NO relay exemption — relaying a
      // lane's "banked <sha>" from its message is exactly the spark case (the
      // sha was 422 on origin); the relayed sha must cite a git_push receipt
      // or a this-run GitHub read (the coarse tier), else it stays unproven.
      // Finding A1 review fix: a sha the run READ as an ok git_push receipt of
      // the lane (get_run_receipts) is receipt-proven — the doctrine's "cite a
      // git_push receipt" is satisfiable cross-chat.
      const unprovenRelayed = unprovenRaw.filter((c) => !observedPushShaProves(c)).filter((c) => !(
        c.kind !== 'commit_local'
        && observedRelayIds.some((id) => c.text.toLowerCase().includes(id))
        && relayBindsClaimContent(c, lowerFdHaystacks)
      ));
      // CARRIED-EVIDENCE tier (tt-rd audit 2026-09-27, finding 4): a claim
      // naming a STABLE artifact that an EARLIER run of this chat receipted,
      // and not phrased as fresh, is CARRIED — not UNVERIFIED. Observation
      // kinds (probe / benchmark / deploy) never carry: they bind to no
      // artifact, so a prior receipt cannot prove THIS firing's observation.
      const carried: NonNullable<GuardVerdict['carriedClaims']> = [];
      const unproven = (opts.carriedReceipts && opts.carriedReceipts.length)
        ? unprovenRelayed.filter((c) => {
            const hit = carriedReceiptFor(c, opts.carriedReceipts!);
            if (!hit) return true;
            carried.push({ kind: c.kind, text: c.text, runId: hit.runId, at: hit.createdAt instanceof Date ? hit.createdAt.toISOString() : String(hit.createdAt) });
            return false;
          })
        : unprovenRelayed;
      if (carried.length) {
        verdict.carriedClaims = carried;
        const note = renderCarriedEvidenceNote(carried);
        finalText += `\n\n${note}`;
        notes.push(note);
      }
      // Finding A1 review fix: commit_local convictions are DEFERRED past
      // GUARD 2b — a "banked <sha>" whose sha the origin re-query finds
      // PRESENT is confirmed, not unproven (GUARD 1 used to strike it first
      // and the same final then carried both "✅ EXISTS on origin" and "treat
      // it as LOCAL ONLY"). The other kinds render here exactly as before.
      for (const c of unproven) {
        if (c.kind === 'commit_local') deferredLocalClaims.push(c);
        else if (deferExternal && isDeferredPrClaimKind(c.kind) && typeof c.prNumber === 'number') deferredExternalClaims.push(c);
        else unprovenNow.push(c);
      }
      if (unprovenNow.length) {
        const note = renderEvidenceGuardNote(unprovenNow, { triggerKind: opts.triggerKind, resumed: opts.resumed ?? false, ...(deferExternal ? { evidenceCalls } : {}) });
        finalText += `\n\n${note}`;
        notes.push(note);
        verdict.unprovenKinds = Array.from(new Set(unprovenNow.map((c) => c.kind)));
        // Ticket f8d68167: keep the claim OBJECTS too — the executor's
        // strip+mark lane elides exactly these claims' lines when unproven
        // claims are the ONLY findings (both resolution paths populate).
        verdict.unprovenClaims = unprovenNow;
        if (deferExternal && evidenceCalls > 0) verdict.evidenceToolCalls = evidenceCalls;
      }
    }

    // GUARD 2 — all triggers: verify every claimed PR against GitHub, with
    // the per-number claimed kinds so the footer renders PER-KIND verdicts.
    const claimKinds = extractPrClaimKinds(finalText);
    // Verify the RISKIEST numbers first (2026-09-08 audit: first-appearance
    // order let five honest PR mentions pad the cap so a sixth fabricated one
    // was never queried): numbers with NO id-matching ok receipt before
    // receipted ones, merge claims before create/close, then appearance order.
    // Anything past the cap is named in the footer as UNVERIFIED.
    const okReceiptPrs = new Set((opts.receipts ?? []).filter((r) => r.ok && r.ids?.prNumber !== undefined && r.ids?.prNumber !== null).map((r) => String(r.ids!.prNumber)));
    const prOrder = Array.from(claimKinds.keys());
    const prRank = (n: number): number => (okReceiptPrs.has(String(n)) ? 2 : 0) + (claimKinds.get(n)?.has('pr_merged') ? 0 : 1);
    const prSorted = [...prOrder].sort((a, b) => prRank(a) - prRank(b) || prOrder.indexOf(a) - prOrder.indexOf(b));
    const prNums = prSorted.slice(0, MAX_VERIFY_PRS);
    const prDropped = prSorted.slice(MAX_VERIFY_PRS);
    // T7-6: GitHub's verdict per PR number — the deferred pr_* convictions reconcile against it.
    const prStates = new Map<number, PrVerification['state']>();
    if (prNums.length) {
      // Repo-resolution precedence for claimed PR numbers:
      //   1. TEXT qualifiers (ticket 630fadc0): an explicit owner/repo named
      //      adjacent to the number (URL / owner/repo#n / "owner/repo PR #n"),
      //      plus known repo ALIASES ("glm53 PR #16" — rollout watch
      //      2026-09-14) resolved via opts.repoAliases — the claim is judged
      //      against the repo it explicitly named.
      //   2. EVIDENCE bindings (ticket 6e157e86): numbers the text left
      //      UNQUALIFIED but this run's observed tool outputs read from a
      //      specific repo (GitHub PR payloads self-describe via
      //      repos/<o>/<r>/pulls/<n> + <o>/<r>/pull/<n> URLs) verify against
      //      the OBSERVED repo. This is the lane the verbatim 98723a76
      //      incident phrasing needed: "…glm53 main: PR #16 merged" and
      //      "PR #2 merged=True …" carry no adjacent alias, so neither the
      //      alias map nor the hint lane fires — the observed payload URL is
      //      the only repo anchor. The anchor fills only numbers the text
      //      itself did not qualify (text wins on conflict).
      //   3. Unresolved sibling-name HINT (rollout watch 2026-09-14) →
      //      UNVERIFIED, never a session-repo lookup.
      //   4. Neither anchor nor hint → the legacy session-repo lane, so an
      //      unobserved phantom still convicts there.
      const prRepoOverrides = extractPrRepoQualifiers(finalText, opts.repoAliases);
      for (const [boundNum, boundSlug] of extractPrRepoEvidenceBindings(fdHaystacks)) {
        if (!prRepoOverrides.has(boundNum)) prRepoOverrides.set(boundNum, boundSlug);
      }
      const vs = await verifyPrClaims({
        prNumbers: prNums,
        claimKinds,
        userId: opts.userId,
        repoUrl: opts.repoUrl,
        githubLabel: opts.githubLabel,
        provider: opts.provider,
        repoOverrides: prRepoOverrides,
        repoHints: extractPrRepoHints(finalText, parseRepoSlug(opts.repoUrl)?.repo ?? null, opts.repoAliases),
      });
      const footer = renderVerificationFooter(vs, opts.now ?? new Date())
        + (prDropped.length ? `\n• ${prDropped.map((n) => `#${n}`).join(', ')} — ⚠︎ NOT verified (per-answer cap of ${MAX_VERIFY_PRS} GitHub lookups reached) — treat as unverified` : '');
      finalText += `\n\n${footer}`;
      notes.push(footer);
      for (const v of vs) prStates.set(v.number, v.state);
      verdict.fabricatedPrs = vs.filter((v) => v.state === 'missing').map((v) => v.number);
      verdict.refutedMergePrs = vs
        .filter((v) => (v.claimKinds ?? []).includes('pr_merged') && (v.state === 'open' || v.state === 'closed'))
        .map((v) => v.number);
    }

    // GUARD 2b — all triggers (best-effort, same discipline as GUARD 2):
    // commit_pushed shas re-queried against the repo's commits API. The sha set
    // is the distinct union of CLAIM shas and — when receipts are provided —
    // receipt-carried shas (git_commit/git_push ids.sha): the claim side gets
    // exonerated/convicted; the receipt side gets its harness record CONFIRMED
    // on origin (a receipt-cited 404 is amended history, never a conviction).
    // 'unavailable' renders NOTHING and touches NO verdict field — the lane is
    // silent on token/network failure.
    {
      const bySha = new Map<string, PushVerification['source']>();
      const lowerHaystacks2b = fdHaystacks.map((h) => h.toLowerCase());
      for (const c of claims) {
        // Ticket 93006fd8: a relay-anchored push claim names ANOTHER lane's
        // repo state (or a cited msg id misread as a sha) — THIS repo's
        // commits API cannot adjudicate it and a 404 there is a FALSE
        // fabrication. The uncited first-person push still faces the re-query.
        // CONTENT-BOUND (P4 v1#24): the skip requires the SHA ITSELF to appear
        // in this run's observed tool output — an anchored msg id no longer
        // pulls an invented sha sharing its line out of the commits-API check.
        const relaySkip = observedRelayIds.some((id) => c.text.toLowerCase().includes(id))
          && relayBindsClaimContent(c, lowerHaystacks2b);
        // Finding A1 review fix: a sha proven by the LANE's ok git_push
        // receipt (read via get_run_receipts this run) names ANOTHER chat's
        // repo state — like a relay, THIS repo's commits API cannot adjudicate
        // it (a supervisor chat has no repo, or a different one).
        if (observedPushShaProves(c)) continue;
        if (c.kind === 'commit_pushed' && c.sha && !bySha.has(c.sha) && !relaySkip) bySha.set(c.sha, 'claim');
        // Finding A1: commit_local shas ALWAYS face the origin re-query (no
        // relay skip — the relayed "banked" is the case) as source 'local':
        // 404 → localOnlyShas (observe-only), present → confirmed.
        if (c.kind === 'commit_local' && c.sha && !bySha.has(c.sha)) bySha.set(c.sha, 'local');
      }
      // Receipt-sourced shas: git_push only (finding A1) — a git_commit
      // receipt is LOCAL and the harness never "confirms it on origin"; under
      // the kill switch git_commit shas ride as 'receipt' exactly as before.
      for (const r of opts.receipts ?? []) {
        const sha = typeof r.ids?.sha === 'string' ? r.ids.sha : null;
        if (sha && r.tool === 'git_push' && !bySha.has(sha)) bySha.set(sha, 'receipt');
      }
      // Present-on-origin shas the deferred commit_local claims reconcile
      // against (empty when the lane was silent / unavailable).
      const presentShas = new Set<string>();
      if (bySha.size) {
        // Finding A1 review fix: verify the RISKIEST shas first — the
        // MAX_VERIFY_SHAS cap sliced in text order, so five "banked" shas
        // ahead of one "pushed <sha>" pushed the fabrication-class claim past
        // the cap and it was never queried (the exact 2026-09-08 PR-lane
        // evasion, on shas). 'claim' (a push claim: 404 = fabricated) →
        // 'receipt' (harness confirmation) → 'local' (observe-only), stable
        // within a rank so text order still breaks ties.
        const sourceRank: Record<PushVerification['source'], number> = { claim: 0, receipt: 1, local: 2 };
        const shaEntries = [...bySha.entries()]
          .map(([sha, source], i) => ({ sha, source, i }))
          .sort((a, b) => sourceRank[a.source] - sourceRank[b.source] || a.i - b.i)
          .map(({ sha, source }) => ({ sha, source }));
        const vs = await verifyPushClaims({
          shas: shaEntries,
          userId: opts.userId,
          repoUrl: opts.repoUrl,
          githubLabel: opts.githubLabel,
          provider: opts.provider,
        });
        const checked = vs.filter((v) => v.state !== 'unavailable');
        if (checked.length) {
          const footer = renderPushVerificationFooter(checked);
          finalText += `\n\n${footer}`;
          notes.push(footer);
          const fabricated = checked.filter((v) => v.state === 'missing' && v.source === 'claim').map((v) => v.sha);
          if (fabricated.length) verdict.fabricatedShas = fabricated;
          const localOnly = checked.filter((v) => v.state === 'missing' && v.source === 'local').map((v) => v.sha);
          if (localOnly.length) verdict.localOnlyShas = localOnly;
          for (const v of checked) if (v.state === 'present') presentShas.add(v.sha.toLowerCase());
        }
      }
      // GUARD 1 (deferred) — the commit_local claims held back above: a sha
      // origin found PRESENT is confirmed (the footer already says so) and is
      // dropped; the rest (404, or the lane silent) convict now, rendered
      // AFTER the origin footer so the final never contradicts itself.
      // T7-6: the deferred pr_merged / pr_closed claims reconcile here too —
      // a PR the API reports in the claimed state is confirmed; everything
      // else convicts in the SAME note as the commit_local survivors.
      const prConfirmed = (c: CompletionClaim): boolean => {
        const st = typeof c.prNumber === 'number' ? prStates.get(c.prNumber) : undefined;
        if (c.kind === 'pr_merged') return st === 'merged';
        if (c.kind === 'pr_closed') return st === 'closed' || st === 'merged';
        return false;
      };
      const externalSurvivors = deferredExternalClaims.filter((c) => !prConfirmed(c));
      if (deferredLocalClaims.length || externalSurvivors.length) {
        const survivors = [
          ...externalSurvivors,
          ...deferredLocalClaims.filter((c) => !c.sha || ![...presentShas].some((s) => exonShaMatches(c.sha!, s))),
        ];
        if (survivors.length) {
          const note = renderEvidenceGuardNote(survivors, { triggerKind: opts.triggerKind, resumed: opts.resumed ?? false, ...(deferExternal ? { evidenceCalls } : {}) });
          finalText += `\n\n${note}`;
          notes.push(note);
          // Appearance order across the GUARD-1 and deferred pr_* convictions
          // (exactly what GUARD 1 alone produced), commit_local last as before.
          const at = (c: CompletionClaim): number => {
            const i = claims.findIndex((x) => x === c || (x.kind === c.kind && x.text === c.text && x.prNumber === c.prNumber && x.sha === c.sha));
            return i < 0 ? Number.MAX_SAFE_INTEGER : i;
          };
          const priorClaims = verdict.unprovenClaims ?? [];
          const mergedClaims = [...priorClaims, ...externalSurvivors].sort((a, b) => at(a) - at(b));
          const localSurvivors = survivors.filter((c) => c.kind === 'commit_local');
          const kinds = Array.from(new Set(mergedClaims.map((c) => c.kind)));
          if (localSurvivors.length && !kinds.includes('commit_local')) kinds.push('commit_local');
          verdict.unprovenKinds = kinds;
          verdict.unprovenClaims = [...mergedClaims, ...localSurvivors];
          if (deferExternal && evidenceCalls > 0) verdict.evidenceToolCalls = evidenceCalls;
        }
      }
    }  } catch (err: any) {
    logger.error(`evidence-guard: applyCompletionClaimGuard failed mid-evaluation — verdict is PARTIAL (non-fatal): ${err?.message}`);
    verdict.guardError = String(err?.message || err || 'unknown error').slice(0, 300);
  }
  return { finalText, notes, verdict };
}

// ── Layer 7: typed CLAIMS block — claims-with-receipts (audit #6 phase 1) ────
//
// The contract lives in claims-block.ts: a machine-run final MAY end with a
// fenced ```claims JSON array of typed completion claims, each ref-matched
// against THIS run's harness-written tool receipts. Adoption is incentive-driven:
//   - block ABSENT   → identity: every prose lane runs exactly as today.
//   - block VERIFIED → positive verdict (claimsBlockVerified) + prose-mining
//     GUARD-1 convictions are DOWNGRADED for the claim classes the verified
//     entries cover (a receipt-proven push means prose mentioning that push
//     is fine). Downgrades are id-narrow: a verified push of sha A never
//     covers a prose push claim of sha B.
//   - block with UNVERIFIED entries → conviction (verdict.unverifiedBlockClaims
//     joins verdictHasFindings), flowing into the exact same failure handling
//     the existing lanes use (reject-back when wired, else the executor's
//     annotate/journal/integrity-ticket path).
//   - block MALFORMED → advisory note only; prose lanes stay authoritative.
//
// STATUS: WIRED (remediation P0 item B29 — this header previously still read
// "UNWIRED / WIRE-ME" from phase 1). applyClaimsBlockLane runs at all three
// seams today:
//   - run-executor.ts finalize seam: `const composed = applyClaimsBlockLane({…})`
//     right after applyCompletionClaimGuard — every downstream read
//     (guardFindings/hardFindings, redact/replace lanes, journal row,
//     integrity ticket, annotate fallback) reads `composed`;
//   - agent.ts in-loop reject-back: `applyClaimsBlock: true` through
//     evidenceGuardRejectBack → evaluateFinalCandidateForRejectBack (the
//     dc04deea parity doctrine — pre-submission convicts/exonerates exactly
//     like the finalize seam);
//   - chat-agent.service.ts SUPERVISOR chat runs (owner 2026-09-03): the same
//     typed-claims contract over the final note, verified against
//     result.receipts before anything persists.
// When no claims block is present it returns the guarded fields
// REFERENCE-EQUAL (zero behavior change), so the wiring is identity for
// block-less runs.
//
// Phase 2 (out of scope here) would flip the default: prose becomes advisory
// for runs that emit a block, and the mined idiom classes retire one by one
// as their typed equivalents prove out.

/**
 * Prose ClaimKind classes a VERIFIED block entry of each type vouches for
 * (the GUARD-1 downgrade map). Deliberately narrow: probe/benchmark have no
 * typed equivalent yet (phase 2), and ticket/message/dispatch/file/verify
 * entries cover no prose-mined class — their value in phase 1 is the positive
 * typed record, not prose relief. `pr` covers all three pr_* kinds, mirroring
 * receiptMatchesClaim's number-match semantics (GUARD 2's GitHub re-query
 * remains the merge-truth check regardless of any downgrade).
 */
const BLOCK_TYPE_COVERED_KINDS: Record<ClaimsBlockType, readonly ClaimKind[]> = {
  push: ['commit_pushed', 'commit_local'],
  pr: ['pr_created', 'pr_merged', 'pr_closed'],
  // 'merge' (tt-rd audit 2026-09-27): a VERIFIED merge entry (vouched by a
  // this-run merge_pull_request receipt) covers the prose pr_merged class —
  // number-narrowed below like `pr`; GUARD 2's GitHub re-query still rules.
  merge: ['pr_merged'],
  deploy: ['deploy'],
  ticket_update: [],
  message_sent: [],
  dispatch: [],
  file_change: [],
  verify: [],
  // Ticket 6d7b379f — the finish_run vocabulary. A VERIFIED commit entry
  // (git_commit/git_push receipt naming the sha) covers the prose
  // commit_local class, sha-narrowed by verifiedBlockClaimCoversProse's
  // isOriginShaKind branch — the same way a verified push entry does. It
  // deliberately does NOT cover commit_pushed: a git_commit receipt proves a
  // LOCAL commit (finding A1's receipt split), so a "pushed <sha>" prose
  // line is never downgraded by a commit entry.
  commit: ['commit_local'],
  // CT-5 (todo 76fd0cce): a VERIFIED probe/benchmark entry — vouched by the
  // run_command receipt that produced it — covers its OWN prose class. This is
  // the downgrade CT-5 existed to enable: before it, a lane's honest "probe says
  // the box is on sha 7d38730f" had no typed record to back it and stayed in the
  // tier-2 advisory lane. Id-narrowing rides the shared helper below (a verified
  // probe of sha A never launders a fabricated prose probe of sha B).
  probe: ['probe'],
  benchmark: ['benchmark'],
  schedule_armed: [],
  email_sent: [],
  state_update: [],
};

/**
 * Does a VERIFIED block entry cover this prose-mined claim? Class membership
 * first, then id-narrowing: an id-bearing prose claim (PR number, push sha)
 * is covered only when the entry's ref names the SAME id — a verified push of
 * sha A never launders a fabricated prose push of sha B. Id-less kinds
 * (deploy) are covered class-wide, mirroring receiptMatchesClaim's coarse
 * deploy tier.
 */
function verifiedBlockClaimCoversProse(prose: CompletionClaim, entry: ClaimsBlockEntry): boolean {
  if (!BLOCK_TYPE_COVERED_KINDS[entry.type].includes(prose.kind)) return false;
  if (prose.prNumber !== undefined) return refNamesPrNumber(entry.ref, prose.prNumber);
  if (isOriginShaKind(prose.kind) && prose.sha) return refNamesSha(entry.ref, prose.sha);
  return true;
}

/** The lane's pure evaluation result (claimsBlockLane). */
export interface ClaimsBlockLaneResult {
  /** A fenced claims block exists in the final text. */
  present: boolean;
  /** Set when present but unparseable — the block was ignored (advisory note only). */
  malformedReason?: string;
  verified: VerifiedBlockClaim[];
  unverified: ClaimsBlockEntry[];
  /** The receipt-INVISIBLE tier (P4 v1#23) — advisory, never a conviction, never a verification. */
  unverifiable: ClaimsBlockEntry[];
  /** Prose ClaimKind classes the VERIFIED entries cover (the downgrade vocabulary). */
  coveredKinds: ClaimKind[];
}

/**
 * Parse + verify the final text's typed claims block against this run's
 * receipts. Pure, deterministic, never throws, no network — receipt lookup
 * is the whole point. Absent block → { present: false } and nothing else.
 */
export function claimsBlockLane(finalText: string, receipts: ToolReceipt[], carriedReceipts?: ToolReceipt[]): ClaimsBlockLaneResult {
  const parsed = parseClaimsBlock(finalText);
  if (!parsed.present) return { present: false, verified: [], unverified: [], unverifiable: [], coveredKinds: [] };
  if (!parsed.claims) {
    return { present: true, malformedReason: parsed.malformedReason ?? 'unparseable', verified: [], unverified: [], unverifiable: [], coveredKinds: [] };
  }
  const { verified, unverified, unverifiable } = verifyClaimsBlock(parsed.claims, receipts, carriedReceipts);
  const covered = new Set<ClaimKind>();
  if (!unverified.length) {
    // Coverage (and the downgrade it drives) is earned only by a block with
    // ZERO unverified entries — a partially-fabricated block vouches for
    // nothing. Unverifiable entries (P4 v1#23) don't kill the verified
    // entries' coverage, but earn none of their own and block the positive
    // claimsBlockVerified verdict (applyClaimsBlockLane).
    for (const v of verified) for (const k of BLOCK_TYPE_COVERED_KINDS[v.claim.type]) covered.add(k);
  }
  return { present: true, verified, unverified, unverifiable, coveredKinds: [...covered] };
}

/** Cap on entries rendered into any lane note (the verdict keeps them all). */
const MAX_BLOCK_NOTE_ENTRIES = 8;

const renderBlockEntry = (e: ClaimsBlockEntry): string => `${e.type} ${e.ref.length > 80 ? `${e.ref.slice(0, 80)}…` : e.ref}`;

/** The lane's POSITIVE note — harness-only chrome (FORGED_MARKER_RES). */
function renderClaimsBlockVerifiedNote(verified: VerifiedBlockClaim[], coveredKinds: ClaimKind[]): string {
  // ed728b87: a cross-run vouch (via:'session'/'relayed') is labeled as such —
  // the receipt id is real but minted by an earlier run of this chat.
  const viaSuffix = (v: VerifiedBlockClaim): string => v.via === 'session' || v.via === 'relayed' || v.via === 'origin' ? ` (${v.via})` : '';
  const shown = verified.slice(0, MAX_BLOCK_NOTE_ENTRIES)
    .map((v) => `${renderBlockEntry(v.claim)} → receipt ${v.receiptId.slice(0, 8)}${viaSuffix(v)}`);
  const more = verified.length > shown.length ? `, +${verified.length - shown.length} more` : '';
  return [
    '[HARNESS EVIDENCE GUARD — CLAIMS BLOCK VERIFIED]',
    `The typed claims block was checked against this run's tool receipts: ${verified.length}/${verified.length} claim(s) verified (${shown.join('; ')}${more}).`,
    coveredKinds.length
      ? `Zero-evidence prose convictions (if any) are downgraded for the covered claim class(es): ${coveredKinds.join(', ')}.`
      : 'These entry types cover no prose-mined claim class — the typed record stands on its own.',
  ].join('\n');
}

/** The lane's CONVICTION note — harness-only chrome (FORGED_MARKER_RES). */
function renderClaimsBlockUnverifiedNote(unverified: ClaimsBlockEntry[], verifiedCount: number): string {
  const shown = unverified.slice(0, MAX_BLOCK_NOTE_ENTRIES).map(renderBlockEntry);
  const more = unverified.length > shown.length ? `, +${unverified.length - shown.length} more` : '';
  return [
    '[HARNESS EVIDENCE GUARD — CLAIMS BLOCK UNVERIFIED]',
    `The typed claims block asserts ${unverified.length} claim(s) with NO matching tool receipt in this run: ${shown.join('; ')}${more}.`,
    `A claims-block entry is a completion claim — one without a receipt is treated as FABRICATED until re-verified with real tool calls.${verifiedCount ? ` (${verifiedCount} other entr${verifiedCount === 1 ? 'y' : 'ies'} did match receipts.)` : ''}`,
  ].join('\n');
}

/** The lane's MALFORMED advisory — harness-only chrome (FORGED_MARKER_RES). */
function renderClaimsBlockMalformedNote(reason: string): string {
  return [
    '[HARNESS EVIDENCE GUARD — CLAIMS BLOCK MALFORMED]',
    `The final answer ends with a typed claims block that could not be parsed (${reason}) — it was IGNORED and prose evidence mining applied unchanged.`,
    'Next time emit a JSON array of {"type","ref"} entries inside the claims fence (types: push, pr, merge, deploy, commit, ticket_update, message_sent, dispatch, file_change, verify, schedule_armed, email_sent, state_update, probe, benchmark). Entries may add an optional "scope":"session" (work an earlier run of this chat did) or "scope":"relayed" (a receipt read with get_run_receipts this run) — scoped entries are re-checked against the chat\u2019s receipt history before a miss is struck.',
  ].join('\n');
}

/**
 * THE SINGLE WIRE-IN (audit #6 phase 1): compose the typed claims-block lane
 * over applyCompletionClaimGuard's output. Returns the same { finalText,
 * notes, verdict } shape plus the lane's own result, so callers swap
 * `guarded` for the return value and touch nothing else.
 *
 * Guarantees:
 *   - USER triggers and ABSENT blocks → the guarded fields are returned
 *     REFERENCE-EQUAL (provably zero behavior change).
 *   - Inputs are never mutated: any change lands on fresh objects/arrays.
 *   - MALFORMED → advisory note appended; verdict untouched.
 *   - FULLY VERIFIED → verdict copy with claimsBlockVerified=true; GUARD-1
 *     convictions covered by the verified entries are removed (unprovenKinds/
 *     unprovenClaims recomputed) and the guard-1 note is surgically re-rendered
 *     over the survivors (or removed outright) so the delivered text never
 *     contradicts the verdict.
 *   - UNVERIFIED entries → verdict copy with unverifiedBlockClaims (a finding
 *     under verdictHasFindings) + conviction note; NO downgrade (a partially
 *     fabricated block vouches for nothing).
 * Never throws (mirrors the guard orchestrator's discipline).
 */
export async function applyClaimsBlockLane(opts: {
  /** The model's final answer BEFORE guard annotations (run-executor: result.finalText). */
  originalText: string;
  /** applyCompletionClaimGuard's output for the same final. */
  guarded: { finalText: string; notes: string[]; verdict: GuardVerdict };
  /** The SAME receipt union the guard received (in-process ∪ prior attempts). */
  receipts: ToolReceipt[];
  triggerKind: 'user' | 'schedule' | 'hook' | 'machine';
  resumed?: boolean;
  /**
   * Ticket ed728b87 (2026-10-27): the chat's recent receipt history (the
   * executor's guardCarriedReceipts — ok receipts from this chat's earlier
   * runs ≤ 7 d). A fence entry that DECLARED scope:session / scope:relayed
   * (finish_run's cross-run vocabulary) and matched no this-run receipt
   * re-matches against this pool before the miss tiers apply. Absent/empty ⇒
   * pre-ed728b87 behavior byte for byte. (RSW-1 cl30, 2026-11-02: the release
   * switch expired 2026-11-12 and was deleted — this pool rides the same
   * unconditional carried tier as the prose guard's.)
   */
  carriedReceipts?: ToolReceipt[];
  /** Telemetry sink (run-executor passes recordLoopMetric). Injected so this
   *  pure module never imports the DB-backed metrics service; omitted in unit
   *  tests ⇒ the observation is simply not recorded. */
  recordMetric?: (m: { kind: string; sessionId?: string; runId?: string; meta: Record<string, unknown> }) => void;
  sessionId?: string;
  runId?: string;
  /**
   * ORIGIN-VOUCH leg (Framework Operator firing 4, 2026-09-22 — the FO
   * charter's own publish path was false-convicted): verifyPushClaims,
   * injected by the executor/reject-back seams exactly as the prose GUARD 2b
   * lane gets it. UNRECEIPTED hex-sha push/file_change entries get the SAME
   * origin-truth channel prose already has: PRESENT on origin → verified
   * (via:'origin'); 404 → stays a conviction (the sha does not exist);
   * unavailable → unverifiable (advisory, never a strike). Absent ⇒ the lane
   * stays receipt-only (pre-fix behavior byte for byte). The check runs ONLY
   * over entries that matched no receipt — receipt-verified entries never
   * re-query.
   */
  originCheck?: (shas: Array<{ sha: string; source: 'claim' | 'receipt' }>) => Promise<PushVerification[]>;
}): Promise<{ finalText: string; notes: string[]; verdict: GuardVerdict; lane: ClaimsBlockLaneResult }> {
  const identity = (lane: ClaimsBlockLaneResult) => ({
    finalText: opts.guarded.finalText, notes: opts.guarded.notes, verdict: opts.guarded.verdict, lane,
  });
  try {
    // The contract is a MACHINE-final protocol (the user-watched turn is a
    // different bug class — GUARD 1's own posture).
    if (opts.triggerKind === 'user') return identity({ present: false, verified: [], unverified: [], unverifiable: [], coveredKinds: [] });
    const lane = claimsBlockLane(opts.originalText, opts.receipts, opts.carriedReceipts);
    if (!lane.present) return identity(lane);

    // ── ORIGIN-VOUCH leg (FO firing 4, 2026-09-22) ──────────────────────────
    // The charter's own publish path (`git push origin HEAD:main` through raw
    // shell — FRAMEWORK_OPERATOR.md step 3) leaves ONLY run_command receipts,
    // which carry no sha: the typed lane convicted exactly the lanes that
    // follow the typed contract (live 14:19Z strike: push b2fe7900 /
    // file_change b4b667f9, both real on origin). Give unreceipted HEX-sha
    // push/file_change entries the SAME origin-truth channel prose GUARD 2b
    // already has: present → verified, 404 → stays convicted, unavailable →
    // unverifiable (advisory). Opt-in via the injected check; kill switch
    // restores receipt-only. Receipt-verified entries NEVER re-query.
    if (
      opts.originCheck
      && lane.unverified.some((e) => (e.type === 'push' || e.type === 'file_change') && isHexRef(e.ref))
    ) {
      try {
        const hexEntries = lane.unverified.filter(
          (e) => (e.type === 'push' || e.type === 'file_change') && isHexRef(e.ref),
        );
        // Dedupe by ref — two entries citing the same commit (push + its
        // file_change) are ONE commits-API lookup, mirroring GUARD 2b's
        // bySha map. Cap discipline rides verifyPushClaims' own MAX_VERIFY_SHAS.
        const bySha = new Map<string, ClaimsBlockEntry[]>();
        for (const e of hexEntries) {
          const list = bySha.get(e.ref.trim().toLowerCase()) ?? [];
          list.push(e);
          bySha.set(e.ref.trim().toLowerCase(), list);
        }
        const vs = await opts.originCheck(
          [...bySha.keys()].map((sha) => ({ sha, source: 'claim' as const })),
        );
        let originVouched = 0;
        let originUnverifiable = 0;
        let originConfirmed = 0;
        for (const v of vs) {
          const entries = bySha.get(v.sha.trim().toLowerCase()) ?? [];
          if (v.state === 'present') {
            // Confirmed on origin — same truth channel as prose GUARD 2b's
            // exoneration. Move the entry out of unverified (a verified entry
            // can never remain a conviction) and into verified; receiptId
            // carries the confirmed sha for traceability (via:'origin' says it
            // is not a receipt id).
            for (const e of entries) {
              lane.unverified = lane.unverified.filter((x) => x !== e);
              lane.verified.push({ claim: e, receiptId: v.sha, via: 'origin' });
              originVouched += 1;
            }
            originConfirmed += 1;
          } else if (v.state === 'missing') {
            // The commit does not exist on origin — stays a conviction,
            // exactly as an unreceipted prose push sha would.
          } else {
            // unavailable — the receipt channel cannot adjudicate and neither
            // could the API: advisory, never a strike (GUARD 2b's silence
            // discipline; the P4 v1#23 unverifiable tier).
            for (const e of entries) {
              lane.unverified = lane.unverified.filter((x) => x !== e);
              lane.unverifiable.push(e);
              originUnverifiable += 1;
            }
          }
        }
        if (originVouched || originUnverifiable) {
          // Recompute coverage over the amended verified set — coverage is
          // earned only by a block with zero unverified entries, and origin
          // vouches earn it exactly like receipt matches (the commit IS on
          // origin — the claim is true).
          const covered = new Set<ClaimKind>();
          for (const v of lane.verified) for (const k of BLOCK_TYPE_COVERED_KINDS[v.claim.type]) covered.add(k);
          lane.coveredKinds = [...covered];
        }
        try {
          opts.recordMetric?.({
            kind: 'guard_miss', sessionId: opts.sessionId, runId: opts.runId,
            meta: {
              seam: 'claims_block_origin_vouch', outcome: 'observed',
              confirmed: originConfirmed, vouched: originVouched, unverifiable: originUnverifiable,
            },
          });
        } catch { /* telemetry is best-effort */ }
      } catch (err: any) {
        // The origin leg must never break the lane — a failed re-query leaves
        // the receipt-only verdict standing (pre-fix behavior).
        logger.warn(`evidence-guard: claims-block origin-vouch failed (non-fatal, receipt-only verdict stands): ${err?.message}`);
      }
    }

    let finalText = opts.guarded.finalText;
    const notes = [...opts.guarded.notes];
    const verdict: GuardVerdict = { ...opts.guarded.verdict };

    if (lane.malformedReason) {
      const note = renderClaimsBlockMalformedNote(lane.malformedReason);
      finalText += `\n\n${note}`;
      notes.push(note);
      return { finalText, notes, verdict, lane };
    }
    if (!lane.verified.length && !lane.unverified.length && !lane.unverifiable.length) {
      // An empty (but well-formed) block asserts nothing — neutral.
      return identity(lane);
    }

    if (lane.unverified.length) {
      verdict.unverifiedBlockClaims = lane.unverified.map(renderBlockEntry);
      const note = renderClaimsBlockUnverifiedNote(lane.unverified, lane.verified.length);
      finalText += `\n\n${note}`;
      notes.push(note);
      return { finalText, notes, verdict, lane };
    }

    // Unverifiable entries (P4 v1#23): no conviction and NO positive
    // claimsBlockVerified verdict — but the verified entries' GUARD-1
    // downgrade below still applies (they are receipt-proven regardless).
    // Gate flip 2026-09-11 (owner: full steam): the advisory note is no longer
    // appended to the delivered final — the observation is a guard_miss loop
    // metric (seam claims_block_unverifiable) so precision stays measurable.
    if (lane.unverifiable.length) {
      try {
        opts.recordMetric?.({
          kind: 'guard_miss', sessionId: opts.sessionId, runId: opts.runId,
          meta: { seam: 'claims_block_unverifiable', n: lane.unverifiable.length, outcome: 'observed' },
        });
      } catch { /* telemetry is best-effort */ }
    }

    // Zero unverified entries: positive verdict (only when nothing was
    // unverifiable either) + the GUARD-1 downgrade for the verified entries.
    if (!lane.unverifiable.length) verdict.claimsBlockVerified = true;
    const before = verdict.unprovenClaims ?? [];
    if (before.length) {
      const survivors = before.filter(
        (c) => !lane.verified.some((v) => verifiedBlockClaimCoversProse(c, v.claim)),
      );
      if (survivors.length !== before.length) {
        verdict.unprovenKinds = Array.from(new Set(survivors.map((c) => c.kind)));
        if (survivors.length) verdict.unprovenClaims = survivors;
        else delete verdict.unprovenClaims;
        // Surgical note repair: the guard appended renderEvidenceGuardNote over
        // the FULL claim set — re-render it over the survivors (or drop it) so
        // the delivered text matches the downgraded verdict. Deterministic:
        // the appended note is byte-reproducible from its inputs. A miss
        // (unexpected inputs) fails safe — verdict downgraded, text untouched.
        const noteCtx = { triggerKind: opts.triggerKind, resumed: opts.resumed ?? false, ...(typeof verdict.evidenceToolCalls === 'number' ? { evidenceCalls: verdict.evidenceToolCalls } : {}) };
        const oldNote = renderEvidenceGuardNote(before, noteCtx);
        const noteIdx = notes.indexOf(oldNote);
        if (noteIdx !== -1 && finalText.includes(`\n\n${oldNote}`)) {
          if (survivors.length) {
            const newNote = renderEvidenceGuardNote(survivors, noteCtx);
            notes[noteIdx] = newNote;
            finalText = finalText.replace(`\n\n${oldNote}`, `\n\n${newNote}`);
          } else {
            notes.splice(noteIdx, 1);
            finalText = finalText.replace(`\n\n${oldNote}`, '');
          }
        }
      }
    }
    if (lane.verified.length) {
      const note = renderClaimsBlockVerifiedNote(lane.verified, lane.coveredKinds);
      finalText += `\n\n${note}`;
      notes.push(note);
    }
    return { finalText, notes, verdict, lane };
  } catch (err: any) {
    logger.warn(`evidence-guard: applyClaimsBlockLane failed (non-fatal, guarded output passes through): ${err?.message}`);
    return identity({ present: false, verified: [], unverified: [], unverifiable: [], coveredKinds: [] });
  }
}
