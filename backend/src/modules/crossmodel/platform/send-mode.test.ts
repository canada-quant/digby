/**
 * platform/send-mode.ts — THE per-send level resolver every entry point shares
 * (audit 2026-09-26 "unify-routing", H7). Pins:
 *   - explicit 'auto' / stored 'auto' route through the Auto router with the
 *     quota ALLOWANCE on every human auto send (routing-unify-1), not only under
 *     patience_auto_only (AUTO_ROUTE_ALLOWANCE_DISABLED restores the old rule);
 *   - patience_auto_only rewrites a human explicit level to Auto on the web AND
 *     the REST seam (settings-switches-3; PATIENCE_AUTO_ONLY_REST_DISABLED keeps
 *     REST explicit); requestedMode rides the router ask and the routing card;
 *   - a supervisor chat never gets Level 3 on a human turn — auto (clamp via
 *     allowDeepResearch:false / supervisor_no_research, segment 'supervisor') or
 *     explicit (floored) — SUPERVISOR_AUTO_RESEARCH_ENABLED restores;
 *   - a NON-human origin never gets Level 3: explicit / stored / routed are
 *     floored to Ensemble (channel_floor); webhooks stay floored even under
 *     MACHINE_DEEP_RESEARCH_FLOOR_DISABLED; a machine sender into a stored-'auto'
 *     chat runs the L2 preset without the router;
 *   - Telegram (chatless human) routes like a web send but stays off Level 3
 *     (chatless_no_research); TELEGRAM_AUTO_ROUTE_DISABLED keeps Level 1;
 *   - guests: the guest allowance (userId undefined), no routingSource;
 *   - kids / browser_agent / escalations pass through untouched;
 *   - the label window arms for a PICKED explicit level even when the switch
 *     routes it (settings-switches-4 option A); demoteForQuota is the ONE
 *     Ensemble rewrite after a lost reserve.
 */
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
// The real auto-router-gate module graph reaches config/database → config/env (process.exit on a keyless test process): stub the stores.
jest.mock('../../../config/database', () => ({ __esModule: true, default: {} }));
jest.mock('../../../config/redis', () => ({ __esModule: true, default: {} }));
const mockAutoOnly: jest.Mock = jest.fn(async () => false);
const mockAllowance: jest.Mock = jest.fn(async () => ({ allowed: true }));
jest.mock('../rate-limit.service', () => ({
  getPatienceAutoOnly: (...a: any[]) => mockAutoOnly(...a),
  deepResearchAllowance: (...a: any[]) => mockAllowance(...a),
}));
const mockRoute: jest.Mock = jest.fn();
jest.mock('./auto-router-gate', () => ({
  ...jest.requireActual('./auto-router-gate'),
  routeMessageAuto: (...a: any[]) => mockRoute(...a),
}));

import { resolveSendMode, demoteForQuota, sendSegment, floorRouting, HUMAN_SEND_ORIGINS, patienceAutoOnlyHonourPreset } from './send-mode';

const ENV = ['AUTO_ROUTE_ALLOWANCE_DISABLED', 'SUPERVISOR_AUTO_RESEARCH_ENABLED', 'MACHINE_DEEP_RESEARCH_FLOOR_DISABLED', 'PATIENCE_AUTO_ONLY_REST_DISABLED', 'TELEGRAM_AUTO_ROUTE_DISABLED'];
const heuristic = (level: string, over: Record<string, unknown> = {}) => ({ level, reason: 'r', reasonKey: 'default_ensemble', suggestCode: false, needsWorkspace: false, source: 'heuristic', heuristicLevel: level, ...over });
const base = { userId: 'u1', origin: 'web' as const, content: 'Hello there', sessionId: 'chat-1' };

beforeEach(() => {
  jest.clearAllMocks();
  for (const k of ENV) delete process.env[k];
  mockAutoOnly.mockResolvedValue(false);
  mockAllowance.mockResolvedValue({ allowed: true });
  mockRoute.mockImplementation(async (i: any) => (i.allowDeepResearch === false ? heuristic('thinking', { clamped: 'quota', reasonKey: i.allowDeepResearchReason }) : heuristic('thinking')));
});

