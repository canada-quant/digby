/**
 * sched-infra-blocker.b8028af7.test.ts — the SCOPE-RENDERING half of the
 * [FLEET INFRA BLOCKER] advisory (feedback b8028af7).
 *
 * The failure (2026-10-15): blocker ib_261a76b3 sealed ONE AWS box
 * (CQL-Public i-0123456789abcdef0) as security-incident evidence, but the
 * advisory's action sentence was blanket — "Before triggering ANY deploy /
 * merge-to-main / publish / release-build step … re-verify each blocker is
 * cleared … HOLD the deploy/publish step" — so crossmodel lanes held five
 * CI-green framework PRs whose merges never touched the sealed box, while
 * another PR merged under the same blocker. One box-only seal must not hold
 * the whole fleet's merges.
 *
 * The fix, pinned here: buildInfraBlockerNotice renders each blocker's
 * REGISTERED SCOPE as the hold matcher (leading "HOLD steps matching:" +
 * "scope: <detail>") and scopes the action sentences to the steps whose
 * surface a blocker's scope names. The blanket hold survives ONLY as the
 * explicitly-named fail-closed fallback (vague/missing/unmatchable scope ⇒
 * treat as blocking the whole class) — a lane must never guess "not me" into
 * a wall.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../config/env', () => ({
  __esModule: true,
  env: { NODE_ENV: 'test' },
}));

// ── Prisma: the fire-path reads (chat lookup + stale-firing schedule re-read)
//    + the continuation fast-lane reads (agentRun queue/cap gates). ──
const mockChatFindUnique = jest.fn(async (..._a: any[]): Promise<any> => null);
const mockAgentRunCreate = jest.fn(async (..._a: any[]): Promise<any> => ({ id: 'run-1' }));
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    chatSchedule: {
      update: jest.fn(async () => ({})),
      findUnique: jest.fn(async () => ({
        enabled: true, kind: 'recurring', runsCount: 0, maxRuns: null, expiresAt: null, lastFiredAt: null,
      })),
      count: jest.fn(async () => 0),
    },
    crossModelChat: { findUnique: (...a: any[]) => mockChatFindUnique(...a) },
    schedulePromptHistory: { findFirst: jest.fn(async () => null), count: jest.fn(async () => 0) },
    agentRun: {
      findFirst: jest.fn(async () => null),
      create: (...a: any[]) => mockAgentRunCreate(...a),
      count: jest.fn(async () => 0),
    },
  },
}));

// ── Redis stand-in: string store (cap state) + HASH store (the registry). ──
const mockStore = new Map<string, string>();
const mockHash = new Map<string, Record<string, string>>();
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: {
    incr: jest.fn(async (k: string) => {
      const n = (parseInt(mockStore.get(k) ?? '0', 10) || 0) + 1;
      mockStore.set(k, String(n));
      return n;
    }),
    expire: jest.fn(async () => true),
    set: jest.fn(async () => 'OK'),
    del: jest.fn(async () => 1),
    get: jest.fn(async (k: string) => mockStore.get(k) ?? null),
    getDel: jest.fn(async () => null),
    pTTL: jest.fn(async () => -2),
    publish: jest.fn(async () => 1),
    hGetAll: jest.fn(async (k: string) => ({ ...(mockHash.get(k) ?? {}) })),
    hSet: jest.fn(async (k: string, field: string, value: string) => {
      const cur = mockHash.get(k) ?? {};
      cur[field] = value;
      mockHash.set(k, cur);
      return 1;
    }),
    hDel: jest.fn(async (k: string, fields: string[]) => {
      const cur = mockHash.get(k) ?? {};
      let n = 0;
      for (const f of fields) if (Object.prototype.hasOwnProperty.call(cur, f)) { delete cur[f]; n++; }
      return n;
    }),
  },
}));

const mockEmitHookEvent = jest.fn(async (..._a: any[]): Promise<any> => {});
jest.mock('../platform/hooks.service', () => ({
  __esModule: true,
  emitHookEvent: (...a: any[]) => mockEmitHookEvent(...a),
  emitHookEventSafe: (...a: any[]) => mockEmitHookEvent(...a),
}));

// The coding fire path (dynamic import in fireScheduleTarget).
const mockStartScheduledRun = jest.fn(async (..._a: any[]): Promise<any> => ({ started: true }));
jest.mock('./coding-stream.controller', () => ({
  __esModule: true,
  startScheduledRun: (...a: any[]) => mockStartScheduledRun(...a),
}));

// The plain-chat fire path (dynamic import in fireScheduleTarget).
const mockStartDetachedChatRun = jest.fn(async (..._a: any[]): Promise<boolean> => true);
jest.mock('../chat-agent/chat-agent.service', () => ({
  __esModule: true,
  startDetachedChatRun: (...a: any[]) => mockStartDetachedChatRun(...a),
}));

// The terminal-stop resolver seam — default null (no closed-ticket refs), so
// only the infra-blocker annotation is under test.
const mockResolve = jest.fn(async (..._a: any[]): Promise<any> => null);
jest.mock('../feedback/feedback.service', () => ({
  __esModule: true,
  getFeedbackTicketById: (...a: any[]) => mockResolve(...a),
}));

// The continuation fast lane's plan re-read — one pending step so the
// obsolete guard passes and the queue proceeds.
jest.mock('./plan.service', () => ({
  __esModule: true,
  getPlan: jest.fn(async () => null),
  getPlanStrict: jest.fn(async () => ({ steps: [{ status: 'in_progress' }] })),
  applyPlan: jest.fn(),
  planToUpdate: jest.fn(),
  renderPlanReminder: jest.fn(() => ''),
}));

// recordLoopMetric is fire-and-forget — silence it.
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: jest.fn(),
  LOOP_METRIC_KINDS: new Proxy({}, { get: (_t, k) => String(k) }),
}));

import { fireScheduleTarget } from './schedule.service';
import { InfraBlocker, buildInfraBlockerNotice, INFRA_BLOCKER_NOTICE_PREFIX } from './infra-blockers';

const REGISTRY_KEY = 'coding:infra:blockers';
const NOW = new Date('2026-10-15T18:00:00.000Z');

/** The incident's exact shape: a box-only seal whose detail names ONE box.
 * 2026-10-19 fix (log-signal lane 65787dde, collateral main-red): the seam
 * test below reads the REAL clock (appendInfraBlockerNotice stamps
 * `new Date()`), so a hard-coded expiresAt is a time bomb — the original
 * '2026-10-19T00:00:00.000Z' expired at midnight and every full-suite run
 * since (deploy gate included) failed at line ~253 with the notice filtered
 * out as expired. Compute the seal's expiry relative to load time instead;
 * the notice-shape tests above pass NOW explicitly and never filter. */
