/**
 * Machine-turn grouping (platform task, owner report 2026-09-02): in
 * hook/schedule-heavy chats — the Fleet Supervisor above all — machine traffic
 * arrives as BURSTS: a schedule/hook wake envelope (user row), the agent's
 * status-note reply (assistant row), the next wake, its reply… dozens of turns
 * deep. Phase C (machine-wake.ts) collapsed each wake ENVELOPE to a one-line
 * block, but the assistant replies still render as full-width markdown bubbles,
 * so the transcript remains a wall of machine turns between two human lines.
 *
 * This pure transform groups machine-turn rows into PER-WAKE collapsible
 * render items — ONE accordion per machine run, never one spanning multiple
 * wakes (the #604 regression: runs broke only at NON-machine user rows, so an
 * all-machine thread merged dozens of hourly wakes into a single maximal
 * mega-accordion — the owner's 2026-09-03 report). Each group collapses its
 * wake's ENTIRE machine turn — envelope, verifier chrome, relays, AND the
 * run's final assistant note (owner directive 2026-09-03, same report: the
 * #605 zero-click summary exemption still left the screen a long scroll of
 * wake paragraphs — "looks like fleet wakes are still appearing?" — so the
 * note folds into the pill too; its first meaningful line becomes the
 * accordion's headline label so history stays scannable with zero clicks).
 * NARROW CARVE-OUT (ticket 77c3a7e9, owner 2026-09-25: "the digest I asked
 * for gets buried in accordion style as a machine message"): the ANSWER row
 * of an owner-armed schedule firing — metadata.kind 'owner_digest'
 * (OWNER_DIGEST_KIND below, stamped by chat-agent finalize when
 * scheduleOwnerArmed && origin 'schedule') — is DELIVERED CONTENT the owner
 * asked to receive, not wake noise; it is exempted from the collapse and
 * renders as a normal visible assistant bubble. The envelope, verifier
 * chrome, and every NON-digest machine row of the turn keep the 2026-09-03
 * directive's collapse exactly as before.
 * Expansion renders the grouped rows VERBATIM in arrival order
 * (byte-lossless, display-layer only — nothing here changes what is stored
 * or sent to any model).
 *
 * GROUPING RULE — wake-anchored, wake-BOUNDED. In the plain-chat path
 * assistant rows carry NO metadata.origin (verified 2026-09-02: nothing in
 * the frontend persistence layer stamps origin on plain-chat assistant
 * replies), so a plain assistant row cannot be classified on its own. (The
 * FLEET thread is different: getSupervisorThread flattens origin onto every
 * row and the backend retro-classifier — fleet.service.ts classifyThreadRows —
 * stamps assistant rows with their own origin or inherits the nearest
 * preceding user row's, so the SupervisorChatTab probe DOES deliver assistant
 * origins; they are used via isMachineStampOrigin, byte-parity with the
 * backend noise set.)
 *
 *  - A run STARTS at a machine USER row (classifySystemRow: wake envelope /
 *    agent relay / harness system row), at a guard-chrome ASSISTANT row
 *    (action-verifier / evidence-guard notices — harness-injected, never a
 *    conversational reply), or at an assistant row stamped with a machine
 *    noise origin (fleet thread).
 *  - A run EXTENDS through 'agent'/'system' machine user rows AND any
 *    assistant rows (a reply lands directly after the turn that produced it —
 *    chronological adjacency is the attribution, mirroring the backend's own
 *    assistant noise-inheritance rule).
 *  - A run ENDS at the NEXT 'wake'-kind machine user row (the next
 *    schedule/hook/webhook firing — continuation envelopes carry origin
 *    'schedule' and bound the same way), at the first NON-machine user row
 *    (the owner or a teammate typing — the assistant reply after it answers a
 *    PERSON and stays visible), or at any non-user/non-assistant row.
 *  - At flush, the run's LAST non-chrome assistant row lends its first
 *    meaningful line to the group's headline label (the note itself stays
 *    INSIDE the collapse — the 2026-09-03 directive). Withhold placeholders /
 *    harness notes ('[System note', '[HARNESS NOTE', '⏳ HARNESS NOTE') never
 *    headline a group.
 *
 * Consecutive-only, positional: runs never merge across a human row, so a
 * wake burst can never leapfrog an owner message in the render order.
 *
 * Mirrors prose-grouping.ts's precedent (maximal runs, raw preserved on the
 * group, stable keys, pure functions) and machine-wake.ts's conservative
 * discipline: absent any machine signal a row is human ⇒ visible. Collapse,
 * never filter.
 */

