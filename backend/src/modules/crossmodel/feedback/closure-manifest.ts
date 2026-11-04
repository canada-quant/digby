/**
 * Deterministic ticket-closure MANIFEST (2026-08-23, owner-ordered burn-down).
 *
 * WHY THIS EXISTS: applying evidence-verified closures through the lane
 * session (an LLM run calling update_feedback item by item) stalled twice —
 * two coordination briefs sat half-applied for a day while already-fixed
 * tickets kept showing "pending review" to the owner. Closing a ticket whose
 * fix is MERGED is bookkeeping, not judgment: it belongs in reviewable data
 * applied by deterministic code, not in a model's context window.
 *
 * HOW IT WORKS: each entry is (id prefix → done + adminNote). The worker cron
 * (worker.ts 'ticket-closure-manifest') calls applyClosureManifest() every 10
 * minutes; each entry is applied AT MOST ONCE EVER via an atomic context-store
 * claim (storeCreate P2002 = already applied), and the update itself only
 * touches rows still open/in_progress — so a re-opened ticket is NEVER
 * re-closed by an old manifest entry (a human reopening wins forever).
 *
 * ADDING CLOSURES: append entries in a PR — the diff IS the audit trail.
 * NEVER edit or remove old entries (their claims make them inert anyway).
 *
 * EVIDENCE-GATED ENTRIES (backlog audit DOI-27, 2026-09-28): an entry may
 * carry `evidence: { commitSha, prUrl?, deployRunId? }`. Such an entry closes
 * ONLY once fix-state.ts proves the fix LIVE — the commit an ancestor of
 * origin/main AND the deploy run green / a box running it (the same
 * merged ∧ deployed bar the reopen gate uses) — and the adminNote then carries
 * the `[machine-close evidence: …]` block the reopen gate later reads. Until
 * the proof holds the entry stays UNCLAIMED and is retried every sweep (a
 * PR-merged-but-not-yet-deployed fix never closes early); the resolver is
 * fail-safe, so a missing GitHub token / API error also waits rather than
 * closing.
 *
 * DRY RUN: `applyClosureManifest({ dryRun: true })` reports what WOULD close
 * (and why an evidence entry is still pending) without writing a row or a
 * claim — the coordinator's `scripts/framework-audit/apply-closure-manifest.js`
 * probe via prodq.sh.
 */

import prisma from '../../../config/database';
import logger from '../../../utils/logger';
import { storeCreate } from '../memory/context-store';
import { resolveFixStateFromEvidence, type ClosureEvidenceNote } from './fix-state';
import { MANIFEST_CLOSABLE_STATUSES } from './ticket-status';

const MANIFEST_NS = ['ticket-manifest', 'applied'];

export interface ClosureEvidence {
  /** The merge commit on main (7–40 hex) — the deterministic half of the proof. */
  commitSha: string;
  prUrl?: string;
  deployRunId?: string;
  /**
   * The repo the fix lives in ("owner/name") — ticket cf5f9718. Rendered into
   * the audit note (`repo <owner/name>`) so the done-bar resolves the proof
   * against THAT repo. Omit for platform-repo fixes (pre-cf5f9718 behavior).
   */
  repo?: string;
}

export interface ClosureEntry {
  /** 8+ char id prefix of the user_feature_requests row. */
  idPrefix: string;
  /** The evidence note shown to the filer. */
  adminNote: string;
  /** When set, the entry closes only once the fix is proven live (see the header). */
  evidence?: ClosureEvidence;
  /** The ticket this one duplicates (8+ char prefix) — recorded on the row's context. */
  duplicateOf?: string;
}

/** The audit block fix-state.ts parses (closure-evidence.ts's exact shape). */
export function renderMachineCloseEvidence(ev: ClosureEvidence): string {
  const parts = [`commit ${ev.commitSha.toLowerCase()}`];
  if (ev.repo) parts.push(`repo ${ev.repo.toLowerCase()}`);
  if (ev.prUrl) parts.push(`PR ${ev.prUrl}`);
  if (ev.deployRunId) parts.push(`deploy run ${ev.deployRunId}`);
  return `[machine-close evidence: ${parts.join('; ')}]`;
}

