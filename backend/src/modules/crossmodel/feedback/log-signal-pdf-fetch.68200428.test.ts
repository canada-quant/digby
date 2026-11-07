/**
 * REPLAY TEST — ticket 68200428 (2026-11-06, family lane a10726b9): the
 * log-signal autofiler stamps an unattainable volume bar on the web-search PDF
 * fetch/extract class, so the post-deploy verifier reopens it forever.
 *
 * THE DEFECT THIS REPLAYS (measured in production, not a fixture).
 * `Digby Web Search: PDF fetch/extract failed for "<url>": <reason>` is emitted
 * once per failed TARGET by mcp-search.ts `extractPdfTextFromUrl`'s catch. The
 * sweep filed this ticket on 11 rows / 3 boot episodes (the rule1-boots shape),
 * and the autofiler attached its default `app_error_log_count <= 2` over the
 * derived fragment.
 *
 * MEASURED FRAGMENT — the reason the bar can never clear. `stableLiteralFragment`
 * keeps the longest literal run, which for this message is the head ending at
 * the FIRST variable token. `normalizeLogMessage` collapses digit runs, so the
 * head stops at the first numeric path segment and the stored bar is a per-HOST
 * prefix that does NOT carry the failure reason:
 *
 *   'digby web search: pdf fetch/extract failed for "https://www.asbca.mil/portals/'   (78 chars)
 *
 * Three of this ticket's own live rows match it, and a same-host row with a
 * DIFFERENT reason matches it too (the 78-char cut sits well before the colon).
 * So the bar counts this target class's research traffic, which no fix can zero.
 *
 * THE CLASS IS DESIGNED END TO END — measured, not assumed (2026-11-06):
 *   - 403/402/503 arms: the third-party document server refuses us. Re-probed
 *     www.asbca.mil with a full browser User-Agent and the same AkamaiGHost
 *     `Access Denied` 403 body came back, so this is not bot-blocking a
 *     User-Agent fix could mitigate.
 *   - maxContentLength arm: PDF_FETCH_MAX_BYTES is a deliberate 20 MiB memory
 *     bound, not a bug to "fix" by raising it.
 *   - redirect-loop arm: ticket 33005438 already adjudicated this same class a
 *     false positive for isap.sejm.gov.pl.
 * One warn per target, then null and the caller falls through to the rest of the
 * search results — never a retry storm (pinned below).
 *
 * WHY THE PRIOR LANE'S "FIX" DID NOT CLOSE IT. PR #2579 (641c63e0) was
 * TEST-ONLY — 1 file, 187 insertions, zero production change — and it recorded
 * its own commitSha on the close. `noteNamesShippedFix` therefore saw a shipped
 * fix, `waivable` went false, no `verification.metricWaived` was stamped, and
 * the verifier measured the still-frozen unattainable bar and reopened at 4 vs
 * 2. The taxonomy fix, not another test-only close, is what breaks the loop.
 *
 * This file pins (a) the autofiler now attaches NO volume bar and FLAGS the row
 * instead, (b) the verifier redirects a STORED bar to NEEDS METRIC REVIEW
 * rather than reopening, and (c) the recall guards that keep genuinely fixable
 * classes measurable.
 */
import {
  designedAlarmOfMetric,
  designedAlarmOfFingerprint,
  designedObservabilityOfFingerprint,
  stableLiteralFragment,
  AUTOFILER_DEFAULT_METRIC_SOURCE,
} from './acceptance-metric-defaults';
import type { AcceptanceMetric } from './ticket-metric';

// log-signal-sweep.service.ts imports config/database, whose env validator calls
// process.exit(1) when DATABASE_URL/JWT secrets are absent — which is the normal
// state under the verify chain. Stub the side-effecting leaves BEFORE the import
// graph is evaluated (jest.mock is hoisted above imports), so this file pins the
// PURE builders only. Same posture as the dc4f7ff5 sibling.
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../config/database', () => ({ __esModule: true, default: {} }));
jest.mock('../../../config/redis', () => ({ __esModule: true, default: {} }));

import { logSignalMetricContext, normalizeLogMessage } from '../fleet/log-signal-sweep.service';

// ── THE TICKET'S OWN LIVE ROWS, verbatim from get_fleet_telemetry ───────────
// (2026-11-06, hours 24, search 'pdf fetch/extract failed'). Three asbca.mil
// targets + the two other hosts the same window carried.
const ROW_403_V1 =
  'Digby Web Search: PDF fetch/extract failed for "https://www.asbca.mil/Portals/143/Decisions/2010/89836-v1-56": Request failed with status code 403';
