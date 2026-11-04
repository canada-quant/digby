/**
 * WI-N (2026-09-25) — route-level pins for the two PATCH routes that shipped
 * without tests: PATCH /schedules/:id (platform.routes.ts, capability-gap P0
 * + T4c prompt/intervalSec) and PATCH /hooks/:id (T4c parity with hook_update).
 *
 * Same harness as platform.routes.fleet.test.ts: the router is driven over
 * real HTTP via an ephemeral express app (no supertest), services are mocked
 * at the module boundary (the routes reach schedule.service / hooks.service
 * via DYNAMIC import, which jest.mock intercepts). What this pins: the auth
 * requirement (401), requireScope wiring (403 insufficient_scope for an agent
 * token without schedules:write / chats:write), zod validation (400s), the
 * arg mapping into the services, and the handle() AppError → status
 * passthrough (404 unknown / 400 refused).
 */

import express from 'express';

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {
  agentToken: { findUnique: jest.fn(), findMany: jest.fn(), findFirst: jest.fn(), create: jest.fn(), update: jest.fn(async () => ({})) },
  user: { findUnique: jest.fn() },
  crossModelChat: { findUnique: jest.fn() },
  crossModelProject: { findUnique: jest.fn() },
  projectMember: { findUnique: jest.fn() },
  chatCodingState: { findMany: jest.fn(async () => []) },
  activity: { create: jest.fn(async () => ({})) },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

// config/env calls process.exit(1) without env vars and kills the whole jest
// worker at import time (pulled in via middleware/error-handler, which only
// reads env.NODE_ENV). Mock env so the REAL AppError + errorHandler load.
jest.mock('../../../config/env', () => ({
  __esModule: true,
  env: { NODE_ENV: 'test' },
}));

const mockVerifyAccessToken = jest.fn();
jest.mock('../../../utils/jwt', () => ({
  __esModule: true,
  verifyAccessToken: (...a: any[]) => mockVerifyAccessToken(...a),
}));

// platform.service — the schedule route reads listSchedules + setChatScheduleEnabled
// from it (static `import * as platform`). NOTE: an explicit object, not the
// fleet suite's auto-vivifying Proxy — spreading a Proxy into the jest.mock
// factory captures only the keys that exist at factory time (none), so a
// route that actually calls platform.service would 500 on `undefined()`.
const svc = {
  listSchedules: jest.fn(),
  setChatScheduleEnabled: jest.fn(),
};
jest.mock('./platform.service', () => ({ __esModule: true, ...svc }));

// coding/schedule.service — DYNAMIC import inside the PATCH /schedules/:id handler.
const scheduleSvc = {
  resolveScheduleIdForUser: jest.fn(),
  updateScheduleForUser: jest.fn(),
};
jest.mock('../coding/schedule.service', () => ({ __esModule: true, ...scheduleSvc }));

const hooksSvc = {
  updateHook: jest.fn(),
  listHooks: jest.fn(),
  subscribeHook: jest.fn(),
  unsubscribeHook: jest.fn(),
};
jest.mock('./hooks.service', () => ({ __esModule: true, ...hooksSvc }));

jest.mock('./goals.service', () => ({ __esModule: true }));
jest.mock('./autonomy.service', () => ({ __esModule: true }));
jest.mock('./supervisor.service', () => ({ __esModule: true }));

import router from './platform.routes';
import { AppError, errorHandler } from '../../../middleware/error-handler';

// ── HTTP harness (mirrors platform.routes.fleet.test.ts) ─────────────────────

let server: any;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/platform', router);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  base = `http://127.0.0.1:${server.address().port}/platform`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

const USER = { id: 'u-1', email: 'a@b.c', role: 'USER' };
const JWT = 'a.jwt.token';
const SID = '77777777-7777-7777-7777-777777777777';
const CID = '44444444-4444-4444-4444-444444444444';
const HID = '66666666-6666-6666-6666-666666666666';

beforeEach(() => {
  jest.clearAllMocks();
  mockVerifyAccessToken.mockReturnValue({ userId: USER.id, email: USER.email, role: 'USER' });
  mockPrisma.agentToken.update.mockResolvedValue({});
  mockPrisma.chatCodingState.findMany.mockResolvedValue([]);
});

async function api(path: string, opts: { method?: string; token?: string | null; body?: any } = {}) {
  const res = await fetch(`${base}${path}`, {
    method: opts.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const body: any = await res.json().catch(() => null);
  return { status: res.status, body };
}

/** Install an agent token carrying exactly `scopes` and return its raw bearer. */
async function agentToken(scopes: string[], seed: string): Promise<string> {
  const raw = 'dgt_' + seed.repeat(24);
  const { createHash } = await import('crypto');
  mockPrisma.agentToken.findUnique.mockImplementation(async ({ where }: any) =>
    where.tokenHash === createHash('sha256').update(raw).digest('hex')
      ? { id: 'tok-1', userId: USER.id, scopes, expiresAt: null, revokedAt: null, lastUsedAt: new Date() }
      : null);
  mockPrisma.user.findUnique.mockResolvedValue({ ...USER, isActive: true, isChild: false, parentId: null });
  return raw;
}

/** The happy-path schedule fixture: resolvable + owned (listSchedules finds it). */
function scheduleExists(over: Record<string, any> = {}) {
  scheduleSvc.resolveScheduleIdForUser.mockResolvedValue(SID);
  svc.listSchedules.mockResolvedValue([{ id: SID, sessionId: CID, enabled: true, ...over }]);
}

// ── Auth ──────────────────────────────────────────────────────────────────────

describe('auth', () => {
  it('rejects unauthenticated PATCH /schedules/:id and PATCH /hooks/:id (401)', async () => {
    expect((await api(`/schedules/${SID}`, { method: 'PATCH', body: { enabled: false } })).status).toBe(401);
    expect((await api(`/hooks/${HID}`, { method: 'PATCH', body: { enabled: false } })).status).toBe(401);
    expect(scheduleSvc.resolveScheduleIdForUser).not.toHaveBeenCalled();
    expect(hooksSvc.updateHook).not.toHaveBeenCalled();
  });

  it('PATCH /schedules/:id needs schedules:write (agent token without it → 403 insufficient_scope)', async () => {
    const raw = await agentToken(['chats:write'], 'ab');
    const r = await api(`/schedules/${SID}`, { method: 'PATCH', token: raw, body: { enabled: false } });
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ error: 'insufficient_scope', required: ['schedules:write'] });
    expect(scheduleSvc.resolveScheduleIdForUser).not.toHaveBeenCalled();
  });

  it('PATCH /hooks/:id needs chats:write (agent token with only chats:read → 403)', async () => {
    const raw = await agentToken(['chats:read'], 'cd');
    const r = await api(`/hooks/${HID}`, { method: 'PATCH', token: raw, body: { enabled: false } });
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ error: 'insufficient_scope', required: ['chats:write'] });
    expect(hooksSvc.updateHook).not.toHaveBeenCalled();
  });

  it('an agent token WITH the scope passes through to the service', async () => {
    const raw = await agentToken(['schedules:write'], 'ef');
    scheduleExists();
    svc.setChatScheduleEnabled.mockResolvedValue({ schedule: { id: SID, enabled: false }, changed: true });
    const r = await api(`/schedules/${SID}`, { method: 'PATCH', token: raw, body: { enabled: false } });
    expect(r.status).toBe(200);
    expect(svc.setChatScheduleEnabled).toHaveBeenCalledWith({ userId: USER.id, chatId: CID, scheduleId: SID, enabled: false });
  });
});

