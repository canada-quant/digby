/**
 * SURFACE ROUTING (ticket a2540aaa) — the missed-bug detector classifies the
 * complaint's SURFACE before filing and routes product-surface complaints to
 * the owning product project's lane.
 *
 * PROD SHAPE THIS REPLAYS: ticket 4e818bb9 (an owner complaint about a
 * deckpose.com defect, written in a chat working in the deckpose product
 * project) was filed as about='digby_platform' — the framework-signal sweep
 * read the CHAT ID the complaint appeared in, never the surface the complaint
 * is ABOUT. The platform queue filled with product tickets whose fixes live
 * in product repos the platform-scoped done-bar could not verify.
 *
 * PINS (the ticket's acceptance, in order):
 * 1. a product-surface complaint (its chat lives in a repo-bound product
 *    project and the complaint text names that product's URL) files with
 *    about='user_project' + context.userProjectId — the dispatcher's lane
 *    home for it;
 * 2. a platform-surface complaint files EXACTLY as before
 *    (about='digby_platform', no userProjectId);
 * 3. an AMBIGUOUS complaint (two competing product surfaces) keeps current
 *    behavior — mis-filing is safer than mis-routing;
 * 4. DETECTOR-RECALL REPLAY: every PRIOR true positive still fires — the
 *    real detector (findOwnerFrustration over real turns) still convicts
 *    each complaint class it convicted before this change, and each files
 *    through the REAL default path (runFrameworkSignalSweepOnce() with NO
 *    injected deps — exactly how worker.ts calls it; the prisma/redis/
 *    feedback layers below ARE the boundary);
 * 5. routing never fires without complaint-text domain evidence;
 * 6. the kill switch (MISSED_BUG_SURFACE_ROUTING_DISABLED=1) restores the
 *    platform-only stamp byte-for-byte — no project reads at all.
 *
 * The detector runs REAL (no mocks below the prisma boundary).
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import type { AdminTurn } from './framework-signal-detectors';

let userRows: AdminTurn[] = [];
let assistantRows: AdminTurn[] = [];
let chatRows: Array<{ id: string; projectId: string | null }> = [];
let projectRows: Array<{ id: string; name: string; repoUrl: string | null; userId: string }> = [];

const mockPrisma: any = {
  crossModelMessage: {
    findMany: jest.fn(async ({ where }: any = {}) => {
      if (where?.role === 'user') return userRows;
      if (where?.chatId?.in) return assistantRows.filter((a) => where.chatId.in.includes(a.chatId));
      return assistantRows;
    }),
  },
  ownerQuestion: { findMany: jest.fn(async () => []) },
  crossModelChat: {
    findMany: jest.fn(async ({ where }: any = {}) => chatRows.filter((c) => !where?.id?.in || where.id.in.includes(c.id))),
  },
  crossModelProject: {
    findMany: jest.fn(async ({ where }: any = {}) => projectRows.filter((p) => (where?.id?.in ? where.id.in.includes(p.id) : !!p.repoUrl))),
  },
  userFeatureRequest: { findMany: jest.fn(async () => []) },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));
jest.mock('./infra-watch.service', () => ({
  __esModule: true,
  adminFleetSupervisors: jest.fn(async () => [{ id: 'sup-1', userId: 'owner-1' }]),
}));

// The REAL filing seam is captured (filing args, dedupe verdicts).
type Filed = { about?: string; userProjectId?: string; title?: string; fingerprint?: string; raw: any };
let filed: Filed[] = [];
const mockFileFeedbackTicket = jest.fn(async (args: any) => {
  filed.push({ about: args?.context?.about, userProjectId: args?.context?.userProjectId, title: args?.title, fingerprint: args?.context?.fingerprint, raw: args });
  return { deduped: false, ticket: { id: `t-${filed.length}`, title: args?.title } };
});
const mockNormalize = jest.fn((t: string) => String(t ?? '').toLowerCase());
jest.mock('../feedback/feedback.service', () => ({
  __esModule: true,
  fileFeedbackTicket: (a: any) => mockFileFeedbackTicket(a),
  normalizeFeedbackTitle: (t: string) => mockNormalize(t),
}));

const mockRedisStore = new Map<string, number>();
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: {
    incr: jest.fn(async (k: string) => { const n = (mockRedisStore.get(k) ?? 0) + 1; mockRedisStore.set(k, n); return n; }),
    decr: jest.fn(async (k: string) => { const n = (mockRedisStore.get(k) ?? 0) - 1; mockRedisStore.set(k, n); return n; }),
    expire: jest.fn(async () => 1),
  },
}));
const mockRecordLoopMetric = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...(a as [])),
  LOOP_METRIC_KINDS: { FRAMEWORK_SIGNAL_SWEEP: 'framework_signal_sweep' },
}));

import { runFrameworkSignalSweepOnce } from './framework-signal-sweep';
import { findOwnerFrustration } from './framework-signal-detectors';
import { productProjectDomains } from './complaint-surface';

/** A real owner turn (the words are what the detector regex reads). */
const turn = (id: string, chatId: string, content: string, minutesAgo: number): AdminTurn => ({
  id, chatId, content, createdAt: new Date(Date.now() - minutesAgo * 60_000),
});

