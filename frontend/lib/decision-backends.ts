/**
 * Decision backends — pure helpers behind the "Decision backends" panel on the
 * Model roles section (Account → Admin → Endpoints → Model roles → Decision
 * gate; 2026-09-26, owner: "support the open weight version of jev for testing
 * different decision models … we are self hosting laya now").
 *
 * The panel edits ONE stored row (['instance','decision-gate']/backends via
 * GET/PUT /admin/model-roles/decision-backends): per purpose a PRIMARY backend
 * (the first leg of that purpose's chain; unset = the Decision gate seat's
 * normal chain) and CHALLENGERS (extra backends asked in parallel whose
 * answers only ever land as shadow telemetry rows — they never answer, never
 * act). The readiness job's stored report then carries one entry per
 * (purpose, backend) so the comparison table can rank them on the same labels.
 *
 * CONTRACT (mirrors backend platform/decision-gate-backends.ts, reviewer pass
 * 2026-09-26): a purpose's challenger list is TRI-STATE — `null` (no list of
 * its own → the default challengers apply), `[]` (explicitly NONE, overriding
 * the defaults) or a list. The PUT sends `primary: ''` to clear a primary,
 * `challengers: null` to fall back to the defaults, `challengers: []` for
 * none. The PUT returns the same view as GET; `coerceBackendsView` guards the
 * panel against a backend that returns less (a `{config}` or `{ok}` body must
 * never unmount the section).
 *
 * Everything here is pure (no fetch, no React) so vitest covers the promote /
 * dirty-diff / role-derivation / coercion rules without a DOM.
 */

import type {
  DecisionBackendPurposeView, DecisionBackendsConfig, DecisionBackendsPatch, DecisionBackendsView,
  DecisionReadinessEntry, DecisionReadinessEntryMetrics, EndpointModel,
} from './api/model-endpoints';

/** The exact confirm copy shown before a primary change on an act purpose
 *  (plan item G — the backend drops the purpose to shadow on that PUT). */
export const PROMOTE_CONFIRM_COPY = 'act drops to shadow until the readiness job re-stamps this backend (≤6 h)';

export interface PurposeBackendsDraft {
  /** '' = no primary of its own — the Decision gate seat's chain answers. */
  primary: string;
  /** The purpose's OWN challenger list: null = none of its own (the default
   *  challengers apply); [] = explicitly NONE (overrides the defaults); else the list. */
  challengers: string[] | null;
}

export interface BackendsDraft {
  purposes: Record<string, PurposeBackendsDraft>;
  defaultChallengers: string[];
}

const uniq = (xs: ReadonlyArray<string>): string[] => Array.from(new Set(xs.filter(x => typeof x === 'string' && x.length > 0)));
const sameList = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean => {
  const x = uniq(a); const y = uniq(b);
  return x.length === y.length && x.every((v, i) => v === y[i]);
};
/** Tri-state equality for a purpose's own challenger list (null ≠ [] ≠ list). */
const sameChallengers = (a: ReadonlyArray<string> | null | undefined, b: ReadonlyArray<string> | null | undefined): boolean => {
  const aNull = a === null || a === undefined;
  const bNull = b === null || b === undefined;
  if (aNull || bNull) return aNull === bNull;
  return sameList(a, b);
};

/**
 * Human labels for decision-gate purposes, used ONLY as the fallback when the
 * backend's view row carries no `label` (a backend older than the purpose, or
 * a bare string[] contract). The backend registry (platform/decision-gate-
 * modes.ts DECISION_PURPOSES) is the source of truth and wins whenever it
 * sends a label; this map keeps the admin tables readable across a mixed
 * blue/green wave. The three compute-policy purposes (2026-09-26) are listed
 * first — they render as "Compute policy" / "Drafts agree" / "Revision
 * material" the moment a backend reports them, label or not.
 */
