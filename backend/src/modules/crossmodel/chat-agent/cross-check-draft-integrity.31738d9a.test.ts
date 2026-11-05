/**
 * Replay pin for ticket 31738d9a (mishap, 2026-09-17) — "Ensemble
 * cross-checker draft delivered fabricated benchmark verdict under a future
 * clock (18:25Z vs 17:59Z live)".
 *
 * The mishap: during the 2026-09-17 ~17:59Z Fleet Supervisor ensemble turn,
 * the injected kimi-k3 cross-checker draft asserted AS FACT that the
 * spark-cluster arena benchmark was "banked: 26/27 cells win", citing
 * "msg 8a7957b6" (an id absent from the orchestrator's evidence ledger) and
 * "confirming" ticket 3af26f08 resolved — under a headline clock of
 * "2:25 PM EDT (18:25Z)", ~26 minutes in the FUTURE of the live harness clock
 * 2026-09-17T17:59:06.622Z. Fresh same-turn tool evidence showed the grid
 * still mid-flight. Had the orchestrator adopted the draft, the owner would
 * have been told a multi-hour benchmark was complete and won while it ran.
 *
 * Layers pinned here:
 *  1. findFutureObservedTimestamps (reused from the action verifier) flags
 *     the draft's future headline clock against the live harness clock — with
 *     the lane's OWN tool texts as provenance haystacks so an honestly quoted
 *     forward reading is not flagged.
 *  2. findPhantomDraftIds flags labeled ids absent from the lane's whole
 *     provided context (phantom-by-construction), sparing ids it actually saw.
 *  3. crossCheckDraftIntegrityBanner composes the per-draft [INTEGRITY FLAGS]
 *     banner prepended inside the injection block (annotation, never strip).
 *  4. crossCheckLaneClockNote (doctrine side, root cause: the lane is handed
 *     NO clock) stamps the real run clock and forbids future-dating +
 *     unprobed state-claims.
 *  5. crossCheckDraftsHeader's new STATE-CLAIMS clause covers the
 *     not-deterministically-strippable class (payload-relayed fleet state).
 *  6. Wiring pins (readFileSync idiom): the service actually applies 1-4 at
 *     the injection seam.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { crossCheckDraftIntegrityBanner, findPhantomDraftIds } from './cross-check-draft-integrity';
import { crossCheckLaneClockNote } from './cross-check-scope';
import { crossCheckDraftsHeader } from './cross-check-action-claims';

// Mock discipline mirrors action-verifier.test.ts: config/database (which
// runs parseEnv → process.exit at load via env.ts) and the logger are mocked
// ABOVE the action-verifier import — the suite needs only the pure
// findFutureObservedTimestamps parser.
const mockPrisma: any = {
  crossModelMessage: { create: jest.fn(async () => ({})), findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  crossModelChat: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  chatCodingState: { findFirst: jest.fn(async () => null) },
  chatSchedule: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  userFeatureRequest: { findFirst: jest.fn(async () => null) },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { findFutureObservedTimestamps } from '../platform/action-verifier';

const SERVICE_SOURCE = readFileSync(join(__dirname, 'chat-agent.service.ts'), 'utf8');

/** The live harness clock at the incident (from the ticket's evidence block). */
const HARNESS_NOW = new Date('2026-09-17T17:59:06.622Z');

/**
 * The incident draft, rebuilt from the ticket's evidence: a future-dated
 * headline clock, the fabricated "banked" verdict with its phantom receipt,
 * the phantom ticket resolution — and one REAL receipt the lane genuinely
 * had in its context (the corpus-presence control).
 */
const INCIDENT_DRAFT = [
  'Fleet sweep — 2:25 PM EDT (18:25Z)',
  '',
  'The spark-cluster arena benchmark verdict is banked: 26/27 cells win (receipt msg 8a7957b6).',
  'Feedback ticket 3af26f08 is confirmed resolved-by-owner.',
  'Per the monitor receipt msg 55224d97 the grid is on its final cell; the main lane can report the win.',
].join('\n');

/**
 * What the lane could LEGITIMATELY quote: its user message + history + system
 * context + its own tool results. Carries the REAL monitor receipt id — and
 * NOT the phantom ones.
 */