// ── PATCH /schedules/:id ──────────────────────────────────────────────────────

describe('PATCH /schedules/:id', () => {
  it('400s on an empty body (the zod refine: pass enabled, prompt and/or intervalSec)', async () => {
    const r = await api(`/schedules/${SID}`, { method: 'PATCH', token: JWT, body: {} });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toMatch(/enabled, prompt and\/or intervalSec/);
    expect(scheduleSvc.resolveScheduleIdForUser).not.toHaveBeenCalled();
  });

  it('400s on bad field shapes (non-boolean enabled, empty prompt, intervalSec under 15 minutes / non-integer)', async () => {
    for (const body of [
      { enabled: 'yes' },
      { prompt: '' },
      { intervalSec: 30 },
      { intervalSec: 90.5 },
      { intervalSec: 32 * 86_400 },
    ]) {
      const r = await api(`/schedules/${SID}`, { method: 'PATCH', token: JWT, body });
      expect(r.status).toBe(400);
    }
    expect(scheduleSvc.resolveScheduleIdForUser).not.toHaveBeenCalled();
    expect(scheduleSvc.updateScheduleForUser).not.toHaveBeenCalled();
    expect(svc.setChatScheduleEnabled).not.toHaveBeenCalled();
  });

  it('404s when the id (or ≥8-char prefix) resolves to nothing the caller owns', async () => {
    scheduleSvc.resolveScheduleIdForUser.mockResolvedValue(null);
    const r = await api(`/schedules/${SID}`, { method: 'PATCH', token: JWT, body: { enabled: false } });
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: 'Schedule not found' });
    expect(scheduleSvc.resolveScheduleIdForUser).toHaveBeenCalledWith(USER.id, SID);
    expect(svc.listSchedules).not.toHaveBeenCalled();
    expect(svc.setChatScheduleEnabled).not.toHaveBeenCalled();
  });

  it('404s when the resolved id is absent from the caller\'s listSchedules view', async () => {
    scheduleSvc.resolveScheduleIdForUser.mockResolvedValue(SID);
    svc.listSchedules.mockResolvedValue([{ id: 'someone-elses', sessionId: CID }]);
    const r = await api(`/schedules/${SID}`, { method: 'PATCH', token: JWT, body: { enabled: true } });
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: 'Schedule not found' });
    expect(svc.setChatScheduleEnabled).not.toHaveBeenCalled();
  });

  it('{enabled} pauses/resumes via setChatScheduleEnabled with the row\'s chat (sessionId) and returns its result', async () => {
    scheduleExists();
    svc.setChatScheduleEnabled.mockResolvedValue({ schedule: { id: SID, enabled: true }, changed: true });
    const r = await api(`/schedules/${SID}`, { method: 'PATCH', token: JWT, body: { enabled: true } });
    expect(r.status).toBe(200);
    expect(svc.setChatScheduleEnabled).toHaveBeenCalledWith({ userId: USER.id, chatId: CID, scheduleId: SID, enabled: true });
    expect(scheduleSvc.updateScheduleForUser).not.toHaveBeenCalled();
    expect(r.body).toEqual({ schedule: { id: SID, enabled: true }, changed: true });
  });

  it('{prompt, intervalSec} ride updateScheduleForUser (only the fields sent) and the warning is surfaced', async () => {
    scheduleExists();
    scheduleSvc.updateScheduleForUser.mockResolvedValue({ ok: true, schedule: { id: SID, intervalSec: 3600 }, warning: 'cadence doubled' });
    const r = await api(`/schedules/${SID}`, { method: 'PATCH', token: JWT, body: { prompt: 'Check the board', intervalSec: 3600 } });
    expect(r.status).toBe(200);
    expect(scheduleSvc.updateScheduleForUser).toHaveBeenCalledWith(USER.id, SID, { prompt: 'Check the board', intervalSec: 3600 });
    expect(svc.setChatScheduleEnabled).not.toHaveBeenCalled();
    expect(r.body).toEqual({ schedule: { id: SID, intervalSec: 3600 }, warning: 'cadence doubled' });

    scheduleSvc.updateScheduleForUser.mockClear();
    scheduleSvc.updateScheduleForUser.mockResolvedValue({ ok: true, schedule: { id: SID } });
    const promptOnly = await api(`/schedules/${SID}`, { method: 'PATCH', token: JWT, body: { prompt: 'P2' } });
    expect(promptOnly.status).toBe(200);
    expect(scheduleSvc.updateScheduleForUser).toHaveBeenCalledWith(USER.id, SID, { prompt: 'P2' });
    expect(promptOnly.body).toEqual({ schedule: { id: SID } });
  });

  it('a refused update (ok:false — disabled row, cap, cadence guard) is a 400 carrying the service\'s reason', async () => {
    scheduleExists();
    scheduleSvc.updateScheduleForUser.mockResolvedValue({ ok: false, error: 'Schedule is DISABLED — it will never fire again' });
    const r = await api(`/schedules/${SID}`, { method: 'PATCH', token: JWT, body: { intervalSec: 3600 } });
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: 'Schedule is DISABLED — it will never fire again' });
    expect(svc.setChatScheduleEnabled).not.toHaveBeenCalled();
  });

  it('{enabled, prompt} together: the edit lands first, then the enable flip; the enable result wins the response', async () => {
    scheduleExists();
    scheduleSvc.updateScheduleForUser.mockResolvedValue({ ok: true, schedule: { id: SID, prompt: 'P3' } });
    svc.setChatScheduleEnabled.mockResolvedValue({ schedule: { id: SID, enabled: true, prompt: 'P3' }, changed: true });
    const r = await api(`/schedules/${SID}`, { method: 'PATCH', token: JWT, body: { enabled: true, prompt: 'P3' } });
    expect(r.status).toBe(200);
    expect(scheduleSvc.updateScheduleForUser).toHaveBeenCalledWith(USER.id, SID, { prompt: 'P3' });
    expect(svc.setChatScheduleEnabled).toHaveBeenCalledWith({ userId: USER.id, chatId: CID, scheduleId: SID, enabled: true });
    const editOrder = scheduleSvc.updateScheduleForUser.mock.invocationCallOrder[0];
    const flipOrder = svc.setChatScheduleEnabled.mock.invocationCallOrder[0];
    expect(editOrder).toBeLessThan(flipOrder);
    expect(r.body).toEqual({ schedule: { id: SID, enabled: true, prompt: 'P3' }, changed: true });
  });

  it('passes a service AppError through with its status (409 when it cannot resume)', async () => {
    scheduleExists();
    svc.setChatScheduleEnabled.mockRejectedValue(new AppError(409, 'Cannot resume: the project is dormant'));
    const r = await api(`/schedules/${SID}`, { method: 'PATCH', token: JWT, body: { enabled: true } });
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: 'Cannot resume: the project is dormant' });
  });
});

