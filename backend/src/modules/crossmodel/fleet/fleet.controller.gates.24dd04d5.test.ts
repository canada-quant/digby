/**
 * Ticket 24dd04d5 — a regular user's Management surface must not receive
 * framework-internal data. Controller-level gates:
 *   - GET /fleet/pulse         → guard (evidence-guard health) is ADMIN-only (service-side)
 *   - GET /fleet/log           → minimal viewers never receive harness-chrome summaries
 *                                (verifier / evidence-guard banners, guard-only notes)
 *   - GET /fleet/supervisor/latest-summary → minimal viewers get the owner-briefing
 *                                layer only; a technical wake note is a neutral stub and a
 *                                guard-struck note is withheld outright
 * (Existing fleet-pulse.test.ts pins the ADMIN/null service contract; the file
 *  covers the controller wiring, including the full-view debug bypass.)
 */
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// error-handler imports config/env, which calls process.exit(1) without env vars
// and kills the whole jest worker at import time — mock AppError (same shape).
jest.mock('../../../middleware/error-handler', () => ({
  __esModule: true,
  AppError: class AppError extends Error {
    constructor(
      public statusCode: number,
      public message: string,
      public isOperational = true,
    ) {
      super(message);
      Object.setPrototypeOf(this, AppError.prototype);
    }
  },
}));

// view-mode: the per-admin Debug preference reads Redis/the store — stub the
// shared-redis hop and the Prisma-backed context store, and let the store
// default (admin ⇒ full) stand. The tests below drive the viewer's ROLE, not
// the debug flip. The database mock must precede the controller import (the
// controller chain reaches config/env via context-store → database).
jest.mock('../../../config/redis', () => ({ __esModule: true, default: { get: jest.fn(async () => null), set: jest.fn(async () => 'OK') } }));
jest.mock('../../../config/database', () => ({ __esModule: true, default: {} }));

// view-mode's debug-emails bypass: default allowlist = claudebot@digby.example.com.
process.env.VIEW_MODE_DEBUG_EMAILS = 'claudebot@digby.example.com';

const service = {
  getFleetLog: jest.fn(),
  getLatestSupervisorWakeNote: jest.fn(),
};
jest.mock('./fleet.service', () => ({
  __esModule: true,
  ...service,
}));

import controller, { FLEET_AUTOMATION_STUB } from './fleet.controller';

/** Invoke one controller method with a fake Express req/res/next. */
function call(fn: (req: any, res: any, next: any) => Promise<void>, user: any, query: Record<string, string> = {}, headers: Record<string, string> = {}) {
  const res: any = { statusCode: 200, json: jest.fn(), status: jest.fn(function (this: any, s: number) { this.statusCode = s; return this; }) };
  const next = jest.fn();
  return fn({ user, query, headers } as any, res, next).then(() => ({ res, next }));
}

const STRUCK_SUMMARY =
  '[HARNESS EVIDENCE GUARD — CLAIMS BLOCK VERIFIED]\nAll 1 manifest entries matched journal receipts.';
// The run-evidence-guard renderEvidenceGuardNote lead form — bare, no em-dash
// (review nit 3, ticket 24dd04d5: the lead test must cover it without one).
const BARE_GUARD_SUMMARY = '[HARNESS EVIDENCE GUARD] 1 claim withheld — no matching journal receipt.';
const VERIFIER_ANNOTATED =
  'Fleet sweep — 2 lanes green, 1 blocked.\n\n[HARNESS EVIDENCE GUARD — CLAIMS BLOCK VERIFIED]\n1 manifest entry matched journal receipts.';
const PLAIN_REPLY = 'Fleet sweep — 2 lanes green, 1 blocked.';
const MACHINE_WAKE_SUMMARY =
  'Framework Operator - current state (2026-10-27T03:06Z, f211 QUIET: opening on 7f194195 green; 502 re-appeared absorbed)…';
