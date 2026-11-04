/**
 * Shared vision capability — describe an image with the IMAGE READER seat
 * (model role `vision_describe`; built-in default glm-5.3-flash on Z.AI, the
 * natively-multimodal member of the GLM-5 series). Extracted 2026-08-24 from
 * documents.controller.ts so the feedback-ticket pipeline
 * (feedback/feedback-images.ts) can reuse the SAME vision hop instead of
 * growing a second one.
 *
 * Model history: qwen-vl-max (DashScope) → gpt-5.6-luna (2026-08-24) →
 * glm-5.3-flash (owner wave 2026-09-03: native-vision cutover) → the
 * `vision_describe` SEAT (2026-09-22, owner: every model call admin-editable —
 * Account → Admin → Endpoints → Model roles → "Image reader"). The seat's
 * chain: its model, the admin's custom fallback, then the built-in default.
 *
 * Contract: returns the RAW description text (callers add their own framing —
 * the knowledge-base path wraps it in `[IMAGE: <filename>]`, the feedback
 * path caps it and inlines it into a dispatch brief). Throws when no provider
 * in the chain can be called (keyless), on an unsupported type, or when every
 * provider returned nothing — callers that must never fail (feedback dispatch)
 * wrap the call in try/catch and degrade.
 */

import { convertHeicToJpeg, isHeicMime } from './heic';
import { imageUrlPart, providerKeyMissing, resolveSeat, seatCompletion, seatProviderChain, warnSeatFailure } from './seat-call';

/** The Image reader seat's BUILT-IN default (exported so ensemble callers can
 *  label their injections; prefer resolveVisionDescribeModel() for the live one). */
export const VISION_UTILITY_MODEL = 'glm-5.3-flash';
export const VISION_DESCRIBE_ROLE = 'vision_describe';

/** The model id the Image reader seat runs RIGHT NOW (override or built-in). */
export async function resolveVisionDescribeModel(): Promise<string> {
  try {
    return (await resolveSeat(VISION_DESCRIBE_ROLE, VISION_UTILITY_MODEL)).provider.model;
  } catch {
    return VISION_UTILITY_MODEL;
  }
}

const DESCRIBE_PROMPT = `Analyze this image thoroughly for use as reference material in a knowledge base. Include:
- A comprehensive description of what is shown
- Any text visible in the image (transcribed exactly, word for word)
- Charts, graphs, tables: describe the data completely with all values
- Diagrams, screenshots, UI elements: describe in detail
- Key details, labels, numbers, dates, measurements
- The overall context and purpose of the image

File: `;

// glm-5.3-flash REASONS before answering (prod probe MP0903: 96/100 tokens
// went to reasoning on a trivial image) — the budget must cover thinking +
// the full description or the description gets truncated.
const DESCRIBE_MAX_TOKENS = 4000;
const DESCRIBE_TIMEOUT_MS = 45_000;