describe('sendSegment', () => {
  it('supervisor > machine > telegram > user / guest', () => {
    expect(sendSegment({ userId: 'u', isSupervisorChat: true, origin: 'web' })).toBe('supervisor');
    expect(sendSegment({ userId: 'u', origin: 'agent' })).toBe('machine');
    expect(sendSegment({ userId: 'u', origin: 'webhook' })).toBe('machine');
    expect(sendSegment({ userId: 'u', origin: 'telegram' })).toBe('telegram');
    expect(sendSegment({ userId: 'u', origin: 'rest' })).toBe('user');
    expect(sendSegment({ userId: null, origin: 'web' })).toBe('guest');
    expect([...HUMAN_SEND_ORIGINS].sort()).toEqual(['imessage', 'rest', 'telegram', 'web']);
  });
});

describe('auto sends', () => {
  it("explicit 'auto' on the web: the allowance is probed (strict) and rides the router; routingSource auto_<source>; autoRouted true", async () => {
    const r = await resolveSendMode({ ...base, mode: 'auto' });
    expect(mockAllowance).toHaveBeenCalledWith({ userId: 'u1', clientIp: undefined, strict: true });
    expect(mockRoute.mock.calls[0][0]).toMatchObject({ content: 'Hello there', allowDeepResearch: true, segment: 'user', sessionId: 'chat-1' });
    expect(r).toMatchObject({ mode: 'thinking', autoRouted: true, autoOnly: false, routingSource: 'auto_heuristic', segment: 'user', labelWindowLevel: null });
    expect(r.routing).toMatchObject({ level: 'thinking', source: 'heuristic' });
  });
  it('an exhausted allowance clamps Level 3 with its reason; a throwing allowance fails CLOSED (quota_unavailable)', async () => {
    mockAllowance.mockResolvedValue({ allowed: false, reasonKey: 'quota_exhausted' });
    await resolveSendMode({ ...base, mode: 'auto' });
    expect(mockRoute.mock.calls[0][0]).toMatchObject({ allowDeepResearch: false, allowDeepResearchReason: 'quota_exhausted' });
    mockAllowance.mockRejectedValue(new Error('redis down'));
    await resolveSendMode({ ...base, mode: 'auto' });
    expect(mockRoute.mock.calls[1][0]).toMatchObject({ allowDeepResearch: false, allowDeepResearchReason: 'quota_unavailable' });
  });
  it('AUTO_ROUTE_ALLOWANCE_DISABLED=1 restores the switch-only allowance (no probe with the switch off; probe under the switch)', async () => {
    process.env.AUTO_ROUTE_ALLOWANCE_DISABLED = '1';
    await resolveSendMode({ ...base, mode: 'auto' });
    expect(mockAllowance).not.toHaveBeenCalled();
    expect(mockRoute.mock.calls[0][0]).toMatchObject({ allowDeepResearch: true });
    mockAutoOnly.mockResolvedValue(true);
    await resolveSendMode({ ...base, mode: 'thinking' });
    expect(mockAllowance).toHaveBeenCalledTimes(1);
  });
  it('guests: the guest allowance (userId undefined, the client ip thunk read lazily), segment guest, no routingSource on an explicit level', async () => {
    mockAllowance.mockResolvedValue({ allowed: false, reasonKey: 'guest_no_research' });
    const ip = jest.fn(() => '203.0.113.9');
    const r = await resolveSendMode({ ...base, userId: null, clientIp: ip, mode: 'auto' });
    expect(mockAllowance).toHaveBeenCalledWith({ userId: undefined, clientIp: '203.0.113.9', strict: true });
    expect(mockRoute.mock.calls[0][0]).toMatchObject({ segment: 'guest', allowDeepResearch: false, allowDeepResearchReason: 'guest_no_research' });
    expect(r.segment).toBe('guest');
    const explicit = await resolveSendMode({ ...base, userId: null, mode: 'thinking', modeSource: 'picked' });
    expect(explicit).toMatchObject({ mode: 'thinking', autoRouted: false, labelWindowLevel: null });
    expect(explicit.routingSource).toBeUndefined();
    expect(ip).toHaveBeenCalledTimes(1);
  });
  it('2026-10-20: the Level 3 allowance VERDICT rides the resolved send (the turn plan research route reads it — a Level 2 router pick carries no clamp)', async () => {
    expect(await resolveSendMode({ ...base, mode: 'auto' })).toMatchObject({ autoRouted: true, allowDeepResearch: true });
    expect((await resolveSendMode({ ...base, mode: 'auto' })).allowDeepResearchReason).toBeUndefined();
    mockAllowance.mockResolvedValue({ allowed: false, reasonKey: 'guest_no_research' });
    const guest = await resolveSendMode({ ...base, userId: null, mode: 'auto' });
    expect(guest).toMatchObject({ mode: 'thinking', allowDeepResearch: false, allowDeepResearchReason: 'guest_no_research' });
    expect(guest.routing?.clamped).toBe('quota'); // the stub router clamps whatever it is told; a real L2 pick would carry none
    mockAllowance.mockResolvedValue({ allowed: false, reasonKey: 'quota_exhausted' });
    expect(await resolveSendMode({ ...base, mode: 'auto' })).toMatchObject({ allowDeepResearch: false, allowDeepResearchReason: 'quota_exhausted' });
    expect(await resolveSendMode({ ...base, isSupervisorChat: true, mode: 'auto' })).toMatchObject({ allowDeepResearch: false, allowDeepResearchReason: 'supervisor_no_research' });
    expect(await resolveSendMode({ ...base, origin: 'telegram', chatless: true, mode: 'auto' })).toMatchObject({ allowDeepResearch: false, allowDeepResearchReason: 'chatless_no_research' });
    // an explicit level carries no verdict (nothing routes it)
    const explicit = await resolveSendMode({ ...base, mode: 'thinking' });
    expect(explicit.allowDeepResearch).toBeUndefined();
    expect(explicit.allowDeepResearchReason).toBeUndefined();
  });
  it("a stored 'auto' chat (no wire mode): a HUMAN send routes; a MACHINE sender gets the L2 preset without the router", async () => {
    const human = await resolveSendMode({ ...base, origin: 'rest', mode: undefined, storedMode: 'auto' });
    expect(human).toMatchObject({ mode: 'thinking', autoRouted: true });
    expect(mockRoute).toHaveBeenCalledTimes(1);
    const machine = await resolveSendMode({ ...base, origin: 'agent', mode: undefined, storedMode: 'auto' });
    expect(machine).toMatchObject({ mode: 'thinking', autoRouted: false, segment: 'machine' });
    expect(machine.routingSource).toBeUndefined();
    expect(mockRoute).toHaveBeenCalledTimes(1);
  });
  it("a machine sender's explicit 'auto' routes with allowDeepResearch:false (channel_floor); the floor kill switch lifts it — except for webhooks", async () => {
    await resolveSendMode({ ...base, origin: 'agent', mode: 'auto' });
    expect(mockRoute.mock.calls[0][0]).toMatchObject({ allowDeepResearch: false, allowDeepResearchReason: 'channel_floor', segment: 'machine' });
    expect(mockAllowance).not.toHaveBeenCalled();
    process.env.MACHINE_DEEP_RESEARCH_FLOOR_DISABLED = '1';
    await resolveSendMode({ ...base, origin: 'agent', mode: 'auto' });
    expect(mockRoute.mock.calls[1][0]).toMatchObject({ allowDeepResearch: true });
    await resolveSendMode({ ...base, origin: 'webhook', mode: 'auto' });
    expect(mockRoute.mock.calls[2][0]).toMatchObject({ allowDeepResearch: false, allowDeepResearchReason: 'channel_floor' });
  });
});

