/**
 * Seats govern sessions (owner 2026-09-28: "even though I changed the endpoint
 * settings for supervisors and agents in admin endpoints … many sessions didn't
 * change … update everything to my UI settings").
 *
 * Before this module a coding session's model was STAMPED at creation
 * (coding_sessions.model) and, unless the project carried a codingModel
 * override, the stamp was the run-time authority — so re-seating the
 * "Workspace default" (coding_default) in Account → Admin → Endpoints → Model
 * roles changed NOTHING for the sessions already alive. Worse, the
 * UserPreferences.codingModel column DEFAULTED to "glm-5.2" for every user and
 * resolveStampedCodingModel treated any resolvable pref as a deliberate pick,
 * so the seat never applied to a NEW session either (every user has a
 * preference row). The owner re-pointed 55 sessions by hand; this makes that
 * unnecessary.
 *
 * ONE resolver — resolveGoverningCodingModel — used at stamping time
 * (coding-data.service resolveStampedCodingModel) AND at run time
 * (run-executor), so new and existing sessions agree. Precedence:
 *
 *   1. 'explicit'   — the session's own pick (modelSource 'spawn-param' from
 *                     start_coding_session {model}, or 'explicit' from
 *                     set_session_model / PUT /coding/sessions/:id {model});
 *   2. 'project'    — the project's codingModel override set by a HUMAN (the
 *                     side-panel picker / REST). A MACHINE-written override
 *                     (update_project from a lane or supervisor on a machine
 *                     turn — settings.codingModelSource 'machine') never
 *                     shadows the seat; a legacy override with no provenance
 *                     applies (the apply-seats action clears the built-in ones);
 *   3. 'preference' — the user's Account → Coding pick, ONLY when the user set
 *                     it themselves: the context-store marker
 *                     ['user',<id>,'coding-prefs']/codingModelExplicit names
 *                     the CURRENT stored value (fail-CLOSED: no marker = not a
 *                     pick; the schema default "glm-5.2" and '' are never picks);
 *   4. 'seat'       — the coding_default SEAT resolved LIVE at run time;
 *   5. 'stamp'      — the stored coding_sessions.model as the last-resort
 *                     RECORD of what ran (seat unresolvable).
 *
 * A stamp with modelSource NULL is a RECORD, never the authority. The run's
 * init event / run_spend meta carry the governing `modelSource` so the API
 * costs panel can show what governed.
 *
 * Leaf: dynamic imports only (the run-executor test suite mocks the modules
 * this reaches). Kill switch SEAT_GOVERNS_SESSIONS_DISABLED=1 restores the
 * pre-2026-09-28 stamp authority byte-for-byte (project override → stamp at
 * run time; project → any resolvable pref → seat at stamping time).
 */

export const SEAT_GOVERNS_SESSIONS_DISABLED_ENV = 'SEAT_GOVERNS_SESSIONS_DISABLED';

/** What governed the model of a run / a stamp. */
export type ModelGovernor = 'explicit' | 'project' | 'preference' | 'seat' | 'stamp';

/** Context-store namespace + key that records a DELIBERATE coding-model preference
 *  (mirrors platform/human-spawn.ts permissionModeExplicit). */
export const CODING_PREFS_STORE_NS = (userId: string): string[] => ['user', userId, 'coding-prefs'];
export const CODING_MODEL_EXPLICIT_KEY = 'codingModelExplicit';

/** The historical Prisma column default — a stored value equal to it is NEVER a pick. */
export const CODING_MODEL_SCHEMA_DEFAULT = 'glm-5.2';

/** The built-in fallback when nothing else resolves (the coding_default seat's own default). */
export const CODING_SEAT_FALLBACK_MODEL = 'glm-5.3';

/** The session-stamp provenances that are the session's OWN pick. */
export const EXPLICIT_MODEL_SOURCES: ReadonlySet<string> = new Set(['spawn-param', 'explicit']);

export interface CodingModelExplicitRecord {
  model: string;
  at: string;
  via: string;
}

export interface GoverningModelDecision {
  model: string;
  source: ModelGovernor;
  /** One line for the log / envelope — why this source won (never secrets). */
  detail: string;
}

