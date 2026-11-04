/**
 * BROKERED SESSION STORE — pins that the `stale` token has a real PRODUCER on a
 * live path (ticket c468f922, owner ruling 2026-10-29 on card oq_b5118c38).
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM THE LEAF TEST. The leaf proves the state
 * machine; it cannot prove the token is ever EMITTED. That was the actual
 * defect: `stale` sat in `REMOTE_BLOCKER_PRIORITY`, both agents listed it in
 * their blocker unions, and no code path could put it on the wire — so a
 * channel left authenticated by an operator session that walked away still read
 * `ready: true`. These tests drive the Redis-backed store end to end (mint →
 * persist → consume → overrun → fold) and assert the FLEET-VISIBLE verdict
 * flips to `blocked` for the stale reason.
 *
 * Redis is mocked with an in-memory stand-in (the agent-link.test.ts pattern) so
 * config/env never loads; the map IS the cross-process bus.
 */

const kv = new Map<string, string>();
const ttls = new Map<string, number>();

jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: {
    setEx: jest.fn(async (k: string, sec: number, v: string) => {
      kv.set(k, v);
      ttls.set(k, sec);
      return 'OK';
    }),
    get: jest.fn(async (k: string) => kv.get(k) ?? null),
    // `SET key value NX EX ttl` — the atomic single-use claim (D3). Returns
    // 'OK' when it won the key, null when it already existed.
    set: jest.fn(async (k: string, v: string, opts?: { NX?: boolean; EX?: number }) => {
      if (opts?.NX && kv.has(k)) return null;
      kv.set(k, v);
      if (opts?.EX) ttls.set(k, opts.EX);
      return 'OK';
    }),
    del: jest.fn(async (k: string) => {
      kv.delete(k);
      return 1;
    }),
  },
}));

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import {
  createBrokeredSession,
  loadBrokeredSession,
  consumeStoredBrokeredSession,
  withBrokeredSessionWindow,
} from './brokered-session.store';
import { brokeredSessionState, closeBrokeredSession } from './brokered-session';
import { remoteAccessVerdict, REMOTE_BLOCKER_PRIORITY, type RemoteAccessAdvert } from './remote-access-verdict';

import { readFileSync } from 'fs';
import { join } from 'path';

// Source pins (the D1 block below) read real files, not mocks: a unit test can
// prove the store works when called, never that a LIVE surface calls it.
const REPO = join(__dirname, '..', '..', '..', '..', '..');
const SRC = (p: string) => readFileSync(join(REPO, p), 'utf8');

const T0 = 1_700_000_000_000;
const READY = { ready: true } as const;
const ADVERT: RemoteAccessAdvert = { enabled: true, tunnelOnly: true, blockers: [] };

function req(overrides: Record<string, unknown> = {}) {
  return { sessionId: 'sess-1', agentId: 'agent-1', channel: 'macos-screen-sharing' as const, ...overrides };
}

beforeEach(() => {
  kv.clear();
  ttls.clear();
});

describe('createBrokeredSession — persists, and refuses over an unsafe channel', () => {
  it('stores a ready grant and returns it', async () => {
    const out = await createBrokeredSession(req(), READY, T0);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.grant.sessionId).toBe('sess-1');
    expect(await loadBrokeredSession('agent-1')).not.toBeNull();
  });

  it('REFUSES to mint onto a channel that has not passed the harden contract', async () => {
    const out = await createBrokeredSession(req(), { ready: false }, T0);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.refusal).toBe('not-ready');
    // Nothing was persisted — a refused mint must not leave a usable row.
    expect(await loadBrokeredSession('agent-1')).toBeNull();
  });

  it('a second grant REPLACES the first (one live operator session per device)', async () => {
    await createBrokeredSession(req({ sessionId: 'sess-1' }), READY, T0);
    await createBrokeredSession(req({ sessionId: 'sess-2' }), READY, T0);
    const stored = await loadBrokeredSession('agent-1');
    expect(stored!.sessionId).toBe('sess-2');
  });

  it('the Redis TTL outlives the window, so an overrun grant stays READABLE long enough to be reported stale', async () => {
    await createBrokeredSession(req({ windowSec: 600 }), READY, T0);
    const ttl = ttls.get('imsg:brokered:agent-1')!;
    // A TTL that merely equals the window would delete the grant exactly when
    // it becomes stale — hiding the very finding this module exists to surface.
    expect(ttl).toBeGreaterThan(600);
  });
});

