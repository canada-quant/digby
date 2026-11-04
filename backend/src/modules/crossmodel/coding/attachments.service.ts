/**
 * Digby Code — stage user-attached bytes onto the session filesystem.
 *
 * Feedback 32bdde10: images attached to a coding-session message reached the
 * MODEL as vision content, but the raw bytes never existed anywhere the agent's
 * TOOLS could reach (searched /tmp, $HOME, the workspace — nothing), so the
 * agent could not place user-sent files into the repo. Chat uploads live in
 * Redis with a 15-min TTL and are never linked to the session; coding message
 * `parts` persist base64 in Postgres but no tool reads them back.
 *
 * Feedback 7f546b03 generalized the seam from images to ALL file types: chat
 * uploads (POST /crossmodel/upload) retain their raw base64 in Redis, the
 * run/steer entry points resolve the upload ids into SessionFilePayloads, and
 * the same staging below (stageSessionFiles) lands them on disk — the agent
 * gets the real file, not just its 50K-char extracted-text preview.
 *
 * Fix seam: at run start (and when a steer carries attachments mid-run) the
 * run-executor writes each attachment's decoded bytes into
 * `<worktree>/.digby/session/attachments/` — a git-ignored scratch dir (we
 * ensure the `.digby/session/.gitignore` wildcard exists, same pattern as
 * plan.service) that is visible to the agent's shell because the session
 * container mounts the SAME coding_workspaces volume at the same path. The
 * agent-facing message gets an [ATTACHMENTS] note listing the relative paths.
 *
 * Staging is best-effort: a failure must never block or fail the run.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import logger from '../../../utils/logger';
import { ChatImage } from './chat-images';
import { SessionFilePayload } from './chat-files';

export interface StagedAttachment {
  /** Sanitized filename as written (index-prefixed, collision-free). */
  name: string;
  /** Absolute path on the backend host AND inside the session container. */
  path: string;
  /** Worktree-relative path (for orientation in notes). */
  relPath: string;
  mediaType: string;
  bytes: number;
  /**
   * 7b5ee09b: when the payload carried an upload-time text extract, the
   * sibling `<name>.extracted.txt` written next to the binary (worktree-
   * relative). Undefined when there was no extract (or its write failed —
   * the extract is auxiliary and never fails the staging).
   */
  extractRelPath?: string;
}

const ATTACHMENTS_REL = path.join('.digby', 'session', 'attachments');

const EXT_BY_MIME: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

/**
 * Sanitize a user-supplied filename into something safe to write inside the
 * attachments dir: directory components stripped (no traversal), conservative
 * charset, no dotfiles, extension coerced to the real (sniff-validated) type.
 * An index prefix keeps batch members distinct and orders them by attach order.
 */
export function sanitizeAttachmentName(raw: string | undefined, mediaType: string, index: number): string {
  const ext = EXT_BY_MIME[mediaType] || '';
  // Strip any directory components — twice, so "a/b/../c" can't leave a segment.
  let base = (raw || '').split(/[\\/]/).filter(Boolean).pop() || '';
  base = base.replace(/[^\w.\-() ]+/g, '_').trim();
  if (base.startsWith('.')) base = `_${base.slice(1)}`;
  if (!base) base = `image${ext || '.bin'}`;
  // Coerce the extension to the validated media type (a "foo.txt" that carries
  // PNG bytes becomes "foo.txt.png" — never executable-looking, never lying).
  if (ext && !base.toLowerCase().endsWith(ext)) base = `${base}${ext}`;
  if (base.length > 80) base = `${base.slice(0, 80 - ext.length)}${ext}`;
  return `${String(index + 1).padStart(2, '0')}-${base}`;
}

/** Insert a `-n` collision suffix before the extension (or at the end when the
 *  name carries none — extensionless file names must still make progress). */
function withCollisionSuffix(name: string, n: number): string {
  return /(\.[^.]+)$/.test(name) ? name.replace(/(\.[^.]+)$/, `-${n}$1`) : `${name}-${n}`;
}

/** The naming rule applied per staged item (index-prefixed, traversal-safe). */
type SanitizeStrategy = (raw: string | undefined, mediaType: string, index: number) => string;

/**
 * Shared staging core (images 32bdde10 / all files 7f546b03): write each
 * item's decoded bytes into `<worktree>/.digby/session/attachments/` and
 * return what landed. Existing files on disk are never overwritten (a steer
 * batch staged mid-run must not clobber the opening turn's files) — a `-n`
 * suffix is appended on collision. Throws on mkdir/write failure (callers
 * catch and degrade to an empty list — staging must not fail the run).
 */
