/**
 * Regression tests for feedback 32bdde10: user-attached images in a coding
 * session must land on the session filesystem (`.digby/session/attachments/`,
 * git-ignored) so the agent's file/shell tools can place them into the repo —
 * previously the bytes lived only as transient vision content + a Redis TTL
 * blob, and no path existed on the container side.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  stageSessionImages, buildAttachmentsNote, stageAndDescribe, sanitizeAttachmentName,
  stageSessionFiles, buildFilesNote, stageFilesAndDescribe,
} from './attachments.service';
import type { ChatImage } from './chat-images';
import type { SessionFilePayload } from './chat-files';

// A minimal real PNG (8-byte signature + IHDR start) — arbitrary bytes work
// here (magic-byte validation happens upstream in chat-images.validateImages).
const PNG = Buffer.from('89504e470d0a1a0a0000000d494844520000000100000001080600000 01f15c489'.replace(' ', ''), 'hex');
const PNG_B64 = PNG.toString('base64');

const img = (name: string | undefined, mediaType = 'image/png', data = PNG_B64): ChatImage =>
  ({ mediaType, data, ...(name ? { name } : {}) });

// A plain-text payload for the 7f546b03 file staging (no magic-byte validation
// for files — any bytes are legal).
const TXT = Buffer.from('name,role\nada,eng\n');
const TXT_B64 = TXT.toString('base64');

const file = (name: string | undefined, mediaType = 'text/plain', data = TXT_B64): SessionFilePayload =>
  ({ mediaType, data, ...(name ? { name } : {}) });

async function tmp(): Promise<string> { return fs.mkdtemp(path.join(os.tmpdir(), 'digby-att-')); }

describe('stageSessionImages', () => {
  test('writes decoded bytes into .digby/session/attachments with index-prefixed names', async () => {
    const wt = await tmp();
    const staged = await stageSessionImages(wt, [img('brand.png'), img('hero shot.png')]);
    expect(staged).toHaveLength(2);
    expect(staged[0].name).toBe('01-brand.png');
    expect(staged[1].name).toBe('02-hero shot.png');
    for (const s of staged) {
      expect(s.relPath).toBe(path.join('.digby', 'session', 'attachments', s.name));
      expect(s.path).toBe(path.join(wt, s.relPath));
      expect(s.bytes).toBe(PNG.length);
      const onDisk = await fs.readFile(s.path);
      expect(onDisk.equals(PNG)).toBe(true);
    }
    // scratch dir is git-ignored (same wildcard pattern as plan.service)
    expect(await fs.readFile(path.join(wt, '.digby', 'session', '.gitignore'), 'utf8')).toContain('*');
    await fs.rm(wt, { recursive: true, force: true });
  });

  test('sanitizes hostile/traversal names — nothing escapes the attachments dir', async () => {
    const wt = await tmp();
    const staged = await stageSessionImages(wt, [img('../../etc/passwd'), img('..\\..\\evil.png')]);
    for (const s of staged) {
      expect(s.name).not.toContain('..');
      expect(s.name).not.toMatch(/[\\/]/);
      expect(path.dirname(s.path)).toBe(path.join(wt, '.digby', 'session', 'attachments'));
    }
    await fs.rm(wt, { recursive: true, force: true });
  });

  test('unnamed images get a type-correct fallback; wrong extensions are coerced', async () => {
    expect(sanitizeAttachmentName(undefined, 'image/png', 0)).toBe('01-image.png');
    expect(sanitizeAttachmentName('photo.txt', 'image/jpeg', 1)).toBe('02-photo.txt.jpg');
    expect(sanitizeAttachmentName('.hidden', 'image/png', 2)).toBe('03-_hidden.png');
  });

  test('idempotent re-staging (at-least-once run claim): same content reuses the file', async () => {
    const wt = await tmp();
    const first = await stageSessionImages(wt, [img('logo.png')]);
    const second = await stageSessionImages(wt, [img('logo.png')]);
    expect(second[0].name).toBe(first[0].name);
    expect(await fs.readdir(path.dirname(first[0].path))).toHaveLength(1);
    await fs.rm(wt, { recursive: true, force: true });
  });

  test('same name with different content (later steer batch) never clobbers — gets a suffix', async () => {
    const wt = await tmp();
    const other = Buffer.from('89504e470d0a1a0a0000000d494844520000000200000002080600000', 'hex');
    const first = await stageSessionImages(wt, [img('logo.png')]);
    const second = await stageSessionImages(wt, [{ mediaType: 'image/png', data: other.toString('base64'), name: 'logo.png' }]);
    expect(second[0].name).toBe('01-logo-2.png');
    // original untouched
    expect((await fs.readFile(first[0].path)).equals(PNG)).toBe(true);
    await fs.rm(wt, { recursive: true, force: true });
  });

  test('same name AND same size but different bytes still gets a suffix (no size-only clobber)', async () => {
    const wt = await tmp();
    const sameSize = Buffer.from(PNG);
    sameSize[sameSize.length - 1] ^= 0xff;
    const first = await stageSessionImages(wt, [img('logo.png')]);
    const second = await stageSessionImages(wt, [{ mediaType: 'image/png', data: sameSize.toString('base64'), name: 'logo.png' }]);
    expect(second[0].name).toBe('01-logo-2.png');
    expect((await fs.readFile(first[0].path)).equals(PNG)).toBe(true);
    await fs.rm(wt, { recursive: true, force: true });
  });

  test('empty input is a no-op (no dir created)', async () => {
    const wt = await tmp();
    expect(await stageSessionImages(wt, [])).toEqual([]);
    await expect(fs.access(path.join(wt, '.digby'))).rejects.toThrow();
    await fs.rm(wt, { recursive: true, force: true });
  });
});

describe('buildAttachmentsNote', () => {
  test("is '' when nothing staged, else lists paths + usage instruction", async () => {
    expect(buildAttachmentsNote([])).toBe('');
    const wt = await tmp();
    const staged = await stageSessionImages(wt, [img('brand.png')]);
    const note = buildAttachmentsNote(staged);
    expect(note).toContain('[ATTACHMENTS — saved to the session filesystem]');
    expect(note).toContain(path.join('.digby', 'session', 'attachments', '01-brand.png'));
    expect(note).toContain('image/png');
    expect(note).toContain('git-ignored');
    await fs.rm(wt, { recursive: true, force: true });
  });
});

describe('stageAndDescribe (the best-effort executor seam)', () => {
  test('stages + returns the note', async () => {
    const wt = await tmp();
    const { staged, note } = await stageAndDescribe(wt, [img('a.png')], 'test');
    expect(staged).toHaveLength(1);
    expect(note).toContain('01-a.png');
    await fs.rm(wt, { recursive: true, force: true });
  });

  test('staging failure degrades to empty (never throws — the run must continue)', async () => {
    const wt = await tmp();
    const blocker = path.join(wt, 'blocker');
    await fs.writeFile(blocker, 'not a dir');
    const { staged, note } = await stageAndDescribe(path.join(blocker, 'sub'), [img('a.png')], 'test');
    expect(staged).toEqual([]);
    expect(note).toBe('');
    await fs.rm(wt, { recursive: true, force: true });
  });
});

/* ====================================================================
 * Feedback 7f546b03 — the same staging seam generalized to ALL file types.
 * ==================================================================== */