export const CLOSURE_MANIFEST: ReadonlyArray<ClosureEntry> = [
  { idPrefix: 'd808e5aa', adminNote: 'Fixed in PR #305 (burn-down wave 2, 2026-08-22): message timestamps — desktop hover + iOS-style swipe reveal on mobile.' },
  { idPrefix: '30833c01', adminNote: 'Fixed in PR #305 (burn-down wave 2, 2026-08-22): browser tab titles follow the active chat.' },
  { idPrefix: '38f5403f', adminNote: 'Fixed in PR #305 (burn-down wave 2, 2026-08-22) + PR #312 correction: Digby hat loader — float only (the gif\'s propeller provides the spin; the hat itself never rotates). Loader prefers /digbyhat.gif when the asset lands.' },
  { idPrefix: 'a0277c29', adminNote: 'Fixed in PR #305 (burn-down wave 2, 2026-08-22): ensemble More-info cards carry mode-aware role sublabels.' },
  { idPrefix: 'adfbe4bf', adminNote: 'Fixed in PR #305 (burn-down wave 2, 2026-08-22): deep-link breadcrumb syncs project context (null clears).' },
  { idPrefix: 'f9ab1be1', adminNote: 'Fixed in PR #305 (burn-down wave 2, 2026-08-22): Management max-w-7xl / account max-w-5xl.' },
  { idPrefix: '182dc4d0', adminNote: 'Fixed in PR #305 (burn-down wave 2, 2026-08-22): expanded thinking renders raw whitespace-pre-wrap.' },
  { idPrefix: '41631647', adminNote: 'Fixed in PR #305 (burn-down wave 2, 2026-08-22): web-pipe raw-text direct-fetch fallback for github raw/api + text extensions.' },
  { idPrefix: 'bf4e0629', adminNote: 'Fixed in PR #305 (burn-down wave 2, 2026-08-22): PDF text extraction at the callMcpTool chokepoint (never binary).' },
  { idPrefix: '7f236c00', adminNote: 'Fixed in PR #305 (burn-down wave 2, 2026-08-22): JS-shell heuristic + honest \'JS-rendered — unavailable\' + one SSR-rescue fetch.' },
  { idPrefix: 'dbe1d975', adminNote: 'Fixed in PR #305 (burn-down wave 2, 2026-08-22): youtube-pipe BrightData web_data_youtube_videos dataset fallback.' },
  { idPrefix: 'debbef04', adminNote: 'Fixed in PR #305 (burn-down wave 2, 2026-08-22): explorer/architect gained WEB_READ (scrape_as_markdown + web_pipe).' },
  { idPrefix: 'be199e93', adminNote: 'Fixed in PR #305 (burn-down wave 2, 2026-08-22): evidence guard REPLACES confabulated machine finals (honest notice on top, original quoted in UNVERIFIED audit section; hook summary carries the verdict).' },
  { idPrefix: 'b8fa321a', adminNote: 'Fixed in PR #305 (burn-down wave 2, 2026-08-22): commit_pushed ClaimKind — unproven commit/push claims flagged with windowed negation.' },
  { idPrefix: 'ae085617', adminNote: 'Fixed in PR #305 (burn-down wave 2, 2026-08-22): action verifier generalized to ALL chats incl. ticket-filing claims (verifyRunActionClaimsAsync).' },
  { idPrefix: 'c1cbe6a2', adminNote: 'Fixed in PR #490 (2026-08-29): action-verifier evidence-citation lane — fabricated msg-row receipt citations inside observation/verification prose are now convicted via a deterministic msg-row existence check (both guard lanes; 5 adversarial review rounds).' },
  { idPrefix: '167822fb', adminNote: 'Fixed in PR #305 (burn-down wave 2, 2026-08-22): fuzzy same-session feedback dedup (Jaccard>=0.6, 24h window).' },
  { idPrefix: 'eb7a3919', adminNote: 'Fixed in PR #305 (burn-down wave 2, 2026-08-22): 8000-char supervisor message limit named in the error + live counter + pre-send gate.' },
  { idPrefix: '63698528', adminNote: 'Fixed in PR #305 (burn-down wave 2, 2026-08-22): dual-timezone timestamp rule (local + Z) in both datetime contexts.' },
  { idPrefix: '54e0a7ea', adminNote: 'Fixed in PR #305 (burn-down wave 2, 2026-08-22): get_platform_network_info read tool (egress IP, hostname; honest \'unavailable\').' },
  { idPrefix: 'c4135a9f', adminNote: 'Fixed in PR #305 (burn-down wave 2, 2026-08-22): hook_update tool + updateHook() service with subscribe-grade validation.' },
  { idPrefix: '6c037cc6', adminNote: 'Fixed in PR #305 (burn-down wave 2, 2026-08-22): news topics inferred via LLM over memory+interests (6h cache, raw-title fallback).' },
  { idPrefix: 'e8cb14ba', adminNote: 'Fixed in PR #305 (burn-down wave 2, 2026-08-22): Code-chip destination picker + \'created in <project>\' toast.' },
  { idPrefix: 'f789d84e', adminNote: 'Fixed in PR #305 (burn-down wave 2, 2026-08-22): expired-confirm traces — watchdog \'Expired unresolved\' section + 30-min sidebar trace rows.' },
  { idPrefix: '205c6a42', adminNote: 'Fixed in PR #305 (burn-down wave 2, 2026-08-22): pairing-code expiry card + retry (no infinite spinner).' },
  { idPrefix: 'ba733210', adminNote: 'Fixed in PR #305 (burn-down wave 2, 2026-08-22): per-chat Autonomy dialog + mode-picker copy (superseded for coding by PR #306: auto = full autonomy).' },
  { idPrefix: '66061261', adminNote: 'Fixed in PR #304 (2026-08-22): unattended runs ending with open plan steps append an honest harness note + self-schedule up to 3 bounded continuation runs.' },
  { idPrefix: '17e26dbc', adminNote: 'Fixed by PR #301: attention watchdog posts consolidated deduped attention/blocked notices to the Fleet Supervisor thread; sidebar rows carry pending-attention badges.' },
  { idPrefix: '623d46c4', adminNote: 'Fixed by the stream-recovery chain (PR #244 poll-adopt, #253 cross-instance re-attach, #292 empty-retry + honest error card).' },
  { idPrefix: '7a6f8214', adminNote: 'Fixed on main — finishRecoveredStream cites this ticket; recovered answers no longer show the false toast.' },
  { idPrefix: '3bc07841', adminNote: 'Fixed by PR #193: kimi k2.6→k3 model + label sync.' },
  { idPrefix: 'ef98b00b', adminNote: 'Stale ops alert — the burn-down resumed (#282–#312) and the queue now drains continuously (batch dispatch + periodic drain).' },
  { idPrefix: '675c3eb9', adminNote: 'Duplicate of the a8976e11 fabrication cluster (signal ticket 8e814f45). Platform guards shipped: #288 annotate+GitHub verify, #299 verifier, #303 journal-backed verdicts, #305 replaced finals, #307 future-dated claim detection.' },
  { idPrefix: 'dcc51edb', adminNote: 'Duplicate of the a8976e11 fabrication cluster (signal ticket 8e814f45). Guards shipped #288/#299/#303/#305/#307.' },
  { idPrefix: 'fa922a67', adminNote: 'Duplicate of the a8976e11 fabrication cluster (signal ticket 8e814f45). Guards shipped #288/#299/#303/#305/#307.' },
  { idPrefix: '2ee370de', adminNote: 'Duplicate of the a8976e11 fabrication cluster (signal ticket 8e814f45). Guards shipped #288/#299/#303/#305/#307.' },
  { idPrefix: '04ab7231', adminNote: 'Duplicate of the a8976e11 fabrication cluster (signal ticket 8e814f45). Guards shipped #288/#299/#303/#305/#307.' },
  { idPrefix: '25fe7124', adminNote: 'Duplicate of the a8976e11 fabrication cluster (signal ticket 8e814f45). Guards shipped #288/#299/#303/#305/#307.' },
  { idPrefix: 'b8b7dcb1', adminNote: 'Duplicate of the a8976e11 fabrication cluster (signal ticket 8e814f45). Guards shipped #288/#299/#303/#305/#307.' },
  { idPrefix: '34f0af90', adminNote: 'Duplicate of the a8976e11 fabrication cluster (signal ticket 8e814f45). Guards shipped #288/#299/#303/#305/#307.' },
  { idPrefix: '6bd0dc17', adminNote: 'Duplicate of the a8976e11 fabrication cluster (signal ticket 8e814f45 stays open until the session\'s schedule is recreated).' },
  { idPrefix: '2d9fe16f', adminNote: 'Guard-noise on the lane session while it applied closure briefs (its note listed applied updates the extractor mis-read as unproven dispatch claims). Verifier tuning tracked by the open signal ticket 8e814f45.' },
  { idPrefix: '5d0bc8f0', adminNote: 'Duplicate of f0c7d367 (Mac-bridge browser-control) — shipped and closed 2026-08-22.' },
  { idPrefix: '85420f42', adminNote: 'Not reproducible as written — sidebar binds title+navigation to the same chat object; re-file with repro if it recurs.' },
  { idPrefix: 'be3d3e8d', adminNote: 'Stale (pre-rebuild): superseded by ChatAutonomy sends, per-project digests, attention watchdog (#301), supervisor state (#296).' },
  { idPrefix: '9982d063', adminNote: 'Duplicate of 167822fb — fuzzy dedup shipped in PR #305.' },
  { idPrefix: '0a83ebe6', adminNote: 'Phantom-claim verifier (#299) + claim-discipline prompt (#296) shipped for exactly this failure.' },
  { idPrefix: '30625e17', adminNote: 'Canonical a8976e11 phantom ticket — platform guards shipped (#288/#299/#303/#305/#307); live tracking moved to signal ticket 8e814f45; session schedule recreation is with the supervisor.' },
  { idPrefix: 'cb4d9fd5', adminNote: 'Same phantom class — guards shipped; nightly triage session steered (prompt requires tool-result ids).' },
  { idPrefix: 'c184ceaa', adminNote: 'Wrong repo — generate_ui_meta.py belongs to canlegal-bench; re-file there.' },
  { idPrefix: 'e30264fc', adminNote: 'Superseded by the deterministic closure manifest (feedback/closure-manifest.ts) — all remaining items applied idempotently by the worker cron.' },
  // ── 2026-08-24 evening sweep ──
  { idPrefix: '9423b41b', adminNote: 'Shipped in PR #360 — schedule_get read-back tool returns the stored prompt verbatim, and list_schedules rows now carry a prompt hash so drift is detectable without a full read-back.' },
  // ── 2026-08-24 document tools + hat: shipped in PRs #344/#345/#346 ──
  { idPrefix: '9dac6576', adminNote: 'Shipped — superseded by the phased plan (ticket 0b18dc53): design in PR #346, implementation in PR #345 (adversarially reviewed + hardened). Digby can now create/edit DOCX, XLSX, CSV, TXT and fill PDF forms via the document tools; outputs land in your Files with download links.' },
  { idPrefix: '0b18dc53', adminNote: 'Shipped — P1 design note in PR #346; P2/P3 implementation in PR #345 after adversarial review + hardening (per-user quotas, upload ownership binding, PDF parse bounds, child gate on the public download route, route-posture pins). Full backend suite 120/2468 green.' },
  { idPrefix: '98853f4f', adminNote: 'Shipped in PR #344 (fleet self-merged under the full-autonomy lifecycle) — the animated hat is bigger everywhere, ~2x in the chat loading stage.' },
  // ── 2026-08-24 wave-5: shipped in PRs #341 + #342 ──
  { idPrefix: 'f58962f8', adminNote: 'Fixed in PR #342 — there was no CSS fade: a cancelled smooth-scroll parked your sent message mid-screen under the composer gradient. Sends now pin instantly to the bottom (same feel as coding sessions).' },
  { idPrefix: 'db881303', adminNote: 'Fixed in PR #342 — hovering a user message now shows the timestamp bottom-right under the bubble, same placement as agent messages.' },
  { idPrefix: 'f89d1213', adminNote: 'Shipped in PR #342 — in shared project chats, teammates\' messages now render in a violet tint with a small From: <name> footnote; your own messages unchanged. (New messages onward — old ones have no recorded author.)' },
  { idPrefix: 'd3a983ca', adminNote: 'Shipped in PR #341 — the dev container now ships tssh (ssh via the tailnet SOCKS proxy) and tcurl helpers; Settings copy updated. No more hand-written ProxyCommand.' },
  { idPrefix: '793f5130', adminNote: 'Shipped in PR #341 — docker/dev-image/Dockerfile with tailscale + helpers preinstalled (set CODING_DEV_IMAGE after building; README has the steps). Boot-time curl skipped automatically when present.' },
  // ── 2026-08-24 watch closures: contained guard signals + actioned briefs + shipped fixes ──
  { idPrefix: '56d3f7b2', adminNote: 'Contained + source stopped — the Tenstorrent session has no enabled schedules left and zero guard catches in 6h since the hardened guard (PR #332) and honest-final notice (#325) went live. The recurring fabricated-PR pattern this tracked is closed.' },
  { idPrefix: 'c67b882c', adminNote: 'Contained — evidence-guard signal from the stopped-run class; the guard replaced the final and journaled the verdict. Root causes shipped (#325 honest finals, #332 hardened guard); fabrication stream silent since. Not a separate defect.' },
  { idPrefix: 'dbfe28c3', adminNote: 'Actioned — coordination brief executed: hat loader shipped (PR #335), mobile overflow shipped (PR #336), tailnet follow-ups picked up (helpers/dev-image in flight). Superseded by the full-autonomy lifecycle (#337).' },
  { idPrefix: '0c256c3a', adminNote: 'Fixed in PR #338 (merged + deployed): sending now turns the mic OFF via recognition.abort() so already-sent text is never re-injected into the composer, and the mic button is now available in coding sessions too (shared useVoiceComposer hook).' },
  // ── 2026-08-23 tailnet dev container: shipped in PR #326 after adversarial review + hardening ──
  { idPrefix: '3ba5d35d', adminNote: 'Shipped in PR #326 (merged 2026-08-23) after two independent adversarial reviews + hardening: one per-user tailnet-joined dev container (admin-only v1 until the per-user volume layout, ticket 4ed6eb2e), userspace tailscaled + SOCKS5, verified tailnet join with per-session-container fallback, uid-1001 session execs, persistent node identity across recreation, Redis-locked creation. Setup: Account → Coding → Dev container.' },
  // ── 2026-08-23 wave-3 burn-down: shipped in PR #330 (deploy verified green + E2E) ──
  { idPrefix: '4fd1de3c', adminNote: 'Shipped in PR #330 — deep search is live: press Cmd/Ctrl+K (or the sidebar search bar) to search across ALL your chats and messages; results show matched snippets and open the chat directly. E2E-verified in production.' },
  { idPrefix: '3d6a8cb2', adminNote: 'Shipped in PRs #328 + #330 — queued messages now render inline at their chronological position with a clear "Queued — runs when this turn finishes" caption (coding sessions via #328, plain chat via #330) instead of a confusing floating notice.' },
  { idPrefix: '4b7a32b1', adminNote: 'Shipped in PR #330 — the chat composer now shows a live character counter from 7,000 chars and blocks over-8,000 sends with an actionable message (mirrors the supervisor composer pattern).' },
  { idPrefix: 'e886622b', adminNote: 'Shipped in PR #330 — root cause was the 30s liveness poll skipping hidden tabs; the chat now reconciles immediately on tab refocus (visibilitychange/focus/pageshow), so machine-run messages appear without a reload.' },
  { idPrefix: '1d4c8a14', adminNote: 'Shipped in PR #330 — the 8000-char schedule_self prompt limit is now documented in the tool schema and an over-length rejection returns a loud actionable failure (never a silent lost wake).' },
  { idPrefix: 'a1ca6bfc', adminNote: 'Shipped in PR #330 — list_feedback now orders open-first via an explicit status rank (Prisma status asc was alphabetical: done<in_progress<open). Same bug also fixed in the admin dashboard listing.' },
  // ── 2026-08-23 final push: contained guard-noise + actioned meta tickets ──
  { idPrefix: '3892de13', adminNote: 'Contained — evidence-guard signal (session cec340f2). The guard caught + neutralized it; the root-cause fix (honest-partial FINAL TURN notice) shipped in PR #325. Not a separate defect.' },
  { idPrefix: 'e27b3d3b', adminNote: 'Contained — evidence-guard signal (session b92ef13f). Guard neutralized; root cause addressed by PR #325 (honest-partial final turn). Not a separate defect.' },
  { idPrefix: '025980b2', adminNote: 'Contained — evidence-guard signal (session a8976e11, the long-running monitor). Guard neutralized every fabrication; root cause addressed by PR #325 + the schedule prompt patch. Tracked as one class, not per-firing.' },
  { idPrefix: 'ea8ab6d6', adminNote: 'Actioned — GitHub #260 commented (superseded by the tailnet dev container PR #326) and #261 adopted as a reviewer-gated phased upgrade (Prisma 7 phase 1 already merged, #321/#322). Coordination ticket closed.' },
  // ── 2026-08-23 follow-up sweep (drain check): stragglers the first batch missed ──
  { idPrefix: 'adfdf8ed', adminNote: 'Duplicate of the a8976e11 fabrication cluster (signal ticket 8e814f45). Guards shipped #288/#299/#303/#305/#307.' },
  { idPrefix: '6e5049a0', adminNote: 'Duplicate of the supervisor phantom-ACK failure — phantom-claim verifier (#299) + claim-discipline prompt (#296) + all-chat verification (#305) shipped for exactly this.' },
  { idPrefix: '67daf9a4', adminNote: 'Duplicate of the a8976e11 fabrication cluster (signal ticket 8e814f45 stays open until the session schedule is recreated). Guards shipped #288/#299/#303/#305/#307.' },
  { idPrefix: 'ea2bfd1a', adminNote: 'Superseded by the deterministic closure manifest (feedback/closure-manifest.ts) — all remaining items applied idempotently by the worker cron.' },
  // ── 2026-09-28 backlog audit (DOI-27 / T2): shared workspaces — fixed by PR #1123 (e18c15c4), deploy run 36472901762 green. Evidence-gated: closes only once fix-state proves the fix live.
  {
    idPrefix: '7acaa7ba',
    adminNote: 'Fixed in PR #1123 (e18c15c4, 2026-09-28): shared workspaces for project members — honest errors instead of silent failures, sidebar nesting, ancestor-inherited access. Deploy run 36472901762 concluded success.',
    evidence: { commitSha: 'e18c15c4', prUrl: 'https://github.com/canada-quant/digby/pull/1123', deployRunId: '36472901762' },
  },
  {
    idPrefix: 'd6110694',
    adminNote: 'Duplicate of user ticket 7acaa7ba (the same owner remark, captured from the supervisor chat) — fixed by the same PR #1123 (e18c15c4, 2026-09-28); the second dispatch lane it spawned was redundant.',
    evidence: { commitSha: 'e18c15c4', prUrl: 'https://github.com/canada-quant/digby/pull/1123', deployRunId: '36472901762' },
    duplicateOf: '7acaa7ba',
  },
  // ── 2026-10-06 ticket catch-up: fixed by the production-audit wave (PR #1303, 7beac605, deploy run 37507532011 green)
  // and the red-CI fix (013c6e70). These tickets had sat "dispatched" on a busy R&D lane that never picked them up.
  {
    idPrefix: '2bae9728',
    adminNote: 'Fixed in PR #1303 (7beac605, audit 2026-10-06 T5-2): start_coding_session with no prompt no longer reads as "work is running" — the spawn envelope + parent card say the child is IDLE until it gets a first message, and a charter-bound spawn delivers its first prompt. Deploy run 37507532011 concluded success.',
    evidence: { commitSha: '7beac605', prUrl: 'https://github.com/canada-quant/digby/pull/1303', deployRunId: '37507532011' },
  },
  {
    idPrefix: '4d64c70d',
    adminNote: 'Fixed in PR #1303 (7beac605, audit 2026-10-06 T2-3): a secure secret-intake path — the store_secret tool (human turn only) lifts the credential from the owner\'s own message server-side into their encrypted coding credentials, so every coding lane gets it as $ENVKEY in its shell; the model only ever sees the env var name, so "install this key" asks stay actionable while redaction keeps the value out of transcripts. Deploy run 37507532011 concluded success.',
    evidence: { commitSha: '7beac605', prUrl: 'https://github.com/canada-quant/digby/pull/1303', deployRunId: '37507532011' },
  },
  {
    idPrefix: 'ce94a30c',
    adminNote: 'Root cause fixed in PR #1303 (7beac605, audit 2026-10-06 T4-4): the [PROJECT SCHEDULES] DORMANT banner told the supervisor to "re-arm NOTHING" while its own one-shot chain told it to re-arm, so it claimed a re-arm it never made. The banner now recognises the supervisor\'s own follow-up chain, and dormancy reads live signals (T4-3). The action verifier had already stripped the invented id. Deploy run 37507532011 concluded success.',
    evidence: { commitSha: '7beac605', prUrl: 'https://github.com/canada-quant/digby/pull/1303', deployRunId: '37507532011' },
  },
  {
    idPrefix: '0087e649',
    adminNote: 'Fixed in 013c6e70: the deploy test gate failed on a keyless race in the call_in test (CI has no provider keys, so live catalog cards were unservable and a 3 s seat fallback raced the assertion); the test now pins the candidate lookup. Full suite green under a keyless env; deploy run 37528633078.',
    evidence: { commitSha: '013c6e70', deployRunId: '37528633078' },
  },
  {
    idPrefix: '4bb5fe23',
    adminNote: 'Shipped (4cc1416f, ticket catch-up 2026-10-06): Google Analytics G-NK7XPHC7FE is now a destination on the site\'s ONE Google tag (no second gtag.js, as Google\'s snippet asks), never for Digby Kids; the privacy policy discloses the Google tags.',
    evidence: { commitSha: '4cc1416f' },
  },
  {
    idPrefix: 'bd5b95b5',
    adminNote: 'Shipped (4cc1416f, ticket catch-up 2026-10-06): coding-session answers now carry the same Copy / thumbs / Report issue / Read aloud row as plain chats, filing the same feedback ticket; a message id that is not a row of the chat is saved unlinked instead of failing.',
    evidence: { commitSha: '4cc1416f' },
  },
  {
    idPrefix: 'ccd634fb',
    adminNote: 'Fixed (cae45248, ticket catch-up 2026-10-06) — all three failures were product bugs: an explicit remember now lifts a stale forget-ban (the recall obeyed an old ban on the topic); a standing chat rule that was only acknowledged is re-run once so set_chat_instructions saves it; the browser INTERACTION UNAVAILABLE banner shows only when the read-only limit actually bit. The suite now ignores the browser success header. The next nightly re-checks all three.',
    evidence: { commitSha: 'cae45248' },
  },
  {
    idPrefix: '92857a41',
    adminNote: 'Fixed (98879e4e PR #1318 + 4ece357b PR #1319) — run 37539254348 failed 2 NEW cases and both were suite over-strictness, not product bugs. 05-tools-create-document: the playbook\'s own row routes "a document they can open" to create_canvas, so the case accepts every real route (create_document preferred; a create_canvas tool call; an inline [CANVAS] block when the artifact landed) and hard-checks an artifact; the doctrine row also now names create_document for a downloadable FILE (md/docx/pdf/csv/xlsx, "save a file"), closing the no-row gap that made the tool pick seed-dependent luck. 13-tools-account-overview: the [YOUR INTEGRATION STATUS] block rides every signed-in turn, so a grounded no-tool answer passes (get_account_overview preferred only, read-only, the answer must name the state) — the same adjudication the integrations-category twin already had; post-fix the lead calls the tool outright. Verified live: nightly 37556487363 case 13 PASS with get_account_overview; case 05 artifact landed. Deploy run 37556477415 green, every box on 98879e4e.',
    evidence: { commitSha: '4ece357b', prUrl: 'https://github.com/canada-quant/digby/pull/1319', deployRunId: '37556477415' },
  },
  {
    idPrefix: 'e294f9a4',
    adminNote: 'Shipped v1 (2df91291, ticket catch-up 2026-10-06): Account → Integrations → MCP servers — add any remote MCP server (Streamable HTTP / SSE + auth header, encrypted at rest), live Test, automatic health checks that back off and self-heal, the server\'s tools offered in your chats and coding sessions, and 19 quick-start templates verified against vendor docs. Servers that need an OAuth sign-in (Notion, Sentry, Square, Asana) come with v2.',
    evidence: { commitSha: '2df91291' },
  },
  {
    idPrefix: '03aef0da',
    adminNote: 'Fixed (d89d38c4, ticket catch-up 2026-10-06): the schedule was live when the wake was built and cancelled by the owner 18 min later; its 8-char prefix then dead-ended because schedule_get only listed the newest 100 stopped rows. [FLEET ATTENTION] now prints the full 36-char id and lists only enabled, unexpired schedules; schedule_get resolves any id at any status.',
    evidence: { commitSha: 'd89d38c4' },
  },
  {
    idPrefix: '6ee7a779',
    adminNote: 'Fixed (d89d38c4, ticket catch-up 2026-10-06): 44 of 970 long supervisor answers in 4 days arrived as one block — real markdown whose newlines came through as spaces. A deterministic repair (wall-of-text.ts, server persist + live render) re-lines headings, bold labels, bullets, numbered runs and code fences and splits very long paragraphs, so the answer reads right the first time; supervisor chats no longer run the Double Checker that used to reformat it.',
    evidence: { commitSha: 'd89d38c4' },
  },
  {
    idPrefix: 'a8d6e514',
    adminNote: 'Fixed (2221dca4, ticket catch-up 2026-10-06): goal / todo progress notes are stored up to 2,000 chars (the DB column was never the limit — the tool layer cut at 200), so a standing loop keeps its continuation ledger; todo_get / goal_get return the full note, while every Pulse / brief / digest / todo_list display stays ≤ 200 chars on a word boundary and HOLD / progress-fraction detection reads the lead.',
    evidence: { commitSha: '2221dca4' },
  },
  {
    idPrefix: 'fcee0741',
    adminNote: 'Fixed (2221dca4, ticket catch-up 2026-10-06): a deferral line that cites a schedule id counts as armed (checked against the chat\'s own schedules — a cited DISABLED row still alarms), and cadence noun phrases ("**Next sweep:** 21:47Z", "Open threads for next sweep:", table cells, another actor\'s cadence) are no longer deferrals; real commitments ("I\'ll re-check next wake") still trip. Replay of the 48 h of rows: the ticket\'s three lines clear.',
    evidence: { commitSha: '2221dca4' },
  },
  {
    idPrefix: '49e2abd5',
    adminNote: 'Fixed (a6dac3b0, 2026-10-06): the background-delegation pool test armed its 30 ms resolve before awaitRunEnd began, so on a loaded runner the worker could settle first (waited 0). The wait now starts before the timer is armed; 10/10 green under CPU load in a keyless env with --maxWorkers=2.',
    evidence: { commitSha: 'a6dac3b0' },
  },
  {
    idPrefix: 'fb707538',
    adminNote: 'No CI gap on PR heads (checked 2026-10-06): PR #1307 head d79f629e ran all 6 ci.yml check-runs. The two red deploy waves came from commits e8fcfb8d and 54e097cb, which were pushed DIRECTLY to main by the integrating session (0 associated PRs), so CI and the deploy test gate ran at the same time — and the gate did its job: Deploy CrossModel was skipped both times, nothing broken reached production. Remedy taken: the integrating session now runs the full backend suite in a keyless env (env -i CI=true) before every push to main; every push since 21:00Z went green first.',
  },
  {
    idPrefix: '536ee3a1',
    adminNote: 'Fixed in 08211fc5 (2026-10-08): both red deploys (37827561943 on a90fed4c, 37827970155 on 789ef7d7) failed only the OpenAPI drift guard — GET /api/crossmodel/refs/{kind}/{id} had landed on main (a direct push, a90fed4c) without an openapi.json entry. Regenerated openapi.json (+1 path); deploy run 37829741014 on 08211fc5 concluded success.',
    evidence: { commitSha: '08211fc5', deployRunId: '37829741014' },
  },
];

