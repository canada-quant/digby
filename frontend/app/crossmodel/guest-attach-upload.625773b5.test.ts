/**
 * Guest attachments (ticket 625773b5 — "how come guest users dont have a
 * attach button available to attach images files etc??").
 *
 * The C3 convergence hid the whole attach surface from guests. Lifting it is
 * only real if the staged ids actually REACH the backend on a chatless send:
 * guests mount CodeSessionView with chatId null, so their send rides
 * buildPlainStreamUrl's open /crossmodel/stream shapes (GET query, the
 * >1500-char register body, and the register-FAILURE fallback). These pins
 * hold that leg — no `uploadId` param means the guest's file silently
 * evaporates and the visible paperclip would be a lie.
 *
 * The upload staging itself needs no guest change: uploadChatFiles sends
 * Authorization only when a token exists (components/attachments.tsx) and POST
 * /crossmodel/upload is in the open-route posture list, with optionalAuthenticate
 * stamping ownerUserId null (backend upload.controller.ts) and loadAttachment
 * reading purely by id — no ownership check to fail.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

vi.mock('@/lib/api-client', () => ({ ensureFreshAuthCookie: vi.fn(async () => {}) }));

import { buildPlainStreamUrl } from './plain-session';

const readSrc = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const PAGE = readSrc('./page.tsx');
const VIEW = readSrc('./components/CodeSessionView.tsx');

const originalFetch = globalThis.fetch;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ streamToken: '33333333-3333-4333-8333-333333333333' }) }));
  (globalThis as any).fetch = fetchMock;
});
afterEach(() => { (globalThis as any).fetch = originalFetch; });

const ids = (url: string) => new URL(url).searchParams.getAll('uploadId');
const GUEST_SESSION = '44444444-4444-4444-8444-444444444444';

describe('625773b5 buildPlainStreamUrl — a CHATLESS GUEST send carries uploadId', () => {
  it('short message: every staged id rides the GET query, alongside the guest session id', async () => {
    const url = await buildPlainStreamUrl({
      message: 'what is in this?',
      mode: 'auto',
      webSearch: false,
      sessionId: GUEST_SESSION,
      uploadIds: ['up-a', 'up-b'],
    });
    // No chatId anywhere — this is the guest shape, not a signed-in chat send.
    expect(new URL(url).searchParams.has('chatId')).toBe(false);
    expect(ids(url)).toEqual(['up-a', 'up-b']);
    expect(new URL(url).searchParams.get('sessionId')).toBe(GUEST_SESSION);
  });

  it('an attachment-only guest send still carries the ids (the placeholder text is server-side)', async () => {
    const url = await buildPlainStreamUrl({ message: '', mode: 'auto', webSearch: false, uploadIds: ['up-only'] });
    expect(ids(url)).toEqual(['up-only']);
  });

  it('no attachments: no uploadId params at all', async () => {
    const url = await buildPlainStreamUrl({ message: 'plain question', mode: 'auto', webSearch: false });
    expect(ids(url)).toEqual([]);
  });

  it('long message: the ids ride the register body (POST /stream/register)', async () => {
    const long = 'x'.repeat(1600);
    await buildPlainStreamUrl({ message: long, mode: 'auto', webSearch: false, sessionId: GUEST_SESSION, uploadIds: ['up-long'] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.uploadId).toEqual(['up-long']);
    expect(body.chatId).toBeUndefined();
  });

  it('register FAILURE: the direct-GET fallback keeps the ids (never a silent text-only send)', async () => {
    (globalThis as any).fetch = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }));
    const url = await buildPlainStreamUrl({
      message: 'x'.repeat(1600),
      mode: 'auto',
      webSearch: false,
      uploadIds: ['up-fallback'],
    });
    expect(ids(url)).toEqual(['up-fallback']);
  });
});

describe('625773b5 [page.tsx] — the attach surface renders for guests', () => {
  it('the paperclip is not user-gated and its hidden input is always mounted', () => {
    expect(PAGE).not.toContain('{!!user && (\n                  <button');
    expect(PAGE).not.toContain('hiddenFileInput={user ? (');
    expect(PAGE).toContain('aria-label="Attach files"');
  });

  it('staged uploads reach the view for a chatless guest mount', () => {
    expect(PAGE).toContain('takeAttachments: () => {');
    expect(PAGE).toContain('onAttachFiles: (files: File[]) => { void processFiles(files); },');
  });
});

describe('625773b5 [CodeSessionView] — a guest hold never drops its files', () => {
  it('the mid-run hold snapshots the bar and an attachment-only hold stages', () => {
    expect(VIEW).toContain('const heldAtts = guestHold && !escalationOf ? (plainCfg.takeAttachments?.() ?? []) : [];');
    expect(VIEW).toContain('if (guestHold && (message.trim() || heldAtts.length > 0)) {');
  });

  it('the drain send carries the held ids through overrideUploads, which the plain path honors', () => {
    expect(VIEW).toContain('void send(merged.message, undefined, { overrideUploads: merged.uploads as unknown as AttachmentInfo[] });');
    expect(VIEW).toContain(': (opts?.overrideUploads ?? plainCfg.takeAttachments?.() ?? []);');
  });

  it('the paperclip is ungated in the unified view too', () => {
    expect(VIEW).not.toContain('{!plain?.guest && (');
  });
});