describe('patience_auto_only', () => {
  it('a human explicit level is rewritten to Auto on the web AND the REST seam, requestedMode kept on the router ask + the card; the picked level still arms the label window', async () => {
    mockAutoOnly.mockResolvedValue(true);
    const web = await resolveSendMode({ ...base, mode: 'deep_research', modeSource: 'picked' });
    expect(web).toMatchObject({ mode: 'thinking', autoOnly: true, autoRouted: true, requestedMode: 'deep_research', labelWindowLevel: 'deep_research' });
    expect(web.routing).toMatchObject({ requestedMode: 'deep_research', modeSource: 'picked' });
    expect(mockRoute.mock.calls[0][0]).toMatchObject({ requestedMode: 'deep_research', modeSource: 'picked' });
    const rest = await resolveSendMode({ ...base, origin: 'rest', mode: 'deep_research' });
    expect(rest).toMatchObject({ mode: 'thinking', autoOnly: true, autoRouted: true, requestedMode: 'deep_research', labelWindowLevel: null });
    const stored = await resolveSendMode({ ...base, origin: 'rest', mode: undefined, storedMode: 'deep_research' });
    expect(stored).toMatchObject({ autoOnly: true, autoRouted: true, requestedMode: 'deep_research' });
  });
  it('PATIENCE_AUTO_ONLY_REST_DISABLED=1 keeps the REST explicit level (SSE seam only, the old rule); the web is still rewritten', async () => {
    mockAutoOnly.mockResolvedValue(true);
    process.env.PATIENCE_AUTO_ONLY_REST_DISABLED = '1';
    expect(await resolveSendMode({ ...base, origin: 'rest', mode: 'deep_research' })).toMatchObject({ mode: 'deep_research', autoOnly: false, autoRouted: false, routingSource: 'user_explicit' });
    expect(await resolveSendMode({ ...base, origin: 'web', mode: 'deep_research' })).toMatchObject({ mode: 'thinking', autoOnly: true });
  });
  it('a reader failure = switch off; supervisor chats and kids never consult it', async () => {
    mockAutoOnly.mockRejectedValue(new Error('db'));
    expect(await resolveSendMode({ ...base, mode: 'thinking' })).toMatchObject({ mode: 'thinking', autoOnly: false, routingSource: 'user_explicit' });
    mockAutoOnly.mockResolvedValue(true);
    expect(await resolveSendMode({ ...base, mode: 'thinking', isSupervisorChat: true })).toMatchObject({ mode: 'thinking', autoOnly: false });
    expect(await resolveSendMode({ ...base, mode: 'thinking', isChild: true })).toMatchObject({ mode: 'thinking', autoOnly: false });
    expect(mockAutoOnly).toHaveBeenCalledTimes(1);
  });
});

