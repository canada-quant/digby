/**
 * REPLAY — ticket e4d345a9.
 *
 * THE DEFECT (measured in production telemetry, 8 rows in ~15 h):
 *   "ToolExecutor: generate_image failed: Invalid `prisma.generatedFile.create()`
 *    invocation: Foreign key constraint violated on the constraint:
 *    `generated_files_userId_fkey`"
 * and the same for create_document. Every occurrence was a GUEST turn.
 *
 * THE MECHANISM this suite replays, in three steps:
 *   1. `chat-agent.service.ts` builds guest runs as
 *      `runUserId = userId || 'anonymous'` — a TRUTHY sentinel, because the
 *      stores it was designed for are key-value with no FK.
 *   2. That sentinel reaches `new ToolCache(runUserId, …)`.
 *   3. Every per-user tool guards with `if (!this.userId) return
 *      DOC_SIGN_IN_MSG` — which a truthy 'anonymous' sails straight past, so
 *      the insert ran with userId='anonymous', a value with no `users` row,
 *      and `generated_files` (NOT NULL + FK → users.id) raised P2003.
 *
 * WHAT IS PINNED HERE:
 *   - a guest cache (null / 'anonymous' / 'anon-…') is normalized to "no owner"
 *     at the single construction seam, so the sign-in guard fires and NO
 *     generated_files INSERT is attempted at all (the FK cannot be reached);
 *   - a signed-in id that has no `users` row — a stale/deleted account — is
 *     refused BEFORE the insert with the typed owner error, not with a raw
 *     prisma P2003;
 *   - an owner deleted between the check and the insert (the residual race) is
 *     translated from P2003 into the SAME typed error;
 *   - the model-facing text is one honest sentence that says "do not retry" —
 *     never the prisma invocation / constraint text, and never the document
 *     catch-all's "correct the arguments and retry" (which is what derailed the
 *     tool loop: guard_strike seam tool_derail_break on 2026-10-30T08:43Z);
 *   - a healthy signed-in owner still persists normally (no regression).
 *
 * Scaffold: document-tools.test.ts / tool-executor.generate-image.test.ts
 * (same mocked boundaries: config/database, upload.controller, mcp-search).
 */
jest.mock('../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {
  generatedFile: {
    create: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(),
    update: jest.fn(),
    aggregate: jest.fn(),
  },
  // The `users` probe createGeneratedFileRow runs before the insert. Default:
  // the owner EXISTS (every pre-existing suite shape); cases override.
  user: { findUnique: jest.fn() },
  crossModelChat: { findFirst: jest.fn(async () => null) },
  projectDocument: { findFirst: jest.fn(), findMany: jest.fn() },
  projectChunk: { findMany: jest.fn() },
  chatFile: { findMany: jest.fn() },
};
jest.mock('../../config/database', () => ({ __esModule: true, default: mockPrisma }));

const mockLoadAttachment: jest.Mock = jest.fn(async () => null);
jest.mock('./upload.controller', () => ({
  __esModule: true,
  loadAttachment: (...a: any[]) => mockLoadAttachment(...a),
}));

jest.mock('./mcp-search', () => ({
  __esModule: true,
  callMcpTool: jest.fn(async () => null),
  webToolsDegraded: jest.fn(() => false),
}));
jest.mock('./coding/web-pipe', () => ({ __esModule: true, runWebPipe: jest.fn() }));
jest.mock('./coding/youtube-pipe', () => ({ __esModule: true, runYoutubePipe: jest.fn() }));

// The image provider leaf — the defect happened AFTER the paid call succeeded,
// so the replay must reach persistence exactly as production did.
const mockGenerateImage: jest.Mock = jest.fn();
jest.mock('./image-generate', () => ({
  __esModule: true,
  generateImage: (...a: any[]) => mockGenerateImage(...a),
  describeImageSubstitution: () => '',
  ImageGenerationError: class ImageGenerationError extends Error { constructor(public code: string, message: string) { super(message); } },
}), { virtual: true });

