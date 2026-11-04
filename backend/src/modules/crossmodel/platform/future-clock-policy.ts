/**
 * Future-clock policy for owner-facing machine notes (build 2026-10-08 Q-3 —
 * OWNER-APPROVED; supersedes the "replace" half of directive cdd3fbfe).
 *
 * The machine-wake future-clock lane (action-verifier.ts
 * findFutureObservedTimestamps) struck 33 supervisor notes between 2026-09-25
 * and 2026-10-08: ONE was a real fabricated clock (a projected "Fleet wake —
 * 6:33 AM PDT" headline written at 5:08 AM PDT), two were time-zone label
 * slips, and 29 were legitimate forward references or undated past events
 * (an ETA range, "≥22:00Z", "the 18:00Z checkpoint", "school hours 9:00 AM
 * PDT", a reservation end "2026-10-03T11:30Z", "registered 02:22Z"). Both full
 * replacements in that window replaced TRUE content, and 30 clean reject-back
 * retries mostly reworded legitimate ETAs. The directive itself says "must NOT
 * convict on regex-shape alone".
 *
 * The package (one switch):
 *   1. A HEADLINE clock written AHEAD of now is corrected, not flagged
 *      (chat-agent/answer-clock.ts stampAheadHeadlineClock) — the one real class.
 *   2. A body clock is CONVICTED only when it is written as an OBSERVATION:
 *      "as of <clock>", "<clock> now" / "now <clock>", "at <clock> I saw / the
 *      probe found …", "<verified / probed / checked …> at <clock>". A token
 *      that carries a date, sits in a dated clause, or carries a forward cue
 *      (~ ≈ ≥, next, ETA, scheduled, armed, expected, will, due) never
 *      convicts. Every other hit is recorded as observed only.
 *   3. A convicted clock ANNOTATES the note (delivered as written + one
 *      trailing annotation — the W1-4 rule for every other strike); the
 *      correction row and the ticket still fire.
 *   4. No reject-back re-orchestration for a clock-only strike (it is kept
 *      when fabricated ticket citations co-ride).
 * Kill switch FUTURE_CLOCK_REPLACE_ENABLED=1 restores the pre-change lane
 * byte-for-byte: every hit convicts, the note is replaced, the reject-back
 * runs, no machine-wake headline restamp.
 *
 * Pure leaf (no imports).
 */

export function futureClockReplaceEnabled(): boolean {
  const v = String(process.env.FUTURE_CLOCK_REPLACE_ENABLED ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

/** Why a detector hit does or does not convict. */
export type ClockHitVerdict = 'convicted' | 'dated' | 'forward' | 'not_observation';

export interface ClockHitLike { token: string; line: string }

// Clause boundaries: sentence / list / table punctuation, brackets, dashes used as separators, ": ".
const CLAUSE_SEP_RE = /[;!?|•·()[\]{}]\s?|\.(?:\s|$)|[—–]|\s-\s|,\s|:\s/g;
const CLAUSE_MAX = 64;

/** Date forms that pin a clause to a calendar day (yyyy-mm-dd, MM-DD, month-name day, weekday, yesterday). */
const CLAUSE_DATE_RE = /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}-\d{1,2}\b|\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)[\s-]\d{1,2}\b|\b(?:Mon|Tue|Tues|Wed|Thu|Thur|Thurs|Fri|Sat|Sun)(?:day|sday|nesday|rsday|urday)?\b|\byesterday\b|\blast night\b/;

/** A forward cue anywhere in the clause before the token (an ETA, a threshold, a schedule). */
const FORWARD_CUE_RE = /[~≈≥≤]|>=|<=|\b(?:next|eta|scheduled|schedule|armed|re-?armed|expected|expect|projected|estimated|will|due|until|till|by|before|after|from|starting|deadline|target|checkpoint|window|fires?|firing|on pace|pace for|planned|resumes?|wait(?:s|ing)? for|watch(?:ing)? for|hold|held|ends?|expires?)\b/i;

/** "as of <clock>" */
const AS_OF_BEFORE_RE = /\bas[ -]of\s*[:(]?\s*$/i;
/** "now <clock>" / "currently <clock>" / "it is <clock>" */
const NOW_BEFORE_RE = /\b(?:now|right now|currently|it is|it's)\s*[:(—–-]?\s*$/i;
/** "<clock> now" / "<clock> (now)" */
const NOW_AFTER_RE = /^\s*[)\]]?\s*(?:[—–-]\s*)?\(?\s*(?:now|right now)\b/i;
/** "<observation verb> [≤4 words] at|@|as of|through <clock>" (the 375c8618 Re-Send class: "verified through 15:03:42Z") */
const OBS_VERB_BEFORE_RE = /\b(?:saw|seen|see|verified|re-?verified|confirmed|probed|re-?probed|checked|re-?checked|observed|measured|polled|pulled|read|found|sampled|captured|queried|inspected)\b(?:\s+\S+){0,4}?\s+(?:at|@|as of|through|thru)\s*$/i;
/** "<completed-event verb> [≤4 words] at|@ <clock>" — an event stamped as having HAPPENED at that clock
 *  (the 1c2eb455 class: "todo d17821d0 done at 06:05:31Z" at a real 06:03:46Z). Never "armed / scheduled at". */
const EVENT_VERB_AT_RE = /\b(?:done|merged|landed|completed|finished|fired|sent|posted|delivered|banked|pushed|deployed|acknowledged|acked|replied|answered|reported|started|launched|restarted|ran|returned|passed|failed|closed|filed|recorded|logged|registered|succeeded|exited|crashed|died)\b(?:\s+\S+){0,4}?\s+(?:at|@)\s*$/i;
/** "at <clock>" / "@<clock>" */
const AT_BEFORE_RE = /(?:\bat|@)\s*$/i;
/** "<clock>, I saw / the probe found / it showed …" */
const OBS_VERB_AFTER_RE = /^\s*[,)\]]?\s*(?:[—–-]\s*)?(?:(?:i|we|it|the\s+\w+|probe|check)\s+)?(?:saw|see|verified|confirmed|probed|checked|observed|measured|polled|read|found|showed|shows|returned|reported)\b/i;