describe('supervisor chats (supervisors-auto-2 / routing-unify-7)', () => {
  it("auto: routed with allowDeepResearch:false (supervisor_no_research) and segment 'supervisor' — the compute_policy row's segment; no allowance probe", async () => {
    const r = await resolveSendMode({ ...base, mode: 'auto', isSupervisorChat: true });
    expect(mockRoute.mock.calls[0][0]).toMatchObject({ allowDeepResearch: false, allowDeepResearchReason: 'supervisor_no_research', segment: 'supervisor' });
    expect(mockAllowance).not.toHaveBeenCalled();
    expect(r.segment).toBe('supervisor');
  });
  it('explicit deep_research is floored to thinking with a truthful card; SUPERVISOR_AUTO_RESEARCH_ENABLED=1 restores both paths', async () => {
    const r = await resolveSendMode({ ...base, mode: 'deep_research', isSupervisorChat: true });
    expect(r).toMatchObject({ mode: 'thinking', floored: 'supervisor_no_research', routing: { level: 'thinking', reasonKey: 'supervisor_no_research', clamped: 'supervisor', requestedMode: 'deep_research' } });
    process.env.SUPERVISOR_AUTO_RESEARCH_ENABLED = '1';
    expect(await resolveSendMode({ ...base, mode: 'deep_research', isSupervisorChat: true })).toMatchObject({ mode: 'deep_research' });
    await resolveSendMode({ ...base, mode: 'auto', isSupervisorChat: true });
    expect(mockRoute.mock.calls[0][0]).toMatchObject({ allowDeepResearch: true, segment: 'supervisor' });
  });
});