export async function describeImageWithVision(
  buffer: Buffer,
  mimeType: string,
  filename: string,
): Promise<string> {
  // HEIC/HEIF (owner report 2026-09-03): iPhone uploads arrive as .heic and
  // vision endpoints reject the format outright — convert to JPEG for the hop
  // (pure-JS/WASM heic-convert). Only a decoder failure keeps the old
  // "convert first" error (a genuinely unreadable file, honestly reported).
  if (isHeicMime(mimeType)) {
    const jpeg = await convertHeicToJpeg(buffer);
    if (!jpeg) throw new Error('HEIC/HEIF images are not supported. Please convert to JPEG or PNG first.');
    buffer = jpeg;
    mimeType = 'image/jpeg';
  }
  const base64 = buffer.toString('base64');
  const messages = [{
    role: 'user',
    content: [
      imageUrlPart(mimeType, base64),
      { type: 'text', text: `${DESCRIBE_PROMPT}${filename}` },
    ],
  }];

  const chain = await seatProviderChain(VISION_DESCRIBE_ROLE, VISION_UTILITY_MODEL, { requiresVision: true });
  let lastError: Error | null = null;
  for (const provider of chain) {
    const keyless = providerKeyMissing(provider);
    if (keyless) { lastError = new Error(`Image reader seat: ${keyless}`); continue; }
    try {
      const r = await seatCompletion(provider, messages, { maxTokens: DESCRIBE_MAX_TOKENS, timeoutMs: DESCRIBE_TIMEOUT_MS });
      if (r.text) return r.text;
      lastError = new Error(`Image reader seat: ${provider.model} returned no description${r.hadReasoning ? ' (it spent the budget reasoning)' : ''}`);
    } catch (err: any) {
      warnSeatFailure(VISION_DESCRIBE_ROLE, provider, err);
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }
  throw lastError ?? new Error('No description could be extracted from the image');
}

// ── Question-directed reading (2026-10-01, the coding `view_image` tool) ─────
// The TB 2.1 chess-best-move trial: a text-only coding lead (glm-5.3) was told
// to find the best move from /app/chess_board.png, had no way to SEE the
// image, and spent ~2 h building pixel template matchers that misread the
// board. answerImageQuestion asks the SAME Image reader seat chain a precise
// question instead of the knowledge-base description above: transcribe text
// exactly, read grids / boards / tables cell by cell with coordinates, and
// say what is uncertain instead of guessing.

const QUESTION_PROMPT = `You are the eyes of an agent that cannot see this image. Answer the question below precisely, from what is VISIBLE in the image.
Rules:
- Transcribe any text exactly, character for character (case, punctuation, numbers, units).
- For a grid, board, table, chart or diagram: give a cell-by-cell (element-by-element) reading with explicit coordinates — rows and columns, or the image's own labels (for example chess squares a1-h8, spreadsheet cells A1) — and state the orientation you used (which side or corner is which).
- Count carefully and list every item; do not summarize a list you were asked to read.
- When something is unclear, ambiguous, cropped or too small to read, say exactly what is uncertain and give the plausible alternatives — never guess silently.

Question: `;

/** Default question when the caller passes none. */
export const DEFAULT_IMAGE_QUESTION = 'Describe this image in full detail, transcribing any text exactly.';

// Generous on purpose: the seat model REASONS before answering (see
// DESCRIBE_MAX_TOKENS above), and a cell-by-cell reading of a board or a
// table is long — 4k would truncate it. 180 s per provider in the chain.
export const ANSWER_MAX_TOKENS = 16_000;
export const ANSWER_TIMEOUT_MS = 180_000;

export interface ImageAnswer {
  /** The answer prose. */
  answer: string;
  /** The model id that answered (the seat's own, its custom fallback, or the built-in). */
  model: string;
}

export interface AnswerImageQuestionOpts {
  userId?: string;
  maxTokens?: number;
  timeoutMs?: number;
}

/**
 * Ask the Image reader seat a QUESTION about an image. Same seat chain and
 * contract as describeImageWithVision (HEIC converted to JPEG first; throws
 * when no provider in the chain can be called, or every provider failed or
 * answered nothing), but returns the model that answered with the text.
 */
export async function answerImageQuestion(
  buffer: Buffer,
  mimeType: string,
  filename: string,
  question: string,
  opts: AnswerImageQuestionOpts = {},
): Promise<ImageAnswer> {
  if (isHeicMime(mimeType)) {
    const jpeg = await convertHeicToJpeg(buffer);
    if (!jpeg) throw new Error('HEIC/HEIF image could not be decoded. Convert it to JPEG or PNG first.');
    buffer = jpeg;
    mimeType = 'image/jpeg';
  }
  const q = String(question || '').trim() || DEFAULT_IMAGE_QUESTION;
  const messages = [{
    role: 'user',
    content: [
      imageUrlPart(mimeType, buffer.toString('base64')),
      { type: 'text', text: `${QUESTION_PROMPT}${q}\n\nFile: ${filename}` },
    ],
  }];

  const maxTokens = opts.maxTokens ?? ANSWER_MAX_TOKENS;
  const timeoutMs = opts.timeoutMs ?? ANSWER_TIMEOUT_MS;
  const chain = await seatProviderChain(VISION_DESCRIBE_ROLE, VISION_UTILITY_MODEL, { ...(opts.userId ? { userId: opts.userId } : {}), requiresVision: true });
  let lastError: Error | null = null;
  for (const provider of chain) {
    const keyless = providerKeyMissing(provider);
    if (keyless) { lastError = new Error(`Image reader seat: ${keyless}`); continue; }
    try {
      // keepThinking: a precise reading benefits from the model's reasoning
      // (DeepSeek built-ins otherwise pin thinking off on bounded seats).
      const r = await seatCompletion(provider, messages, { maxTokens, timeoutMs, keepThinking: true });
      if (r.text) return { answer: r.text, model: provider.model };
      lastError = new Error(`Image reader seat: ${provider.model} returned no answer${r.hadReasoning ? ' (it spent the budget reasoning)' : ''}`);
    } catch (err: any) {
      warnSeatFailure(VISION_DESCRIBE_ROLE, provider, err);
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }
  throw lastError ?? new Error('No answer could be extracted from the image');
}