// The rows the surface loader serves. proj-crossmodel is the platform (its
// name AND repo slug pin the platform project) — the classifier must NEVER
// route to it. proj-deckpose is a repo-bound product; proj-optcg is the same
// product under a repo name that does NOT imply its domain (the tier-3 env
// map's real shape: product "optcg" serving deckpose.com).
const PLATFORM_REPO = 'https://github.com/canada-quant/digby';
const DECKPOSE_REPO = 'https://github.com/canada-quant/example-repo';
function seedProjects(): void {
  projectRows = [
    { id: 'proj-crossmodel', name: 'crossmodel', repoUrl: PLATFORM_REPO, userId: 'owner-1' },
    { id: 'proj-deckpose', name: 'deckpose', repoUrl: DECKPOSE_REPO, userId: 'owner-1' },
    { id: 'proj-optcg', name: 'optcg', repoUrl: DECKPOSE_REPO, userId: 'owner-1' },
  ];
  chatRows = [
    { id: 'chat-plat', projectId: 'proj-crossmodel' },
    { id: 'chat-deck', projectId: 'proj-deckpose' },
  ];
}

beforeEach(() => {
  jest.clearAllMocks();
  filed = [];
  mockRedisStore.clear();
  userRows = [];
  assistantRows = [];
  delete process.env.MISSED_BUG_SURFACE_ROUTING_DISABLED;
  delete process.env.PRODUCT_PROJECT_DOMAINS;
  seedProjects();
});

/** recordPass fires recordLoopMetric behind a dynamic-import .then() the sweep
 *  does not await — flush the microtask queue before asserting on it. */
const flushTelemetry = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('DETECTOR-RECALL REPLAY — prior missed-bug true positives still fire (real detector, real default filing path)', () => {
  it('replays the PLATFORM complaint class (the detector\'s prior conviction shape): still files about=digby_platform unchanged', async () => {
    userRows = [turn('u-plat-1', 'chat-plat', 'the deploy preview is still broken — why do i have to ask three times for a fix?', 5)];
    assistantRows = [turn('a-plat-1', 'chat-plat', 'Working on it.', 10)];
    // The detector convicted on its own regex, unmocked…
    expect(findOwnerFrustration(userRows, assistantRows)).toHaveLength(1);
    // …and the REAL default path (no injected deps — worker.ts's call shape) files it.
    await runFrameworkSignalSweepOnce();
    expect(filed).toHaveLength(1);
    expect(filed[0].about).toBe('digby_platform');
    expect(filed[0].userProjectId).toBeUndefined();
    expect(filed[0].fingerprint).toBe('missed-bug:chat-plat:u-plat-1');
    expect(filed[0].title).toBe('Missed bug: owner frustration in chat chat-pla'); // id8 truncation — today's title
    expect(filed[0].raw.context.kind).toBe('missed-bug');
    expect(filed[0].raw.context.surfaceRoute).toMatchObject({ tier: null }); // classified platform, stamped as today
    // routed count rides the pass telemetry (the summary strings are pinned
    // byte-for-byte by framework-signal-sweep.test.ts).
    await flushTelemetry();
    const pass = mockRecordLoopMetric.mock.calls.map((c) => c[0]).find((x) => x?.meta && typeof x.meta.routed === 'number');
    expect(pass?.meta.routed).toBe(0);
  });

  it('replays the OTHER prior conviction classes (frustrating / still broken / annoying) — all still file, none lost to the routing', async () => {
    userRows = [
      turn('u-r1', 'chat-plat', 'this workflow is really frustrating', 30),
      turn('u-r2', 'chat-plat', 'this is still broken after your fix', 20),
      turn('u-r3', 'chat-deck', 'the tournament page is annoying me — https://deckpose.com/tournaments keeps losing the decklist', 10),
    ];
    assistantRows = [
      turn('a-r0', 'chat-plat', 'ack', 40),
      turn('a-r2', 'chat-plat', 'ack', 25),
      turn('a-r3', 'chat-deck', 'ack', 15),
    ];
    expect(findOwnerFrustration(userRows, assistantRows)).toHaveLength(3);
    await runFrameworkSignalSweepOnce();
    expect(filed).toHaveLength(3);
    // The platform two stay platform; the deckpose one routes.
    expect(filed.filter((f) => f.about === 'digby_platform')).toHaveLength(2);
    const routed = filed.find((f) => f.userProjectId === 'proj-deckpose');
    expect(routed).toBeDefined();
    expect(routed!.about).toBe('user_project');
  });
});

