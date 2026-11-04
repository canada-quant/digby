/**
 * view_image (2026-10-01) — the coding lane LOOKS at an image through the
 * Image reader seat instead of rebuilding vision from pixels (TB 2.1
 * chess-best-move: a text-only glm-5.3 lead spent ~2 h on glyph template
 * matching and misread the board twice).
 *
 * Pins: magic-byte format detection (an image by its BYTES, never by name),
 * cheap header dimensions, the 6 MB refusal BEFORE any read, the shq()-quoted
 * path in both shell commands, marker-bounded base64 parsing, the success
 * envelope, and every failure line in the coding tools' `Tool view_image
 * failed:` shape. The default answerer is image-describe's
 * answerImageQuestion (mocked here).
 */

const mockAnswerImageQuestion: jest.Mock = jest.fn();
jest.mock('../image-describe', () => ({
  __esModule: true,
  answerImageQuestion: (...a: any[]) => mockAnswerImageQuestion(...a),
}));

import {
  detectImageMime, imageDimensions, mimeFromExtension, runViewImage, viewImageToolDisabled,
  VIEW_IMAGE_MAX_BYTES, VIEW_IMAGE_SCHEMA, VIEW_IMAGE_TOOL, type ViewImageIO,
} from './view-image';

/** The tools.ts quoting helper, verbatim. */
const shq = (s: string): string => `'${String(s).replace(/'/g, `'\\''`)}'`;
const WT = '/app/coding-workspaces/worktrees/sess-1';

// ── Minimal real headers ─────────────────────────────────────────────────────

function png(width: number, height: number, extra = 32): Buffer {
  const b = Buffer.alloc(33 + extra);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}
function gif(width: number, height: number): Buffer {
  const b = Buffer.alloc(16);
  b.write('GIF89a', 0, 'latin1');
  b.writeUInt16LE(width, 6);
  b.writeUInt16LE(height, 8);
  return b;
}
function bmp(width: number, height: number): Buffer {
  const b = Buffer.alloc(54);
  b.write('BM', 0, 'latin1');
  b.writeUInt32LE(54, 2);
  b.writeUInt32LE(40, 14);
  b.writeInt32LE(width, 18);
  b.writeInt32LE(height, 22);
  return b;
}
function webpVp8x(width: number, height: number): Buffer {
  const b = Buffer.alloc(40);
  b.write('RIFF', 0, 'latin1');
  b.writeUInt32LE(32, 4);
  b.write('WEBP', 8, 'latin1');
  b.write('VP8X', 12, 'latin1');
  b.writeUInt32LE(10, 16);
  b.writeUIntLE(width - 1, 24, 3);
  b.writeUIntLE(height - 1, 27, 3);
  return b;
}
function webpVp8l(width: number, height: number): Buffer {
  const b = Buffer.alloc(40);
  b.write('RIFF', 0, 'latin1');
  b.write('WEBP', 8, 'latin1');
  b.write('VP8L', 12, 'latin1');
  b[20] = 0x2f;
  const w = width - 1;
  const h = height - 1;
  // 14-bit width, 14-bit height packed little-endian from bit 0.
  const bits = (w & 0x3fff) | ((h & 0x3fff) << 14);
  b.writeUInt32LE(bits >>> 0, 21);
  return b;
}
function webpVp8(width: number, height: number): Buffer {
  const b = Buffer.alloc(40);
  b.write('RIFF', 0, 'latin1');
  b.write('WEBP', 8, 'latin1');
  b.write('VP8 ', 12, 'latin1');
  Buffer.from([0x9d, 0x01, 0x2a]).copy(b, 23);
  b.writeUInt16LE(width, 26);
  b.writeUInt16LE(height, 28);
  return b;
}
function jpeg(width: number, height: number): Buffer {
  return Buffer.from([
    0xff, 0xd8, // SOI
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, // APP0 (16)
    0xff, 0xc0, 0x00, 0x11, 0x08, (height >> 8) & 0xff, height & 0xff, (width >> 8) & 0xff, width & 0xff, 0x03,
    0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, // SOF0
    0xff, 0xd9,
  ]);
}
function heic(brand: string): Buffer {
  const b = Buffer.alloc(24);
  b.writeUInt32BE(24, 0);
  b.write('ftyp', 4, 'latin1');
  b.write(brand, 8, 'latin1');
  return b;
}

describe('detectImageMime — an image by its BYTES', () => {
  it('recognises PNG, JPEG, GIF, WebP, BMP and HEIC magic numbers', () => {
    expect(detectImageMime(png(8, 8), 'x.png')).toBe('image/png');
    expect(detectImageMime(jpeg(10, 20), 'x.jpg')).toBe('image/jpeg');
    expect(detectImageMime(gif(1, 1), 'x.gif')).toBe('image/gif');
    const gif87 = gif(1, 1); gif87.write('GIF87a', 0, 'latin1');
    expect(detectImageMime(gif87, 'x.gif')).toBe('image/gif');
    expect(detectImageMime(webpVp8x(5, 5), 'x.webp')).toBe('image/webp');
    expect(detectImageMime(bmp(4, 4), 'x.bmp')).toBe('image/bmp');
    expect(detectImageMime(heic('heic'), 'photo.HEIC')).toBe('image/heic');
  });
  it('the bytes win over the name: a PNG named .jpg is a PNG, a text file named .png is nothing', () => {
    expect(detectImageMime(png(8, 8), 'board.jpg')).toBe('image/png');
    expect(detectImageMime(Buffer.from('not an image at all\n'), 'board.png')).toBeNull();
    expect(detectImageMime(Buffer.from('%PDF-1.7\n...'), 'doc.png')).toBeNull();
    expect(detectImageMime(Buffer.from('BM is not a bitmap header, just text that starts with BM'), 'x.bmp')).toBeNull();
    expect(detectImageMime(Buffer.from([0xff]), 'x.jpg')).toBeNull();
  });
  it('a generic HEIF container (mif1) counts only under a .heic/.heif name', () => {
    expect(detectImageMime(heic('mif1'), 'photo.heif')).toBe('image/heif');
    expect(detectImageMime(heic('mif1'), 'clip.mp4')).toBeNull();
    expect(detectImageMime(heic('isom'), 'clip.heic')).toBeNull(); // an mp4 brand
  });
  it('mimeFromExtension reads the name only', () => {
    expect(mimeFromExtension('/app/a.JPEG')).toBe('image/jpeg');
    expect(mimeFromExtension('a.webp')).toBe('image/webp');
    expect(mimeFromExtension('a.txt')).toBeNull();
    expect(mimeFromExtension('')).toBeNull();
  });
});

describe('imageDimensions — cheap header reads, never a decode', () => {
  it('reads PNG, GIF, BMP (negative = top-down), WebP (VP8X / VP8L / VP8) and JPEG (SOF after APP0)', () => {
    expect(imageDimensions(png(640, 480), 'image/png')).toEqual({ width: 640, height: 480 });
    expect(imageDimensions(gif(320, 200), 'image/gif')).toEqual({ width: 320, height: 200 });
    expect(imageDimensions(bmp(100, -50), 'image/bmp')).toEqual({ width: 100, height: 50 });
    expect(imageDimensions(webpVp8x(1920, 1080), 'image/webp')).toEqual({ width: 1920, height: 1080 });
    expect(imageDimensions(webpVp8l(300, 150), 'image/webp')).toEqual({ width: 300, height: 150 });
    expect(imageDimensions(webpVp8(64, 32), 'image/webp')).toEqual({ width: 64, height: 32 });
    expect(imageDimensions(jpeg(1024, 768), 'image/jpeg')).toEqual({ width: 1024, height: 768 });
  });
  it('a truncated header or an unknown type is null, never a throw', () => {
    expect(imageDimensions(png(8, 8).subarray(0, 12), 'image/png')).toBeNull();
    expect(imageDimensions(jpeg(1, 1).subarray(0, 6), 'image/jpeg')).toBeNull();
    expect(imageDimensions(heic('heic'), 'image/heic')).toBeNull();
    expect(imageDimensions(Buffer.alloc(0), 'image/bmp')).toBeNull();
  });
});

// ── Executor ─────────────────────────────────────────────────────────────────

/** A fake session shell: answers the stat probe and the base64 read for one file. */
function fakeShell(file: { path: string; bytes?: Buffer; missing?: boolean; notFile?: boolean; statSize?: number; noise?: string; stderr?: string }) {
  const commands: string[] = [];
  const execShell = jest.fn(async (command: string, cwd?: string, timeoutMs?: number) => {
    commands.push(command);
    expect(cwd).toBe(WT);
    expect(typeof timeoutMs).toBe('number');
    const noise = file.noise ?? '';
    if (command.includes('stat -L -c %s')) {
      if (file.missing) return { stdout: `${noise}__VIEW_IMAGE_MISSING__\n`, stderr: '' };
      if (file.notFile) return { stdout: `${noise}__VIEW_IMAGE_NOT_FILE__\n`, stderr: '' };
      return { stdout: `${noise}__VIEW_IMAGE_SIZE__${file.statSize ?? file.bytes?.length ?? 0}\n`, stderr: '' };
    }
    if (command.includes('base64 -w0')) {
      return { stdout: `${noise}__VIEW_IMAGE_B64_BEGIN__\n${(file.bytes ?? Buffer.alloc(0)).toString('base64')}\n__VIEW_IMAGE_B64_END__\n`, stderr: file.stderr ?? '' };
    }
    throw new Error(`unexpected command: ${command}`);
  });
  return { execShell, commands };
}

const io = (execShell: ViewImageIO['execShell'], answer?: ViewImageIO['answer']): ViewImageIO => ({ execShell, worktree: WT, quote: shq, userId: 'u1', ...(answer ? { answer } : {}) });

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.VIEW_IMAGE_TOOL_DISABLED;
});
afterAll(() => { delete process.env.VIEW_IMAGE_TOOL_DISABLED; });

describe('runViewImage', () => {
  it('reads the bytes through the shell, asks the seat, and returns the labelled answer', async () => {
    const bytes = png(800, 800);
    const { execShell, commands } = fakeShell({ path: '/app/chess_board.png', bytes, noise: 'env.sh says hi\n' });
    const answer = jest.fn(async () => ({ answer: 'a8: black rook; b8: empty; …', model: 'glm-5.3-flash' }));
    const out = await runViewImage(io(execShell, answer), { path: '/app/chess_board.png', question: 'list every piece and its square' });
    expect(out).toBe('[view_image — glm-5.3-flash read /app/chess_board.png (800x800)]\na8: black rook; b8: empty; …');
    expect(commands).toHaveLength(2);
    expect(commands[0]).toContain("stat -L -c %s -- '/app/chess_board.png'");
    expect(commands[1]).toContain("base64 -w0 -- '/app/chess_board.png'");
    expect(answer).toHaveBeenCalledTimes(1);
    const [buf, mime, filename, question, opts] = (answer.mock.calls[0] as unknown) as any[];
    expect(Buffer.compare(buf, bytes)).toBe(0); // byte-exact through base64 + env noise
    expect(mime).toBe('image/png');
    expect(filename).toBe('chess_board.png');
    expect(question).toBe('list every piece and its square');
    expect(opts).toEqual({ userId: 'u1' });
  });

  it('defaults to image-describe answerImageQuestion and passes an empty question through (the seat applies the default)', async () => {
    mockAnswerImageQuestion.mockResolvedValue({ answer: 'A red square.', model: 'cql-litellm:vision' });
    const { execShell } = fakeShell({ path: 'shots/a.gif', bytes: gif(2, 3) });
    const out = await runViewImage({ execShell, worktree: WT, quote: shq }, { path: 'shots/a.gif' });
    expect(out).toBe('[view_image — cql-litellm:vision read shots/a.gif (2x3)]\nA red square.');
    expect(mockAnswerImageQuestion).toHaveBeenCalledWith(expect.any(Buffer), 'image/gif', 'a.gif', '', undefined);
  });

  it('shq()-quotes a hostile path in BOTH commands (no expansion)', async () => {
    const p = "/app/it's $(rm -rf .) `id`.png";
    const { execShell, commands } = fakeShell({ path: p, bytes: png(1, 1) });
    await runViewImage(io(execShell, async () => ({ answer: 'ok', model: 'm' })), { path: p });
    const quoted = shq(p);
    expect(quoted).toBe(`'/app/it'\\''s $(rm -rf .) \`id\`.png'`);
    for (const c of commands) expect(c).toContain(quoted);
    // the raw path never appears unquoted
    for (const c of commands) expect(c.replace(new RegExp(quoted.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '')).not.toContain('$(rm');
  });

  it('refuses a file over 6 MB from the stat alone — the bytes are never read, the seat never called', async () => {
    const { execShell, commands } = fakeShell({ path: '/app/huge.png', statSize: VIEW_IMAGE_MAX_BYTES + 1 });
    const answer = jest.fn();
    const out = await runViewImage(io(execShell, answer as any), { path: '/app/huge.png' });
    expect(out).toMatch(/^Tool view_image failed: \/app\/huge\.png is 6\.0 MB — over the 6\.0 MB view_image limit\. Downscale or crop it/);
    expect(commands).toHaveLength(1);
    expect(answer).not.toHaveBeenCalled();
    // exactly at the limit is fine
    const ok = fakeShell({ path: '/app/edge.png', bytes: Buffer.concat([png(1, 1), Buffer.alloc(VIEW_IMAGE_MAX_BYTES - png(1, 1).length)]) });
    expect(await runViewImage(io(ok.execShell, async () => ({ answer: 'fine', model: 'm' })), { path: '/app/edge.png' })).toMatch(/^\[view_image — m read \/app\/edge\.png/);
  });

  it('refuses a non-image file by its bytes even with an image extension', async () => {
    const { execShell } = fakeShell({ path: '/app/secret.png', bytes: Buffer.from('API_KEY=abc123\n') });
    const answer = jest.fn();
    const out = await runViewImage(io(execShell, answer as any), { path: '/app/secret.png' });
    expect(out).toBe('Tool view_image failed: /app/secret.png has a .png extension but its bytes are not a PNG image — check it with run_command (`file /app/secret.png`).');
    expect(answer).not.toHaveBeenCalled();
    const other = fakeShell({ path: 'notes.txt', bytes: Buffer.from('hello') });
    expect(await runViewImage(io(other.execShell, answer as any), { path: 'notes.txt' })).toMatch(/^Tool view_image failed: notes\.txt is not a supported image \(PNG, JPEG, GIF, WebP, BMP or HEIC/);
  });

  it('missing / not-a-file / empty / mismatched reads fail with the coding-tool failure shape', async () => {
    const missingRel = fakeShell({ path: 'board.png', missing: true });
    expect(await runViewImage(io(missingRel.execShell), { path: 'board.png' })).toMatch(/^Tool view_image failed: no such file: board\.png \(relative paths resolve from the project root — task files often live elsewhere/);
    const missingAbs = fakeShell({ path: '/app/board.png', missing: true });
    expect(await runViewImage(io(missingAbs.execShell), { path: '/app/board.png' })).toBe('Tool view_image failed: no such file: /app/board.png.');
    const dir = fakeShell({ path: '/app', notFile: true });
    expect(await runViewImage(io(dir.execShell), { path: '/app' })).toBe('Tool view_image failed: /app is not a regular file.');
    const empty = fakeShell({ path: '/app/e.png', bytes: Buffer.alloc(0) });
    expect(await runViewImage(io(empty.execShell), { path: '/app/e.png' })).toBe('Tool view_image failed: /app/e.png is empty (0 bytes).');
    const short = fakeShell({ path: '/app/s.png', bytes: png(1, 1), statSize: 9999, stderr: 'base64: read error' });
    expect(await runViewImage(io(short.execShell), { path: '/app/s.png' })).toMatch(/^Tool view_image failed: reading \/app\/s\.png returned \d+ bytes, expected 9999 .*base64: read error/);
  });

  it('a shell that cannot run (container down) is reported, not thrown', async () => {
    const execShell = jest.fn(async () => ({ stdout: '', stderr: 'Isolated execution is temporarily unavailable (the session container is not healthy).' }));
    const out = await runViewImage(io(execShell), { path: '/app/a.png' });
    expect(out).toBe('Tool view_image failed: could not read /app/a.png through the session shell — Isolated execution is temporarily unavailable (the session container is not healthy).');
    const thrower = jest.fn(async () => { throw new Error('docker exec exploded'); });
    expect(await runViewImage(io(thrower), { path: '/app/a.png' })).toBe('Tool view_image failed: docker exec exploded');
  });

  it('a seat that cannot answer (unservable / every provider failed / empty) says the image was NOT seen', async () => {
    const { execShell } = fakeShell({ path: '/app/a.jpg', bytes: jpeg(4, 4) });
    const out = await runViewImage(io(execShell, async () => { throw new Error('Image reader seat: glm-5.3-flash needs the ZAI_API_KEY environment variable (Z.AI), which is not set on this instance'); }), { path: '/app/a.jpg' });
    expect(out).toMatch(/^Tool view_image failed: the Image reader seat could not read \/app\/a\.jpg — Image reader seat: glm-5\.3-flash needs the ZAI_API_KEY/);
    expect(out).toMatch(/The image was NOT seen/);
    const again = fakeShell({ path: '/app/a.jpg', bytes: jpeg(4, 4) });
    expect(await runViewImage(io(again.execShell, async () => ({ answer: '  ', model: 'm' })), { path: '/app/a.jpg' })).toBe('Tool view_image failed: the Image reader seat returned no answer for /app/a.jpg.');
  });

  it('argument + format refusals happen before any shell call', async () => {
    const execShell = jest.fn();
    expect(await runViewImage(io(execShell as any), {})).toMatch(/^Tool view_image failed: a path is required/);
    expect(await runViewImage(io(execShell as any), { path: '   ' })).toMatch(/^Tool view_image failed: a path is required/);
    expect(await runViewImage(io(execShell as any), { path: '/app/logo.svg' })).toMatch(/^Tool view_image failed: \/app\/logo\.svg is an SVG \(XML text\) — read it with read_file/);
    expect(await runViewImage(io(execShell as any), { path: '/app/doc.pdf' })).toMatch(/^Tool view_image failed: \/app\/doc\.pdf is a PDF — use read_document/);
    expect(execShell).not.toHaveBeenCalled();
  });

  it('VIEW_IMAGE_TOOL_DISABLED=1: the executor refuses without touching the shell', async () => {
    process.env.VIEW_IMAGE_TOOL_DISABLED = '1';
    expect(viewImageToolDisabled()).toBe(true);
    const execShell = jest.fn();
    expect(await runViewImage(io(execShell as any), { path: '/app/a.png' })).toBe('Tool view_image failed: view_image is disabled on this instance (VIEW_IMAGE_TOOL_DISABLED).');
    expect(execShell).not.toHaveBeenCalled();
    process.env.VIEW_IMAGE_TOOL_DISABLED = '0';
    expect(viewImageToolDisabled()).toBe(false);
  });
});

describe('VIEW_IMAGE_SCHEMA', () => {
  it('is a function tool named view_image with a required path and an optional question', () => {
    expect(VIEW_IMAGE_SCHEMA.function.name).toBe(VIEW_IMAGE_TOOL);
    expect(VIEW_IMAGE_SCHEMA.function.parameters.required).toEqual(['path']);
    expect(Object.keys(VIEW_IMAGE_SCHEMA.function.parameters.properties)).toEqual(['path', 'question']);
    expect(VIEW_IMAGE_SCHEMA.function.description).toMatch(/instead of pixel heuristics/);
  });
});
