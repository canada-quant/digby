/**
 * ANSWER CLOCK HEADER (audit 2026-10-08 W1-6 — supervisors F9).
 *
 * A Schooltime owner answer written at 18:09:20Z (11:09 AM PDT) opened
 * "**10:31 AM PDT (17:31Z) — capturing right now**": the model copied its
 * header clock from the last lane message, 38 minutes stale, and the owner read
 * a "right now" that was not now. The header clock of an owner answer on a
 * supervisor chat is the ANSWER's clock: when the first line carries a
 * status-stamp clock (a local time with a zone and/or a "(HH:MMZ)" pair) that is
 * more than STALE_MIN minutes behind the answer's own clock, it is restamped
 * from the server clock in the same zone and shape. A first line naming a date
 * or weekday (a dated, historical header) and a clock AHEAD of now are left
 * alone. Pure; kill switch OWNER_ANSWER_CLOCK_STAMP_DISABLED=1.
 */

export const ANSWER_CLOCK_STALE_MIN = 10;
/** Headers that drifted by more than this are a different day's clock — never touched. */
const MAX_DRIFT_MIN = 12 * 60;

const ZONE_OFFSET_MIN: Readonly<Record<string, number>> = {
  PDT: -7 * 60, PST: -8 * 60, MDT: -6 * 60, MST: -7 * 60, CDT: -5 * 60, CST: -6 * 60,
  EDT: -4 * 60, EST: -5 * 60, UTC: 0, GMT: 0, BST: 60, CET: 60, CEST: 120,
};
const DATE_WORD_RE = /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b|\b(?:mon|tue|wed|thu|fri|sat|sun)(?:day|sday|nesday|rsday|urday)?\b|\b\d{4}-\d{2}-\d{2}\b|\byesterday\b|\btomorrow\b/i;
const STAMP_CUE_RE = /\b(?:now|right now|currently|as of|status|update|wake|sweep|check-?in)\b/i;
const CLOCK_RE = /(\d{1,2}):(\d{2})\s*(AM|PM|am|pm)\s*(PDT|PST|MDT|MST|CDT|CST|EDT|EST|UTC|GMT|BST|CET|CEST)?(\s*\(\s*(\d{1,2}):(\d{2})\s*Z\s*\))?/;

export function answerClockStampDisabled(): boolean {
  return process.env.OWNER_ANSWER_CLOCK_STAMP_DISABLED === '1';
}

export interface ClockStampResult {
  text: string;
  /** Set when the header was restamped. driftMin < 0 (direction 'ahead') = the header read later than now. */
  stamped?: { from: string; to: string; driftMin: number; direction?: 'ahead' };
}

const pad2 = (n: number) => String(n).padStart(2, '0');
const mod = (a: number, m: number) => ((a % m) + m) % m;

/** Restamp a stale first-line clock header with the answer's own clock. Pure; exported for tests. */
export function stampAnswerClockHeader(text: string, now: Date): ClockStampResult {
  const t = String(text ?? '');
  if (!t.trim() || answerClockStampDisabled()) return { text: t };
  const nl = t.indexOf('\n');
  const firstLine = nl >= 0 ? t.slice(0, nl) : t;
  if (firstLine.length > 240) return { text: t };
  const m = CLOCK_RE.exec(firstLine);
  if (!m || (m.index ?? 0) > 80) return { text: t };
  if (DATE_WORD_RE.test(firstLine)) return { text: t };
  const hasZ = !!m[5];
  if (!hasZ && !STAMP_CUE_RE.test(firstLine)) return { text: t };
  let h12 = Number(m[1]);
  const min = Number(m[2]);
  if (h12 < 1 || h12 > 12 || min > 59) return { text: t };
  const pm = /pm/i.test(m[3]);
  const localMin = mod(h12, 12) * 60 + (pm ? 12 * 60 : 0) + min;
  // Zone offset: from the "(HH:MMZ)" pair when present (exact), else the abbreviation table.
  let offset: number | null = null;
  if (hasZ) {
    const zMin = Number(m[6]) * 60 + Number(m[7]);
    let o = mod(localMin - zMin, 24 * 60);
    if (o > 14 * 60) o -= 24 * 60;
    offset = o;
  } else if (m[4]) {
    offset = ZONE_OFFSET_MIN[m[4].toUpperCase()] ?? null;
  }
  if (offset === null) return { text: t };
  // The header's instant: its UTC minute-of-day on the day that puts it closest to now.
  const headerUtcMin = mod(localMin - offset, 24 * 60);
  const nowUtcMin = now.getUTCHours() * 60 + now.getUTCMinutes();
  let drift = nowUtcMin - headerUtcMin;
  if (drift > 12 * 60) drift -= 24 * 60;
  if (drift < -12 * 60) drift += 24 * 60;
  if (drift <= ANSWER_CLOCK_STALE_MIN || drift > MAX_DRIFT_MIN) return { text: t };
  const nowLocal = mod(nowUtcMin + offset, 24 * 60);
  h12 = Math.floor(nowLocal / 60) % 12 || 12;
  const ampm = nowLocal >= 12 * 60 ? 'PM' : 'AM';
  const sameCase = /[a-z]/.test(m[3]) ? ampm.toLowerCase() : ampm;
  const zone = m[4] ? ` ${m[4]}` : '';
  const zPair = hasZ ? ` (${pad2(Math.floor(nowUtcMin / 60))}:${pad2(nowUtcMin % 60)}Z)` : '';
  const replacement = `${h12}:${pad2(nowLocal % 60)} ${sameCase}${zone}${zPair}`;
  const at = m.index ?? 0;
  const newFirst = firstLine.slice(0, at) + replacement + firstLine.slice(at + m[0].length);
  return {
    text: newFirst + (nl >= 0 ? t.slice(nl) : ''),
    stamped: { from: m[0].trim(), to: replacement, driftMin: drift },
  };
}

