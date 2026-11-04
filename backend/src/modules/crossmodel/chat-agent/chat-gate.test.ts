/**
 * chat-gate tests — the agentic-only routing decision + attachment mapping.
 * Pure module (its only runtime import is coding/chat-images, dependency-free),
 * so no prisma/env mocks are needed.
 */

import { decideChatGate, mapAttachmentForAgent, chatWriteAccessGranted, chatReadAccessGranted, streamAccessDeniedError, STREAM_AUTH_REQUIRED_CODE, STREAM_AUTH_REQUIRED_MESSAGE } from './chat-gate';
import { MAX_IMAGES } from '../coding/chat-images';

// A real PNG signature (\x89PNG\r\n\x1a\n) + filler — validateImages sniffs the
// leading bytes, so base64 of the raw signature bytes passes as image/png.
const PNG_B64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8]).toString('base64');
// Decodes to plain text — fails the magic-byte sniff for any declared image type.
const NOT_IMAGE_B64 = Buffer.from('this is not an image at all').toString('base64');

describe('decideChatGate', () => {
  it('passes browser_agent through untouched (even anonymous)', () => {
    expect(decideChatGate({ mode: 'browser_agent', userId: null })).toEqual({ action: 'browser_agent' });
    expect(decideChatGate({ mode: 'browser_agent', userId: 'u1' })).toEqual({ action: 'browser_agent' });
  });

  it('routes council modes to the agent with councilMode=true — anonymous AND logged-in (owner 2026-09-23: guests get deep research under an IP-keyed quota)', () => {
    for (const mode of ['deep_research', 'deep_research_all']) {
      for (const userId of [null, undefined, '', 'u1'] as any[]) {
        expect(decideChatGate({ mode, userId })).toEqual({ action: 'agent', councilMode: true });
      }
    }
  });

  it('routes every other mode to the agent — anonymous AND logged-in, either model set', () => {
    for (const mode of ['single_thinking', 'thinking', 'single', 'fast']) {
      expect(decideChatGate({ mode, userId: null })).toEqual({ action: 'agent', councilMode: false });
      expect(decideChatGate({ mode, userId: 'u1' })).toEqual({ action: 'agent', councilMode: false });
    }
  });
});

describe('chatWriteAccessGranted (H1 — cross-user chat injection gate)', () => {
  it('grants the chat owner', () => {
    expect(chatWriteAccessGranted({ userId: 'u1', access: 'owner', exists: true })).toBe(true);
  });

  it('grants a project editor/admin (write) — members can legitimately send in shared chats', () => {
    expect(chatWriteAccessGranted({ userId: 'u2', access: 'write', exists: true })).toBe(true);
  });

  it('denies a project viewer (read-only may not inject messages)', () => {
    expect(chatWriteAccessGranted({ userId: 'u2', access: 'read', exists: true })).toBe(false);
  });

  it('denies a stranger (access none)', () => {
    expect(chatWriteAccessGranted({ userId: 'u2', access: 'none', exists: true })).toBe(false);
  });

  it('denies an anonymous caller even if the chat exists — anon can never own a chat', () => {
    expect(chatWriteAccessGranted({ userId: null, access: 'owner', exists: true })).toBe(false);
    expect(chatWriteAccessGranted({ userId: undefined, access: 'write', exists: true })).toBe(false);
  });

  it('denies when the chat does not exist (and on lookup failure, which maps to exists=false)', () => {
    expect(chatWriteAccessGranted({ userId: 'u1', access: 'none', exists: false })).toBe(false);
    expect(chatWriteAccessGranted({ userId: 'u1', access: 'owner', exists: false })).toBe(false);
  });
});

describe('chatReadAccessGranted (P5 — GET /agent/active for shared-chat members)', () => {
  it('grants the owner and every project member level, viewers included', () => {
    expect(chatReadAccessGranted({ userId: 'u1', access: 'owner', exists: true })).toBe(true);
    expect(chatReadAccessGranted({ userId: 'u2', access: 'write', exists: true })).toBe(true);
    // The drain-watch fix: a member who queued a message must get a real
    // answer from /agent/active — the old owner-only 404 read as "idle" and
    // cleared the Queued badge before the answer existed.
    expect(chatReadAccessGranted({ userId: 'u2', access: 'read', exists: true })).toBe(true);
  });

  it('denies strangers, anonymous callers, and missing chats (no existence leak)', () => {
    expect(chatReadAccessGranted({ userId: 'u2', access: 'none', exists: true })).toBe(false);
    expect(chatReadAccessGranted({ userId: null, access: 'owner', exists: true })).toBe(false);
    expect(chatReadAccessGranted({ userId: undefined, access: 'read', exists: true })).toBe(false);
    expect(chatReadAccessGranted({ userId: 'u1', access: 'owner', exists: false })).toBe(false);
  });
});

