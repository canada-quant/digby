/**
 * Ticket 06d2886a (2026-10-12) — REPLAY: a computer-use vision seat whose
 * stored override no longer resolves must NOT fail open onto a text-only model.
 *
 * The incident: the computer_vision seat carried the override
 * `cql-litellm:api-optimize-alibaba-deepseek-v4.1-flash`; the CQL-Public
 * breach (2026-10-10/11) retired that endpoint, so resolveRoleModel returned
 * the dead spec verbatim, resolveProviderForRunInner's registry-miss fallback
 * called normalizeCodingModel on the UNKNOWN colon-spec → glm-5.3 (the
 * unknown-id default), and glm-5.3 is TEXT-ONLY — the first image_url part of
 * every computer_task dispatch earned "Request failed with status code 400"
 * at step 1, fleet-wide, while the admin save-guard (assertAssignable's
 * VISION_ROLES check) would have refused exactly that assignment.
 *
 * The fix (seat-call.ts):
 *   - resolveVisionSeat / seatProviderChain({requiresVision}) skip a KNOWN
 *     text-only provider that a DEAD SPEC failed open onto, falling back to
 *     the seat's custom fallback / built-in vision default (never skipping the
 *     seat's own configured built-in — that is the admin's explicit choice).
 *   - seatCompletion refuses to PUT image_url parts on the wire to a KNOWN
 *     text-only provider, throwing the admin-actionable message instead of
 *     the provider's opaque 400.
 *
 * These tests replay BOTH sides: the dead-override fail-open path now serves
 * the built-in vision default, and a text-only provider reached with images is
 * refused locally with the seat-picker's own guidance.
 */

jest.mock('axios', () => ({ __esModule: true, default: { post: jest.fn() } }));
jest.mock('../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
const mockResolveRoleModel = jest.fn(async (_r: string) => '');
const mockResolveRoleFallback = jest.fn(async (_r: string) => '');
jest.mock('./model-endpoints/model-roles.service', () => ({
  __esModule: true,
  resolveRoleModel: (...a: any[]) => mockResolveRoleModel(...(a as [string])),
  resolveRoleFallback: (...a: any[]) => mockResolveRoleFallback(...(a as [string])),
}));
// The registry resolves NOTHING for the dead CQL spec — that is the incident.
jest.mock('./model-endpoints/model-endpoints.service', () => ({
  __esModule: true,
  resolveRegistryModel: async () => null,
}));

import axios from 'axios';
import logger from '../../utils/logger';
import { resolveProvider } from './coding/coding-model';
import {
  imageUrlPart,
  providerKeyMissing,
  resolveSeat,
  resolveVisionSeat,
  seatCompletion,
  seatProviderChain,
} from './seat-call';

const mockedPost = axios.post as jest.Mock;
const ok = (message: any, finish = 'stop') => ({ data: { choices: [{ message, finish_reason: finish }] } });

/** The dead spec exactly as the incident left it on the computer_vision seat. */
const DEAD_CQL_SPEC = 'cql-litellm:api-optimize-alibaba-deepseek-v4.1-flash';

const ENV = ['ZAI_API_KEY', 'DEEPSEEK_API_KEY', 'MOONSHOT_API_KEY', 'DASHSCOPE_API_KEY'] as const;
let saved: Record<string, string | undefined> = {};
beforeEach(() => {
  jest.clearAllMocks();
  mockResolveRoleModel.mockResolvedValue('');
  mockResolveRoleFallback.mockResolvedValue('');
  saved = Object.fromEntries(ENV.map(k => [k, process.env[k]]));
  for (const k of ENV) process.env[k] = `sk-${k.toLowerCase()}`;
});
afterEach(() => { for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]!; } });

