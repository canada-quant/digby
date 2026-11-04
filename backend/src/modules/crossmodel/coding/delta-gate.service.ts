/**
 * DELTA GATE (feedback ticket 0b1dbe75) — the token-saving answer to heartbeat
 * watch loops. An hourly "is it done yet?" recurring schedule burns a full
 * model run (~420k tokens) per firing even when the thing it watches has not
 * moved. With a delta gate armed the PLATFORM polls the schedule's cheap https
 * probes itself at each fire time and SKIPS the model run when every observed
 * value still equals its stored marker — a skipped firing costs a few KB of
 * outbound fetch, not a run.
 *
 * Shape (stored on coding_schedules.deltaGate, Json?):
 *   { probes: [ { url, headers?, jsonPath? | pattern?,           // 1..4 probes
 *                 marker?, checkedAt?, lastError? } ],           // platform-maintained
 *     heartbeatHours? }                                          // 1..168, default 6
 *
 * Fire-time verdicts (evaluateDeltaGate — recurring schedules only):
 *   (a) any probe lacking a stored marker  → FIRE 'baseline'  (first read establishes it)
 *   (b) any observed value ≠ marker        → FIRE 'delta'
 *   (c) any probe error                    → FIRE 'error'     (FAIL-OPEN: a gate
 *       failure must never silence a schedule; the errored probe keeps its old
 *       marker and gets lastError stamped)
 *   (d) all unchanged but lastFiredAt null-or-older-than heartbeatHours
 *                                          → FIRE 'heartbeat' (liveness floor)
 *   (e) all unchanged                      → SKIP (lastStatus
 *       'skipped:delta_unchanged'; runsCount/lastFiredAt untouched — the
 *       atomic claim already slid nextRunAt, so the cadence slides)
 *
 * Fetch safety rides premise-register's fetchPremiseSource (https only,
 * DNS-checked public hosts, ≤2 re-checked redirects, 10 s, 1 MB); patterns run
 * under safeMatch's vm timeout after the registration-time nested-quantifier
 * ban. The whole evaluation is bounded (~25 s race) and NEVER throws. Header
 * VALUES may carry secrets (Authorization…) — they are stored but NEVER echoed
 * on any read surface (ScheduleView carries header NAMES only).
 */

import {
  fetchPremiseSource,
  readJsonPath,
  safeMatch,
  isUnsafePattern,
  PREMISE_JSONPATH_MAX,
  PREMISE_PATTERN_MAX,
  PREMISE_SOURCE_MAX,
} from '../platform/premise-register';

export const DELTA_GATE_MAX_PROBES = 4;
export const DELTA_GATE_DEFAULT_HEARTBEAT_HOURS = 6;
export const DELTA_GATE_MAX_HEARTBEAT_HOURS = 168;
export const DELTA_GATE_EVAL_TIMEOUT_MS = 25_000;
export const DELTA_GATE_MARKER_MAX = 1000;
export const DELTA_GATE_MAX_HEADERS = 8;
const HEADER_NAME_RE = /^[A-Za-z0-9-]{1,60}$/;
const HEADER_VALUE_MAX = 300;
const LAST_ERROR_MAX = 300;
// Same dot/bracket path shape premise-register enforces at registration.
const JSONPATH_RE = /^[A-Za-z0-9_$][A-Za-z0-9_$\-]*(?:\.[A-Za-z0-9_$\-]+|\[\d+\])*$/;

export interface DeltaGateProbe {
  /** https URL (no userinfo, ≤400 chars) — canonicalized at write time. */
  url: string;
  /** Optional request headers (≤8; values ≤300 chars, may be secrets — never echoed). */
  headers?: Record<string, string>;
  /** dot/bracket path into a JSON body, e.g. 'runs[0].score' — exactly one of jsonPath|pattern. */
  jsonPath?: string;
  /** regex over a TEXT body; the FIRST capture group is read (whole match when no group). */
  pattern?: string;
  /** Platform-maintained: the last observed value (stringified, ≤DELTA_GATE_MARKER_MAX). */
  marker?: string;
  /** Platform-maintained: ISO of the last evaluation attempt. */
  checkedAt?: string;
  /** Platform-maintained: the last probe failure (marker is preserved alongside). */
  lastError?: string;
}

