/**
 * Ticket e2915963 (2026-10-24, agent-filed) — "Mac agent self-update loses
 * Accessibility TCC grant — unattended computer-use dies at 0 steps until
 * owner re-grants" — BACKEND HALF.
 *
 * THE MISHAP (replayed here at the poll seam, the exact observable the
 * incident produced):
 *   • 14:48:06Z — the agent self-updated 0.9.4 → 0.9.6; the runtime heal
 *     (21c68e74) swapped the DigbyAgent binary at its stable path (a rename —
 *     new inode; macOS TCC grants attach to the exact file).
 *   • The stored advertisement still said ax:true (the pre-update process
 *     advertised it on its last poll).
 *   • 15:01Z — the next computer_task returned "[COMPUTER_TASK —
 *     UNAVAILABLE] … Missing macOS permission(s): Accessibility", steps: 0.
 *     NOTHING told the owner; the OS had re-prompted into the void (owner
 *     absent). A scheduled AWS-console drive stood down at zero steps.
 *
 * WHAT THE BACKEND FIX DOES at the ONLY seam that can see the flip: the poll
 * route reads the STORED permissions (pre-update) vs the fresh advert
 * (post-update). A stored-true → fresh-false key is a regression → ONE
 * deduped Telegram push to the owner (the notify_user channel), the moment
 * it happens — not at task time.
 *
 * The PURE decision core lives in ./agent-perm-regression.ts (no Prisma/Redis
 * imports — the same constraint as computer-agent/availability.ts); the
 * controller wiring is pinned source-bytes (the house idiom for effectful
 * seams that cannot boot on Linux CI without the full stack).
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../config/database', () => {
  const store: any = { rows: [] };
  return { __esModule: true, default: store };
});
jest.mock('../../../config/env', () => ({
  __esModule: true,
  env: { NODE_ENV: 'test' },
}));
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: {
    get: jest.fn(async () => null),
    set: jest.fn(async () => null),
    del: jest.fn(async () => null),
    setEx: jest.fn(async () => null),
  },
}));
jest.mock('./agent-link', () => ({
  __esModule: true,
  agentBroker: { dispatch: jest.fn(), waitForCommand: jest.fn(async () => null), deliverResult: jest.fn() },
}));

import { readFileSync } from 'fs';
import { join } from 'path';

import {
  whichTccPermissionsRegressed,
  shouldPushTccRegression,
  tccRegressionPushText,
  versionTransitionCause,
  joinedKeySet,
  tccRegressionDedupeKey,
  storedPermissionsOf,
} from './agent-perm-regression';

// __dirname (CommonJS backend — the 2f646c10 suite's idiom; import.meta is
// not enabled for backend tests).
const here = __dirname;

// ── 1. The pure regression core ───────────────────────────────────────────────

describe('e2915963: whichTccPermissionsRegressed — the exact incident shape', () => {
  it('flags ax when the stored advert said granted and the fresh advert says missing (0.9.4→0.9.6 incident)', () => {
    // The incident: stored {ax:true} pre-update, fresh {ax:false} post-update.
    const regressed = whichTccPermissionsRegressed(
      { ax: true, sr: true, fda: true },
      { ax: false, sr: true, fda: true },
    );
    expect(regressed).toEqual(['ax']);
  });

  it('flags every regressed key together (a heal swap orphans all three at once)', () => {
    const regressed = whichTccPermissionsRegressed(
      { ax: true, sr: true, fda: true },
      { ax: false, sr: false, fda: false },
    );
    expect([...regressed].sort()).toEqual(['ax', 'fda', 'sr']);
  });

  it('never flags a false→true flip (a grant landing is not a regression)', () => {
    expect(whichTccPermissionsRegressed({ ax: false }, { ax: true })).toEqual([]);
  });

  it('never flags a permission that was never granted (the onboarding flow owns pre-existing gaps)', () => {
    expect(whichTccPermissionsRegressed({ ax: false, sr: false }, { ax: false, sr: false })).toEqual([]);
    expect(whichTccPermissionsRegressed(null, { ax: false })).toEqual([]);
  });

  it('an absent fresh advert never fabricates a regression (absent-never-clobbers)', () => {
    expect(whichTccPermissionsRegressed({ ax: true }, null)).toEqual([]);
    expect(whichTccPermissionsRegressed({ ax: true }, undefined)).toEqual([]);
  });
});

describe('e2915963: shouldPushTccRegression — ONE push per regression episode', () => {
  it('pushes on the first observation of a key-set', () => {
    expect(shouldPushTccRegression(['ax'], null)).toBe(true);
    expect(shouldPushTccRegression(['ax'], undefined)).toBe(true);
  });

  it('does NOT re-push while the same episode is in flight (the 25 s poll storm dedupe)', () => {
    const set = joinedKeySet(['ax']);
    expect(shouldPushTccRegression(['ax'], set)).toBe(false);
  });

  it('a DIFFERENT key-set is a NEW episode and pushes again (more grants lost)', () => {
    expect(shouldPushTccRegression(['ax', 'sr'], joinedKeySet(['ax']))).toBe(true);
  });

  it('no regression never pushes', () => {
    expect(shouldPushTccRegression([], null)).toBe(false);
  });
});

describe('e2915963: tccRegressionPushText — the owner-facing message', () => {
  it('names the device, the lost grants and the fix, and attributes the version transition', () => {
    const text = tccRegressionPushText('cqlstannembp1', ['ax'], '0.9.4 → 0.9.6');
    expect(text).toContain('cqlstannembp1');
    expect(text).toContain('0.9.4 → 0.9.6');
    expect(text).toContain('Accessibility');
    expect(text).toContain('DigbyAgent');
    expect(text).toContain('Privacy & Security');
  });

  it('reads correctly with no cause (unattributed regression still surfaces)', () => {
    const text = tccRegressionPushText('Mac mini', ['ax', 'sr'], null);
    expect(text).toContain('Mac mini');
    expect(text).toContain('Accessibility, Screen Recording');
    expect(text).toContain('were');
  });
});

describe('e2915963: versionTransitionCause — the observable only the backend sees', () => {
  it('extracts "0.9.4 → 0.9.6" from a real transition', () => {
    expect(versionTransitionCause('0.9.4', '0.9.6')).toBe('0.9.4 → 0.9.6');
  });

  it('null when either version is missing or malformed, or no transition', () => {
    expect(versionTransitionCause(null, '0.9.6')).toBeNull();
    expect(versionTransitionCause('0.9.4', null)).toBeNull();
    expect(versionTransitionCause('0.9.4', '0.9.4')).toBeNull();
    expect(versionTransitionCause('unknown', '0.9.6')).toBeNull();
  });
});

describe('e2915963: dedupe key + stored-permission extraction', () => {
  it('the dedupe key is stable per agent row', () => {
    expect(tccRegressionDedupeKey('agent-1')).toBe('tcc_regression:agent-1');
  });

  it('storedPermissionsOf normalizes a stored row the same way the merge path does', () => {
    expect(storedPermissionsOf({ permissions: { ax: true, sr: false, fda: true, relaunch: false } })).toMatchObject({ ax: true, sr: false, fda: true });
    expect(storedPermissionsOf({ permissions: null })).toBeNull();
    expect(storedPermissionsOf(null)).toBeNull();
    expect(storedPermissionsOf({ permissions: { ax: 'garbage' } })).toBeNull();
  });
});

// ── 2. The controller wiring (source-bytes pins — the house idiom) ────────────

describe('e2915963: the poll seam wires the detector (source-byte pins)', () => {
  const src = readFileSync(join(here, 'imessage.controller.ts'), 'utf8');

  it('the poll route computes the regression from the STORED advertisement BEFORE touchAgent overwrites it', () => {
    // The detector MUST read the pre-update advertisement (agent row) — after
    // touchAgent the stored value IS the fresh one and the flip is gone.
    const detectorIdx = src.indexOf('whichTccPermissionsRegressed(agentPermissions(agent), mergedPerms)');
    const touchIdx = src.indexOf('await touchAgent(agent.id, version,');
    expect(detectorIdx).toBeGreaterThan(-1);
    expect(touchIdx).toBeGreaterThan(detectorIdx);
  });

  it('the push is fire-and-forget (the poll path never blocks on Telegram/Redis)', () => {
    expect(src).toMatch(/void pushTccRegressionToOwner\(/);
    expect(src).toMatch(/\.catch\(\(e\) => logger\.warn\(`imessage: TCC regression push failed/);
  });

  it('a healed episode clears the dedupe key (a future regression pushes fresh)', () => {
    expect(src).toMatch(/\(redisClient as any\)\.del\(tccRegressionDedupeKey\(agent\.id\)\)/);
  });

  it('a send FAILURE releases the dedupe key so the next poll retries (review F5 — a Telegram outage must not swallow the episode silently)', () => {
    expect(src).toMatch(/releasing the dedupe key so the next poll retries/);
    expect(src).toMatch(/del\(dedupeKey\)/);
  });

  it('the owner push reuses the notify_user Telegram channel and marks the episode BEFORE the send', () => {
    expect(src).toMatch(/redisClient as any\)\.set\(dedupeKey, episodeKeySet/);
    expect(src).toMatch(/telegram\/telegram\.service/);
    expect(src).toMatch(/telegramLink\.findUnique/);
  });
});