const LANE_CORPUS = [
  '[HOOK WAKE] spark arena monitor firing 7: DRIVER=ALIVE, CSV=ABSENT, the grid still on its final cell (28/28) as of BOX_TS 17:56:26Z (msg 55224d97).',
  'Fleet supervisor wake context, 2026-09-17T17:59Z.',
].join('\n');

describe('incident replay — the future headline clock is flagged (ticket 31738d9a)', () => {
  it('sanity: the draft headline is genuinely ahead of the incident harness clock', () => {
    // The replay is meaningless unless 18:25Z really is future at HARNESS_NOW.
    expect(Date.parse('2026-09-17T18:25:00Z')).toBeGreaterThan(HARNESS_NOW.getTime());
  });

  it('flags the 18:25Z headline clock as a future observation at the live clock', () => {
    const findings = findFutureObservedTimestamps(INCIDENT_DRAFT, HARNESS_NOW, { evidenceHaystacks: [] });
    const zulu = findings.find(f => f.token.includes('18:25'));
    expect(zulu).toBeDefined();
    // ~26 minutes ahead (whole-minute rounding of 25m53s+).
    expect(zulu!.minutesAhead).toBeGreaterThanOrEqual(25);
    expect(zulu!.minutesAhead).toBeLessThanOrEqual(27);
  });

  it('does NOT flag the same clock when the lane\'s own tool output carries the reading (tool provenance)', () => {
    // The a688ba29 discipline: a stamp quoted from the lane's own tool result
    // (a schedule's nextRunAt, a receipt instant) is quoted forward data, not
    // an invented clock — the service passes d.toolTexts as the haystacks.
    const findings = findFutureObservedTimestamps(INCIDENT_DRAFT, HARNESS_NOW, {
      evidenceHaystacks: ['monitor schedule row: nextRunAt 2026-09-17T18:25:00.000Z'],
    });
    expect(findings.find(f => f.token.includes('18:25'))).toBeUndefined();
  });

  it('flags the phantom receipt ids while sparing the one the lane actually read', () => {
    const phantoms = findPhantomDraftIds(INCIDENT_DRAFT, LANE_CORPUS);
    expect(phantoms).toContain('msg 8a7957b6');
    expect(phantoms).toContain('ticket 3af26f08');
    // The real monitor receipt IS in the lane's context — quotable, not phantom.
    expect(phantoms).not.toContain('msg 55224d97');
  });

  it('composes a banner naming BOTH classes and the ticket', () => {
    const banner = crossCheckDraftIntegrityBanner({
      futureClocks: findFutureObservedTimestamps(INCIDENT_DRAFT, HARNESS_NOW, { evidenceHaystacks: [] }),
      phantomIds: findPhantomDraftIds(INCIDENT_DRAFT, LANE_CORPUS),
    });
    expect(banner).toContain('[INTEGRITY FLAGS');
    expect(banner).toContain('31738d9a');
    expect(banner).toContain('18:25Z');
    expect(banner).toContain('LATER than the live harness clock');
    expect(banner).toContain('msg 8a7957b6');
    expect(banner).toContain('ticket 3af26f08');
    expect(banner).toContain('refuted-by-construction');
  });
});

describe('controls — honest drafts stay untouched', () => {
  it('a clean draft produces no findings and an EMPTY banner (byte-identical injection)', () => {
    const draft = 'The arena grid is on its final cell per the monitor receipt msg 55224d97. The main lane should keep polling.';
    const futureClocks = findFutureObservedTimestamps(draft, HARNESS_NOW, { evidenceHaystacks: [] });
    const phantomIds = findPhantomDraftIds(draft, LANE_CORPUS);
    expect(futureClocks).toEqual([]);
    expect(phantomIds).toEqual([]);
    expect(crossCheckDraftIntegrityBanner({ futureClocks, phantomIds })).toBe('');
  });

  it('forward-looking ETA phrasing is NOT flagged — projections are legitimate when labeled', () => {
    const draft = 'The final cell is expected to finish by 19:00Z; the main lane should re-probe then.';
    expect(findFutureObservedTimestamps(draft, HARNESS_NOW, { evidenceHaystacks: [] })).toEqual([]);
  });

  it('a PAST clock is not flagged — observations of what already happened are the norm', () => {
    const draft = 'As of 17:56:26Z the driver was still alive and the CSV absent.';
    expect(findFutureObservedTimestamps(draft, HARNESS_NOW, { evidenceHaystacks: [] })).toEqual([]);
  });

  it('an id the lane read in its OWN tool results is quotable, not phantom', () => {
    const draft = 'Web result mentioned feedback ticket 9f77aa10 in passing.';
    const corpus = `${LANE_CORPUS}\nsearch result excerpt: …see ticket 9f77aa10 for the original report…`;
    expect(findPhantomDraftIds(draft, corpus)).toEqual([]);
  });
});