export interface DeltaGate {
  probes: DeltaGateProbe[];
  heartbeatHours?: number;
}

export type DeltaGateFireReason = 'baseline' | 'delta' | 'heartbeat' | 'error' | 'unchanged';

export interface DeltaGateVerdict {
  fire: boolean;
  reason: DeltaGateFireReason;
  detail?: string;
  /** The updated gate to persist (markers/checkedAt/lastError maintained). */
  gate: DeltaGate;
  /** True when any marker/lastError changed (checkedAt alone does not set it). */
  markersChanged: boolean;
}

const str = (v: unknown, max: number): string => String(v ?? '').trim().slice(0, max);

/**
 * STRICT write-time validation (createSchedule / updateScheduleForUser): any
 * violation returns an actionable error naming the violated rule. The
 * platform-maintained fields (marker/checkedAt/lastError) are STRIPPED from
 * caller input — the first evaluation after any arm/update FIRES to establish
 * a fresh baseline. heartbeatHours defaults to 6.
 */
export function validateDeltaGate(raw: unknown): { gate?: DeltaGate; error?: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: 'deltaGate must be an object {probes: [{url, headers?, jsonPath?|pattern?}], heartbeatHours?} — 1–4 probes, exactly one reader each.' };
  }
  const input = raw as Record<string, unknown>;
  const list = input.probes;
  if (!Array.isArray(list) || list.length === 0) {
    return { error: `deltaGate.probes must be an array of 1–${DELTA_GATE_MAX_PROBES} probe objects (got ${Array.isArray(list) ? 'an empty array' : typeof list}).` };
  }
  if (list.length > DELTA_GATE_MAX_PROBES) {
    return { error: `deltaGate.probes holds at most ${DELTA_GATE_MAX_PROBES} probes (got ${list.length}) — keep the few values the run actually waits on.` };
  }
  const probes: DeltaGateProbe[] = [];
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    const label = `probe[${i}]`;
    if (!p || typeof p !== 'object' || Array.isArray(p)) return { error: `deltaGate ${label} must be an object {url, headers?, jsonPath?|pattern?}.` };
    const rawUrl = str((p as any).url, PREMISE_SOURCE_MAX + 1);
    let u: URL;
    try { u = new URL(rawUrl); } catch { return { error: `deltaGate ${label}: url must be an https URL (got "${rawUrl || '(empty)'}").` }; }
    if (u.protocol !== 'https:' || String((p as any).url ?? '').length > PREMISE_SOURCE_MAX) {
      return { error: `deltaGate ${label}: url must be https only, ≤${PREMISE_SOURCE_MAX} chars (got "${rawUrl.slice(0, 60)}").` };
    }
    if (u.username || u.password) return { error: `deltaGate ${label}: url must not carry credentials (userinfo) — put auth in headers.Authorization instead.` };
    const probe: DeltaGateProbe = { url: u.toString() };

    if ((p as any).headers !== undefined && (p as any).headers !== null) {
      const h = (p as any).headers;
      if (!h || typeof h !== 'object' || Array.isArray(h)) return { error: `deltaGate ${label}: headers must be an object of name → value string pairs (≤${DELTA_GATE_MAX_HEADERS}).` };
      const entries = Object.entries(h);
      if (entries.length > DELTA_GATE_MAX_HEADERS) return { error: `deltaGate ${label}: at most ${DELTA_GATE_MAX_HEADERS} headers (got ${entries.length}).` };
      const headers: Record<string, string> = {};
      for (const [name, value] of entries) {
        if (!HEADER_NAME_RE.test(name)) return { error: `deltaGate ${label}: header name "${name.slice(0, 40)}" must match ${HEADER_NAME_RE} (letters/digits/dash, 1–60 chars).` };
        if (typeof value !== 'string') return { error: `deltaGate ${label}: header "${name}" value must be a string.` };
        if (value.length > HEADER_VALUE_MAX) return { error: `deltaGate ${label}: header "${name}" value is over ${HEADER_VALUE_MAX} chars.` };
        headers[name] = value;
      }
      if (entries.length) probe.headers = headers;
    }

    const jsonPath = str((p as any).jsonPath, PREMISE_JSONPATH_MAX + 1);
    const pattern = str((p as any).pattern, PREMISE_PATTERN_MAX + 1);
    if (!jsonPath && !pattern) return { error: `deltaGate ${label}: give exactly one reader — jsonPath (dot/bracket path into a JSON body, e.g. 'runs[0].score') OR pattern (regex; first capture group read from a text body).` };
    if (jsonPath && pattern) return { error: `deltaGate ${label}: give jsonPath OR pattern, not both.` };
    if (jsonPath) {
      if (jsonPath.length > PREMISE_JSONPATH_MAX || !JSONPATH_RE.test(jsonPath)) {
        return { error: `deltaGate ${label}: jsonPath must be a dot/bracket path like results.suite_mean or runs[0].score (≤${PREMISE_JSONPATH_MAX} chars).` };
      }
      probe.jsonPath = jsonPath;
    } else {
      if (pattern.length > PREMISE_PATTERN_MAX) return { error: `deltaGate ${label}: pattern too long (≤${PREMISE_PATTERN_MAX} chars).` };
      try { new RegExp(pattern, 'i'); } catch { return { error: `deltaGate ${label}: pattern is not a valid regex.` }; }
      if (isUnsafePattern(pattern)) {
        return { error: `deltaGate ${label}: pattern uses nested or stacked quantifiers (catastrophic backtracking) — anchor it on the label text instead, e.g. "Version:\\s*([\\d.]+)".` };
      }
      probe.pattern = pattern;
    }
    // marker/checkedAt/lastError are PLATFORM-MAINTAINED — caller-supplied
    // values are stripped so a re-arm/re-write always re-baselines.
    probes.push(probe);
  }

  let heartbeatHours = DELTA_GATE_DEFAULT_HEARTBEAT_HOURS;
  if (input.heartbeatHours !== undefined && input.heartbeatHours !== null) {
    const h = Number(input.heartbeatHours);
    if (!Number.isFinite(h)) return { error: `deltaGate.heartbeatHours must be a number of hours (1–${DELTA_GATE_MAX_HEARTBEAT_HOURS}, default ${DELTA_GATE_DEFAULT_HEARTBEAT_HOURS}).` };
    if (h < 1 || h > DELTA_GATE_MAX_HEARTBEAT_HOURS) return { error: `deltaGate.heartbeatHours must be 1–${DELTA_GATE_MAX_HEARTBEAT_HOURS} hours (got ${h}) — the liveness floor may not exceed a week.` };
    heartbeatHours = Math.round(h);
  }
  return { gate: { probes, heartbeatHours } };
}

