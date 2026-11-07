/**
 * PREMISE REGISTER (owner directive 2026-09-16, framework item 2).
 *
 * Why: the CanLaw read-through found the program's central number — the
 * untrained Qwen3.8-27B base scores 60.07% on CanLegalBench v0.8.0 — absent
 * from the CanLaw project entirely, while its plan compared fine-tunes against
 * a different (retired) baseline. Nobody was wrong on purpose: a premise lived
 * in one project's transcript and never became a fact the other project could
 * see, so nothing could ever contradict it. Goals need a place for the numbers
 * they rest on, and the framework needs to re-check those numbers without a
 * model in the loop.
 *
 * What this module is:
 *  - the premise SHAPE + validation (`normalizePremises`), used by the
 *    goal_premise_set tool (goals.service setGoalPremises) — pure;
 *  - the deterministic SOURCE RE-CHECK (`runPremiseCheckOnce`, hourly on its
 *    own cron id `premise-check`): for every premise with an https `source`
 *    not checked in the last 50 min, fetch it (https only, private/link-local
 *    addresses refused after a timed DNS lookup, ≤2 re-checked redirects, 10s,
 *    1 MB), read the number by `jsonPath` (JSON) or `pattern` (regex with a
 *    nested-quantifier ban at registration AND a 250 ms vm timeout at match
 *    time — retried ONCE on a timeout, so a CPU-deschedule false positive is
 *    absorbed while a catastrophic pattern still errors, ticket 640c3bb5), compare against `value` within `tolerance`, stamp the premise
 *    (merged by key onto the row's CURRENT premises, never a blind overwrite),
 *    and on a NEW drift wake the project supervisor with [PREMISE DRIFT]
 *    (fleet supervisor when the project has none) — deduped 24h per premise on
 *    the observed value, capped per target per sweep;
 *  - the CROSS-PROJECT CONTRADICTION flag: goals in ≥2 projects of one owner
 *    registering the same `key` with values apart beyond tolerance wake the
 *    Fleet Supervisor ONCE per key with every goal listed, deduped 7 days on
 *    the whole (goal, value) tuple.
 *
 * Bounds (review 2026-09-16): a 4-minute wall-clock budget per sweep,
 * 4 concurrent goals, least-recently-checked first, DNS lookups timed. Per-user
 * gates: every read and wake is scoped to the goal owner's own projects and
 * supervisors; paused/archived project supervisors are never woken. Failure
 * posture: every probe fails toward "unknown" (lastError, no wake); the sweep
 * never throws into the cron loop. Kill switch: PREMISE_CHECK_DISABLED=1.
 */

import { promises as dns } from 'dns';
import { createHash } from 'crypto';
import vm from 'vm';
import prisma from '../../../config/database';
import redisClient from '../../../config/redis';
import logger from '../../../utils/logger';
import { modelToolName } from '../coding/tool-scope';
import { LOOP_METRIC_KINDS } from './loop-metric-kinds';
import { recordLoopMetric } from './loop-metrics.service';
import {
  KPI_KEY_PREFIX, isKpiPremise, normalizeReceiptId, normalizeKpiBarDirection,
  isBooleanKpiUnit, BOOLEAN_KPI_BAR,
  type PremiseValueStamp,
} from './kpi-of-record';
import { TARGET_PREMISE_KEY_RE, targetBound } from './goal-done-suspect';

const SOURCE = 'premise-register';

/** 8 → 12 (tt-rd audit 2026-09-27, finding 2e): the speed goal's register was
 *  FULL with 7 internal engineering figures, so the one client-visible KPI had
 *  no room of its own. The `kpi:` prefix is reserved — a goal carries at most
 *  ONE KPI premise (normalizePremises refuses a second). */
export const PREMISE_MAX_PER_GOAL = 12;
/** Value-history ring kept on a premise whose value changed (finding 2a). */
export const PREMISE_HISTORY_MAX = 8;
/**
 * Ticket 7862cb2a (2026-11-01): 40 → 64. The KPI contract tells every lane to
 * register a diagnostic reading under `<kpi key>:diag`, but a realistic
 * descriptive key overflows 40 once the suffix is added
 * (`backlog:auto_decrypt_rate_clips_per_hr` is 38 chars, +5 = 43 → REFUSED),
 * so the documented naming convention was unsatisfiable by the very key it is
 * derived from and the lane had to park a SHORTENED key. A key is an
 * identifier, not a payload — 64 costs nothing (`premises` is a Json column)
 * and leaves 19 chars of headroom over the shape the contract asks for.
 */
export const PREMISE_KEY_MAX = 64;
export const PREMISE_UNIT_MAX = 12;
export const PREMISE_NOTE_MAX = 160;
/** suite/scorer id a scored premise was produced under, e.g. 'canlegalbench-v0.8.0/det-v2' (finding C3, 2026-09-27) */
export const PREMISE_MANIFEST_MAX = 60;
export const PREMISE_SOURCE_MAX = 400;
export const PREMISE_JSONPATH_MAX = 120;
export const PREMISE_PATTERN_MAX = 200;
export const PREMISE_FETCH_TIMEOUT_MS = 10_000;
export const PREMISE_DNS_TIMEOUT_MS = 3_000;
export const PREMISE_FETCH_MAX_BYTES = 1_000_000;
export const PREMISE_FETCH_MAX_REDIRECTS = 2;
export const PREMISE_PATTERN_BODY_CAP = 256_000;
export const PREMISE_PATTERN_TIMEOUT_MS = 250;
export const PREMISE_CHECK_MAX_GOALS = 400;
export const PREMISE_SWEEP_BUDGET_MS = 4 * 60_000;
export const PREMISE_SWEEP_CONCURRENCY = 4;
/** A premise checked more recently than this is skipped (idempotent re-claims, fairness across users). */
export const PREMISE_RECHECK_MIN_MS = 50 * 60_000;
/** An unchanged "still ok" stamp is written at most this often. */
export const PREMISE_HEARTBEAT_MS = 6 * 3600_000;
export const PREMISE_DRIFT_DEDUPE_SEC = 24 * 3600;
export const PREMISE_DRIFT_WAKES_PER_TARGET = 5;
export const PREMISE_CONFLICT_DEDUPE_SEC = 7 * 86400;
/** Review fix (sup3 fixer pass, 2026-09-27 — finding 1): DONE goals closed within this window are still re-checked
 *  (stamp only — no drift wake, no conflict flag) so a '⚠ suspect' close clears itself once its source meets the bar.
 *  Mirrors board-digest BOARD_SUSPECT_DONE_WINDOW_MS. */
export const PREMISE_CHECK_DONE_WINDOW_MS = 7 * 86400_000;
const CONFLICT_KEY = (userId: string, hash: string) => `premise:conflict:${userId}:${hash}`;
const DRIFT_KEY = (goalId: string, key: string) => `premise:drift:${goalId}:${key.toLowerCase()}`;

export type PremiseDrift = 'ok' | 'drift' | 'error';

export interface GoalPremise {
  /** short slug, e.g. 'untrained_base_suite_mean' */
  key: string;
  value: number;
  unit?: string;
  /** where the number came from (free text, ≤160) */
  note?: string;
  /** https URL the framework re-checks hourly */
  source?: string;
  /** JSON dot/bracket path into the source body, e.g. 'results.suite_mean' or 'runs[0].score' */
  jsonPath?: string;
  /** regex over a TEXT body; the FIRST capture group is the number */
  pattern?: string;
  /** absolute tolerance (same unit as value); 0 = any change is drift */
  tolerance?: number;
  /**
   * Finding C3 (2026-09-27): the suite/scorer MANIFEST the number was produced
   * under ('canlegalbench-v0.8.0/det-v2', 'llama-bench draft2g tg32'). Two
   * premises are like-for-like ONLY when their manifests match — a judged
   * frontier bar beside a deterministic-scorer score renders no gap.
   */
  manifest?: string;
  /** key of a SIBLING premise on the same goal this one is a bar/target for — the board renders the gap only when manifests match */
  compareTo?: string;
  setByChatId?: string | null;
  setAt?: string;
  /** Finding C3: the value this premise held BEFORE its last beyond-tolerance re-registration (a REVISION, never silent) */
  prevValue?: number;
  prevManifest?: string;
  revisedAt?: string;
  checkedAt?: string;
  observed?: number;
  /** When `observed` was last written (ISO): the sweep's checkedAt, or a lane's goal_premise_set observed (finding 1, 2026-09-27). */
  observedAt?: string;
  /** A lane's evidence for a manually recorded `observed` (run id / file / quoted line, ≤160); cleared when the source sweep overwrites `observed`. */
  observedNote?: string;
  /** last CONFIRMED comparison ('error' only when the source has never been read) */
  drift?: PremiseDrift;
  driftNote?: string;
  /** last probe failure (kept alongside the confirmed drift state, never replacing it) */
  lastError?: string;
  lastErrorAt?: string;
  /** Mission KPI contract (tt-rd audit 2026-09-27, finding 1): 'kpi' marks the
   *  ONE of-record number a goal with a numeric bar is measured by (also implied
   *  by a `kpi:` key prefix). Its value is set ONLY from a run_command receipt
   *  id (`receiptId`, required — goals.service
   *  checks the row exists, ok:true, in the goal's project); `bar` is the
   *  target (M1/M2). Any other rate registers under its own key. */
  kind?: 'kpi';
  /** run_command (or other tool) receipt the value was read from — full id or ≥8-char prefix as cited. */
  receiptId?: string;
  /**
   * The bar's DIRECTION, declared at registration (ticket 9fcd69ca, 2026-10-27):
   * 'up' = a floor the KPI must rise to (value ≥ bar met); 'down' = a ceiling it
   * must fall to or below (latency / p95 / error-rate / budget-cap bars — value
   * ≤ bar met). Omitted / 'auto' ⇒ inferred from the first registered value,
   * which misreads a latency KPI whose FIRST reading already sits under its
   * ceiling (18ms vs a 500ms bar ⇒ 'up' ⇒ healthy readings flagged unmet).
   */
  barDirection?: 'up' | 'down';
  /** the goal's numeric bar for this KPI */
  bar?: number;
  /** finding 2a: the value this one replaced (+ its stamp) — the board shows "last change a→b @HH:MMZ" */
  prev?: PremiseValueStamp;
  /** finding 2a: oldest-first ring (≤ PREMISE_HISTORY_MAX) of superseded values */
  history?: PremiseValueStamp[];
}

export type PremiseInput = Partial<Record<keyof GoalPremise, unknown>>;

const KEY_RE = new RegExp(`^[a-z0-9][a-z0-9_.:-]{0,${PREMISE_KEY_MAX - 1}}$`, 'i');
const MANIFEST_RE = /^[a-z0-9][a-z0-9_.:/@+ -]{0,59}$/i;
const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v.replace(/[,%$\s]/g, '')) : NaN;
  return Number.isFinite(n) ? n : null;
};
const str = (v: unknown, max: number): string => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * Review fix (2026-09-27, finding C3 follow-up): a manifest is SANITIZED the
 * way unit/note are clipped — never refused. The doctrine tells every lane to
 * add one, and a 400 on 'canlegalbench v0.8.0 (det-v2)', 'llama-bench draft2g,
 * tg32', 'det-v2 #3' or 'suite=cal16' lost the WHOLE goal_premise_set write
 * (every premise in the call) and cost the lane a tool round. A run of
 * disallowed characters becomes a space when it touches whitespace and a '-'
 * elsewhere; whitespace collapses; the id is clipped to PREMISE_MANIFEST_MAX;
 * only an id that is EMPTY after sanitizing is omitted (like a blank one).
 */
export function sanitizePremiseManifest(raw: unknown): string {
  let s = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  s = s.replace(/ ?[^a-z0-9_.:/@+ -]+ ?/gi, (m) => (m.includes(' ') ? ' ' : '-'));
  s = s.replace(/-{2,}/g, '-').replace(/ {2,}/g, ' ').replace(/^[^a-z0-9]+/i, '');
  s = s.slice(0, PREMISE_MANIFEST_MAX).replace(/[- ]+$/g, '');
  return MANIFEST_RE.test(s) ? s : '';
}

