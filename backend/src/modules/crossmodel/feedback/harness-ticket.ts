/**
 * HARNESS tickets about another account's chat (audit 2026-10-08 W5-1b — the
 * follow-up to the owner-only ticket autonomy fix 7d6b6e09).
 *
 * The incident: the action verifier auto-filed mishap 7cabb0cc about an
 * EXTERNAL account's chat. The ticket was stored under that account's user id
 * with a verbatim 1,500-char excerpt of the assistant's answer to them, so
 * (1) the external user saw an internal "Phantom action claim … (chat …)"
 * ticket in their own Feedback tab, and (2) the excerpt travelled into a
 * framework lane's brief and from there into a repo test fixture.
 *
 * A HARNESS ticket is one the framework files about a run, never a person:
 * its context carries a detector stamp — `verifier` (action-verifier,
 * evidence-guard …) or `class` (provider_billing, seat_capability_rejection,
 * news_fetch_breaker …). The same stamp is what the filer binding already
 * reads as `harness_filed` (platform-tools.ts filerBindingVerdict).
 *
 * Two rules, both deterministic:
 *  - CONTENT: when the subject account (the ticket's userId) is NOT an admin
 *    account, the description stored is SHAPE-ONLY — the defect title, the
 *    detector, the ids it cites and (when the filer supplies one) a harness-
 *    written shape line — never verbatim text from that chat. Kill switch
 *    FEEDBACK_HARNESS_SUBJECT_REDACT_DISABLED=1 (the full description is stored,
 *    as before).
 *  - VISIBILITY: a harness ticket is never listed in a NON-admin user's own
 *    Feedback tab (GET /feature-requests) — it is an internal framework record,
 *    not something they filed. Admins keep seeing every row (admin list, and
 *    their own tab). Kill switch FEEDBACK_HARNESS_HIDE_FROM_SUBJECT_DISABLED=1.
 *
 * LEAF: pure helpers only (no prisma, no logger) — the service and the
 * controller do the I/O.
 */

const onFlag = (v: unknown): boolean => /^(1|true|on|yes)$/i.test(String(v ?? '').trim());

export function harnessSubjectRedactDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return onFlag(env.FEEDBACK_HARNESS_SUBJECT_REDACT_DISABLED);
}

export function harnessHideFromSubjectDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return onFlag(env.FEEDBACK_HARNESS_HIDE_FROM_SUBJECT_DISABLED);
}

const ctxObj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

const stamp = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** True when the ticket context carries a harness detector stamp (`verifier` or `class`). Pure. */
export function isHarnessTicketContext(context: unknown): boolean {
  const c = ctxObj(context);
  return !!stamp(c.verifier) || !!stamp(c.class);
}

/** A stored row is a harness ticket: agent-sourced AND detector-stamped. Pure. */
export function isHarnessTicketRow(row: { source?: string | null; context?: unknown }): boolean {
  return row?.source === 'agent' && isHarnessTicketContext(row?.context);
}

/**
 * Should this row be hidden from the requesting user's own Feedback tab?
 * Admins see everything; a non-admin never sees a harness ticket.
 */
export function hiddenFromSubjectTab(row: { source?: string | null; context?: unknown }, requesterIsAdmin: boolean, env: NodeJS.ProcessEnv = process.env): boolean {
  if (requesterIsAdmin || harnessHideFromSubjectDisabled(env)) return false;
  return isHarnessTicketRow(row);
}

const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const HEX_ID_RE = /\b(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{8,40}\b/gi;

/** The ids a text cites — full uuids first, then bare hex ids (8–40 chars, letters AND digits), de-duplicated, capped. Pure. */
export function idsCitedIn(text: unknown, max = 20): string[] {
  const s = String(text ?? '');
  const out: string[] = [];
  const push = (id: string) => {
    const low = id.toLowerCase();
    if (out.some((o) => o === low || o.startsWith(low) || low.startsWith(o))) return;
    out.push(low);
  };
  for (const m of s.matchAll(UUID_RE)) { push(m[0]); if (out.length >= max) return out; }
  const withoutUuids = s.replace(UUID_RE, ' ');
  for (const m of withoutUuids.matchAll(HEX_ID_RE)) { push(m[0]); if (out.length >= max) return out; }
  return out;
}

export const SHAPE_ONLY_HEADER =
  '[Shape-only harness ticket — the run it describes belongs to another account, so this ticket stores no verbatim text from that chat: the defect, the detector and the ids only (audit 2026-10-08 W5-1b). An admin reads the chat itself if the content is needed.]';

/** SHARED-PROJECT-DISPATCH (2026-10-20): the header of an AUTO-APPROVED supervisor platform ticket from another account. */
export const SUPERVISOR_SHAPE_ONLY_HEADER =
  '[Shape-only ticket — filed by a supervisor seat on another account and auto-approved for a ticket lane, so it stores no free text from that account: the defect title, the filer seat and the ids only (shared-project dispatch, 2026-10-20). An admin reads the filing chat itself if the content is needed.]';

/**
 * The SHAPE-ONLY description stored for a harness ticket about another
 * account's chat. `shape` is an optional harness-written line (e.g. the action
 * verifier's claim kinds + cited ids) — it must itself carry no chat text.
 * Pure.
 */
export function shapeOnlyDescription(input: {
  title: string; description: string; context: unknown; shape?: string | null;
  /** SHARED-PROJECT-DISPATCH (2026-10-20): a non-detector filer (a supervisor seat) names itself; default = the detector stamp. */
  detector?: string | null;
  /** SHARED-PROJECT-DISPATCH: a header for a non-harness shape-only row; default = SHAPE_ONLY_HEADER. */
  header?: string | null;
}): string {
  const c = ctxObj(input.context);
  const detector = String(input.detector ?? '').trim() || stamp(c.verifier) || stamp(c.class) || 'harness';
  const where = [
    stamp(c.surface) ? `surface ${stamp(c.surface)}` : '',
    stamp(c.sessionId) ? `subject chat ${stamp(c.sessionId).slice(0, 8)}` : '',
    stamp(c.runId) ? `run ${stamp(c.runId).slice(0, 8)}` : '',
  ].filter(Boolean).join(' · ');
  const ids = idsCitedIn(input.description);
  const lines = [
    String(input.header ?? '').trim() || SHAPE_ONLY_HEADER,
    '',
    `Defect: ${String(input.title ?? '').trim()}`,
    `Detector: ${detector}${where ? ` · ${where}` : ''}`,
  ];
  const shape = String(input.shape ?? '').trim();
  if (shape) lines.push(`Shape: ${shape.slice(0, 1500)}`);
  lines.push(`Ids referenced: ${ids.length ? ids.join(', ') : 'none'}`);
  return lines.join('\n').slice(0, 8000);
}
