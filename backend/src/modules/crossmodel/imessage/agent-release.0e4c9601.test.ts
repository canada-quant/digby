/**
 * Agent release manifest — the updater floor (ticket 0e4c9601, 2026-10-09).
 *
 * LIVE MISHAP REPLAYED: the 0.8.0 self-updater stages an adhoc-signed
 * better_sqlite3.node (npm ci's local build) that a Team-signed hardened-
 * runtime interpreter (DigbyHelper) refuses at dlopen — the agent then boots
 * DEGRADED but keeps polling, so its rollback watchdog stands down and the
 * iMessage breakage is silent. A release carrying the native-carry fix
 * (0.8.1+) must therefore never be advertised to an updater BELOW the fix:
 * the POLLER'S OWN CODE performs the swap, and an old updater swapping in a
 * new tree reproduces the mishap on every Mac that takes the advert.
 *
 * The fix: AGENT_RELEASE.minUpdaterVersion — a hand-set policy floor the
 * publish script (scripts/publish-agent-tarball.sh) preserves verbatim.
 */

import { agentUpdateAdvert, AGENT_RELEASE } from './agent-release';

// Mocks mirror agent-release.4e75cdea.test.ts (agent-release imports
// agent-link → config/redis at module load; keep the comparator REAL).
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../config/database', () => {
  const store: any = {
    rows: [],
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
  agentVersionAtLeast: (v: string | null | undefined, min: string) => {
    if (!v) return false;
    const a = String(v).split('.').map((n) => parseInt(n, 10) || 0);
    const b = String(min).split('.').map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const x = a[i] || 0, y = b[i] || 0;
      if (x > y) return true;
      if (x < y) return false;
    }
    return true;
  },
}));

const REAL_SHA = 'a'.repeat(64);

/** Snapshot the manifest, mutate it per-case, restore after — the module-level
 *  const is shared state across tests, so each case pins it explicitly. */
async function withManifest(patch: Partial<typeof AGENT_RELEASE>, fn: () => void | Promise<void>) {
  const saved = { ...AGENT_RELEASE };
  Object.assign(AGENT_RELEASE, patch);
  try {
    await fn();
  } finally {
    Object.assign(AGENT_RELEASE, saved);
  }
}