describe('surface classification at filing (the detector change, default path)', () => {
  it('routes a deckpose.com complaint from a deckpose-project chat: about=user_project + userProjectId + surfaceRoute evidence', async () => {
    userRows = [turn('u-d1', 'chat-deck', 'the bracket generator on https://deckpose.com/tournaments is still broken', 5)];
    assistantRows = [turn('a-d1', 'chat-deck', 'ack', 8)];
    await runFrameworkSignalSweepOnce();
    expect(filed).toHaveLength(1);
    expect(filed[0].about).toBe('user_project');
    expect(filed[0].userProjectId).toBe('proj-deckpose');
    const ctx = filed[0].raw.context;
    expect(ctx.surfaceRoute.tier).toBe('chat_project');
    expect(ctx.surfaceRoute.repoSlug).toBe('canada-quant/example-repo');
    expect(ctx.surfaceRoute.evidence).toContain('deckpose.com');
    // Every OTHER context key survives untouched (conservative stamping).
    expect(ctx.kind).toBe('missed-bug');
    expect(ctx.chatId).toBe('chat-deck');
    expect(ctx.about).toBe('user_project');
    await flushTelemetry();
    const pass = mockRecordLoopMetric.mock.calls.map((c) => c[0]).find((x) => x?.meta && typeof x.meta.routed === 'number');
    expect(pass?.meta.routed).toBe(1);
  });

  it('does NOT route on a repo-bound product project alone (no complaint-text domain evidence): platform stamp unchanged', async () => {
    userRows = [turn('u-d2', 'chat-deck', 'the export button is still broken', 5)];
    assistantRows = [turn('a-d2', 'chat-deck', 'ack', 8)];
    await runFrameworkSignalSweepOnce();
    expect(filed).toHaveLength(1);
    expect(filed[0].about).toBe('digby_platform');
    expect(filed[0].userProjectId).toBeUndefined();
    expect(filed[0].raw.context.surfaceRoute).toMatchObject({ tier: null });
  });

  it('routes via the env map when NO project token implies the domain (tier 3: product "optcg" serving deckpose.com)', async () => {
    // No repo/name token may imply deckpose.com — the deckpose project is
    // out of the picture for this pass (its id/name/repo all say optcg).
    projectRows = projectRows.filter((p) => p.id !== 'proj-deckpose');
    process.env.PRODUCT_PROJECT_DOMAINS = 'proj-optcg=deckpose.com';
    chatRows = [{ id: 'chat-solo', projectId: null }];
    userRows = [turn('u-s1', 'chat-solo', 'https://deckpose.com/tournaments dropped my decklist — why do i have to rebuild it', 5)];
    assistantRows = [turn('a-s1', 'chat-solo', 'ack', 8)];
    await runFrameworkSignalSweepOnce();
    expect(filed).toHaveLength(1);
    expect(filed[0].about).toBe('user_project');
    expect(filed[0].userProjectId).toBe('proj-optcg');
    expect(filed[0].raw.context.surfaceRoute).toMatchObject({ tier: 'env_map', repoSlug: 'canada-quant/example-repo' });
    expect(filed[0].raw.context.surfaceRoute.evidence).toContain('PRODUCT_PROJECT_DOMAINS');
  });

  it('routes a deckpose.com complaint from a PLATFORM-project chat via the OTHER repo-bound project (candidates tier)', async () => {
    userRows = [turn('u-d3', 'chat-plat', 'the decklist import at https://deckpose.com/tournaments is still broken', 5)];
    assistantRows = [turn('a-d3', 'chat-plat', 'ack', 8)];
    await runFrameworkSignalSweepOnce();
    expect(filed).toHaveLength(1);
    expect(filed[0].about).toBe('user_project');
    expect(filed[0].userProjectId).toBe('proj-deckpose');
    expect(filed[0].raw.context.surfaceRoute).toMatchObject({ tier: 'candidates' });
  });

  it('the SAME project matching through two tiers (chat tokens AND the env map) is ONE match — routes, not ambiguity', async () => {
    process.env.PRODUCT_PROJECT_DOMAINS = 'proj-deckpose=deckpose.com';
    userRows = [turn('u-t2', 'chat-deck', 'the decklist import at https://deckpose.com/tournaments is still broken', 5)];
    assistantRows = [turn('a-t2', 'chat-deck', 'ack', 8)];
    await runFrameworkSignalSweepOnce();
    expect(filed).toHaveLength(1);
    expect(filed[0].about).toBe('user_project');
    expect(filed[0].userProjectId).toBe('proj-deckpose');
    expect(filed[0].raw.context.surfaceRoute).toMatchObject({ tier: 'chat_project' });
    expect(filed[0].raw.context.surfaceRoute.evidence).toContain("chat's own project");
  });

  it('AMBIGUOUS evidence (two competing product surfaces) keeps current behavior — mis-filing is safer than mis-routing', async () => {
    projectRows = [
      ...projectRows,
      { id: 'proj-canvasly', name: 'canvasly', repoUrl: 'https://github.com/canada-quant/canvasly', userId: 'owner-1' },
    ];
    userRows = [turn('u-m1', 'chat-deck', 'the decklist export on deckpose.com is still broken, and so is my bracket app at canvasly.app', 5)];
    assistantRows = [turn('a-m1', 'chat-deck', 'ack', 8)];
    await runFrameworkSignalSweepOnce();
    expect(filed).toHaveLength(1);
    expect(filed[0].about).toBe('digby_platform');
    expect(filed[0].userProjectId).toBeUndefined();
  });

  it('never routes to the PLATFORM project even when a complaint names digby.example.com (platform domains are never evidence)', async () => {
    userRows = [turn('u-p1', 'chat-plat', 'digby.example.com streaming is still broken', 5)];
    assistantRows = [turn('a-p1', 'chat-plat', 'ack', 8)];
    await runFrameworkSignalSweepOnce();
    expect(filed).toHaveLength(1);
    expect(filed[0].about).toBe('digby_platform');
    expect(filed[0].userProjectId).toBeUndefined();
    expect(filed[0].raw.context.surfaceRoute).toMatchObject({ tier: null });
  });

  it('an unmatched product domain (no project implies it, no env map) stays platform', async () => {
    userRows = [turn('u-x1', 'chat-plat', 'the checkout at https://shopsomewhereelse.com is still broken', 5)];
    assistantRows = [turn('a-x1', 'chat-plat', 'ack', 8)];
    await runFrameworkSignalSweepOnce();
    expect(filed).toHaveLength(1);
    expect(filed[0].about).toBe('digby_platform');
    expect(filed[0].userProjectId).toBeUndefined();
  });
});

