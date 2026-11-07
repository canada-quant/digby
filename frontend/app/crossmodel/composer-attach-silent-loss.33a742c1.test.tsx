/**
 * Composer attachments silently vanish after upload (ticket 33a742c1).
 *
 * THE OWNER'S REPORT: three .log attachments in a supervisor chat each showed
 * up in the composer, then disappeared once the upload finished; every send
 * went out as the bare placeholder "Analyze the attached file(s)." with zero
 * upload payload and NO error on screen.
 *
 * WHAT WAS ACTUALLY WRONG (reproduced here, not assumed). The ticket guessed
 * the picker's accept filter rejected `.log` after showing it attached. That
 * half is REFUTED — `.log` is in the accept list of both pickers and the
 * backend stages a plain `.log` happily. Two REAL defects were found and are
 * pinned below:
 *
 *   1. `.log`/`.out`/`.diff`/`.patch` (and the code-file family) were absent
 *      from EXT_MIME_MAP, so a generic browser declaration
 *      ('', 'application/octet-stream') reached the server unresolved and the
 *      file's fate rested ENTIRELY on the server's 8 KB byte sniff. Logs
 *      routinely carry a control byte (ANSI escapes, \f, \v) — the sniff then
 *      fails and the upload 400s. LIVE-PROBED against production: the same
 *      .log bytes with an ANSI escape + form feed return HTTP 400 when
 *      declared 'application/octet-stream' and HTTP 200 when declared
 *      'text/plain'. So this is a real, reproducing refusal.
 *   2. A refused upload produced only a transient toast and NO chip, so what
 *      the user sees is an attachment that vanishes with nothing on screen
 *      explaining it. The composer now keeps an INLINE, persistent notice.
 *
 * HONEST SCOPE LIMIT — what this file does NOT claim. The owner's exact
 * sequence ended in a send whose placeholder ("Analyze the attached file(s).")
 * proves a chip HAD staged (both composers only build that placeholder when
 * at least one attachment is staged), i.e. the upload succeeded and the payload
 * was lost DOWNSTREAM of upload. Defect 1 above therefore cannot be the whole
 * story for those three sends: a refused upload yields no chip and, with no
 * draft text, no send at all. The downstream loss remains open — see the
 * follow-up ticket filed from that lane. This file pins the two defects that
 * ARE proven and fixed here; it does not replay the owner's placeholder send.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { resolveAttachmentMime } from './components/attachments';

const readSrc = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const ATTACHMENTS = readSrc('./components/attachments.tsx');
const PAGE = readSrc('./page.tsx');
const SUPERVISOR = readSrc('./management/SupervisorChatTab.tsx');

describe('33a742c1 — a plain-text .log must never be left to the server byte sniff', () => {
  // The exact failing shape from the report: an OPTCGSim autosave .log that the
  // OS/browser hands over with NO useful type. Pre-fix this resolved to
  // 'application/octet-stream'; now it must resolve to a concrete text type.
  it('resolves .log to text/plain when the browser declares no type at all', () => {
    expect(resolveAttachmentMime('OPTCGSim_autosave.log', '')).toBe('text/plain');
  });

  it('resolves .log to text/plain when the browser declares the generic binary type', () => {
    expect(resolveAttachmentMime('WNNHGLQ.log', 'application/octet-stream')).toBe('text/plain');
  });

  it('resolves the rest of the plain-text family the pickers accept', () => {
    for (const ext of ['log', 'out', 'diff', 'patch', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'sh', 'sql', 'env', 'py', 'go', 'rs', 'ts', 'tsx', 'js', 'css', 'html', 'vue', 'svelte']) {
      expect(resolveAttachmentMime(`sample.${ext}`, 'application/octet-stream')).toBe('text/plain');
      expect(resolveAttachmentMime(`sample.${ext}`, '')).toBe('text/plain');
    }
  });

  it('is case-insensitive about the extension (WNNHGLQ.LOG)', () => {
    expect(resolveAttachmentMime('WNNHGLQ.LOG', 'application/octet-stream')).toBe('text/plain');
  });

  // Regression guard for the pre-existing behaviour: a CONCRETE declared type
  // still wins, so images/audio/pdf/docx stage exactly as before.
  it('keeps a concrete declared type authoritative', () => {
    expect(resolveAttachmentMime('shot.png', 'image/png')).toBe('image/png');
    expect(resolveAttachmentMime('clip.wav', 'audio/wav')).toBe('audio/wav');
    expect(resolveAttachmentMime('doc.pdf', 'application/pdf')).toBe('application/pdf');
    expect(resolveAttachmentMime('sheet.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'))
      .toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  });

  it('leaves a genuinely unknown extension on the generic type so the server still sniffs it', () => {
    // Never invent a text type for an extension we do not know — the backend's
    // byte sniff stays the enforcement point for those.
    expect(resolveAttachmentMime('binary.weirdext', '')).toBe('application/octet-stream');
    expect(resolveAttachmentMime('binary.weirdext', 'application/octet-stream')).toBe('application/octet-stream');
  });
});

describe('33a742c1 — the upload loop resolves through resolveAttachmentMime', () => {
  // Guards the wiring: the helper is only useful if the fetch body actually uses
  // it. A future refactor back to `file.type || EXT_MIME_MAP[ext]` reintroduces
  // the bug for every generic-typed declaration.
  it('the staged mime comes from resolveAttachmentMime, not the raw file.type', () => {
    expect(ATTACHMENTS).toContain('const effectiveMimeType = resolveAttachmentMime(file.name, file.type);');
    expect(ATTACHMENTS).not.toContain("const effectiveMimeType = file.type || EXT_MIME_MAP[ext] || 'application/octet-stream';");
  });
});

describe('33a742c1 — a refused file leaves an INLINE trace, never a silent disappearance', () => {
  it('uploadChatFiles reports every failure through onRejected', () => {
    expect(ATTACHMENTS).toContain('onRejected?: (rejections: AttachmentRejection[]) => void');
    // The HTTP-refusal branch and the thrown branch both record a rejection.
    expect(ATTACHMENTS).toContain('rejected.push({ filename: file.name, reason });');
    // And the batch is handed to the composer once, after the loop.
    expect(ATTACHMENTS).toContain('if (rejected.length) opts?.onRejected?.(rejected);');
  });

  it('exports a rendered notice component that names the failed file', () => {
    expect(ATTACHMENTS).toContain('export function AttachmentNotice(');
    expect(ATTACHMENTS).toContain('role="alert"');
    expect(ATTACHMENTS).toContain("Couldn&apos;t attach {names} — {reason}");
  });

  it('the supervisor composer — the surface in the report — renders the notice', () => {
    expect(SUPERVISOR).toContain('AttachmentNotice');
    expect(SUPERVISOR).toContain('onRejected: (rejections) => setAttachmentRejections');
    // The bar must render for a rejection ALONE: the pre-fix gate was
    // `attachments.length > 0`, so a file that failed to stage rendered nothing.
    expect(SUPERVISOR).toContain('attachments.length > 0 || attachmentRejections.length > 0');
  });

  it('the home composer renders the notice too', () => {
    expect(PAGE).toContain('AttachmentNotice');
    expect(PAGE).toContain('onRejected: (rejections) => setAttachmentRejections');
    expect(PAGE).toContain('attachments.length > 0 || attachmentRejections.length > 0');
  });

  it('the notice is dismissible so it cannot stick forever', () => {
    expect(SUPERVISOR).toContain('onDismiss={() => setAttachmentRejections([])}');
    expect(PAGE).toContain('onDismiss={() => setAttachmentRejections([])}');
  });

  // Review B1 (blocking, fixed): this notice renders INSIDE the composer's
  // <form> (ChatComposer renders `{topContent}` inside <form onSubmit=…>), and
  // an unmarked <button> defaults to type="submit" — so clicking the X to clear
  // an error would SUBMIT THE DRAFT. That would be a worse version of the very
  // bug being fixed. Pin the attribute so it can never be dropped again.
  it('the dismiss button is type="button", never an implicit submit (review B1)', () => {
    const notice = ATTACHMENTS.slice(ATTACHMENTS.indexOf('export function AttachmentNotice('));
    const btn = notice.slice(0, notice.indexOf('</button>'));
    expect(btn).toContain('type="button"');
  });
});

describe('33a742c1 — the pickers already accepted .log (the ticket\'s guess, checked)', () => {
  // Pinned so the NEXT session does not "re-fix" a non-existent accept filter:
  // both pickers list .log, which is exactly why rejecting it after upload was
  // the worst of both paths.
  it('both composers accept .log in the file picker', () => {
    const acceptFor = (src: string) => (src.match(/accept="([^"]*)"/) || [])[1] || '';
    expect(acceptFor(SUPERVISOR)).toContain('.log');
    expect(acceptFor(PAGE + readSrc('./components/CodeSessionView.tsx'))).toContain('.log');
  });
});