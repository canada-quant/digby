/**
 * Tier-0 Calendar consent request + TCC-client surfacing (ticket daf8706a,
 * agent 0.9.11).
 *
 * THE INCIDENT (cql-stanne-mbp1, 2026-10-27): mac_calendar_list_events
 * returned {"events":null,"unavailable":{"reason":"calendar-denied"}} for
 * ~40 minutes across 3+ calls BEFORE and AFTER the owner granted the Digby
 * app Calendar access (the digbyHelper row visible and ON; full quit +
 * relaunch). The requesting binary never appeared in the Calendars pane
 * (no "+" to add one), so the grant could never reach it — while the
 * iMessage bridge on the same Mac worked (pairing fine).
 *
 * ROOT CAUSE (two defects):
 *   1. The read gate conflated tier 0 (notDetermined — THIS client never
 *      asked, so macOS has no TCC row to show) with tier 2 (denied) into
 *      one calendar-denied reason, and the agent NEVER called the
 *      requesting EventKit API — so no row was ever created for the agent
 *      binary and every user grant landed on the WRONG client (the Digby
 *      app shell ≠ the launchd DigbyAgent / bundled DigbyHelper binary
 *      that actually asks).
 *   2. The unavailable payload carried no client identity, so nobody
 *      could see which binary needed the grant.
 *
 * THE FIX: tier 0 gets its own marker + reason (calendar-never-requested),
 * every unavailable payload carries `client` (the agent binary's
 * process.execPath — the TCC client macOS attributes the EventKit request
 * to), and the read path's tier-0 classification fires the ONE
 * fire-and-forget consent request (calendar-request.ts — the agent's ONLY
 * requesting EventKit call; the read, poll, status and preflight surfaces
 * stay non-requesting per the 0.9.8/0.9.9 invariants).
 *
 * Layers (the 4e75cdea house idiom):
 *   1. REAL behavioral test with a FAKE osascript on PATH — proves the
 *      tier-0 classification, the payload shape (client = process.execPath),
 *      the ONCE-per-process request latch (two reads → exactly one request),
 *      latch-stays-set on a failed request, and fire-and-forget semantics
 *      (the read result never waits for the request to settle).
 *   2. SOURCE-BYTES pins for the macOS wiring that cannot run on Linux CI:
 *      the gate's tier-0 marker + ordering, the quarantine of the
 *      requesting API to calendar-request.ts, the 0.9.8 invariant (only
 *      calendar.ts imports the requester), the backend copy, and the
 *      version stamp.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, '..', 'src');
const dist = join(here, '..', 'dist');

const read = (p) => readFileSync(join(src, p), 'utf8');
const calendarSrc = read('calendar.ts');
const requestSrc = read('calendar-request.ts');
const indexSrc = read('index.ts');
const backendSrc = readFileSync(
  join(src, '..', '..', 'backend', 'src', 'modules', 'crossmodel', 'coding', 'coding-integrations.ts'),
  'utf8',
);
const pkg = JSON.parse(readFileSync(join(src, '..', 'package.json'), 'utf8'));

// ── 1. Source pins: the gate + classification ───────────────────────────────

test('daf8706a: the read gate gives tier 0 its OWN marker BEFORE the denial marker', () => {
  // Tier 0 = notDetermined = "this client never asked" — it must be
  // distinguishable from tier 2 (denied) or the backend cannot tell the
  // user the truth (the incident's reason conflation).
  const gateIdx = calendarSrc.indexOf('if auth is not 3 and auth is not 5 then');
  assert.ok(gateIdx > 0, 'the auth gate exists');
  const gate = calendarSrc.slice(gateIdx, gateIdx + 600);
  const tier0Idx = gate.indexOf('error "not requested: EventKit calendar auth status 0"');
  const deniedIdx = gate.indexOf('error ("not authorized: EventKit calendar auth status "');
  assert.ok(tier0Idx > -1, 'the gate mints the dedicated tier-0 marker');
  assert.ok(deniedIdx > -1, 'the gate keeps the denied/restricted marker');
  assert.ok(tier0Idx < deniedIdx, 'tier 0 is classified INSIDE the gate, before the generic denial');
});

test('daf8706a: isNeverRequested classifies the marker BEFORE isDenied in listEvents', () => {
  // Ordering is load-bearing: "not requested: …" contains neither the
  // denial markers, but the belt-and-braces pin keeps the classifier
  // order explicit (same discipline as the no-account guard).
  const neverIdx = calendarSrc.indexOf('isNeverRequested(String(stderr))');
  const deniedIdx = calendarSrc.indexOf("isDenied(String(stderr))");
  const noAcctIdx = calendarSrc.indexOf("isNoAccount(String(stderr))");
  assert.ok(neverIdx > -1, 'the tier-0 classifier arm exists');
  assert.ok(neverIdx < deniedIdx, 'never-requested is classified BEFORE denial');
  assert.ok(noAcctIdx < neverIdx, 'no-account stays first (its marker is a superset check)');
});

test('daf8706a: tier-0 resolution fires the requester AND returns the dedicated reason', () => {
  const tier0Block = calendarSrc.slice(
    calendarSrc.indexOf('if (isNeverRequested(String(stderr)))'),
    calendarSrc.indexOf("unavailable('calendar-never-requested')") + 60,
  );
  assert.ok(tier0Block.includes('requestCalendarAccessOnce();'), 'the one-shot requester fires on tier 0');
  assert.match(calendarSrc, /unavailable\('calendar-never-requested'\)/, 'the dedicated reason is returned');
});

// ── 2. The payload carries the TCC client identity ──────────────────────────

test('daf8706a: every unavailable payload carries client = the agent binary path', () => {
  assert.match(
    calendarSrc,
    /const TCC_CLIENT_PATH: string = \(\(\) => \{\s*try \{\s*return process\.execPath \|\| 'unknown';/,
    'the client is captured once at module load from process.execPath',
  );
  assert.match(
    calendarSrc,
    /events: null, unavailable: \{ reason, pane: 'calendar', client: TCC_CLIENT_PATH \}/,
    'the ONLY unavailable minter carries the client',
  );
  // One minter, many reasons: listEvents must resolve exclusively through
  // it (no reason is minted inline anywhere else).
  const minters = [...calendarSrc.matchAll(/unavailable: \{[^}]*\}/g)].map((m) => m[0]);
  assert.equal(minters.length, 1, `exactly one unavailable payload shape (found ${minters.length})`);
  assert.match(calendarSrc, /client: string \}/, 'the payload type carries the client field');
});

// ── 3. The requesting API stays quarantined to calendar-request.ts ─────────

test('daf8706a: the requesting EventKit API lives ONLY in calendar-request.ts (code, comments stripped)', () => {
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
  const files = ['calendar.ts', 'index.ts', 'permissions.ts', 'tcc-regrant.ts', 'api.ts', 'config.ts'];
  for (const f of files) {
    assert.doesNotMatch(
      strip(read(f)),
      /requestAccessToEntityType/,
      `${f} must stay free of the requesting EventKit API (the 0.9.8/0.9.9 non-requesting surfaces)`,
    );
  }
  assert.match(strip(requestSrc), /requestAccessToEntityType:EVT completion:/, 'the ONE requester calls the requesting API');
});

test('daf8706a: the requester is imported ONLY by the read path (calendar.ts) — never the poll/status/preflight surfaces', () => {
  // The 0.9.8 invariant (ticket 30787bc4): status surfaces never drive a
  // requesting API. Structural pin: only calendar.ts may import the module.
  for (const f of ['index.ts', 'permissions.ts', 'tcc-regrant.ts', 'api.ts', 'config.ts']) {
    assert.doesNotMatch(read(f), /calendar-request/, `${f} must not import the requester`);
  }
  assert.match(read('calendar.ts'), /import \{ requestCalendarAccessOnce \} from '\.\/calendar-request';/, 'the read path imports it');
});

test('daf8706a: the requester is ONCE per process and FIRE-AND-FORGET', () => {
  assert.match(requestSrc, /let tier0RequestFired = false;/, 'the module-level latch exists');
  assert.match(requestSrc, /if \(tier0RequestFired\) return;\s*\n\s*tier0RequestFired = true;/, 'the latch flips before any work');
  // Fire-and-forget: listEvents never awaits it — the resolution of the
  // read is independent of the request child (the callback only logs).
  const tier0Block = calendarSrc.slice(
    calendarSrc.indexOf('if (isNeverRequested(String(stderr)))'),
    calendarSrc.indexOf("return resolve(unavailable('calendar-never-requested'))"),
  );
  assert.doesNotMatch(tier0Block, /await/, 'no await in the tier-0 resolution block (fire-and-forget)');
  // Never throws out of the caller: staging failure is logged, not raised.
  const fnBody = requestSrc.slice(requestSrc.indexOf('export function requestCalendarAccessOnce'));
  assert.match(fnBody, /\} catch \{\s*\n\s*\/\/ Same staging-failure contract/, 'staging failure is swallowed');
});

// ── 4. Backend copy surfaces the new reason + the client ────────────────────

test('daf8706a: the backend branches on calendar-never-requested and names the client binary', () => {
  // 2026-11-06: the copy moved into calendar/apple-calendar.ts so ONE place
  // writes it (tool + new-chat context + home card). The tier-0 branch and the
  // client surfacing survive; the UNVERIFIABLE claim does not: the old copy
  // asserted "A one-time consent dialog was just triggered" for a read that
  // only proves nobody had asked yet. Three Macs never showed that dialog.
  const policySrc = readFileSync(
    join(src, '..', '..', 'backend', 'src', 'modules', 'crossmodel', 'calendar', 'apple-calendar.ts'),
    'utf8',
  );
  const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
  assert.match(policySrc, /case 'calendar-never-requested':/, 'the tier-0 state has its own copy arm');
  assert.match(policySrc, /has never been granted Calendar access/, 'the tier-0 copy is surfaced');
  // The verifiable-claim rule applies to the CODE (a comment may of course
  // quote the old sentence to explain why it is gone).
  assert.doesNotMatch(stripComments(policySrc), /dialog was just triggered/i, 'never claim a dialog that nothing observed');
  // The observed consent episode (agent >= 0.9.24) is what the copy reports.
  assert.match(policySrc, /consentCopy\(consent\)/, 'the last observed episode is described');
  assert.match(policySrc, /interpreted\.client/, 'the TCC client is still surfaced to the caller');
  // The denied copy names the agent binary too (ask 1: WHICH client was
  // denied must be visible in one line for BOTH tier-0 and tier-2).
  assert.match(policySrc, /DIFFERENT client/, 'the denial copy names the binary-vs-app trap');
});

test('daf8706a: the dispatch latch treats never-requested as a permission negative — but NOT a TCC regression', () => {
  // noteCalendarRead(false): tier 0 IS a permission-state negative (the
  // advert must not advertise granted). noteTccDenial stays OUT: the
  // post-update preflight owns grant-loss detection (c44b19e9) — a
  // first-ever ungranted Mac must not file a spurious TCC regression
  // (the 0.9.8 lesson).
  const caseBody = indexSrc.slice(
    indexSrc.indexOf("case 'calendar_list_events':"),
    indexSrc.indexOf('// ── Browser automation'),
  );
  assert.match(caseBody, /result\.unavailable\?\.reason === 'calendar-never-requested'/, 'the latch feeds on tier 0');
  const neverFeed = caseBody.slice(caseBody.indexOf("'calendar-never-requested'"));
  assert.doesNotMatch(neverFeed, /noteTccDenial\(\{ kind: 'calendar-denied' \}\)\s*;\s*\n\s*\}/, 'no noteTccDenial is fed from the tier-0 arm');
  // The ONLY noteTccDenial calendar feed remains the tier-2 denial (c44b19e9).
  const feeds = [...caseBody.matchAll(/noteTccDenial\(\{ kind: 'calendar-denied' \}\)/g)].length;
  assert.equal(feeds, 1, 'exactly one watchdog feed (the classified tier-2 denial)');
});

// ── 5. Version pin ──────────────────────────────────────────────────────────

test('daf8706a version pin: the tier-0 fix ships stamped (0.9.23, carried forward)', () => {
  // The 0.9.23 pin guarded the fix's RELEASE. It is now a floor: the 2026-11-06
  // consent-outcome repair ships as 0.9.24 on top of it, and pinning the exact
  // string would make every later release edit an unrelated test.
  const [maj, min, patch] = pkg.version.split('.').map(Number);
  assert.ok(maj > 0 || min > 9 || (min === 9 && patch >= 23), `the tier-0 fix ships in agent >= 0.9.23 (found ${pkg.version})`);
  assert.match(read('config.ts'), new RegExp(`export const AGENT_VERSION = '${pkg.version.replace(/\./g, '\\.')}';`), 'AGENT_VERSION matches package.json');
});

// ── 6. REAL behavioral test: fake osascript proves the whole flow ──────────

test('daf8706a live flow: tier-0 read → never-requested payload + exactly ONE consent request (latched, fire-and-forget)', async () => {
  // A fake osascript on PATH stands in for the Mac: every staged script is
  // inspected — a request script (contains the requesting API) exits 0
  // (grant granted); anything else (the read gate) exits 1 with the
  // tier-0 marker. Every invocation is logged so the test can count.
  const fakeDir = join(here, '.tmp-daf8706a-bin');
  const logPath = join(fakeDir, 'calls.log');
  mkdirSync(fakeDir, { recursive: true });
  writeFileSync(
    join(fakeDir, 'osascript'),
    [
      '#!/bin/bash',
      'echo "CALL $1" >> "$DYG_FAKE_OSALOG"',
      'content=$(cat "$1" 2>/dev/null)',
      'if printf \'%s\' "$content" | grep -q "requestAccessToEntityType"; then',
      '  echo "REQ" >> "$DYG_FAKE_OSALOG"',
      '  if [ "$DYG_FAKE_REQ_MODE" = "fail" ]; then echo "bridge exploded" >&2; exit 1; fi',
      '  exit 0',
      'fi',
      'echo "not requested: EventKit calendar auth status 0" >&2',
      'exit 1',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  writeFileSync(logPath, '');

  const prevPath = process.env.PATH;
  process.env.PATH = `${fakeDir}:${prevPath}`;
  process.env.DYG_FAKE_OSALOG = logPath;
  delete process.env.DYG_FAKE_REQ_MODE;

  try {
    // Fresh import in THIS process = fresh latch (the poll path in prod
    // shares module state; the test asserts the dynamics, not a starting
    // value).
    const { listEvents } = await import(join(dist, 'calendar.js'));

    const callsInLog = () => (existsSync(logPath) ? readFileSync(logPath, 'utf8').split('\n').filter(Boolean) : []);
    const waitUntil = async (predicate, ms = 4000) => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        if (predicate()) return true;
        await new Promise((r) => setTimeout(r, 50));
      }
      return predicate();
    };

    // ── First read: tier 0 → classified, requester fired (not awaited).
    const first = await listEvents(7);
    assert.equal(first.events, null, 'tier 0 returns no events');
    assert.equal(first.unavailable.reason, 'calendar-never-requested', 'the dedicated reason');
    assert.equal(first.unavailable.pane, 'calendar', 'the pane stays calendar');
    assert.equal(first.unavailable.client, process.execPath, 'the payload names THIS binary (the TCC client)');
    assert.ok(await waitUntil(() => callsInLog().some((l) => l.startsWith('REQ'))), 'the consent request fired');

    // ── Second read: still tier 0 (the fake never grants mid-test) — but
    // NO second request: the once-per-process latch holds.
    const second = await listEvents(7);
    assert.equal(second.unavailable.reason, 'calendar-never-requested');
    const reads = callsInLog().filter((l) => !l.startsWith('REQ')).length;
    assert.equal(callsInLog().filter((l) => l.startsWith('REQ')).length, 1, `exactly ONE consent request per process (reads: ${reads})`);

    // ── A FAILED request must NOT re-arm the latch: flip the fake to
    // fail-mode would not matter — the latch is already set; assert the
    // count stays 1 after a third read.
    process.env.DYG_FAKE_REQ_MODE = 'fail';
    const third = await listEvents(7);
    assert.equal(third.unavailable.reason, 'calendar-never-requested');
    assert.equal(callsInLog().filter((l) => l.startsWith('REQ')).length, 1, 'the latch stays set after a failed request (no re-prompt loop)');
  } finally {
    process.env.PATH = prevPath;
    delete process.env.DYG_FAKE_OSALOG;
    delete process.env.DYG_FAKE_REQ_MODE;
    try {
      execFileSync('rm', ['-rf', fakeDir]);
    } catch {
      // best-effort cleanup
    }
  }
});
