/**
 * v0.7.0/0.7.1/0.7.2/0.7.3 — calendar read path (ticket 1ea9a120): the calendar TCC advert
 * latch, the calendar_list_events dispatch pin, and the &cal= poll param.
 *
 * THE CONTRACT: the advert must reflect REAL read outcomes, never a
 * standalone probe. noteCalendarRead(true) on a successful read (the
 * Calendar.app automation consent fires on the first real read, which is
 * the whole point of feeding the latch from the dispatch path);
 * noteCalendarRead(false) on a classified DENIAL (calendar.ts's
 * reason:'calendar-denied' — the TCC -1743 "not authorized to send Apple
 * events" class); an UNREACHABLE read (Calendar.app quit ≠ permission
 * revoked) feeds NOTHING, so the advert keeps its previous value.
 *
 * This pins the 2f646c10 stale-truth rule on the calendar axis: a denial
 * must never masquerade as unreachable, and neither may masquerade as a
 * grant. The absent key (no read yet) must round-trip as absent — the
 * backend merge (mergeAgentPermissions) relies on that to keep an absent
 * advert from clobbering a stored true.
 *
 * Run: `npm test` in imessage-agent/ (builds dist/ first).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, '..', 'dist');
const src = join(here, '..', 'src');

test('calendar advert latch dynamics: true → false → idempotent denial → true again', async () => {
  // Fresh import so module state from other test files cannot leak in.
  const { noteCalendarRead, calendarAdvert } = await import(join(dist, 'permissions.js'));
  // A fresh import of the same specifier shares module state with the poll
  // path in production, so the pre-state is whatever this import carries —
  // assert the DYNAMICS, not an assumed starting value.
  noteCalendarRead(true);
  assert.equal(calendarAdvert(), true, 'successful read must set the advert true');
  noteCalendarRead(false);
  assert.equal(calendarAdvert(), false, 'classified denial must set the advert false');
  // Re-feed a denial → still false (idempotent latch, no flap).
  noteCalendarRead(false);
  assert.equal(calendarAdvert(), false);
  noteCalendarRead(true);
  assert.equal(calendarAdvert(), true, 'a later granted read flips it back on');
});

test('calendar latch is NEVER fed by an unreachable read — the dispatch pins it', () => {
  // The latch dynamics are behavioral (above); the unreachable-never-feeds
  // rule is pinned STRUCTURALLY: index.ts may only call noteCalendarRead on
  // result.events !== null (grant) or unavailable.reason ===
  // 'calendar-denied' (denial) — an unreachable result must reach neither
  // arm. This is the exact 2f646c10 class fix (told "granted" while dead).
  const index = readFileSync(join(src, 'index.ts'), 'utf8');
  const caseMatch = index.match(/case 'calendar_list_events':\s*\{([\s\S]*?)\n    \}/);
  assert.ok(caseMatch, 'index.ts must keep a calendar_list_events case');
  const body = caseMatch[1];
  const feeds = [...body.matchAll(/noteCalendarRead\((true|false)\)/g)].map((m) => m[1]);
  assert.deepEqual(
    feeds,
    ['true', 'false'],
    'the case must feed the latch exactly once per branch: grant(true) then denial(false)',
  );
  assert.match(body, /result\.events !== null/, 'grant arm: events !== null');
  assert.match(body, /unavailable\?\.reason === 'calendar-denied'/, 'denial arm: classified reason only');
  assert.doesNotMatch(
    body,
    /noteCalendarRead\([^)]*\)\s*;?\s*\/\/.*unreachable/i,
    'no unreachable feed anywhere in the case',
  );
});

test('calendar_list_events dispatch pin: no throw, structured unavailable, days clamp', () => {
  const index = readFileSync(join(src, 'index.ts'), 'utf8');
  // The handler must never throw — every failure shape returns
  // {events:null, unavailable:{reason, pane:'calendar'}} so the backend's
  // dispatch resolves and can surface the reason (a thrown error 504s the
  // poll and loses the class — the same pin as permissions.2f646c10).
  assert.match(index, /const result = await listEvents\(days\);/, 'delegates to listEvents(days)');
  assert.match(index, /return result;/, 'returns the classified result, never a throw');
  // days clamp: 1..120 mirrors the Google connector's default-7 semantics.
  assert.match(index, /Math\.min\(Math\.max\(Number\(params\.days\) \|\| 7, 1\), 120\)/, 'days clamped 1..120, default 7');
});

test('api.ts: the poll URL carries &cal= only when the advert is derived', () => {
  const api = readFileSync(join(src, 'api.ts'), 'utf8');
  // Optional-key contract: the param rides ONLY when calendarAdvert() is
  // defined — an agent that has never done a calendar read must not claim
  // any calendar state (a wrong claim would either clobber the stored
  // value or freeze it). This is the absent-never-clobbers seam.
  // api.ts serializes the PermissionStatus the poll loop hands it — the advert
  // DERIVATION (calendarAdvert) lives in permissions.ts; api.ts only guards
  // the optional key: absent (undefined = never read) → param stays ABSENT.
  assert.match(
    api,
    /if \(p\.calendar !== undefined\) q \+= `&cal=\$\{p\.calendar \? 1 : 0\}`;/,
    'the &cal= param rides only when the calendar key is defined',
  );
  assert.match(api, /if \(!p\) return '';/, 'a null status (legacy poll) advertises nothing at all');
});

test('calendar.ts classification: -1743 / "not authorized" stderr → calendar-denied, else unreachable', () => {
  const calendarSrc = readFileSync(join(src, 'calendar.ts'), 'utf8');
  // The classifier is the ground truth the latch and the backend both lean
  // on: isDenied must catch the TCC -1743 / "not authorized to send Apple
  // events" class and ONLY that — anything else (Calendar.app quit, launch
  // timeouts, malformed output) is calendar-unreachable, which never feeds
  // the latch.
  // The source regex uses `?` as a QUANTIFIER (`apple ?events`) — escape it
  // here so this pin matches the source bytes, not a phantom of them.
  assert.match(calendarSrc, /not authorized\|apple \?events\|-1743\|automation/i, 'isDenied regex covers the TCC denial class');
  assert.match(calendarSrc, /'calendar-denied'\s*\|\s*'calendar-never-requested'\s*\|\s*'calendar-unreachable'/, 'all reasons exist in the union (daf8706a added never-requested)');
  assert.match(calendarSrc, /unavailable\('calendar-denied'\)/, 'denial classified at both resolve sites');
  assert.match(calendarSrc, /unavailable\('calendar-unreachable'\)/, 'unreachable classified at both resolve sites');
  assert.match(calendarSrc, /events: null, unavailable: \{ reason, pane: 'calendar', client: TCC_CLIENT_PATH \}/, 'unavailable shape carries pane AND the TCC client (daf8706a)');
});

test('v0.7.3 version pin: the calendar read path ships stamped', () => {
  const pkg = JSON.parse(readFileSync(join(src, '..', 'package.json'), 'utf8'));
  const [maj, min] = pkg.version.split('.').map(Number);
  assert.ok(maj > 0 || min >= 7, `the calendar read path ships in agent >= 0.7.3 (found ${pkg.version})`);
});

test('api.ts: the pair body carries the backend canonical `cal` key, never raw `calendar`', () => {
  const api = readFileSync(join(src, 'api.ts'), 'utf8');
  // The pair body must serialize through pairPermissions so a calendar grant
  // lands under the ONE key the backend's permissionsFromBody reads (`cal`)
  // — a raw PermissionStatus would send `calendar` and the parser would
  // silently drop it (the pair/poll wire-key asymmetry the 0.7.0
  // adversarial review caught; the poll already maps via &cal=).
  assert.match(api, /function pairPermissions\(p: PermissionStatus\)/, 'the pair body serializes through the wire-key mapper');
  assert.match(api, /if \(p\.calendar !== undefined\) wire\.cal = p\.calendar;/, '`calendar` maps to `cal` at the wire boundary');
  assert.match(api, /permissions: pairPermissions\(permissions\)/, 'the pair body carries the mapped shape');
  assert.doesNotMatch(api, /\{ permissions \}/, 'the raw PermissionStatus object never rides the pair body');
});

// ── v0.7.3 sign-in guard (owner directive 2026-10-07) ────────────────────────
// "the mbp-2 is not logged in to my apple account and does not contain my
// calendar events… make sure user is logged into apple account when trying
// to use these services" — a Mac with ZERO calendars (not signed in) must
// classify as no-calendar-account, NEVER a silent empty success.

test('v0.7.3 sign-in guard: zero-calendars Mac classifies as no-calendar-account (never an empty success)', () => {
  const calendarSrc = readFileSync(join(src, 'calendar.ts'), 'utf8');
  // The guard errors BEFORE any read: count the store's calendars right
  // after construction; zero → the marker the classifier keys on.
  assert.match(calendarSrc, /calCount is 0/, 'the ASOC script guards zero calendars');
  assert.match(calendarSrc, /no calendar account: EventKit reports 0 calendars/, 'the error marker the TS classifier keys on');
  assert.match(calendarSrc, /'no-calendar-account'/, 'the classified reason is minted');
  // The classifier must catch the marker BEFORE the denial classifier (the
  // marker contains neither 'not authorized' nor -1743, but ordering is the
  // belt-and-braces pin anyway).
  const noAcctIdx = calendarSrc.indexOf("isNoAccount(String(stderr))");
  const deniedIdx = calendarSrc.indexOf("isDenied(String(stderr))");
  assert.ok(noAcctIdx > -1 && deniedIdx > -1, 'both classifier arms exist');
  assert.ok(noAcctIdx < deniedIdx, 'no-account is classified BEFORE denial');
  assert.match(calendarSrc, /function isNoAccount\(stderr: string\): boolean \{\s*return \/no calendar account\/i\.test\(stderr \|\| ''\);/, 'the classifier catches the marker, case-insensitively');
});

test('v0.7.3 backend surfaced copy: no-calendar-account renders sign-in copy, not the raw shape', () => {
  // 2026-11-06: the copy moved OUT of the tool's dispatch case into
  // calendar/apple-calendar.ts — ONE place writes Apple Calendar copy so the
  // tool, the new-chat context and the home card cannot drift apart. The
  // INVARIANT is unchanged: a no-calendar-account read surfaces sign-in copy,
  // never the raw {events:null} shape the model could read as "nothing on".
  const policySrc = readFileSync(
    join(src, '..', '..', 'backend', 'src', 'modules', 'crossmodel', 'calendar', 'apple-calendar.ts'),
    'utf8',
  );
  assert.match(policySrc, /case 'no-calendar-account':/, 'the state has its own copy arm');
  assert.match(policySrc, /not signed in to an Apple account/, 'the surfaced copy names the fix (sign in)');
  // And the tool still routes through the shared policy rather than telling
  // its own story.
  const backendSrc = readFileSync(
    join(src, '..', '..', 'backend', 'src', 'modules', 'crossmodel', 'coding', 'coding-integrations.ts'),
    'utf8',
  );
  assert.match(backendSrc, /readAppleCalendar\(userId/, 'the tool uses the shared Apple read');
});

test('v0.7.3 version pin: the sign-in guard ships stamped', () => {
  const pkg = JSON.parse(readFileSync(join(src, '..', 'package.json'), 'utf8'));
  const [maj, min] = pkg.version.split('.').map(Number);
  assert.ok(maj > 0 || min >= 7, `the sign-in guard ships in agent >= 0.7.3 (found ${pkg.version})`);
});
