/**
 * Agentic-only chat gate (agentic-only cutover, 2026-07-23).
 *
 * EVERY non-kids, non-browser_agent chat request now runs the agent engine —
 * all patience modes (single_thinking / thinking / deep_research /
 * deep_research_all), both model sets, anonymous AND logged-in, with or
 * without attachments. This module holds the pure decision + attachment
 * mapping logic so streamQuery stays a thin HTTP layer (and the rules are
 * unit-testable without the controller's import graph).
 *
 * Kids (qwen-kid) and browser_agent are routed BEFORE this gate and never
 * reach it; council modes additionally enforce the daily quota at the
 * call site (reserveDeepResearchQuota — not pure, so it stays in the
 * controller). Guests (owner 2026-09-23) may run council modes too; the
 * controller keys their quota on the client IP (anonymous daily limit).
 */

import { validateImages, MAX_IMAGES, type ChatImage } from '../coding/chat-images';
import type { Attachment } from '../upload.controller';

export type ChatGateDecision =
  | { action: 'agent'; councilMode: boolean }
  | { action: 'browser_agent' }
  | { action: 'auth_required'; code: string; message: string };

/**
 * Where does this chat request go? Anything that returns 'agent' runs the
 * agent engine — there is no legacy fall-through anymore. Council modes
 * (deep_research / deep_research_all) set councilMode so the controller
 * reserves the daily quota (per user, or per client IP for guests — owner
 * 2026-09-23 opened deep research to signed-out visitors).
 */
export function decideChatGate(args: { mode: string; userId: string | null | undefined; lane?: 'quick' | 'standard' | 'checked' | 'research' | null }): ChatGateDecision {
  if (args.mode === 'browser_agent') return { action: 'browser_agent' };
  // Roster 2026-10-06 A-4: the council quota keys on the research LANE (a turn-plan-routed send) as well as a Level 3
  // mode (stored / explicit / keyword / a research rung) — the reserve below the gate runs for either.
  const councilMode = args.lane === 'research' || args.mode === 'deep_research' || args.mode === 'deep_research_all';
  return { action: 'agent', councilMode };
}

/**
 * H1 (adversarial review 2026-07-23): may this caller run (and persist into)
 * this chat? A chatId on the stream request asserts WRITE access — the agent
 * persists user/assistant rows under it. Mirrors
 * crossModelService.updateChat's requiredAccess='write': the owner or a
 * project editor/admin. A project member CAN legitimately send messages in a
 * shared chat (the frontend has no read-only send gate), but a project VIEWER
 * may only read. Anonymous callers can never own a chat — their history lives
 * in the Redis session store. Pure decision; the prisma lookup (getChatAccess)
 * stays in the controller.
 */
export function chatWriteAccessGranted(args: {
  userId?: string | null;
  access: 'none' | 'read' | 'write' | 'owner';
  exists: boolean;
}): boolean {
  if (!args.userId) return false;
  if (!args.exists) return false;
  return args.access === 'owner' || args.access === 'write';
}

/**
 * READ-level counterpart (P5 audit): may this caller OBSERVE this chat's run
 * state (GET /agent/active — the queued-drain watch's poll)? Any project
 * member qualifies, viewers included: members can queue messages into a
 * shared chat (chatWriteAccessGranted above), so an owner-only answer here
 * read as "idle" to them and cleared the Queued badge before the answer
 * existed. Pure decision; the prisma lookup (getChatAccess) stays in the
 * controller.
 */
export function chatReadAccessGranted(args: {
  userId?: string | null;
  access: 'none' | 'read' | 'write' | 'owner';
  exists: boolean;
}): boolean {
  if (!args.userId) return false;
  if (!args.exists) return false;
  return args.access !== 'none';
}

/**
 * Error payload when chatWriteAccessGranted denies a stream. Distinguishes the
 * two real-world causes so the user gets an ACTIONABLE message:
 *  - no userId on the request: the SSE GET arrived anonymous — almost always a
 *    stale/missing cm_access cookie for a signed-in user (2026-07-23 "Chat not
 *    found" regression: the cookie holds a 15m JWT re-set only at login/
 *    refresh, so idle sessions silently lost stream auth). The message is
 *    UNIFORM for every chatId, so it leaks nothing about chat existence.
 *  - authenticated but not owner/editor: keep the original non-leaking 404.
 */
export const STREAM_AUTH_REQUIRED_CODE = 'STREAM_AUTH_REQUIRED';
export const STREAM_AUTH_REQUIRED_MESSAGE =
  'Your sign-in session expired — please sign in again to continue this chat.';