// ── AHEAD-of-now headline clocks on machine notes (build 2026-10-08 Q-3 — OWNER-APPROVED) ──
//
// The one REAL fabricated clock the machine-wake future-clock lane caught in
// 33 strikes (2026-09-25 → 10-08) was a projected headline: "**Fleet wake —
// 6:33 AM PDT: …**" written at 5:08 AM PDT. The note was struck and re-run;
// the fix is to correct the clock, not to flag the note. A machine note whose
// FIRST line is a status stamp ("<label> — <clock>" with a stamp cue, or a
// clock at the head of the line) whose clock reads MORE than 90 s AHEAD of
// the run's real clock (≤ 12 h — further is a different day) is restamped
// from the server clock in the same zone and shape; a paired gloss ("22:33Z
// (07:33 PM PDT)", "7:41 AM PDT / 14:41Z") is checked token by token, so a
// wrong-zone gloss beside a right clock is corrected alone. Never touched: a
// first line naming a date / weekday, a clock past the first 80 chars, a
// forward-cued clock ("next wake 18:00Z", "ETA ~1:46 PM PDT", "by 9:00 AM").
// Pure. Applied by the chat-agent machine-wake seam BEFORE the integrity
// guard; FUTURE_CLOCK_REPLACE_ENABLED=1 (platform/future-clock-policy.ts)
// turns it off with the rest of the clock package.

/** The detector's tolerance (action-verifier FUTURE_TS_TOLERANCE_MS): a clock this far ahead is "in the future". */
export const AHEAD_CLOCK_TOLERANCE_MS = 90_000;
const AHEAD_MAX_MS = 12 * 60 * 60_000;
const ZONED_CLOCK_RE = /(?<![\d:])\b(\d{1,2}):([0-5]\d)(?::([0-5]\d))?(\s*)(?:([AaPp])(\.?\s?[Mm]\.?))?(\s*)(Z|UTC|GMT|PDT|PST|MDT|MST|CDT|CST|EDT|EST|BST|CET|CEST)\b/g;
const HEAD_FORWARD_CUE_RE = /(?:[~≈≥≤]|>=|<=|\b(?:by|until|till|through|thru|next|eta|due|after|before|from|starting|scheduled|armed|fires?|firing|deadline|target|expected|projected|pace for|on pace|at the earliest)\b)[^0-9]{0,12}$/i;
const HEAD_STAMP_WORD_RE = /\b(?:sweep|wake|status|update|check-?in|report|digest|tick|now|as of|currently)\b/i;
const HEAD_PREFIX_ONLY_RE = /^[\s*#_>`\-–—:|[\]]*$/;
/** The stamp clock sits right after the label's separator ("Fleet wake — 6:33", "Sweep: 06:33Z", "as of 9:40"). */
const HEAD_STAMP_POSITION_RE = /(?:^|[—–\-:|(@]|\bas of|\bnow|\bat)[\s*_]*$/i;
/** A backward-pointing clock ("since 05:40Z", "last 22:00Z") is a past reference, never the stamp. */
const HEAD_BACKWARD_CUE_RE = /\b(?:since|ago|last|earlier|previous|prior|from)\b[^0-9]{0,12}$/i;

interface ZonedToken { start: number; end: number; text: string; h: number; m: number; s?: number; ap?: string; zone: string }

function zonedTokens(line: string): ZonedToken[] {
  const out: ZonedToken[] = [];
  ZONED_CLOCK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ZONED_CLOCK_RE.exec(line))) {
    const h = Number(m[1]);
    const ap = m[5];
    if (ap ? h < 1 || h > 12 : h > 23) continue;
    out.push({ start: m.index, end: m.index + m[0].length, text: m[0], h, m: Number(m[2]), ...(m[3] ? { s: Number(m[3]) } : {}), ...(ap ? { ap } : {}), zone: m[8].toUpperCase() });
  }
  return out;
}

function zoneOffsetMin(zone: string): number | null {
  if (zone === 'Z') return 0;
  const o = ZONE_OFFSET_MIN[zone];
  return typeof o === 'number' ? o : null;
}