describe('non-human origins (routing-unify-5 / supervisors-auto-3)', () => {
  it.each(['agent', 'webhook', 'schedule', 'hook'] as const)('%s: an explicit deep_research is floored to thinking (channel_floor) with no routingSource', async (origin) => {
    const r = await resolveSendMode({ ...base, origin, mode: 'deep_research' });
    expect(r).toMatchObject({ mode: 'thinking', floored: 'channel_floor', autoRouted: false, segment: 'machine' });
    expect(r.routing).toMatchObject({ level: 'thinking', reasonKey: 'channel_floor', clamped: 'channel_floor' });
    expect(r.routingSource).toBeUndefined();
  });
  it('a stored deep_research chat + an agent send with no mode is floored too; MACHINE_DEEP_RESEARCH_FLOOR_DISABLED=1 lifts it for agents, never for webhooks', async () => {
    expect(await resolveSendMode({ ...base, origin: 'agent', mode: undefined, storedMode: 'deep_research' })).toMatchObject({ mode: 'thinking', floored: 'channel_floor' });
    process.env.MACHINE_DEEP_RESEARCH_FLOOR_DISABLED = '1';
    expect(await resolveSendMode({ ...base, origin: 'agent', mode: 'deep_research' })).toMatchObject({ mode: 'deep_research' });
    expect(await resolveSendMode({ ...base, origin: 'webhook', mode: 'deep_research' })).toMatchObject({ mode: 'thinking', floored: 'channel_floor' });
  });
  it('a human explicit level stays explicit (routingSource by modeSource) and a human deep_research is NOT floored', async () => {
    expect(await resolveSendMode({ ...base, origin: 'rest', mode: 'deep_research' })).toMatchObject({ mode: 'deep_research', routingSource: 'user_explicit' });
    expect(await resolveSendMode({ ...base, mode: 'thinking', modeSource: 'default' })).toMatchObject({ mode: 'thinking', routingSource: 'user_default' });
    expect(await resolveSendMode({ ...base, mode: 'fast' })).toMatchObject({ mode: 'single_thinking' }); // legacy alias
  });
});

describe('Telegram (routing-unify-6)', () => {
  it("routes like a web send with segment 'telegram' and allowDeepResearch:false (chatless_no_research); TELEGRAM_AUTO_ROUTE_DISABLED=1 keeps Level 1", async () => {
    const r = await resolveSendMode({ ...base, origin: 'telegram', chatless: true, mode: 'auto', sessionId: 'telegram:555' });
    expect(mockRoute.mock.calls[0][0]).toMatchObject({ segment: 'telegram', allowDeepResearch: false, allowDeepResearchReason: 'chatless_no_research', sessionId: 'telegram:555' });
    expect(r).toMatchObject({ mode: 'thinking', autoRouted: true, segment: 'telegram' });
    process.env.TELEGRAM_AUTO_ROUTE_DISABLED = '1';
    expect(await resolveSendMode({ ...base, origin: 'telegram', chatless: true, mode: 'auto' })).toMatchObject({ mode: 'single_thinking', autoRouted: false });
    expect(mockRoute).toHaveBeenCalledTimes(1);
  });
});

describe('pass-throughs', () => {
  it('browser_agent, kids and escalations are untouched', async () => {
    expect(await resolveSendMode({ ...base, mode: 'browser_agent' })).toMatchObject({ mode: 'browser_agent', autoRouted: false });
    expect(await resolveSendMode({ ...base, mode: 'auto', isChild: true })).toMatchObject({ mode: 'auto', autoRouted: false });
    expect(await resolveSendMode({ ...base, mode: 'deep_research', escalation: true })).toMatchObject({ mode: 'deep_research', routingSource: 'escalation', autoRouted: false });
    expect(mockRoute).not.toHaveBeenCalled();
    expect(mockAutoOnly).not.toHaveBeenCalled();
  });
});