/** Ticket 7acaa7ba: a project VIEWER (read access) who tries to send. */
export const STREAM_VIEWER_CODE = 'STREAM_VIEWER';
export const STREAM_VIEWER_MESSAGE =
  'You have view access to this chat (viewer on its project). Ask the project owner for editor access to send messages.';

export function streamAccessDeniedError(args: {
  userId?: string | null;
  /** The getChatAccess verdict — 'read' (a viewer member) gets an actionable message. */
  access?: 'none' | 'read' | 'write' | 'owner';
}): { message: string; code?: string } {
  if (!args.userId) {
    return { message: STREAM_AUTH_REQUIRED_MESSAGE, code: STREAM_AUTH_REQUIRED_CODE };
  }
  // Ticket 7acaa7ba: an authenticated VIEWER was told 'Chat not found' while
  // the chat was open in front of them — indistinguishable from a broken link.
  // They ARE a member (read access), so no existence is leaked by saying so.
  if (args.access === 'read') {
    return { message: STREAM_VIEWER_MESSAGE, code: STREAM_VIEWER_CODE };
  }
  return { message: 'Chat not found' };
}

export interface AgentAttachment {
  /** Validated images for the CURRENT user turn (vision models only). */
  userImages?: ChatImage[];
  /** Extracted document/PDF text block appended to the agent's user message. */
  documentText?: string;
}

/**
 * Map the controller's combined Attachment (upload.controller.loadAttachment)
 * onto agent-run inputs:
 *   - base64 images → ChatImage[] (validated per coding/chat-images.ts caps;
 *     images that fail validation are dropped with a transparency note),
 *   - extracted document/PDF text → one text block (mirrors the legacy
 *     synthesizeNode doc injection, 30K cap).
 */
export function mapAttachmentForAgent(attachment: Attachment | undefined): AgentAttachment {
  if (!attachment) return {};

  // ── Images ──
  const imageFiles = [attachment, ...(attachment.additionalFiles ?? [])]
    .filter(f => f.type === 'image' && f.base64)
    .slice(0, MAX_IMAGES * 2); // hard bound before per-image validation
  const userImages: ChatImage[] = [];
  const droppedImages: string[] = [];
  for (const f of imageFiles) {
    if (userImages.length >= MAX_IMAGES) { droppedImages.push(f.filename); continue; }
    const img: ChatImage = { mediaType: f.mimeType || '', data: f.base64!, name: f.filename };
    // Validate the ACCUMULATED set so the total-bytes cap is enforced too —
    // an offending image is dropped without sinking the rest.
    const candidate = [...userImages, img];
    const v = validateImages(candidate);
    if (v.ok) userImages.push(...v.images.slice(userImages.length));
    else droppedImages.push(f.filename);
  }

  // ── Document text (mirror of legacy query-pipeline synthesizeNode) ──
  let documentText: string | undefined;
  if (attachment.extractedText && attachment.extractedText.length > 50) {
    // Surface the uploadId (the stream controller sets it for single-upload
    // requests) so tool-calling models can pass it to fill_pdf_form.
    const upRef = attachment.uploadId ? ` (uploadId: ${attachment.uploadId})` : '';
    const docParts: string[] = [`[${attachment.filename}${upRef}]\n${attachment.extractedText}`];
    for (const extra of attachment.additionalFiles ?? []) {
      if (extra.extractedText && extra.extractedText.length > 10) {
        docParts.push(`[${extra.filename}]\n${extra.extractedText}`);
      }
    }
    const combinedDocText = docParts.join('\n\n');
    // 30K cap — the agent orchestrator context easily handles this; the legacy
    // 15K cap meant only ~30% of large documents was visible.
    const docForAgent = combinedDocText.length > 30000
      ? combinedDocText.substring(0, 30000) + `\n\n[… document truncated — ${combinedDocText.length} chars total]`
      : combinedDocText;
    documentText = `═══ UPLOADED DOCUMENT CONTENT (use as source of truth) ═══\n${docForAgent}\n═══ END DOCUMENT ═══`;
  }

  if (droppedImages.length > 0) {
    const note = `[Note: ${droppedImages.length} attached image(s) could not be analyzed (${droppedImages.join(', ')}) — if the user asks about them, explain the image format/size wasn't supported.]`;
    documentText = documentText ? `${documentText}\n\n${note}` : note;
  }

  return {
    ...(userImages.length ? { userImages } : {}),
    ...(documentText ? { documentText } : {}),
  };
}
