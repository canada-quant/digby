/**
 * TCC grant-loss self-heal (ticket c44b19e9, 2026-10-24, agent 0.9.9).
 *
 * THE MISHAP (observed live on cql-stanne-mbp1, agent 0.9.7): a self-update
 * swaps the node binary tree; macOS TCC keys grants to the binary's exact
 * file identity, so Accessibility / Screen Recording / Full Disk Access /
 * Calendars (EventKit) grants silently die. Capabilities then failed at task
 * time with bare classified errors (`{"reason":"calendar-denied"}` — no
 * remediation copy; re-probed live 19:26Z 2026-10-24), the Calendars loss is
 * INVISIBLE to the backend's e2915963 advert detector (TCC_REGRESSION_KEYS
 * is ax/sr/fda only, and the cal advert only flips after the first DENIED
 * read), and the owner was never told to re-grant + relaunch. The
 * oq_51ab56d2 / 30787bc4 / a9a74086 / 6f4f8b36 incident line is one root
 * cause: a swap is a RELAUNCH BOUNDARY that invalidates every grant
 * assumption this process inherited.
 *
 * THIS MODULE (pure — every function is exported for the c44b19e9 suite):
 *   1. The CONSOLIDATED re-grant event: ONE structured payload listing every
 *      missing grant plus the System Settings pane deep-link for each, so the
 *      backend surfaces ONE owner card (click-paths + the quit-and-relaunch
 *      instruction) instead of silent failure or per-permission dialog spam.
 *   2. The classification map from a call-time TCC-DENIAL outcome to the
 *      grant that was lost: calendar-denied → cal; the 33401f39 corroborated
 *      solid-placeholder capture conviction → sr; the chatdb Full Disk
 *      Access block → fda; a missing-Accessibility block (only when the
 *      grant previously read true) → ax. Fed ONLY from real command results
 *      — NEVER a requesting probe (the 0.9.8 rule, ticket 30787bc4: the
 *      poll/status path must never drive a requesting API; c44b19e9's
 *      preflight uses authorization-STATUS queries only).
 *   3. The episode set arithmetic the run loop uses for once-per-episode
 *      surfacing: a conviction ADDS its grant to the open set, a real
 *      success HEALS it out; the consolidated event rides the poll only
 *      while the set is non-empty, and the backend dedupes identical sets
 *      (Redis per-episode key) so ONE card lands per episode. The operator
 *      rule (incident 6f4f8b36) rides every surface: a newly granted
 *      permission only applies to a FRESHLY LAUNCHED process — the card
 *      tells the user to QUIT + RELAUNCH the agent after re-granting.
 */

import { AgentConfig } from './config';

/** The wire vocabulary for the re-grant event's `grants[]` — the same keys
 *  the permission advert (ax/sr/fda/cal) speaks; cal joins the surface the
 *  e2915963 detector never watched. One vocabulary, never a drift.
 *
 * 30d3c366 (2026-10-29): `im` (Input Monitoring) and `ae` (Automation) join
 *  the vocabulary. They were the two grants the owner actually lost on both
 *  Macs and NEITHER vocabulary could name them, so a post-update loss of
 *  either could not produce a card at all — the consolidated event above
 *  would have carried an empty set and `buildTccReGrantNeeded` returns null
 *  for that. Appended (never interleaved) so every pre-existing pinned
 *  ordering — the wire form `ax,sr,fda,cal` and the backend parser — is
 *  byte-identical. */
export type ReGrantKey = 'ax' | 'sr' | 'fda' | 'cal' | 'im' | 'ae';

/** The canonical key order (stable wire shape for the backend parser and the
 *  test pins). 30d3c366 appends the two new grants LAST so a pre-existing
 *  three/four-grant set serialises exactly as it always did. */
export const REGRANT_KEY_ORDER: readonly ReGrantKey[] = ['ax', 'sr', 'fda', 'cal', 'im', 'ae'];

/** 30d3c366: the grants that are ADVISORY — worth naming when lost, but never
 *  a capability gate of their own. Input Monitoring is what macOS keys
 *  `CGPreflightListenEventAccess` to (OBSERVING input events); this agent
 *  POSTS events (an Accessibility power) and creates no event tap, so a
 *  missing `im` must never present as "remote control is broken" — the copy
 *  says what it is for and nothing more. Automation is deliberately NOT in
 *  this set: the front-window probe really does need System Events, so a lost
 *  `ae` legitimately degrades the capture-display choice. */
export const ADVISORY_REGRANT_KEYS: readonly ReGrantKey[] = ['im'];

/** T1 (follow-up review): pure covered-guard — does the open consolidated
 *  re-grant episode already cover an e2915963-seam regression set? When it
 *  does, the older per-key surfacing is suppressed (ONE incident, ONE Mac
 *  dialog + ONE owner push: the consolidated card, which names every lost
 *  grant incl. Calendars and carries the relaunch line). A partial overlap
 *  does NOT suppress — the uncovered keys still need their surfacing. */