import {
  classifySystemRow,
  isMachineStampOrigin,
  isOwnerInboxRow,
  isStatusCardRow,
  OWNER_INBOX_PREFIX,
  summarizeSystemRow,
  summarizeWakeEnvelope,
  type SystemRowKind,
} from './machine-wake';
import { classifyWakeHeadline, cleanWakeLabel } from './fleet-summary';

/** 'assistant-machine' = an assistant row inside (or chrome-starting) a
 *  machine turn — the agent's routine status note. */
export type MachineRowKind = SystemRowKind | 'assistant-machine';

/** Normalized view of a transcript row — callers adapt their message shape
 *  (CodingMessage via plainMeta.origin, FleetThreadMessage via its flattened
 *  origin) with the probe callback. */
export interface MachineRowProbe {
  id?: string;
  role?: string;
  content?: string | null;
  origin?: string | null;
  /** metadata.kind — 'owner_briefing' rows are the plain-English briefing
   *  layer (owner 2026-09-04): written FOR the owner, they render as regular
   *  assistant bubbles and are NEVER folded into a machine-turn accordion
   *  (byte-parity with the backend classifyThreadRows exemption). */
  kind?: string | null;
  /** metadata.scheduleOwnerArmed (ticket 6ef770a1): the wake user row was
   *  fired by an owner-armed schedule (promptSetBy 'user'). A machine GROUP
   *  whose ANCHOR row — the wake envelope user row — carries this renders
   *  EXPANDED with a "requested" marker: owner-armed digests are DELIVERED
   *  CONTENT, not internal wake noise (the ~7:30 AM AI-digest report). Only
   *  the anchor counts: the flag on the wake envelope describes the whole
   *  turn it opened; a flag on a non-anchor row (never stamped today, guarded
   *  regardless) must not leak into an unrelated group. */
  ownerArmed?: boolean;
  /** Ticket 56d6b204: metadata.childResult on the ANCHOR row — the wake was
   *  delivered by the auto-wired child→parent RESULT hook (the parent SPAWNED
   *  the sub-session and is waiting on its verdict). A machine GROUP whose
   *  anchor carries this renders EXPANDED with a "results" marker: the
   *  sub-session's delivered work is content the owner asked for, not internal
   *  wake noise. Only the anchor counts, mirroring ownerArmed — the wake
   *  envelope describes the whole turn it opened. */
  childResult?: boolean;
  /** Fixer 2026-09-27 (tt-rd audit, finding upward-chatter-1):
   *  metadata.ownerAskReply on the ANCHOR row — the wake was an [OWNER ASK
   *  UNANSWERED] re-wake / [FOLLOW-THROUGH] nudge raised to answer an owner
   *  question. A machine GROUP whose anchor carries this renders EXPANDED
   *  with an "answer" marker: the reply is the answer the owner asked for,
   *  never internal wake noise. Anchor-only, mirroring childResult. */
  ownerAskReply?: boolean;
  /** Ticket 390b6767: call-site-computed — this row rides a deliverable
   *  image the transcript renders inline through a signal the content scan
   *  cannot see: an assistant image part (coding transcripts) or an
   *  attachment chip with a resolved fileId. Markdown image/link syntax in
   *  `content` is detected HERE (rowCarriesInlineImage) — call sites don't
   *  need to scan content themselves. */
  carriesImage?: boolean;
}

/** metadata.kind marking an owner briefing — keep in sync with the backend's
 *  fleet/owner-briefing.service OWNER_BRIEFING_KIND. */
export const OWNER_BRIEFING_KIND = 'owner_briefing';

/** metadata.kind marking the ANSWER row of an owner-armed schedule firing
 *  (ticket 77c3a7e9) — keep in sync with the backend's chat-agent/
 *  machine-wake OWNER_DIGEST_KIND. Stamped only when the firing schedule was
 *  owner-armed (scheduleOwnerArmed + origin 'schedule'), the same signal the
 *  wake envelope's metadata.scheduleOwnerArmed carries. */
export const OWNER_DIGEST_KIND = 'owner_digest';