export const DECISION_PURPOSE_LABELS: Readonly<Record<string, string>> = {
  compute_policy: 'Compute policy',
  drafts_agree: 'Drafts agree',
  revision_material: 'Revision material',
  wake_triage: 'Supervisor wake triage',
  delta_material: 'Schedule delta materiality',
  auto_route: 'Auto patience router',
  imessage_send: 'iMessage send intent',
  browser_driver: 'Browser driver choice',
  memory_extract: 'Memory-extraction gate',
  self_audit: 'Coding self-audit gate',
  guard_strike: 'Guard-strike adjudication',
  sweep_triage: 'Supervisor sweep pre-triage',
  checker_route: 'Level 2 checker placement',
  coding_memory_fold: 'Coding-memory fold gate',
  reflection_route: 'Reflection route pre-choice',
  claim_evidenced: 'Action-verifier claim evidence',
  drain_triage: 'Agent-message drain triage',
  firing_superseded: 'Superseded-firing gate',
  tool_intent: 'Tool-intent attribution',
  wake_effort: 'Machine-wake reasoning effort',
  // 2026-09-27 / 2026-10-03 purposes the map had missed (same labels as the backend registry rows).
  supervisor_turn_noop: 'Supervisor turn pre-triage (sweep + drain)',
  session_topology: 'Session topology (spawn / reuse / merge / retire)',
  turn_plan: 'Turn plan (dynamic roster)',
  // Task-aware model pick (2026-10-20): a pure evidence key — no gate act consumer.
  task_kind: 'Task kind',
};

/** The label to show for a purpose: the backend's own label when it sent one
 *  (non-blank), else the client fallback map, else the raw key. */
export function purposeLabelFor(purpose: string, backendLabel?: string | null): string {
  const fromBackend = typeof backendLabel === 'string' ? backendLabel.trim() : '';
  if (fromBackend) return fromBackend;
  return DECISION_PURPOSE_LABELS[purpose] ?? purpose;
}

/** The purpose KEYS of a view's `purposes` list — the backend sends view
 *  objects (`{ purpose, label, … }`); a bare string[] (an older contract) and
 *  a missing list are tolerated. Order preserved, deduped, blanks dropped. */
export function purposeKeys(purposes: ReadonlyArray<DecisionBackendPurposeView | string> | null | undefined): string[] {
  const out: string[] = [];
  for (const p of purposes ?? []) {
    const key = typeof p === 'string' ? p : (p && typeof p === 'object' && typeof p.purpose === 'string' ? p.purpose : '');
    if (key && !out.includes(key)) out.push(key);
  }
  return out;
}

/** The view object for one purpose, when the backend sent objects. */
export function purposeView(purposes: ReadonlyArray<DecisionBackendPurposeView | string> | null | undefined, purpose: string): DecisionBackendPurposeView | null {
  for (const p of purposes ?? []) {
    if (p && typeof p === 'object' && p.purpose === purpose) return p;
  }
  return null;
}

/** The editable draft for every listed purpose (purposes the config does not
 *  mention get an empty row so the table stays complete). `purposes` may be
 *  the view's object list, a string[] or absent. */
export function draftFromConfig(
  config: DecisionBackendsConfig | null | undefined,
  purposes?: ReadonlyArray<DecisionBackendPurposeView | string> | null,
): BackendsDraft {
  const out: BackendsDraft = { purposes: {}, defaultChallengers: uniq(config?.defaultChallengers ?? []) };
  const keys = uniq([...purposeKeys(purposes), ...Object.keys(config?.purposes ?? {})]);
  for (const p of keys) {
    const row = config?.purposes?.[p];
    out.purposes[p] = { primary: row?.primary ?? '', challengers: Array.isArray(row?.challengers) ? uniq(row.challengers) : null };
  }
  return out;
}

/** The spec that answers a purpose FIRST: its configured primary, else the
 *  Decision gate seat's effective model (the seat chain's head). */
export function effectivePrimarySpec(config: DecisionBackendsConfig | null | undefined, purpose: string, seatEffective: string): string {
  return config?.purposes?.[purpose]?.primary || seatEffective || '';
}

/** The challengers a purpose runs: its own list when it HAS one (an explicit
 *  `[]` means none), else the defaults — the backend's `own ?? defaultChallengers`. */
export function effectiveChallengers(config: DecisionBackendsConfig | null | undefined, purpose: string): string[] {
  const own = config?.purposes?.[purpose]?.challengers;
  return Array.isArray(own) ? uniq(own) : uniq(config?.defaultChallengers ?? []);
}

/** The numbers of a report entry: today's backend nests them under `metrics`;
 *  a flat entry (the REST contract's shorthand) is tolerated. null when the
 *  entry carries no `n` at all. */
