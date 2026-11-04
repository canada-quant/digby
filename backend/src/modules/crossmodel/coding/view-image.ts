/**
 * view_image — a coding lane LOOKS at an image file (2026-10-01).
 *
 * Evidence (prod TB 2.1 bench, 2026-09-30, task chess-best-move): the coding
 * lead is text-only (glm-5.3). Told to "find the best move from
 * /app/chess_board.png", it had no way to see the image, spent ~2 h building
 * pixel template matchers from rendered font glyphs, misread the pieces (two
 * wrong FENs) and failed. Digby already had a vision hop — the admin "Image
 * reader" seat (`vision_describe`, image-describe.ts) — but no coding tool
 * reached it.
 *
 * The tool reads the bytes THROUGH THE SESSION SHELL (ctx.execShell), not the
 * backend filesystem: task files often live outside the worktree (/app/...)
 * and the shell is the lane's real filesystem. Two commands, the path always
 * shq()-quoted (the caller passes the quoting helper, ast-tools.ts style):
 *   1. a regular-file check + `stat -L -c %s` — refused over 6 MB;
 *   2. `base64 -w0` between markers (the per-command env prelude may print).
 * The decoded bytes must match the stat size and their MAGIC BYTES must name
 * an image format (PNG, JPEG, GIF, WebP, BMP, HEIC/HEIF) — a non-image file
 * is refused, so the tool cannot be used to ship arbitrary file contents to a
 * model. The answer comes from answerImageQuestion (image-describe.ts) with a
 * question-directed prompt.
 *
 * Kill switch VIEW_IMAGE_TOOL_DISABLED=1: agent.ts drops the schema from every
 * run's tool list and the executor refuses.
 *
 * Leaf: no prisma, no module-scope import of the seat runtime (the answerer is
 * required lazily so tools.ts's module graph is unchanged for the suites that
 * import it).
 */

import * as path from 'path';

export const VIEW_IMAGE_TOOL = 'view_image';
/** Largest image file the tool will read (bytes on disk). */
export const VIEW_IMAGE_MAX_BYTES = 6 * 1024 * 1024;
const STAT_TIMEOUT_MS = 30_000;
const READ_TIMEOUT_MS = 60_000;

const SIZE_MARK = '__VIEW_IMAGE_SIZE__';
const MISSING_MARK = '__VIEW_IMAGE_MISSING__';
const NOT_FILE_MARK = '__VIEW_IMAGE_NOT_FILE__';
const B64_BEGIN = '__VIEW_IMAGE_B64_BEGIN__';
const B64_END = '__VIEW_IMAGE_B64_END__';

export function viewImageToolDisabled(): boolean {
  const v = String(process.env.VIEW_IMAGE_TOOL_DISABLED ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

export const VIEW_IMAGE_SCHEMA = {
  type: 'function' as const,
  function: {
    name: VIEW_IMAGE_TOOL,
    description: 'LOOK at an image file (PNG, JPEG, GIF, WebP, BMP, HEIC) through the Image reader vision model and get a text answer. You cannot see images yourself — use this instead of pixel heuristics (template matching, hand-rolled OCR, colour sampling) whenever a task depends on what an image shows. The file is read through the session shell, so task files outside the worktree work (e.g. /app/board.png). Ask a PRECISE question ("list every piece and its square a1-h8, which side is white?", "transcribe the table cell by cell", "what does the error dialog say?"); the answer states what is uncertain — re-ask a narrower question, or crop the region with run_command and view the crop, before acting on an uncertain reading. Max 6 MB.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Image path: absolute anywhere in the session container (e.g. /app/chess_board.png) or relative to the project root.' },
        question: { type: 'string', description: 'What to answer about the image. Default: describe it in full detail, transcribing any text exactly.' },
      },
      required: ['path'],
    },
  },
};

/** The coding system prompt's guidance line (agent.ts "How you work"; omitted under the kill switch). */
export const VIEW_IMAGE_PROMPT_LINE = "- view_image(path, question) — LOOK at an image file (PNG/JPG/GIF/WebP) through a vision model; use it instead of pixel heuristics whenever a task depends on what an image shows; ask a precise question (e.g. 'list every piece and its square').";

// ── Format detection ─────────────────────────────────────────────────────────

const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs']);
const HEIF_GENERIC_BRANDS = new Set(['mif1', 'msf1']);
/** BITMAPCOREHEADER / INFO / V2 / V3 / V4 / V5 — a real BMP's DIB header size. */
const BMP_DIB_SIZES = new Set([12, 40, 52, 56, 64, 108, 124]);

const EXT_MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.jpe': 'image/jpeg', '.jfif': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.dib': 'image/bmp',
  '.heic': 'image/heic', '.heif': 'image/heif',
};

/** The image MIME a file NAME claims (extension only), or null. */
export function mimeFromExtension(filePath: string): string | null {
  return EXT_MIME[path.extname(String(filePath || '')).toLowerCase()] ?? null;
}

