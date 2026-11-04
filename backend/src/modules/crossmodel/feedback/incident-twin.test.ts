/**
 * audit 2026-10-08 W5-2 — same-chat INCIDENT TWINS become one lane.
 *
 * REPLAY (goals.md F4): chat 21faf114's L2 lead filed 59a4407b and its
 * cross-checker filed 9b944f30 136 s later — one web_pipe defect in other
 * words (title Jaccard 0.21, under the fuzzy bar 0.6). Both opened, the
 * fresh-lane dispatcher gave each a lane, and the lanes raced into competing
 * PRs #1339 / #1340. The second filing is now a linked duplicate (status done,
 * duplicateOf, autoDispatch:false) — never dispatched.
 *
 * The fixtures are the REAL ticket texts (first 1,500 chars) of the owner's own
 * chats; the negatives are real DISTINCT same-chat pairs filed within 30 min.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {
  userFeatureRequest: { findMany: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), count: jest.fn(), create: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
  user: { findUnique: jest.fn() },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

const mockRecordLoopMetric = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
}));

const mockDrain = jest.fn(async () => ({ result: 'sent', batched: 1 }));
jest.mock('./ticket-dispatch.service', () => ({
  __esModule: true,
  drainOpenTicketsToLane: (...a: any[]) => (mockDrain as any)(...a),
  releaseTicketDispatchClaim: jest.fn(async () => undefined),
}));

jest.mock('../../../middleware/error-handler', () => ({
  __esModule: true,
  AppError: class AppError extends Error {
    constructor(public statusCode: number, public message: string) { super(message); }
  },
}));

import { fileFeedbackTicket } from './feedback.service';
import {
  findIncidentTwin, scoreIncidentTwin, evidenceAnchors, evidenceIds, INCIDENT_TWIN_WINDOW_MS,
  incidentTwinBurstExemption, incidentTwinStrictDisabled, seriesMarker, INCIDENT_TWIN_BURST_WINDOW_MS,
} from './incident-twin';
import { TWIN_FIXTURES as F } from './incident-twin.test-fixtures';

const CHAT = '21faf114-69ed-453c-80ed-b7af6440d01b';
const NOW = Date.parse('2026-10-07T16:11:08.199Z');

function openRow(id: string, key: string, createdAt: number, ctx: Record<string, unknown> = {}) {
  return {
    id, type: 'bug_report', title: F[key].title, description: F[key].description, priority: 3, source: 'agent', status: 'in_progress',
    createdAt: new Date(createdAt), updatedAt: new Date(createdAt),
    context: { sessionId: CHAT, chatId: CHAT, surface: 'chat', filedBy: CHAT, dispatchMode: 'ticket_lane', dispatchedTo: '9effe0d0-accc-4ec3-a7cd-d2452be09632', ...ctx },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.FEEDBACK_INCIDENT_TWIN_DEDUPE_DISABLED;
  delete process.env.INCIDENT_TWIN_STRICT_DISABLED;
  mockPrisma.userFeatureRequest.findMany.mockResolvedValue([]);
  mockPrisma.userFeatureRequest.findFirst.mockResolvedValue(null);
  mockPrisma.userFeatureRequest.count.mockResolvedValue(0);
  mockPrisma.userFeatureRequest.updateMany.mockResolvedValue({ count: 0 });
  mockPrisma.userFeatureRequest.create.mockImplementation(async ({ data }: any) => ({ id: 'new-ticket-id', ...data }));
  mockPrisma.userFeatureRequest.update.mockImplementation(async ({ where, data }: any) => ({ id: where.id, ...data }));
  mockPrisma.user.findUnique.mockResolvedValue({ role: 'ADMIN' });
});

describe('scoreIncidentTwin — calibrated on real same-chat pairs', () => {
  it('REPLAY: the lead (59a4407b) and cross-checker (9b944f30) filings of ONE web_pipe defect are twins', () => {
    const s = scoreIncidentTwin(F['59a4407b'], F['9b944f30']);
    expect(s.titleJaccard).toBeLessThan(0.6); // the fuzzy title pass could not see it
    expect(s.twin).toBe(true);
    expect(s.sharedAnchors).toBeGreaterThanOrEqual(2); // the docs URL + the quoted query
    expect(s.shingle).toBeGreaterThanOrEqual(0.15);
  });

  it('REPLAY: the Fleet Supervisor re-filing ONE frozen-deploy incident 12 min later (e1ccaa80 → 4b432e90) twins on shared ids', () => {
    const s = scoreIncidentTwin(F['e1ccaa80'], F['4b432e90']);
    expect(s.sharedIds).toBeGreaterThanOrEqual(6);
    expect(s.twin).toBe(true);
  });

  it.each([
    ['a8d6e514', 'fcee0741', 'two distinct findings filed in the same second'],
    ['c737d007', '58e675c9', 'two distinct shortfall-hunt findings filed together'],
    ['e1ccaa80', 'b1d435fd', 'a frozen deploy vs the goal-gate schedule bug (4 shared ids)'],
    ['4b432e90', 'b1d435fd', 'deploy queue wedge vs the goal-gate schedule bug'],
  ])('distinct same-chat filings are NOT twins: %s / %s (%s)', (a, b) => {
    expect(scoreIncidentTwin(F[a], F[b]).twin).toBe(false);
  });

  it('extracts anchors (URLs, quoted spans) and evidence ids', () => {
    expect([...evidenceAnchors('see "Bouncing Angels Xtreme Dance Dome" at https://docs.example.com/a.')])
      .toEqual(['https://docs.example.com/a', 'bouncing angels xtreme dance dome']);
    expect([...evidenceIds('run 35282575521 commit 32b71f1b1 PR #839 lane 9a5f8aa9 word deadbeef')].sort())
      .toEqual(['32b71f1b', '35282575521', '9a5f8aa9', 'pr839']);
  });
});

describe('findIncidentTwin — window, harness exclusion, linked rows', () => {
  const cand = (over: Record<string, unknown> = {}) => ({ ...openRow('59a4407b-ee05-4026-bac9-b4a71c00fed3', '59a4407b', NOW - 136_000), ...over });
  it('finds the open same-chat twin inside the window', () => {
    expect(findIncidentTwin([cand()], { ...F['9b944f30'], context: { role: 'cross_checker' } }, NOW)?.candidate.id).toBe('59a4407b-ee05-4026-bac9-b4a71c00fed3');
  });
  it('ignores a candidate older than the window', () => {
    expect(findIncidentTwin([cand({ createdAt: new Date(NOW - INCIDENT_TWIN_WINDOW_MS - 1000) })], F['9b944f30'], NOW)).toBeNull();
  });
  it('a harness filing (verifier / class stamp) never twins, and never anchors one', () => {
    expect(findIncidentTwin([cand()], { ...F['9b944f30'], context: { verifier: 'action-verifier' } }, NOW)).toBeNull();
    expect(findIncidentTwin([cand({ context: { class: 'provider_billing' } })], F['9b944f30'], NOW)).toBeNull();
  });
  it('a linked record (duplicateOf) never anchors another link', () => {
    expect(findIncidentTwin([cand({ context: { duplicateOf: 'x' } })], F['9b944f30'], NOW)).toBeNull();
  });
});

describe('fileFeedbackTicket — the twin is stored as a linked duplicate (REPLAY 59a4407b → 9b944f30)', () => {
  const crossCheckerFiling = {
    userId: '83e4fbf9-e18c-42f1-9bf7-7a99caf9d9c4',
    type: 'bug_report',
    title: F['9b944f30'].title,
    description: F['9b944f30'].description,
    priority: 3,
    context: { sessionId: CHAT, chatId: CHAT, surface: 'chat', role: 'cross_checker', filedBy: CHAT, about: 'digby_platform' },
  };

  function primeLead() {
    const lead = openRow('59a4407b-ee05-4026-bac9-b4a71c00fed3', '59a4407b', Date.now() - 136_000);
    // exact / class / closed passes see nothing; the fuzzy (same session/chat) query returns the lead's open row.
    mockPrisma.userFeatureRequest.findMany.mockImplementation(async (q: any) => (q?.where?.OR ? [lead] : []));
    return lead;
  }

  it('links the second filing (status done, duplicateOf, autoDispatch:false), back-links the lead, never dispatches', async () => {
    const lead = primeLead();
    const r: any = await fileFeedbackTicket(crossCheckerFiling);
    expect(r.deduped).toBe(true);
    expect(r.duplicateOf).toBe(lead.id);
    const created = mockPrisma.userFeatureRequest.create.mock.calls[0][0].data;
    expect(created).toMatchObject({ status: 'done', source: 'agent', title: F['9b944f30'].title });
    expect(created.context).toMatchObject({ duplicateOf: lead.id, duplicateMatch: 'incident-twin', autoDispatch: false, role: 'cross_checker' });
    expect(created.adminNote).toContain(`Duplicate of ticket ${lead.id}`);
    expect(created.adminNote).toContain('NOT dispatched');
    // the lead gains a twins back-link — no priority bump, no description append (a twin is not a recurrence)
    const upd = mockPrisma.userFeatureRequest.update.mock.calls.find((c: any[]) => c[0].where.id === lead.id)[0].data;
    expect(Object.keys(upd)).toEqual(['context']);
    expect(upd.context.twins).toEqual(['new-ticket-id']);
    expect(mockDrain).not.toHaveBeenCalled();
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'feedback_incident_twin', meta: expect.objectContaining({ duplicateOf: lead.id, role: 'cross_checker' }) }));
  });

  it('kill switch FEEDBACK_INCIDENT_TWIN_DEDUPE_DISABLED=1 files a fresh open row (pre-fix behaviour)', async () => {
    process.env.FEEDBACK_INCIDENT_TWIN_DEDUPE_DISABLED = '1';
    primeLead();
    const r: any = await fileFeedbackTicket(crossCheckerFiling);
    expect(r.deduped).toBe(false);
    const created = mockPrisma.userFeatureRequest.create.mock.calls[0][0].data;
    expect(created.status).toBeUndefined(); // default 'open'
    expect(created.context.duplicateOf).toBeUndefined();
  });

  it('a DISTINCT same-chat filing still files its own ticket', async () => {
    const other = { ...openRow('a8d6e514-0000-4000-8000-000000000000', 'a8d6e514', Date.now() - 60_000), context: { sessionId: CHAT } };
    mockPrisma.userFeatureRequest.findMany.mockImplementation(async (q: any) => (q?.where?.OR ? [other] : []));
    const r: any = await fileFeedbackTicket({ ...crossCheckerFiling, title: F['fcee0741'].title, description: F['fcee0741'].description });
    expect(r.deduped).toBe(false);
  });
});

// ── INCIDENT-TWIN-STRICT (2026-10-20) ─────────────────────────────────────────
// Prod sample: 7/7 twin links joined DIFFERENT asks at 0 shared evidence
// anchors — a review run's burst of findings shares its report boilerplate, so
// the shingle leg alone linked them and the second ask was stored closed and
// never dispatched. The pair below is that shape (synthetic text, the real
// template: identical WHAT HAPPENED / IMPACT / SUGGESTED FIX paragraphs, a
// different FINDING, no URL, no quoted span, no shared id).
const BURST_HEAD = 'WHAT HAPPENED\nShortfall-hunt review run over the scheduling and board planes (cycle 4). Every finding below was verified against fresh code bytes this run; the standing charter asks for one ticket per finding carrying the evidence, the impact on the fleet, and a suggested fix that a fresh ticket lane can land without owner input.\n\nFINDING\n';
const BURST_TAIL = '\n\nIMPACT\nEvery standing loop that relies on this surface keeps running on stale state; supervisors read the board as healthy while the lane is wrong, and the owner has no way to see it from the status card.\n\nSUGGESTED FIX\nLand the smallest change that makes the defect observable and correct, pin it with a regression test replaying the evidence above, and record the change in the agent guide with a kill switch.';
const ASK_SCHEDULE = {
  title: 'Schedule sweep re-arms an owner-stopped schedule after a deploy drain requeue',
  description: `${BURST_HEAD}A schedule the owner stopped is re-armed when a deploy drain requeues its in-flight firing: the requeue copies the row cadence but never its stopped stamp, so the next sweep fires it again.${BURST_TAIL}`,
};
const ASK_BOARD = {
  title: 'Board digest drops goals whose premise key carries a unit suffix',
  description: `${BURST_HEAD}The board digest renders no premise line for a goal whose premise key ends in a unit suffix such as _ms or _pct: the key parser treats the suffix as a deadline marker and the decode fails closed, hiding the bar from every supervisor wake.${BURST_TAIL}`,
};

describe('INCIDENT-TWIN-STRICT — shingle overlap alone is not a twin', () => {
  it('two DIFFERENT asks sharing report boilerplate (0 anchors, title Jaccard 0) linked before; strict refuses the link', () => {
    const loose = scoreIncidentTwin(ASK_SCHEDULE, ASK_BOARD, { strict: false });
    expect(loose.shingle).toBeGreaterThanOrEqual(0.15); // the pre-fix bar fired on the boilerplate
    expect(loose.sharedAnchors).toBe(0);
    expect(loose.twin).toBe(true);
    expect(loose.matchedBy).toBe('shingle');
    const strict = scoreIncidentTwin(ASK_SCHEDULE, ASK_BOARD, { strict: true });
    expect(strict.twin).toBe(false);
    expect(strict.matchedBy).toBeNull();
    expect(strict.strictRejected).toBe(true);
    // strict is the default (kill switch unset)
    expect(scoreIncidentTwin(ASK_SCHEDULE, ASK_BOARD).twin).toBe(false);
  });

  it('the TRUE twin (59a4407b / 9b944f30) still twins strictly — corroborated by its shared evidence anchors', () => {
    const s = scoreIncidentTwin(F['59a4407b'], F['9b944f30'], { strict: true });
    expect(s.titleJaccard).toBeLessThan(0.3); // the title leg alone would not save it …
    expect(s.sharedAnchors).toBeGreaterThanOrEqual(1); // … the docs URL + the quoted query do
    expect(s.twin).toBe(true);
    expect(s.strictRejected).toBeUndefined();
    // the ids leg is untouched: the Fleet Supervisor re-filing still twins
    expect(scoreIncidentTwin(F['e1ccaa80'], F['4b432e90'], { strict: true }).twin).toBe(true);
  });

  it('a shingle match whose TITLES agree (Jaccard ≥ 0.3) still twins with no anchor', () => {
    const retold = { title: 'Schedule sweep re-arms an owner-stopped schedule after a drain requeue', description: ASK_SCHEDULE.description.replace('fires it again', 'runs it again') };
    const s = scoreIncidentTwin(ASK_SCHEDULE, retold, { strict: true });
    expect(s.sharedAnchors).toBe(0);
    expect(s.titleJaccard).toBeGreaterThanOrEqual(0.3);
    expect(s.twin).toBe(true);
  });

  it('every real DISTINCT fixture pair stays apart under strict too', () => {
    for (const [a, b] of [['a8d6e514', 'fcee0741'], ['c737d007', '58e675c9'], ['e1ccaa80', 'b1d435fd'], ['4b432e90', 'b1d435fd']]) {
      expect(scoreIncidentTwin(F[a], F[b], { strict: true }).twin).toBe(false);
    }
  });

  it('kill switch INCIDENT_TWIN_STRICT_DISABLED=1 restores the shingle-alone leg', () => {
    expect(incidentTwinStrictDisabled({ INCIDENT_TWIN_STRICT_DISABLED: '1' } as any)).toBe(true);
    expect(incidentTwinStrictDisabled({} as any)).toBe(false);
    process.env.INCIDENT_TWIN_STRICT_DISABLED = '1';
    expect(scoreIncidentTwin(ASK_SCHEDULE, ASK_BOARD).twin).toBe(true);
    expect(findIncidentTwin([{ id: 'sched-ticket-1', createdAt: new Date(NOW - 60_000), ...ASK_SCHEDULE, context: { sessionId: CHAT } }], ASK_BOARD, NOW)?.candidate.id).toBe('sched-ticket-1');
  });
});

describe('INCIDENT-TWIN-STRICT — one run\'s burst of findings is never twinned', () => {
  const lead = (createdAt: number, ctx: Record<string, unknown>) => ({ id: '59a4407b-ee05-4026-bac9-b4a71c00fed3', createdAt: new Date(createdAt), ...F['59a4407b'], context: { sessionId: CHAT, ...ctx } });

  it('the SAME filer (run id + role) inside 120 s is a burst: exempt even where the text would twin', () => {
    const cand = lead(NOW - 30_000, { runId: 'chat-run-1' });
    const filing = { ...F['9b944f30'], context: { runId: 'chat-run-1' } };
    expect(scoreIncidentTwin(cand, filing).twin).toBe(true); // the text alone WOULD twin
    expect(incidentTwinBurstExemption(cand, filing, NOW)).toBe('same_run_burst');
    expect(findIncidentTwin([cand], filing, NOW)).toBeNull();
  });

  it('the lead and its cross-checker share a turn\'s run id but are TWO filers (different role) — the incident pair still twins', () => {
    const cand = lead(NOW - 30_000, { runId: 'chat-run-1' });
    const filing = { ...F['9b944f30'], context: { runId: 'chat-run-1', role: 'cross_checker' } };
    expect(incidentTwinBurstExemption(cand, filing, NOW)).toBeNull();
    expect(findIncidentTwin([cand], filing, NOW)?.candidate.id).toBe(cand.id);
  });

  it('outside the burst window, or across different runs, the same filer can still twin', () => {
    const late = lead(NOW - INCIDENT_TWIN_BURST_WINDOW_MS - 1_000, { runId: 'chat-run-1' });
    expect(incidentTwinBurstExemption(late, { ...F['9b944f30'], context: { runId: 'chat-run-1' } }, NOW)).toBeNull();
    const otherRun = lead(NOW - 30_000, { runId: 'chat-run-0' });
    expect(incidentTwinBurstExemption(otherRun, { ...F['9b944f30'], context: { runId: 'chat-run-1' } }, NOW)).toBeNull();
    // no run id on either side (rows filed before the stamp) ⇒ never a burst
    expect(incidentTwinBurstExemption(lead(NOW - 30_000, {}), F['9b944f30'], NOW)).toBeNull();
  });

  it('differing series markers ("fix k of N", "part k", "Finding k") are a burst; matching or missing markers are not', () => {
    expect(seriesMarker({ title: 'Fix 2 of 5: schedule drain keeps the stopped stamp', description: '' })).toBe('fix:2');
    expect(seriesMarker({ title: 'x', description: 'Part 3 — the board digest\nmore' })).toBe('part:3');
    expect(seriesMarker(F['c737d007'])).toBe('finding:1'); // real: "Shortfall-hunt cycle 2, Finding 1 (report: …)"
    expect(seriesMarker(F['58e675c9'])).toBe('finding:2');
    expect(seriesMarker({ title: 'A part of the board digest is missing', description: 'no marker here' })).toBeNull();
    const base = { id: 'sched-ticket-1', createdAt: new Date(NOW - 10 * 60_000), context: { sessionId: CHAT } };
    const c = { ...base, ...F['59a4407b'], title: `Fix 1 of 3: ${F['59a4407b'].title}` };
    const f2 = { ...F['9b944f30'], title: `Fix 2 of 3: ${F['9b944f30'].title}` };
    expect(incidentTwinBurstExemption(c, f2, NOW)).toBe('series_marker');
    expect(findIncidentTwin([c], f2, NOW)).toBeNull();
    const fSame = { ...F['9b944f30'], title: `Fix 1 of 3: ${F['9b944f30'].title}` };
    expect(incidentTwinBurstExemption(c, fSame, NOW)).toBeNull();
    expect(findIncidentTwin([c], fSame, NOW)?.candidate.id).toBe('sched-ticket-1');
  });

  it('kill switch INCIDENT_TWIN_STRICT_DISABLED=1 drops the burst exemption', () => {
    process.env.INCIDENT_TWIN_STRICT_DISABLED = '1';
    const cand = lead(NOW - 30_000, { runId: 'chat-run-1' });
    expect(findIncidentTwin([cand], { ...F['9b944f30'], context: { runId: 'chat-run-1' } }, NOW)?.candidate.id).toBe(cand.id);
  });
});

describe('fileFeedbackTicket — a distinct ask sharing boilerplate files its OWN ticket (INCIDENT-TWIN-STRICT)', () => {
  const filing = {
    userId: '83e4fbf9-e18c-42f1-9bf7-7a99caf9d9c4', type: 'bug_report', title: ASK_BOARD.title, description: ASK_BOARD.description, priority: 3,
    context: { sessionId: CHAT, chatId: CHAT, surface: 'chat', filedBy: CHAT, about: 'digby_platform' },
  };
  const prime = () => {
    const prior = { id: 'sched-ticket-1', type: 'bug_report', ...ASK_SCHEDULE, priority: 3, source: 'agent', status: 'open', createdAt: new Date(Date.now() - 5 * 60_000), updatedAt: new Date(), context: { sessionId: CHAT, chatId: CHAT, surface: 'chat', filedBy: CHAT } };
    mockPrisma.userFeatureRequest.findMany.mockImplementation(async (q: any) => (q?.where?.OR ? [prior] : []));
  };

  it('strict (default): no link — a fresh open row, no feedback_incident_twin metric', async () => {
    prime();
    const r: any = await fileFeedbackTicket(filing);
    expect(r.deduped).toBe(false);
    const created = mockPrisma.userFeatureRequest.create.mock.calls[0][0].data;
    expect(created.status).toBeUndefined();
    expect(created.context.duplicateOf).toBeUndefined();
    expect(mockRecordLoopMetric).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'feedback_incident_twin' }));
  });

  it('kill switch INCIDENT_TWIN_STRICT_DISABLED=1: the pre-fix link (the prod over-link shape)', async () => {
    process.env.INCIDENT_TWIN_STRICT_DISABLED = '1';
    prime();
    const r: any = await fileFeedbackTicket(filing);
    expect(r.deduped).toBe(true);
    expect(r.duplicateOf).toBe('sched-ticket-1');
  });
});