/**
 * Ticket 7862cb2a: the key a caller can actually SEND, given one that is over
 * the length cap. Pure, and derived so the offer never dead-ends (the af24badf
 * rule: never advise a retry this module would refuse again) — the returned
 * string either passes `KEY_RE` at ≤ PREMISE_KEY_MAX, or is EMPTY, meaning "no
 * legal shortening exists" and the caller must omit the offer entirely rather
 * than print `e.g. ""`. (Adversarial review 2026-11-01: an earlier cut claimed
 * a universal invariant and was falsified by separator-only, space-bearing and
 * non-ASCII keys — all three now sanitise or return ''.)
 *
 * The `:diag` suffix is PRESERVED when the caller used it: the KPI contract
 * names `<kpi key>:diag` as the shape, so clipping the tail off would silently
 * turn a diagnostic into something that reads as a KPI candidate key.
 * Everything else shortens from the end.
 */
export function shortenPremiseKey(raw: unknown, max: number = PREMISE_KEY_MAX): string {
  const clean = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (clean.length <= max && KEY_RE.test(clean)) return clean;
  // Legalise first: an illegal character anywhere (a space, a non-ASCII rune)
  // would survive a pure length clip and hand back a key this module refuses.
  const legal = clean.replace(/[^a-z0-9_.:-]/gi, '');
  const suffixed = /^(.*?)(:diag)$/i.exec(legal);
  const candidate = suffixed
    ? `${suffixed[1].slice(0, Math.max(0, max - suffixed[2].length))}${suffixed[2]}`
    : legal.slice(0, max);
  // A key must START alphanumeric and must not end on a bare separator; an
  // all-separator input legitimately has no shortening (return ''), and the
  // caller then drops the offer instead of suggesting something refused.
  const trimmed = candidate.replace(/^[_.:-]+/, '').replace(/[_.:-]+$/, '');
  return KEY_RE.test(trimmed) ? trimmed : '';
}

/**
 * ReDoS shapes are refused at registration: a quantified group that is itself
 * quantified ((a+)+, (\d*)*), stacked quantifiers (a+*), an alternation inside
 * a quantified group ((a|aa)*), more than two `.*`. Defense in depth — the
 * match itself also runs under a hard vm timeout (`safeMatch`).
 */