describe('ticket 06d2886a — dead vision-seat override fails open onto a text-only model', () => {
  it('REPLAY: the unresolvable CQL spec alone resolves to TEXT-ONLY glm-5.3 (the incident premise)', async () => {
    // What the run path did at 10:15Z on 2026-10-12: registry miss →
    // normalizeCodingModel(unknown colon-spec) → glm-5.3, which carries NO
    // supportsVision flag (coding-model.ts: GLM-5.3 flagship is TEXT-ONLY).
    mockResolveRoleModel.mockResolvedValue(DEAD_CQL_SPEC);
    const seat = await resolveSeat('computer_vision', 'deepseek-flash');
    expect(seat.spec).toBe(DEAD_CQL_SPEC);
    expect(seat.provider.model).toBe('glm-5.3');
    expect(seat.provider.supportsVision).not.toBe(true);
  });

  it('REPLAY: seatCompletion REFUSES to send image_url parts to the text-only provider instead of POSTing a 400', async () => {
    const glm = resolveProvider('glm-5.3');
    expect(glm.supportsVision).not.toBe(true);
    const messages = [{ role: 'user', content: [{ type: 'text', text: 'what is on screen?' }, imageUrlPart('image/png', 'QUJD')] }];
    await expect(seatCompletion(glm, messages, { maxTokens: 64, timeoutMs: 1000 }))
      .rejects.toThrow(/cannot serve this call: it does not accept inline images/);
    // Nothing reached the wire — the provider's opaque 400 never happens.
    expect(mockedPost).not.toHaveBeenCalled();
  });

  it('FIX: resolveVisionSeat serves the seat\'s built-in vision default when the override fails open onto a text-only model', async () => {
    mockResolveRoleModel.mockResolvedValue(DEAD_CQL_SPEC);
    mockResolveRoleFallback.mockResolvedValue('');
    const seat = await resolveVisionSeat('computer_vision', 'deepseek-flash');
    expect(seat.provider.model).toBe('deepseek-flash');       // the seat's own built-in default, vision-capable
    expect(seat.provider.supportsVision).toBe(true);
    expect(seat.spec).toBe('deepseek-flash');
    // The warn names the dead spec so an operator sees the config drift.
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining(DEAD_CQL_SPEC),
      expect.anything(),
    );
    // And the served provider actually completes a vision-shaped call.
    mockedPost.mockResolvedValueOnce(ok({ content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'click', arguments: '{"x":1,"y":2}' } }] }, 'tool_calls'));
    const r = await seatCompletion(seat.provider, [
      { role: 'user', content: [{ type: 'text', text: 'act' }, imageUrlPart('image/png', 'QUJD')] },
    ], { maxTokens: 64, timeoutMs: 1000, tools: [{ type: 'function', function: { name: 'click', description: 'd', parameters: { type: 'object', properties: {} } } }] });
    expect(r.toolCalls[0].name).toBe('click');
    expect(mockedPost).toHaveBeenCalledTimes(1);
  });

  it('FIX: the admin\'s custom fallback wins over the built-in default when it is vision-capable', async () => {
    mockResolveRoleModel.mockResolvedValue(DEAD_CQL_SPEC);
    mockResolveRoleFallback.mockResolvedValue('glm-5.3-flash');
    const seat = await resolveVisionSeat('computer_vision', 'deepseek-flash');
    expect(seat.provider.model).toBe('glm-5.3-flash');
    expect(seat.provider.supportsVision).toBe(true);
  });

  it('FIX: seatProviderChain({requiresVision}) drops the text-only fail-open head — the Image reader / PDF reader shape', async () => {
    mockResolveRoleModel.mockResolvedValue(DEAD_CQL_SPEC);
    mockResolveRoleFallback.mockResolvedValue('');
    const chain = await seatProviderChain('vision_describe', 'glm-5.3-flash', { requiresVision: true });
    // The glm-5.3 fail-open head is GONE; the built-in default remains.
    expect(chain.map(p => p.model)).toEqual(['glm-5.3-flash']);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining(DEAD_CQL_SPEC), expect.anything());
    // Without requiresVision the chain is unchanged (non-image seats keep the old behaviour).
    const plain = await seatProviderChain('vision_describe', 'glm-5.3-flash');
    expect(plain.map(p => p.model)).toEqual(['glm-5.3', 'glm-5.3-flash']);
  });

  it('NEVER skips the seat\'s OWN configured built-in — an admin who deliberately assigns glm-5.3-flash gets glm-5.3-flash', async () => {
    mockResolveRoleModel.mockResolvedValue('glm-5.3-flash'); // resolves cleanly, vision-capable
    const seat = await resolveVisionSeat('computer_vision', 'deepseek-flash');
    expect(seat.provider.model).toBe('glm-5.3-flash');
    expect(logger.warn).not.toHaveBeenCalled();
    // And a keyless built-in default is NOT swapped in silently by the vision path.
    mockResolveRoleModel.mockResolvedValue('deepseek-flash');
    delete process.env.DEEPSEEK_API_KEY;
    const keyless = await resolveVisionSeat('computer_vision', 'deepseek-flash');
    expect(keyless.provider.model).toBe('deepseek-flash');
    expect(providerKeyMissing(keyless.provider)).toContain('DEEPSEEK_API_KEY');
  });

  it('a vision-capable override is served untouched (no behaviour change for healthy seats)', async () => {
    mockResolveRoleModel.mockResolvedValue('deepseek-flash');
    const seat = await resolveVisionSeat('computer_vision', 'deepseek-flash');
    expect(seat.provider.model).toBe('deepseek-flash');
    expect(seat.spec).toBe('deepseek-flash');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('GENERALIZATION: a never-seen dead spec on a DIFFERENT vision seat is intercepted identically (capability-based, not string-matched), and the wire guard catches image parts in a LATER message position', async () => {
    // A synthetic retirement the ticket never named — proves the guard keys on
    // provider CAPABILITY, not on the literal cql-litellm string.
    mockResolveRoleModel.mockResolvedValue('retired-vendor:vision-pro-x9');
    mockResolveRoleFallback.mockResolvedValue('');
    const seat = await resolveVisionSeat('vision_describe', 'glm-5.3-flash');
    expect(seat.provider.model).toBe('glm-5.3-flash');   // the Image reader's own built-in vision default
    expect(seat.provider.supportsVision).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('retired-vendor:vision-pro-x9'), expect.anything());
    // Perturbed shape: image part arrives in a LATER user turn, after a
    // string-content user message and a null-content assistant turn.
    const glm = resolveProvider('glm-5.3');
    await expect(seatCompletion(glm, [
      { role: 'user', content: 'start' },
      { role: 'assistant', content: null },
      { role: 'user', content: [{ type: 'text', text: 'next screen' }, imageUrlPart('image/jpeg', 'QUJD')] },
    ], { maxTokens: 64, timeoutMs: 1000 })).rejects.toThrow(/does not accept inline images/);
    expect(mockedPost).not.toHaveBeenCalled();
  });
});