describe('consumeStoredBrokeredSession — single-use across processes', () => {
  it('consumes once and persists consumedAt so a REPLAY from another process is refused', async () => {
    await createBrokeredSession(req(), READY, T0);
    const claim = { sessionId: 'sess-1', agentId: 'agent-1', channel: 'macos-screen-sharing' as const };

    const first = await consumeStoredBrokeredSession(claim, T0 + 1_000);
    expect(first.ok).toBe(true);

    // Re-read from the store, exactly as a SECOND backend process would.
    const replay = await consumeStoredBrokeredSession(claim, T0 + 2_000);
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.refusal).toBe('already-consumed');
  });

  it('refuses a claim for a device with no grant', async () => {
    const out = await consumeStoredBrokeredSession(
      { sessionId: 'sess-1', agentId: 'ghost', channel: 'macos-screen-sharing' },
      T0,
    );
    expect(out.ok).toBe(false);
  });
});

describe('withBrokeredSessionWindow — THE PRODUCER of `stale`', () => {
  it('emits `stale` for a session that was live and outlived its window', async () => {
    await createBrokeredSession(req({ windowSec: 600 }), READY, T0);
    await consumeStoredBrokeredSession(
      { sessionId: 'sess-1', agentId: 'agent-1', channel: 'macos-screen-sharing' },
      T0 + 1_000,
    );

    // Past the window, never closed: the exact dangerous shape.
    const now = T0 + 900_000;
    const folded = await withBrokeredSessionWindow('agent-1', ADVERT, now);
    expect(folded!.blockers).toContain('stale');

    // And it reaches the FLEET-VISIBLE verdict, which is what a lane reads.
    const verdict = remoteAccessVerdict(folded);
    expect(verdict.ready).toBe(false);
    expect(verdict.state).toBe('blocked');
    expect(verdict.reason).toBe(REMOTE_BLOCKER_PRIORITY.find((b) => b.token === 'stale')!.reason);
  });

  it('does NOT emit stale for a grant that expired UNUSED (no false alarm)', async () => {
    await createBrokeredSession(req({ windowSec: 600 }), READY, T0);
    // Never consumed — the operator never showed up.
    const folded = await withBrokeredSessionWindow('agent-1', ADVERT, T0 + 900_000);
    expect(folded).toBe(ADVERT);
    expect(remoteAccessVerdict(folded).ready).toBe(true);
  });

  it('does NOT emit stale for a cleanly CLOSED session', async () => {
    await createBrokeredSession(req({ windowSec: 600 }), READY, T0);
    await consumeStoredBrokeredSession(
      { sessionId: 'sess-1', agentId: 'agent-1', channel: 'macos-screen-sharing' },
      T0 + 1_000,
    );
    const stored = await loadBrokeredSession('agent-1');
    expect(brokeredSessionState(stored, T0 + 2_000)).toBe('open');
    // Closing is the control; a closed session must read clean forever.
    const closed = closeBrokeredSession(stored, T0 + 3_000)!;
    kv.set('imsg:brokered:agent-1', JSON.stringify(closed));
    const folded = await withBrokeredSessionWindow('agent-1', ADVERT, T0 + 9_000_000);
    expect(folded).toBe(ADVERT);
  });

  it('returns the advert UNCHANGED when the device has no session at all', async () => {
    const folded = await withBrokeredSessionWindow('agent-1', ADVERT, T0);
    expect(folded).toBe(ADVERT);
  });

  it('returns the advert UNCHANGED for a channel that is OFF', async () => {
    const off: RemoteAccessAdvert = { enabled: false, tunnelOnly: false, blockers: [] };
    await createBrokeredSession(req({ windowSec: 600 }), READY, T0);
    await consumeStoredBrokeredSession(
      { sessionId: 'sess-1', agentId: 'agent-1', channel: 'macos-screen-sharing' },
      T0 + 1_000,
    );
    expect(await withBrokeredSessionWindow('agent-1', off, T0 + 900_000)).toBe(off);
  });

  it('never REMOVES an existing blocker (the fold can only tighten)', async () => {
    const exposed: RemoteAccessAdvert = { enabled: true, tunnelOnly: true, blockers: ['exposed'] };
    await createBrokeredSession(req({ windowSec: 600 }), READY, T0);
    await consumeStoredBrokeredSession(
      { sessionId: 'sess-1', agentId: 'agent-1', channel: 'macos-screen-sharing' },
      T0 + 1_000,
    );
    const folded = await withBrokeredSessionWindow('agent-1', exposed, T0 + 900_000);
    expect(folded!.blockers).toContain('exposed');
    expect(folded!.blockers).toContain('stale');
  });

  it('a corrupt stored row reads as NO session rather than throwing into the device list', async () => {
    kv.set('imsg:brokered:agent-1', '{not json');
    await expect(withBrokeredSessionWindow('agent-1', ADVERT, T0)).resolves.toBe(ADVERT);
  });
});