export function isUnsafePattern(pattern: string): boolean {
  const p = pattern.replace(/\\./g, 'x'); // escaped chars are literals
  if (/\([^()]*[*+}][^()]*\)\s*[*+{]/.test(p)) return true; // an OPTIONAL quantified group ((a+)?) is safe
  if (/[*+}][*+]/.test(p)) return true;
  if (/\([^()]*\|[^()]*\)\s*[*+{]/.test(p)) return true;
  if ((p.match(/\.\*/g) ?? []).length > 2) return true;
  if (/\{\d{4,}/.test(p)) return true;
  return false;
}

/** Shape/validate ONE premise; returns an error string instead of a premise when invalid. */
export function normalizePremise(raw: PremiseInput, meta: { setByChatId?: string | null; now?: Date } = {}): GoalPremise | string {
  if (!raw || typeof raw !== 'object') return 'premise must be an object';
  // The LENGTH check reads the key as SENT, never a clipped copy: `str()` cuts
  // at MAX+1, so measuring the clipped value would report the wrong length and
  // — ticket 7862cb2a — drop a `:diag` suffix off the end before the offer can
  // preserve it (a diagnostic then reads as a KPI candidate key).
  const givenKey = String(raw.key ?? '').replace(/\s+/g, ' ').trim();
  if (!givenKey) return `premise key must be 1–${PREMISE_KEY_MAX} chars of letters/digits/_ . : - (got "(empty)")`;
  // Ticket 7862cb2a: an OVER-LONG key used to fall into the same one-line
  // "must be 1–40 chars" refusal as a malformed one, naming a key CLIPPED to
  // 41 chars (so the caller could not even see what it sent) and offering no
  // landing key — a lane whose naturally-derived `<kpi>:diag` key was 43 chars
  // got no arithmetic and no escape, and had to guess a shortened spelling.
  // The overflow is the interesting case: name the real length, the exact
  // overflow, and a key that will actually land.
  if (givenKey.length > PREMISE_KEY_MAX) {
    const landing = shortenPremiseKey(givenKey);
    const over = givenKey.length - PREMISE_KEY_MAX;
    const shown = givenKey.length > 120 ? `${givenKey.slice(0, 117)}…` : givenKey;
    // An empty `landing` means NO legal shortening exists (a separator-only or
    // wholly non-ASCII key) — say so instead of printing `e.g. ""`, which is
    // the very dead end this message exists to remove.
    const offer = landing
      ? ` Re-send it shortened, e.g. "${landing}" (${landing.length} chars${/:diag$/i.test(landing) ? ', :diag suffix kept' : ''}), and put the full reading in the note.`
      : ' No shortened form of this key is legal either (a key must start with a letter/digit), so pick a new slug of letters/digits/_ . : - and put the full reading in the note.';
    return `premise key is ${givenKey.length} chars, ${over} over the ${PREMISE_KEY_MAX}-char cap (got "${shown}") — a key must be 1–${PREMISE_KEY_MAX} chars of letters/digits/_ . : -.${offer}`;
  }
  const key = givenKey;
  if (!KEY_RE.test(key)) return `premise key must be 1–${PREMISE_KEY_MAX} chars of letters/digits/_ . : - (got "${key}")`;
  const value = num(raw.value);
  if (value === null) return `premise "${key}": value must be a finite number`;
  const out: GoalPremise = { key, value, setByChatId: meta.setByChatId ?? null, setAt: (meta.now ?? new Date()).toISOString() };
  const unit = str(raw.unit, PREMISE_UNIT_MAX); if (unit) out.unit = unit;
  const note = str(raw.note, PREMISE_NOTE_MAX); if (note) out.note = note;
  if (raw.manifest !== undefined && raw.manifest !== null) {
    // Sanitized, never refused (review fix 2026-09-27) — see sanitizePremiseManifest.
    const manifest = sanitizePremiseManifest(raw.manifest);
    if (manifest) out.manifest = manifest;
  }
  if (raw.compareTo !== undefined && raw.compareTo !== null && String(raw.compareTo).trim()) {
    const compareTo = str(raw.compareTo, PREMISE_KEY_MAX + 1);
    if (!KEY_RE.test(compareTo)) return `premise "${key}": compareTo must be the key of another premise on this goal`;
    if (compareTo.toLowerCase() === key.toLowerCase()) return `premise "${key}": compareTo cannot point at itself`;
    out.compareTo = compareTo;
  }
  if (raw.source !== undefined && raw.source !== null && String(raw.source).trim()) {
    const source = str(raw.source, PREMISE_SOURCE_MAX + 1);
    let u: URL;
    try { u = new URL(source); } catch { return `premise "${key}": source must be an https URL`; }
    if (u.protocol !== 'https:' || source.length > PREMISE_SOURCE_MAX) return `premise "${key}": source must be an https URL (≤${PREMISE_SOURCE_MAX} chars)`;
    if (u.username || u.password) return `premise "${key}": source must not carry credentials`;
    out.source = u.toString();
    const jsonPath = str(raw.jsonPath, PREMISE_JSONPATH_MAX + 1);
    const pattern = str(raw.pattern, PREMISE_PATTERN_MAX + 1);
    if (!jsonPath && !pattern) return `premise "${key}": a source needs jsonPath (JSON body) or pattern (text body, first capture group = the number)`;
    if (jsonPath && pattern) return `premise "${key}": give jsonPath OR pattern, not both`;
    if (jsonPath) {
      if (jsonPath.length > PREMISE_JSONPATH_MAX || !/^[A-Za-z0-9_$][A-Za-z0-9_$\-]*(?:\.[A-Za-z0-9_$\-]+|\[\d+\])*$/.test(jsonPath)) return `premise "${key}": jsonPath must be a dot/bracket path like results.suite_mean or runs[0].score`;
      out.jsonPath = jsonPath;
    } else {
      if (pattern.length > PREMISE_PATTERN_MAX) return `premise "${key}": pattern too long (≤${PREMISE_PATTERN_MAX})`;
      try { new RegExp(pattern, 'i'); } catch { return `premise "${key}": pattern is not a valid regex`; }
      if (!/\((?!\?)/.test(pattern)) return `premise "${key}": pattern needs one capture group around the number`;
      if (isUnsafePattern(pattern)) return `premise "${key}": pattern uses nested or stacked quantifiers (catastrophic backtracking) — anchor it on the label text instead, e.g. "Suite mean:\\s*([\\d.]+)"`;
      out.pattern = pattern;
    }
  }
  if (raw.tolerance !== undefined && raw.tolerance !== null && String(raw.tolerance) !== '') {
    const tol = num(raw.tolerance);
    if (tol === null || tol < 0) return `premise "${key}": tolerance must be a number ≥ 0`;
    out.tolerance = tol;
  }
  // Mission KPI contract (finding 1). `kind:'kpi'` or a `kpi:` key marks the
  // of-record number; it needs its receipt. Other premises MAY carry a
  // receiptId too (rendered as "receipt <id8> · <age>").
  if (raw.kind !== undefined && raw.kind !== null && String(raw.kind).trim()) {
    if (String(raw.kind).trim().toLowerCase() !== 'kpi') return `premise "${key}": kind must be 'kpi' (or omitted)`;
    out.kind = 'kpi';
  }
  if (isKpiPremise(out) || key.toLowerCase().startsWith(KPI_KEY_PREFIX)) out.kind = 'kpi';
  if (raw.receiptId !== undefined && raw.receiptId !== null && String(raw.receiptId).trim()) {
    const rid = normalizeReceiptId(raw.receiptId);
    if (!rid) return `premise "${key}": receiptId must be a receipt id (≥8 hex chars, as get_run_receipts prints it)`;
    out.receiptId = rid;
  }
  if (raw.bar !== undefined && raw.bar !== null && String(raw.bar) !== '') {
    const bar = num(raw.bar);
    if (bar === null) return `premise "${key}": bar must be a finite number`;
    out.bar = bar;
  }
  // Ticket 9fcd69ca (2026-10-27): the bar's DIRECTION can be DECLARED, so a
  // latency / ceiling KPI whose first reading already sits under its bar stops
  // inferring 'up' (value must rise to bar) and false-flagging kpi_bar_unmet on
  // every healthy reading. Accepted spellings: 'up' | 'down' | 'at_least' |
  // 'at_most' | 'min' | 'max' | 'ge'/'gte' | 'le'/'lte' | 'ceiling' |
  // 'lower_is_better' / 'lower_is_worse' | 'auto' (= infer, the default, and
  // the one spelling that CLEARS a previously retained declaration).
  // `atMost: true` is accepted as the boolean alias of 'at_most'.
  const rawBarDirection = raw.barDirection !== undefined ? raw.barDirection : ((raw as { atMost?: unknown }).atMost === true ? 'at_most' : undefined);
  if (rawBarDirection !== undefined && rawBarDirection !== null && String(rawBarDirection).trim() !== '' && String(rawBarDirection).trim().toLowerCase() !== 'auto') {
    const bd = normalizeKpiBarDirection(rawBarDirection);
    if (!bd) {
      return `premise "${key}": barDirection must be one of 'up' | 'down' (or 'at_least' / 'at_most' / 'min' / 'max' / 'ge' / 'le' / 'ceiling' / 'lower_is_better' / 'lower_is_worse'; 'auto' = infer from the first registered value) — declare 'down' for a latency / p95 / error-rate / budget-cap bar (value ≤ bar is MET)`;
    }
    out.barDirection = bd;
  }
  if ((out.barDirection !== undefined) && out.bar === undefined) {
    return targetBarDirectionRefusal(key)
      ?? `premise "${key}": barDirection needs a bar (and marks a KPI premise — 'kpi:' key or kind:'kpi')`;
  }
  // Ticket d1a7bec2 (CASE 2): a BOOLEAN unit denotes a truth reading (1 = true),
  // so a numeric bar copied over from a sibling percentage ("bar 90" on a
  // certified-true flag) is arithmetic on incomparable units — it renders
  // "1 bool < bar 90" forever and no reading can ever clear it (goal f43bce21
  // sat on the board with a permanent ⚠ after it closed). NORMALISE, don't
  // refuse: the row is honest, only its bar was copied, and a refusal would
  // brick an existing premise on its next write. bar 1 with an 'up' floor is the
  // one comparison a boolean can meet, so the stored bar and direction are
  // rewritten to it here — and the read path (kpiBarMet / kpiBarUnmetOf) ignores
  // the stored bar entirely, so rows already written stay honest without a
  // backfill. Placed AFTER the declared-direction parse so a stale 'down'
  // copied alongside the bar cannot survive.
  if (out.bar !== undefined && isKpiPremise(out) && isBooleanKpiUnit(out.unit)) {
    out.bar = BOOLEAN_KPI_BAR;
    out.barDirection = 'up';
  }
  // m2 (review 4112375b): barDirection is bar semantics ONLY the KPI readers
  // consume — refuse it on a non-KPI premise even when a bar is present, so a
  // plain premise can never carry a dead declaration.
  if (out.barDirection !== undefined && !isKpiPremise(out)) {
    return targetBarDirectionRefusal(key) ?? plainBarDirectionRefusal(key);
  }
  if (out.kind === 'kpi' && !out.receiptId) {
    return KPI_RECEIPT_RULE(key);
  }
  // Review fix (sup3 fixer pass, 2026-09-27 — finding 1): a lane can RECORD the
  // measured value of a target_* premise (goal_premise_set observed +
  // observedNote). Before this, `observed` was written only by the hourly
  // source sweep, so a source-less target premise could never be met and the
  // done-suspect remedy "record the met premise" had no tool path.
  const hasObserved = raw.observed !== undefined && raw.observed !== null && String(raw.observed).trim() !== '';
  const observedNote = str(raw.observedNote, PREMISE_NOTE_MAX);
  if (hasObserved) {
    const observed = num(raw.observed);
    if (observed === null) return `premise "${key}": observed must be a finite number (the measured value)`;
    out.observed = observed;
    out.observedAt = out.setAt;
    if (observedNote) out.observedNote = observedNote;
  } else if (observedNote) {
    return `premise "${key}": observedNote needs observed (the measured number it describes)`;
  }
  return out;
}

/** The refusal text for a KPI premise without a receipt — the rule, verbatim (finding 1). */
export const KPI_RECEIPT_RULE = (key: string): string => {
  // Ticket 7862cb2a (the af24badf rule applied to the contract's OWN advice):
  // a long `kpi:` key used to spawn a `:diag` key over the cap — the refusal
  // then named a retry THIS module refuses. Strip EVERY `kpi:` prefix (a double
  // prefix used to yield `kpi:foo:diag`, which reads as ANOTHER KPI premise and
  // is refused for a missing receipt — the same dead end one level over).
  const bare = key.replace(/^(kpi:)+/i, '');
  // A key that ALREADY ends in `:diag` must not get a SECOND suffix — the rule
  // offered `games_flowing_to_sim:diag:diag` for the very spelling the contract
  // taught (family fdf5c19f, member 99b06f9e): legal, but a nonsense name for a
  // diagnostic that already IS one.
  const diag = shortenPremiseKey(/:diag$/i.test(bare) ? bare : `${bare}:diag`);
  const where = diag ? `(e.g. "${diag}")` : '(pick a new slug of letters/digits/_ . : -)';
  return `premise "${key}": a kpi: premise is the goal's ONE of-record number and is set ONLY from a this-wake run_command receipt id — pass receiptId (the \`id\` on the receipt row get_run_receipts prints for the lane that ran the probe, or that run's id), never a remembered figure, a derived ratio or an internal timer. A diagnostic-window / slow-regime / partial-config reading is NOT the KPI: register it under its own key ${where} with the config in its note.`;
};

/**
 * Ticket 443fa1ee (2026-11-01, lane 0037460b run 2816f4db — a 3×
 * goal_premise_set streak). Adjudication: the GUARDS are correct (barDirection
 * is bar semantics only the KPI readers consume), but the REFUSAL TEXT was a
 * dead end for the shape the caller actually sent — exactly the af24badf class
 * this file already fixed for the premise-cap message (a refusal whose advice
 * the very same module refuses again):
 *
 *   (1) It said "register it on the goal's 'kpi:' premise" for EVERY non-KPI
 *       key. A `target:` key is not a stray plain premise — done-suspect
 *       (TARGET_PREMISE_KEY_RE) reads it as the goal's target, and it carries
 *       its bound IN THE KEY (target_max_… / target_p95_ceiling = a ceiling,
 *       everything else = a floor). Moving that number onto the kpi: premise
 *       instead would stop it being a target premise at all. The advice was
 *       not merely unhelpful — following it loses the target semantics.
 *   (2) The kpi: path it named is often CLOSED when the caller reaches it: the
 *       failing goal held 12/12 premises with zero kpi: keys, so the advised
 *       write is refused at the cap (kpiAdviceCaveat). A refusal must never
 *       point at another refusal.
 *
 * The text below only fires for a `target:` key, names the bound implied by the
 * caller's own key, and teaches the shape that actually lands: the target keeps
 * `value` as its bar, and the MEASURED reading goes in observed + observedNote
 * (that is the reading `targetPremiseState` grades met/unmet from).
 */
function targetBarDirectionRefusal(key: string): string | null {
  if (!TARGET_PREMISE_KEY_RE.test(key)) return null;
  const bound = targetBound(key);
  const reads = bound === 'max' ? 'an UPPER bound: observed ≤ value is met' : 'a LOWER bound: observed ≥ value is met';
  return `premise "${key}" is a TARGET premise and carries its bar in \`value\` — its bound is declared by the KEY, not by barDirection ("${key}" reads as ${reads}; a key carrying max/ceiling/upper/at_most/under/below/le gets the ceiling). barDirection is KPI-bar semantics and is not read on a target premise, so drop it and record the measured reading instead: {key:"${key}", value:<the bar>, observed:<the measured number>, observedNote:"<run id / file / quoted line>"} — done-suspect grades that observed against value. Keep barDirection for the goal's ONE 'kpi:' premise (a kpi: key or kind:'kpi').`;
}

/**
 * Ticket faeaa181 (2026-11-02, lane e72931af run 741a5097 — a 3×
 * goal_premise_set streak on goal 79284e7f). The GUARD is correct and unchanged
 * (`barDirection` is bar semantics only the KPI readers consume); the REFUSAL
 * TEXT was the dead end, the third iteration of the af24badf class in this file.
 *
 * 443fa1ee fixed the `target:` arm and left this arm's wording alone on the
 * assumption that "a NON-target key keeps the original kpi: wording (no
 * behaviour change for the shape it fits)". The filed lane is the
 * counter-example: it held a plain metric key (`rerank_p95_servable_ms`) whose
 * bar is a CEILING, so it declared `barDirection:'down'` — forward-looking,
 * since 9fcd69ca taught "declare 'down' for every latency / p95 / error-rate /
 * budget-cap KPI" and the tool's own `barDirection` description says exactly
 * that. The old text answered by naming ONE path ("register it on the goal's
 * 'kpi:' premise"), and every attempt at that path dead-ended too:
 *
 *   · `kpi:<key>:diag` → the `kpi:` prefix makes it a SECOND KPI (refused by the
 *     one-of-record rule), and a KPI premise without a receipt is refused again;
 *   · `kpi:<key>` + the goal's OTHER rate as a second `kpi:` → same one-KPI cap;
 *   · while the goal ALREADY holds its KPI, the advised write is refused — the
 *     caveat says so, but the caveat is reachable ONLY via an already-registered
 *     kpi: (this call's own list is not consulted until after the per-premise
 *     loop), so the first refusal of a run still reads as "do this" with no
 *     shape that lands.
 *
 * Two facts make the advice wrong on its merits, not just incomplete:
 *   (1) `bar` is dead on a non-KPI premise for the SAME reason barDirection is —
 *       every reader (project-status, project-brief, goal-priority,
 *       adoption-ladder, done-suspect, goal-outcome) runs kpiBarText/kpiBarMet
 *       on a `kpiPremiseOf(...)` result, which is kpi:/kind:'kpi' only. So
 *       "keep bar, drop barDirection" would silently lose the bar.
 *   (2) `observed`/`observedNote` is graded by done-suspect only on a TARGET
 *       key, so a plain key cannot carry a graded reading either.
 *
 * The text below states the real placement rule (a numeric bar lives on the
 * goal's ONE kpi: premise — declare it there once, and re-register that same
 * `kpi:` key when the reading or the bar changes, rather than minting a second
 * KPI), names the shape that LANDS for this measurement right now (`value` =
 * the measurement, bar + its ceiling in the note), and says plainly what the
 * register does not offer on a plain key. It never advises a write this register
 * would refuse.
 */
function plainBarDirectionRefusal(key: string): string {
  return `premise "${key}": barDirection is a KPI-bar field — register it on the goal's 'kpi:' premise (kind:'kpi') — because every reader of it runs on that one premise, so here it would be a dead declaration. Declare the bar there once with {key:"kpi:...", value:<the reading>, bar:<the bar>, barDirection:"down", receiptId:"<this-wake run_command receipt>"}, and when the reading or the bar changes re-register THAT SAME kpi: key instead of minting a second one (a goal carries exactly ONE kpi: premise, so "kpi:${key}:diag" or a second rate under a kpi: key is refused). To record THIS measurement right now, register its own non-kpi key with value = the measured number and the bar + its ceiling in the note: {key:"${key}", value:<the measured number>, unit:"<unit>", note:"<bar> <unit> ceiling; <run id / file / quoted line>"} — \`bar\` is dead on a non-kpi key too (same readers), and a plain key has no graded \`observed\` (done-suspect grades observed only on a target_* premise and the kpi: premise).`;
}

/**
 * Whether the "move it onto the goal's 'kpi:' premise" advice can actually
 * land, given the register this call is merging onto — the af24badf rule
 * ("NEVER advise a retry this same branch would refuse again") applied to the
 * KPI path. Returns null when the kpi: write is open, else the caveat naming
 * why it is closed and the write that does land.
 */
function kpiAdviceCaveat(existing: GoalPremise[] | undefined, mode: 'merge' | 'replace', isTargetKey = false): string | null {
  if (!Array.isArray(existing)) return null;
  const kpiKeys = existing.filter((p) => isKpiPremise(p)).map((p) => String(p.key));
  // "the shape above" only makes sense when the refusal text taught it (a target key).
  const shape = isTargetKey ? ' (the shape above — its bound comes from the key)' : '';
  // A goal carries at most ONE kpi: premise — moving a SECOND number onto it is
  // impossible in both modes, so the caveat is unconditional.
  if (kpiKeys.length > 0) {
    return `NOTE: this goal already carries its kpi: premise ("${kpiKeys[0]}") and a goal carries at most ONE, so do NOT move this bar onto a kpi: key — register it under its own non-kpi key instead${shape}.`;
  }
  const projected = mode === 'replace' ? 1 : existing.length + 1;
  if (projected > PREMISE_MAX_PER_GOAL) {
    return `NOTE: the kpi: path is CLOSED on this goal right now — it already holds ${existing.length}/${PREMISE_MAX_PER_GOAL} premises with no kpi: key, so adding one is refused at the cap. Register the number under its own non-kpi key${shape}, or free a slot with mode:'replace' first.`;
  }
  return null;
}

/**
 * Mishap 99b06f9e (2026-11-07, ticket-lane family `tool-failure-streak`, session
 * c9868b86 run fad39f29 — a 3× `goal_premise_set` streak on goal f78208f8):
 * the fifth iteration of the af24badf class in this file, and the first where
 * the DEAD END was authored by the framework's own CONTRACT rather than by a
 * refusal text.
 *
 * The lane registered `games_flowing_to_sim`, then tried to register its
 * diagnostic reading and chose `kpi:games_flowing_to_sim:diag` — because BOTH
 * places that teach the naming convention said to:
 *   · the `goal_premise_set` key schema (`platform-tools.ts`: "Long enough for
 *     '<kpi key>:diag' (a diagnostic reading)"), and
 *   · the project Mission KPI contract fed to every supervisor
 *     (`role-profiles.ts`: "registers under its OWN key — `<kpi key>:diag`").
 * But `isKpiPremise` (kpi-of-record.ts) classifies ANY `kpi:`-prefixed key as
 * the KPI of record, so the taught spelling is refused as a SECOND KPI — and
 * the refusal said only "every other rate registers under a non-kpi key"
 * without ever naming the landing key. The lane repeated it (a third call
 * added a `kpi:…:diag` beside the plain key), and the breaker tripped.
 *
 * The fix is NOT to relax the one-per-goal guard (that guard is correct: the
 * `:diag` key really would become the of-record number and its bar would win).
 * Two things change: the two teaching sites stop prescribing the refused shape
 * and spell the landing key outright, and this refusal NAMES it — so a caller
 * that arrives with the taught spelling is corrected in ONE round-trip instead
 * of being told only what not to do.
 *
 * The advice is derived from the caller's OWN keys, so it never names a write
 * this register would refuse (af24badf's rule): the landing key for
 * `kpi:<bare>:diag` is `<bare>:diag`, which carries no prefix and is a plain,
 * accepted non-KPI key.
 */
export function kpiDiagLandingAdvice(kpis: Array<{ key: string }>): string {
  const landings: string[] = [];
  for (const p of kpis) {
    const raw = String(p.key ?? '');
    if (!/^kpi:/i.test(raw)) continue;
    // Strip EVERY `kpi:` prefix, exactly as KPI_RECEIPT_RULE does: stripping
    // one would name `kpi:a:diag` for a `kpi:kpi:a:diag` key — itself refused
    // as a second KPI, i.e. the dead end one level over (adversarial review,
    // this ticket).
    const bare = raw.replace(/^(kpi:)+/i, '');
    // Only the diagnostic SHAPE gets a named landing key: a plain second rate
    // has no canonical name to offer, so it keeps the generic instruction.
    if (!/:diag$/i.test(bare)) continue;
    // The offered key must ACTUALLY LAND (af24badf's rule). `shortenPremiseKey`
    // is this module's own authority on that: it legalises an illegal start
    // (`:diag`, `_x:diag`, `-x:diag` all become a key KEY_RE accepts), keeps a
    // `:diag` suffix, and returns '' when no legal form exists — those are
    // dropped rather than advised (adversarial review, this ticket).
    const k = shortenPremiseKey(bare);
    if (k && !landings.includes(k)) landings.push(k);
  }
  if (!landings.length) {
    return `A diagnostic reading goes under a key with NO \`kpi:\` prefix — the \`kpi:\` prefix is what makes a key the KPI of record, so \`kpi:<name>:diag\` is refused as a second one.`;
  }
  // Bounded: this answer is consumed after a head-slice (DISPLAY_RESULT_CAP in
  // coding/agent.ts) and a 1200-char capture on the breaker path, so a long
  // call must not push the actionable part past the cut.
  const MAX_NAMED = 4;
  const shown = landings.slice(0, MAX_NAMED).map((k) => `"${k}"`).join(', ');
  const more = landings.length > MAX_NAMED ? ` (+${landings.length - MAX_NAMED} more)` : '';
  const one = landings.length === 1;
  return `Drop the \`kpi:\` prefix from the diagnostic key(s): ${shown}${more} ${one ? 'is' : 'are'} the same reading as a plain, accepted non-KPI premise (a \`kpi:\` prefix is what makes a key the KPI of record, so \`kpi:<name>:diag\` is a SECOND one). Bar fields (\`bar\`/\`barDirection\`) are dead on a non-KPI key — put the bar and its ceiling in the note.`;
}

/**
 * Ticket 7862cb2a (the second half of the collision): the 12-key cap had a
 * SILENT side. A `mode:'replace'` call keeps exactly the keys it sends, so a
 * lane at the cap evicts whatever premise it happens to omit — and nothing on
 * the answer says which measured facts just stopped being drift-watched. A
 * live measured premise (`backlog:diar_silence_class = 532`) survived only as
 * prose in the goal note afterwards.
 *
 * The register cannot rank "load-bearing" for the caller, so it states the
 * FACT instead: these keys were registered and are not in this call, so they
 * are gone from the register — name them, and say how to keep them. Returns
 * null when nothing was dropped (the overwhelmingly common success path), so
 * an ordinary call's answer is byte-identical to before.
 */
export function premiseEvictionNotice(dropped: string[], mode: 'merge' | 'replace', kept: number): string | null {
  if (!dropped.length) return null;
  const n = dropped.length;
  const lines = [
    `NOTE: this replace left ${kept} premise(s) and DROPPED ${n} that ${n === 1 ? 'was' : 'were'} registered: ${dropped.join(', ')} — a replace keeps ONLY the keys in the call, so ${n === 1 ? 'it is' : 'they are'} no longer drift-watched, machine-checked or on the bus.`,
    `mode:'replace' is how a goal frees a slot for a new premise. If ${n === 1 ? 'that premise is' : 'any of these are'} still load-bearing, re-send ${n === 1 ? 'it' : 'them'} in the SAME array (the cap is ${PREMISE_MAX_PER_GOAL} premises; if the call would then hold more than ${PREMISE_MAX_PER_GOAL}, drop the NEW key you meant to add instead and say which fact you are retiring and why).`,
  ];
  return lines.join(' ');
}

/**
 * Ticket c58f0dc7 (2026-11-05, lane 0037460b run baedaee5 — a 3×
 * goal_premise_set streak on goal 8f0dcd6f, the SAME goal as 443fa1ee and
 * 7862cb2a). The fourth iteration of the af24badf class, and the first one
 * that was never an individual text's fault: EVERY refusal the lane received
 * was correct and, after #2243/#2286, self-describing. The defect is the ORDER
 * and the ARITY of disclosure.
 *
 * Reproduced against the shipped code (byte-for-byte, all three texts):
 *   call 1 → "backlog:auto_decrypt_rate_clips_per_hr": barDirection needs a bar
 *   call 2 → "target:auto_decrypt_clips_per_hr" is a TARGET premise …
 *   call 3 → a goal holds at most 12 premises (got 14: 12 already registered +
 *            2 new key(s) in this call)
 *
 * The lane re-sent the SAME array three times. Each call carried THREE
 * independent defects — two per-premise placement errors AND a whole-call cap
 * overflow — but `normalizePremises` returned at the FIRST per-premise failure
 * and evaluated the cap only AFTER the loop (it needs the merged set). So the
 * caller could not see the cap until both placement errors were fixed, and
 * fixing them was itself two round-trips. Three defects, three calls, one
 * breaker trip. The guards were never wrong; the DISCLOSURE was serial.
 *
 * af24badf's rule — "NEVER advise a retry this same branch would refuse again"
 * — generalised: a refusal must never make the caller pay a round-trip for a
 * defect this call ALREADY knows about. So every independent per-premise
 * failure is collected and reported together, and — when it is CERTAIN — the
 * whole-call cap overflow is disclosed in the same answer.
 *
 * THE CERTAINTY RULE (adversarial review 2026-11-05, this ticket). The cap is a
 * property of the MERGED set, so while some premises are still invalid the
 * final size is not knowable — a repair can collide with an already-registered
 * key and add nothing. A first cut counted the keys AS SENT and thereby broke
 * af24badf's rule in the opposite direction: it predicted an overflow the
 * corrected call would NOT hit (12 valid keys + one keyless stray, replace
 * mode → "1 key must go" while the repaired call LANDS), which is a refusal
 * pointing at a retry this branch ACCEPTS. So:
 *   · CERTAIN — the premises that DID validate already overflow. Every one of
 *     them is in the final set, so this cannot be repaired away. Assert it.
 *   · POSSIBLE — only the invalid ones could push it over. State the counts and
 *     the worst case as an upper bound ("if each lands as its own premise"),
 *     name the merge-onto-a-registered-key repair that would fit, and never
 *     claim the call is over.
 *   · Otherwise say nothing about the cap.
 * The one thing this must never do is stay SILENT when the caller is about to
 * hit the cap — that silence is the paid round-trip the ticket exists to
 * remove.
 *
 * Bounds (same review): the answer is bounded, because it is consumed after a
 * head-slice downstream — `DISPLAY_RESULT_CAP = 8000` in coding/agent.ts and a
 * 1200-char capture on the breaker path. An unbounded list buried the cap
 * notice past the cut (8 verbose defects already ran to 11,161 chars, with the
 * notice at char 10,220). So the cap block goes FIRST and the list is capped.
 *
 * Byte-compatibility: a call with exactly ONE blocking defect that does NOT
 * touch the cap returns exactly the text it returned before (the pins in
 * af24badf / 7862cb2a / 443fa1ee / faeaa181 and the kpi: contract assert those
 * verbatim). A one-defect call that ALSO overflows necessarily gets the
 * enumerated form — that is the whole point, since the bare text is what hid
 * the cap.
 *
 * NOT fixed here (named, not claimed closed): the whole-call ONE-KPI gate
 * (`at most ONE kpi: premise`) is still evaluated serially after this point, so
 * a call carrying both a placement error and two `kpi:` keys still needs two
 * calls. Same class, smaller blast radius; left to its own change.
 */
function multiPremiseRefusal(problems: string[], cap: { certain: boolean; text: string } | null): string {
  const MAX_SHOWN = 5;
  const one = problems.length === 1;
  const shown = problems.slice(0, MAX_SHOWN).map((e, i) => `(${i + 1}) ${e}`).join(' ');
  const more = problems.length > MAX_SHOWN ? ` …and ${problems.length - MAX_SHOWN} more invalid premise(s); every one is checked the same way.` : '';
  const list = `${shown}${more}`;
  // The cap block leads: it is the whole-call fact, and a downstream head-slice
  // must never be able to cut it off.
  if (cap) {
    const lead = cap.certain
      ? `THIS CALL CANNOT LAND EVEN IF THE INVALID PREMISE(S) BELOW ARE FIXED — the premise(s) that DID validate already overflow the cap: ${cap.text}`
      : `ALSO CHECK THE SIZE BEFORE RE-SENDING — ${cap.text}`;
    const tail = cap.certain
      ? `The ${problems.length} invalid premise(s) below are a SEPARATE problem; fix both the list and the size, then re-send once.`
      : `The ${problems.length} invalid premise(s) below are a SEPARATE problem; fixing them alone may still leave the call over the cap.`;
    return `${lead} ${tail} ${list}`;
  }
  const head = `${problems.length} premise${one ? '' : 's'} in this call ${one ? 'is' : 'are'} invalid. Each is checked independently, so fixing ${one ? 'it' : 'them'} ONE PER CALL costs one refused round-trip per defect — fix ${one ? 'it' : 'ALL of them'} and re-send once.`;
  return `${head} ${list}`;
}

/**
 * The CAP arithmetic, shared with the real cap branch so the two cannot state
 * different numbers for the same set (the branch's own text is pinned verbatim
 * by 0aeb8844 / af24badf / 7862cb2a). Returns null when `keys` fits.
 *
 * It is fed a KEY LIST, not a call: the certain path passes only the premises
 * that validated, the possible path passes the union an unrepaired call would
 * produce. Callers own which question they are asking.
 */
function premiseCapError(priorKeys: string[], incomingKeys: string[], mode: 'merge' | 'replace'): string | null {
  const uniq = (ks: string[]): string[] => {
    const m = new Map<string, string>();
    for (const k of ks) if (!m.has(k.toLowerCase())) m.set(k.toLowerCase(), k);
    return [...m.values()];
  };
  const inc = uniq(incomingKeys);
  // A merge unions onto the stored register ('byKey' is lowercased, so the
  // union is deduped); a replace keeps only the keys it is sent.
  const union = mode === 'replace' ? inc : uniq([...priorKeys, ...inc]);
  if (union.length <= PREMISE_MAX_PER_GOAL) return null;
  const over = union.length - PREMISE_MAX_PER_GOAL;
  const n = `${over} key${over === 1 ? '' : 's'}`;
  if (inc.length > PREMISE_MAX_PER_GOAL) {
    const why = mode === 'replace'
      ? 'a replace keeps exactly the keys it is sent, so nothing already registered offsets it'
      : 'the call itself is over the cap before the goal is even considered';
    return `a goal holds at most ${PREMISE_MAX_PER_GOAL} premises (got ${union.length}) — this call sends ${inc.length} keys, ${why}, so ${n} must go from this call: the call itself must shrink (re-sending the same set is refused again in either mode)`;
  }
  if (priorKeys.length > PREMISE_MAX_PER_GOAL) {
    return `a goal holds at most ${PREMISE_MAX_PER_GOAL} premises (got ${union.length}) — this goal ALREADY holds ${priorKeys.length}, more than the cap, so dropping keys from this call cannot bring it under it; send the ≤${PREMISE_MAX_PER_GOAL}-key set you want it to KEEP with mode:'replace' (a replace keeps ONLY the keys in the call — re-send the keys you still need and omit the rest)`;
  }
  const newKeys = Math.max(0, union.length - priorKeys.length);
  return `a goal holds at most ${PREMISE_MAX_PER_GOAL} premises (got ${union.length}: ${priorKeys.length} already registered + ${newKeys} new key(s) in this call) — ${n} must go: drop at least ${over} of the NEW key(s) (dropping one you merely re-sent moves nothing — it is already registered), or send the ≤${PREMISE_MAX_PER_GOAL}-key set you want it to KEEP with mode:'replace' (a replace keeps ONLY the keys in the call, so re-send every already-registered key you still need; ANY registered key you omit is RETIRED from the register and named back to you as an eviction). Already registered: ${priorKeys.join(', ')}`;
}

/**
 * The cap heads-up for a call that ALSO carries invalid premises. `validKeys`
 * are the premises that validated (certain to land); `intendedKeys` are every
 * slot the call sends, INCLUDING a unique placeholder per keyless/!object
 * element and the RAW (unclipped) text of a key that failed validation, so two
 * distinct over-long keys never collapse into one phantom slot and a keyless
 * stub is never silently dropped.
 *
 * Returns null when the cap is not in play, so an ordinary refusal's answer is
 * byte-identical to before.
 */
function capNoticeForInvalidCall(
  priorKeys: string[], validKeys: string[], intendedKeys: string[], mode: 'merge' | 'replace',
): { certain: boolean; text: string } | null {
  const certain = premiseCapError(priorKeys, validKeys, mode);
  if (certain) return { certain: true, text: certain };
  // Not certain: report the WORST CASE as an upper bound, and name the repair
  // that makes it fit. Never asserted as an overflow.
  const possible = premiseCapError(priorKeys, intendedKeys, mode);
  if (!possible) return null;
  const uniq = new Set(intendedKeys.map((k) => k.toLowerCase())).size;
  const upper = mode === 'replace'
    ? uniq
    : new Set([...priorKeys.map((k) => k.toLowerCase()), ...intendedKeys.map((k) => k.toLowerCase())]).size;
  return {
    certain: false,
    text: `the goal holds ${priorKeys.length} of its ${PREMISE_MAX_PER_GOAL} premises and this call sends ${uniq} premise slot(s), so if each becomes its own premise the corrected call would hold up to ${upper} (cap ${PREMISE_MAX_PER_GOAL}). If your repair MERGES an invalid premise onto a key that is already registered it fits and no trimming is needed; otherwise drop enough to fit.`,
  };
}

/**
 * Append the af24badf caveat to a barDirection-placement refusal when the
 * `kpi:` write it advises would itself be refused by THIS register. Only
 * applied to refusals that actually point at the kpi: path — every other
 * validation error is returned untouched.
 */
function withKpiAdviceCaveat(error: string, existing: GoalPremise[] | undefined, mode: 'merge' | 'replace'): string {
  if (!/barDirection (?:is a KPI-bar field|needs a bar)/.test(error)) return error;
  const caveat = kpiAdviceCaveat(existing, mode, /is a TARGET premise/.test(error));
  return caveat ? `${error} ${caveat}` : error;
}

/** Why the KPI contract refused a goal_premise_set call — the loop_metrics kpi_premise_refused reason (fixer follow-up 5). */
export type KpiRefusalReason = 'no_receipt' | 'second_kpi' | 'receipt_missing' | 'receipt_not_ok' | 'other_project';
const KPI_RECEIPT_RULE_RE = /^premise "([^"]+)": a kpi: premise is the goal's ONE of-record number/;
/** The key a KPI_RECEIPT_RULE refusal names, or null for any other validation error (pure; keyed on the rule text itself). */
export const kpiReceiptRefusalKey = (error: string): string | null => KPI_RECEIPT_RULE_RE.exec(String(error ?? ''))?.[1] ?? null;

