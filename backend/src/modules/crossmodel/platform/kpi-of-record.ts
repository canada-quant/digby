/**
 * KPI OF RECORD (tt-rd audit 2026-09-27, "kpi-honesty-loops" findings 1, 2, 4, 5).
 *
 * Why: over 14 days the tt-rd project supervisor reported THREE different
 * figures to the owner as "the" serving rate — 7.3 tok/s (1000 / a 138 ms
 * read_wait timer, retracted 90 min later), 6.56 tok/s ("of record" — decode-
 * phase arithmetic on the same 12.6 s probe print) and 5.08 tok/s (the only
 * client-visible end-to-end number) — while the register's single mutable
 * premise slot flapped 5.364 → 2.464 → 5.08 in 14 h (a diagnostic-window
 * reading overwrote the KPI) and the Fleet Supervisor copied the momentary
 * value into free-text state and owner answers that then went stale. Owner
 * (msg d9d15a6b): "what is the truth now.. serving 4toks or serving 7 toks?".
 *
 * What this LEAF module is (imports nothing from the services — the board
 * renderer, the state formatter, the status card, the brief, the premise
 * validator and chat-agent's reply finalize all read it):
 *  - the `kpi:` key convention: a goal with a numeric bar carries exactly ONE
 *    premise whose key starts with `kpi:` (or `kind:'kpi'`); its value is set
 *    ONLY from a run_command receipt id (premise-register.ts refuses a KPI
 *    without one — deterministic and cheap, so it may refuse; every other
 *    gate here is observe-only);
 *  - pure renderers: the board line
 *    `KPI client_visible_e2e_tok_s=5.08 tok/s (receipt f5b42fe6 · 2h ago · bar ≥10) · last change 5.364→2.464 @03:34Z`,
 *    the state-doc annotation `[register now: …]`, the status-card row and the
 *    reply footer `(KPI of record: …)`;
 *  - the deterministic "typed rate" miner: `<number> <kpi unit>` mentions in a
 *    note / answer that differ from the register value.
 *
 * Env knobs (read at call time; docs: .env.example):
 *  ADOPTION_LADDER_K / _HOURS      the ladder thresholds (8 / 48) — read here so the doctrine budget matches the wake
 */

export const KPI_KEY_PREFIX = 'kpi:';
/** Adoption-ladder thresholds live HERE (a leaf) so the harness wake (adoption-ladder.ts)
 *  and the doctrine's per-lever budget (supervisor-doctrine.ts) read the SAME numbers —
 *  fixer follow-up 3c (the prompt said 6 firings / 24 h while the harness tripped at 8 / 48). */
export const ADOPTION_LADDER_K_ENV = 'ADOPTION_LADDER_K';
export const ADOPTION_LADDER_HOURS_ENV = 'ADOPTION_LADDER_HOURS';
const envInt = (name: string, dflt: number): number => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
};
/** Completed work sessions since the last receipted KPI move that trip a [NO-ADOPTION] wake — and the budget per lever the doctrine names. */
export const adoptionLadderK = (): number => envInt(ADOPTION_LADDER_K_ENV, 8);
/** Hours since the last receipted KPI move that trip a [NO-ADOPTION] wake (only with ≥ 1 completed experiment in the window). */
export const adoptionLadderHours = (): number => envInt(ADOPTION_LADDER_HOURS_ENV, 48);

/** One historical value of a premise (the ring premise-register keeps on value change). */
export interface PremiseValueStamp {
  value: number;
  setAt?: string;
  receiptId?: string;
}

/** The subset of a GoalPremise the KPI surfaces read (structural — premise-register.ts owns the full shape). */
export interface KpiPremiseLike {
  key: string;
  value: number;
  unit?: string;
  kind?: string;
  bar?: number;
  /** Ticket 9fcd69ca: declared bar direction ('up' floor / 'down' ceiling) — honored by kpiBarDirection/kpiBarMet/kpiBarText; absent ⇒ inferred. */
  barDirection?: string;
  receiptId?: string;
  setAt?: string;
  note?: string;
  prev?: PremiseValueStamp;
  history?: PremiseValueStamp[];
}