const USER_MESSAGE_SUMMARY = 'does the fleet look healthy today?';
const AGENT_MESSAGE_SUMMARY = '[AGENT-SENT MESSAGE — from another Digby agent chat] ticket dispatched';

const logRow = (over: Record<string, unknown>) => ({
  at: '2026-10-27T03:06:00.000Z',
  kind: 'supervisor_reply',
  from: 'Fleet Supervisor',
  to: 'You',
  summary: PLAIN_REPLY,
  sourceId: 'row-1',
  chatId: 'chat-1',
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
});

describe('GET /fleet/log — minimal view filters harness chrome (ticket 24dd04d5)', () => {
  it('a regular user never receives guard/verifier chrome in log summaries', async () => {
    service.getFleetLog.mockResolvedValue({
      messages: [
        logRow({ summary: STRUCK_SUMMARY, sourceId: 'r-struck' }),
        logRow({ summary: BARE_GUARD_SUMMARY, sourceId: 'r-bare' }),
        logRow({ summary: VERIFIER_ANNOTATED, sourceId: 'r-annotated' }),
        logRow({ summary: PLAIN_REPLY, sourceId: 'r-plain' }),
        logRow({ kind: 'machine_wake', from: 'Scheduler', summary: MACHINE_WAKE_SUMMARY, sourceId: 'r-wake' }),
        logRow({ kind: 'user_message', from: 'You', to: 'Fleet Supervisor', summary: USER_MESSAGE_SUMMARY, sourceId: 'r-user' }),
        logRow({ kind: 'agent_message', from: 'Agent (x)', to: 'Fleet Supervisor', summary: AGENT_MESSAGE_SUMMARY, sourceId: 'r-agent' }),
      ],
      hasMore: false,
    });
    const { res } = await call(controller.getLog.bind(controller), { id: 'u1', role: 'USER' });
    const page = res.json.mock.calls[0][0];
    const summaries = page.messages.map((r: any) => r.summary);
    // A struck note is DROPPED; a chrome-ANNOTATED note keeps its stripped
    // activity body (the sweep facts are legitimate); a machine wake becomes
    // the neutral stub; user/agent rows pass through.
    expect(summaries).toEqual([
      PLAIN_REPLY, // r-annotated — trailing chrome stripped
      PLAIN_REPLY, // r-plain
      FLEET_AUTOMATION_STUB, // r-wake
      USER_MESSAGE_SUMMARY,
      AGENT_MESSAGE_SUMMARY,
    ]);
    // Structural fields survive (the tab's rendering contract).
    expect(page.messages[0]).toEqual(expect.objectContaining({ kind: 'supervisor_reply', from: 'Fleet Supervisor', at: expect.any(String) }));
    expect(page.hasMore).toBe(false);
  });

  it('a minimal viewer without the debug-email bypass still gets the filter (the role, not the flip, owns fleet reads)', async () => {
    service.getFleetLog.mockResolvedValue({ messages: [logRow({ summary: STRUCK_SUMMARY })], hasMore: false });
    const { res } = await call(controller.getLog.bind(controller), { id: 'u2', role: 'USER' });
    expect(res.json.mock.calls[0][0].messages).toEqual([]);
  });

  it('an admin gets the raw log unchanged', async () => {
    service.getFleetLog.mockResolvedValue({ messages: [logRow({ summary: STRUCK_SUMMARY })], hasMore: true, nextBefore: 'c1' });
    const { res } = await call(controller.getLog.bind(controller), { id: 'u3', role: 'ADMIN' });
    const page = res.json.mock.calls[0][0];
    expect(page.messages).toHaveLength(1);
    expect(page.messages[0].summary).toBe(STRUCK_SUMMARY);
    expect(page.nextBefore).toBe('c1');
  });

  it('the verification account asking for the full view gets the raw log (X-Digby-View bypass)', async () => {
    service.getFleetLog.mockResolvedValue({ messages: [logRow({ summary: STRUCK_SUMMARY })], hasMore: false });
    const { res } = await call(
      controller.getLog.bind(controller),
      { id: 'u4', role: 'USER', email: 'claudebot@digby.example.com' },
      {},
      { 'x-digby-view': 'full' },
    );
    expect(res.json.mock.calls[0][0].messages).toHaveLength(1);
  });

  it('pagination fields (hasMore/nextBefore) pass through when filtering', async () => {
    service.getFleetLog.mockResolvedValue({ messages: [logRow({ summary: STRUCK_SUMMARY, sourceId: 'a' }), logRow({ sourceId: 'b' })], hasMore: true, nextBefore: 'c2' });
    const { res } = await call(controller.getLog.bind(controller), { id: 'u5', role: 'USER' });
    const page = res.json.mock.calls[0][0];
    expect(page.messages).toHaveLength(1);
    expect(page.hasMore).toBe(true);
    expect(page.nextBefore).toBe('c2');
  });
});

