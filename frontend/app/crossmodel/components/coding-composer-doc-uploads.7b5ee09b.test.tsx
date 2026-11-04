/**
 * Ticket 7b5ee09b — a PDF (or DOCX/XLSX) attached in a CODING session must
 * reach the agent as a real file, exactly like it does in a plain chat.
 *
 * The regression (owner report: "couldn't upload a PDF in coding session but
 * works in chat sessions"): the coding composer's file input accept= listed
 * only image/*, text/* and text/code extensions, and handleIncomingFiles
 * routed anything that was not an image or an inline-able text/code file to
 * `rejected.push(...)` → a toast claiming "only images and text/code files
 * work in a coding session". The PDF never left the browser — while the
 * BACKEND channel had existed since 7f546b03 (parseUploadIdsBody +
 * resolveUploadIdsToFiles on startRun/steer/streamCapabilityRun, staging
 * into <worktree>/.digby/session/attachments/).
 *
 * The fix: document files (pdf/docx/xlsx/xls) stage through the SHARED chat
 * upload flow (uploadChatFiles → POST /crossmodel/upload), ride the run/steer
 * POST body as uploadIds, and render as removable chips (the shared
 * AttachmentChips bar) until send. This pin locks the contract in the
 * source-pin idiom (coding-composer-image-gates.c7d404cf).
 *
 * Ticket 6c050917 (2026-10-26): AUDIO extensions join the doc set — the
 * coding picker accepts audio and handleIncomingFiles routes it through the
 * same uploadChatFiles channel (never the reject branch); the rejection
 * toast names audio. Without this, the widened accept= advertised audio the
 * router refused — the dead-paperclip class this file exists to pin against.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const VIEW = readFileSync(
  fileURLToPath(new URL('./CodeSessionView.tsx', import.meta.url)),
  'utf8',
);
const CODING_API = readFileSync(
  fileURLToPath(new URL('../../../lib/api/coding.ts', import.meta.url)),
  'utf8',
);
const PAGE = readFileSync(
  fileURLToPath(new URL('../page.tsx', import.meta.url)),
  'utf8',
);

describe('7b5ee09b — coding composer routes documents to the upload channel', () => {
  it('the coding file input accepts pdf/docx/xlsx/xls', () => {
    const accept = VIEW.match(/accept="(image\/\*[^"]*)"/)?.[1] ?? '';
    for (const ext of ['.pdf', '.docx', '.xlsx', '.xls']) expect(accept).toContain(ext);
    expect(accept).toContain('application/pdf');
  });

  it('documents route to uploadChatFiles BEFORE the reject branch (a PDF can never hit rejected)', () => {
    // Ticket 6c050917: audio extensions join the doc set — an audio clip
    // picked in a coding session routes through the SAME upload channel.
    expect(VIEW).toContain("const CODE_ATTACH_DOC_EXTS = new Set(['pdf', 'docx', 'xlsx', 'xls', 'wav', 'mp3', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'flac', 'webm'])");
    const docRoute = VIEW.indexOf('docs.push(f)');
    const rejectRoute = VIEW.indexOf('rejected.push(f.name)');
    expect(docRoute).toBeGreaterThan(-1);
    expect(rejectRoute).toBeGreaterThan(-1);
    expect(docRoute).toBeLessThan(rejectRoute);
  });

  it('ticket 6c050917: audio picked in a coding session routes to the upload channel (never the reject branch)', () => {
    // The audio extensions sit in the SAME doc set the router checks before
    // the reject branch — an audio clip stages exactly like a PDF.
    for (const ext of ['wav', 'mp3', 'm4a', 'aac', 'ogg', 'flac']) {
      expect(VIEW).toContain(`'${ext}'`);
    }
    // The picker advertises audio…
    const accept = VIEW.match(/accept="(image\/\*[^"]*)"/)?.[1] ?? '';
    expect(accept).toContain('audio/*');
    // …and the reject toast names audio (no advertise-and-refuse mismatch).
    expect(VIEW).toContain('images, audio, text/code files');
  });

  it('staged documents land as removable chips in component state', () => {
    expect(VIEW).toContain('void uploadChatFiles(docs).then(newItems => {');
    expect(VIEW).toContain('setPendingUploads(prev => [...prev, ...newItems])');
    expect(VIEW).toContain('<AttachmentChips attachments={pendingUploads}');
  });

  it('the uploadIds ride BOTH the run and the steer body', () => {
    expect(VIEW).toContain('const uploadIds = pendingUploads.map(a => a.uploadId);');
    expect(VIEW).toContain('await codingApi.startRun(sid, message, images, uploadIds);');
    expect(VIEW).toContain('await codingApi.steerRun(activeSession.id, message, images, uploadIds);');
  });

  it('the stale "only images and text/code files" rejection copy is gone', () => {
    expect(VIEW).not.toContain('only images and text/code files work in a coding session');
    expect(VIEW).toContain('PDF/DOCX/XLSX documents work in a coding session');
  });

  it('the stale "no upload endpoint for coding sessions" design comment is gone', () => {
    expect(VIEW).not.toContain('there is no upload endpoint for coding sessions');
  });
});

describe('7b5ee09b — the coding API client carries uploadIds', () => {
  it('startRun and steerRun accept uploadIds and include them in the POST body when non-empty', () => {
    const startSig = CODING_API.indexOf('startRun: async (sessionId: string, message: string, images?: ChatImage[], uploadIds?: string[])');
    const steerSig = CODING_API.indexOf('steerRun: async (sessionId: string, message: string, images?: ChatImage[], uploadIds?: string[])');
    expect(startSig).toBeGreaterThan(-1);
    expect(steerSig).toBeGreaterThan(-1);
    // Both bodies carry the same conditional-spread idiom (empty never sends the key).
    const bodies = CODING_API.match(/\.\.\.\(uploadIds\?\.length \? \{ uploadIds \} : \{\}\)/g) ?? [];
    expect(bodies.length).toBe(2);
  });
});

describe('7b5ee09b — "what else is broke": the plain-chat composer accept list', () => {
  it('page.tsx accept= includes xlsx/xls (the backend upload controller already supports them)', () => {
    const accept = PAGE.match(/accept="(image\/\*[^"]*)"/)?.[1] ?? '';
    expect(accept).toContain('.xlsx');
    expect(accept).toContain('.xls');
    expect(accept).toContain('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(accept).toContain('application/vnd.ms-excel');
  });
});
