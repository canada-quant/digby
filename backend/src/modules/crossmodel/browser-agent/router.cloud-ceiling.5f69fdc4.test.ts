/**
 * Ticket 5f69fdc4 — SECOND WORKSTREAM: the router must describe CLOUD's real
 * interaction ceiling, so an interaction-needing task is not routed into a
 * read-only driver.
 *
 * The measured waste this pins away: with CLOUD_BROWSER_CDP off (the prod
 * default) the router offered CLOUD for an interactive task, the first click
 * came back 'disabled-by-config', and only THEN did the glm-loop re-route to a
 * paired Mac (b346ce80) — a wasted round trip plus a refusal the user reads as
 * a failure. And once interaction IS enabled, no destination description ever
 * claimed cloud could click, so an interactive public-site task had no textual
 * reason to prefer it.
 *
 * The ceiling is read from the DRIVER's interactionCapability() (single source
 * of truth), never a second read of process.env — this project has been bitten
 * twice by two hand-kept copies of one predicate drifting apart.
 */

jest.mock('../platform/decision-gate', () => ({
  __esModule: true,
  decide: jest.fn(async () => null),
  decisionMode: jest.fn(() => 'off'),
  decisionThreshold: (_p: string, fallback: number) => fallback,
  recordDecisionOutcome: jest.fn(),
  confidenceOf: () => 0,
}));

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../imessage/imessage.service', () => ({
  __esModule: true,
  listAgents: jest.fn(),
  selectAgent: jest.fn(),
  agentDisplayName: (a: any) => (a?.label || a?.deviceName || 'Mac'),
  isOnline: (d: Date | null | undefined) => !!d && Date.now() - new Date(d).getTime() < 45_000,
}));

jest.mock('../model-endpoints/model-roles.service', () => ({
  __esModule: true,
  resolveRoleModel: async () => '',
  resolveRoleFallback: async () => '',
}));

jest.mock('./glm-client', () => ({
  __esModule: true,
  glmChat: jest.fn(),
  glmConfigured: jest.fn(() => true),
  stripThink: (s: string) => s,
}));

// The cloud driver is the SINGLE SOURCE of the ceiling: each test sets what
// interactionCapability() reports, and the router must reflect exactly that.
let mockCapability: string | undefined = 'disabled-by-config';
jest.mock('./cloud-driver', () => ({
  __esModule: true,
  CloudBrowserDriver: jest.fn().mockImplementation(() => ({
    kind: 'cloud' as const,
    interactionCapability: () => mockCapability,
  })),
}));

jest.mock('./local-driver', () => ({
  __esModule: true,
  LocalBrowserDriver: jest.fn().mockImplementation((agentId: string) => ({ kind: 'local', agentId })),
}));

jest.mock('./session-browser-client', () => ({
  __esModule: true,
  BROWSER_SERVICE_ENABLED: () => false,
  sessionBrowserAvailable: async () => false,
}));

import { decide, decisionMode } from '../platform/decision-gate';
import { glmChat, glmConfigured } from './glm-client';
import { listAgents, selectAgent } from '../imessage/imessage.service';
import { selectBrowserDriver } from './router';

const asMock = (fn: unknown) => fn as jest.Mock;

const agentRow = () => ({
  id: 'agent-1',
  userId: 'u1',
  agentVersion: '0.2.1',
  lastSeenAt: new Date(),
  pairedAt: new Date(),
});

/** A capable Mac is required to reach the reasoning router at all: with no
 *  Mac and no computer use the router short-circuits to cloud with no prompt. */
function readyRouter(pick = 'cloud') {
  asMock(selectAgent).mockResolvedValue({ agent: agentRow(), note: 'the paired Mac', error: null });
  asMock(listAgents).mockResolvedValue([agentRow()]);
  asMock(glmConfigured).mockReturnValue(true);
  asMock(glmChat).mockResolvedValue({ content: `{"driver":"${pick}","reason":"r"}` });
}

const systemPrompt = () => asMock(glmChat).mock.calls[0][0].messages[0].content as string;

beforeEach(() => {
  jest.clearAllMocks();
  mockCapability = 'disabled-by-config';
  asMock(decisionMode).mockReturnValue('off');
});

describe('cloud interaction ceiling is named in the routing prompt (5f69fdc4)', () => {
  it('CDP off (disabled-by-config) → cloud is described as READ-ONLY', async () => {
    readyRouter();
    await selectBrowserDriver('u1', 'click through the quote pages on this public site');
    const sys = systemPrompt();
    expect(sys).toContain('READ-ONLY');
    expect(sys).toContain('NO INTERACTIVE CLOUD SESSION IN THIS DEPLOYMENT');
  });

  it('CDP off → the prompt does NOT claim cloud can interact (the old narrowing)', async () => {
    readyRouter();
    await selectBrowserDriver('u1', 'click through the quote pages on this public site');
    const sys = systemPrompt();
    // The interactive clause is the widening — it must never appear while the
    // driver reports a permanent ceiling, or the router would route an
    // interaction-needing task into a read-only driver. Assert on the
    // CLOUD-specific sentence: "it can click, type and scroll" alone also
    // appears in the LOCAL description (and LOCAL legitimately offers it).
    expect(sys).not.toContain('Interaction is ENABLED in this deployment');
    expect(sys).not.toContain('Choose CLOUD also for interactive tasks on public sites');
  });

  it('CDP on (interaction enabled) → the prompt advertises the interactive capability', async () => {
    mockCapability = 'unavailable'; // enabled, no live session yet (knowable pre-navigate)
    readyRouter();
    await selectBrowserDriver('u1', 'click through the quote pages on this public site');
    const sys = systemPrompt();
    expect(sys).toContain('Interaction is ENABLED in this deployment');
    expect(sys).toContain('it can click, type and scroll');
  });

  it('CDP on → cloud is NOT described as read-only', async () => {
    mockCapability = 'unavailable';
    readyRouter();
    await selectBrowserDriver('u1', 'click through the quote pages on this public site');
    expect(systemPrompt()).not.toContain('READ-ONLY');
  });

  it('a driver that cannot report a ceiling adds nothing (no invented claim)', async () => {
    mockCapability = undefined; // optional method absent / unknown
    readyRouter();
    await selectBrowserDriver('u1', 'read a page');
    const sys = systemPrompt();
    expect(sys).not.toContain('READ-ONLY');
    expect(sys).not.toContain('Interaction is ENABLED');
  });
});

describe('cloud interaction ceiling reaches the decision gate criteria (5f69fdc4)', () => {
  it('CDP off → the cloud criterion carries the read-only clause', async () => {
    readyRouter();
    asMock(decisionMode).mockReturnValue('shadow');
    await selectBrowserDriver('u1', 'click through a public site');
    const criteria = asMock(decide).mock.calls[0][1].driver.criteria as Record<string, string>;
    expect(criteria.cloud).toContain('READ-ONLY here');
  });

  it('CDP on → the cloud criterion carries the interactive clause', async () => {
    mockCapability = 'unavailable';
    readyRouter();
    asMock(decisionMode).mockReturnValue('shadow');
    await selectBrowserDriver('u1', 'click through a public site');
    const criteria = asMock(decide).mock.calls[0][1].driver.criteria as Record<string, string>;
    expect(criteria.cloud).toContain('Interactive here');
    expect(criteria.cloud).not.toContain('READ-ONLY here');
  });
});