/**
 * Ticket-lane guard (2026-10-06 ticket catch-up): true while an UNAPPLIED
 * entry names this ticket — its fix already shipped and this manifest closes it
 * once the evidence holds, so the dispatcher must not spawn a lane to rebuild
 * it. An APPLIED entry (closed, then reopened on recurrence) no longer shields
 * the ticket. A lookup failure answers true (fail safe: no lane this drain).
 */
export async function manifestClosePending(ticketId: string): Promise<boolean> {
  const entry = CLOSURE_MANIFEST.find((e) => String(ticketId).startsWith(e.idPrefix));
  if (!entry) return false;
  try {
    const applied = await prisma.contextStoreEntry.findUnique({
      where: { namespacePath_key: { namespacePath: MANIFEST_NS.join(':'), key: entry.idPrefix } },
      select: { key: true },
    });
    return !applied;
  } catch {
    return true;
  }
}

export interface ClosureManifestReport {
  /** Rows closed this sweep (0 on a dry run). */
  applied: number;
  /** Dry run: entries that would close now, with the row count. */
  wouldClose: Array<{ idPrefix: string; rows: number }>;
  /** Evidence entries whose proof does not hold yet (never claimed; retried next sweep). */
  pending: Array<{ idPrefix: string; reason: string }>;
}