export function regressionCovered(regressed: readonly string[], openEpisode: readonly ReGrantKey[]): boolean {
  if (regressed.length === 0 || openEpisode.length === 0) return false;
  return regressed.every((k) => (openEpisode as readonly string[]).includes(k));
}

/** The System Settings pane deep-link per grant. `cal` joins the vocabulary
 *  the backend validates (VALID_PANES) and the agent's own PANE_URLS — the
 *  Calendars pane id macOS exposes for EventKit TCC.
 *
 *  30d3c366: `im` → Privacy_ListenEvent is the pane macOS titles "Input
 *  Monitoring" (the `IOHIDRequestAccess`/`CGPreflightListenEventAccess` TCC
 *  service — the pane's own id is ListenEvent, not "InputMonitoring"; a wrong
 *  id opens Settings at the top level and the owner hunts, which is exactly
 *  the friction the ticket reports). `ae` → Privacy_Automation is the
 *  Automation pane that hosts the per-target Apple Events rows (System
 *  Events / Calendar); it has no add-the-file switch — the row appears only
 *  after the first denied Apple Event. */
export const REGRANT_PANE_URLS: Record<ReGrantKey, string> = {
  ax: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  sr: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  fda: 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles',
  cal: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars',
  im: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent',
  ae: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation',
};

/** Human label per grant (the card's line-item copy). The labels are the
 *  EXACT System Settings pane names (30d3c366: the ticket is about the owner
 *  having to hunt for the toggles — a label that is not the pane title is
 *  half the friction), except `ae` which the pane calls "Automation". */
export const REGRANT_LABELS: Record<ReGrantKey, string> = {
  ax: 'Accessibility',
  sr: 'Screen Recording',
  fda: 'Full Disk Access',
  cal: 'Calendars',
  im: 'Input Monitoring',
  ae: 'Automation',
};

/** ONE line of the card's fix copy per grant: the label, the pane, and the
 *  one instruction that matters. FDA keeps its add-the-file steps (a CLI
 *  node binary has no switch until it is ADDED to the pane) — the same
 *  steps the agent's own onboarding dialog uses (51d8dbe0: name the REAL
 *  executable so the file the user adds is exactly the revealed one). */
export function regrantLine(grant: ReGrantKey, helper: string): string {
  const label = REGRANT_LABELS[grant];
  switch (grant) {
    case 'fda':
      return `• ${label} — in the Full Disk Access pane, click + (unlock first if needed), add the "${helper}" file, and turn it ON.`;
    // 30d3c366: the two grants the ticket reports. Their panes have no
    // find-the-file switch — macOS lists them ONLY after a denied call — so
    // the copy names the trigger instead of sending the owner hunting for a
    // row that is not there (the exact friction the ticket describes).
    case 'im':
      return `• ${label} — open the Input Monitoring pane and turn "${helper}" ON if it is listed; if it is not listed yet, it appears after this Mac's next input observation.`;
    case 'ae':
      return `• ${label} — open the Automation pane, expand "${helper}", and turn ON the switches for "System Events" (and Calendar if present). If nothing is listed, it appears after the next attempt.`;
    default:
      return `• ${label} — open the ${label} pane, find "${helper}", and turn the switch ON.`;
  }
}

/** The consolidated event payload — ONE result carrying EVERY missing grant
 *  (never per-grant spam), the System Settings pane deep-link per grant, and
 *  the quit-and-relaunch instruction (the operator rule: a grant only takes
 *  effect on a freshly launched process, so toggling without relaunching
 *  heals nothing). */
export interface TccReGrantNeeded {
  type: 'tcc-regrant-needed';
  /** The grants that were lost / not re-made after the swap. */
  grants: ReGrantKey[];
  /** The System Settings pane deep-link per grant (the card's button target). */
  panes: string[];
  /** What orphaned them ("self-update 0.9.9 swapped the agent binary at …"
 *  for the post-update preflight; "call-time denial" for the watchdog), or
 *  null when unknown. */
  cause: string | null;
  /** The operator rule, always true from this module: the user must QUIT +
 *  RELAUNCH the agent after re-granting (a new grant applies only to a
 *  freshly launched process). */
  relaunchRequired: true;
}

/** Pure: build the consolidated event from the missing grants + cause.
 *  Dedupes the grant list and preserves the module's canonical key order
 *  (REGRANT_KEY_ORDER — ax, sr, fda, cal, im, ae) — a stable wire shape for
 *  the backend parser and the test pins. Returns null for an empty set
 *  (nothing to re-grant).
 *
 *  30d3c366: this filter used to be a hand-written four-key literal. Adding a
 *  key to ReGrantKey without touching it would have silently DROPPED the new
 *  grant — the event would carry a shorter set than the caller passed, and an
 *  im-only or ae-only loss would have produced `grants: []` plus a built event
 *  with no grants. One order constant, referenced here, is the fix. */