describe('stageSessionFiles', () => {
  test('a text file keeps its REAL name + extension and its exact bytes', async () => {
    const wt = await tmp();
    const staged = await stageSessionFiles(wt, [file('allin-people.txt')]);
    expect(staged).toHaveLength(1);
    expect(staged[0].name).toBe('01-allin-people.txt');
    expect(staged[0].mediaType).toBe('text/plain');
    expect(staged[0].bytes).toBe(TXT.length);
    expect(staged[0].relPath).toBe(path.join('.digby', 'session', 'attachments', '01-allin-people.txt'));
    expect((await fs.readFile(staged[0].path)).equals(TXT)).toBe(true);
    // scratch dir is git-ignored (same wildcard pattern as plan.service)
    expect(await fs.readFile(path.join(wt, '.digby', 'session', '.gitignore'), 'utf8')).toContain('*');
    await fs.rm(wt, { recursive: true, force: true });
  });

  test('an IMAGE mediaType still coerces the extension to the sniff-validated type', async () => {
    const wt = await tmp();
    const staged = await stageSessionFiles(wt, [file('photo.txt', 'image/png', PNG_B64)]);
    expect(staged[0].name).toBe('01-photo.txt.png');
    await fs.rm(wt, { recursive: true, force: true });
  });

  test('unnamed files fall back to "file"; hostile/traversal names stay inside the dir', async () => {
    const wt = await tmp();
    const staged = await stageSessionFiles(wt, [file(undefined), file('../../etc/passwd.csv', 'text/csv')]);
    expect(staged[0].name).toBe('01-file');
    expect(staged[1].name).toBe('02-passwd.csv');
    for (const s of staged) {
      expect(s.name).not.toContain('..');
      expect(s.name).not.toMatch(/[\\/]/);
      expect(path.dirname(s.path)).toBe(path.join(wt, '.digby', 'session', 'attachments'));
    }
    await fs.rm(wt, { recursive: true, force: true });
  });

  test('same name with different content (later steer batch) never clobbers — gets a -2 suffix', async () => {
    const wt = await tmp();
    const other = Buffer.from('x,y\n1,2\n');
    const first = await stageSessionFiles(wt, [file('data.csv', 'text/csv')]);
    const second = await stageSessionFiles(wt, [file('data.csv', 'text/csv', other.toString('base64'))]);
    expect(second[0].name).toBe('01-data-2.csv');
    // original untouched
    expect((await fs.readFile(first[0].path)).equals(TXT)).toBe(true);
    await fs.rm(wt, { recursive: true, force: true });
  });

  test('an EXTENSIONLESS name still suffixes on collision (no stuck same-name loop)', async () => {
    const wt = await tmp();
    await stageSessionFiles(wt, [file('Makefile', 'text/plain')]);
    const second = await stageSessionFiles(wt, [file('Makefile', 'text/plain', Buffer.from('other').toString('base64'))]);
    expect(second[0].name).toBe('01-Makefile-2');
    await fs.rm(wt, { recursive: true, force: true });
  });

  test('idempotent re-staging (at-least-once run claim): same name + same bytes reuses the file', async () => {
    const wt = await tmp();
    const first = await stageSessionFiles(wt, [file('data.csv', 'text/csv')]);
    const second = await stageSessionFiles(wt, [file('data.csv', 'text/csv')]);
    expect(second[0].name).toBe(first[0].name);
    expect(await fs.readdir(path.dirname(first[0].path))).toHaveLength(1);
    await fs.rm(wt, { recursive: true, force: true });
  });

  test('empty input is a no-op (no dir created)', async () => {
    const wt = await tmp();
    expect(await stageSessionFiles(wt, [])).toEqual([]);
    await expect(fs.access(path.join(wt, '.digby'))).rejects.toThrow();
    await fs.rm(wt, { recursive: true, force: true });
  });
});