/**
 * Tolerant read of a STORED gate at fire time. Stored gates passed strict
 * validation at write time, but a hand-edited/legacy row must never wedge the
 * sweeper: malformed probes drop; a gate with no usable probe returns null
 * (the caller warns and FIRES — fail-open).
 */
export function parseStoredDeltaGate(raw: unknown): DeltaGate | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const list = (raw as any).probes;
  if (!Array.isArray(list)) return null;
  const probes: DeltaGateProbe[] = [];
  for (const p of list) {
    if (!p || typeof p !== 'object') continue;
    const url = typeof (p as any).url === 'string' ? (p as any).url : '';
    if (!url.startsWith('https://') || url.length > PREMISE_SOURCE_MAX + 40) continue;
    const jsonPath = typeof (p as any).jsonPath === 'string' && (p as any).jsonPath ? String((p as any).jsonPath).slice(0, PREMISE_JSONPATH_MAX + 1) : undefined;
    const pattern = typeof (p as any).pattern === 'string' && (p as any).pattern ? String((p as any).pattern).slice(0, PREMISE_PATTERN_MAX + 1) : undefined;
    if (!jsonPath && !pattern) continue;
    const probe: DeltaGateProbe = { url };
    if ((p as any).headers && typeof (p as any).headers === 'object' && !Array.isArray((p as any).headers)) {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries((p as any).headers).slice(0, DELTA_GATE_MAX_HEADERS)) {
        if (HEADER_NAME_RE.test(k) && typeof v === 'string') headers[k] = (v as string).slice(0, HEADER_VALUE_MAX);
      }
      if (Object.keys(headers).length) probe.headers = headers;
    }
    if (jsonPath && !pattern) probe.jsonPath = jsonPath; else if (pattern && !jsonPath) probe.pattern = pattern; else continue;
    if (typeof (p as any).marker === 'string') probe.marker = (p as any).marker;
    if (typeof (p as any).checkedAt === 'string') probe.checkedAt = (p as any).checkedAt;
    if (typeof (p as any).lastError === 'string') probe.lastError = (p as any).lastError;
    probes.push(probe);
    if (probes.length >= DELTA_GATE_MAX_PROBES) break;
  }
  if (!probes.length) return null;
  const h = Number((raw as any).heartbeatHours);
  const heartbeatHours = Number.isFinite(h) && h >= 1 && h <= DELTA_GATE_MAX_HEARTBEAT_HOURS ? Math.round(h) : DELTA_GATE_DEFAULT_HEARTBEAT_HOURS;
  return { probes, heartbeatHours };
}