const ROW_403_MAC =
  'Digby Web Search: PDF fetch/extract failed for "https://www.asbca.mil/Portals/143/Decisions/2013/56355%20MAC": Request failed with status code 403';
const ROW_403_PDF =
  'Digby Web Search: PDF fetch/extract failed for "https://www.asbca.mil/Decisions/2010/56355.pdf": Request failed with status code 403';
const ROW_404_FDA =
  'Digby Web Search: PDF fetch/extract failed for "https://www.accessdata.fda.gov/drugsatfda_docs/label/2018/02": Request failed with status code 404';
const ROW_402_GLOBALSECURITY =
  'Digby Web Search: PDF fetch/extract failed for "https://www.globalsecurity.org/military/library/report/2006/": Request failed with status code 402';

// The other arms of the SAME emit site, all designed for the same reasons.
const ROW_MAXLEN_DUPONT =
  'Digby Web Search: PDF fetch/extract failed for "https://www.dupont.com/content/dam/dupont/amer/us/en/perform": maxContentLength size of 20971520 exceeded';
const ROW_REDIRECT_ISAP =
  'Digby Web Search: PDF fetch/extract failed for "https://isap.sejm.gov.pl/isap.nsf/download.xsp/WDU2017000035": Maximum number of redirects exceeded';
const ROW_503_ROCKWOOL =
  'Digby Web Search: PDF fetch/extract failed for "https://www.rockwool.com/siteassets/o2-rockwool/documentatio": Request failed with status code 503';

const ALL_CLASS_ROWS = [
  ROW_403_V1, ROW_403_MAC, ROW_403_PDF, ROW_404_FDA, ROW_402_GLOBALSECURITY,
  ROW_MAXLEN_DUPONT, ROW_REDIRECT_ISAP, ROW_503_ROCKWOOL,
];

const metricCtx = (raw: string, siblings: ReadonlyArray<{ fingerprint: string; exampleMessage: string }> = []) =>
  logSignalMetricContext(
    { fingerprint: normalizeLogMessage(raw), levels: ['warn'], sources: ['web-search'], exampleMessage: raw },
    {},
    siblings,
  );

const autofilerMetric = (messagePattern: string): AcceptanceMetric => ({
  probe: 'app_error_log_count',
  params: { messagePattern, level: 'warn', source: 'web-search' },
  operator: '<=',
  target: 2,
  windowHours: 24,
});