describe('agentUpdateAdvert updater floor (ticket 0e4c9601)', () => {
  it('a poller BELOW the updater floor never sees the release (its old updater would land the adhoc module)', async () => {
    await withManifest({ version: '0.8.1', sha256: REAL_SHA, minUpdaterVersion: '0.8.1' }, () => {
      expect(agentUpdateAdvert('0.8.0')).toBeNull(); // mbp-5's updater generation — the live mishap
      expect(agentUpdateAdvert('0.7.3')).toBeNull();
      expect(agentUpdateAdvert('0.6.3')).toBeNull();
    });
  });

  it('a poller AT/ABOVE the floor and below the release sees the advert normally', async () => {
    await withManifest({ version: '0.9.0', sha256: REAL_SHA, minUpdaterVersion: '0.8.1' }, () => {
      const a = agentUpdateAdvert('0.8.1');
      expect(a).toBeTruthy();
      expect(a!.version).toBe('0.9.0');
      expect(a!.sha256).toBe(REAL_SHA);
      // a poller ABOVE the floor likewise (only the strictly-newer rule applies)
      expect(agentUpdateAdvert('0.8.2')!.version).toBe('0.9.0');
    });
  });

  it('a floor at or above the release version silences the advert entirely (a publish can ship the gate closed)', async () => {
    await withManifest({ version: '0.8.0', sha256: REAL_SHA, minUpdaterVersion: '0.8.1' }, () => {
      expect(agentUpdateAdvert('0.8.0')).toBeNull();
      expect(agentUpdateAdvert('0.7.3')).toBeNull();
      expect(agentUpdateAdvert('0.6.3')).toBeNull();
      // the only poller that could act is at/above a release it cannot take
      expect(agentUpdateAdvert('0.8.1')).toBeNull(); // at-or-newer than 0.8.0 → nothing anyway
    });
  });

  it('a malformed floor is ignored (never wedges advertising on a typo)', async () => {
    await withManifest({ version: '0.8.1', sha256: REAL_SHA, minUpdaterVersion: 'not.a.version' }, () => {
      expect(agentUpdateAdvert('0.8.0')).toBeTruthy(); // behaves as if no floor
    });
    await withManifest({ version: '0.8.1', sha256: REAL_SHA, minUpdaterVersion: undefined }, () => {
      expect(agentUpdateAdvert('0.8.0')).toBeTruthy(); // absent floor = the 4e75cdea behavior
    });
  });

  it('the live manifest ships the floor: minUpdaterVersion 0.8.2 gates the 0.9.6 release', async () => {
    // The committed manifest is version 0.9.6 + floor 0.8.2 (0.8.2 landed the
    // a9a74086 native-dep change 11.10.0 → 12.11.1, which the 0.8.1
    // self-updater's native carry REFUSES by design, ticket 0e4c9601 — the
    // floor keeps those pollers on what they run). 0.9.0 (51d8dbe0), 0.9.1
    // (933e6ca4: installer/app duality), 0.9.2 (405927c9: single-agent
    // convergence), 0.9.3 (c6e91d19: running-agent stamp + installer
    // verification), 0.9.4 (the same fix with the HARDENED verification —
    // post-merge review of 5e8d73fc: env-var paths, pre-load stamp
    // invalidation, live-pid requirement, realpath entry match), 0.9.5
    // (81105154: the owner-presence classifier uses TWO CLOCKS — attribution at
    // the HID READING's moment so the agent's own synthetic input no longer
    // reads as "human input N s ago", idle measured at the report clock so
    // no false presence at the window edge), 0.9.6 (same as 0.9.5 — released
    // as one) 0.9.7 (e2915963: the runtime heal never swaps a
    // byte-identical binary and a TCC regression surfaces immediately) and
    // 0.9.8 (30787bc4: the Screen Recording status probe is backoff-gated —
    // no more every-minute native permission dialog loop from a TCC-orphaned
    // binary)
    // keep better-sqlite3 12.11.1 UNCHANGED,
    // so 0.8.2+ Macs may take it by self-update; the floor only excludes
    // ≤ 0.8.1 updaters.
    expect(AGENT_RELEASE.version).toBe('0.9.19');
    expect(AGENT_RELEASE.minUpdaterVersion).toBe('0.8.2');
    expect(agentUpdateAdvert('0.8.1')).toBeNull();
    expect(agentUpdateAdvert('0.8.0')).toBeNull();
    expect(agentUpdateAdvert('0.8.2')!.version).toBe('0.9.19'); // above-floor poller takes it
    expect(agentUpdateAdvert('0.8.3')!.version).toBe('0.9.19'); // the 51d8dbe0 ticket's own Mac (0.8.3) takes the fix
    expect(agentUpdateAdvert('0.9.0')).toBeTruthy(); // mbp-1's 0.9.0 agent takes the current release (the 933e6ca4 fix line)
    expect(agentUpdateAdvert('0.9.1')).toBeTruthy(); // a 0.9.1 Mac takes the current release (the 405927c9 convergence fix)
    expect(agentUpdateAdvert('0.9.2')).toBeTruthy(); // a 0.9.2 Mac takes 0.9.6 (the c6e91d19 stamp + verification fix)
    expect(agentUpdateAdvert('0.9.3')).toBeTruthy(); // a 0.9.3 Mac takes 0.9.6 (the hardened verification — the same-version stamp false-pass fix)
    expect(agentUpdateAdvert('0.9.4')).toBeTruthy(); // a 0.9.4 Mac takes 0.9.8 (the e2915963 + 30787bc4 line — the incident Mac itself)
    expect(agentUpdateAdvert('0.9.5')).toBeTruthy(); // a 0.9.5 Mac takes 0.9.8 — the 21c68e74 runtime release shipped as 0.9.5; 0.9.6 supersedes it (collision resolution 2026-10-24), 0.9.8 carries e2915963 + 30787bc4
    expect(agentUpdateAdvert('0.9.6')).toBeTruthy(); // a 0.9.6 Mac takes 0.9.8 (the release this incident ran on takes the fix)
    expect(agentUpdateAdvert('0.9.7')).toBeTruthy(); // a 0.9.7 Mac takes 0.9.8 (the 30787bc4 dialog-loop fix — the e2915963 incident Mac self-updated to 0.9.7 at 15:5xZ)
    expect(agentUpdateAdvert('0.9.10')!.version).toBe('0.9.19'); // a 0.9.10 Mac takes the current release
    expect(agentUpdateAdvert('0.9.11')!.version).toBe('0.9.19'); // a 0.9.11 Mac MUST take 0.9.12+ — 0.9.11 shipped WITHOUT the remote-access command (see the manifest note), so "at the release → nothing" would strand every device on a build that cannot enable the channel
    // 30d3c366: a 0.9.12 Mac (the mbp-2 incident build) TAKES the current
    // release — 0.9.13 is the release that names Input Monitoring + Automation
    // and re-requests them, so an at-0.9.12 device must never be stranded.
    expect(agentUpdateAdvert('0.9.12')!.version).toBe('0.9.19');
    // 0.9.13 (the 30d3c366 TCC-grant release) takes the current one — a device
    // must never be stranded at a release that cannot report `off`.
    expect(agentUpdateAdvert('0.9.13')!.version).toBe('0.9.19');
    // 0.9.14 (the honest three-state remote-channel release) MUST take the
    // current release (ticket 11b6974f): 0.9.14's daemon never re-read its
    // config, so an owner who enabled the unattended preset there never
    // reached the fleet — and its probe could never report `off`. Leaving
    // at-release devices alone would strand every paired Mac on exactly the
    // build this ticket is about.
    expect(agentUpdateAdvert('0.9.14')!.version).toBe('0.9.19');
    // 746c4d4f DELIVERY PIN: 0.9.15 is the build the reported incident ran on
    // (paired Mac cql-stanne-mbp1: left-clicks arriving as right-click context
    // menus, Cmd-shortcuts eaten by Finder). It is now strictly older than the
    // release, so it MUST be offered 0.9.17 — "at the release → nothing" would
    // strand every paired Mac on the build this ticket exists to fix.
    expect(agentUpdateAdvert('0.9.15')!.version).toBe('0.9.19');
    // c468f922 RELAY PIN: 0.9.16 is now strictly older than the release. A
    // 0.9.16 Mac has the command channel but NO relay pump, so it can never
    // carry a brokered session. Offering it the release is what turns a paired
    // device into an actual peer; leaving it alone would leave every existing
    // Mac permanently unable to reach the data plane this ticket ships.
    expect(agentUpdateAdvert('0.9.16')!.version).toBe('0.9.19');
    // c468f922 RFB CODEC PIN: 0.9.17 is now strictly older than the release.
    // It has the relay pump (so it can CARRY bytes) but NO RFB codec, so every
    // frame it receives is dropped at the handler seam and the operator sees no
    // screen at all. Offering it 0.9.18 is what turns "the pipe moves bytes"
    // into "the operator sees a screen"; leaving at-release 0.9.17 devices
    // alone would strand the fleet one build short of rendering.
    expect(agentUpdateAdvert('0.9.17')!.version).toBe('0.9.19');
    // c468f922 FIX SLICE PIN: 0.9.18 shipped the codec but encoded screens at
    // NATIVE size (a Retina Mac needs 317-901 relay frames against a 256 cap, so
    // video died) and never primed click geometry (every relayed click was
    // refused). 0.9.19 is the first build that actually renders AND accepts
    // input on a real display, so an at-0.9.18 device must be offered it.
    expect(agentUpdateAdvert('0.9.18')!.version).toBe('0.9.19');
    expect(agentUpdateAdvert('0.9.19')).toBeNull(); // at the release → nothing
  });
});