/** The observed value from a fetched body per the probe's reader; an error string when unreadable. */
function extractProbeValue(body: string, probe: DeltaGateProbe): { value: string } | { error: string } {
  if (probe.jsonPath) {
    let parsed: unknown;
    try { parsed = JSON.parse(body); } catch { return { error: 'body is not JSON' }; }
    const v = readJsonPath(parsed, probe.jsonPath);
    if (v === undefined) return { error: `jsonPath "${probe.jsonPath}" absent` };
    const s = typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : JSON.stringify(v);
    return { value: String(s).slice(0, DELTA_GATE_MARKER_MAX) };
  }
  if (probe.pattern) {
    let m: RegExpExecArray | null | 'timeout';
    try { m = safeMatch(probe.pattern, body); } catch { return { error: 'pattern is not a valid regex' }; }
    if (m === 'timeout') return { error: 'pattern timed out — simplify it' };
    if (!m) return { error: 'pattern did not match' };
    return { value: String(m[1] ?? m[0]).slice(0, DELTA_GATE_MARKER_MAX) };
  }
  return { error: 'probe has no reader (jsonPath/pattern)' };
}

async function evaluateProbes(gate: DeltaGate, working: DeltaGate, nowIso: string, fetchImpl: typeof fetch): Promise<void> {
  await Promise.all(working.probes.map(async (probe, i) => {
    probe.checkedAt = nowIso;
    try {
      const fetched = await fetchPremiseSource(probe.url, fetchImpl, probe.headers);
      const read = extractProbeValue(fetched.body, probe);
      if ('error' in read) {
        probe.lastError = read.error.slice(0, LAST_ERROR_MAX);
        return;
      }
      const prev = gate.probes[i]?.marker;
      if (prev !== read.value) probe.marker = read.value; // set (baseline) or update (delta)
      if (probe.lastError !== undefined) delete probe.lastError;
    } catch (err: any) {
      probe.lastError = String(err?.message ?? err).slice(0, LAST_ERROR_MAX);
    }
  }));
}

/**
 * Evaluate a gate at fire time. NEVER throws — every failure path fails OPEN
 * (fire 'error'). Runs all probes in parallel (each fetch is 10 s-bounded by
 * fetchPremiseSource) inside a ~25 s wall-clock race; a timeout fires 'error'
 * with the ORIGINAL gate returned (the detached probes mutate only their own
 * copy, so nothing half-written can be persisted).
 */
