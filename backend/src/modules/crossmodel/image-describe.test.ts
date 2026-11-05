/**
 * image-describe.ts — answerImageQuestion (2026-10-01, the coding view_image
 * tool): the SAME Image reader seat chain as describeImageWithVision, a
 * question-directed prompt, a generous budget (16k tokens / 180 s per
 * provider — the seat model reasons first), and the answering model named.
 * describeImageWithVision keeps its own prompt and 4k / 45 s budget.
 */

const mockSeatProviderChain: jest.Mock = jest.fn();
const mockSeatCompletion: jest.Mock = jest.fn();
const mockProviderKeyMissing: jest.Mock = jest.fn(() => null);
const mockWarnSeatFailure: jest.Mock = jest.fn();
jest.mock('./seat-call', () => ({
  __esModule: true,
  seatProviderChain: (...a: any[]) => mockSeatProviderChain(...a),
  seatCompletion: (...a: any[]) => mockSeatCompletion(...a),
  providerKeyMissing: (...a: any[]) => mockProviderKeyMissing(...a),
  warnSeatFailure: (...a: any[]) => mockWarnSeatFailure(...a),
  imageUrlPart: (mime: string, b64: string) => ({ type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } }),
  resolveSeat: jest.fn(),
}));
const mockConvertHeic: jest.Mock = jest.fn();
jest.mock('./heic', () => ({
  __esModule: true,
  convertHeicToJpeg: (...a: any[]) => mockConvertHeic(...a),
  isHeicMime: (m: string) => m === 'image/heic' || m === 'image/heif',
}));

import { answerImageQuestion, describeImageWithVision, ANSWER_MAX_TOKENS, ANSWER_TIMEOUT_MS, DEFAULT_IMAGE_QUESTION } from './image-describe';

const SEAT = { model: 'glm-5.3-flash', label: 'Z.AI', url: 'https://api.z.ai/x', apiKey: 'k' };
const FALLBACK = { model: 'cql-vision', label: 'cql', url: 'https://llm.cql.ca/v1/chat/completions', apiKey: '' };
const ok = (text: string) => ({ text, reasoning: '', toolCalls: [], finishReason: 'stop', hadReasoning: false });
const textOf = (call: any[]): string => call[1][0].content[1].text;

beforeEach(() => {
  jest.clearAllMocks();
  mockProviderKeyMissing.mockImplementation(() => null);
  mockSeatProviderChain.mockResolvedValue([SEAT, FALLBACK]);
});