const sameReader = (a: GoalPremise, b: GoalPremise): boolean =>
  a.value === b.value && (a.source ?? '') === (b.source ?? '') && (a.jsonPath ?? '') === (b.jsonPath ?? '') && (a.pattern ?? '') === (b.pattern ?? '');
const STAMP_FIELDS: Array<keyof GoalPremise> = ['checkedAt', 'observed', 'observedAt', 'observedNote', 'drift', 'driftNote', 'lastError', 'lastErrorAt', 'prev', 'history'];
/** Finding C3: a revision stamp survives a same-value re-registration (the board keeps naming it for its window). */
const REVISION_FIELDS: Array<keyof GoalPremise> = ['prevValue', 'prevManifest', 'revisedAt'];
const OBSERVED_FIELDS = new Set<keyof GoalPremise>(['observed', 'observedAt', 'observedNote']);

/**
 * Finding 2a (tt-rd audit 2026-09-27): a premise whose VALUE changed keeps
 * what it replaced — `prev` {value, setAt, receiptId} and an oldest-first ring
 * of ≤ PREMISE_HISTORY_MAX superseded values — so the board can show
 * "last change 5.364→2.464 @03:34Z" and the adoption-ladder signal can find
 * the last receipted move toward the bar. Schema-free (JSON on the row).
 */