describe('buildFilesNote', () => {
  test("is '' when nothing staged, else lists relPath/mediaType/size and says file(s) — never 'image'/'vision'", async () => {
    expect(buildFilesNote([])).toBe('');
    const wt = await tmp();
    const staged = await stageSessionFiles(wt, [file('allin-people.txt')]);
    const note = buildFilesNote(staged);
    expect(note).toContain('The user attached 1 file to this message');
    expect(note).toContain(path.join('.digby', 'session', 'attachments', '01-allin-people.txt'));
    expect(note).toContain('text/plain');
    expect(note).toContain('KB');
    expect(note).toContain('git-ignored');
    expect(note).not.toContain('image');
    expect(note).not.toContain('vision');
    await fs.rm(wt, { recursive: true, force: true });
  });

  test('pluralizes for a batch', async () => {
    const wt = await tmp();
    const staged = await stageSessionFiles(wt, [file('a.txt'), file('b.csv', 'text/csv')]);
    const note = buildFilesNote(staged);
    expect(note).toContain('The user attached 2 files to this message');
    await fs.rm(wt, { recursive: true, force: true });
  });
});

describe('stageFilesAndDescribe (the best-effort executor seam)', () => {
  test('stages + returns the note', async () => {
    const wt = await tmp();
    const { staged, note } = await stageFilesAndDescribe(wt, [file('a.txt')], 'test');
    expect(staged).toHaveLength(1);
    expect(note).toContain('01-a.txt');
    await fs.rm(wt, { recursive: true, force: true });
  });

  test('staging failure degrades to empty (never throws — the run must continue)', async () => {
    const wt = await tmp();
    const blocker = path.join(wt, 'blocker');
    await fs.writeFile(blocker, 'not a dir');
    const { staged, note } = await stageFilesAndDescribe(path.join(blocker, 'sub'), [file('a.txt')], 'test');
    expect(staged).toEqual([]);
    expect(note).toBe('');
    await fs.rm(wt, { recursive: true, force: true });
  });
});

