/**
 * Feedback screenshots → disk + vision-at-dispatch (e87aee19) — unit tests.
 *
 *   (a) extraction strips the packed ---IMAGES--- base64 out of the stored
 *       description and writes the decoded bytes under
 *       <FEEDBACK_IMAGES_ROOT>/<ticketId>/ (real fs, tmp dir);
 *   (b) the dispatch brief builder inlines the CACHED vision text
 *       ("Screenshot N (vision): …") and NEVER carries base64 — each image is
 *       described ONCE EVER (the <file>.desc.txt sidecar), across the single
 *       AND batch briefs, and a legacy still-packed row is healed at dispatch;
 *   (c) a vision failure (or a missing image file) degrades silently to the
 *       file-reference line — the dispatch still sends.
 *
 * describeImageWithVision is mocked throughout; prisma/redis/the lane seam are
 * mocked exactly as in ticket-dispatch.service.test.ts.
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {
  crossModelChat: { findUnique: jest.fn() },
  userFeatureRequest: { findMany: jest.fn(async () => []), update: jest.fn() },
  agentRun: { count: jest.fn(async () => 0), findMany: jest.fn(async () => []) },
  chatCodingState: { findMany: jest.fn(async () => []) },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

const mockRedisSet: jest.Mock = jest.fn(async () => 'OK');
const mockRedisIncr: jest.Mock = jest.fn(async () => 1);
const mockRedisExpire: jest.Mock = jest.fn(async () => 1);
const mockRedisDel: jest.Mock = jest.fn(async () => 1);
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: {
    set: (...a: any[]) => mockRedisSet(...a),
    incr: (...a: any[]) => mockRedisIncr(...a),
    expire: (...a: any[]) => mockRedisExpire(...a),
    del: (...a: any[]) => mockRedisDel(...a),
  },
}));

// The lane-send seam (dynamic import inside the dispatch service).
const mockSendChatMessage: jest.Mock = jest.fn(async () => ({ queued: true, chatId: 'lane-1' }));
const mockStartCodingSession: jest.Mock = jest.fn(async () => ({ id: 'batch-sess-1' }));
jest.mock('../platform/platform.service', () => ({
  __esModule: true,
  sendChatMessage: (...a: any[]) => mockSendChatMessage(...a),
  startCodingSession: (...a: any[]) => mockStartCodingSession(...a),
}));

// The vision hop — mocked; dispatch callers must degrade when it throws.
const VISION_TEXT = 'A screenshot of the feedback form with a greyed-out attach button.';
const mockDescribe: jest.Mock = jest.fn(async () => VISION_TEXT);
jest.mock('../image-describe', () => ({
  __esModule: true,
  describeImageWithVision: (...a: any[]) => mockDescribe(...a),
}));

import {
  IMAGE_DELIMITER,
  extractFeedbackImages,
  parseScreenshotRefs,
  renderScreenshotLines,
  resolveScreenshotPath,
  stripImagesSection,
} from './feedback-images';
import { dispatchTicketToLane, drainOpenTicketsToLane } from './ticket-dispatch.service';

// 1×1 px PNG / 1×1 px JPEG — real decodable bytes (mime comes from the data URL).
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const JPG_B64 = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/2wBDAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AvwA//9k=';
const PNG_URL = `data:image/png;base64,${PNG_B64}`;
const JPG_URL = `data:image/jpeg;base64,${JPG_B64}`;

let ROOT: string;
const ENV = { ...process.env };

beforeAll(async () => {
  ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'digby-fbimg-'));
});

afterAll(async () => {
  process.env = ENV;
  await fs.rm(ROOT, { recursive: true, force: true });
});

beforeEach(() => {
  jest.clearAllMocks();
  process.env = { ...ENV };
  process.env.FEEDBACK_IMAGES_ROOT = ROOT;
  process.env.TICKET_DISPATCH_ENABLED = 'true';
  process.env.PLATFORM_ENGINEER_CHAT_ID = 'lane-1';
  delete process.env.TICKET_DISPATCH_DAILY_CAP;
  mockPrisma.crossModelChat.findUnique.mockResolvedValue({ userId: 'owner-1' });
  mockPrisma.userFeatureRequest.findMany.mockResolvedValue([]);
  mockPrisma.userFeatureRequest.update.mockImplementation(async ({ where, data }: any) => ({ id: where.id, ...data }));
  mockRedisSet.mockResolvedValue('OK');
  mockRedisIncr.mockResolvedValue(1);
  mockSendChatMessage.mockResolvedValue({ queued: true, chatId: 'lane-1' });
  mockPrisma.agentRun.count.mockResolvedValue(0);
  mockPrisma.agentRun.findMany.mockResolvedValue([]);
  mockPrisma.chatCodingState.findMany.mockResolvedValue([]);
  mockDescribe.mockResolvedValue(VISION_TEXT);
});

// ── (a) extraction: strip + store ─────────────────────────────────────────────

describe('extractFeedbackImages — (a) strips base64, writes files', () => {
  it('strips the packed section, writes the decoded bytes, and leaves reference lines', async () => {
    const packed = `The attach button is dead.${IMAGE_DELIMITER}${PNG_URL}\n${JPG_URL}`;
    const r = await extractFeedbackImages(packed, 't-a1');

    expect(r.description).not.toContain('---IMAGES---');
    expect(r.description).not.toContain('base64');
    expect(r.description).toContain('The attach button is dead.');
    expect(r.description).toContain('[screenshot 1: t-a1/1.png]');
    expect(r.description).toContain('[screenshot 2: t-a1/2.jpg]');
    expect(r.images).toHaveLength(2);

    const png = await fs.readFile(path.join(ROOT, 't-a1', '1.png'));
    expect(png.equals(Buffer.from(PNG_B64, 'base64'))).toBe(true);
    const jpg = await fs.readFile(path.join(ROOT, 't-a1', '2.jpg'));
    expect(jpg.equals(Buffer.from(JPG_B64, 'base64'))).toBe(true);
  });

  it('is idempotent — re-extracting the same packed description never duplicates files', async () => {
    const packed = `dupe.${IMAGE_DELIMITER}${PNG_URL}`;
    await extractFeedbackImages(packed, 't-a2');
    const again = await extractFeedbackImages(packed, 't-a2');
    expect(again.images).toHaveLength(1);
    expect(await fs.readdir(path.join(ROOT, 't-a2'))).toEqual(['1.png']);
  });

  it('a dedup append with NEW screenshots never overwrites the earlier ones (next-free index)', async () => {
    // The dedup-bump path extracts into the EXISTING ticket's dir: a blind
    // restart at 1.png would clobber the first filing's image (and orphan its
    // [screenshot 1: …] ref + any cached <file>.desc.txt vision text).
    const first = `original report.${IMAGE_DELIMITER}${PNG_URL}`;
    await extractFeedbackImages(first, 't-a2b');
    const bump = `same title, new screenshot.${IMAGE_DELIMITER}${JPG_URL}`;
    const r = await extractFeedbackImages(bump, 't-a2b');

    expect(r.description).toContain('[screenshot 2: t-a2b/2.jpg]');
    const png = await fs.readFile(path.join(ROOT, 't-a2b', '1.png'));
    expect(png.equals(Buffer.from(PNG_B64, 'base64'))).toBe(true); // untouched
    const jpg = await fs.readFile(path.join(ROOT, 't-a2b', '2.jpg'));
    expect(jpg.equals(Buffer.from(JPG_B64, 'base64'))).toBe(true);
  });

  it('passes a delimiter-free description through untouched (no IO)', async () => {
    const r = await extractFeedbackImages('plain text, no images', 't-a3');
    expect(r.description).toBe('plain text, no images');
    expect(r.images).toEqual([]);
  });

  it('still strips the base64 when every blob is malformed — a bounded description outranks the images', async () => {
    const packed = `bad blob.${IMAGE_DELIMITER}data:image/png;base64,`;
    const r = await extractFeedbackImages(packed, 't-a4');
    expect(r.description).toBe('bad blob.');
    expect(r.images).toEqual([]);
  });

  it('rejects an oversized blob BEFORE decoding it (pre-decode length guard)', async () => {
    // base64 inflates ~4/3: a string longer than ceil(8MB/3)*4 decodes to >8MB.
    // The guard must trip without ever allocating the decoded buffer.
    const huge = 'A'.repeat(Math.ceil((8 * 1024 * 1024) / 3) * 4 + 4);
    const packed = `big blob.${IMAGE_DELIMITER}data:image/png;base64,${huge}`;
    const r = await extractFeedbackImages(packed, 't-a5');
    expect(r.description).toBe('big blob.');
    expect(r.images).toEqual([]);
    await expect(fs.readdir(path.join(ROOT, 't-a5'))).resolves.toEqual([]);
  });

  it('stops storing NEW files once the ticket dir hits the per-ticket cap (still strips)', async () => {
    // Fill t-a6 with MAX_FILES_PER_TICKET (25) pre-existing files, then append
    // a NEW blob: it must be skipped, the description still stripped, and the
    // pre-existing files untouched (review N2).
    const dir = path.join(ROOT, 't-a6');
    await fs.mkdir(dir, { recursive: true });
    for (let i = 1; i <= 25; i++) {
      await fs.writeFile(path.join(dir, `${i}.png`), Buffer.from(PNG_B64, 'base64'));
    }
    const packed = `capped.${IMAGE_DELIMITER}${JPG_URL}`;
    const r = await extractFeedbackImages(packed, 't-a6');
    expect(r.description).toBe('capped.');
    expect(r.images).toEqual([]);
    expect((await fs.readdir(dir)).filter((f) => !f.endsWith('.desc.txt')).length).toBe(25);
  });

  it('a MULTI-blob call on a capped dir leaks nothing past the cap (reviewer F1)', async () => {
    // Regression: after a cap-skip the index counter kept climbing within the
    // same call, so blobs 2..N on a full dir were stored at 26, 27, … past the
    // cap. Fill 25 files, append TWO new blobs in ONE call: both skipped, the
    // description still stripped, the dir untouched.
    const dir = path.join(ROOT, 't-a6b');
    await fs.mkdir(dir, { recursive: true });
    for (let i = 1; i <= 25; i++) {
      await fs.writeFile(path.join(dir, `${i}.png`), Buffer.from(PNG_B64, 'base64'));
    }
    const packed = `capped multi.${IMAGE_DELIMITER}${JPG_URL}\n${JPG_URL.replace('AARCAABAAED', 'AARCAACAAED')}`;
    const r = await extractFeedbackImages(packed, 't-a6b');
    expect(r.description).toBe('capped multi.');
    expect(r.images).toEqual([]);
    expect((await fs.readdir(dir)).filter((f) => !f.endsWith('.desc.txt')).length).toBe(25);
  });

  it('pure helpers: stripImagesSection cuts the packed section; refs parse; traversal is refused', () => {
    const packed = `hello.${IMAGE_DELIMITER}${PNG_URL}`;
    expect(stripImagesSection(packed)).toBe('hello.');
    expect(stripImagesSection('no delimiter')).toBe('no delimiter');
    expect(parseScreenshotRefs('t\n\n[screenshot 1: t-1/1.png]\n[screenshot 2: t-1/2.jpg]'))
      .toEqual([{ index: 1, relPath: 't-1/1.png' }, { index: 2, relPath: 't-1/2.jpg' }]);
    expect(resolveScreenshotPath('../../etc/passwd')).toBeNull();
    expect(resolveScreenshotPath('t-a1/1.png')).toBe(path.join(ROOT, 't-a1', '1.png'));
  });
});

// ── (b) dispatch briefs: vision text inlined, base64 never ────────────────────

describe('dispatch briefs — (b) cached vision text inlined, base64 never carried', () => {
  const TICKET = {
    id: 't-b1',
    type: 'bug_report',
    title: 'Attach button dead',
    description: 'The paperclip is disabled.',
    priority: 3,
    source: 'user',
  };

  it('single-ticket brief carries "Screenshot N (vision): …", describes ONCE EVER (sidecar cache)', async () => {
    // Stage the ticket exactly as the creation path leaves it: bytes on disk,
    // reference lines in the description.
    const packed = `The paperclip is disabled.${IMAGE_DELIMITER}${PNG_URL}`;
    const { description } = await extractFeedbackImages(packed, 't-b1');
    const ticket = { ...TICKET, description };

    expect(await dispatchTicketToLane(ticket)).toBe('sent');
    const brief = mockSendChatMessage.mock.calls[0][0].content;
    expect(brief).toContain(`Screenshot 1 (vision): ${VISION_TEXT}`);
    expect(brief).toContain('[screenshot 1: t-b1/1.png]'); // the human-meaningful ref stays
    expect(brief).not.toContain('---IMAGES---');
    expect(brief).not.toContain(PNG_B64.slice(0, 48));
    expect(mockDescribe).toHaveBeenCalledTimes(1);

    // The cache sidecar lands next to the image…
    await expect(fs.readFile(path.join(ROOT, 't-b1', '1.png.desc.txt'), 'utf8')).resolves.toContain('greyed-out attach button');

    // …so a second dispatch describes ZERO times and still inlines the text.
    jest.clearAllMocks();
    mockPrisma.crossModelChat.findUnique.mockResolvedValue({ userId: 'owner-1' });
    mockRedisSet.mockResolvedValue('OK');
    mockRedisIncr.mockResolvedValue(1);
    mockSendChatMessage.mockResolvedValue({ queued: true, chatId: 'lane-1' });
    expect(await dispatchTicketToLane(ticket)).toBe('sent');
    expect(mockDescribe).not.toHaveBeenCalled();
    expect(mockSendChatMessage.mock.calls[0][0].content).toContain(`Screenshot 1 (vision): ${VISION_TEXT}`);
  });

  it('batch brief inlines vision text inside its "--- ticket N/N ---" block, never base64', async () => {
    const packed = `Batch shot.${IMAGE_DELIMITER}${PNG_URL}`;
    const { description } = await extractFeedbackImages(packed, 't-b2');
    mockPrisma.userFeatureRequest.findMany.mockResolvedValue([
      { id: 't-b2', type: 'bug_report', title: 'Batch ticket', description, priority: 2, source: 'user', context: {}, userId: 'owner-1' }, // the lane owner's ticket (owner-only autonomy, audit 2026-10-08 F3)
    ]);

    const r = await drainOpenTicketsToLane();
    expect(r).toEqual({ result: 'sent', batched: 1 });
    const brief = mockSendChatMessage.mock.calls[0][0].content;
    expect(brief).toContain('--- ticket 1/1 ---');
    expect(brief).toContain(`Screenshot 1 (vision): ${VISION_TEXT}`);
    expect(brief).not.toContain('---IMAGES---');
    expect(brief).not.toContain(PNG_B64.slice(0, 48));
  });

  it('heals a LEGACY still-packed description at dispatch: row updated to refs, brief stripped', async () => {
    const packed = `Legacy shot.${IMAGE_DELIMITER}${PNG_URL}`;
    expect(await dispatchTicketToLane({ ...TICKET, id: 't-b3', description: packed })).toBe('sent');

    // First-sighting extraction: bytes on disk, the stored row swapped to refs.
    expect(mockPrisma.userFeatureRequest.update).toHaveBeenCalledWith({
      where: { id: 't-b3' },
      data: { description: expect.stringContaining('[screenshot 1: t-b3/1.png]') },
    });
    const updateArg = mockPrisma.userFeatureRequest.update.mock.calls[0][0].data.description;
    expect(updateArg).not.toContain('base64');

    const brief = mockSendChatMessage.mock.calls[0][0].content;
    expect(brief).toContain(`Screenshot 1 (vision): ${VISION_TEXT}`);
    expect(brief).not.toContain('---IMAGES---');
    expect(brief).not.toContain(PNG_B64.slice(0, 48));
  });

  it('caps vision-described screenshots at 3 per brief and each description at ~800 chars', async () => {
    const dir = path.join(ROOT, 't-cap');
    await fs.mkdir(dir, { recursive: true });
    for (let i = 1; i <= 5; i++) await fs.writeFile(path.join(dir, `${i}.png`), Buffer.from(PNG_B64, 'base64'));
    mockDescribe.mockImplementation(async () => 'y'.repeat(2000));

    const description = [
      'five shots',
      '[screenshot 1: t-cap/1.png]', '[screenshot 2: t-cap/2.png]', '[screenshot 3: t-cap/3.png]',
      '[screenshot 4: t-cap/4.png]', '[screenshot 5: t-cap/5.png]',
    ].join('\n');
    const lines = await renderScreenshotLines(description);
    expect(lines).toHaveLength(3);
    expect(mockDescribe).toHaveBeenCalledTimes(3);
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual('Screenshot 5 (vision): '.length + 800);
    }
  });
});

// ── (c) vision failure degrades to the reference line ────────────────────────

describe('dispatch briefs — (c) vision failure degrades, never fails the dispatch', () => {
  const TICKET = {
    id: 't-c1',
    type: 'bug_report',
    title: 'Degrade case',
    description: 'desc',
    priority: 1,
    source: 'user',
  };

  it('a throwing vision hop degrades to the file-reference line; no cache written', async () => {
    mockDescribe.mockRejectedValue(new Error('vision hop down'));
    const packed = `Degrade shot.${IMAGE_DELIMITER}${PNG_URL}`;
    const { description } = await extractFeedbackImages(packed, 't-c1');

    expect(await dispatchTicketToLane({ ...TICKET, description })).toBe('sent');
    const brief = mockSendChatMessage.mock.calls[0][0].content;
    expect(brief).toContain('Screenshot 1: t-c1/1.png (image on file — vision description unavailable)');
    expect(brief).not.toContain('(vision)');
    expect(brief).not.toContain(PNG_B64.slice(0, 48));
    // No sidecar on failure — a later healthy dispatch can still describe it.
    await expect(fs.stat(path.join(ROOT, 't-c1', '1.png.desc.txt'))).rejects.toThrow();
  });

  it('a missing image file (multi-instance / cleaned disk) degrades the same way', async () => {
    const description = 'Text.\n\n[screenshot 1: t-c2/1.png]';
    expect(await dispatchTicketToLane({ ...TICKET, id: 't-c2', description })).toBe('sent');
    const brief = mockSendChatMessage.mock.calls[0][0].content;
    expect(brief).toContain('Screenshot 1: t-c2/1.png (image on file — vision description unavailable)');
    expect(mockDescribe).not.toHaveBeenCalled(); // nothing to describe — file never existed
  });
});
