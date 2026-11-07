/**
 * TICKET d634e874 (2026-11-07) — an auto-filer bar must keep the EMITTER'S NAME.
 *
 * THE INCIDENT. `warnSeatFailure` (seat-call.ts:280) renders ONE template for
 * every seat role that shares it:
 *
 *     `${role} seat: ${p.model} (${p.label}) failed — ${describeSeatError(err)}`
 *
 * so `pdf_ocr seat: …` and `vision_describe seat: …` differ only in the leading
 * role token. `normalizeLogMessage` replaces each model/error number with a
 * `<n>` placeholder, which SPLITS the fingerprint into
 *   `pdf_ocr seat: api-optimize-zai-glm-`   (35 chars — carries the role)
 *   `-flash (llm-cql (custom endpoint)) failed — timeout of`  (53 chars)
 * and `stableLiteralFragment` took the LONGEST run — the one WITHOUT the role.
 *
 * MEASURED, all three roles deriving the identical string:
 *   pdf_ocr         → "flash (llm-cql (custom endpoint)) failed — timeout of"
 *   vision_describe → "flash (llm-cql (custom endpoint)) failed — timeout of"
 *   computer_vision → "flash (llm-cql (custom endpoint)) failed — timeout of"
 *
 * CONSEQUENCE (live). The 22-row pdf_ocr amplification was fixed in 082c8cbb60
 * (PR #2652) and deployed; the pdf_ocr count fell to ONE row. The post-deploy
 * verifier then REOPENED the ticket at 2026-11-07T15:05:49Z on `measured 3` —
 * two vision_describe and one computer_vision row from entirely different emit
 * sites. The bar was not measuring the defect's emit class at all, so no fix to
 * the pdf_ocr emitter could ever have cleared it.
 *
 * THE RULE THIS PINS: when a message NAMES ITS OWN EMITTER, the derived pattern
 * must keep that name. The sibling-discrimination pass (30dfad06) cannot supply
 * this guarantee — it only fires when a colliding sibling is visible in the
 * same pass, and the seat role that starts failing next week is by definition
 * not in it.
 */

jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    appErrorLog: { count: jest.fn() },
    loopMetric: { count: jest.fn() },
    userFeatureRequest: { count: jest.fn() },
  },
}));

// importing normalizeLogMessage from the sweep pulls its module graph — stub
// the two boot-time singletons the existing sweep suite stubs too, so this
// leaf-only pin never needs a live env.
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: { get: jest.fn(async () => null), set: jest.fn(async () => 'OK'), del: jest.fn(async () => 1), incr: jest.fn(async () => 1), decr: jest.fn(async () => 0), expire: jest.fn(async () => 1) },
}));
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { stableLiteralFragment, emitterScopedRun, healEmitterScopedPattern, fingerprintOfLogSignalTitle } from './acceptance-metric-defaults';
import { normalizeLogMessage } from '../fleet/log-signal-sweep.service';

/** The exact live raw rows (prod app_error_logs, 2026-11-07). */
const RAW_PDF = 'pdf_ocr seat: api-optimize-zai-glm-5.3-flash (llm-cql (custom endpoint)) failed — timeout of 90000ms exceeded';
const RAW_VIS = 'vision_describe seat: api-optimize-zai-glm-5.3-flash (llm-cql (custom endpoint)) failed — timeout of 45000ms exceeded';
const RAW_CV = 'computer_vision seat: api-optimize-zai-glm-5.3-flash (llm-cql (custom endpoint)) failed — timeout of 45000ms exceeded';

const matches = (pattern: string, row: string) => row.toLowerCase().includes(pattern.toLowerCase());

describe('d634e874 — the derived bar keeps the emit class', () => {
  const pdf = stableLiteralFragment(normalizeLogMessage(RAW_PDF), RAW_PDF);
  const vis = stableLiteralFragment(normalizeLogMessage(RAW_VIS), RAW_VIS);
  const cv = stableLiteralFragment(normalizeLogMessage(RAW_CV), RAW_CV);

  it('every seat role yields a bar, and it names its own role', () => {
    expect(pdf).toBeTruthy();
    expect(vis).toBeTruthy();
    expect(cv).toBeTruthy();
    expect(pdf!.toLowerCase().startsWith('pdf_ocr seat:')).toBe(true);
    expect(vis!.toLowerCase().startsWith('vision_describe seat:')).toBe(true);
    expect(cv!.toLowerCase().startsWith('computer_vision seat:')).toBe(true);
  });

  it('THE REGRESSION: the pdf_ocr bar matches its OWN rows and NOT the two unrelated classes', () => {
    expect(matches(pdf!, RAW_PDF)).toBe(true);
    expect(matches(pdf!, RAW_VIS)).toBe(false);
    expect(matches(pdf!, RAW_CV)).toBe(false);
  });

  it('the three roles derive three DISTINCT bars (no shared cross-emitter fingerprint)', () => {
    expect(new Set([pdf, vis, cv]).size).toBe(3);
    // …and each is scoped to itself, so a bar can never count a sibling's rows.
    expect(matches(vis!, RAW_VIS)).toBe(true);
    expect(matches(vis!, RAW_PDF)).toBe(false);
    expect(matches(cv!, RAW_CV)).toBe(true);
    expect(matches(cv!, RAW_PDF)).toBe(false);
  });

  it('the SHARED TAIL that caused the reopen can never become the bar for a seat row', () => {
    // The exact stored pattern that reopened d634e874 — it matches all three.
    const poisoned = 'flash (llm-cql (custom endpoint)) failed — timeout of';
    expect(matches(poisoned, RAW_VIS)).toBe(true);
    expect(matches(poisoned, RAW_CV)).toBe(true);
    // Whatever the derivation settles on, it is never this cross-emitter tail.
    for (const bar of [pdf, vis, cv]) expect(bar!.toLowerCase()).not.toBe(poisoned);
  });

  it('the bar stays a single-spaced literal run that the real rows contain', () => {
    // Whitespace-stable (review F2): no double spaces / newlines in the bar.
    for (const bar of [pdf, vis, cv]) {
      expect(bar).not.toMatch(/\s{2,}|\r?\n/);
      expect(bar!.length).toBeGreaterThanOrEqual(16);
    }
    // The fingerprint places <n> where the row carries digits — the bar is the
    // literal prefix BEFORE that placeholder, so it is a true substring.
    expect(pdf!.toLowerCase()).toContain('pdf_ocr seat:');
    expect(normalizeLogMessage(RAW_PDF).toLowerCase()).toContain(pdf!.toLowerCase());
  });
});

