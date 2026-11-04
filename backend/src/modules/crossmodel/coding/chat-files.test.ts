/**
 * Chat FILE attachments (feedback 7f546b03) — the validation gauntlet every
 * resolved upload payload must survive before it can ride a coding run:
 * count cap, base64 syntax, per-file + total decoded-size caps, loud specific
 * errors (never silently strip). Unlike chat-images there is NO mime
 * whitelist or magic-byte sniff — any file type is legal (the bytes stage to
 * disk for the agent's tools, never to a model API).
 */

import {
  SessionFilePayload, MAX_FILES, MAX_FILE_BYTES, MAX_FILE_TOTAL_BYTES, MAX_FILE_EXTRACT_CHARS, validateFiles,
} from './chat-files';

const TXT = Buffer.from('name,role\nada,eng\n').toString('base64');
const file = (mediaType: string, data: string, name?: string): SessionFilePayload =>
  (name ? { mediaType, data, name } : { mediaType, data });

/** A syntactically valid base64 payload of ~`decodedBytes` decoded bytes.
 *  'A' is base64 for zero-bits, so the fill keeps the alphabet. */
function bigPayload(decodedBytes: number): string {
  const chars = Math.ceil(decodedBytes / 3) * 4; // 3 bytes → 4 chars, no padding
  return 'A'.repeat(chars);
}

describe('validateFiles — happy path', () => {
  test('accepts arbitrary media types (no whitelist) and keeps name/mediaType/data', () => {
    const r = validateFiles([
      file('text/csv', TXT, 'allin-people.csv'),
      file('application/vnd.openxmlformats-officedocument.wordprocessingml.document', TXT, 'brief.docx'),
      file('application/octet-stream', TXT),
    ]);
    expect(r).toEqual({
      ok: true,
      files: [
        { mediaType: 'text/csv', data: TXT, name: 'allin-people.csv' },
        { mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', data: TXT, name: 'brief.docx' },
        { mediaType: 'application/octet-stream', data: TXT },
      ],
    });
  });

  test('accepts a full batch of MAX_FILES files', () => {
    const r = validateFiles(Array.from({ length: MAX_FILES }, () => ({ mediaType: 'text/plain', data: TXT })));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.files).toHaveLength(MAX_FILES);
  });

  test('absent / null / non-array / empty array all validate to zero files', () => {
    for (const raw of [undefined, null, 'nope', 42, {}, []]) {
      expect(validateFiles(raw)).toEqual({ ok: true, files: [] });
    }
  });

  test('a name over 200 chars is sliced, not rejected', () => {
    const r = validateFiles([{ mediaType: 'text/plain', data: TXT, name: 'x'.repeat(300) }]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.files[0].name).toHaveLength(200);
  });
});

describe('validateFiles — loud rejections', () => {
  test('more than MAX_FILES files', () => {
    const r = validateFiles(Array.from({ length: MAX_FILES + 1 }, () => ({ mediaType: 'text/plain', data: TXT })));
    expect(r).toEqual({ ok: false, error: `At most ${MAX_FILES} files per message.` });
  });

  test('a non-object item is malformed', () => {
    const r = validateFiles(['data.csv']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('malformed');
  });

  test('missing / empty data', () => {
    for (const item of [{ mediaType: 'text/plain' }, { mediaType: 'text/plain', data: '' }]) {
      const r = validateFiles([item]);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain('has no data');
    }
  });

  test('invalid media types: non-string, empty, over 100 chars', () => {
    for (const mediaType of [42, '', '   ', 'x/'.padEnd(101, 'y')]) {
      const r = validateFiles([{ mediaType, data: TXT }]);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain('invalid media type');
    }
  });

  test('a non-string name is invalid', () => {
    const r = validateFiles([{ mediaType: 'text/plain', data: TXT, name: 42 }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('invalid name');
  });

  test('bad base64: wrong length, bad alphabet, or a data: URL', () => {
    for (const data of ['ABC', '!!!!====', `data:text/csv;base64,${TXT}`]) {
      const r = validateFiles([{ mediaType: 'text/csv', data, name: 'd.csv' }]);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain('not valid base64');
    }
  });

  test('per-file oversize names the file + the limit', () => {
    const r = validateFiles([{ mediaType: 'text/csv', data: bigPayload(MAX_FILE_BYTES + 3), name: 'huge.csv' }]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('"huge.csv"');
      expect(r.error).toContain(`per-file limit is ${MAX_FILE_BYTES / 1024 / 1024} MB`);
    }
  });

  test('total oversize across individually-legal files', () => {
    const half = bigPayload(Math.floor(MAX_FILE_TOTAL_BYTES / 2) + 3);
    const r = validateFiles([
      { mediaType: 'text/csv', data: half, name: 'a.csv' },
      { mediaType: 'text/csv', data: half, name: 'b.csv' },
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(`total more than ${MAX_FILE_TOTAL_BYTES / 1024 / 1024} MB`);
  });

  test('the error labels the file by name when it has one', () => {
    const r = validateFiles([{ mediaType: 'text/plain', data: '', name: 'broken.txt' }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('"broken.txt"');
  });
});

/* ====================================================================
 * Feedback 7b5ee09b — the upload-time text extract rides the payload
 * (auxiliary: capped, never a failure condition; a non-string extract is
 * malformed and rejects loudly).
 * ==================================================================== */
describe('validateFiles — extractedText passthrough (7b5ee09b)', () => {
  test('a string extract passes through alongside name/mediaType/data', () => {
    const r = validateFiles([{ mediaType: 'application/pdf', data: TXT, name: 'report.pdf', extractedText: 'page one text' }]);
    expect(r).toEqual({
      ok: true,
      files: [{ mediaType: 'application/pdf', data: TXT, name: 'report.pdf', extractedText: 'page one text' }],
    });
  });

  test('an over-cap extract is sliced to MAX_FILE_EXTRACT_CHARS, never rejected', () => {
    const r = validateFiles([{ mediaType: 'application/pdf', data: TXT, extractedText: 'x'.repeat(MAX_FILE_EXTRACT_CHARS + 500) }]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.files[0].extractedText).toHaveLength(MAX_FILE_EXTRACT_CHARS);
  });

  test('a payload WITHOUT an extract gains no key (exact-shape contract)', () => {
    const r = validateFiles([{ mediaType: 'text/csv', data: TXT, name: 'd.csv' }]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.files[0]).toEqual({ mediaType: 'text/csv', data: TXT, name: 'd.csv' });
  });

  test('an EMPTY-string extract is dropped, not carried as a pointless key', () => {
    const r = validateFiles([{ mediaType: 'application/pdf', data: TXT, extractedText: '' }]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.files[0]).toEqual({ mediaType: 'application/pdf', data: TXT });
  });

  test('a non-string extract is malformed — loud reject naming the file', () => {
    for (const extractedText of [42, { text: 'x' }, ['x'], true]) {
      const r = validateFiles([{ mediaType: 'application/pdf', data: TXT, name: 'bad.pdf', extractedText }]);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toContain('"bad.pdf"');
        expect(r.error).toContain('invalid text extract');
      }
    }
  });
});