export function buildTccReGrantNeeded(
  grants: ReGrantKey[],
  cause: string | null,
): TccReGrantNeeded | null {
  if (grants.length === 0) return null;
  const unique = [...new Set(grants)];
  const ordered = REGRANT_KEY_ORDER.filter((k) => unique.includes(k));
  return {
    type: 'tcc-regrant-needed',
    grants: ordered,
    panes: ordered.map((g) => REGRANT_PANE_URLS[g]),
    cause,
    relaunchRequired: true,
  };
}

/** The user-facing consolidated copy (the Mac-side notification/dialog and
 *  the backend card's body derive from the same shape — one voice): the
 *  missing list, the per-grant pane line, and the relaunch line LAST (the
 *  step the incident 6f4f8b36 operator rule demands). */
export function regrantNeededMessage(event: TccReGrantNeeded, helper: string): string {
  const n = event.grants.length;
  const lines = event.grants.map((g) => regrantLine(g, helper));
  return (
    `Digby lost ${n === 1 ? 'a' : n} macOS permission${n === 1 ? '' : 's'} on this Mac` +
    `${event.cause ? ` (${event.cause})` : ''}:\n\n` +
    lines.join('\n') +
    '\n\nThen QUIT and RELAUNCH the Digby agent — the new grant only applies to a freshly launched process, so until it restarts the ' +
    `${n === 1 ? 'capability keeps failing' : 'capabilities keep failing'}.`
  );
}

// ── Episode-set arithmetic (once-per-episode surfacing) ──────────────────────

/** Pure: the episode dedupe key — the sorted joined grant set. Identical to
 *  the backend's joinedKeySet format for the ax/sr/fda subset, so a
 *  cross-surface comparison is a plain string compare (the suppression
 *  itself is regressionCovered on the agent side /
 *  regrantCoversRegression on the backend side — T1). */
export function regrantEpisodeKey(grants: ReGrantKey[]): string {
  return [...new Set(grants)].sort().join(',');
}

/** Pure: does a conviction CHANGE the open episode (a new grant lost → a new
 *  key-set → surface once)? The same grant re-observed on every command
 *  while the episode is open changes nothing — the 30787bc4 anti-pattern
 *  (one dialog per poll) stays closed. */
export function convictionChangesEpisode(open: ReGrantKey[], source: TccDenialSource | null): boolean {
  if (!source) return false;
  const grant = classifyDenial(source);
  if (!grant) return false;
  return !open.includes(grant);
}

/** The runtime grant-loss classifier input: a classified call-time outcome.
 *  Fed ONLY from real command results — never a requesting probe. */
export type TccDenialSource =
  | { kind: 'calendar-denied' }   // calendar.ts classifier (EventKit auth tier / legacy -1743)
  | { kind: 'solid-capture' }    // 33401f39 corroborated solid-placeholder conviction
  | { kind: 'fda-block' }        // chatdb Full Disk Access denial text
  | { kind: 'ax-block' }         // computer.ts preflight Accessibility block
  | { kind: 'im-block' }         // computer.ts preflight Input Monitoring block
  // 30d3c366: an Apple Events / System Events automation denial (-1743) from a
  // REAL call — the front-window probe (computer.ts 'front_window'), the
  // legacy 'frontmost' action. Before this existed the text was unclassified,
  // so an Automation loss produced NO episode and the only trace was a
  // "capture falls back to pointer → main" log line. That is precisely the
  // ticket's "agent silently blind; the failure presents as flaky input".
  | { kind: 'automation-denied' };

/** Pure: map a call-time TCC-denial outcome to the grant it convicts. A
 *  solid-capture conviction (noteCaptureResult(false) — the 33401f39
 *  corroborated verdict, never one frame alone) is the Screen Recording
 *  grant; calendar-denied is the Calendars (EventKit) grant; the FDA block
 *  is Full Disk Access; the Accessibility block is ax; an Apple Events
 *  denial is Automation (ae). */
export function classifyDenial(source: TccDenialSource): ReGrantKey | null {
  switch (source.kind) {
    case 'calendar-denied': return 'cal';
    case 'solid-capture': return 'sr';
    case 'fda-block': return 'fda';
    case 'ax-block': return 'ax';
    case 'im-block': return 'im';
    case 'automation-denied': return 'ae';
    default: return null;
  }
}