function clauseAround(line: string, idx: number, tokenLen: number): { before: string; after: string } {
  const head = line.slice(0, idx);
  const lastSep = (s: string): { start: number; sep: string } => {
    let start = 0;
    let sep = '';
    CLAUSE_SEP_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = CLAUSE_SEP_RE.exec(s))) { start = m.index + m[0].length; sep = m[0]; }
    return { start, sep };
  };
  const { start, sep } = lastSep(head);
  let before = head.slice(start);
  // "now (06:33Z)" / "as of (06:33Z)": a token opening its own parenthesis reads with the clause before it.
  if (!before.trim() && sep.trim() === '(') {
    const outerHead = head.slice(0, start - sep.length);
    before = `${outerHead.slice(lastSep(outerHead).start)}(`;
  }
  if (before.length > CLAUSE_MAX) before = before.slice(before.length - CLAUSE_MAX);
  const tail = line.slice(idx + tokenLen);
  CLAUSE_SEP_RE.lastIndex = 0;
  const next = CLAUSE_SEP_RE.exec(tail);
  // the immediate punctuation after the token stays visible to NOW_AFTER_RE / OBS_VERB_AFTER_RE ("…Z) now")
  const cut = next ? Math.max(next.index + next[0].length, Math.min(tail.length, 3)) : tail.length;
  let after = tail.slice(0, Math.min(cut, CLAUSE_MAX));
  if (next && next.index === 0) {
    // a leading separator ("), I saw …" / ", the probe found …"): read the next clause too
    const rest = tail.slice(next[0].length);
    CLAUSE_SEP_RE.lastIndex = 0;
    const n2 = CLAUSE_SEP_RE.exec(rest);
    after = tail.slice(0, Math.min(next[0].length + (n2 ? n2.index : rest.length), CLAUSE_MAX));
  }
  return { before, after };
}

/** Classify one detector hit. Pure; exported for tests. */
export function classifyFutureClockHit(hit: ClockHitLike): ClockHitVerdict {
  const token = String(hit?.token ?? '');
  const line = String(hit?.line ?? '');
  if (!token) return 'not_observation';
  if (/\d{4}-\d{2}-\d{2}/.test(token)) return 'dated';
  const idx = line.indexOf(token);
  if (idx < 0) return 'not_observation'; // the excerpt lost the token — never convict what cannot be read
  const { before, after } = clauseAround(line, idx, token.length);
  if (CLAUSE_DATE_RE.test(before) || CLAUSE_DATE_RE.test(after.slice(0, 16))) return 'dated';
  const observation = AS_OF_BEFORE_RE.test(before)
    || NOW_BEFORE_RE.test(before)
    || NOW_AFTER_RE.test(after)
    || OBS_VERB_BEFORE_RE.test(before)
    || EVENT_VERB_AT_RE.test(before)
    || (AT_BEFORE_RE.test(before) && OBS_VERB_AFTER_RE.test(after));
  if (!observation) return FORWARD_CUE_RE.test(before) ? 'forward' : 'not_observation';
  // An observation cue with a forward marker AT the token ("as of ~06:33Z", "now, next fire 06:33Z") is an estimate.
  const nearBefore = before.slice(-24);
  if (/[~≈≥≤]\s*$|>=\s*$|<=\s*$/.test(before) || /\b(?:next|eta|scheduled|armed|expected|projected|estimated|will|due)\b/i.test(nearBefore)) return 'forward';
  return 'convicted';
}

export interface ClockPartition<T> {
  convicted: T[];
  observed: Array<T & { verdict: Exclude<ClockHitVerdict, 'convicted'> }>;
}

/** Split detector hits into convicted (observation-shaped) and observed-only. Pure. */
export function partitionFutureClockHits<T extends ClockHitLike>(hits: readonly T[]): ClockPartition<T> {
  const convicted: T[] = [];
  const observed: Array<T & { verdict: Exclude<ClockHitVerdict, 'convicted'> }> = [];
  for (const h of hits ?? []) {
    const v = classifyFutureClockHit(h);
    if (v === 'convicted') convicted.push(h);
    else observed.push({ ...h, verdict: v });
  }
  return { convicted, observed };
}

/** What the guard decided about a note's future clocks (rides ActionGuardResult.clockVerdict → the seam's telemetry). */
export interface FutureClockVerdict {
  /** 'annotated' = ≥1 convicted clock, note delivered as written + annotation; 'observed' = hits, none convicted;
   *  'replaced' = the legacy lane (FUTURE_CLOCK_REPLACE_ENABLED=1) replaced the note. */
  outcome: 'annotated' | 'observed' | 'replaced';
  legacy: boolean;
  hits: Array<{ token: string; minutesAhead: number; line: string; verdict: ClockHitVerdict }>;
}