describe('68200428 — the web-search PDF fetch/extract class gets NO volume bar', () => {
  it('SPECIMEN: the ticket\u2019s newest 403 row no longer stamps a volume default', () => {
    const ctx = metricCtx(ROW_403_V1);
    expect(ctx.acceptanceMetric).toBeUndefined();
    // FLAGGED, not silently dropped — the row stays on the done-bar board.
    expect(ctx.acceptanceMetricMissing).toBe(true);
    expect(ctx.acceptanceMetricDesignedObservability).toBe('websearch-pdf-fetch-target');
  });

  // EVERY arm of the emit site is designed, so every arm must be covered — the
  // strength and the risk of a template-wide signature, both pinned here.
  it('covers every live arm: 403 / 404 / 402 / 503 / maxContentLength / redirect loop', () => {
    for (const raw of ALL_CLASS_ROWS) {
      const ctx = metricCtx(raw);
      expect(ctx.acceptanceMetric).toBeUndefined();
      expect(ctx.acceptanceMetricDesignedObservability).toBe('websearch-pdf-fetch-target');
    }
  });

  // ── THE MEASUREMENT THAT JUSTIFIES THE SIGNATURE WIDTH ────────────────────
  // The derived fragment is a per-HOST prefix that stops at the first digit run
  // and never reaches the reason. That is why a shape-based test on the bar
  // could not separate the by-design 403 from a fixable same-host arm — and why
  // the bar itself is unattainable. Pinned as an executable measurement so a
  // future fragment-builder change cannot make the claim silently false.
  it('MEASURED: the derived bar is a host prefix that omits the reason', () => {
    const frag = stableLiteralFragment(normalizeLogMessage(ROW_403_V1), ROW_403_V1);
    expect(frag).toBe('digby web search: pdf fetch/extract failed for "https://www.asbca.mil/portals/');
    // It does not carry the reason ...
    expect(frag!.toLowerCase()).not.toContain('403');
    expect(frag!.toLowerCase()).not.toContain('status code');
    // ... and a same-host row with a DIFFERENT reason still contains it, i.e.
    // the bar spans arms a fix cannot distinguish.
    const sameHostOtherReason =
      'Digby Web Search: PDF fetch/extract failed for "https://www.asbca.mil/Portals/143/Decisions/2010/9": timeout of 20000ms exceeded';
    expect(sameHostOtherReason.toLowerCase()).toContain(frag!.toLowerCase());
  });

  // ── RECALL GUARDS ────────────────────────────────────────────────────────
  // This adds an EXEMPTION TIER to the metric detector (a class that no longer
  // gets a volume bar), so the DETECTOR-RECALL REPLAY obligation applies: every
  // PRIOR true positive of the detector must be replayed here and asserted to
  // STILL fire. The metric detector's prior true positives are the classes it
  // was built to hold to a bar — an ordinary framework fault and an ordinary
  // web-search fault — plus, critically, the EXTRACTOR warn that shares this
  // emit site's feature name but measures a different thing.
  //
  //   DETECTOR-RECALL REPLAY (metric true positive #1): an ordinary web-search
  //   fault still gets its volume bar (<`RECALL GUARD: an ordinary web-search
  //   fault still gets its volume bar`>).
  //
  //   DETECTOR-RECALL REPLAY (metric true positive #2): an ordinary framework
  //   fault (prisma P1001) still gets its volume bar (<`RECALL GUARD: an
  //   ordinary framework fault is untouched`>).
  //
  //   DETECTOR-RECALL REPLAY (metric true positive #3): the pdf-parse EXTRACTOR
  //   warn — the nearest neighbour of the exempted class, same feature name,
  //   different emitter — still gets its volume bar, so the exemption cannot
  //   swallow a regression in extraction (<`RECALL GUARD: the pdf-parse
  //   extractor warn keeps its volume bar`>).
  //
  //   DETECTOR-RECALL REPLAY (metric true positive #4 — the one our first cut
  //   MISSED): the `URI malformed` arm is OUR OWN bug, not a third-party
  //   condition. `extractPdfTextFromUrl` ran `decodeURIComponent(<last
  //   segment>)` inside the fetch's try, and a bare `%` throws for a PDF we had
  //   ALREADY downloaded (real target: asbca.mil `…/56355%MAC`). A
  //   template-wide signature would have retired the bar on a fixable defect
  //   (adversarial review, 2026-11-06). It keeps its volume bar
  //   (<`RECALL GUARD: the URI malformed arm keeps its bar`>).
  //
  // The EXTRACTOR's own warn is a DIFFERENT message measuring whether the
  // extractor works — a regression there must stay measurable.
  it('RECALL GUARD: the pdf-parse extractor warn keeps its volume bar', () => {
    const extractor = 'pdf-parse getText() failed for 89836-v1-56.pdf: Invalid PDF structure';
    expect(designedObservabilityOfFingerprint(normalizeLogMessage(extractor), extractor)).toBeNull();
    const ctx = metricCtx(extractor);
    expect(ctx.acceptanceMetricMissing).toBeUndefined();
    expect(ctx.acceptanceMetric).toBeDefined();
  });

  it('RECALL GUARD: the URI malformed arm keeps its bar (our bug, not a third party\u2019s)', () => {
    const ours = 'Digby Web Search: PDF fetch/extract failed for "https://www.asbca.mil/Portals/143/Decisions/2013/56355%MAC": URI malformed';
    // NOT designed observability — the signature excludes it.
    expect(designedObservabilityOfFingerprint(normalizeLogMessage(ours), ours)).toBeNull();
    const ctx = metricCtx(ours);
    expect(ctx.acceptanceMetricMissing).toBeUndefined();
    expect(ctx.acceptanceMetric).toBeDefined();
    // And a legacy STORED bar for this arm is never redirected away.
    expect(
      designedAlarmOfMetric(
        autofilerMetric('digby web search: pdf fetch/extract failed for "https://www.asbca.mil/portals/'),
        AUTOFILER_DEFAULT_METRIC_SOURCE,
      )?.id,
    ).toBe('websearch-pdf-fetch-target');
  });

  // THE REPAIR ITSELF: the bug that minted that arm. `decodeURIComponent` throws
  // on a bare `%`; the safe decode returns the raw segment so extraction
  // proceeds on the already-downloaded bytes.
  it('REPAIR: a bare % in the filename no longer throws (our bug is fixed at the emit site)', () => {
    const { safeDecodeUrlSegment } = require('../mcp-search');
    // The exact shape a real asbca.mil target carries.
    expect(() => decodeURIComponent('56355%MAC')).toThrow(/URI malformed/);
    expect(safeDecodeUrlSegment('56355%MAC')).toBe('56355%MAC');
    // Well-formed escapes still decode as before (the encodings in the live rows).
    expect(safeDecodeUrlSegment('56355%20MAC')).toBe('56355 MAC');
    expect(safeDecodeUrlSegment('normal-file.pdf')).toBe('normal-file.pdf');
  });

  it('RECALL GUARD: an ordinary web-search fault still gets its volume bar', () => {
    const ordinary = 'Digby Web Search: scrape_as_markdown failed after 2 gateway attempt(s): ECONNRESET';
    expect(designedObservabilityOfFingerprint(normalizeLogMessage(ordinary), ordinary)).toBeNull();
    const ctx = metricCtx(ordinary);
    expect(ctx.acceptanceMetricMissing).toBeUndefined();
    expect(ctx.acceptanceMetric).toBeDefined();
  });

  it('RECALL GUARD: an ordinary framework fault is untouched', () => {
    const ctx = metricCtx('prisma query failed: connection reset by peer (P1001)');
    expect(ctx.acceptanceMetricMissing).toBeUndefined();
    expect(ctx.acceptanceMetric).toBeDefined();
  });
});