describe('streamAccessDeniedError (2026-07-23 stale-cookie regression)', () => {
  it('anonymous arrival gets the actionable session-expired message + code', () => {
    for (const userId of [null, undefined, ''] as any[]) {
      expect(streamAccessDeniedError({ userId })).toEqual({
        message: STREAM_AUTH_REQUIRED_MESSAGE,
        code: STREAM_AUTH_REQUIRED_CODE,
      });
    }
  });

  it('authenticated but denied keeps the non-leaking Chat not found (no code)', () => {
    expect(streamAccessDeniedError({ userId: 'u2' })).toEqual({ message: 'Chat not found' });
  });

  // ── Ticket 7acaa7ba: the viewer denial must be ACTIONABLE ──
  it('an authenticated project VIEWER (read access) gets the view-access message, not Chat not found', () => {
    const out = streamAccessDeniedError({ userId: 'u2', access: 'read' });
    expect(out.code).toBe('STREAM_VIEWER');
    expect(out.message).toContain('view access');
    expect(out.message).toContain('editor');
    // No existence leak beyond membership the viewer already has.
    expect(out.message).not.toContain('Chat not found');
  });

  it('write/owner access never reaches the denial path, and access none stays Chat not found', () => {
    expect(streamAccessDeniedError({ userId: 'u2', access: 'none' })).toEqual({ message: 'Chat not found' });
    // Defensive: even if called with write/owner it degrades to the stranger shape.
    expect(streamAccessDeniedError({ userId: 'u2', access: 'write' }).message).toBe('Chat not found');
  });
});

describe('mapAttachmentForAgent', () => {
  it('returns {} when no attachment', () => {
    expect(mapAttachmentForAgent(undefined)).toEqual({});
  });

  it('maps a valid base64 image to userImages', () => {
    const out = mapAttachmentForAgent({ type: 'image', base64: PNG_B64, mimeType: 'image/png', filename: 'pic.png' } as any);
    expect(out.userImages).toHaveLength(1);
    expect(out.userImages![0]).toMatchObject({ mediaType: 'image/png', data: PNG_B64, name: 'pic.png' });
    expect(out.documentText).toBeUndefined();
  });

  it('drops an image whose bytes fail the sniff and explains in a note', () => {
    const out = mapAttachmentForAgent({ type: 'image', base64: NOT_IMAGE_B64, mimeType: 'image/png', filename: 'fake.png' } as any);
    expect(out.userImages).toBeUndefined();
    expect(out.documentText).toContain('could not be analyzed');
    expect(out.documentText).toContain('fake.png');
  });

  it('caps images at MAX_IMAGES and notes the overflow', () => {
    const extras = Array.from({ length: MAX_IMAGES }, (_, i) => ({ type: 'image', base64: PNG_B64, mimeType: 'image/png', filename: `x${i}.png` }));
    const out = mapAttachmentForAgent({ type: 'image', base64: PNG_B64, mimeType: 'image/png', filename: 'main.png', additionalFiles: extras } as any);
    expect(out.userImages).toHaveLength(MAX_IMAGES);
    expect(out.documentText).toContain('could not be analyzed');
  });

  it('maps extracted document text (>50 chars) into a bounded block', () => {
    const text = 'lorem ipsum dolor sit amet '.repeat(10); // >50 chars
    const out = mapAttachmentForAgent({ type: 'document', filename: 'doc.pdf', extractedText: text } as any);
    expect(out.userImages).toBeUndefined();
    expect(out.documentText).toContain('UPLOADED DOCUMENT CONTENT');
    expect(out.documentText).toContain('[doc.pdf]');
    expect(out.documentText).toContain(text.slice(0, 40));
    expect(out.documentText).toContain('END DOCUMENT');
  });

  it('ignores too-short extracted text', () => {
    const out = mapAttachmentForAgent({ type: 'document', filename: 'tiny.txt', extractedText: 'short' } as any);
    expect(out).toEqual({});
  });

  it('appends additionalFiles document text and truncates past 30K', () => {
    const big = 'x'.repeat(40000);
    const out = mapAttachmentForAgent({
      type: 'document', filename: 'big.pdf', extractedText: big,
      additionalFiles: [{ type: 'document', filename: 'extra.pdf', extractedText: 'extra doc text here' }],
    } as any);
    expect(out.documentText).toContain('document truncated');
    expect(out.documentText).not.toContain('[extra.pdf]'); // cut off by the 30K cap
  });

  it('combines images + document text in one result', () => {
    const out = mapAttachmentForAgent({
      type: 'image', base64: PNG_B64, mimeType: 'image/png', filename: 'scan.png',
      extractedText: 'a scanned document with plenty of extracted text content '.repeat(2),
    } as any);
    expect(out.userImages).toHaveLength(1);
    expect(out.documentText).toContain('UPLOADED DOCUMENT CONTENT');
  });
});

describe('roster 2026-10-06 A-4 — the council quota keys on the research LANE', () => {
  it('a turn-plan research lane holds a council slot even before the mode is rewritten; other lanes do not', () => {
    expect(decideChatGate({ mode: 'thinking', userId: 'u1', lane: 'research' })).toEqual({ action: 'agent', councilMode: true });
    expect(decideChatGate({ mode: 'thinking', userId: 'u1', lane: 'checked' })).toEqual({ action: 'agent', councilMode: false });
    expect(decideChatGate({ mode: 'browser_agent', userId: 'u1', lane: 'research' })).toEqual({ action: 'browser_agent' });
  });
});
