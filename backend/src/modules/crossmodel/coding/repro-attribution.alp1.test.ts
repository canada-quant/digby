/**
 * ALP-1 — OBSERVE-ONLY attribution of adjudication reproduction probes
 * (backlog `docs/FRAMEWORK_BACKLOG.md` §ALP-1; tickets 921013a5 → d8395cca).
 *
 * WHAT THESE TESTS ARE FOR. The whole safety claim of ALP-1's implementation is
 * an ASYMMETRY: a tagged trip gains an attribution field and a telemetry row,
 * and gains NOTHING ELSE. If a future refactor ever turns `reproOf` into a
 * suppression path — an exemption for "I was only reproducing it" — these
 * cases go red, because each one asserts what did NOT change:
 *
 *   1. a TAGGED adjudication probe still files its ticket (nothing suppressed);
 *   2. a GENUINE refusal trip with no dispatch binding files exactly as today
 *      and gains no attribution (the exemption is not merely unwritten, it is
 *      unreachable — there is no code path from "refusal" to "skip");
 *   3. an UNTAGGED trip's filed context is BYTE-IDENTICAL to the pre-change
 *      filing and writes zero metric rows;
 *   4. the switch is read AT CALL TIME (an operator flipping it mid-process
 *      restores the pre-change filing) and covers every attribution effect;
 *   5. every read failure is fail-open — a filing is never lost to attribution.
 *
 * The loopjacking / distinct-contexts invariants (d53eed71) live in their own
 * pin file and are re-asserted here only as the CONSTRAINT they impose on this
 * change: attribution is context-only, and the staged-args surfaces this could
 * have touched are not touched.
 */

const mockFindFirst = jest.fn(async (..._a: any[]): Promise<any> => null);
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    userFeatureRequest: { findFirst: (...a: any[]) => mockFindFirst(...a) },
  },
}));

import {
  REPRO_OF_FIELD,
  REPRO_EVIDENCE_FIELD,
  REPRO_EVIDENCE_DISPATCH_LANE,
  reproAttributionDisabled,
  isTicketIdShaped,
  reproFromDispatchedRow,
  resolveReproAttribution,
  reproContextFields,
  reproMetricMeta,
} from './repro-attribution';

/** A probe lane's dispatcher stamp — the ONLY accepted attribution source. */
const laneRow = (id = '921013a5') => ({
  id,
  context: { dispatchMode: 'ticket_lane', dispatchedTo: '350827a9', dispatchedAt: '2026-11-05T00:18:33Z' },
});

beforeEach(() => {
  jest.clearAllMocks();
  mockFindFirst.mockReset();
  mockFindFirst.mockResolvedValue(null);
  delete process.env.REPRO_ATTRIBUTION_DISABLED;
});
afterEach(() => {
  delete process.env.REPRO_ATTRIBUTION_DISABLED;
});