export function withHistory(prev: GoalPremise, next: GoalPremise): GoalPremise {
  if (Number(prev.value) === Number(next.value)) {
    // Reader/source changed but the value did not: carry the ring forward untouched.
    return { ...next, ...(prev.prev ? { prev: prev.prev } : {}), ...(prev.history?.length ? { history: prev.history } : {}) };
  }
  const stamp: PremiseValueStamp = { value: Number(prev.value), ...(prev.setAt ? { setAt: prev.setAt } : {}), ...(prev.receiptId ? { receiptId: prev.receiptId } : {}) };
  const history = [...(Array.isArray(prev.history) ? prev.history : []), stamp].slice(-PREMISE_HISTORY_MAX);
  return { ...next, prev: stamp, history };
}

// ── Revisions (finding C3, 2026-09-27) ──────────────────────────────────────
//
// Why: goal_premise_set merged by key and silently overwrote — spark's
// draft2g_tg32_mean_tps went 30.88 → 18.60 on the same stack and no note, wake
// or board line ever named the regression. A beyond-tolerance re-registration
// is now a REVISION: the premise carries prevValue/prevManifest/revisedAt, the
// caller (goals.service) records `premise_revised` and the [BOARD] block
// prepends a PREMISE REVISIONS line for 72h. Pure here. Always on — the
// PREMISE_REVISION_DISABLED release switch was removed 2026-10-31 (RSW-1
// cohort delete); a beyond-tolerance re-registration is always a REVISION.

export interface PremiseRevision {
  key: string;
  old: number;
  new: number;
  /** signed percent change vs |old|; null when old is 0 */
  pct: number | null;
  unit?: string;
  oldManifest?: string;
  newManifest?: string;
  /** true = same manifest on both sides; false = they differ; null = at least one side has none */
  manifestMatch: boolean | null;
  /** the one-line rendering the board and the tool answer carry */
  line: string;
}

export const premiseTolerance = (a: Partial<GoalPremise> | undefined, b: Partial<GoalPremise> | undefined): number =>
  Math.max(0, Number(a?.tolerance) || 0, Number(b?.tolerance) || 0);

export const premiseRevisionPct = (oldValue: number, newValue: number): number | null =>
  oldValue === 0 || !Number.isFinite(oldValue) || !Number.isFinite(newValue) ? null : ((newValue - oldValue) / Math.abs(oldValue)) * 100;

const fmtNum = (n: number): string => (Number.isInteger(n) ? String(n) : String(Number(n.toFixed(4))));
const fmtPct = (pct: number | null): string => (pct === null ? 'from 0' : `${pct > 0 ? '+' : pct < 0 ? '-' : ''}${Math.abs(pct) >= 10 ? Math.round(Math.abs(pct)) : Number(Math.abs(pct).toFixed(1))}%`);

/** "premise draft2g_tg32_mean_tps revised 30.88→18.6 tok/s (-40%)" (+ " — manifest a→b, not like-for-like" when the manifests differ). */
export function formatPremiseRevision(r: Omit<PremiseRevision, 'line'>): string {
  const unit = r.unit ? String(r.unit) : '';
  const manifest = r.oldManifest && r.newManifest && r.oldManifest !== r.newManifest
    ? ` — manifest ${r.oldManifest}→${r.newManifest}, not like-for-like`
    : r.newManifest && !r.oldManifest ? ` [${r.newManifest}]` : '';
  return `premise ${r.key} revised ${fmtNum(r.old)}→${fmtNum(r.new)}${unit} (${fmtPct(r.pct)})${manifest}`;
}

/** A REVISION is a same-key re-registration whose value moved beyond the (larger) tolerance of either side. */
export function detectPremiseRevision(prev: GoalPremise | undefined, next: GoalPremise): PremiseRevision | null {
  if (!prev || !Number.isFinite(prev.value) || !Number.isFinite(next.value)) return null;
  if (Math.abs(next.value - prev.value) <= premiseTolerance(prev, next) + 1e-9) return null;
  const base: Omit<PremiseRevision, 'line'> = {
    key: next.key, old: prev.value, new: next.value, pct: premiseRevisionPct(prev.value, next.value),
    ...(next.unit || prev.unit ? { unit: next.unit ?? prev.unit } : {}),
    ...(prev.manifest ? { oldManifest: prev.manifest } : {}),
    ...(next.manifest ? { newManifest: next.manifest } : {}),
    manifestMatch: prev.manifest && next.manifest ? prev.manifest === next.manifest : null,
  };
  return { ...base, line: formatPremiseRevision(base) };
}

/**
 * Validate a whole set. mode 'merge' upserts by key onto `existing` (keeping
 * an unchanged premise's check stamps); 'replace' rewrites the set.
 *
 * Returns the premises, or a refusal. Ticket c58f0dc7: the refusal is no longer
 * "the first validation error" — every independent per-premise failure is
 * collected and returned together (see `multiPremiseRefusal`), together with a
 * cap heads-up when the call's size is in play, so a caller never pays one
 * refused round-trip per defect. A call with exactly one blocking defect that
 * does not touch the cap still returns that defect's text verbatim.
 */