/** One log line per (entry, reason) per process for a pending evidence entry — the 10-min sweep must not spam. */
const pendingLogged = new Set<string>();

/**
 * Apply every not-yet-applied manifest entry. Idempotent + at-most-once per
 * entry (durable claim); a DB hiccup releases nothing — the entry retries on
 * the next sweep because the claim is only taken AFTER a successful update.
 * An evidence-gated entry whose proof does not hold stays unclaimed too.
 * `dryRun` reports without writing anything (no row update, no claim).
 * Never throws.
 */
export async function applyClosureManifest(opts: { dryRun?: boolean } = {}): Promise<ClosureManifestReport> {
  const dryRun = opts.dryRun === true;
  const report: ClosureManifestReport = { applied: 0, wouldClose: [], pending: [] };
  for (const entry of CLOSURE_MANIFEST) {
    try {
      const already = await prisma.contextStoreEntry.findUnique({
        where: { namespacePath_key: { namespacePath: MANIFEST_NS.join(':'), key: entry.idPrefix } },
        select: { key: true },
      }).catch(() => null);
      if (already) continue;

      const openWhere = { id: { startsWith: entry.idPrefix }, status: { in: [...MANIFEST_CLOSABLE_STATUSES] } };
      let adminNote = `${entry.adminNote} [closed by manifest, evidence-verified]`;

      if (entry.evidence) {
        adminNote = `${adminNote} ${renderMachineCloseEvidence(entry.evidence)}`;
        // Prove the fix live on each still-open row (the owner's token path
        // rides the row's userId). Any row whose proof fails keeps the
        // WHOLE entry unclaimed — never a partial claim.
        const rows = await prisma.userFeatureRequest.findMany({
          where: openWhere,
          select: { id: true, userId: true },
        });
        let pendingReason: string | null = null;
        for (const row of rows) {
          const note: ClosureEvidenceNote = { ...entry.evidence };
          const state = await resolveFixStateFromEvidence({ id: row.id, userId: row.userId }, note);
          if (!state.fixLive) { pendingReason = state.reason; break; }
        }
        if (pendingReason) {
          report.pending.push({ idPrefix: entry.idPrefix, reason: pendingReason });
          const logKey = `${entry.idPrefix}|${pendingReason}`;
          if (!pendingLogged.has(logKey)) {
            pendingLogged.add(logKey);
            logger.info(`closure-manifest: ${entry.idPrefix} PENDING — fix not proven live yet (${pendingReason}); retried next sweep`);
          }
          continue;
        }
      }
      const contextPatch: Record<string, unknown> | null = entry.duplicateOf
        ? { duplicateOf: entry.duplicateOf, autoDispatch: false }
        : null;

      if (dryRun) {
        const n = await prisma.userFeatureRequest.count({ where: openWhere });
        if (n > 0) report.wouldClose.push({ idPrefix: entry.idPrefix, rows: n });
        continue;
      }

      let count = 0;
      if (contextPatch) {
        // A context merge needs the row (a Prisma JSON write replaces, never
        // merges) — one row per prefix in practice; every open one is closed.
        const rows = await prisma.userFeatureRequest.findMany({ where: openWhere, select: { id: true, context: true } });
        for (const row of rows) {
          const prev = row.context && typeof row.context === 'object' && !Array.isArray(row.context) ? (row.context as Record<string, unknown>) : {};
          const res = await prisma.userFeatureRequest.updateMany({
            where: { id: row.id, status: { in: [...MANIFEST_CLOSABLE_STATUSES] } },
            data: { status: 'done', adminNote, context: { ...prev, ...contextPatch } as any },
          });
          count += res.count;
        }
      } else {
        const res = await prisma.userFeatureRequest.updateMany({
          where: openWhere,
          data: { status: 'done', adminNote },
        });
        count = res.count;
      }
      // Claim AFTER the update so a failed update retries next sweep. A zero-row
      // update means the ticket is already done (or never existed) — claim it
      // too so the sweep stays O(new entries).
      await storeCreate(MANIFEST_NS, entry.idPrefix, { appliedAt: new Date().toISOString(), rows: count });
      if (count > 0) {
        report.applied += count;
        logger.info(`closure-manifest: closed ${entry.idPrefix} (${count} row)`);
      }
    } catch (err: any) {
      logger.warn(`closure-manifest: entry ${entry.idPrefix} failed (retries next sweep): ${err?.message}`);
    }
  }
  return report;
}