/** A KPI premise resolved to its goal/project — what the card, brief, state and footer consume. */
export interface KpiView extends KpiPremiseLike {
  goalId: string;
  projectId: string;
  goalTitle?: string;
}

/** Read stored premises JSON back (tolerant of legacy/garbage rows) — the pure twin of premise-register's readPremises, for leaf consumers. */
export function readPremisesLoose(json: unknown): KpiPremiseLike[] {
  if (!Array.isArray(json)) return [];
  return (json as any[])
    .filter((p) => p && typeof p === 'object' && typeof p.key === 'string' && Number.isFinite(Number(p.value)))
    .map((p) => ({ ...p, value: Number(p.value) }));
}

/** `kpi:`-prefixed key or kind:'kpi'. */
export function isKpiPremise(p: unknown): p is KpiPremiseLike {
  if (!p || typeof p !== 'object') return false;
  const key = String((p as any).key ?? '');
  return (p as any).kind === 'kpi' || key.toLowerCase().startsWith(KPI_KEY_PREFIX);
}

/** The key without its `kpi:` prefix — what the board/card print. */
export function kpiBareKey(key: string): string {
  const k = String(key ?? '');
  return k.toLowerCase().startsWith(KPI_KEY_PREFIX) ? k.slice(KPI_KEY_PREFIX.length) : k;
}

/** First KPI premise of a list (a goal carries at most one — premise-register enforces it). */
export function kpiPremiseOf(premises: unknown): KpiPremiseLike | null {
  if (!Array.isArray(premises)) return null;
  for (const p of premises) if (isKpiPremise(p) && Number.isFinite(Number((p as any).value))) return { ...(p as any), value: Number((p as any).value) };
  return null;
}

/** Receipt id citation shape: ≥ 8 hex chars, optionally the full uuid (dashes allowed). */
export const RECEIPT_ID_RE = /^[0-9a-f]{8}(?:[0-9a-f-]{0,28})?$/i;
export const normalizeReceiptId = (v: unknown): string | null => {
  const s = String(v ?? '').trim().toLowerCase();
  return RECEIPT_ID_RE.test(s) ? s : null;
};

const id8 = (v: unknown): string => String(v ?? '').slice(0, 8);
const msOf = (iso: unknown): number => (typeof iso === 'string' ? new Date(iso).getTime() : NaN);

/** "2h", "35m", "3d" — whole units, never negative. */
export function formatAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** "MM-DD HH:MMZ" of an ISO stamp ('?' when unparsable). */
export function stampMdHm(iso: unknown): string {
  const ms = msOf(iso);
  return Number.isFinite(ms) ? `${new Date(ms).toISOString().slice(5, 16).replace('T', ' ')}Z` : '?';
}
/** "HH:MMZ" of an ISO stamp. */
export function stampHm(iso: unknown): string {
  const ms = msOf(iso);
  return Number.isFinite(ms) ? `${new Date(ms).toISOString().slice(11, 16)}Z` : '?';
}

/** Value + unit as printed everywhere ("5.08 tok/s"; the unit keeps its own leading space when the register stored one). */
export function kpiValueText(p: { value: number; unit?: string }): string {
  const unit = p.unit ? String(p.unit) : '';
  return `${Number(p.value)}${unit && !/^\s/.test(unit) && !/^[%]/.test(unit) ? ` ${unit}` : unit}`;
}

/**
 * Ticket d1a7bec2 (CASE 2) — a BOOLEAN unit ('bool' / 'flag' / 'boolean' …)
 * denotes a truth reading (1 = true, 0 = false). A numeric bar copied over
 * from a sibling percentage is INCOMPARABLE to it: the Schooltime-adjacent
 * embeddings goal (f43bce21, closed 'done') carried
 * `caller_kpi_certified = 1 bool, bar 90, barDirection up` and the board
 * rendered "⚠ suspect kpi_bar_unmet — kpi caller_kpi_certified=1 bool < bar
 * 90" forever, because no bool can exceed 90. A closed goal keeping a ⚠ on
 * the board erodes trust in every other flag, so the comparison is skipped
 * on the read path AND the stored bar is normalised on the write path.
 */