const mockRedis = {
  incr: jest.fn(async () => 1),
  decr: jest.fn(async () => 0),
  expire: jest.fn(async () => 1),
};
jest.mock('../../config/redis', () => ({ __esModule: true, default: mockRedis }));
jest.mock('./platform/rate-slots', () => ({
  __esModule: true,
  HOUR_KEY_TTL: 2 * 3600,
  DAY_KEY_TTL: 2 * 86_400,
  rateKeys: (prefix: string, userId: string, sessionId: string) => ({
    dayKey: `${prefix}:user:${userId}:d`, hourKey: `${prefix}:chat:${sessionId}:h`,
  }),
  consumeRateSlots: async () => ({ ok: true }),
}), { virtual: true });

const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('./platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
  LOOP_METRIC_KINDS: { IMAGE_GENERATION: 'image_generation' },
}));

import {
  ToolCache,
  GeneratedFileOwnerError,
  GENERATED_FILE_OWNER_MSG,
} from './tool-executor';

const SIGN_IN_MSG = 'Document tools need a signed-in account. Ask the user to sign in, then try again.';
const OWNER = '83e4fbf9-e18c-42f1-9bf7-7a99caf9d9c4';
const STALE_OWNER = 'deleted-account-0000-0000-000000000000';
const GUEST_CHAT = 'anon-b03';

/** The exact error Prisma raises for this defect (code + message tail). */
const prismaFkError = () => Object.assign(
  new Error("\nInvalid `prisma.generatedFile.create()` invocation:\n\n\nForeign key constraint violated on the constraint: `generated_files_userId_fkey`"),
  { code: 'P2003', meta: { field_name: 'generated_files_userId_fkey' } },
);

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('png-body')]);
const okImage = () => ({
  bytes: PNG, mimeType: 'image/png', width: 1024, height: 1024, model: 'qwen-image-3.0', provider: 'dashscope',
  spec: 'qwen-image-3.0', latencyMs: 4200, referenceMode: 'none',
});

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.generatedFile.aggregate.mockResolvedValue({ _count: { _all: 1 }, _sum: { size: 1024 } });
  mockPrisma.generatedFile.create.mockImplementation(async ({ data }: any) => ({ id: 'file-1', ...data }));
  mockPrisma.generatedFile.findFirst.mockResolvedValue(null);
  mockPrisma.user.findUnique.mockResolvedValue({ id: OWNER });
  mockLoadAttachment.mockResolvedValue(null);
  mockGenerateImage.mockResolvedValue(okImage());
});

describe('e4d345a9 (1) — a guest run can never reach the generated_files FK', () => {
  // The three shapes a guest run actually carries to ToolCache: the null an
  // explicit guest path passes, the 'anonymous' sentinel chat-agent builds
  // (`runUserId = userId || 'anonymous'`), and an `anon-<sid>` session key.
  it.each([
    ['null (explicit anonymous)', null],
    ["'anonymous' (the chat-agent sentinel)", 'anonymous'],
    ["'  anonymous  ' (padded sentinel)", '  anonymous  '],
    ["'anon-b03' (the guest chat from the 08:43Z error row)", GUEST_CHAT],
  ])('%s → the sign-in message and NO INSERT', async (_label, userId) => {
    const cache = new ToolCache(userId as any);
    expect(await cache.getOrExecute('create_document', { filename: 'a.txt', content: 'x' })).toBe(SIGN_IN_MSG);
    expect(await cache.getOrExecute('generate_image', { prompt: 'a red fox in the snow' })).toBe(SIGN_IN_MSG);
    // The whole point: the constraint is never approached.
    expect(mockPrisma.generatedFile.create).not.toHaveBeenCalled();
    expect(mockGenerateImage).not.toHaveBeenCalled();
  });

  it('the MECHANISM: the sentinel is truthy, which is why the sign-in guard never fired', async () => {
    // The replay above is only meaningful if 'anonymous' really does pass the
    // `if (!this.userId)` guards that pre-fix code relied on. Prove that
    // property directly: the old guard is a plain falsy test, so a truthy
    // sentinel sailed past it and the INSERT ran.
    expect(Boolean('anonymous')).toBe(true);
    expect(Boolean('anon-b03')).toBe(true);
    // ...and that a guest cache now reports NO owner, so the guard fires.
    const guest: any = new ToolCache('anonymous');
    expect(guest.userId).toBeNull();
    // A signed-in id is preserved untouched (normalization is not over-broad).
    const real: any = new ToolCache(OWNER);
    expect(real.userId).toBe(OWNER);
  });

  it('a guest browser_task takes the sign-in path (the same normalization, one seam up)', async () => {
    // N1 from the adversarial review: normalizing the sentinel also fixes a
    // real hole on this tool — pre-fix a guest passed the guard and consumed a
    // hosted-browser session under a userId that has no account. Pin it so the
    // behaviour change is deliberate and visible.
    const out = await new ToolCache('anonymous').getOrExecute('browser_task', { task: 'open example.com' });
    expect(out).toContain('only available for signed-in users');
  });
});