// ── PATCH /hooks/:id ──────────────────────────────────────────────────────────

describe('PATCH /hooks/:id', () => {
  it('400s on an empty body (the zod refine: pass at least one field)', async () => {
    const r = await api(`/hooks/${HID}`, { method: 'PATCH', token: JWT, body: {} });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toMatch(/at least one field/);
    expect(hooksSvc.updateHook).not.toHaveBeenCalled();
  });

  it('400s on bad field shapes (empty eventTypes, negative debounceSec, non-boolean enabled, non-uuid id)', async () => {
    for (const [path, body] of [
      [`/hooks/${HID}`, { eventTypes: [] }],
      [`/hooks/${HID}`, { debounceSec: -1 }],
      [`/hooks/${HID}`, { enabled: 'no' }],
      ['/hooks/not-a-uuid', { enabled: false }],
    ] as const) {
      const r = await api(path, { method: 'PATCH', token: JWT, body });
      expect(r.status).toBe(400);
    }
    expect(hooksSvc.updateHook).not.toHaveBeenCalled();
  });

  it('stores an empty promptTemplate (the service clears it; render falls back to the default)', async () => {
    const view = { id: HID, promptTemplate: '' };
    hooksSvc.updateHook.mockResolvedValue(view);
    const r = await api(`/hooks/${HID}`, { method: 'PATCH', token: JWT, body: { promptTemplate: '' } });
    expect(r.status).toBe(200);
    expect(hooksSvc.updateHook).toHaveBeenCalledWith({
      userId: USER.id, hookId: HID, eventTypes: undefined, promptTemplate: '', debounceSec: undefined, enabled: undefined,
    });
    expect(r.body).toEqual(view);
  });

  it('maps every field to updateHook and returns the view', async () => {
    const view = { id: HID, eventTypes: ['run_failed'], promptTemplate: 'PT', debounceSec: 30, enabled: false };
    hooksSvc.updateHook.mockResolvedValue(view);
    const r = await api(`/hooks/${HID}`, {
      method: 'PATCH', token: JWT,
      body: { eventTypes: ['run_failed'], promptTemplate: 'PT', debounceSec: 30, enabled: false },
    });
    expect(r.status).toBe(200);
    expect(hooksSvc.updateHook).toHaveBeenCalledWith({
      userId: USER.id, hookId: HID, eventTypes: ['run_failed'], promptTemplate: 'PT', debounceSec: 30, enabled: false,
    });
    expect(r.body).toEqual(view);
  });

  it('a partial body leaves the omitted fields undefined (the service keeps stored values)', async () => {
    hooksSvc.updateHook.mockResolvedValue({ id: HID, enabled: true });
    const r = await api(`/hooks/${HID}`, { method: 'PATCH', token: JWT, body: { enabled: true } });
    expect(r.status).toBe(200);
    expect(hooksSvc.updateHook).toHaveBeenCalledWith({
      userId: USER.id, hookId: HID, eventTypes: undefined, promptTemplate: undefined, debounceSec: undefined, enabled: true,
    });
  });

  it('404s when the service finds no hook the caller owns (null)', async () => {
    hooksSvc.updateHook.mockResolvedValue(null);
    const r = await api(`/hooks/${HID}`, { method: 'PATCH', token: JWT, body: { enabled: false } });
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: 'Hook not found' });
  });

  it('400s an unknown event type at the schema (enum) before the service', async () => {
    const r = await api(`/hooks/${HID}`, { method: 'PATCH', token: JWT, body: { eventTypes: ['exploded'] } });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('Validation error');
    // zod v4 renamed the enum issue code invalid_enum_value → invalid_value
    // (GHSA-mrhx-c7xc-m3w5 bump). Either way it must be a SCHEMA-level 400.
    expect(['invalid_enum_value', 'invalid_value']).toContain(r.body.details[0].code);
    expect(r.body.details[0].path).toEqual(['body', 'eventTypes', 0]);
    expect(hooksSvc.updateHook).not.toHaveBeenCalled();
  });
});