export async function evaluateDeltaGate(
  gate: DeltaGate,
  opts: { now: Date; lastFiredAt: Date | null; fetchImpl?: typeof fetch },
): Promise<DeltaGateVerdict> {
  try {
    const now = opts.now;
    const nowIso = now.toISOString();
    const fetchImpl = opts.fetchImpl ?? fetch;
    // The inner evaluation works on a deep copy — a timeout returns the
    // caller's gate untouched (markersChanged false), never a half-written one.
    const working: DeltaGate = JSON.parse(JSON.stringify(gate));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), DELTA_GATE_EVAL_TIMEOUT_MS);
      (timer as any).unref?.();
    });
    const raced = await Promise.race([evaluateProbes(gate, working, nowIso, fetchImpl).then(() => 'done' as const), deadline]);
    if (timer) clearTimeout(timer);
    if (raced === 'timeout') {
      return { fire: true, reason: 'error', detail: `delta-gate evaluation timed out after ${Math.round(DELTA_GATE_EVAL_TIMEOUT_MS / 1000)}s`, gate, markersChanged: false };
    }

    // Verdict precedence: baseline (a successful first read) → delta → error →
    // heartbeat → unchanged. An ERRORED probe never counts as a baseline (no
    // value was read) — the error branch below catches it (fail-open).
    let baseline: DeltaGateProbe | null = null;
    let delta: { probe: DeltaGateProbe; from: string } | null = null;
    let errored: DeltaGateProbe | null = null;
    let markersChanged = false;
    for (let i = 0; i < working.probes.length; i++) {
      const probe = working.probes[i];
      const stored = gate.probes[i];
      if (probe.lastError) { if (!errored) errored = probe; if (stored?.lastError !== probe.lastError) markersChanged = true; continue; }
      if (stored?.lastError !== undefined && probe.lastError === undefined) markersChanged = true; // error cleared by a good read
      if (stored?.marker === undefined) { if (!baseline) baseline = probe; markersChanged = true; continue; }
      if (probe.marker !== stored.marker) { if (!delta) delta = { probe, from: stored.marker! }; markersChanged = true; }
    }
    const clip = (s: string | undefined) => (s ?? '').length > 80 ? `${(s ?? '').slice(0, 80)}…` : (s ?? '');
    if (baseline) {
      return { fire: true, reason: 'baseline', detail: `baseline established for ${baseline.url} (marker "${clip(baseline.marker)}")`, gate: working, markersChanged };
    }
    if (delta) {
      return { fire: true, reason: 'delta', detail: `${delta.probe.url} changed: "${clip(delta.from)}" → "${clip(delta.probe.marker)}"`, gate: working, markersChanged };
    }
    if (errored) {
      return { fire: true, reason: 'error', detail: `${errored.url}: ${errored.lastError}`, gate: working, markersChanged };
    }
    const heartbeatMs = (working.heartbeatHours ?? DELTA_GATE_DEFAULT_HEARTBEAT_HOURS) * 3600_000;
    const lastFiredMs = opts.lastFiredAt ? opts.lastFiredAt.getTime() : NaN;
    if (!Number.isFinite(lastFiredMs) || now.getTime() - lastFiredMs >= heartbeatMs) {
      return {
        fire: true,
        reason: 'heartbeat',
        detail: `all ${working.probes.length} probe(s) unchanged; last real run ${Number.isFinite(lastFiredMs) ? `${Math.round((now.getTime() - lastFiredMs) / 3600_000)}h ago` : 'never'} meets the ${working.heartbeatHours}h heartbeat`,
        gate: working,
        markersChanged,
      };
    }
    return { fire: false, reason: 'unchanged', gate: working, markersChanged };
  } catch (err: any) {
    // Fail-open at the boundary too — a gate bug must never silence a schedule.
    return { fire: true, reason: 'error', detail: `delta-gate evaluation errored: ${String(err?.message ?? err).slice(0, 140)}`, gate, markersChanged: false };
  }
}