describe('kill switch + no-finding pass (default path)', () => {
  it('MISSED_BUG_SURFACE_ROUTING_DISABLED=1 restores the platform-only stamp byte-for-byte — no project reads at all', async () => {
    process.env.MISSED_BUG_SURFACE_ROUTING_DISABLED = '1';
    userRows = [turn('u-k1', 'chat-deck', 'https://deckpose.com/tournaments is still broken', 5)];
    assistantRows = [turn('a-k1', 'chat-deck', 'ack', 8)];
    await runFrameworkSignalSweepOnce();
    expect(mockPrisma.crossModelProject.findMany).not.toHaveBeenCalled();
    expect(filed).toHaveLength(1);
    expect(filed[0].about).toBe('digby_platform');
    expect(filed[0].userProjectId).toBeUndefined();
    expect(filed[0].raw.context.surfaceRoute).toBeUndefined();
    await flushTelemetry();
    const pass = mockRecordLoopMetric.mock.calls.map((c) => c[0]).find((x) => x?.meta && typeof x.meta.routed === 'number');
    expect(pass?.meta.routed).toBe(0);
  });

  it('a pass with no findings files nothing', async () => {
    const summary = await runFrameworkSignalSweepOnce();
    expect(filed).toHaveLength(0);
    expect(summary).toContain('found 0');
  });
});

describe('env seam + adjacent classes', () => {
  it('productProjectDomains parses PRODUCT_PROJECT_DOMAINS (env seam used by tier 3)', () => {
    const parsed = productProjectDomains({ PRODUCT_PROJECT_DOMAINS: 'p111=app.example.com, p222=deckpose.com deckpose.app' });
    expect([...parsed.entries()]).toEqual([
      ['p111', new Set(['app.example.com'])],
      ['p222', new Set(['deckpose.com', 'deckpose.app'])],
    ]);
    expect(productProjectDomains({}).size).toBe(0);
    expect(productProjectDomains(undefined as any).size).toBe(0);
  });

  it('raw-marker findings keep the platform stamp (the classifier only touches missed-bug findings)', async () => {
    // A [HARNESS …] marker surviving renderer cleaning — the raw-marker
    // detector's conviction shape — through the default path.
    assistantRows = [turn('a-mk1', 'chat-deck', '[HARNESS NOTE] stream ended without a final answer', 5)];
    await runFrameworkSignalSweepOnce();
    const markers = filed.filter((f) => String(f.fingerprint ?? '').startsWith('raw-marker:'));
    for (const m of markers) {
      expect(m.about).toBe('digby_platform');
      expect(m.userProjectId).toBeUndefined();
      expect(m.raw.context.surfaceRoute).toBeUndefined();
    }
  });
});