function isOwnerBriefing(probe: MachineRowProbe): boolean {
  return probe?.kind === OWNER_BRIEFING_KIND;
}

/**
 * Delivered RESULTS (owner 2026-09-29: "make sure messages between agents and
 * sessions and subsessions are also working correctly"): a sub-session's
 * hand-off row (metadata.kind/origin 'deliverable_handoff' — backend
 * coding/deliverable-handoff.ts) and a background continuation's answer
 * (metadata.kind 'continuation_result' — chat-agent/turn-continuation.ts) are
 * written FOR the person who asked. Neither carries a machine origin, so the
 * walk below used to fold one that landed right after a machine row (a
 * continuation's own [HARNESS CONTINUATION] envelope, a relay, a wake) into
 * that machine accordion — the result hidden exactly where the owner never
 * looks. They are owner-facing rows, like the briefing and the digest.
 */
export const DELIVERED_RESULT_KINDS: ReadonlySet<string> = new Set(['deliverable_handoff', 'continuation_result']);

export function isDeliveredResult(probe: Pick<MachineRowProbe, 'kind' | 'origin'>): boolean {
  return (!!probe?.kind && DELIVERED_RESULT_KINDS.has(probe.kind)) || probe?.origin === 'deliverable_handoff';
}

/** Ticket 77c3a7e9: the digest ANSWER of an owner-armed schedule firing —
 *  delivered content for the owner, exempt from the machine-turn collapse
 *  exactly like an owner briefing. The row still carries origin 'schedule'
 *  (inherited from the turn), so the kind marker must WIN in classification. */
function isOwnerDigest(probe: MachineRowProbe): boolean {
  return probe?.kind === OWNER_DIGEST_KIND;
}

export interface MachineTurnGroup<T> {
  kind: 'machineGroup';
  /** Stable React key: the first row's id (positional fallback). */
  key: string;
  /** The run's COLLAPSED rows in arrival order — the ENTIRE machine turn:
   *  wake envelope, verifier/system chrome, AND the final assistant note
   *  (owner directive 2026-09-03: the note folds into the pill too; tapping
   *  expands it). Expansion renders these raw. */
  rows: T[];
  count: number;
  /** Per-row classification, parallel to rows. */
  kinds: MachineRowKind[];
  /** Fallback header context: the wake's "eventType from 'source'", or a kind
   *  label ("agent relay + status notes") when the run has no wake. */
  summary: string;
  /** The scannable header line: the run's final assistant note's first
   *  meaningful line, markdown stripped (≤90) — "Fleet wake — 2 lane
   *  completions, both no-ops". '' when the run had no note (chrome-only). */
  headline: string;
  /** Caller-formatted time of the FIRST row (opts.timeOf), when provided. */
  timeLabel?: string;
  /** The LAST row's id — the wake note's durable message id when the run
   *  ended with one; the dashboard Fleet-summary card's click-through
   *  expansion/scroll target (Issue 7). Undefined only for id-less rows. */
  lastRowId?: string;
  /** Ticket 6ef770a1: true when the group's ANCHOR row (the wake envelope
   *  user row) carries metadata.scheduleOwnerArmed — the wake fired from an
   *  owner-armed schedule (promptSetBy 'user'). Callers mount the group
   *  EXPANDED and mark it "requested": owner-armed digests are delivered
   *  content the owner asked for, not internal wake noise. Undefined/absent
   *  on every legacy and machine-armed group — renders exactly as today. */
  ownerArmed?: boolean;
  /** Ticket 56d6b204: true when the group's ANCHOR row (the wake envelope
   *  user row) carries metadata.childResult — the wake was delivered by the
   *  auto-wired child→parent RESULT hook (the parent SPAWNED the sub-session
   *  and is waiting on its verdict). Callers mount the group EXPANDED and
   *  mark it "results": the sub-session's delivered work is content the owner
   *  asked for, never internal wake noise to fold behind the collapsed pill
   *  (the 2026-09-25 incident, chat 6e36c834 — "hidden in a machine
   *  accordion"). Undefined/absent on every legacy and non-child-result hook
   *  group — renders exactly as today. */
  childResult?: boolean;
  /** Fixer 2026-09-27 (finding upward-chatter-1): true when the group's
   *  ANCHOR row carries metadata.ownerAskReply — the wake was raised to
   *  answer an owner ask. Callers mount the group EXPANDED and mark it
   *  "answer". Undefined/absent on every other group — renders as today. */
  ownerAskReply?: boolean;
  /** Ticket 390b6767: true when ANY row in the group carries a deliverable
   *  inline image — markdown image/link syntax pointing at an inline byte
   *  route (`![alt](/api/crossmodel/files/<uuid>/inline)` or the bare-link
   *  form the markdown layer promotes the same way), an image attachment
   *  chip with a fileId, or an image part. Callers mount the group EXPANDED
   *  and mark the pill with an image chip: a delivered image is content the
   *  owner must SEE, not noise to fold behind the collapsed machine pill
   *  (the owner's invisible-test-image report). Undefined/absent on every
   *  image-free group — renders exactly as today. */
  hasImage?: boolean;
}