export function readinessEntryMetrics(entry: DecisionReadinessEntry | null | undefined): DecisionReadinessEntryMetrics | null {
  if (!entry) return null;
  const m = (entry.metrics ?? (entry as unknown as Partial<DecisionReadinessEntryMetrics>)) as Partial<DecisionReadinessEntryMetrics>;
  if (typeof m?.n !== 'number') return null;
  return {
    n: m.n,
    days: m.days,
    accuracy: Number(m.accuracy),
    brier: Number(m.brier),
    ece: Number(m.ece),
    auroc: Number(m.auroc),
    coverageAt5: m.coverageAt5 ?? { coverage: NaN, threshold: null, n: 0, errors: 0 },
    actBand: m.actBand ?? { n: 0, correct: 0, precision: NaN, coverage: NaN, threshold: NaN },
    positives: m.positives,
    negatives: m.negatives,
    calls: typeof m.calls === 'number' ? m.calls : undefined,
    failRate: typeof m.failRate === 'number' ? m.failRate : undefined,
    p50Ms: typeof m.p50Ms === 'number' ? m.p50Ms : undefined,
    p95Ms: typeof m.p95Ms === 'number' ? m.p95Ms : undefined,
  };
}

/** The key that identifies an entry's backend: its spec when the report
 *  carries one, else the label (pre-2026-09-26 reports). */
export function entryBackendKey(entry: Pick<DecisionReadinessEntry, 'backend' | 'backendSpec'>): string {
  return entry.backendSpec || entry.backend;
}

/** Which seat a report entry's backend holds in its purpose's chain: the
 *  report's own `role` when present, else derived from the stored config +
 *  the seat's effective model (a spec-less entry cannot be placed → null). */
export function backendRoleFor(
  entry: Pick<DecisionReadinessEntry, 'purpose' | 'backend' | 'backendSpec' | 'role'>,
  config: DecisionBackendsConfig | null | undefined,
  seatEffective: string,
): 'primary' | 'challenger' | 'fallback' | null {
  if (entry.role === 'primary' || entry.role === 'challenger' || entry.role === 'fallback') return entry.role;
  const spec = entry.backendSpec;
  if (!spec) return null;
  if (spec === effectivePrimarySpec(config, entry.purpose, seatEffective)) return 'primary';
  if (effectiveChallengers(config, entry.purpose).includes(spec)) return 'challenger';
  return 'fallback';
}

/** The PUT body for what the draft changed — ONLY the purposes whose primary
 *  or own challenger list differs, plus defaultChallengers when they differ.
 *  `primary: ''` clears; `challengers: null` drops the own list (defaults
 *  apply); `challengers: []` = explicitly none. null when nothing changed. */
export function dirtyBackendPatch(config: DecisionBackendsConfig | null | undefined, draft: BackendsDraft): DecisionBackendsPatch | null {
  const patch: DecisionBackendsPatch = {};
  for (const [p, row] of Object.entries(draft.purposes)) {
    const cur = config?.purposes?.[p];
    const primaryDirty = (row.primary ?? '') !== (cur?.primary ?? '');
    const curChallengers = Array.isArray(cur?.challengers) ? cur.challengers : null;
    const challengersDirty = !sameChallengers(row.challengers, curChallengers);
    if (!primaryDirty && !challengersDirty) continue;
    patch.purposes = patch.purposes ?? {};
    patch.purposes[p] = {
      ...(primaryDirty ? { primary: row.primary ?? '' } : {}),
      ...(challengersDirty ? { challengers: row.challengers === null || row.challengers === undefined ? null : uniq(row.challengers) } : {}),
    };
  }
  if (!sameList(draft.defaultChallengers ?? [], config?.defaultChallengers ?? [])) patch.defaultChallengers = uniq(draft.defaultChallengers ?? []);
  return patch.purposes || patch.defaultChallengers ? patch : null;
}

/** "Promote to primary" (plan item D): the challenger becomes the primary and
 *  the previous effective primary joins the purpose's OWN challenger list
 *  (old challengers − spec ∪ [old primary]), so the comparison keeps both.
 *  null when `spec` already is the effective primary. */
export function promotePatch(config: DecisionBackendsConfig | null | undefined, purpose: string, spec: string, seatEffective: string): DecisionBackendsPatch | null {
  const prev = effectivePrimarySpec(config, purpose, seatEffective);
  if (!spec || spec === prev) return null;
  const challengers = uniq([...effectiveChallengers(config, purpose).filter(c => c !== spec), ...(prev ? [prev] : [])]);
  return { purposes: { [purpose]: { primary: spec, challengers } } };
}

/** The purposes a patch changes the primary of WHILE they run in act — the
 *  ones the backend will drop to shadow on save (the confirm dialog names them). */