describe('68200428 — a STORED unattainable bar is redirected, never reopened', () => {
  // The ACTUAL stored pattern, verbatim from the ticket's
  // context.acceptanceMetric (autofiler-default, target 2, window 24h).
  const STORED = 'digby web search: pdf fetch/extract failed for "https://www.asbca.mil/portals/';

  it('recognizes the ticket\u2019s own stored fragment as designed observability', () => {
    const hit = designedAlarmOfMetric(autofilerMetric(STORED), AUTOFILER_DEFAULT_METRIC_SOURCE);
    expect(hit?.id).toBe('websearch-pdf-fetch-target');
    expect(hit?.class).toBe('designed-observability');
    // The verifier's note quotes this, so it must explain the by-design reason.
    expect(hit?.why).toContain('per-target');
  });

  // Every OTHER host's stored bar is the same class — a lane must not have to
  // re-litigate this per host (the sweep files one ticket per fingerprint).
  it('recognizes the derived bar for the sibling hosts too', () => {
    for (const pattern of [
      'digby web search: pdf fetch/extract failed for "https://www.dupont.com/content/dam/dupont/amer/us/en/perform": maxconten',
      'digby web search: pdf fetch/extract failed for "https://isap.sejm.gov.pl/isap.nsf/download.xsp/wdu',
      'digby web search: pdf fetch/extract failed for "https://www.rockwool.com/siteassets/o2-rockwool/documentatio',
    ]) {
      expect(designedAlarmOfMetric(autofilerMetric(pattern), AUTOFILER_DEFAULT_METRIC_SOURCE)?.id)
        .toBe('websearch-pdf-fetch-target');
    }
  });

  // GUARDRAIL (inherited from 1425001e): never a lane's escape hatch. The hatch
  // is keyed on an EXPLICIT hand-authored marker (ticket 31199f81) — absence of
  // a marker is NOT a claim, so a markerless bar is classified on its content.
  it('REFUSES an EXPLICITLY hand-authored metric — the escape-hatch guard still holds', () => {
    for (const source of ['manual', 'lane-authored', 'filer']) {
      expect(designedAlarmOfMetric(autofilerMetric(STORED), source)).toBeNull();
    }
  });

  it('a MARKERLESS stored bar is classified on its content (ticket 31199f81)', () => {
    for (const source of [undefined, null, '']) {
      expect(designedAlarmOfMetric(autofilerMetric(STORED), source)?.id).toBe('websearch-pdf-fetch-target');
    }
  });

  // Detection must not weaken: the extractor's metric is NOT redirected.
  it('does NOT redirect the extractor\u2019s metric', () => {
    expect(
      designedAlarmOfMetric(
        autofilerMetric('pdf-parse gettext() failed for'),
        AUTOFILER_DEFAULT_METRIC_SOURCE,
      ),
    ).toBeNull();
  });

  // The two signatures this extends keep their own labels (no regression).
  it('still reports the existing classes unchanged', () => {
    expect(
      designedAlarmOfMetric(autofilerMetric('utilitychat: utility role override unreachable (timeout of'), AUTOFILER_DEFAULT_METRIC_SOURCE)?.id,
    ).toBe('utility-override-failover');
    expect(
      designedAlarmOfMetric(autofilerMetric('llm-extracted note claim(s) narrating third-party lane status — real artifacts owned by oth'), AUTOFILER_DEFAULT_METRIC_SOURCE)?.id,
    ).toBe('action-verifier-drop-guard');
  });
});