/** A transcript row (human, or an assistant reply to a HUMAN turn — always
 *  expanded) or one per-wake machine accordion. */
export type MachineTurnItem<T> =
  | { kind: 'row'; row: T }
  | MachineTurnGroup<T>;

/** Harness-injected assistant chrome that is never a conversational reply —
 *  these START a group even with no wake in the loaded window (e.g. a verifier
 *  notice after a paging cut). Byte-aligned with the backend's guard notes. */
const ASSISTANT_CHROME_PREFIXES = ['[ACTION VERIFIER', '[HARNESS EVIDENCE GUARD'];

function isAssistantChrome(content: string | null | undefined): boolean {
  if (typeof content !== 'string') return false;
  const c = content.trimStart();
  return ASSISTANT_CHROME_PREFIXES.some(p => c.startsWith(p));
}

/** Rows that must never be EXEMPTED as a run's summary note even though they
 *  sit in the assistant stream: withhold placeholders and harness run-state
 *  notes. Wider than ASSISTANT_CHROME_PREFIXES on purpose — classification is
 *  untouched (a standalone '[System note' assistant row stays visible as
 *  before); this set only vetoes the summary exemption. */
const SUMMARY_INELIGIBLE_PREFIXES = [...ASSISTANT_CHROME_PREFIXES, '[System note', '[HARNESS NOTE', '⏳ HARNESS NOTE', OWNER_INBOX_PREFIX];

function isSummaryIneligible(content: string | null | undefined): boolean {
  if (typeof content !== 'string') return false;
  const c = content.trimStart();
  return SUMMARY_INELIGIBLE_PREFIXES.some(p => c.startsWith(p));
}

/**
 * Ticket 390b6767: does this row's content reference a DELIVERABLE inline
 * image the markdown layer renders as an embed? Two shapes:
 *   - `![alt](/api/crossmodel/files/<uuid>/inline)` — the markdown image the
 *     delivery note carries (AuthedFileImage's route);
 *   - `[text](/api/crossmodel/files/<uuid>/inline)` — the BARE inline-route
 *     link the markdown anchor renderer promotes to an image embed (the
 *     c6e8edda bare-link promotion — same delivered image, link form).
 * Both key on the UUID form (the 8-char display prefix never matches a real
 * route), and the generated-file inline route is included too — a generated
 * image delivered into a machine note is the same class of deliverable.
 * Deliberately DOESN'T match the /download route (a download card is not an
 * inline image) or any query-string/external URL. Pure, exported for tests.
 */
const INLINE_IMG_UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const INLINE_IMAGE_MD_RE = new RegExp(
  `!\\[[^\\]]*\\]\\(/api/crossmodel/(?:files|generated-files)/${INLINE_IMG_UUID}/inline/?\\)`,
);
const INLINE_LINK_MD_RE = new RegExp(
  `\\[[^\\]]+\\]\\(/api/crossmodel/(?:files|generated-files)/${INLINE_IMG_UUID}/inline/?\\)`,
);

export function rowCarriesInlineImage(
  probe: Pick<MachineRowProbe, 'content' | 'carriesImage'>,
): boolean {
  if (probe?.carriesImage === true) return true;
  const c = typeof probe?.content === 'string' ? probe.content : '';
  // Review finding: `[^\]]*` over a pathological bracket-only payload is
  // O(n²) (measured 100k '[' ≈ 9s) and the grouping runs in render — bail
  // early unless the cheap link-opener marker is present at all.
  if (!c.includes('](')) return false;
  return INLINE_IMAGE_MD_RE.test(c) || INLINE_LINK_MD_RE.test(c);
}