describe('the absence this module fixes is now observable', () => {
  it('before this change nothing could emit `stale`; now the store does, via the declared token', async () => {
    // The token is the DECLARED one, so the wire vocabulary is unchanged and
    // the fleet does not need a new parser to understand a stale session.
    const declared = REMOTE_BLOCKER_PRIORITY.some((b) => b.token === 'stale');
    expect(declared).toBe(true);

    await createBrokeredSession(req({ windowSec: 600 }), READY, T0);
    await consumeStoredBrokeredSession(
      { sessionId: 'sess-1', agentId: 'agent-1', channel: 'macos-screen-sharing' },
      T0 + 1_000,
    );
    const folded = await withBrokeredSessionWindow('agent-1', ADVERT, T0 + 900_000);
    expect(folded!.blockers).toEqual(['stale']);
  });
});

/**
 * D1 (review 2026-11-02) — THE STORE MUST HAVE A REAL PRODUCER, NOT JUST A
 * READER.
 *
 * The first cut exported `createBrokeredSession` / `consumeStoredBrokeredSession`
 * and NOTHING in production called them: only `withBrokeredSessionWindow` was
 * imported, so the Redis key it reads was never written by any route, controller
 * or agent verb, and `stale` stayed unreachable in situ — the exact defect class
 * this module exists to fix, reproduced inside the module itself.
 *
 * These are SOURCE pins on purpose: a unit test cannot prove that a live surface
 * calls something, only that the wiring text exists. Together with the route pins
 * in `remote-access-verdict.c468f922.test.ts` they make the reader-without-a-writer
 * regression impossible to reintroduce silently.
 */
describe('D1 — a real surface can mint and consume, not just read', () => {
  const ctrl = SRC('backend/src/modules/crossmodel/imessage/imessage.controller.ts');
  const routes = SRC('backend/src/modules/crossmodel/imessage/imessage.routes.ts');

  it('the controller imports and CALLS all three verbs', () => {
    expect(ctrl).toMatch(/import \{[^}]*createBrokeredSession[^}]*\} from '\.\/brokered-session\.store'/);
    expect(ctrl).toMatch(/createBrokeredSession\(/);
    expect(ctrl).toMatch(/consumeStoredBrokeredSession\(/);
    expect(ctrl).toMatch(/closeStoredBrokeredSession\(/);
  });

  it('the routes expose open / use-once / close, all JWT-scoped', () => {
    expect(routes).toMatch(/router\.post\('\/agents\/:id\/brokered-session', authenticate, \(req, res, next\) => controller\.openBrokeredSession/);
    expect(routes).toMatch(/router\.post\('\/agents\/:id\/brokered-session\/use', authenticate, \(req, res, next\) => controller\.useBrokeredSession/);
    expect(routes).toMatch(/router\.delete\('\/agents\/:id\/brokered-session', authenticate, \(req, res, next\) => controller\.closeBrokeredSession/);
  });

  it('minting is GATED on the verdict — a session can never open on an unsafe channel', () => {
    // The controller must pass the folded verdict into createBrokeredSession;
    // a bare `createBrokeredSession(req.body, { ready: true })` would let a
    // session onto an exposed port and is what this pin forbids.
    expect(ctrl).toMatch(/const verdict = remoteAccessVerdict\(\s*await withBrokeredSessionWindow\(/);
    expect(ctrl).toMatch(/createBrokeredSession\(\s*\{[\s\S]{0,400}?\},\s*verdict,\s*\)/);
  });

  it('the open path resolves the device through the CALLER\'s own list (no cross-user id)', () => {
    const open = ctrl.slice(ctrl.indexOf('async openBrokeredSession'));
    const body = open.slice(0, open.indexOf('async useBrokeredSession'));
    // Ownership scoping: listAgents(req.user.id) then find by id — the same
    // contract rename/set-default/delete use, so a forged id is a 404.
    expect(body).toMatch(/await listAgents\(req\.user!\.id\)/);
    expect(body).toMatch(/agents\.find\(\(a\) => a\.id === id\)/);
    expect(body).toMatch(/404/);
  });

  it('no response field could carry a credential', () => {
    const open = ctrl.slice(ctrl.indexOf('async openBrokeredSession'));
    const body = open.slice(0, open.indexOf('async useBrokeredSession'));
    // The success payload is sessionId/device/expiresInSec/expiresAt/note only.
    expect(body).not.toMatch(/password\s*:/i);
    expect(body).not.toMatch(/secret\s*:/i);
    expect(body).not.toMatch(/vnc/i);
  });
});