async function stageIntoAttachmentsDir(
  worktree: string,
  items: Array<{ name?: string; mediaType: string; data: string; extractedText?: string }>,
  sanitize: SanitizeStrategy,
): Promise<StagedAttachment[]> {
  if (!items.length) return [];
  const dir = path.join(worktree, ATTACHMENTS_REL);
  await fs.mkdir(dir, { recursive: true });
  // Git-ignore the whole scratch dir (idempotent; '*' alone — the .gitignore
  // itself stays ignored too, matching plan.service, so it can never ride
  // along on a user's `git add -A`). GitHub-backed worktrees use the REPO's
  // .gitignore, which knows nothing about .digby/ — without this the staged
  // bytes pollute git status/diff.
  const gi = path.join(worktree, '.digby', 'session', '.gitignore');
  await fs.writeFile(gi, '*\n', { encoding: 'utf8', flag: 'wx' }).catch(() => {});
  const existing = new Set(await fs.readdir(dir).catch(() => [] as string[]));

  const staged: StagedAttachment[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const buf = Buffer.from(item.data, 'base64');
    let name = sanitize(item.name, item.mediaType, i);
    let skipWrite = false;
    // Idempotent re-staging (the run queue is at-least-once): a same-name file
    // with the SAME bytes is this attachment already staged — reuse it, don't
    // rewrite. A same-name file with DIFFERENT content (a later steer batch)
    // gets a -n suffix so the earlier turn's file is never clobbered.
    if (existing.has(name)) {
      const same = await fs.readFile(path.join(dir, name)).then(b => b.equals(buf)).catch(() => false);
      if (same) {
        skipWrite = true;
      } else {
        for (let n = 2; existing.has(name); n++) {
          name = withCollisionSuffix(sanitize(item.name, item.mediaType, i), n);
        }
      }
    }
    existing.add(name);
    const target = path.join(dir, name);
    if (!skipWrite) await fs.writeFile(target, buf);
    // 7b5ee09b: an upload-time text extract stages as a `<name>.extracted.txt`
    // sibling keyed to the FINAL (collision-suffixed) staged name, so the
    // pairing is obvious (`01-report-2.pdf` → `01-report-2.pdf.extracted.txt`).
    // Best-effort: the extract is auxiliary — its failure must not fail the
    // file's staging (the binary is the payload; the extract is the readable
    // copy for a container without pdftotext/mammoth).
    let extractRelPath: string | undefined;
    if (item.extractedText) {
      const extractName = `${name}.extracted.txt`;
      try {
        await fs.writeFile(path.join(dir, extractName), item.extractedText, 'utf8');
        extractRelPath = path.join(ATTACHMENTS_REL, extractName);
      } catch (err: any) {
        logger.warn(`coding attachments: text-extract sibling write failed for ${name} (file still staged): ${err?.message}`);
      }
    }
    staged.push({
      name,
      path: target,
      relPath: path.join(ATTACHMENTS_REL, name),
      mediaType: item.mediaType,
      bytes: buf.length,
      ...(extractRelPath ? { extractRelPath } : {}),
    });
  }
  return staged;
}

/**
 * Stage images (feedback 32bdde10) — names coerced to the sniff-validated
 * image type via sanitizeAttachmentName.
 */
export async function stageSessionImages(worktree: string, images: ChatImage[]): Promise<StagedAttachment[]> {
  return stageIntoAttachmentsDir(worktree, images, sanitizeAttachmentName);
}

/**
 * Sanitize a NON-image file's name (feedback 7f546b03): same traversal/charset
 * rules as sanitizeAttachmentName but the ORIGINAL filename + extension are
 * kept as-is (a csv must stay a csv — no type coercion when there is no
 * sniff-validated type to coerce to). Image mediaTypes delegate to
 * sanitizeAttachmentName so a misrouted image still gets its extension coerced.
 */