describe('68200428 — the emit site is a per-target warn, never a retry storm', () => {
  const fs = require('fs');
  const path = require('path');
  const read = (rel: string) => fs.readFileSync(path.join(__dirname, rel), 'utf8') as string;

  /** Every .ts/.tsx file under src, excluding tests and node_modules. */
  const sourceFiles = (dir: string, out: string[] = []): string[] => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
        sourceFiles(p, out);
      } else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) {
        out.push(p);
      }
    }
    return out;
  };

  /**
   * Lines that actually EMIT, not lines that merely MENTION the template.
   *
   * A prose mention must never satisfy (or fail) a "one emitter" pin: the first
   * cut of this test counted comment lines, so the very doc comment explaining
   * the repair made the pin fail (caught by the verify chain, not by review).
   * Code-context only: drop `//` and block-comment `*` lines.
   */
  const emitLines = (src: string) =>
    src.split('\n').filter((l) => {
      const t = l.trim();
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return false;
      return l.includes('PDF fetch/extract failed');
    });

  // SOURCE-LEVEL PIN — the basis for a template-wide signature. Exactly ONE
  // emitter REPO-WIDE; if a future refactor adds a second one (or a retry
  // inside it) the class stops being "one warn per target" and this pin fails,
  // forcing the signature to be revisited instead of silently widening.
  //
  // REPO-WIDE, not one file: a sibling call site already exists
  // (`coding/web-pipe.ts` calls `extractPdfTextFromUrl(...).catch(() => null)`),
  // and a single-file scan could not see a SECOND emitter added elsewhere
  // (adversarial review of this ticket, 2026-11-06).
  it('PIN: exactly one emit site REPO-WIDE, and the fetch is never retried', () => {
    const roots = [path.join(__dirname, '../../..')]; // backend/src
    const files = roots.flatMap((r) => sourceFiles(r));
    expect(files.length).toBeGreaterThan(500); // the scan really walked the tree

    const emitters = files
      .map((f) => ({ file: path.relative(path.join(__dirname, '../../..'), f), lines: emitLines(fs.readFileSync(f, 'utf8')) }))
      .filter((x) => x.lines.length > 0);

    expect(emitters).toHaveLength(1);
    expect(emitters[0].file).toBe(path.join('modules', 'crossmodel', 'mcp-search.ts'));
    expect(emitters[0].lines).toHaveLength(1);

    const src = read('../mcp-search.ts');

    // The emit is the catch of extractPdfTextFromUrl, whose ONLY outcome on
    // failure is `return null` — the caller falls through, it never re-calls.
    const fnAt = src.indexOf('export async function extractPdfTextFromUrl');
    expect(fnAt).toBeGreaterThan(0);
    const body = src.slice(fnAt, src.indexOf('\n// ──', fnAt) > 0 ? src.indexOf('\n// ──', fnAt) : fnAt + 4000);
    expect(body).toContain('PDF fetch/extract failed');
    expect(body).toContain('return null');
    // No loop/retry construct wraps the fetch, and the function is called once
    // per target from the scrape path (not inside a retry ladder).
    expect(body).not.toMatch(/for\s*\(|while\s*\(|maxRetries|attempt\s*</);
    // The filename decode must NOT be able to throw (our own bug, ticket
    // 68200428 review): `safeDecodeUrlSegment` swallows URIError.
    expect(body).toContain('safeDecodeUrlSegment(');
    expect(body).not.toContain('decodeURIComponent(');
    // The 20 MiB cap is a deliberate bound, not an accident to be "fixed" up.
    expect(src).toContain('const PDF_FETCH_MAX_BYTES = 20 * 1024 * 1024;');
    expect(src).toContain('const PDF_FETCH_TIMEOUT_MS = 20_000;');
  });

  // NOT A FILING-STOP: the sweep must keep fingerprinting and filing this class
  // (the per-target warn is the only account of which research targets fail, and
  // it is what surfaced this ticket). The de-filing predicate is the designed
  // ALARM set, which must stay blind to it.
  it('the filing-stop predicate is UNCHANGED — the class still files tickets', () => {
    for (const raw of ALL_CLASS_ROWS) {
      expect(designedAlarmOfFingerprint(normalizeLogMessage(raw), raw)).toBeNull();
    }
  });
});