describe('demoteForQuota / floorRouting', () => {
  it('demoteForQuota rewrites the card to Ensemble with clamped quota (a missing card is synthesised)', () => {
    expect(demoteForQuota({ level: 'deep_research', reason: 'research intent', suggestCode: false })).toEqual({ mode: 'thinking', routing: { level: 'thinking', reason: 'research intent — demoted to Ensemble (deep research quota)', suggestCode: false, reasonKey: 'quota_exhausted', clamped: 'quota' } });
    expect(demoteForQuota(undefined).routing).toMatchObject({ level: 'thinking', reasonKey: 'quota_exhausted', clamped: 'quota' });
  });
  it('floorRouting only touches a deep_research card', () => {
    expect(floorRouting({ level: 'thinking', reason: 'r', suggestCode: false }, 'channel_floor', 'x')).toEqual({ level: 'thinking', reason: 'r', suggestCode: false });
    expect(floorRouting({ level: 'deep_research', reason: 'r', suggestCode: false }, 'supervisor_no_research', 'why')).toMatchObject({ level: 'thinking', reasonKey: 'supervisor_no_research', clamped: 'supervisor', reason: 'r — why' });
    expect(floorRouting(undefined, 'channel_floor', 'x')).toBeUndefined();
  });
});

describe('PATIENCE_AUTO_ONLY_HONOUR_PRESET (opt-in; audit/patience-auto-only-switch-state merged 2026-09-26)', () => {
  afterEach(() => { delete process.env.PATIENCE_AUTO_ONLY_HONOUR_PRESET; });
  it('default OFF: a signed-in Advanced preset (modeSource default) is routed as Auto under the switch, the preset kept as requestedMode', async () => {
    expect(patienceAutoOnlyHonourPreset({})).toBe(false);
    mockAutoOnly.mockResolvedValue(true);
    mockAllowance.mockResolvedValue({ allowed: true });
    mockRoute.mockResolvedValue({ level: 'thinking', reason: 'r', suggestCode: false, reasonKey: 'heuristic', source: 'heuristic' });
    const r = await resolveSendMode({ mode: 'deep_research', userId: 'u1', origin: 'web', content: 'x', modeSource: 'default' });
    expect(r).toMatchObject({ mode: 'thinking', autoOnly: true, autoRouted: true, requestedMode: 'deep_research' });
  });
  it('=1: the signed-in preset keeps its level (routingSource user_default, no router); guests and picked / restored sends are still routed', async () => {
    process.env.PATIENCE_AUTO_ONLY_HONOUR_PRESET = '1';
    expect(patienceAutoOnlyHonourPreset()).toBe(true);
    mockAutoOnly.mockResolvedValue(true);
    mockAllowance.mockResolvedValue({ allowed: true });
    mockRoute.mockResolvedValue({ level: 'thinking', reason: 'r', suggestCode: false, reasonKey: 'heuristic', source: 'heuristic' });
    const kept = await resolveSendMode({ mode: 'deep_research', userId: 'u1', origin: 'web', content: 'x', modeSource: 'default' });
    expect(kept).toMatchObject({ mode: 'deep_research', autoOnly: true, autoRouted: false, routingSource: 'user_default' });
    expect(kept.requestedMode).toBeUndefined();
    expect(mockRoute).not.toHaveBeenCalled();
    const guest = await resolveSendMode({ mode: 'thinking', userId: null, origin: 'web', content: 'x', modeSource: 'default' });
    expect(guest).toMatchObject({ autoRouted: true, requestedMode: 'thinking' });
    const picked = await resolveSendMode({ mode: 'thinking', userId: 'u1', origin: 'web', content: 'x', modeSource: 'picked' });
    expect(picked).toMatchObject({ autoRouted: true, requestedMode: 'thinking' });
  });
});
