/**
 * Ticket 31fd8440 — "Desktop app re-download still serves older agent
 * version": the owner re-downloaded the Digby desktop app for a paired Mac
 * and STILL had an old agent. Root cause (verified 2026-10-09): the served
 * Digby.dmg is 0.1.10 bundling Mac agent 0.6.3 (commit 7b74ecc5b, published
 * 2026-09-26) while the current agent release is 0.8.1 — and NOTHING told the
 * user which agent a re-download installs. The DMG can only be rebuilt on the
 * owner's signing Mac, so the code-side fix is the ticket's second acceptance
 * clause: a CLEAR VERSION INDICATOR (which build you have, which is latest)
 * plus a served path to the current release.
 *
 * Server side, that means /imessage/status now carries `latestAgentVersion`
 * (the CURRENT release from the agent-release manifest) so the web card —
 * served LIVE inside the existing desktop app — can render
 * "agent vX → vY" for every paired Mac. These suites pin:
 *
 *   • agentReleaseVersion() — the display twin of the manifest: a valid
 *     manifest version passes through; a malformed one returns null (a
 *     half-finished publish must never reach the UI as "the latest")
 *   • the /status payload — `latestAgentVersion` rides BOTH branches
 *     (no paired Macs AND the connected body), always from the manifest
 *
 * Mocks mirror agent-release.4e75cdea.test.ts (config/database, config/redis,
 * config/env, utils/logger, agent-link broker, availability).
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../config/database', () => {
  const store: any = {
    rows: [] as any[],
    iMessageAgent: {
      update: jest.fn().mockResolvedValue({}),
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({ id: 'agent-new', agentToken: 'tok' }),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  return { __esModule: true, default: store };
});
jest.mock('../../../config/env', () => ({
  __esModule: true,
  env: { NODE_ENV: 'test' },
}));
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: { setEx: jest.fn(), get: jest.fn(), del: jest.fn() },
}));
jest.mock('./agent-link', () => ({
  __esModule: true,
  agentBroker: { dispatch: jest.fn(), waitForCommand: jest.fn(), deliverResult: jest.fn() },
}));
jest.mock('../browser-agent/router', () => ({
  __esModule: true,
  localBrowserAvailable: () => false,
  localBrowserStatus: () => 'no paired Mac',
  localBrowserStatusMulti: () => 'no paired Mac',
}));
jest.mock('../computer-agent/availability', () => ({
  __esModule: true,
  computerAgentStatus: () => 'unavailable',
  computerUseAvailable: () => false,
}));
jest.mock('../computer-agent/vision-client', () => ({
  __esModule: true,
  visionConfigured: async () => false,
}));

import { agentReleaseVersion, AGENT_RELEASE } from './agent-release';
import * as controller from './imessage.controller';
import prisma from '../../../config/database';

const asMock = (fn: unknown) => fn as jest.Mock;

/** Snapshot the manifest, mutate it per-case, restore after — the module-level
 *  const is shared state across tests (same idiom as 4e75cdea). */
async function withManifest(patch: Partial<typeof AGENT_RELEASE>, fn: () => void | Promise<void>) {
  const saved = { ...AGENT_RELEASE };
  Object.assign(AGENT_RELEASE, patch);
  try {
    await fn();
  } finally {
    Object.assign(AGENT_RELEASE, saved);
  }
}

/** A request/response pair good enough for getStatus (JWT user only). */
function statusCall() {
  const req: any = { user: { id: 'user-1' } };
  const res: any = {
    statusCode: 0,
    body: null as any,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: any) { this.body = payload; return this; },
  };
  const next = jest.fn();
  return { req, res, next };
}

describe('agentReleaseVersion — the display twin of the manifest (31fd8440)', () => {
  it('passes a valid manifest version through verbatim', async () => {
    await withManifest({ version: '0.8.1' }, () => {
      expect(agentReleaseVersion()).toBe('0.8.1');
    });
  });

  it('a malformed version returns null (never displayed as "the latest")', async () => {
    await withManifest({ version: '' }, () => expect(agentReleaseVersion()).toBeNull());
    await withManifest({ version: 'PLACEHOLDER' }, () => expect(agentReleaseVersion()).toBeNull());
    await withManifest({ version: '0.8' }, () => expect(agentReleaseVersion()).toBeNull());
  });
});

describe('GET /imessage/status — latestAgentVersion rides the payload (31fd8440)', () => {
  it('no paired Macs → the empty body still names the current release', async () => {
    asMock(prisma.iMessageAgent.findMany).mockResolvedValue([]);
    const { req, res, next } = statusCall();
    await (controller.default as any).getStatus(req as any, res as any, next as any);
    expect(next).not.toHaveBeenCalled();
    expect(res.body.success).toBe(true);
    expect(res.body.data.connected).toBe(false);
    // The manifest version, verbatim — the card shows "latest v0.8.1" even
    // before any Mac is paired, so the user never has to guess.
    expect(res.body.data.latestAgentVersion).toBe(AGENT_RELEASE.version);
  });

  it('connected → the body names the current release next to the default Mac\'s version', async () => {
    asMock(prisma.iMessageAgent.findMany).mockResolvedValue([
      {
        id: 'agent-1',
        userId: 'user-1',
        label: 'mbp-2',
        deviceId: 'dev-1',
        deviceName: 'cql-stanne-macbook-pro-2',
        isDefault: true,
        // The exact stale case from the ticket: the app-bundled agent.
        agentVersion: '0.6.3',
        platform: 'macos',
        capabilities: ['imessage', 'browser', 'computer'],
        permissions: null,
        lastSeenAt: new Date(),
        pairedAt: new Date(),
      },
    ]);
    const { req, res, next } = statusCall();
    await (controller.default as any).getStatus(req as any, res as any, next as any);
    expect(next).not.toHaveBeenCalled();
    expect(res.body.data.connected).toBe(true);
    expect(res.body.data.agentVersion).toBe('0.6.3');
    // The CURRENT release — so the card can render 0.6.3 → <release>.
    expect(res.body.data.latestAgentVersion).toBe(AGENT_RELEASE.version);
  });

  it('a malformed manifest (half-finished publish) surfaces null, never a placeholder', async () => {
    asMock(prisma.iMessageAgent.findMany).mockResolvedValue([]);
    await withManifest({ version: 'unset' }, async () => {
      const { req, res, next } = statusCall();
      await (controller.default as any).getStatus(req as any, res as any, next as any);
      expect(res.body.data.latestAgentVersion).toBeNull();
    });
  });
});