describe('ALP-1 purity — the acceptance rule is a contract, not plumbing', () => {
  it('accepts ONLY a ticket_lane binding whose row carries a shaped ticket id', () => {
    expect(reproFromDispatchedRow(laneRow())).toEqual({
      reproOf: '921013a5',
      evidence: REPRO_EVIDENCE_DISPATCH_LANE,
    });
  });

  it('rejects every non-adjudication shape — no attribution is invented', () => {
    // A lane dispatched by a different mode is not adjudicating a ticket.
    expect(reproFromDispatchedRow({ id: '921013a5', context: { dispatchMode: 'owner_dispatch' } })).toBeNull();
    // A legacy dispatchedTo stamp that never named a lane: binding, not adjudication.
    expect(reproFromDispatchedRow({ id: '921013a5', context: { dispatchedTo: '350827a9' } })).toBeNull();
    // Unshaped / hostile ids never become a context field (no fabricated ids,
    // no free text — the value is a real row's id or nothing).
    expect(reproFromDispatchedRow({ id: 'not-a-ticket', context: { dispatchMode: 'ticket_lane' } })).toBeNull();
    expect(reproFromDispatchedRow({ id: 42, context: { dispatchMode: 'ticket_lane' } })).toBeNull();
    expect(reproFromDispatchedRow({ id: '921013a5', context: null })).toBeNull();
    expect(reproFromDispatchedRow(null)).toBeNull();
    expect(reproFromDispatchedRow(undefined)).toBeNull();
  });

  it('ticket-id shape is the store vocabulary (8–40 hex), never a prefix match', () => {
    expect(isTicketIdShaped('921013a5')).toBe(true);
    expect(isTicketIdShaped('98712fe3de5f')).toBe(true);
    expect(isTicketIdShaped('d8395cca')).toBe(true);
    expect(isTicketIdShaped('921013')).toBe(false); // too short to be an id
    expect(isTicketIdShaped('921013a5-extra')).toBe(false);
    expect(isTicketIdShaped('  921013a5  ')).toBe(true); // trimmed, not cropped
    expect(isTicketIdShaped('zzzzzzzz')).toBe(false); // not hex
    expect(isTicketIdShaped(undefined)).toBe(false);
  });

  it('an untagged attribution spreads to an EMPTY object (byte-identical filing)', () => {
    // This is the mechanism behind invariant 3: `{...reproContextFields(null)}`
    // adds no key at all, so the pre-change context object is untouched.
    expect(reproContextFields(null)).toEqual({});
    expect(Object.keys(reproContextFields(null))).toHaveLength(0);
    expect(reproContextFields({ reproOf: '921013a5', evidence: REPRO_EVIDENCE_DISPATCH_LANE })).toEqual({
      [REPRO_OF_FIELD]: '921013a5',
      [REPRO_EVIDENCE_FIELD]: REPRO_EVIDENCE_DISPATCH_LANE,
    });
  });

  it('the metric meta names the ticket and its source; null when untagged', () => {
    expect(reproMetricMeta(null, { sessionId: 's', tool: 'update_feedback' })).toBeNull();
    expect(reproMetricMeta({ reproOf: '921013a5', evidence: REPRO_EVIDENCE_DISPATCH_LANE }, {
      sessionId: 's', runId: 'r', tool: 'update_feedback', shape: 'failure',
    })).toEqual({
      sessionId: 's', runId: 'r', tool: 'update_feedback', shape: 'failure',
      reproOf: '921013a5', reproEvidence: REPRO_EVIDENCE_DISPATCH_LANE,
    });
    // An attribution with no run id must not emit `runId: undefined` into meta.
    const meta = reproMetricMeta({ reproOf: '921013a5', evidence: REPRO_EVIDENCE_DISPATCH_LANE }, {
      sessionId: 's', runId: null, tool: 'update_feedback',
    })!;
    expect('runId' in meta).toBe(false);
    expect(meta.shape).toBe('failure'); // defaulted, never absent
  });
});