function sanitizeFileName(raw: string | undefined, mediaType: string, index: number): string {
  if (mediaType.startsWith('image/')) return sanitizeAttachmentName(raw, mediaType, index);
  // Strip any directory components — twice, so "a/b/../c" can't leave a segment.
  let base = (raw || '').split(/[\\/]/).filter(Boolean).pop() || '';
  base = base.replace(/[^\w.\-() ]+/g, '_').trim();
  if (base.startsWith('.')) base = `_${base.slice(1)}`;
  if (!base) base = 'file';
  // Truncate like the image rule but PRESERVE the original extension.
  if (base.length > 80) {
    const ext = base.match(/(\.[^.]{1,12})$/)?.[1] ?? '';
    base = ext ? `${base.slice(0, 80 - ext.length)}${ext}` : base.slice(0, 80);
  }
  return `${String(index + 1).padStart(2, '0')}-${base}`;
}

/**
 * Stage arbitrary chat-uploaded files (feedback 7f546b03) — original names +
 * extensions preserved (images keep the image coercion). Same mkdir/gitignore/
 * collision/idempotency semantics as stageSessionImages (shared core above).
 */
export async function stageSessionFiles(worktree: string, files: SessionFilePayload[]): Promise<StagedAttachment[]> {
  return stageIntoAttachmentsDir(worktree, files, sanitizeFileName);
}

function fmtBytes(n: number): string {
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

/**
 * The agent-facing note listing where the attached bytes landed ('' when nothing
 * staged). Appended to the user message / steer instruction — it is context for
 * the model, NOT persisted as the user's transcript text.
 */
export function buildAttachmentsNote(staged: StagedAttachment[]): string {
  if (!staged.length) return '';
  const lines = staged.map(s => `- ${s.relPath} (${s.mediaType}, ${fmtBytes(s.bytes)})`);
  return `\n\n[ATTACHMENTS — saved to the session filesystem]\n`
    + `The user attached ${staged.length} image${staged.length === 1 ? '' : 's'} to this message. Beyond the vision copy you received, the raw bytes are on disk (git-ignored scratch dir):\n`
    + lines.join('\n')
    + `\nUse your file/shell tools on them as the task requires (e.g. \`cp\` into the repo if they should be tracked — that is an explicit choice, they stay git-ignored otherwise).`;
}

/** Stage + build the note, swallowing errors (logged) — the run-executor seam. */
export async function stageAndDescribe(worktree: string, images: ChatImage[], label: string): Promise<{ staged: StagedAttachment[]; note: string }> {
  try {
    const staged = await stageSessionImages(worktree, images);
    if (staged.length) logger.info(`coding attachments: staged ${staged.length} image(s) for ${label} → ${staged[0].path}`);
    return { staged, note: buildAttachmentsNote(staged) };
  } catch (err: any) {
    logger.warn(`coding attachments: staging failed for ${label} (run continues without fs copies): ${err?.message}`);
    return { staged: [], note: '' };
  }
}

/**
 * The agent-facing note for staged FILES (feedback 7f546b03) — same shape as
 * buildAttachmentsNote minus the vision mention ('' when nothing staged).
 */
export function buildFilesNote(staged: StagedAttachment[]): string {
  if (!staged.length) return '';
  // 7b5ee09b: a staged text extract gets its own pointer line — the agent
  // reads the .txt with read_file instead of needing a PDF/Office parser.
  const lines = staged.map(s =>
    `- ${s.relPath} (${s.mediaType}, ${fmtBytes(s.bytes)})`
    + (s.extractRelPath ? `\n  text extract saved to ${s.extractRelPath} — read it with read_file.` : ''));
  return `\n\n[ATTACHED FILES — saved to the session filesystem]\n`
    + `The user attached ${staged.length} file${staged.length === 1 ? '' : 's'} to this message. The raw bytes are on disk (git-ignored scratch dir):\n`
    + lines.join('\n')
    + `\nUse your file/shell tools on them as the task requires (e.g. \`cp\` into the repo if they should be tracked — that is an explicit choice, they stay git-ignored otherwise).`;
}

/** Stage files + build the note, swallowing errors (logged) — mirrors stageAndDescribe. */
export async function stageFilesAndDescribe(worktree: string, files: SessionFilePayload[], label: string): Promise<{ staged: StagedAttachment[]; note: string }> {
  try {
    const staged = await stageSessionFiles(worktree, files);
    if (staged.length) logger.info(`coding attachments: staged ${staged.length} file(s) for ${label} → ${staged[0].path}`);
    return { staged, note: buildFilesNote(staged) };
  } catch (err: any) {
    logger.warn(`coding attachments: file staging failed for ${label} (run continues without fs copies): ${err?.message}`);
    return { staged: [], note: '' };
  }
}