const BOOLEAN_UNIT_RE = /^(?:bool|boolean|flag|binary|yes\/no|true\/false|truthy)$/i;
/** The one bar a boolean reading can be compared against (true = 1). */
export const BOOLEAN_KPI_BAR = 1;
/** Pure: does this premise's unit denote a boolean/flag reading? */
export function isBooleanKpiUnit(unit: unknown): boolean {
  const u = String(unit ?? '').trim();
  return u !== '' && BOOLEAN_UNIT_RE.test(u);
}
/** Pure: the bar a KPI is actually compared against — a boolean reading's bar is always BOOLEAN_KPI_BAR, never a copied-over numeric one. A premise with NO bar keeps NO bar: fabricating one would print a "bar ≥1" clause the register never held and would make computeAdoptionLadder's kpiBarMet() gate (bar-less goals) never trip. */
export function effectiveKpiBar(p: { bar?: number; unit?: string }): number | undefined {
  const declared = Number.isFinite(Number(p.bar)) ? Number(p.bar) : undefined;
  if (isBooleanKpiUnit(p.unit)) return declared === undefined ? undefined : BOOLEAN_KPI_BAR;
  return declared;
}

/** A declared bar direction: 'up' = the KPI must RISE to its bar (a floor, `value >= bar` met); 'down' = it must FALL to or below it (a ceiling — latency / p95 / error-rate / budget-cap bars, `value <= bar` met). Ticket 9fcd69ca (2026-10-27): inference alone misread a MET latency KPI (bar 500ms ceiling, first reading 18ms, current 83.6ms) as unmet — `bar >= first ⇒ 'up'` is wrong the moment a healthy KPI's FIRST reading already sits under its ceiling, and every latency/ceiling KPI false-flagged `kpi_bar_unmet` that way. */
export type KpiBarDirection = 'up' | 'down';

/** Normalize a caller-supplied bar-direction input to 'up' | 'down', or null when it does not name one ('auto', '', unknown spelling — the caller then infers). Pure, never throws. */
export function normalizeKpiBarDirection(v: unknown): KpiBarDirection | null {
  if (v === undefined || v === null) return null;
  const s = String(v).trim().toLowerCase();
  if (!s || s === 'auto') return null;
  if (s === 'up' || s === 'at_least' || s === 'atleast' || s === 'min' || s === 'ge' || s === 'gte' || s === 'higher' || s === 'lower_is_worse') return 'up';
  if (s === 'down' || s === 'at_most' || s === 'atmost' || s === 'max' || s === 'le' || s === 'lte' || s === 'ceiling' || s === 'lower_is_better') return 'down';
  return null;
}

/** 'up' when the KPI is meant to RISE to its bar (bar ≥ the first registered value — history[0] when the ring exists, else the current value), 'down' otherwise. A DECLARED `barDirection` ('up' | 'down') wins outright (ticket 9fcd69ca: a latency KPI whose first reading already beats its ceiling inferred 'up' and false-flagged kpi_bar_unmet on every healthy reading). A BOOLEAN unit is always 'up' — the only meaningful comparison is true (1) ≥ 1 (ticket d1a7bec2). */
export function kpiBarDirection(p: { value: number; bar?: number; history?: PremiseValueStamp[]; barDirection?: string; unit?: string }): 'up' | 'down' {
  // Ticket d1a7bec2 (CASE 2): a boolean reading's bar is BOOLEAN_KPI_BAR with a
  // floor direction — a copied-over '90' plus a declared 'down' must not turn
  // "certified = true" into a permanent ⚠.
  if (isBooleanKpiUnit(p.unit)) return 'up';
  const declared = normalizeKpiBarDirection(p.barDirection);
  if (declared) return declared;
  // m1 (review 4112375b): a NON-EMPTY unknown spelling on the READ path (only
  // reachable by a hand-edited / non-tool write — the register refuses garbage
  // at write time) silently degrades to the false-flagging inference. Warn so
  // the stale row is visible in the box logs; inference still applies.
  if (p.barDirection !== undefined && p.barDirection !== null && String(p.barDirection).trim() !== '') {
    console.warn(`[kpi-of-record] premise barDirection "${String(p.barDirection)}" is not a known spelling ('up' | 'down' | 'auto') — falling back to inference from the first registered value`);
  }
  const first = Array.isArray(p.history) && p.history.length && Number.isFinite(Number(p.history[0]?.value)) ? Number(p.history[0].value) : Number(p.value);
  return Number(p.bar) >= first ? 'up' : 'down';
}