describe('d634e874 — emitterScopedRun unit shape', () => {
  it('reports NOT-required for a message that does not name an emitter', () => {
    const r = emitterScopedRun('session history sync: push refused permanently', ['session history sync: push refused permanently']);
    expect(r).toEqual({ required: false, run: null });
  });

  it('reports required-but-null when the message names an emitter but no run keeps it', () => {
    // The role token is the whole segment and everything else is placeholders:
    // too short to qualify, so NO bar rather than a cross-emitter one.
    const r = emitterScopedRun('vision_describe seat: <n> (<n>) failed — <n>', ['<n> (<n>) failed — <n>']);
    expect(r.required).toBe(true);
    expect(r.run).toBe(null);
  });

  it('takes the LONGEST run that keeps the emitter name, not merely any', () => {
    const r = emitterScopedRun('pdf_ocr seat: aaa (bbb) failed', ['pdf_ocr seat: aaa', 'pdf_ocr seat: aaa (bbb) failed', 'bbb) failed']);
    expect(r.run).toBe('pdf_ocr seat: aaa (bbb) failed');
  });

  it('never returns a run that only CONTAINS the role mid-string', () => {
    const r = emitterScopedRun('pdf_ocr seat: api-glm', ['warned about pdf_ocr seat: api-glm earlier']);
    expect(r.required).toBe(true);
    expect(r.run).toBe(null); // not anchored at the start ⇒ not this emitter's own name
  });
});

describe('d634e874 — messages WITHOUT an emitter name are untouched', () => {
  it('a plain non-seat message still derives its longest literal run', () => {
    expect(stableLiteralFragment('session history sync: push refused permanently (terminal auth)', undefined))
      .toBe('session history sync: push refused permanently (terminal auth)');
  });

  it('a non-seat message WITH a raw example still prefers a discriminating run', () => {
    const fp = 'brightdata direct: scrape_as_markdown failed: <n> request failed with status code <n>';
    const raw = 'BrightData direct: scrape_as_markdown failed: 500 Request failed with status code 500';
    const out = stableLiteralFragment(fp, raw);
    expect(out).toBeTruthy();
    expect(raw.toLowerCase()).toContain(out!.toLowerCase());
  });
});

describe('d634e874 — read-time heal re-scopes an ALREADY-STORED coarse pattern', () => {
  const STORED = { probe: 'app_error_log_count', params: { level: 'warn', messagePattern: 'flash (llm-cql (custom endpoint)) failed — timeout of', excludeLogClass: 'external' }, target: 2, operator: '<=', windowHours: 24 } as any;
  const FP = 'pdf_ocr seat: api-optimize-zai-glm-<n>-flash (llm-cql (custom endpoint)) failed — timeout of <n>ms exceeded';

  it('the ticket title yields the fingerprint', () => {
    expect(fingerprintOfLogSignalTitle(`log-signal: ${FP}`)).toBe(FP);
    expect(fingerprintOfLogSignalTitle('SCIM: Users/Groups')).toBe(null);
    expect(fingerprintOfLogSignalTitle(null)).toBe(null);
  });

  it('re-scopes the stored pattern to the ticket own role', () => {
    const h = healEmitterScopedPattern(STORED, 'autofiler-default', FP);
    expect(h.healed).toBe(true);
    expect(h.role).toBe('pdf_ocr');
    expect(h.metric.params.messagePattern).toBe('pdf_ocr seat: api-optimize-zai-glm');
    expect(h.metric.params.excludeLogClass).toBe('external'); // other filters preserved
    expect(h.metric.target).toBe(2);
    // The healed pattern no longer matches the two unrelated classes.
    expect(matches(h.metric.params.messagePattern, RAW_VIS)).toBe(false);
    expect(matches(h.metric.params.messagePattern, RAW_CV)).toBe(false);
    expect(matches(h.metric.params.messagePattern, RAW_PDF)).toBe(true);
  });

  it('NEVER touches a hand-authored metric', () => {
    const h = healEmitterScopedPattern(STORED, 'lane-authored', FP);
    expect(h.healed).toBe(false);
    expect(h.metric).toBe(STORED);
  });

  it('is idempotent — an already-scoped pattern is left alone', () => {
    const scoped = { ...STORED, params: { ...STORED.params, messagePattern: 'pdf_ocr seat: api-optimize-zai-glm' } };
    expect(healEmitterScopedPattern(scoped, 'autofiler-default', FP).healed).toBe(false);
  });

  it('does nothing when the fingerprint does not name an emitter', () => {
    expect(healEmitterScopedPattern(STORED, 'autofiler-default', 'brightdata direct: scrape failed').healed).toBe(false);
    expect(healEmitterScopedPattern(STORED, 'autofiler-default', null).healed).toBe(false);
  });
});