/**
 * Attachment save/load — Redis-backed, cross-instance (2026-08-16).
 *
 * Pins the fix for the silent-attachment-loss class: uploads used to live in
 * per-instance /tmp, so the /stream consumer on the other web instance loaded
 * null and the send proceeded WITHOUT the file. Now: Redis primary with the
 * 15-min TTL, /tmp only as a same-instance fallback when Redis is down.
 */

const mockRedis = {
  set: jest.fn(),
  get: jest.fn(),
};
jest.mock('../../config/redis', () => ({ __esModule: true, default: mockRedis }));
jest.mock('../../config/database', () => ({ __esModule: true, default: {} }));
jest.mock('../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../middleware/auth', () => ({ AuthRequest: {} }));
jest.mock('./ingestion.service', () => ({ processDocument: jest.fn() }));
jest.mock('./pdf-extract', () => ({ extractPdfText: jest.fn() }));

import fs from 'fs';
import { saveAttachment, loadAttachment, Attachment } from './upload.controller';

const ATT: Attachment = { type: 'document', filename: 'a.txt', mimeType: 'text/plain', extractedText: 'hello' };

beforeEach(() => {
  jest.clearAllMocks();
  mockRedis.set.mockResolvedValue('OK');
  mockRedis.get.mockResolvedValue(null);
});

describe('saveAttachment', () => {
  it('stores JSON in Redis under cm:upload:<id> with the 15-min TTL', async () => {
    await saveAttachment('u1', ATT);
    expect(mockRedis.set).toHaveBeenCalledWith('cm:upload:u1', JSON.stringify(ATT), { EX: 900 });
  });

  it('falls back to /tmp when Redis is down (degrades to same-instance, never fails the upload)', async () => {
    mockRedis.set.mockRejectedValue(new Error('redis down'));
    const write = jest.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
    await expect(saveAttachment('u2', ATT)).resolves.toBeUndefined();
    expect(write).toHaveBeenCalledWith('/tmp/cm_upload_u2.json', JSON.stringify(ATT));
    write.mockRestore();
  });
});

describe('loadAttachment', () => {
  it('loads from Redis (cross-instance path)', async () => {
    mockRedis.get.mockResolvedValue(JSON.stringify(ATT));
    expect(await loadAttachment('u1')).toEqual(ATT);
    expect(mockRedis.get).toHaveBeenCalledWith('cm:upload:u1');
  });

  it('falls back to /tmp when Redis misses or errors', async () => {
    mockRedis.get.mockRejectedValue(new Error('redis down'));
    const exists = jest.spyOn(fs, 'existsSync').mockReturnValue(true);
    const read = jest.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify(ATT) as any);
    expect(await loadAttachment('u3')).toEqual(ATT);
    exists.mockRestore();
    read.mockRestore();
  });

  it('returns null when the attachment is nowhere (caller logs a warning — never silent)', async () => {
    const exists = jest.spyOn(fs, 'existsSync').mockReturnValue(false);
    expect(await loadAttachment('u4')).toBeNull();
    exists.mockRestore();
  });
});


// ─── Ticket 6c050917: audio uploads + the audio combine branch ───────────────
// processUpload and combineAttachments are imported lazily in production and
// need a live multer request; the pure decision layer is pinned instead.

describe('combineAttachments — audio branch (ticket 6c050917)', () => {
  // Re-import the module surface the lazy paths use.
  let combine: typeof import('./upload.controller').combineAttachments;
  beforeAll(() => {
    combine = require('./upload.controller').combineAttachments;
  });

  const WAV = Buffer.concat([Buffer.from('52494646', 'hex'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(8, 1)]);
  const audio = (filename: string, mimeType = 'audio/wav') =>
    ({ type: 'audio' as const, filename, mimeType, base64: WAV.toString('base64') });

  it('an audio-only send produces a composite audio attachment (was undefined before the branch)', () => {
    const out = combine([audio('kokoro_af_heart_all4.wav')]);
    expect(out).toBeDefined();
    expect(out!.type).toBe('audio');
    expect(out!.mimeType).toBe('audio/wav');
    expect(out!.base64).toBe(WAV.toString('base64'));
    // The agent-facing pointer note names the clip.
    expect(out!.extractedText).toContain('kokoro_af_heart_all4.wav');
    expect(out!.extractedText).toContain('no transcription available');
  });

  it('multiple audio clips keep the first primary and the rest ride additionalFiles (every uploadId keeps its chip)', () => {
    const out = combine([audio('a.wav'), audio('b.wav'), audio('c.mp3', 'audio/mpeg')]);
    expect(out!.type).toBe('audio');
    expect(out!.filename).toBe('a.wav, b.wav, c.mp3');
    expect(out!.additionalFiles).toHaveLength(2);
    expect(out!.additionalFiles!.map(f => f.filename)).toEqual(['b.wav', 'c.mp3']);
  });

  it('audio never outranks an image in a mixed send (the pre-existing precedence is untouched)', () => {
    const out = combine([
      audio('clip.wav'),
      { type: 'image', filename: 'p.png', mimeType: 'image/png', base64: Buffer.from('x').toString('base64') },
    ]);
    expect(out!.type).toBe('image');
    expect(out!.filename).toBe('p.png');
  });
});