/**
 * Ticket 56d6b204: does this USER-row content carry the child-result wake
 * signature? The metadata flag only exists on rows persisted AFTER this fix —
 * the incident chat itself (6e36c834, 2026-09-25) and every other legacy
 * parent wake carries nothing but content, so the anchor probe needs a
 * content-scan fallback to mount those turns EXPANDED too (the 390b6767
 * hybrid precedent: metadata flag first, content signature for legacy rows).
 *
 * The signature is the CONJUNCTION of two independently-matched markers, not
 * a contiguous string: the machine-provenance header
 * ('[MACHINE-TRIGGERED RUN' — the wake envelope prefix chat-agent.service
 * bakes at position 0 today, matched anywhere for tolerance) AND the rendered
 * child-result template head (hooks.service CHILD_RESULT_PROMPT_TEMPLATE:
 * `Your sub-session "{{sourceChatTitle}}" (chat id …) reported {{eventType}}`
 * — or the LEGACY pre-2026-09-14 generation, which renders the same head
 * WITHOUT the '(chat id …' parenthetical: `Your sub-session "X" reported …`
 * [reviewer B3]: 34 enabled prod hooks still carry the legacy template, so
 * the parenthetical is matched OPTIONALLY). Neither marker alone suffices:
 * the prefix marks ANY machine wake (a fleet sweep envelope has it too —
 * expanding every hook wake would undo the whole collapse), and prose that
 * merely mentions a sub-session is not a verdict delivery. The title
 * parenthetical matches loosely (1..120 chars, either quote style — the
 * title is free text) but anchors on the literal 'Your sub-session "' /
 * 'Your sub-session '' openers, which no human phrasing produces. Pure,
 * exported for tests.
 */