export function seatGovernsSessionsDisabled(): boolean {
  const v = String(process.env[SEAT_GOVERNS_SESSIONS_DISABLED_ENV] ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

/** True when a stored preference VALUE could be a pick at all (non-empty, not the schema default). Pure. */
export function isCodingModelPickValue(value: string | null | undefined): boolean {
  const v = typeof value === 'string' ? value.trim() : '';
  return !!v && v !== CODING_MODEL_SCHEMA_DEFAULT;
}

/** True when a session stamp is the session's OWN pick (spawn-param / explicit). Pure. */
export function isExplicitModelSource(modelSource: string | null | undefined): boolean {
  return typeof modelSource === 'string' && EXPLICIT_MODEL_SOURCES.has(modelSource);
}

/**
 * Record that the user set their codingModel THEMSELVES (Account → Coding save /
 * set_preferences on a live user turn). A value that cannot be a pick ('' or
 * the schema default) CLEARS the marker instead. Best-effort, never throws.
 */
export async function markCodingModelExplicit(userId: string, model: string | null | undefined, via: string): Promise<void> {
  if (!userId) return;
  try {
    const store = await import('../memory/context-store');
    if (!isCodingModelPickValue(model)) {
      await store.storeDelete(CODING_PREFS_STORE_NS(userId), CODING_MODEL_EXPLICIT_KEY).catch(() => {});
      return;
    }
    const record: CodingModelExplicitRecord = { model: String(model).trim(), at: new Date().toISOString(), via: String(via || 'settings') };
    await store.storePut(CODING_PREFS_STORE_NS(userId), CODING_MODEL_EXPLICIT_KEY, record as unknown as Record<string, unknown>);
  } catch { /* the marker is a courtesy — a store hiccup never fails a preference write */ }
}

/**
 * TRUE when the user's stored codingModel was set by them: the explicit marker
 * exists AND names the CURRENT stored value. Fail-CLOSED (false) on any read
 * error or for a value that cannot be a pick.
 */
export async function isCodingModelExplicit(userId: string, currentPref: string | null | undefined): Promise<boolean> {
  if (!userId || !isCodingModelPickValue(currentPref)) return false;
  try {
    const store = await import('../memory/context-store');
    const rec = await store.storeGet<CodingModelExplicitRecord>(CODING_PREFS_STORE_NS(userId), CODING_MODEL_EXPLICIT_KEY);
    return !!rec && typeof rec === 'object' && typeof rec.model === 'string' && rec.model.trim() === String(currentPref).trim();
  } catch {
    return false;
  }
}

/** The instance's coding_default SEAT, resolved live (fail-open to the built-in). */
export async function resolveCodingSeatModel(): Promise<string> {
  try {
    const { resolveRoleModelForRun } = await import('./coding-model');
    return (await resolveRoleModelForRun('coding_default', CODING_SEAT_FALLBACK_MODEL)) || CODING_SEAT_FALLBACK_MODEL;
  } catch {
    return CODING_SEAT_FALLBACK_MODEL;
  }
}

export interface GoverningModelInput {
  userId: string;
  projectId?: string | null;
  /** The stored coding_sessions.model (run time) — absent at stamping time. */
  stampedModel?: string | null;
  /** The stored coding_sessions.modelSource (run time). */
  modelSource?: string | null;
  /** The user's stored codingModel when the caller already loaded it; undefined = load it here. */
  storedPref?: string | null;
}

/**
 * THE resolver (precedence in the file header). Never throws: every step is
 * fail-open to the next, and the last step always answers.
 */
export async function resolveGoverningCodingModel(input: GoverningModelInput): Promise<GoverningModelDecision> {
  const userId = String(input.userId || '');
  const stamped = typeof input.stampedModel === 'string' && input.stampedModel.trim() ? input.stampedModel.trim() : '';

  // 1. The session's own pick.
  if (stamped && isExplicitModelSource(input.modelSource)) {
    return { model: stamped, source: 'explicit', detail: `session pick (${input.modelSource})` };
  }

  // 2. A HUMAN-set project override (legacy no-provenance overrides apply).
  if (input.projectId) {
    try {
      const data = await import('./coding-data.service');
      const pick = await data.projectCodingModel(input.projectId);
      if (pick) {
        let provenance: string | null = null;
        try { provenance = await data.projectCodingModelSource(input.projectId); } catch { provenance = null; }
        if (provenance === 'machine') {
          // A lane / supervisor wrote it on a machine turn — the admin seat governs.
        } else {
          const resolved = await data.resolveOneCodingPick(pick, userId);
          if (resolved) return { model: resolved, source: 'project', detail: `project codingModel "${pick}"${provenance ? ` (${provenance})` : ''}` };
        }
      }
    } catch { /* fail-open to the preference */ }
  }

  // 3. The user's OWN preference (explicit marker required).
  try {
    let pref = input.storedPref;
    if (pref === undefined) {
      const prisma = (await import('../../../config/database')).default;
      const row = await prisma.userPreferences.findUnique({ where: { userId }, select: { codingModel: true } });
      pref = row?.codingModel ?? null;
    }
    if (isCodingModelPickValue(pref) && await isCodingModelExplicit(userId, pref)) {
      const data = await import('./coding-data.service');
      const resolved = await data.resolveOneCodingPick(pref, userId);
      if (resolved) return { model: resolved, source: 'preference', detail: `Account → Coding pick "${String(pref).trim()}"` };
    }
  } catch { /* fail-open to the seat */ }

  // 4. The seat, live.
  try {
    const { resolveRoleModelForRun } = await import('./coding-model');
    const seat = await resolveRoleModelForRun('coding_default', CODING_SEAT_FALLBACK_MODEL);
    if (seat) return { model: seat, source: 'seat', detail: 'coding_default seat' };
  } catch { /* fail-open to the stamp */ }

  // 5. The record.
  return { model: stamped || CODING_SEAT_FALLBACK_MODEL, source: 'stamp', detail: stamped ? 'stored session model (seat unresolvable)' : 'built-in default (seat unresolvable)' };
}