describe('answerImageQuestion', () => {
  it('asks the Image reader seat a question-directed prompt with the generous budget and names the model', async () => {
    mockSeatCompletion.mockResolvedValueOnce(ok('a8 black rook, e1 white king'));
    const r = await answerImageQuestion(Buffer.from('png-bytes'), 'image/png', 'chess_board.png', 'list every piece and its square', { userId: 'u1' });
    expect(r).toEqual({ answer: 'a8 black rook, e1 white king', model: 'glm-5.3-flash' });
    expect(mockSeatProviderChain).toHaveBeenCalledWith('vision_describe', 'glm-5.3-flash', { userId: 'u1', requiresVision: true });
    const call = mockSeatCompletion.mock.calls[0];
    expect(call[0]).toBe(SEAT);
    expect(call[1][0].content[0].image_url.url).toBe(`data:image/png;base64,${Buffer.from('png-bytes').toString('base64')}`);
    const text = textOf(call);
    expect(text).toMatch(/cell-by-cell/);
    expect(text).toMatch(/Transcribe any text exactly/);
    expect(text).toMatch(/say exactly what is uncertain/);
    expect(text).toMatch(/Question: list every piece and its square\n\nFile: chess_board\.png$/);
    expect(call[2]).toEqual({ maxTokens: ANSWER_MAX_TOKENS, timeoutMs: ANSWER_TIMEOUT_MS, keepThinking: true });
    expect(ANSWER_MAX_TOKENS).toBe(16_000);
    expect(ANSWER_TIMEOUT_MS).toBe(180_000);
  });

  it('an empty question falls back to the full-detail default', async () => {
    mockSeatCompletion.mockResolvedValueOnce(ok('desc'));
    await answerImageQuestion(Buffer.from('x'), 'image/jpeg', 'a.jpg', '   ');
    expect(textOf(mockSeatCompletion.mock.calls[0])).toContain(`Question: ${DEFAULT_IMAGE_QUESTION}`);
    expect(mockSeatProviderChain).toHaveBeenCalledWith('vision_describe', 'glm-5.3-flash', { requiresVision: true });
  });

  it('walks the chain: a failing or empty provider falls through, and the answering one is named', async () => {
    mockSeatCompletion
      .mockRejectedValueOnce(Object.assign(new Error('HTTP 429'), { response: { status: 429 } }))
      .mockResolvedValueOnce(ok('from the fallback'));
    const r = await answerImageQuestion(Buffer.from('x'), 'image/webp', 'a.webp', 'q');
    expect(r).toEqual({ answer: 'from the fallback', model: 'cql-vision' });
    expect(mockWarnSeatFailure).toHaveBeenCalledTimes(1);
  });

  it('a keyless provider is skipped; every provider failing throws the last error', async () => {
    mockProviderKeyMissing.mockImplementation((p: any) => (p === SEAT ? 'glm-5.3-flash needs the ZAI_API_KEY environment variable' : null));
    mockSeatCompletion.mockResolvedValueOnce({ ...ok(''), hadReasoning: true });
    await expect(answerImageQuestion(Buffer.from('x'), 'image/png', 'a.png', 'q'))
      .rejects.toThrow('Image reader seat: cql-vision returned no answer (it spent the budget reasoning)');
    expect(mockSeatCompletion).toHaveBeenCalledTimes(1); // the keyless seat was never called
    mockSeatProviderChain.mockResolvedValueOnce([SEAT]);
    await expect(answerImageQuestion(Buffer.from('x'), 'image/png', 'a.png', 'q'))
      .rejects.toThrow('Image reader seat: glm-5.3-flash needs the ZAI_API_KEY environment variable');
  });

  it('HEIC converts to JPEG first; an undecodable HEIC throws before any model call', async () => {
    mockConvertHeic.mockResolvedValueOnce(Buffer.from('jpeg-bytes'));
    mockSeatCompletion.mockResolvedValueOnce(ok('a photo'));
    await answerImageQuestion(Buffer.from('heic-bytes'), 'image/heic', 'IMG.HEIC', 'q');
    expect(mockSeatCompletion.mock.calls[0][1][0].content[0].image_url.url).toBe(`data:image/jpeg;base64,${Buffer.from('jpeg-bytes').toString('base64')}`);
    mockConvertHeic.mockResolvedValueOnce(null);
    await expect(answerImageQuestion(Buffer.from('bad'), 'image/heif', 'x.heif', 'q')).rejects.toThrow(/HEIC\/HEIF image could not be decoded/);
  });
});

describe('describeImageWithVision is unchanged', () => {
  it('keeps the knowledge-base prompt and its 4k / 45 s budget', async () => {
    mockSeatCompletion.mockResolvedValueOnce(ok('a description'));
    expect(await describeImageWithVision(Buffer.from('x'), 'image/png', 'kb.png')).toBe('a description');
    const call = mockSeatCompletion.mock.calls[0];
    expect(textOf(call)).toMatch(/^Analyze this image thoroughly for use as reference material in a knowledge base\./);
    expect(textOf(call)).toMatch(/File: kb\.png$/);
    expect(call[2]).toEqual({ maxTokens: 4000, timeoutMs: 45_000 });
    expect(mockSeatProviderChain).toHaveBeenCalledWith('vision_describe', 'glm-5.3-flash', { requiresVision: true });
  });
});