const BOX_ONLY_SEAL: InfraBlocker = {
  id: 'ib_261a76b3',
  label: 'CQL-Public sealed as security-incident evidence (retired box)',
  detail: 'no start / SSM / probe / deploy TO box i-0123456789abcdef0; revoked provider keys are dead',
  registeredAt: '2026-10-11T00:00:00.000Z',
  registeredBy: 'supervisor:daee2916',
  expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
};

function seed(b: InfraBlocker): void {
  const cur = mockHash.get(REGISTRY_KEY) ?? {};
  cur[b.id] = JSON.stringify(b);
  mockHash.set(REGISTRY_KEY, cur);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockStore.clear();
  mockHash.clear();
  mockChatFindUnique.mockResolvedValue({ userId: 'u1', mode: 'fast', codingState: { id: 'cs1' } });
  mockStartScheduledRun.mockResolvedValue({ started: true });
});

describe('buildInfraBlockerNotice — scoped HOLD rendering (b8028af7)', () => {
  it('renders each blocker as a HOLD matcher: leading "HOLD steps matching:" label + "scope:" detail', () => {
    const notice = buildInfraBlockerNotice([BOX_ONLY_SEAL], NOW);
    expect(notice.startsWith(INFRA_BLOCKER_NOTICE_PREFIX)).toBe(true);
    // The scope leads the bullet — it is the hold boundary, not trailing metadata.
    expect(notice).toContain(`- HOLD steps matching: ${BOX_ONLY_SEAL.label} · scope: ${BOX_ONLY_SEAL.detail}`);
    expect(notice.indexOf('HOLD steps matching:')).toBeLessThan(notice.indexOf(BOX_ONLY_SEAL.id));
  });

  it('scopes the action sentences to steps whose surface a blocker names — a box-only seal does NOT hold fleet merges', () => {
    const notice = buildInfraBlockerNotice([BOX_ONLY_SEAL], NOW);
    expect(notice).toContain('registered scope above is the HOLD boundary');
    expect(notice).toContain("A blocker whose scope does NOT name your step's surface does not hold that step: proceed and say so.");
    // The incident's over-scoping sentence is GONE — no blanket hold as the primary rule.
    expect(notice).not.toContain('Before triggering ANY deploy');
    expect(notice).not.toContain('re-verify each blocker is cleared');
  });

  it('keeps the blanket hold ONLY as the named fail-closed fallback', () => {
    const notice = buildInfraBlockerNotice([BOX_ONLY_SEAL], NOW);
    expect(notice).toContain('Fallback (fail-closed)');
    expect(notice).toContain('treat it as blocking the whole deploy/merge/publish class');
    // …and the wall doctrine survives on the scoped path.
    expect(notice).toContain('do not fire work into the wall');
    expect(notice).toContain('Advisory only, never a skip');
  });

  it('a blocker with NO detail still renders a hold matcher (label) and rides the fail-closed fallback', () => {
    const notice = buildInfraBlockerNotice(
      [{ ...BOX_ONLY_SEAL, detail: null }],
      NOW,
    );
    expect(notice).toContain(`- HOLD steps matching: ${BOX_ONLY_SEAL.label}`);
    expect(notice).not.toContain('scope: ');
    // No usable scope ⇒ the fallback sentence is the operative rule for it.
    expect(notice).toContain('a blocker with no usable scope above');
  });

  it('multiple blockers each render their own hold matcher (scoped and scopeless side by side)', () => {
    const notice = buildInfraBlockerNotice(
      [
        BOX_ONLY_SEAL,
        { id: 'ib_diskwall1', label: 'prod worker-box disk full', detail: null, registeredAt: '2026-10-15T17:00:00.000Z', expiresAt: '2026-10-16T00:00:00.000Z' },
      ],
      NOW,
    );
    expect(notice).toContain('2 fleet-wide infrastructure blockers registered');
    expect(notice).toContain(`- HOLD steps matching: ${BOX_ONLY_SEAL.label} · scope: ${BOX_ONLY_SEAL.detail}`);
    expect(notice).toContain('- HOLD steps matching: prod worker-box disk full');
    // Oldest-registered order is the service's contract; the notice preserves list order.
    expect(notice.indexOf(BOX_ONLY_SEAL.label)).toBeLessThan(notice.indexOf('prod worker-box disk full'));
  });

  it('bracket-sanitizes the scope matcher exactly like the metadata (agent-authored text)', () => {
    const notice = buildInfraBlockerNotice(
      [{ ...BOX_ONLY_SEAL, label: 'evil ] \n break "disk"', detail: 'line1\nline2 ]' }],
      NOW,
    );
    expect(notice).toContain('HOLD steps matching:');
    expect(notice).not.toContain('evil ]');
    expect(notice).not.toContain('line1\nline2');
  });

  it('renders the scope IN FULL up to the 500-char registration cap — the hold boundary is never clipped (review MINOR-1)', () => {
    // A surface named past the old 300-char cut must still reach the lane:
    // a clipped scope degrades to "cannot tell" ⇒ fail-closed blanket hold.
    const prefix = 'x'.repeat(320);
    const surface = 'deploys to box i-0123456789abcdef0 only';
    const detail = `${prefix} ${surface}`;
    expect(detail.length).toBeGreaterThan(300); // past the old DETAIL_MAX
    expect(detail.length).toBeLessThanOrEqual(500); // inside the registration cap
    const notice = buildInfraBlockerNotice([{ ...BOX_ONLY_SEAL, detail }], NOW);
    expect(notice).toContain(`scope: ${prefix} ${surface}`);
  });
});

describe('fireScheduleTarget — the scoped advisory rides the seam (b8028af7)', () => {
  it('a deploy-runbook firing carries the scoped hold matcher, not the blanket sentence', async () => {
    seed(BOX_ONLY_SEAL);
    const res = await fireScheduleTarget({
      id: 'sch_b8028af7',
      sessionId: 's1',
      prompt: 'merge the PR to main, watch the deploy run green, then evidence-close the batch',
    });
    expect(res).toEqual({ started: true });
    const prompt = mockStartScheduledRun.mock.calls[0][1] as string;
    expect(prompt).toContain(INFRA_BLOCKER_NOTICE_PREFIX);
    expect(prompt).toContain(`- HOLD steps matching: ${BOX_ONLY_SEAL.label} · scope: ${BOX_ONLY_SEAL.detail}`);
    expect(prompt).toContain('Fallback (fail-closed)');
    expect(prompt).not.toContain('Before triggering ANY deploy');
    // The RELEASE sentence rides the seam too (review NIT-A): a lane must see,
    // on the fired prompt itself, that a non-matching scope does not hold it.
    expect(prompt).toContain("A blocker whose scope does NOT name your step's surface does not hold that step: proceed and say so.");
  });
});