/* ====================================================================
 * Feedback 7b5ee09b — an upload-time text extract stages as a readable
 * `<name>.extracted.txt` sibling (the container has no pdftotext/mammoth),
 * and the note points the agent at it. No extract → byte-identical behavior.
 * ==================================================================== */
describe('staged text extracts (7b5ee09b)', () => {
  const pdfFile = (name: string, data: string, extractedText?: string): SessionFilePayload =>
    ({ name, mediaType: 'application/pdf', data, ...(extractedText !== undefined ? { extractedText } : {}) });

  test('a payload with extractedText writes the .extracted.txt sibling keyed to the staged name', async () => {
    const wt = await tmp();
    const staged = await stageSessionFiles(wt, [pdfFile('report.pdf', TXT_B64, 'page one text')]);
    expect(staged).toHaveLength(1);
    expect(staged[0].name).toBe('01-report.pdf');
    expect(staged[0].extractRelPath).toBe(path.join('.digby', 'session', 'attachments', '01-report.pdf.extracted.txt'));
    const sibling = path.join(wt, '.digby', 'session', 'attachments', '01-report.pdf.extracted.txt');
    expect(await fs.readFile(sibling, 'utf8')).toBe('page one text');
    // the binary itself staged untouched
    expect((await fs.readFile(staged[0].path)).equals(TXT)).toBe(true);
    await fs.rm(wt, { recursive: true, force: true });
  });

  test('buildFilesNote points the agent at the extract with a read_file hint', async () => {
    const wt = await tmp();
    const staged = await stageSessionFiles(wt, [pdfFile('report.pdf', TXT_B64, 'page one text')]);
    const note = buildFilesNote(staged);
    expect(note).toContain('01-report.pdf.extracted.txt');
    expect(note).toContain('read_file');
    expect(note).toContain('text extract saved to');
    await fs.rm(wt, { recursive: true, force: true });
  });

  test('a file WITHOUT an extract stages exactly as before — no sibling, no note line, no key', async () => {
    const wt = await tmp();
    const staged = await stageSessionFiles(wt, [file('data.csv', 'text/csv')]);
    expect(staged[0].extractRelPath).toBeUndefined();
    expect('extractRelPath' in staged[0]).toBe(false);
    const dirEntries = await fs.readdir(path.join(wt, '.digby', 'session', 'attachments'));
    expect(dirEntries).toEqual(['01-data.csv']);
    const note = buildFilesNote(staged);
    expect(note).not.toContain('extract');
    await fs.rm(wt, { recursive: true, force: true });
  });

  test('a collision-suffixed binary gets the matching suffixed extract sibling (pairing stays obvious)', async () => {
    const wt = await tmp();
    const other = Buffer.from('x,y\n1,2\n');
    await stageSessionFiles(wt, [pdfFile('report.pdf', TXT_B64, 'first extract')]);
    const second = await stageSessionFiles(wt, [pdfFile('report.pdf', other.toString('base64'), 'second extract')]);
    expect(second[0].name).toBe('01-report-2.pdf');
    expect(second[0].extractRelPath).toBe(path.join('.digby', 'session', 'attachments', '01-report-2.pdf.extracted.txt'));
    const sibling = path.join(wt, '.digby', 'session', 'attachments', '01-report-2.pdf.extracted.txt');
    expect(await fs.readFile(sibling, 'utf8')).toBe('second extract');
    // the first batch's files are untouched
    const firstSibling = path.join(wt, '.digby', 'session', 'attachments', '01-report.pdf.extracted.txt');
    expect(await fs.readFile(firstSibling, 'utf8')).toBe('first extract');
    await fs.rm(wt, { recursive: true, force: true });
  });

  test('stageFilesAndDescribe surfaces the extract pointer in the returned note', async () => {
    const wt = await tmp();
    const { staged, note } = await stageFilesAndDescribe(wt, [pdfFile('report.pdf', TXT_B64, 'page one text')], 'test');
    expect(staged[0].extractRelPath).toBeDefined();
    expect(note).toContain('01-report.pdf.extracted.txt');
    await fs.rm(wt, { recursive: true, force: true });
  });
});