export function normalizePremises(
  rawList: unknown,
  existing: GoalPremise[],
  opts: { mode?: 'merge' | 'replace'; setByChatId?: string | null; now?: Date } = {},
): { ok: true; premises: GoalPremise[]; revisions: PremiseRevision[]; dropped: string[] } | { ok: false; error: string; kpiRefusal?: { reason: KpiRefusalReason; key: string } } {
  if (!Array.isArray(rawList)) return { ok: false, error: 'premises must be an array of {key, value, unit?, note?, manifest?, compareTo?, source?, jsonPath?|pattern?, tolerance?, bar?, barDirection?, receiptId?}' };
  const mode = opts.mode === 'replace' ? 'replace' : 'merge';
  const incoming: GoalPremise[] = [];
  const seen = new Set<string>();
  // Ticket 9fcd69ca: keys whose raw input EXPLICITLY carried 'auto' — the one
  // spelling that clears a retained declaration back to inference. An omitted
  // barDirection is an omission (semantics persist), never a clear.
  const explicitAutoDirection = new Set<string>();
  // The PRIOR set, both modes: receipt inheritance (KPI contract) and — finding C3 —
  // revisions compare against it (a 'replace' that moves a key's value is exactly
  // the silent overwrite C3 names).
  const priorByKey = new Map<string, GoalPremise>((Array.isArray(existing) ? existing : []).map((p) => [String(p.key).toLowerCase(), p]));
  // Ticket c58f0dc7: every independent per-premise failure is COLLECTED, not
  // returned at the first one. The filed lane re-sent one payload three times
  // because each call disclosed a single defect and the whole-call cap was not
  // even evaluated until the per-premise loop passed. See multiPremiseRefusal.
  const problems: string[] = [];
  let kpiRefusalOut: { reason: KpiRefusalReason; key: string } | undefined;
  // The slots this call SENDS, for the POSSIBLE-overflow side of the cap
  // heads-up. Review c58f0dc7: a keyless/non-object element must not collapse
  // into one shared phantom slot, and an over-long key must be kept RAW (not
  // clipped at PREMISE_KEY_MAX+1) or two distinct over-long keys dedupe into
  // one — both made the notice silently absent where it was needed.
  const intendedKeys: string[] = [];
  for (const rawIn of rawList as PremiseInput[]) {
    if (rawIn && typeof rawIn === 'object') {
      const rawKey = (rawIn as { key?: unknown }).key;
      // Distinct placeholder per keyless slot so each stays its own slot.
      intendedKeys.push(typeof rawKey === 'string' && rawKey.trim() ? rawKey.trim().toLowerCase() : `\u0000slot:${intendedKeys.length}`);
      const bd = (rawIn as { barDirection?: unknown }).barDirection;
      if (bd !== undefined && bd !== null && String(bd).trim().toLowerCase() === 'auto') {
        explicitAutoDirection.add(str((rawIn as { key?: unknown }).key, PREMISE_KEY_MAX + 1).toLowerCase());
      }
    } else {
      intendedKeys.push(`\u0000slot:${intendedKeys.length}`);
    }
    // A re-send of an UNCHANGED receipted value without its receipt (a full-set
    // mode:'replace' trim, a merge that repeats the KPI) inherits the receipt it
    // already has — the contract asks for a receipt per NEW reading, not per call.
    let raw = rawIn;
    let inheritedFrom: GoalPremise | null = null;
    if (raw && typeof raw === 'object' && (raw.receiptId === undefined || raw.receiptId === null || String(raw.receiptId).trim() === '')) {
      const prior = priorByKey.get(str(raw.key, PREMISE_KEY_MAX + 1).toLowerCase());
      if (prior?.receiptId && num(raw.value) !== null && Number(prior.value) === num(raw.value)) { raw = { ...raw, receiptId: prior.receiptId }; inheritedFrom = prior; }
    }
    const p = normalizePremise(raw, opts);
    if (typeof p === 'string') {
      // A KPI-contract refusal is tagged so goals.service can record it (every other validation error is a shape error, not a gate).
      const refusedKey = kpiReceiptRefusalKey(p);
      if (refusedKey && !kpiRefusalOut) kpiRefusalOut = { reason: 'no_receipt' as const, key: refusedKey };
      // Ticket 443fa1ee: never let a refusal point at a kpi: write THIS register
      // would refuse again (af24badf rule — a dead end one turn later). The
      // tag above is computed on the original text; the caveat only ever
      // touches barDirection-placement errors, which carry no tag.
      problems.push(withKpiAdviceCaveat(p, existing, mode));
      continue;
    }
    // An inherited receipt is the SAME reading: it keeps its measurement stamp (age on the board = when it was measured).
    if (inheritedFrom?.setAt) p.setAt = inheritedFrom.setAt;
    const k = p.key.toLowerCase();
    if (seen.has(k)) { problems.push(`premise "${p.key}" given twice`); continue; }
    seen.add(k);
    incoming.push(p);
  }
  // Ticket c58f0dc7: disclose EVERY independent defect in this ONE answer —
  // the per-premise failures collected above AND, when it can be said with
  // certainty (or as a bounded upper-bound heads-up), the whole-call cap
  // overflow that the old code could not even evaluate until the loop had
  // passed. A single blocking defect that does not touch the cap still returns
  // exactly the text it returned before (the pins in af24badf / 7862cb2a /
  // 443fa1ee / faeaa181 / the kpi: contract assert those verbatim).
  if (problems.length) {
    const priorKeys = (Array.isArray(existing) ? existing : []).map((p) => String(p.key));
    // CERTAIN = the premises that DID validate already overflow. Every one is in
    // the final set, so no repair of the invalid ones can bring it under the cap.
    const capNotice = capNoticeForInvalidCall(priorKeys, incoming.map((p) => p.key), intendedKeys, mode);
    const error = (problems.length === 1 && !capNotice)
      ? problems[0]
      : multiPremiseRefusal(problems, capNotice);
    return { ok: false, error, ...(kpiRefusalOut ? { kpiRefusal: kpiRefusalOut } : {}) };
  }
  const prior = Array.isArray(existing) ? existing : [];
  const base = mode === 'replace' ? [] : prior;
  const byKey = new Map<string, GoalPremise>(base.map((p) => [p.key.toLowerCase(), p]));
  const revisions: PremiseRevision[] = [];
  for (const p of incoming) {
    const prev = byKey.get(p.key.toLowerCase());
    const before = priorByKey.get(p.key.toLowerCase());
    const revision = detectPremiseRevision(before, p);
    // Same value + same source ⇒ the old check stamps are still meaningful.
    if (prev && sameReader(prev, p)) {
      const kept: GoalPremise = { ...p };
      // A manually recorded `observed` in THIS call wins over the old stamp
      // (finding 1); every other stamp carries over unchanged.
      const manual = p.observed !== undefined;
      for (const f of STAMP_FIELDS) {
        if (manual && OBSERVED_FIELDS.has(f)) continue;
        if (prev[f] !== undefined) (kept as any)[f] = prev[f];
      }
      for (const f of REVISION_FIELDS) if (prev[f] !== undefined) (kept as any)[f] = prev[f];
      // A receipted reading is not refreshed by a receipt-less re-send of the
      // same value: it keeps its receipt AND its measurement stamp (age on the
      // board = when it was measured). A fresh receipt is a fresh reading.
      if (prev.receiptId && (!kept.receiptId || kept.receiptId === prev.receiptId)) {
        kept.receiptId = prev.receiptId;
        if (prev.setAt) kept.setAt = prev.setAt;
      }
      byKey.set(p.key.toLowerCase(), kept);
    } else if (revision && before) {
      const revised: GoalPremise = { ...p, prevValue: before.value, revisedAt: p.setAt ?? (opts.now ?? new Date()).toISOString() };
      if (before.manifest) revised.prevManifest = before.manifest;
      revisions.push(revision);
      byKey.set(p.key.toLowerCase(), prev ? withHistory(prev, revised) : revised);
    } else {
      // A within-tolerance nudge (or a reader change) keeps the prior revision record.
      const next: GoalPremise = { ...p };
      if (before) for (const f of REVISION_FIELDS) if (before[f] !== undefined) (next as any)[f] = before[f];
      byKey.set(p.key.toLowerCase(), prev ? withHistory(prev, next) : next);
    }
  }
  const premises = [...byKey.values()];
  // Ticket 7862cb2a: the keys a REPLACE silently retired (registered before,
  // absent from this call). 'merge' never drops — it can only overflow the cap,
  // which is refused above with its own arithmetic — so this is replace-only.
  const droppedKeys = mode === 'replace'
    ? prior.filter((p) => p && typeof p.key === 'string' && !byKey.has(String(p.key).toLowerCase())).map((p) => String(p.key))
    : [];
  // Ticket 9fcd69ca: the bar's DIRECTION is bar SEMANTICS, not a reading — an
  // omitted barDirection on a re-registered KPI keeps the prior declaration
  // (every branch above), an explicit one re-declares, and an EXPLICIT 'auto'
  // is the one spelling that clears it back to inference. Applied AFTER the
  // per-branch merges so a fresh receipted reading (the revision path) keeps
  // its ceiling semantics too.
  // (Cannot mutate the caller's `existing` rows: every `premises` element here
  // is an object normalizePremise built this call — `byKey` re-keyed them — so
  // the retain/clear writes land on OUR copies only. Verified by review probe,
  // 4112375b M1.)
  for (const p of premises) {
    const k = p.key.toLowerCase();
    if (p.barDirection === undefined && priorByKey.get(k)?.barDirection !== undefined && !explicitAutoDirection.has(k)) {
      p.barDirection = priorByKey.get(k)?.barDirection;
    }
    if (explicitAutoDirection.has(k) && p.barDirection !== undefined) {
      delete p.barDirection;
    }
  }
  // Finding 2e: the `kpi:` prefix is reserved — ONE KPI premise per goal.
  const kpis = premises.filter((p) => isKpiPremise(p));
  if (kpis.length > 1) {
    return {
      ok: false,
      error: `a goal carries at most ONE kpi: premise (got ${kpis.map((p) => p.key).join(', ')}) — the of-record number has one key; every other rate registers under a non-kpi key. ${kpiDiagLandingAdvice(incoming.filter((p) => isKpiPremise(p)))}`,
      kpiRefusal: { reason: 'second_kpi', key: kpis.map((p) => p.key).join(', ') },
    };
  }
  if (premises.length > PREMISE_MAX_PER_GOAL) {
    // Mishap 0aeb8844 (2026-09-24): a lane at the cap that merges one new
    // premise is refused with a bare count — no arithmetic, no escape hatch —
    // and re-sends the same array (2× identical refusals on CanLaw). The
    // refusal must name WHY the union overflowed and the mode:'replace' path,
    // but only when replace would actually land inside the cap (an over-cap
    // input array has no hatch).
    //
    // Mishap af24badf (2026-10-30) — the hatch advice itself dead-ended, one
    // level up. The merge refusal said "resend the full intended set with
    // mode:'replace'" UNCONDITIONALLY; a lane holding 11 premises that wanted
    // to keep 3 more followed it verbatim (11 + 3 = 14 intended), and the
    // replace branch refused THAT with the bare text — no arithmetic, no
    // hatch — because a replace keeps every key you send and 14 > 12. So the
    // one instruction the refusal gave sent the caller into a second dead end
    // and burned the tool round the message exists to save (the model then
    // spent a third call regaining it). Rule now enforced here: NEVER advise a
    // retry this same branch would refuse again, and always state the KEY
    // COUNT the caller is trying to keep and how many must go. The hatch is
    // the ≤cap set the goal should END with — never "the full intended set",
    // which is exactly the set that does not fit.
    //
    // Ticket c58f0dc7: the TEXT now comes from `premiseCapError` — the same
    // helper `capNoticeForInvalidCall` uses to warn an invalid call ahead of
    // time. That is what makes the two statements ONE source of truth instead
    // of two hand-copied literals (adversarial review, this ticket: the first
    // cut claimed this and did not do it, so "the projection cannot drift" was
    // false). `premise-register.c58f0dc7.test.ts` pins the equality.
    const capError = premiseCapError(prior.map((p) => p.key), incoming.map((p) => p.key), mode);
    if (capError) {
      // `prior` can hold a duplicate key only if a legacy row was hand-written;
      // the union arithmetic above is the authority on the count, so keep its
      // headline when the helper (which dedupes) disagrees.
      const dedupedUnion = new Set([...prior, ...incoming].map((p) => p.key.toLowerCase())).size;
      return {
        ok: false,
        error: dedupedUnion === premises.length
          ? capError
          : `a goal holds at most ${PREMISE_MAX_PER_GOAL} premises (got ${premises.length}) — ${premises.length - PREMISE_MAX_PER_GOAL} key(s) must go: send the ≤${PREMISE_MAX_PER_GOAL}-key set you want it to KEEP with mode:'replace' (a replace keeps ONLY the keys in the call)`,
      };
    }
  }
  return { ok: true, premises, revisions, dropped: droppedKeys };
}

/** Read stored JSON back as premises (tolerant of legacy/garbage rows). */
export function readPremises(json: unknown): GoalPremise[] {
  if (!Array.isArray(json)) return [];
  return (json as any[]).filter((p) => p && typeof p === 'object' && typeof p.key === 'string' && Number.isFinite(Number(p.value)))
    .map((p) => ({ ...p, value: Number(p.value) }));
}

// ── Source re-check ──────────────────────────────────────────────────────────

/** Private / loopback / link-local / unspecified / metadata ranges — refused as fetch targets (SSRF guard). */
export function isBlockedAddress(ip: string): boolean {
  const v4 = ip.match(/^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/i);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true; // multicast + reserved + broadcast
    return false;
  }
  const v6 = ip.toLowerCase();
  if (v6 === '::' || v6 === '::1') return true;
  if (/^f[cd][0-9a-f]{2}:/.test(v6)) return true; // fc00::/7 unique local
  if (/^fe[89ab][0-9a-f]:/.test(v6)) return true; // fe80::/10 link local
  if (v6.startsWith('::ffff:')) return true; // v4-mapped that did not parse above
  return false;
}

export function isBlockedHostname(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || h === 'metadata.google.internal';
}

const withTimeout = <T>(p: Promise<T>, ms: number, label: string): Promise<T> => new Promise<T>((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(label)), ms);
  (t as any).unref?.();
  p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
});

async function assertPublicHost(url: URL): Promise<void> {
  if (url.protocol !== 'https:') throw new Error('source must be https');
  if (isBlockedHostname(url.hostname)) throw new Error(`source host "${url.hostname}" is not reachable from here`);
  const bare = url.hostname.replace(/^\[|\]$/g, '');
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(bare) || bare.includes(':')) {
    if (isBlockedAddress(bare)) throw new Error('source address is private');
    return;
  }
  const addrs = await withTimeout(dns.lookup(url.hostname, { all: true }), PREMISE_DNS_TIMEOUT_MS, 'source host lookup timed out');
  if (!addrs.length) throw new Error('source host did not resolve');
  for (const a of addrs) if (isBlockedAddress(a.address)) throw new Error('source resolves to a private address');
}

export interface FetchedBody { body: string; contentType: string }

/** https-only bounded fetch: DNS-checked hosts, ≤2 manual redirects (each re-checked), 10s, 1 MB.
 *  `extraHeaders` (delta gate, ticket 0b1dbe75 — probe auth) merge OVER the
 *  default headers: defaults first, the caller's win. Values are never echoed
 *  back (they may carry secrets). */