/** Does the current value already satisfy the bar (nothing left to adopt toward)? false without a bar. A BOOLEAN unit compares against BOOLEAN_KPI_BAR (ticket d1a7bec2), never a numeric bar copied over from a sibling KPI. */
export function kpiBarMet(p: { value: number; bar?: number; history?: PremiseValueStamp[]; barDirection?: string; unit?: string }): boolean {
  if (!Number.isFinite(Number(p.value))) return false;
  const bar = effectiveKpiBar(p);
  if (!Number.isFinite(Number(bar))) return false;
  return kpiBarDirection(p) === 'up' ? Number(p.value) >= Number(bar) : Number(p.value) <= Number(bar);
}

/** The bar clause ("bar ≥10") — direction from the FIRST registered value (fixer follow-up 2: a counts-up KPI that passed its bar used to flip to "≤"); a DECLARED barDirection wins (ticket 9fcd69ca — the clause must read "≤500" on a latency ceiling). A BOOLEAN unit prints its own comparable bar (ticket d1a7bec2). */
export function kpiBarText(p: { value: number; bar?: number; history?: PremiseValueStamp[]; barDirection?: string; unit?: string }): string {
  const bar = effectiveKpiBar(p);
  if (!Number.isFinite(Number(bar))) return '';
  return `bar ${kpiBarDirection(p) === 'up' ? '≥' : '≤'}${Number(bar)}`;
}

/**
 * Finding 2(b): the board/wake rendering of ONE premise — every premise shows
 * its receipt + age when it has a receipt; a KPI is labelled and shows its last
 * change so the reader sees flapping.
 */
export function renderKpiInline(p: KpiPremiseLike, now: Date = new Date()): string {
  const meta: string[] = [];
  if (p.receiptId) meta.push(`receipt ${id8(p.receiptId)}`);
  const setMs = msOf(p.setAt);
  if (Number.isFinite(setMs)) meta.push(`${formatAge(now.getTime() - setMs)} ago`);
  const bar = kpiBarText(p);
  if (bar) meta.push(bar);
  let out = `KPI ${kpiBareKey(p.key)}=${kpiValueText(p)}${meta.length ? ` (${meta.join(' · ')})` : ''}`;
  if (p.prev && Number.isFinite(Number(p.prev.value)) && Number(p.prev.value) !== Number(p.value)) {
    out += ` · last change ${Number(p.prev.value)}→${Number(p.value)} @${stampHm(p.setAt)}`;
  }
  return out;
}

/** Receipt + age suffix for a NON-KPI premise that carries a receipt (" (receipt f5b42fe6 · 2h ago)"; '' otherwise). */
export function renderPremiseReceiptSuffix(p: { receiptId?: string; setAt?: string }, now: Date = new Date()): string {
  if (!p.receiptId) return '';
  const setMs = msOf(p.setAt);
  return ` (receipt ${id8(p.receiptId)}${Number.isFinite(setMs) ? ` · ${formatAge(now.getTime() - setMs)} ago` : ''})`;
}