describe('GET /fleet/supervisor/latest-summary — minimal viewers get the briefing layer only (ticket 24dd04d5)', () => {
  it('an owner briefing passes through unchanged (plain-English by construction)', async () => {
    service.getLatestSupervisorWakeNote.mockResolvedValue({
      chatId: 'c1',
      note: { id: 'n1', createdAt: '2026-10-27T03:00:00.000Z', content: 'All fleet systems are healthy — nothing needs you.', kind: 'briefing' },
    });
    const { res } = await call(controller.getLatestSummary.bind(controller), { id: 'u1', role: 'USER' });
    expect(res.json.mock.calls[0][0].note.content).toBe('All fleet systems are healthy — nothing needs you.');
  });

  it('a technical wake note becomes a neutral automation stub — never the raw note', async () => {
    service.getLatestSupervisorWakeNote.mockResolvedValue({
      chatId: 'c1',
      note: { id: 'n2', createdAt: '2026-10-27T03:00:00.000Z', content: 'Fleet wake — 06:54Z: decay coding-agent n=18 codes {502,524}; run_lock 7/7 paired; ib_26821574 re-verified.', kind: 'wake' },
    });
    const { res } = await call(controller.getLatestSummary.bind(controller), { id: 'u2', role: 'USER' });
    const note = res.json.mock.calls[0][0].note;
    expect(note.kind).toBe('wake');
    expect(note.content).toBe('Fleet automation ran — open Supervisor Chat for details.');
    expect(note.content).not.toContain('decay');
  });

  it('a guard-struck note is WITHHELD outright (chrome-only, nothing to stub)', async () => {
    service.getLatestSupervisorWakeNote.mockResolvedValue({
      chatId: 'c1',
      note: { id: 'n3', createdAt: '2026-10-27T03:00:00.000Z', content: STRUCK_SUMMARY, kind: 'wake' },
    });
    const { res } = await call(controller.getLatestSummary.bind(controller), { id: 'u3', role: 'USER' });
    expect(res.json.mock.calls[0][0].note).toBeNull();
  });

  it('an admin receives the raw note unchanged', async () => {
    const raw = { chatId: 'c1', note: { id: 'n4', createdAt: '2026-10-27T03:00:00.000Z', content: 'Fleet wake — 06:54Z: …', kind: 'wake' } };
    service.getLatestSupervisorWakeNote.mockResolvedValue(raw);
    const { res } = await call(controller.getLatestSummary.bind(controller), { id: 'u4', role: 'ADMIN' });
    expect(res.json.mock.calls[0][0]).toEqual(raw);
  });

  it('a null note passes through for every viewer', async () => {
    service.getLatestSupervisorWakeNote.mockResolvedValue({ chatId: null, note: null });
    const { res } = await call(controller.getLatestSummary.bind(controller), { id: 'u5', role: 'USER' });
    expect(res.json.mock.calls[0][0]).toEqual({ chatId: null, note: null });
  });
});