export async function fetchPremiseSource(source: string, fetchImpl: typeof fetch = fetch, extraHeaders?: Record<string, string>): Promise<FetchedBody> {
  let url = new URL(source);
  for (let hop = 0; hop <= PREMISE_FETCH_MAX_REDIRECTS; hop++) {
    await assertPublicHost(url);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), PREMISE_FETCH_TIMEOUT_MS);
    try {
      const res = await fetchImpl(url.toString(), {
        redirect: 'manual',
        signal: ctl.signal,
        headers: {
          'user-agent': 'digby-premise-check/1 (+https://digby.ai)',
          accept: 'application/json, text/plain, text/*;q=0.8, */*;q=0.5',
          ...(extraHeaders ?? {}),
        },
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (!loc) throw new Error(`redirect ${res.status} without location`);
        url = new URL(loc, url);
        continue;
      }
      if (!res.ok) throw new Error(`source returned HTTP ${res.status}`);
      const len = Number(res.headers.get('content-length') ?? 0);
      if (len > PREMISE_FETCH_MAX_BYTES) throw new Error('source body exceeds 1 MB');
      const reader = res.body?.getReader();
      let body = '';
      if (reader) {
        const dec = new TextDecoder();
        let total = 0;
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > PREMISE_FETCH_MAX_BYTES) { await reader.cancel().catch(() => {}); throw new Error('source body exceeds 1 MB'); }
          body += dec.decode(value, { stream: true });
        }
        body += dec.decode();
      } else {
        body = await res.text();
        if (body.length > PREMISE_FETCH_MAX_BYTES) throw new Error('source body exceeds 1 MB');
      }
      return { body, contentType: String(res.headers.get('content-type') ?? '') };
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error('too many redirects');
}

/** Walk a dot/bracket path through parsed JSON. */
export function readJsonPath(root: unknown, path: string): unknown {
  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  let cur: any = root;
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[p];
  }
  return cur;
}

/**
 * Run a user-registered pattern under a hard wall-clock bound: V8 checks for
 * interrupts while backtracking, so a vm timeout terminates a catastrophic
 * match (verified: (a+)+$ on 40 bytes terminates at the deadline). The body
 * is capped too. Returns 'timeout' when the deadline fired.
 *
 * ONE bounded attempt — callers facing wall-clock false positives (the process
 * descheduled mid-match under CPU contention) retry at their layer:
 * extractObserved retries ONCE before reporting (ticket 640c3bb5).
 */
