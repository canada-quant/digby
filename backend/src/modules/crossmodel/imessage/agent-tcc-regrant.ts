/**
 * Agent TCC consolidated re-grant card (ticket c44b19e9, 2026-10-24).
 *
 * THE MISHAP: the agent's self-update swaps its binary tree; macOS TCC keys
 * the Accessibility / Screen Recording / Full Disk Access / Calendars grants
 * to the binary's exact file identity, so the swap silently orphans them.
 * The e2915963 detector (agent-perm-regression.ts) already catches the
 * ax/sr/fda advert flips, but it CANNOT see the Calendars loss (the cal
 * advert only flips after the first DENIED read) and its per-key push names
 * only the toggle-off fix — not the consolidated quit-and-relaunch card the
 * operator rule demands (incident 6f4f8b36: a newly granted permission only
 * applies to a freshly launched process).
 *
 * THE AGENT SIDE (imessage-agent 0.9.9, src/tcc-regrant.ts) runs ONE
 * non-requesting post-update preflight (authorization-status queries only —
 * never a requesting API, the 0.9.8 invariant from ticket 30787bc4) and a
 * runtime grant-loss watchdog fed by real call outcomes (calendar-denied,
 * the 33401f39 corroborated solid-black-capture conviction, the chatdb FDA
 * block). While its grant-loss episode is OPEN, every poll carries the
 * joined grant set as `regrant=cal,sr` (sorted, comma-separated).
 *
 * THIS MODULE: parse that param, decide ONE owner push per episode (Redis
 * dedupe, same discipline as e2915963), and build the push text with the
 * per-grant System Settings pane + the quit-and-relaunch line. Pure where
 * possible — exported for the c44b19e9 suite.
 */

/** The grant keys the re-grant event can carry — the agent-side vocabulary
 *  (tcc-regrant.ts ReGrantKey). One vocabulary, never a drift.
 *
 *  30d3c366: `im` (Input Monitoring) and `ae` (Automation) join LAST. They are
 *  the two grants the owner actually lost on both Macs and neither vocabulary
 *  could name them — so a post-update loss of either produced no card at all.
 *  Appended rather than interleaved so every pre-existing pinned wire form
 *  (`ax,sr,fda,cal`, sorted) is byte-identical. */
export const REGRANT_KEYS = ['ax', 'sr', 'fda', 'cal', 'im', 'ae'] as const;
export type ReGrantKey = (typeof REGRANT_KEYS)[number];

/** Human label per grant (the card's line items) — the exact System Settings
 *  pane titles, so the owner can find the toggle without hunting (30d3c366). */
export const REGRANT_LABELS: Record<ReGrantKey, string> = {
  ax: 'Accessibility',
  sr: 'Screen Recording',
  fda: 'Full Disk Access',
  cal: 'Calendars',
  im: 'Input Monitoring',
  ae: 'Automation',
};

/** The System Settings pane id per grant — the SAME vocabulary the backend's
 *  permissionAction VALID_PANES accepts, extended with the Calendars pane
 *  (Privacy_Calendars) for this surface. The card's per-grant button
 *  dispatches permission_open_pane with these ids. */
export const REGRANT_PANES: Record<ReGrantKey, string> = {
  ax: 'accessibility',
  sr: 'screen-recording',
  fda: 'full-disk-access',
  cal: 'calendars',
  im: 'input-monitoring',
  ae: 'automation',
};

/**
 * Pure: parse the poll's `regrant` query param into the grant set. Accepts
 * the agent's joined form ('cal,sr' — sorted, comma-separated); every token
 * must be a known key, the list deduped; an absent/empty/garbage param is
 * null (no episode open — never fabricates one).
 */
export function parseRegrantParam(raw: unknown): ReGrantKey[] | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const tokens = raw.split(',').map((t) => t.trim()).filter(Boolean);
  if (tokens.length === 0) return null;
  const known = new Set<string>(REGRANT_KEYS);
  for (const t of tokens) {
    if (!known.has(t)) return null; // unknown token — not ours to judge
  }
  const ordered = REGRANT_KEYS.filter((k) => tokens.includes(k));
  return ordered.length > 0 ? [...ordered] : null;
}

/** The episode key for dedupe: the sorted joined grant set — IDENTICAL in
 *  format to the agent-side regrantEpisodeKey (tcc-regrant.ts: sorted,
 *  comma-separated) so the two surfaces share one key vocabulary; the
 *  backend compares only keys it wrote itself, but one format is one fewer
 *  thing to drift. */
export function regrantEpisodeKey(grants: ReGrantKey[]): string {
  return [...new Set(grants)].sort().join(',');
}

/**
 * Pure: the consolidated owner push text. ONE card: names the Mac, lists
 * EVERY lost grant with its System Settings pane, and ends with the
 * quit-and-relaunch instruction (the operator rule — without it the owner
 * re-grants, the card goes green, and the RUNNING process stays blind:
 * the exact 2026-10-24 mbp-1 incident shape).
 */
export function tccReGrantPushText(device: string, grants: ReGrantKey[], cause: string | null): string {
  const lines = grants.map((g) => `• ${REGRANT_LABELS[g]} — System Settings → Privacy & Security → ${REGRANT_LABELS[g]}, find the DigbyAgent entry and turn it ON.`);
  const why = cause ? ` (${cause})` : '';
  return (
    `🔐 Digby Mac permission re-grant needed — ${device}${why}:\n` +
    lines.join('\n') +
    '\n\nThen QUIT and RELAUNCH the Digby agent on that Mac — a newly granted permission only applies to a freshly launched process (until the relaunch the capabilities keep failing).'
  );
}

/**
 * Pure: should the consolidated push fire for this poll? ONE message per
 * episode: a grant-set that differs from the pushed set fires; the SAME set
 * (the episode still open — the agent re-sends it on every poll while the
 * owner is at System Settings) stays deduped.
 */
export function shouldPushReGrant(grants: ReGrantKey[], pushedKeySet: string | null | undefined): boolean {
  if (grants.length === 0) return false;
  return regrantEpisodeKey(grants) !== pushedKeySet;
}

/** T1 (follow-up review): pure covered-guard — does the open consolidated
 *  re-grant episode (this poll's `regrant` param) already cover an
 *  e2915963-seam regression set? When it does, the older per-key push is
 *  suppressed (ONE incident, ONE owner message: the consolidated card,
 *  which names every lost grant incl. Calendars and carries the
 *  quit-and-relaunch line). A partial overlap does NOT suppress — the
 *  uncovered keys keep their e2915963 message. The e2915963 ax/sr/fda
 *  detector itself is untouched: a regression with NO open re-grant episode
 *  (the pre-0.9.9 path — an agent older than 0.9.9, or a flip the watchdog
 *  has not yet convicted) still pushes exactly as before. */
export function regrantCoversRegression(regressed: readonly string[], regrantGrants: ReGrantKey[] | null): boolean {
  if (regressed.length === 0 || !regrantGrants || regrantGrants.length === 0) return false;
  return regressed.every((k) => (regrantGrants as readonly string[]).includes(k));
}

/** The Redis dedupe key for a device's re-grant episode (7-day TTL at the
 *  write site — the e2915963 discipline). */
export function regrantDedupeKey(agentId: string): string {
  return `tcc_regrant:${agentId}`;
}

/**
 * Pure: the cause line for the push — the version transition the poll
 * observed (the e2915963 attribution helper reused), or null. The agent
 * names its own cause for the preflight event; the backend version
 * transition names the swap for the card.
 */
export { versionTransitionCause as regrantVersionCause } from './agent-perm-regression';