/**
 * Pure: classify a command outcome's error text into the TCC denial it
 * convicts, using EXACT stable markers the owning suites already pin — the
 * 933e6ca4 solid-black-capture hint, the chatdb FDA message, and computer.ts's
 * permissionBlock "Missing macOS permission(s):" line. A text that matches
 * none is not ours to judge (null — never a fabricated denial).
 *
 * 30d3c366: this lives HERE, in the pure leaf module, rather than in
 * index.ts. index.ts is a self-executing entrypoint — its last statement is
 * `main()` — so importing it from a test terminates the test process before a
 * single `test()` registers (the replay suite then "passes" with zero
 * assertions). A pure classifier belongs in the pure module: one place, and
 * testable without the entrypoint.
 */
export function denialFromErrorText(msg: string | null | undefined): TccDenialSource | null {
  if (!msg || typeof msg !== 'string') return null;
  if (/two consecutive captures came back solid-black/i.test(msg)) return { kind: 'solid-capture' };
  if (/Full Disk Access is not granted/i.test(msg)) return { kind: 'fda-block' };
  // The raw chatdb sqlite denial (list_chats/get_messages when FDA is lost):
  // the same marker chatdb.ts checkAccess classifies by.
  if (/unable to open database file|SQLITE_CANTOPEN|operation not permitted/i.test(msg)) return { kind: 'fda-block' };
  // 30d3c366: the Automation denial. `-1743` is macOS's errAEEventNotPermitted
  // ("Not authorized to send Apple events to System Events") — the exact
  // failure a self-update produces when the Automation grant is orphaned. It
  // arrives as `Error: An error occurred: … (-1743)` from the front_window
  // probe and from any System Events / AppleEvent path. Before this branch the
  // text matched nothing, so an Automation loss opened NO episode: the only
  // trace was a soft "capture falls back to pointer → main" log and the
  // operator saw flaky input. `-1743` is also the legacy EventKit denial the
  // calendar classifier handles, so ONLY a text naming System Events / Apple
  // events is convicted as Automation here — the calendar path keeps its own
  // classifier (calendar.ts) and must never be re-attributed by this one.
  if (/-1743/.test(msg) && /system events|apple\s?events?|not authorized to send/i.test(msg)) {
    return { kind: 'automation-denied' };
  }
  if (/^Missing macOS permission\(s\):/m.test(msg)) {
    if (/Accessibility/i.test(msg)) return { kind: 'ax-block' };
    if (/Screen Recording/i.test(msg)) return { kind: 'solid-capture' };
    if (/Automation/i.test(msg)) return { kind: 'automation-denied' };
    if (/Input Monitoring/i.test(msg)) return { kind: 'im-block' };
  }
  return null;
}

/** Pure: the post-update preflight's grant set — the ax/sr/fda regressions
 *  (before-true → now-false against the predecessor's last-advertised
 *  grants, the e2915963 contract: a never-granted permission is the
 *  onboarding flow's gap, not a regression) PLUS the Calendars loss the
 *  advert detector never saw (predecessor cal:true, the status-only
 *  EventKit authorization query now reading a non-readable tier). A null
 *  cal status (the status query itself failed) adds nothing — an unknown
 *  never fabricates a loss. */
export function preflightGrants(
  prev: { ax?: boolean; sr?: boolean; fda?: boolean; cal?: boolean; im?: boolean; ae?: boolean } | null | undefined,
  now: { ax: boolean; sr: boolean; fda: boolean; im?: boolean },
  calNow: boolean | null,
  aeNow: boolean | null = null,
): ReGrantKey[] {
  const out: ReGrantKey[] = [];
  if (prev && typeof prev === 'object') {
    if (prev.ax === true && now.ax === false) out.push('ax');
    if (prev.sr === true && now.sr === false) out.push('sr');
    if (prev.fda === true && now.fda === false) out.push('fda');
    if (prev.cal === true && calNow === false) out.push('cal');
    // 30d3c366: the two grants the ticket actually lost on BOTH Macs, which
    // this comparison could not name — so a post-update Input Monitoring or
    // Automation loss produced NO card at all. Same before-true → now-false
    // rule, and an UNKNOWN reading (undefined / null) contributes nothing:
    // a bridge that cannot answer must never fabricate a grant loss (the
    // c44b19e9 unknown-never-convicts rule).
    if (prev.im === true && now.im === false) out.push('im');
    if (prev.ae === true && aeNow === false) out.push('ae');
  }
  return out;
}

/** The cause line for the post-update preflight: the version transition this
 *  successor observed (the runtime-swap stamp + the agent version), or null
 *  when no swap is pending (a plain relaunch must never masquerade as one —
 *  the e2915963 attribution contract). */
export function preflightCauseFromSwap(
  swap: { swappedAt: string } | null,
  version: string,
): string | null {
  if (!swap) return null;
  return `self-update ${version} swapped the agent binary at ${swap.swappedAt}`;
}

/** The cause token for the runtime watchdog's event (the brief's
 *  classification label, verbatim so the card's copy and the tests agree). */
export const WATCHDOG_CAUSE = 'grant lost after update — needs relaunch + re-grant';