/**
 * The image MIME the BYTES prove (magic numbers), or null when they are not a
 * supported image. The extension is consulted only for a generic HEIF
 * container (`mif1` / `msf1` brands are shared with other ISO-BMFF images).
 */
export function detectImageMime(buf: Buffer, filePath = ''): string | null {
  if (!buf || buf.length < 3) return null;
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.toString('latin1', 0, 6))) return 'image/gif';
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.length >= 26 && buf[0] === 0x42 && buf[1] === 0x4d && BMP_DIB_SIZES.has(buf.readUInt32LE(14))) return 'image/bmp';
  if (buf.length >= 12 && buf.toString('latin1', 4, 8) === 'ftyp') {
    const brand = buf.toString('latin1', 8, 12);
    if (HEIC_BRANDS.has(brand)) return 'image/heic';
    if (HEIF_GENERIC_BRANDS.has(brand) && /\.(heic|heif)$/i.test(filePath)) return 'image/heif';
  }
  return null;
}

/** Pixel dimensions read from the header when cheap (no decode), else null. */
export function imageDimensions(buf: Buffer, mime: string): { width: number; height: number } | null {
  try {
    let width = 0;
    let height = 0;
    switch (mime) {
      case 'image/png':
        if (buf.length < 24) return null;
        width = buf.readUInt32BE(16); height = buf.readUInt32BE(20);
        break;
      case 'image/gif':
        if (buf.length < 10) return null;
        width = buf.readUInt16LE(6); height = buf.readUInt16LE(8);
        break;
      case 'image/bmp': {
        const dib = buf.readUInt32LE(14);
        if (dib === 12) { width = buf.readUInt16LE(18); height = buf.readUInt16LE(20); }
        else { width = Math.abs(buf.readInt32LE(18)); height = Math.abs(buf.readInt32LE(22)); }
        break;
      }
      case 'image/webp': {
        if (buf.length < 30) return null;
        const chunk = buf.toString('latin1', 12, 16);
        if (chunk === 'VP8 ') { width = buf.readUInt16LE(26) & 0x3fff; height = buf.readUInt16LE(28) & 0x3fff; }
        else if (chunk === 'VP8L') {
          const b1 = buf[22], b2 = buf[23], b3 = buf[24];
          width = 1 + (((b1 & 0x3f) << 8) | buf[21]);
          height = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
        } else if (chunk === 'VP8X') { width = 1 + buf.readUIntLE(24, 3); height = 1 + buf.readUIntLE(27, 3); }
        else return null;
        break;
      }
      case 'image/jpeg': {
        let i = 2;
        while (i + 9 < buf.length) {
          if (buf[i] !== 0xff) return null;
          const marker = buf[i + 1];
          if (marker === 0xff) { i += 1; continue; } // fill byte
          if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) { i += 2; continue; } // standalone
          const len = buf.readUInt16BE(i + 2);
          if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
            height = buf.readUInt16BE(i + 5); width = buf.readUInt16BE(i + 7);
            break;
          }
          if (len < 2) return null;
          i += 2 + len;
        }
        break;
      }
      default:
        return null;
    }
    return width > 0 && height > 0 ? { width, height } : null;
  } catch {
    return null;
  }
}

// ── Executor ─────────────────────────────────────────────────────────────────

export type ImageAnswerer = (
  buffer: Buffer, mime: string, filename: string, question: string, opts?: { userId?: string },
) => Promise<{ answer: string; model: string }>;

export interface ViewImageIO {
  execShell: (command: string, cwd?: string, timeoutMs?: number) => Promise<{ stdout: string; stderr: string }>;
  worktree: string;
  /** The single-quote shell quoting helper (tools.ts shq). */
  quote: (s: string) => string;
  userId?: string;
  /** Injected for tests; default = image-describe.ts answerImageQuestion. */
  answer?: ImageAnswerer;
}

function fail(reason: string): string {
  return `Tool ${VIEW_IMAGE_TOOL} failed: ${reason}`;
}

function shellDetail(r: { stdout: string; stderr: string }): string {
  const t = `${r.stderr || ''}`.replace(/\s+/g, ' ').trim() || `${r.stdout || ''}`.replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, 300) : 'no output';
}

function fmtMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function defaultAnswerer(): ImageAnswerer {
  // Lazy: the seat runtime (coding-model, model roles) loads only on a call.
  const { answerImageQuestion } = require('../image-describe') as typeof import('../image-describe');
  return (buffer, mime, filename, question, opts) => answerImageQuestion(buffer, mime, filename, question, opts);
}

/**
 * Run the tool: returns `[view_image — <model> read <path> (<WxH>)]\n<answer>`
 * on success, or a `Tool view_image failed: …` line (the coding tools' failure
 * shape) — never throws.
 */