describe('crossCheckLaneClockNote — doctrine-side root-cause fix (the lane is handed NO clock)', () => {
  const note = crossCheckLaneClockNote(HARNESS_NOW);

  it('stamps the lane\'s REAL run clock', () => {
    expect(note).toContain('2026-09-17T17:59:06.622Z');
  });

  it('forbids stating a later clock as the current time and mandates projection labeling', () => {
    expect(note).toContain('LATER than this as the current time');
    expect(note).toContain('projection');
  });

  it('governs state-claim + id-citation provenance', () => {
    expect(note).toContain('YOUR OWN tools observed this run');
    expect(note).toContain('not probed');
    expect(note).toContain('actually read in your context or your tool results');
  });

  it('cites the ticket for traceability', () => {
    expect(note).toContain('31738d9a');
  });
});

describe('crossCheckDraftsHeader — STATE-CLAIMS clause + banner framing (ticket 31738d9a)', () => {
  const header = crossCheckDraftsHeader(2);

  it('declares state claims never freshly verified by the tool-less lane', () => {
    expect(header).toContain('STATE CLAIMS IN A DRAFT ARE NEVER FRESHLY VERIFIED');
    expect(header).toContain('payload-derived at best');
    expect(header).toContain('re-probe it with YOUR OWN tools');
  });

  it('names the deterministic INTEGRITY FLAGS banner as authoritative', () => {
    expect(header).toContain('[INTEGRITY FLAGS]');
    expect(header).toContain('refuted-by-construction');
  });

  it('keeps the 0cbfa36e + ce9ee48d clauses intact (no regression)', () => {
    expect(header).toContain('ACTION CLAIMS IN A DRAFT ARE NEVER ADOPTABLE');
    expect(header).toContain('ARTIFACT CITATIONS IN A DRAFT ARE NOT YOUR EVIDENCE');
  });
});

describe('injection wiring — the service applies every layer (ticket 31738d9a)', () => {
  it('imports the integrity leaf', () => {
    expect(SERVICE_SOURCE).toContain("import { crossCheckDraftIntegrityBanner, findPhantomDraftIds } from './cross-check-draft-integrity';");
  });

  it('composes the lane clock note into the checker doctrine BEFORE the artifact rule', () => {
    const clockIdx = SERVICE_SOURCE.indexOf('${crossCheckLaneClockNote(new Date())}');
    const ruleIdx = SERVICE_SOURCE.indexOf('${crossCheckArtifactGroundingRule()}');
    expect(clockIdx).toBeGreaterThan(-1);
    expect(ruleIdx).toBeGreaterThan(clockIdx);
  });

  it('captures the lane\'s own tool texts with each draft', () => {
    expect(SERVICE_SOURCE).toContain('toolTexts: toolResultTextsFromParts(result.parts)');
  });

  it('builds the legitimate-quote corpus from the lane\'s message, history, and system context', () => {
    expect(SERVICE_SOURCE).toContain("const laneContextCorpus = [queryMessage, ctx.systemContext || '', ...ctx.conversationHistory.slice(-6)");
  });

  it('scans each draft for future clocks with the tool texts as provenance haystacks', () => {
    expect(SERVICE_SOURCE).toContain("const { findFutureObservedTimestamps } = await import('../platform/action-verifier');");
    expect(SERVICE_SOURCE).toContain('{ evidenceHaystacks: d.toolTexts }');
  });

  it('annotates via the banner and logs the flags for observability', () => {
    expect(SERVICE_SOURCE).toContain('const banner = crossCheckDraftIntegrityBanner({ futureClocks, phantomIds });');
    expect(SERVICE_SOURCE).toContain('const body = banner ? `${banner}\\n${clean.text}` : clean.text;');
    expect(SERVICE_SOURCE).toContain('annotated before injection (ticket 31738d9a)');
  });
});