// ── Typed-rate mining (findings 4/5) ─────────────────────────────────────────

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/** The unit as a regex fragment tolerant of spacing around the slash ("tok/s" matches "tok / s" too). */
function unitPattern(unit: string): string | null {
  const u = String(unit ?? '').trim();
  if (!u) return null;
  return escapeRe(u).replace(/\\\//g, '\\s*/\\s*').replace(/\s+/g, '\\s*');
}

/** Every `<number> <unit>` mention in `text` (numbers as written; "≈5.08 tok/s" and "5.08tok/s" both count). */
export function mineKpiRateMentions(text: string, unit: string | undefined): number[] {
  return mineKpiRateMentionsAt(text, unit).map((m) => m.value);
}

/** mineKpiRateMentions with each mention's offset in `text`. */
function mineKpiRateMentionsAt(text: string, unit: string | undefined): Array<{ value: number; index: number }> {
  const up = unitPattern(unit ?? '');
  if (!up || !text) return [];
  const re = new RegExp(`(?<![\\w.])(\\d+(?:\\.\\d+)?)\\s*${up}(?![\\w/])`, 'gi');
  const out: Array<{ value: number; index: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const n = Number(m[1]);
    if (Number.isFinite(n)) out.push({ value: n, index: m.index });
    if (out.length >= 32) break;
  }
  return out;
}

/**
 * audit 2026-10-06 T8-12 (others F17): a rate written as a THRESHOLD ("adoption bar ≥5.23 tok/s", "must beat
 * 6 tok/s", "target of 10 tok/s") is a bar, not a claim about the current value — kpi_reply_mismatch flagged it as a
 * quoted KPI. A mention preceded (within the same clause) by a comparator or a threshold word is skipped.
 * KPI_THRESHOLD_MENTION_EXEMPT_DISABLED=1 judges every mention as before.
 */
export function kpiThresholdMentionExemptDisabled(): boolean {
  return process.env.KPI_THRESHOLD_MENTION_EXEMPT_DISABLED === '1';
}
const THRESHOLD_CUE_RE = /(?:(?<![-=<])[≥≤><]=?|=>|\b(?:bar|target|threshold|goal|beat|beats|beating|exceed|exceeds|exceeding|above|below|at least|at most|minimum|maximum|min|max|floor|ceiling)\b(?:\s+(?:of|is|at|=|:))?)\s*[~≈]?\s*$/i;
export function isThresholdMention(text: string, index: number): boolean {
  const before = text.slice(Math.max(0, index - 32), index);
  return THRESHOLD_CUE_RE.test(before);
}

/** Same number at the register's own precision (5.08 vs 5.080 agree; 5.1 vs 5.08 do not). */
export function sameKpiValue(a: number, b: number): boolean {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  const decimals = (n: number) => { const s = String(n); const i = s.indexOf('.'); return i < 0 ? 0 : s.length - i - 1; };
  const d = Math.max(decimals(a), decimals(b));
  return Math.abs(a - b) < 0.5 * Math.pow(10, -d);
}

/** Does the text cite the KPI by key (with or without the `kpi:` prefix)? */
export function mentionsKpiKey(text: string, key: string): boolean {
  const bare = kpiBareKey(key);
  if (!bare) return false;
  return new RegExp(`(?:^|[^\\w])(?:kpi:)?${escapeRe(bare)}(?![\\w])`, 'i').test(text);
}

/** Every number the register HOLDS for a KPI: the value, its bar, `prev` and the history ring. */
export function kpiRegisterValues(kpi: KpiPremiseLike): number[] {
  const vals = [Number(kpi.value), Number(kpi.bar), Number(kpi.prev?.value), ...(Array.isArray(kpi.history) ? kpi.history.map((h) => Number(h?.value)) : [])];
  return vals.filter((v) => Number.isFinite(v));
}

/**
 * Rates typed into `text` in the KPI's unit that the register does NOT hold
 * (dedup'd, order kept). Quoting the bar ("reach the bar of 10 tok/s"), the
 * previous reading ("prev 2.464 tok/s") or a history value is NOT a mis-report
 * — fixer follow-up 4: those used to footer a correct reply, replace a correct
 * brief sentence and pollute kpi_reply_mismatch.
 */
export function typedRatesDisagreeingWithKpi(text: string, kpi: KpiPremiseLike): number[] {
  const held = kpiRegisterValues(kpi);
  const seen = new Set<number>();
  const out: number[] = [];
  const skipThresholds = !kpiThresholdMentionExemptDisabled();
  for (const { value: n, index } of mineKpiRateMentionsAt(text, kpi.unit)) {
    if (skipThresholds && isThresholdMention(text, index)) continue;
    if (seen.has(n) || held.some((h) => sameKpiValue(n, h))) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

/** The one-line "of record" sentence ("5.08 tok/s — receipt f5b42fe6, 2 h ago"). */
export function kpiOfRecordText(kpi: KpiPremiseLike, now: Date = new Date()): string {
  const bits: string[] = [];
  if (kpi.receiptId) bits.push(`receipt ${id8(kpi.receiptId)}`);
  const setMs = msOf(kpi.setAt);
  if (Number.isFinite(setMs)) bits.push(`${formatAge(now.getTime() - setMs)} ago`);
  return `${kpiValueText(kpi)}${bits.length ? ` — ${bits.join(', ')}` : ''}`;
}

/**
 * Finding 5: the deterministic reply footer. When an owner-facing supervisor
 * reply types a rate in the KPI's unit that differs from the register value
 * and never cites the premise key, append the register's own line. Returns
 * null when nothing is to append (no KPI, no mismatch, key cited).
 */
export function kpiReplyFooter(text: string, kpis: KpiView[], now: Date = new Date()): { footer: string; kpi: KpiView; quoted: number[] } | null {
  if (!text || !kpis?.length) return null;
  for (const kpi of kpis) {
    if (!kpi.unit) continue;
    if (mentionsKpiKey(text, kpi.key)) continue;
    const quoted = typedRatesDisagreeingWithKpi(text, kpi);
    if (!quoted.length) continue;
    return { footer: `(KPI of record — ${kpiBareKey(kpi.key)}: ${kpiOfRecordText(kpi, now)}${kpiBarText(kpi) ? `; ${kpiBarText(kpi)}` : ''})`, kpi, quoted };
  }
  return null;
}

/**
 * Finding 2(d): observe-only annotation of a [SUPERVISOR STATE] project line —
 * when the line names the KPI key or types a rate in its unit, append the
 * live register value so a stale copied number is visibly stale.
 */
export function annotateStateLineWithKpi(line: string, kpis: KpiView[], now: Date = new Date()): string {
  if (!line || !kpis?.length) return line;
  for (const kpi of kpis) {
    const cites = mentionsKpiKey(line, kpi.key) || (kpi.unit ? mineKpiRateMentions(line, kpi.unit).length > 0 : false);
    if (!cites) continue;
    // Fixer follow-up 4: a line that already carries the register value verbatim IS current — nothing to annotate.
    if (line.includes(kpiValueText(kpi))) return line;
    const annotation = `[register now: ${kpiBareKey(kpi.key)}=${kpiValueText(kpi)} @${stampHm(kpi.setAt)}${kpi.receiptId ? ` receipt ${id8(kpi.receiptId)}` : ''}]`;
    if (line.includes(annotation)) return line;
    return `${line} ${annotation}`;
  }
  return line;
}

/** Owner-facing status-card row (finding 4). */
export function renderKpiCardLine(kpi: KpiPremiseLike & { experimentsSinceMove?: number; hoursSinceMove?: number }, now: Date = new Date()): string {
  const label = kpiBareKey(kpi.key).replace(/[_-]+/g, ' ');
  let out = `KPI of record — ${label}: ${kpiOfRecordText(kpi, now)}`;
  const bar = kpiBarText(kpi);
  if (bar) out += ` — ${bar}`;
  const hours = Number(kpi.hoursSinceMove);
  const exp = Number(kpi.experimentsSinceMove);
  if (Number.isFinite(hours) && hours >= 1) {
    out += ` · unchanged for ${formatAge(hours * 3_600_000)}`;
    if (Number.isFinite(exp) && exp > 0) out += ` (${exp} work session${exp === 1 ? '' : 's'} since the last move)`;
  }
  return out;
}

// ── KPI re-announcement (ticket abca56ce) ────────────────────────────────────
// The specimen: the Schooltime rate was announced "MET" to the owner THREE
// times in one day (103.9 @02:00, 162.9 @05:18 Telegram, 113.4 @08:56) while
// the of-record state never changed — the near-duplicate guard could not see
// it because every different number is a different token set. The fix anchors
// on the REGISTER, never the number the model happened to type: remember the
// of-record {value, met} state per KPI at announcement time and refuse a
// re-announcement when the state is unchanged and the value moved ≤ threshold
// (default 10%). One push per KPI state change.

/** Generic rate words that appear inside KPI keys but name no KPI ("clips_per_hour" → per/hour are structural). */
const KPI_NAME_STOPWORDS = new Set([
  'rate', 'hour', 'hours', 'day', 'days', 'week', 'weeks', 'minute', 'minutes', 'second', 'seconds',
  'sec', 'min', 'count', 'counts', 'total', 'value', 'values', 'metric', 'metrics', 'kpi', 'score',
  'scores', 'average', 'avg', 'target', 'bar', 'threshold', 'quota', 'peak', 'mean', 'p50', 'p90', 'p99',
]);

/** Distinctive identity words of a KPI key — "schooltime_verified_clips_per_hour" (unit "clips/hr") → ["schooltime", "verified"]. The UNIT's own tokens are structural: they appear in every rate mention in that unit (another KPI's "101.2 clips/hr" must not announce this one), so they never count as identity. Pure. */
export function kpiNameWords(key: string, unit?: string): string[] {
  const bare = kpiBareKey(String(key ?? ''));
  const unitWords = new Set(String(unit ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  const words = bare.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return [...new Set(words.filter((w) => w.length >= 5 && !KPI_NAME_STOPWORDS.has(w) && !unitWords.has(w)))];
}

/** The of-record state a push announces — the REGISTER's figure and met/unmet verdict at announcement time. */
export interface KpiAnnounceState { value: number; met: boolean; at: number }

/** The register's current announcement state for a KPI premise. Pure. */
export function kpiAnnounceStateOf(kpi: KpiPremiseLike, at: number = Date.now()): KpiAnnounceState {
  return { value: Number(kpi.value), met: kpiBarMet(kpi), at };
}

/**
 * Does a push ANNOUNCE this KPI? True when it (a) names the key (with or
 * without the `kpi:` prefix), or (b) names a distinctive key word AND types a
 * rate in the KPI's unit, quotes the of-record figure, or names its bar state
 * ("the Schooltime rate is MET", "schooltime clips/hr holding at 113.4 — bar
 * met"). IDENTITY IS REQUIRED for (b): a rate in the same unit alone, the
 * register figure alone, or the word "met" alone (review F1/F2: "we met with
 * the vendor", "CPU saturated at 100%") is NOT an announcement — the guard
 * fails open rather than silencing a neighbour's news. The bar cue must name
 * the BAR ("bar met", "met the bar"), never the bare word "met". Pure.
 */
const KPI_BAR_MET_CUE_RE = /\bbar\b[^.\n]{0,24}\b(?:is |was |now |still )?(?:not |un)?met\b|\b(?:not |un)?met the bar\b/i;
export function kpiAnnouncedBy(text: string, kpi: KpiPremiseLike): boolean {
  const t = String(text ?? '');
  if (!t.trim()) return false;
  if (mentionsKpiKey(t, kpi.key)) return true;
  const nameWords = kpiNameWords(kpi.key, kpi.unit);
  const named = nameWords.some((w) => new RegExp(`(?:^|[^a-z0-9])${escapeRe(w)}(?:[^a-z0-9]|$)`, 'i').test(t));
  if (!named) return false; // no identity → never this KPI's announcement
  const rates = mineKpiRateMentions(t, kpi.unit);
  if (rates.some((n) => sameKpiValue(n, Number(kpi.value)))) return true;
  return rates.length > 0 || KPI_BAR_MET_CUE_RE.test(t);
}

/**
 * Would announcing NOW be a REPEAT of `last`? True when the met/unmet state
 * is unchanged AND the of-record value moved at most `threshold` (a fraction,
 * default 0.10) of the last announced value — no news. A state flip or a
 * material move is news and re-pushes. Pure, fail-open on non-finite inputs.
 */
export function kpiAnnouncementIsRepeat(
  last: KpiAnnounceState,
  now: { value: number; met: boolean },
  threshold: number = 0.10,
): boolean {
  if (!Number.isFinite(last?.value) || !Number.isFinite(now?.value)) return false;
  if (last.met !== now.met) return false;
  const move = Math.abs(now.value - last.value);
  return move <= Math.abs(last.value) * threshold + 1e-9;
}