describe('ALP-1 resolver — fail-open everywhere, switch read at CALL TIME', () => {
  it('tags a session the dispatcher bound to a ticket lane', async () => {
    mockFindFirst.mockResolvedValue(laneRow('921013a5'));
    await expect(resolveReproAttribution('350827a9')).resolves.toEqual({
      reproOf: '921013a5',
      evidence: REPRO_EVIDENCE_DISPATCH_LANE,
    });
    // Prefix-exact JSON-path read, closed tickets excluded: a lane still bound
    // to a ticket that has since closed is no longer adjudicating it.
    const where = mockFindFirst.mock.calls[0][0].where;
    expect(where.context).toEqual({ path: ['dispatchedTo'], equals: '350827a9' });
    expect(where.status.notIn).toEqual(expect.arrayContaining(['done', 'deployed_verified']));
  });

  it('reads the switch AT CALL TIME — flipping it mid-process restores today', async () => {
    expect(reproAttributionDisabled()).toBe(false);
    mockFindFirst.mockResolvedValue(laneRow());
    await expect(resolveReproAttribution('350827a9')).resolves.not.toBeNull();

    process.env.REPRO_ATTRIBUTION_DISABLED = '1';
    expect(reproAttributionDisabled()).toBe(true);
    // Same module instance, same process: the OFF path must not even READ.
    await expect(resolveReproAttribution('350827a9')).resolves.toBeNull();
    expect(mockFindFirst).toHaveBeenCalledTimes(1); // the ON call only

    delete process.env.REPRO_ATTRIBUTION_DISABLED;
    await expect(resolveReproAttribution('350827a9')).resolves.not.toBeNull();
  });

  it('only the literal "1" disables it (any other value keeps attribution on)', async () => {
    mockFindFirst.mockResolvedValue(laneRow());
    for (const v of ['0', '', 'true', 'yes']) {
      process.env.REPRO_ATTRIBUTION_DISABLED = v;
      await expect(resolveReproAttribution('350827a9')).resolves.not.toBeNull();
    }
  });

  it('a read error is fail-open null — attribution never costs a filing', async () => {
    mockFindFirst.mockRejectedValueOnce(new Error('db down'));
    await expect(resolveReproAttribution('350827a9')).resolves.toBeNull();
  });

  it('a hand-mocked prisma without the model is fail-open null, never a TypeError', async () => {
    // The many reflection.* suites mock prisma by hand; a model they never
    // declared must not turn into a thrown TypeError on the filing path.
    const prismaModule = require('../../../config/database');
    const saved = prismaModule.default.userFeatureRequest;
    try {
      delete prismaModule.default.userFeatureRequest;
      await expect(resolveReproAttribution('350827a9')).resolves.toBeNull();
    } finally {
      prismaModule.default.userFeatureRequest = saved;
    }
  });

  it('a blank session id reads nothing at all', async () => {
    await expect(resolveReproAttribution('')).resolves.toBeNull();
    await expect(resolveReproAttribution('   ')).resolves.toBeNull();
    expect(mockFindFirst).not.toHaveBeenCalled();
  });
});

describe('ALP-1 safety — attribution is NEVER an exemption (the d53eed71 constraint)', () => {
  it('repro-attribution exposes no suppression/skip/exempt surface at all', () => {
    // A guard against the ONE refactor this item must never attract: turning
    // attribution into an excuse to stop counting. If someone adds such a
    // helper, this assertion is the tripwire.
    const api = require('./repro-attribution');
    const suppressors = Object.keys(api).filter((k) => /skip|suppress|exempt|shouldcount|allow/i.test(k));
    expect(suppressors).toEqual([]);
  });

  it('a GENUINE refusal-shaped trip carries no dispatch binding ⇒ no attribution', async () => {
    // A refusal trip does not go through the dispatcher, so the lookup finds no
    // ticket_lane row. The assertion that matters: nothing about the refusal
    // reaches this module's accepted shapes.
    mockFindFirst.mockResolvedValue(null);
    await expect(resolveReproAttribution('genuine-refusal-session')).resolves.toBeNull();
    expect(reproContextFields(null)).toEqual({});
    expect(reproMetricMeta(null, { sessionId: 'genuine-refusal-session', tool: 'run_command' })).toBeNull();
  });

  it('the module touches NEITHER the staged-args surfaces NOR the classifier', () => {
    // The invariant this change had to preserve: staged confirmations execute
    // ONLY their staged args, and `looksLikeToolFailure` keeps classifying
    // every failure. Attribution must therefore appear on neither surface.
    // Comments are stripped first: the module's own docstring NAMES both
    // surfaces precisely to say it does not touch them, and a substring scan
    // over prose would convict the documentation.
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, 'repro-attribution.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    expect(src).not.toMatch(/looksLikeToolFailure/);
    expect(src).not.toMatch(/confirmation/);
    expect(src).not.toMatch(/stagedArgs|confirmedArgs/);
    // And it writes ATTRIBUTION only — never a status, count or verdict.
    expect(src).not.toMatch(/\.update\(/);
    expect(src).not.toMatch(/\.delete\(/);
    expect(src).not.toMatch(/status:\s*'/);
  });
});