const CHILD_RESULT_HEAD_RE = /Your sub-session ["'].{1,120}["']\s*(?:\(chat id )?/;

export function isChildResultWakeContent(content: string): boolean {
  const c = typeof content === 'string' ? content : '';
  if (!c.includes('[MACHINE-TRIGGERED RUN')) return false;
  return CHILD_RESULT_HEAD_RE.test(c);
}

/** The machine classification of a row, or null for a human row. Assistant
 *  rows classify on guard chrome OR a machine noise origin stamp (fleet
 *  thread; byte-parity with the backend noise set) — wake-anchored
 *  inheritance (the common case, and the ONLY case in the plain-chat path
 *  where assistant rows carry no origin) is the grouping walk's business. */
export function classifyMachineRow(probe: MachineRowProbe): MachineRowKind | null {
  if (!probe) return null;
  if (probe.role === 'user') {
    return classifySystemRow({ role: probe.role, content: probe.content, metadata: { origin: probe.origin } });
  }
  if (probe.role === 'assistant') {
    // Owner briefings are exempt even when a machine origin stamp is present
    // (defensive — the backend never stamps one): the kind marker wins.
    if (isOwnerBriefing(probe)) return null;
    // Owner-armed scheduled digest (ticket 77c3a7e9): the ANSWER row carries
    // origin 'schedule' (inherited from its turn), so WITHOUT this exemption a
    // standalone/window-edge digest row would classify 'assistant-machine' via
    // isMachineStampOrigin and fold right back into an accordion. The kind
    // marker wins.
    if (isOwnerDigest(probe)) return null;
    if (isDeliveredResult(probe)) return null;
    if (isAssistantChrome(probe.content) || isMachineStampOrigin(probe.origin)) return 'assistant-machine';
    // Harness-authored assistant cards (owner ask 2026-09-14): owner-inbox
    // notes and per-project status rows are machine traffic — they fold into
    // the machine turn that produced them (rendered as cards when expanded),
    // never as standalone conversational replies.
    const asMsg = { role: probe.role, content: probe.content, metadata: { origin: probe.origin, kind: probe.kind } };
    // Owner-inbox notes fold with the machine turn; the hourly project STATUS
    // card is written FOR the owner (like the owner briefing) and must stay a
    // visible row — never a collapsed pill, never the accordion's headline
    // (EOD review 2026-09-14).
    // (The per-SESSION status card — origin session_status, 2026-09-15 — is the
    // same class: written FOR the owner, stays a visible row.)
    if (isStatusCardRow(asMsg)) return null;
    if (isOwnerInboxRow(asMsg)) return 'assistant-machine';
    return null;
  }
  return null;
}

const KIND_LABELS: Record<MachineRowKind, string> = {
  wake: 'wake',
  agent: 'agent relay',
  system: 'system notice',
  'assistant-machine': 'status notes',
};

/** Header context for a run: the first wake's event summary when there is
 *  one ("run_completed from 'Nightly Engineer'"), else the distinct kind
 *  labels in order of first appearance ("agent relay + status notes"). */
function buildSummary(probes: MachineRowProbe[], kinds: MachineRowKind[]): string {
  const wakeIdx = kinds.indexOf('wake');
  if (wakeIdx >= 0) {
    const env = summarizeWakeEnvelope(probes[wakeIdx].content || '');
    if (env.eventType && env.sourceTitle) return `${env.eventType} from '${env.sourceTitle}'`;
    if (env.eventType) return env.eventType;
    if (env.sourceTitle) return `from '${env.sourceTitle}'`;
    return 'machine wake';
  }
  const seen: MachineRowKind[] = [];
  for (const k of kinds) if (!seen.includes(k)) seen.push(k);
  return seen.map(k => KIND_LABELS[k]).join(' + ');
}

/** The group's scannable headline from its exempted summary note: the first
 *  line that is neither empty nor a bracketed chrome header, leading/trailing
 *  markdown emphasis and heading markers stripped ("**Fleet wake — …**" →
 *  "Fleet wake — …"), then cleanWakeLabel (owner polish pass 2026-09-03:
 *  EMBEDDED emphasis tokens strip too — "⚠ **interrupted**" renders plain —
 *  and the note's own leading timestamp de-dupes against the row's time
 *  chrome), whitespace-collapsed, capped — never fabricated, just truncated.
 *  Display-label only: the expanded rows render the note verbatim. */
function buildHeadline(content: string): string {
  const line = (content || '')
    .split('\n')
    .map(l => l.trim().replace(/^[#>\s\-*]+/, '').replace(/\*+$/, '').trim())
    .find(l => l.length > 0 && !l.startsWith('[')) || '';
  if (!line) return '';
  return summarizeSystemRow(cleanWakeLabel(line), 90);
}

/**
 * Group wake-BOUNDED machine-turn runs: ONE group per machine run, with the
 * run's final summary note exempted out of the collapse (rendered expanded
 * right after its group). Every machine-classified row lands in a group (a
 * run of one chrome row is a group of one — the same collapsed affordance as
 * today's single-row MachineWakeBlock); human rows and exempted summaries
 * pass through in their exact arrival positions.
 */
export function groupMachineRows<T>(
  rows: T[],
  opts: {
    probe: (row: T) => MachineRowProbe;
    /** Optional clock label for the group header (first row's time). */
    timeOf?: (row: T) => string | undefined;
  },
): MachineTurnItem<T>[] {
  const items: MachineTurnItem<T>[] = [];
  let runRows: T[] = [];
  let runProbes: MachineRowProbe[] = [];
  let runKinds: MachineRowKind[] = [];

  const flush = () => {
    if (!runRows.length) return;
    // Headline (owner directive 2026-09-03): the ENTIRE machine turn — wake
    // envelope, verifier chrome, AND the final assistant note — collapses
    // into the single pill; tapping expands it. The run's LAST non-chrome
    // assistant row only lends its first meaningful line to the accordion
    // label so history stays scannable; the note itself stays INSIDE the
    // collapse. Withhold placeholders and harness notes are ineligible as
    // headline sources (they are chrome, not the summary).
    let headline = '';
    for (let i = runRows.length - 1; i >= 0; i--) {
      // Eligibility: a real assistant row with real content — an empty row
      // can never headline the group (review N1: a trailing empty assistant
      // row would otherwise win and bury the real note's line).
      if (runProbes[i].role === 'assistant'
          && (runProbes[i].content || '').trim().length > 0
          && !isSummaryIneligible(runProbes[i].content)) {
        headline = buildHeadline(runProbes[i].content || '');
        break;
      }
    }
    const first = runProbes[0];
    // Ticket 390b6767: ANY row in the run may carry the delivered image — the
    // note that delivers it is typically the LAST assistant row, not the wake
    // envelope, so this scans every probe (content syntax + call-site flag).
    const hasImage = runProbes.some(p => rowCarriesInlineImage(p)) || undefined;
    items.push({
      kind: 'machineGroup',
      key: `mtg-${first.id ?? items.length}`,
      rows: runRows,
      count: runRows.length,
      kinds: runKinds,
      summary: buildSummary(runProbes, runKinds),
      headline,
      timeLabel: opts.timeOf?.(runRows[0]),
      lastRowId: runProbes[runProbes.length - 1]?.id,
      // Owner-armed anchor (ticket 6ef770a1): the FIRST row's probe carries
      // the wake envelope's metadata.scheduleOwnerArmed. runProbes[0] is the
      // run's anchor by construction (push() appends and flush() emits the
      // accumulated run), so this reads the wake envelope — the row the
      // backend stamps — and only that row.
      ownerArmed: first.ownerArmed === true || undefined,
      // Child-result anchor (ticket 56d6b204): the FIRST row's probe carries
      // the wake envelope's metadata.childResult (or the content-signature
      // fallback stamped below for legacy rows) — same anchor-only rule as
      // ownerArmed: the wake envelope describes the whole turn it opened.
      childResult: first.childResult === true || undefined,
      // Owner-ask anchor (fixer 2026-09-27): same anchor-only rule — the wake
      // envelope of an owner-ask re-wake describes the whole turn it opened.
      ownerAskReply: first.ownerAskReply === true || undefined,
      hasImage,
    });
    runRows = [];
    runProbes = [];
    runKinds = [];
  };

  const push = (row: T, probe: MachineRowProbe, kind: MachineRowKind) => {
    runRows.push(row);
    runProbes.push(probe);
    runKinds.push(kind);
  };

  for (const row of rows) {
    let probe = opts.probe(row) || {};
    if (probe.role === 'user') {
      const k = classifyMachineRow(probe);
      if (k) {
        // WAKE BOUNDARY (the #604 mega-accordion fix): the NEXT wake envelope
        // closes the current run and starts a new one — one accordion per
        // machine run, never one spanning multiple wakes. 'agent'/'system'
        // rows (verifier notices, relays) EXTEND the run that produced them.
        if (k === 'wake') flush();
        // A CHILD-SESSION RELAY carrying the delivered-result marker also
        // opens a turn of its own (ticket 739e8191, review finding): a relay
        // classifies 'agent' and therefore EXTENDS the run around it, so
        // without a boundary here the group's anchor is some earlier sweep and
        // the anchor-only childResult read below (and at flush) never sees the
        // marker — the delivered result stays folded shut. Flushing first makes
        // the relay the anchor of its OWN group, which is exactly what the
        // marker already means everywhere else. Never strips: rows without the
        // marker extend the run exactly as before.
        if (k === 'agent' && probe.childResult === true) flush();
        // Child-result content-signature fallback (ticket 56d6b204): LEGACY
        // wake rows predate metadata.childResult — the incident chat itself
        // (6e36c834) is one — so the anchor is derived from the rendered
        // child-result template head in the content. Stamped on the probe
        // BEFORE push so flush() reads it off runProbes[0]; the metadata flag
        // (already on the probe when the backend stamped the row) wins
        // regardless — this only ever adds, never strips.
        if (k === 'wake' && !probe.childResult && isChildResultWakeContent(probe.content || '')) {
          probe = { ...probe, childResult: true };
        }
        push(row, probe, k);
      } else {
        // A human (or unclassifiable) user row closes the run: the assistant
        // reply after it answers a PERSON and stays visible.
        flush();
        items.push({ kind: 'row', row });
      }
      continue;
    }
    if (probe.role === 'assistant') {
      if (isOwnerBriefing(probe) || isOwnerDigest(probe) || isDeliveredResult(probe) || isStatusCardRow({ role: 'assistant', content: probe.content, metadata: { origin: probe.origin, kind: probe.kind } })) {
        // Owner briefing (owner 2026-09-04), the owner-armed scheduled digest
        // ANSWER (ticket 77c3a7e9), and the hourly project status card
        // (owner 2026-09-14): plain-English rows written FOR the owner — render
        // as visible rows, never folded into a wake accordion. Close the open
        // run first so chronology holds ([group(wake+note), briefing/status,
        // group(next wake…)]); the next wake starts its own group as usual.
        flush();
        items.push({ kind: 'row', row });
        continue;
      }
      if (runRows.length > 0) {
        // Wake-anchored inheritance: a reply directly after machine turn rows
        // is that turn's status note (plain-chat assistant rows carry no
        // origin stamp, so chronological adjacency is the attribution — the
        // same rule the backend's retro-classifier applies to fleet rows).
        push(row, probe, 'assistant-machine');
      } else if (classifyMachineRow(probe)) {
        // Standalone machine assistant row: guard chrome, or a machine noise
        // origin stamp (fleet thread) — starts a group even with no wake in
        // the loaded window (e.g. after a paging cut).
        push(row, probe, 'assistant-machine');
      } else {
        items.push({ kind: 'row', row });
      }
      continue;
    }
    // Unknown/system roles: conservative boundary — never swallowed.
    flush();
    items.push({ kind: 'row', row });
  }
  flush();
  return items;
}

/**
 * Background bundling (owner 2026-09-29, the digby-benchmarks recording: "we
 * need to hide a lot more machine messages"). Between two visible rows a
 * project supervisor chat stacked one accordion pill PER wake — "Lane checked
 * this wake: healthy, no action needed", "Sweep at … (firing 12)",
 * "run_completed from '…'", "Settle-check outcome: stale premise …" — two or
 * three between every hourly card. Consecutive per-wake groups now fold into
 * ONE "background activity" row; expanding it shows the per-wake pills exactly
 * as before (which expand to the verbatim rows) — collapse, never filter, and
 * never one flat mega-accordion (the #604 lesson: the bundle holds GROUPS).
 *
 * A group that must stay in sight is never bundled and breaks the run: an
 * owner-armed digest, a child-result delivery, an owner-ask answer, a
 * delivered image. A lone group stays a plain group. Pure; display only.
 */
export interface MachineTurnBundle<T> {
  kind: 'machineBundle';
  /** Stable React key: the first group's key. */
  key: string;
  groups: MachineTurnGroup<T>[];
  /** Total folded rows across the groups. */
  rowCount: number;
  /** First / last group's time labels. */
  firstTime?: string;
  lastTime?: string;
  /** Groups whose headline reads as trouble (classifyWakeHeadline 'attention'). */
  attention: number;
  /** Inter-agent messages (lane ↔ supervisor relays) folded in the bundle. */
  agentMessages: number;
  /** The newest group's headline (or summary) — the row's "latest:" text. */
  latest: string;
}

export type BundledMachineItem<T> = MachineTurnItem<T> | MachineTurnBundle<T>;

/** True for a group that must stay visible on its own (never bundled). */
export function isPinnedMachineGroup(g: Pick<MachineTurnGroup<unknown>, 'ownerArmed' | 'childResult' | 'ownerAskReply' | 'hasImage'>): boolean {
  return !!(g.ownerArmed || g.childResult || g.ownerAskReply || g.hasImage);
}

export function bundleMachineGroups<T>(items: MachineTurnItem<T>[], opts: { minGroups?: number } = {}): BundledMachineItem<T>[] {
  const min = Math.max(2, opts.minGroups ?? 2);
  const out: BundledMachineItem<T>[] = [];
  let run: MachineTurnGroup<T>[] = [];
  const flush = () => {
    if (run.length >= min) {
      const last = run[run.length - 1];
      out.push({
        kind: 'machineBundle',
        key: `mtb-${run[0].key}`,
        groups: run,
        rowCount: run.reduce((n, g) => n + g.count, 0),
        firstTime: run[0].timeLabel,
        lastTime: last.timeLabel,
        attention: run.filter((g) => !!g.headline && classifyWakeHeadline(g.headline) === 'attention').length,
        agentMessages: run.reduce((n, g) => n + g.kinds.filter((k) => k === 'agent').length, 0),
        latest: last.headline || last.summary,
      });
    } else {
      out.push(...run);
    }
    run = [];
  };
  for (const item of items) {
    if (item.kind === 'machineGroup' && !isPinnedMachineGroup(item)) {
      run.push(item);
      continue;
    }
    flush();
    out.push(item);
  }
  flush();
  return out;
}