export function primaryChangesOnActPurposes(
  config: DecisionBackendsConfig | null | undefined,
  patch: DecisionBackendsPatch | null | undefined,
  effectiveModes: Record<string, string | undefined>,
): string[] {
  const out: string[] = [];
  for (const [p, row] of Object.entries(patch?.purposes ?? {})) {
    if (row.primary === undefined) continue;
    if ((row.primary ?? '') === (config?.purposes?.[p]?.primary ?? '')) continue;
    if (effectiveModes[p] === 'act') out.push(p);
  }
  return out;
}

/** True when `x` is a complete decision-backends view: a `config` object with
 *  a `purposes` record, a `candidates` array and a `purposes` list. The PUT
 *  contract says the backend returns the GET view; this is the check, not a trust. */
export function isDecisionBackendsView(x: unknown): x is DecisionBackendsView {
  if (!x || typeof x !== 'object') return false;
  const v = x as Partial<DecisionBackendsView>;
  return !!v.config && typeof v.config === 'object' && !!v.config.purposes && typeof v.config.purposes === 'object'
    && Array.isArray(v.candidates) && Array.isArray(v.purposes);
}

/** The view to render after a PUT: the response itself when it is a full view;
 *  otherwise the previous view with whatever complete parts the response
 *  carried (`config`, `candidates`, `purposes`) merged over it. Never throws,
 *  never yields a view without candidates / purposes — a `{ok:true}` body
 *  leaves the panel exactly as it was (the caller may then re-GET). */
export function coerceBackendsView(prev: DecisionBackendsView, raw: unknown): DecisionBackendsView {
  if (isDecisionBackendsView(raw)) return raw;
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<DecisionBackendsView>;
  return {
    ...prev,
    ...r,
    config: r.config && typeof r.config === 'object' && r.config.purposes && typeof r.config.purposes === 'object' ? r.config : prev.config,
    candidates: Array.isArray(r.candidates) ? r.candidates : prev.candidates,
    purposes: Array.isArray(r.purposes) ? r.purposes : prev.purposes,
  };
}

/** The decision-backend endpoint-model fields ([calibrated], max state chars)
 *  that a save SENT but the backend did not ECHO — an older backend's zod
 *  schema / whitelist drops them silently (plan item A adds them). Named for
 *  the toast; [] when nothing was dropped or nothing was echoed at all.
 *  Ticket bd51693b: imageTimeoutMs joined the guard list — the exact defect
 *  class this catches (admin saved, 200 returned, value gone on reload, no
 *  warning because the list wasn't extended) cost a full debug cycle on the
 *  04c8ffd1 image-timeout ticket. */
export function strippedDecisionFields(
  sent: ReadonlyArray<Pick<EndpointModel, 'id' | 'calibrated' | 'maxStateChars' | 'decision' | 'imageTimeoutMs'>>,
  saved: ReadonlyArray<Pick<EndpointModel, 'id' | 'calibrated' | 'maxStateChars' | 'decision' | 'imageTimeoutMs'>> | null | undefined,
): string[] {
  if (!Array.isArray(saved)) return [];
  const out: string[] = [];
  const add = (name: string) => { if (!out.includes(name)) out.push(name); };
  for (const m of sent) {
    const echo = saved.find(s => s.id === m.id);
    if (!echo) continue;
    if (m.calibrated === true && echo.calibrated !== true) add('[calibrated]');
    if (typeof m.maxStateChars === 'number' && m.maxStateChars > 0 && echo.maxStateChars !== m.maxStateChars) add('max state chars');
    // Laya follow-up (2026-09-26): the [typed decisions] flag — an older backend's whitelist drops it silently too.
    if (m.decision === 'systemone_chat' && echo.decision !== 'systemone_chat') add('[typed decisions]');
    // bd51693b: the per-model image timeout (04c8ffd1) — a positive number the
    // backend did not echo back was silently stripped, not clamped.
    if (typeof m.imageTimeoutMs === 'number' && m.imageTimeoutMs > 0 && echo.imageTimeoutMs !== m.imageTimeoutMs) add('image timeout');
  }
  return out;
}

/** Table cell formatting — NaN / null / undefined render as "n/a", never "NaN". */
export function fmtMetric(v: number | null | undefined, digits = 3): string {
  return typeof v === 'number' && Number.isFinite(v) ? v.toFixed(digits) : 'n/a';
}

export function fmtPercent(v: number | null | undefined, digits = 0): string {
  return typeof v === 'number' && Number.isFinite(v) ? `${(v * 100).toFixed(digits)}%` : 'n/a';
}

export function fmtMs(v: number | null | undefined): string {
  return typeof v === 'number' && Number.isFinite(v) ? `${Math.round(v)} ms` : 'n/a';
}