describe('e4d345a9 (1) — an unresolvable owner is refused BEFORE the insert', () => {
  it('create_document: owner has no users row → typed error, no insert attempted', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);
    const out = await new ToolCache(STALE_OWNER).getOrExecute('create_document', { filename: 'notes.txt', content: 'hello' });
    expect(out).toBe(GENERATED_FILE_OWNER_MSG);
    expect(mockPrisma.generatedFile.create).not.toHaveBeenCalled();
  });

  it('generate_image: owner has no users row → typed error, slots refunded, no insert', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);
    const out = await new ToolCache(STALE_OWNER, GUEST_CHAT).getOrExecute('generate_image', { prompt: 'a quiet harbour at dawn' });
    expect(out).toBe(GENERATED_FILE_OWNER_MSG);
    expect(mockPrisma.generatedFile.create).not.toHaveBeenCalled();
    // Consumed-before / refunded-on-failure invariant still holds.
    expect(mockRedis.decr).toHaveBeenCalled();
  });
});

describe('e4d345a9 (2) — the residual FK race is translated, never surfaced raw', () => {
  it('an owner deleted between the check and the insert (P2003) → the same typed error', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: OWNER }); // passes the probe
    mockPrisma.generatedFile.create.mockRejectedValue(prismaFkError());
    const out = await new ToolCache(OWNER).getOrExecute('create_document', { filename: 'a.txt', content: 'x' });
    expect(out).toBe(GENERATED_FILE_OWNER_MSG);
  });

  it('the model-facing text tells the agent to STOP, not to correct its arguments', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);
    const out = await new ToolCache(STALE_OWNER).getOrExecute('create_document', { filename: 'a.txt', content: 'x' });
    expect(out).toMatch(/Do not retry/);
    // The old document catch-all invited a retry — the derail's trigger.
    expect(out).not.toMatch(/correct the arguments and retry/);
  });

  it('a non-FK failure still takes the ordinary document-tool path (no over-capture)', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: OWNER });
    mockPrisma.generatedFile.create.mockRejectedValue(new Error('connection reset'));
    const out = await new ToolCache(OWNER).getOrExecute('create_document', { filename: 'a.txt', content: 'x' });
    expect(out).toContain('correct the arguments and retry');
    expect(out).not.toBe(GENERATED_FILE_OWNER_MSG);
  });

  it('GeneratedFileOwnerError carries a stable code for the REST mirror', () => {
    const err = new GeneratedFileOwnerError();
    expect(err.code).toBe('owner_unresolved');
    expect(err.message).toBe(GENERATED_FILE_OWNER_MSG);
    expect(err).toBeInstanceOf(Error);
  });
});

describe('e4d345a9 — a healthy signed-in owner is unchanged (no regression)', () => {
  it('create_document persists ONE row for a resolvable owner', async () => {
    mockPrisma.generatedFile.create.mockResolvedValue({ id: 'file-ok' });
    const out = await new ToolCache(OWNER).getOrExecute('create_document', { filename: 'notes.txt', content: 'hello' });
    expect(out).toContain('file-ok');
    expect(mockPrisma.generatedFile.create).toHaveBeenCalledTimes(1);
    const arg = mockPrisma.generatedFile.create.mock.calls[0][0];
    expect(arg.data.userId).toBe(OWNER);
    expect(arg.data.filename).toBe('notes.txt');
  });

  it('generate_image persists for a resolvable owner', async () => {
    mockPrisma.generatedFile.create.mockResolvedValue({ id: 'img-ok' });
    const out = await new ToolCache(OWNER, GUEST_CHAT).getOrExecute('generate_image', { prompt: 'a quiet harbour at dawn' });
    expect(out).toContain('img-ok');
    expect(mockPrisma.generatedFile.create).toHaveBeenCalledTimes(1);
    expect(mockPrisma.generatedFile.create.mock.calls[0][0].data.userId).toBe(OWNER);
  });
});