export function safeMatch(pattern: string, body: string, timeoutMs: number = PREMISE_PATTERN_TIMEOUT_MS): RegExpExecArray | null | 'timeout' {
  const re = new RegExp(pattern, 'i');
  try {
    return vm.runInNewContext('re.exec(s)', { re, s: body.slice(0, PREMISE_PATTERN_BODY_CAP) }, { timeout: Math.max(10, timeoutMs) });
  } catch (err: any) {
    if (err?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') return 'timeout';
    throw err;
  }
}

/** The observed number from a fetched body per the premise's reader; an error string when unreadable. */
export function extractObserved(fetched: FetchedBody, p: GoalPremise, matchImpl: typeof safeMatch = safeMatch): { observed: number } | { error: string } {
  if (p.jsonPath) {
    let parsed: unknown;
    try { parsed = JSON.parse(fetched.body); } catch { return { error: 'source body is not JSON' }; }
    const v = num(readJsonPath(parsed, p.jsonPath));
    return v === null ? { error: `jsonPath "${p.jsonPath}" did not read a number` } : { observed: v };
  }
  if (p.pattern) {
    let m: RegExpExecArray | null | 'timeout';
    try { m = matchImpl(p.pattern, fetched.body); } catch { return { error: 'pattern is not a valid regex' }; }
    // The vm timeout is a WALL-CLOCK budget in this process: under CPU
    // contention (the 2026-09-20 full-suite auto-verify flake, ticket
    // 640c3bb5) the process can be descheduled mid-match and even a trivial
    // non-matching pattern "times out". Retry ONCE before reporting — a
    // genuinely catastrophic pattern still errors (bounded at
    // 2×PREMISE_PATTERN_TIMEOUT_MS, ReDoS protection intact) while a single
    // deschedule false positive is absorbed.
    if (m === 'timeout') {
      try { m = matchImpl(p.pattern, fetched.body); } catch { return { error: 'pattern is not a valid regex' }; }
    }
    if (m === 'timeout') return { error: `pattern timed out after ${PREMISE_PATTERN_TIMEOUT_MS} ms — simplify it` };
    const v = m ? num(m[1] ?? m[0]) : null;
    return v === null ? { error: 'pattern did not match a number' } : { observed: v };
  }
  return { error: 'premise has no reader (jsonPath/pattern)' };
}

export function comparePremise(p: GoalPremise, observed: number): PremiseDrift {
  const tol = Number.isFinite(Number(p.tolerance)) && Number(p.tolerance) >= 0 ? Number(p.tolerance) : 0;
  return Math.abs(observed - p.value) <= tol + 1e-9 ? 'ok' : 'drift';
}

const fmt = (v: number | undefined, unit?: string): string => (v === undefined || v === null || !Number.isFinite(v) ? '?' : `${Number(v.toFixed(4))}${unit ?? ''}`);
const id8 = (s: unknown): string => String(s ?? '').slice(0, 8);
const hhmmz = (d: Date): string => `${d.toISOString().slice(5, 16).replace('T', ' ')}Z`;

export function renderDriftWake(goal: { id: string; title: string; projectName: string }, p: GoalPremise, now: Date): string {
  return [
    `[PREMISE DRIFT] goal ${id8(goal.id)} "${goal.title.slice(0, 80)}" (${goal.projectName}) rests on premise ${p.key} = ${fmt(p.value, p.unit)}${p.setAt ? ` (set ${hhmmz(new Date(p.setAt))}${p.setByChatId ? ` by lane ${id8(p.setByChatId)}` : ''})` : ''}, but its source now reads ${fmt(p.observed, p.unit)} (${p.source}, checked ${hhmmz(now)}, tolerance ±${fmt(p.tolerance ?? 0, p.unit)}).`,
    `A plan built on the old number may no longer hold. Do ONE of: (a) the new value is right — refresh it with goal_premise_set (same key, new value, keep the source) and revise any todo whose target depended on it; (b) the source changed meaning or is wrong — record why in the premise note (goal_premise_set) and in ${modelToolName('update_supervisor_state')}; (c) the goal itself no longer holds — goal_update its description/status. Cite goal ${id8(goal.id)} and premise "${p.key}" in your note; the [BOARD] block will show the drift until the premise is refreshed.`,
  ].join('\n');
}

export interface ConflictEntry { id: string; title: string; projectName: string; p: GoalPremise }
export function renderConflictWake(key: string, entries: ConflictEntry[]): string {
  const sorted = [...entries].sort((a, b) => a.id.localeCompare(b.id));
  // Finding C3: the manifest rides each value; a manifest-less copy beside a
  // manifested one is named as such (the wildcard match that woke this).
  const anyManifest = sorted.some((e) => !!e.p.manifest);
  const tag = (p: GoalPremise): string => (p.manifest ? ` [${p.manifest}]` : anyManifest ? ' [no manifest]' : '');
  const parts = sorted.map((e) => `${e.projectName} goal ${id8(e.id)} "${e.title.slice(0, 60)}" says ${fmt(e.p.value, e.p.unit)}${tag(e.p)}${e.p.setAt ? ` (set ${hhmmz(new Date(e.p.setAt))})` : ''}`);
  return [
    `[PREMISE CONFLICT] ${sorted.length} projects hold different values for the same premise "${key}": ${parts.join('; ')}.`,
    `One of them is stale, or the key means two different things. Reconcile it this wake: ask each project supervisor (send_chat_message) to confirm its number and source, then set the right value on every goal with goal_premise_set (or rename one key if they measure different things). Cite every goal id.`,
  ].join('\n');
}

/**
 * Finding C3 + review fix (2026-09-27): which same-key entries (one owner,
 * ≥2 projects) are a LIKE-FOR-LIKE contradiction. Entries are bucketed by
 * manifest; an UNSET manifest is a WILDCARD that joins every bucket of its
 * key, so a legacy manifest-less premise still conflicts with every manifested
 * copy (the moment ONE project adds a manifest must not switch the detector
 * off). A bucket conflicts when it spans ≥2 projects and its values sit apart
 * beyond the largest tolerance. `notLikeForLike` is true when the key's values
 * differ across projects ONLY across different manifests — never a wake.
 * PREMISE_REVISION_DISABLED=1: manifests ignored, key-only grouping.
 */
export function likeForLikeConflict<E extends { g: { projectId: string }; p: GoalPremise }>(all: E[]): { conflicting: E[]; notLikeForLike: boolean } {
  const crossProject = (entries: E[]): boolean => new Set(entries.map((e) => e.g.projectId)).size >= 2;
  const apart = (entries: E[]): boolean => {
    const values = entries.map((e) => e.p.value);
    const tol = Math.max(0, ...entries.map((e) => e.p.tolerance ?? 0));
    return Math.max(...values) - Math.min(...values) > tol + 1e-9;
  };
  const manifestOf = (e: E): string => String(e.p.manifest ?? '').toLowerCase();
  const manifests = [...new Set(all.map(manifestOf).filter(Boolean))];
  const buckets = manifests.length ? manifests.map((m) => all.filter((e) => !manifestOf(e) || manifestOf(e) === m)) : [all];
  const hit = new Set<E>();
  for (const b of buckets) if (crossProject(b) && apart(b)) for (const e of b) hit.add(e);
  const conflicting = all.filter((e) => hit.has(e));
  return { conflicting, notLikeForLike: !conflicting.length && manifests.length >= 2 && crossProject(all) && apart(all) };
}

// ── Sweep ────────────────────────────────────────────────────────────────────

interface GoalRowForCheck { id: string; userId: string; projectId: string; title: string; status: string; premises: unknown; updatedAt?: Date | null; project?: { name: string } | null }

/** The project's ENABLED supervisor, else the owner's fleet supervisor, else null. Paused/archived supervisors are never woken. */
async function supervisorForProject(projectId: string, userId: string): Promise<string | null> {
  const project = await prisma.crossModelProject.findFirst({ where: { id: projectId, userId }, select: { projectSupervisorEnabled: true, archivedAt: true } }).catch(() => null);
  if (project && project.projectSupervisorEnabled === true && !project.archivedAt) {
    const proj = await prisma.crossModelChat.findFirst({ where: { projectId, userId, isProjectSupervisor: true, archivedAt: null }, select: { id: true } }).catch(() => null);
    if (proj) return proj.id;
  }
  return fleetSupervisorFor(userId);
}

async function fleetSupervisorFor(userId: string): Promise<string | null> {
  const fleet = await prisma.crossModelChat.findFirst({ where: { userId, isSupervisor: true, archivedAt: null }, select: { id: true } }).catch(() => null);
  return fleet?.id ?? null;
}

const msOf = (iso: string | undefined): number => (iso ? new Date(iso).getTime() : NaN);
const needsCheck = (p: GoalPremise, now: Date): boolean =>
  !!p.source && !!(p.jsonPath || p.pattern) && (!Number.isFinite(msOf(p.checkedAt)) || now.getTime() - msOf(p.checkedAt) >= PREMISE_RECHECK_MIN_MS);
const oldestCheck = (ps: GoalPremise[], now: Date): number => Math.min(...ps.filter((p) => needsCheck(p, now)).map((p) => (Number.isFinite(msOf(p.checkedAt)) ? msOf(p.checkedAt) : 0)));

type Stamp = Pick<GoalPremise, 'key' | 'checkedAt' | 'observed' | 'drift' | 'driftNote' | 'lastError' | 'lastErrorAt'> & { reader: GoalPremise };

/** Apply stamps by key onto the row's CURRENT premises — only where key + value + source are unchanged. Returns null when nothing differs. */
export function mergeStamps(current: GoalPremise[], stamps: Stamp[], now: Date): GoalPremise[] | null {
  let changed = false;
  const out = current.map((cur) => {
    const st = stamps.find((s) => s.key.toLowerCase() === cur.key.toLowerCase() && sameReader(cur, s.reader));
    if (!st) return cur;
    const next: GoalPremise = { ...cur };
    let differs = false;
    for (const f of ['observed', 'drift', 'driftNote', 'lastError', 'lastErrorAt'] as const) {
      if (st[f] !== undefined && st[f] !== cur[f]) { (next as any)[f] = st[f]; differs = true; }
      if (st[f] === undefined && f !== 'observed' && cur[f] !== undefined && (f === 'lastError' || f === 'lastErrorAt' || f === 'driftNote')) { delete (next as any)[f]; differs = true; }
    }
    // The source reading supersedes a lane's manual record (finding 1,
    // 2026-09-27): stamp observedAt from this check and drop the observedNote.
    if (st.observed !== undefined && st.observed !== cur.observed) {
      next.observedAt = st.checkedAt;
      if (next.observedNote !== undefined) delete next.observedNote;
      differs = true;
    }
    const heartbeatDue = !Number.isFinite(msOf(cur.checkedAt)) || now.getTime() - msOf(cur.checkedAt) >= PREMISE_HEARTBEAT_MS;
    if (differs || heartbeatDue) { next.checkedAt = st.checkedAt; changed = true; return next; }
    return cur;
  });
  return changed ? out : null;
}

export interface PremiseCheckDeps {
  fetchImpl?: typeof fetch;
  enqueueDirectWake?: (opts: { targetChatId: string; prompt: string; meta?: Record<string, unknown> }) => Promise<unknown>;
  now?: Date;
  budgetMs?: number;
}

/**
 * Hourly: re-check every sourced premise on active/blocked goals (least
 * recently checked first, bounded budget + concurrency), stamp the result,
 * wake on NEW drift; then flag same-key cross-project contradictions.
 * Never throws. Returns counters for tests/telemetry.
 */
export async function runPremiseCheckOnce(deps: PremiseCheckDeps = {}): Promise<{ goals: number; checked: number; drifted: number; conflicts: number; skippedBudget: number }> {
  const out = { goals: 0, checked: 0, drifted: 0, conflicts: 0, skippedBudget: 0 };
  if (process.env.PREMISE_CHECK_DISABLED === '1') return out;
  const now = deps.now ?? new Date();
  const started = Date.now();
  const budgetMs = deps.budgetMs ?? PREMISE_SWEEP_BUDGET_MS;
  const wake = deps.enqueueDirectWake ?? (async (o) => (await import('./hooks.service')).enqueueDirectWake(o));
  let goals: GoalRowForCheck[] = [];
  try {
    goals = (await (prisma.projectGoal as any).findMany({
      where: {
        // Finding 1 (2026-09-27): done goals closed within the suspect window are re-read too (stamp only).
        OR: [{ status: { in: ['active', 'blocked'] } }, { status: 'done', updatedAt: { gte: new Date(now.getTime() - PREMISE_CHECK_DONE_WINDOW_MS) } }],
        NOT: { premises: { equals: [] } },
      },
      select: { id: true, userId: true, projectId: true, title: true, status: true, premises: true, updatedAt: true, project: { select: { name: true } } },
      take: PREMISE_CHECK_MAX_GOALS,
    })) as GoalRowForCheck[];
  } catch (err: any) {
    logger.warn(`${SOURCE}: goal listing failed (pre-migration or db): ${err?.message ?? err}`, { source: SOURCE });
    return out;
  }
  out.goals = goals.length;

  // (1) Source re-check — least recently checked goal first, bounded pool + budget.
  const due = goals.filter((g) => readPremises(g.premises).some((p) => needsCheck(p, now)))
    .sort((a, b) => oldestCheck(readPremises(a.premises), now) - oldestCheck(readPremises(b.premises), now));
  const driftWakesByTarget = new Map<string, number>();
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      if (cursor >= due.length) return;
      if (Date.now() - started > budgetMs) { out.skippedBudget += due.length - cursor; cursor = due.length; return; }
      const g = due[cursor++];
      try {
        await checkGoal(g);
      } catch (err: any) {
        logger.warn(`${SOURCE}: goal ${id8(g.id)} check failed (non-fatal): ${err?.message ?? err}`, { source: SOURCE });
      }
    }
  };
  const checkGoal = async (g: GoalRowForCheck): Promise<void> => {
    const premises = readPremises(g.premises);
    const stamps: Stamp[] = [];
    for (const p of premises) {
      if (!needsCheck(p, now)) continue;
      out.checked++;
      const before = p.drift;
      const stamp: Stamp = { key: p.key, checkedAt: now.toISOString(), reader: p };
      let observed: number | null = null;
      try {
        const fetched = await fetchPremiseSource(p.source!, deps.fetchImpl);
        const read = extractObserved(fetched, p);
        if ('error' in read) {
          stamp.lastError = read.error; stamp.lastErrorAt = now.toISOString();
          if (!before || before === 'error') stamp.drift = 'error';
        } else {
          observed = read.observed;
          stamp.observed = observed; stamp.drift = comparePremise(p, observed);
          stamp.driftNote = stamp.drift === 'drift' ? `source reads ${fmt(observed, p.unit)} vs registered ${fmt(p.value, p.unit)}` : undefined;
          stamp.lastError = undefined; stamp.lastErrorAt = undefined;
        }
      } catch (err: any) {
        stamp.lastError = String(err?.message ?? err).slice(0, 140); stamp.lastErrorAt = now.toISOString();
        if (!before || before === 'error') stamp.drift = 'error';
      }
      stamps.push(stamp);
      // A DONE goal is stamped only (finding 1): the '⚠ suspect' board badge is its surface, never a drift wake.
      if (stamp.drift === 'drift' && observed !== null && before !== 'drift' && g.status !== 'done') {
        await maybeWakeForDrift(g, { ...p, observed, drift: 'drift' }, observed);
      }
    }
    if (!stamps.length) return;
    // Re-read the row and merge by key: a goal_premise_set that landed mid-sweep (e.g. the
    // refresh a drift wake asked for) must never be clobbered by the snapshot we started from.
    const fresh = await (prisma.projectGoal as any).findUnique({ where: { id: g.id }, select: { premises: true, updatedAt: true } }).catch(() => null);
    if (!fresh) return;
    const merged = mergeStamps(readPremises(fresh.premises), stamps, now);
    if (!merged) return;
    // Explicit updatedAt: a framework stamp must not masquerade as goal activity.
    await (prisma.projectGoal as any).update({ where: { id: g.id }, data: { premises: merged, ...(fresh.updatedAt ? { updatedAt: fresh.updatedAt } : {}) } })
      .catch((err: any) => logger.warn(`${SOURCE}: stamp failed for goal ${id8(g.id)}: ${err?.message ?? err}`, { source: SOURCE }));
  };
  const maybeWakeForDrift = async (g: GoalRowForCheck, p: GoalPremise, observed: number): Promise<void> => {
    const tol = p.tolerance ?? 0;
    const dkey = DRIFT_KEY(g.id, p.key);
    const lastWaked = Number(await (redisClient as any).get(dkey).catch(() => null));
    if (Number.isFinite(lastWaked) && Math.abs(lastWaked - observed) <= tol + 1e-9) return; // same drift already woke someone in the last 24h
    const target = await supervisorForProject(g.projectId, g.userId);
    if (!target) return;
    const n = driftWakesByTarget.get(target) ?? 0;
    if (n >= PREMISE_DRIFT_WAKES_PER_TARGET) return; // the rest is on the [BOARD] line
    driftWakesByTarget.set(target, n + 1);
    out.drifted++;
    try {
      // abd733af (6d19f11f sibling seam): a failed drift wake must not set the
      // 24h drift key — the premise would look handled while no wake landed.
      // Retry semantics (review round 1b finding 2): the caller gates on
      // `before !== 'drift'`, and checkGoal persists the merged drift stamp
      // regardless of wake outcome — so the retry this unlocks is the NEXT
      // DRIFT ONSET (or a re-check while the row stamp has not yet landed),
      // not an unconditional next-sweep retry. The pre-fix shape was strictly
      // worse: the phantom 24h key ALSO suppressed that re-onset.
      const wres: any = await wake({ targetChatId: target, prompt: renderDriftWake({ id: g.id, title: g.title, projectName: g.project?.name ?? id8(g.projectId) }, p, now), meta: { origin: 'premise-register', kind: 'premise_drift', goalId: g.id, key: p.key } });
      if (wres && typeof wres === 'object' && wres.ok === false) {
        logger.warn(`${SOURCE}: drift wake enqueue not ok for ${target.slice(0, 8)}: ${wres.error ?? 'unknown error'}`, { source: SOURCE });
        recordLoopMetric({ kind: LOOP_METRIC_KINDS.PREMISE_REGISTER_WAKE, sessionId: target, meta: { goalId: g.id, key: p.key, outcome: 'enqueue_failed', error: wres.error ?? null } });
        return;
      }
      await (redisClient as any).set(dkey, String(observed), { EX: PREMISE_DRIFT_DEDUPE_SEC }).catch(() => {});
    } catch (err: any) {
      logger.warn(`${SOURCE}: drift wake failed: ${err?.message ?? err}`, { source: SOURCE });
    }
  };
  await Promise.all(Array.from({ length: Math.min(PREMISE_SWEEP_CONCURRENCY, Math.max(1, due.length)) }, () => worker()));

  // (2) Cross-project same-key contradictions, per owner — ONE wake per key.
  const byUser = new Map<string, GoalRowForCheck[]>();
  for (const g of goals) {
    if (g.status === 'done') continue; // finding 1: a closed goal's premise never contradicts a live one
    byUser.set(g.userId, [...(byUser.get(g.userId) ?? []), g]);
  }
  for (const [userId, rows] of byUser) {
    const byKey = new Map<string, Array<{ g: GoalRowForCheck; p: GoalPremise }>>();
    for (const g of rows) for (const p of readPremises(g.premises)) byKey.set(p.key.toLowerCase(), [...(byKey.get(p.key.toLowerCase()) ?? []), { g, p }]);
    for (const [, all] of byKey) {
      if (new Set(all.map((e) => e.g.projectId)).size < 2) continue;
      // Finding C3 (+ review fix 2026-09-27): a same-key pair under DIFFERENT
      // manifests is not like-for-like (a judged frontier bar vs a det-v2
      // score) — never a contradiction, so never a wake. An UNSET manifest is
      // a wildcard (see likeForLikeConflict).
      const { conflicting: entries, notLikeForLike } = likeForLikeConflict(all);
      if (notLikeForLike) continue;
      if (!entries.length) continue;
      const sorted = [...entries].sort((a, b) => a.g.id.localeCompare(b.g.id));
      const hash = createHash('sha256').update([sorted[0].p.key.toLowerCase(), ...sorted.map((e) => `${e.g.id}=${e.p.value}`)].join('|')).digest('hex').slice(0, 16);
      const ckey = CONFLICT_KEY(userId, hash);
      if (await (redisClient as any).get(ckey).catch(() => null)) continue;
      const target = await fleetSupervisorFor(userId);
      if (!target) continue; // no dedupe stamp: a later supervisor creation must still surface it
      out.conflicts++;
      try {
        // abd733af (6d19f11f sibling seam): a failed conflict wake must not set
        // the 7d conflict key — a cross-project contradiction would look
        // surfaced for a week while nothing landed.
        const wres: any = await wake({
          targetChatId: target,
          prompt: renderConflictWake(sorted[0].p.key, sorted.map((e) => ({ id: e.g.id, title: e.g.title, projectName: e.g.project?.name ?? id8(e.g.projectId), p: e.p }))),
          meta: { origin: 'premise-register', kind: 'premise_conflict', key: sorted[0].p.key, goalIds: sorted.map((e) => e.g.id) },
        });
        if (wres && typeof wres === 'object' && wres.ok === false) {
          logger.warn(`${SOURCE}: conflict wake enqueue not ok for ${target.slice(0, 8)}: ${wres.error ?? 'unknown error'}`, { source: SOURCE });
          recordLoopMetric({ kind: LOOP_METRIC_KINDS.PREMISE_REGISTER_WAKE, sessionId: target, meta: { key: sorted[0].p.key, goalIds: sorted.map((e) => e.g.id), outcome: 'enqueue_failed', error: wres.error ?? null } });
          continue;
        }
        await (redisClient as any).set(ckey, '1', { EX: PREMISE_CONFLICT_DEDUPE_SEC }).catch(() => {});
      } catch (err: any) {
        logger.warn(`${SOURCE}: conflict wake failed: ${err?.message ?? err}`, { source: SOURCE });
      }
    }
  }
  if (out.checked || out.conflicts || out.skippedBudget) logger.info(`${SOURCE}: sweep goals=${out.goals} due=${due.length} checked=${out.checked} drifted=${out.drifted} conflicts=${out.conflicts} skippedBudget=${out.skippedBudget} ms=${Date.now() - started}`, { source: SOURCE });
  return out;
}