/** ms the token's nearest instant (yesterday / today / tomorrow) reads ahead of now; null when the zone is unknown. */
function tokenAheadMs(t: ZonedToken, now: Date): number | null {
  const offset = zoneOffsetMin(t.zone);
  if (offset === null) return null;
  const localMin = t.ap ? mod(t.h, 12) * 60 + (/p/i.test(t.ap) ? 12 * 60 : 0) + t.m : t.h * 60 + t.m;
  const utcMin = mod(localMin - offset, 24 * 60);
  const day = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const base = day + utcMin * 60_000 + (t.s ?? 0) * 1000;
  let best = Infinity;
  for (const cand of [base - 86_400_000, base, base + 86_400_000]) {
    const d = cand - now.getTime();
    if (Math.abs(d) < Math.abs(best)) best = d;
  }
  return best;
}

/** The token re-rendered at `now` in its own zone, keeping its padding, seconds, spacing and AM/PM case. */
function renderAt(t: ZonedToken, now: Date): string {
  const offset = zoneOffsetMin(t.zone) ?? 0;
  const local = mod(now.getUTCHours() * 60 + now.getUTCMinutes() + offset, 24 * 60);
  const padded = /^\d{2}:/.test(t.text);
  let hour = Math.floor(local / 60);
  let ap = t.ap;
  if (t.ap) {
    const pm = hour >= 12;
    hour = hour % 12 || 12;
    ap = /[a-z]/.test(t.ap) ? (pm ? 'p' : 'a') : (pm ? 'P' : 'A');
  }
  const hh = padded ? pad2(hour) : String(hour);
  const sec = typeof t.s === 'number' ? `:${pad2(now.getUTCSeconds())}` : '';
  let out = t.text.replace(/^\d{1,2}:\d{2}(?::\d{2})?/, `${hh}:${pad2(local % 60)}${sec}`);
  if (t.ap && ap) out = out.replace(/([AaPp])(\.?\s?[Mm]\.?)/, (_all, _a, rest) => `${ap}${rest}`);
  return out;
}

/** Restamp an AHEAD-of-now status-stamp clock on a machine note's first line. Pure; exported for tests. */
export function stampAheadHeadlineClock(text: string, now: Date): ClockStampResult {
  const t = String(text ?? '');
  if (!t.trim()) return { text: t };
  const lead = t.length - t.trimStart().length;
  const body = t.slice(lead);
  const nl = body.indexOf('\n');
  const firstLine = nl >= 0 ? body.slice(0, nl) : body;
  if (firstLine.length > 240 || DATE_WORD_RE.test(firstLine) || /\d{4}-\d{2}-\d{2}/.test(firstLine)) return { text: t };
  const tokens = zonedTokens(firstLine);
  const first = tokens[0];
  if (!first || first.start > 80) return { text: t };
  const before = firstLine.slice(0, first.start);
  if (HEAD_FORWARD_CUE_RE.test(before) || HEAD_BACKWARD_CUE_RE.test(before) || !HEAD_STAMP_POSITION_RE.test(before)) return { text: t };
  if (!HEAD_STAMP_WORD_RE.test(before) && !HEAD_PREFIX_ONLY_RE.test(before)) return { text: t };
  const pair: ZonedToken[] = [first];
  const second = tokens[1];
  if (second && /^\s*[(/]\s*$/.test(firstLine.slice(first.end, second.start))) pair.push(second);
  let worstAheadMs = 0;
  const rewrites: Array<{ tok: ZonedToken; to: string }> = [];
  for (const tok of pair) {
    const ahead = tokenAheadMs(tok, now);
    if (ahead === null || ahead <= AHEAD_CLOCK_TOLERANCE_MS || ahead > AHEAD_MAX_MS) continue;
    worstAheadMs = Math.max(worstAheadMs, ahead);
    rewrites.push({ tok, to: renderAt(tok, now) });
  }
  if (!rewrites.length) return { text: t };
  const spanStart = pair[0].start;
  let spanEnd = pair[pair.length - 1].end;
  // "22:33Z (07:33 PM PDT)": the span closes the gloss's parenthesis.
  if (pair.length > 1 && firstLine.slice(pair[0].end, pair[1].start).includes('(') && firstLine[spanEnd] === ')') spanEnd += 1;
  let newLine = firstLine;
  for (const r of [...rewrites].sort((a, b) => b.tok.start - a.tok.start)) {
    newLine = newLine.slice(0, r.tok.start) + r.to + newLine.slice(r.tok.end);
  }
  const delta = newLine.length - firstLine.length;
  return {
    text: t.slice(0, lead) + newLine + (nl >= 0 ? body.slice(nl) : ''),
    stamped: { from: firstLine.slice(spanStart, spanEnd), to: newLine.slice(spanStart, spanEnd + delta), driftMin: -Math.round(worstAheadMs / 60_000), direction: 'ahead' },
  };
}