export async function runViewImage(io: ViewImageIO, args: any): Promise<string> {
  if (viewImageToolDisabled()) return fail('view_image is disabled on this instance (VIEW_IMAGE_TOOL_DISABLED).');
  const rawPath = typeof args?.path === 'string' ? args.path.trim() : '';
  if (!rawPath) return fail('a path is required (absolute in the session container, e.g. /app/board.png, or relative to the project root).');
  if (rawPath.includes('\0')) return fail('the path contains a NUL byte.');
  const question = typeof args?.question === 'string' ? args.question.trim() : '';
  const ext = path.extname(rawPath).toLowerCase();
  if (ext === '.svg') return fail(`${rawPath} is an SVG (XML text) — read it with read_file, or render it to PNG with run_command and view the PNG.`);
  if (ext === '.pdf') return fail(`${rawPath} is a PDF — use read_document, or render a page to PNG with run_command and view the PNG.`);

  const p = io.quote(rawPath);
  try {
    // 1. Regular file + size (stat follows symlinks, like the read below).
    const st = await io.execShell(
      `if [ -f ${p} ]; then printf '${SIZE_MARK}%s\\n' "$(stat -L -c %s -- ${p} 2>/dev/null)"; elif [ -e ${p} ]; then echo ${NOT_FILE_MARK}; else echo ${MISSING_MARK}; fi`,
      io.worktree, STAT_TIMEOUT_MS,
    );
    const out = st.stdout || '';
    if (out.includes(MISSING_MARK)) {
      return fail(`no such file: ${rawPath}${path.isAbsolute(rawPath) ? '' : ' (relative paths resolve from the project root — task files often live elsewhere, e.g. /app/…; pass the absolute path)'}.`);
    }
    if (out.includes(NOT_FILE_MARK)) return fail(`${rawPath} is not a regular file.`);
    const sizeMatch = out.match(new RegExp(`${SIZE_MARK}(\\d*)`));
    if (!sizeMatch) return fail(`could not read ${rawPath} through the session shell — ${shellDetail(st)}`);
    const size = Number(sizeMatch[1]);
    if (!sizeMatch[1] || !Number.isFinite(size)) return fail(`could not stat ${rawPath} — ${shellDetail(st)}`);
    if (size === 0) return fail(`${rawPath} is empty (0 bytes).`);
    if (size > VIEW_IMAGE_MAX_BYTES) {
      return fail(`${rawPath} is ${fmtMb(size)} — over the ${fmtMb(VIEW_IMAGE_MAX_BYTES)} view_image limit. Downscale or crop it with run_command (Python PIL, or ImageMagick if installed) and view the smaller copy.`);
    }

    // 2. The bytes, base64 between markers.
    const rd = await io.execShell(
      `printf '${B64_BEGIN}\\n'; base64 -w0 -- ${p}; printf '\\n${B64_END}\\n'`,
      io.worktree, READ_TIMEOUT_MS,
    );
    const body = rd.stdout || '';
    const a = body.indexOf(B64_BEGIN);
    const b = body.indexOf(B64_END, a < 0 ? 0 : a);
    if (a < 0 || b < 0) return fail(`could not read ${rawPath} through the session shell — ${shellDetail(rd)}`);
    const b64 = body.slice(a + B64_BEGIN.length, b).replace(/\s+/g, '');
    const buf = Buffer.from(b64, 'base64');
    if (buf.length !== size) {
      return fail(`reading ${rawPath} returned ${buf.length} bytes, expected ${size} (the file changed mid-read or the read failed${rd.stderr ? ` — ${shellDetail({ stdout: '', stderr: rd.stderr })}` : ''}).`);
    }

    const mime = detectImageMime(buf, rawPath);
    if (!mime) {
      const claimed = mimeFromExtension(rawPath);
      return fail(claimed
        ? `${rawPath} has a ${ext} extension but its bytes are not a ${claimed.replace('image/', '').toUpperCase()} image — check it with run_command (\`file ${rawPath}\`).`
        : `${rawPath} is not a supported image (PNG, JPEG, GIF, WebP, BMP or HEIC, judged by its bytes). Convert it to PNG with run_command first.`);
    }
    const dims = imageDimensions(buf, mime);
    const answerer = io.answer ?? defaultAnswerer();
    let res: { answer: string; model: string };
    try {
      res = await answerer(buf, mime, path.basename(rawPath), question, io.userId ? { userId: io.userId } : undefined);
    } catch (err: any) {
      return fail(`the Image reader seat could not read ${rawPath} — ${String(err?.message ?? err).replace(/\s+/g, ' ').slice(0, 400)}. The image was NOT seen: say so rather than presenting a pixel-heuristic guess as a reading.`);
    }
    const answer = String(res?.answer ?? '').trim();
    if (!answer) return fail(`the Image reader seat returned no answer for ${rawPath}.`);
    return `[view_image — ${res.model || 'Image reader'} read ${rawPath}${dims ? ` (${dims.width}x${dims.height})` : ''}]\n${answer}`;
  } catch (err: any) {
    return fail(`${String(err?.message ?? err).replace(/\s+/g, ' ').slice(0, 300)}`);
  }
}
