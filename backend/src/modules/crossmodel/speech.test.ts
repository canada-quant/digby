/**
 * speech.ts — the ASR / TTS seats' runtime (2026-09-22: replaces the OpenAI
 * whisper-1 / tts-1 client; NO frontier models).
 *
 * Pins:
 *   - transcribeAudio chain: asr override → self-hosted STT_BASE_URL → DashScope
 *     qwen3-asr-flash (OpenAI-compatible chat route, input_audio data URI);
 *     an earlier leg failing warns and falls to the next; nothing left → the
 *     error surfaces; a stale override is skipped with a warn; a config read
 *     failure is fail-open.
 *   - textToSpeech: tts override posts /audio/speech (mp3); the built-in
 *     default runs qwen3-tts-flash in ≤600-char sentence chunks and joins the
 *     WAVs; splitForSpeech / concatWav / dashScopeVoice are pure.
 *
 * axios is mocked at the module boundary; the model-roles + registry seams are
 * dynamically imported by speech.ts and mocked here (the real module pulls
 * config/database into the graph).
 */

jest.mock('axios', () => ({ __esModule: true, default: { post: jest.fn(), get: jest.fn() } }));
jest.mock('../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
const mockGetModelRoleOverrides = jest.fn();
jest.mock('./model-endpoints/model-roles.service', () => ({
  __esModule: true,
  getModelRoleOverrides: (...a: any[]) => mockGetModelRoleOverrides(...a),
}));
const mockResolveRegistryModel = jest.fn();
jest.mock('./model-endpoints/model-endpoints.service', () => ({
  __esModule: true,
  resolveRegistryModel: (...a: any[]) => mockResolveRegistryModel(...a),
}));

import axios from 'axios';
import logger from '../../utils/logger';
import { transcribeAudio, textToSpeech, synthesizeSpeechProgressively, splitForSpeech, concatWav, dashScopeVoice, sttConfigured, DASHSCOPE_ASR_MODEL, DASHSCOPE_TTS_MODEL } from './speech';

const mockedPost = axios.post as jest.Mock;
const mockedGet = axios.get as jest.Mock;
const mockWarn = logger.warn as jest.Mock;

const REG = {
  url: 'http://10.0.0.5:11434/v1/chat/completions',
  baseUrl: 'http://10.0.0.5:11434/v1',
  apiKey: 'sk-registry-secret',
  model: 'parakeet-tdt-0.6b-v3',
  label: 'my-stt',
  supportsVision: false,
  coding: false,
  matryoshka: false,
  thinkingOff: false,
};
const AUDIO = Buffer.from('fake-audio-bytes');
const COMPAT_CHAT = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions';
const MULTIMODAL = 'https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';

/** A minimal 16 kHz mono 16-bit WAV with `samples` zeroed samples. */
function wav(samples: number, fill = 0): Buffer {
  const dataLen = samples * 2;
  const buf = Buffer.alloc(44 + dataLen, fill);
  buf.write('RIFF', 0, 'ascii'); buf.writeUInt32LE(36 + dataLen, 4); buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii'); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(16000, 24); buf.writeUInt32LE(32000, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii'); buf.writeUInt32LE(dataLen, 40);
  return buf;
}

const ENV_KEYS = ['STT_BASE_URL', 'STT_MODEL', 'STT_API_KEY', 'DASHSCOPE_API_KEY'] as const;
let saved: Record<string, string | undefined> = {};
function setEnv(env: Record<string, string | undefined>) {
  for (const k of ENV_KEYS) { if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
}
beforeEach(() => {
  jest.resetAllMocks();
  mockGetModelRoleOverrides.mockResolvedValue({});
  mockResolveRegistryModel.mockResolvedValue(null);
  saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
  setEnv({});
});
afterEach(() => { setEnv(saved); });

describe('transcribeAudio — chain order', () => {
  it('asr override SET: posts multipart to the registry /audio/transcriptions with the registry model + key', async () => {
    setEnv({ STT_BASE_URL: 'http://localhost:5092/v1', DASHSCOPE_API_KEY: 'sk-dash' });
    mockGetModelRoleOverrides.mockResolvedValue({ asr: 'my-stt:parakeet-tdt-0.6b-v3' });
    mockResolveRegistryModel.mockResolvedValue(REG);
    mockedPost.mockResolvedValueOnce({ data: 'overridden transcript' });
    const text = await transcribeAudio(AUDIO, 'note.webm', 'audio/webm');
    expect(text).toBe('overridden transcript');
    expect(mockedPost).toHaveBeenCalledTimes(1);
    const [url, form, opts] = mockedPost.mock.calls[0];
    expect(url).toBe('http://10.0.0.5:11434/v1/audio/transcriptions');
    expect(opts.headers.Authorization).toBe('Bearer sk-registry-secret');
    expect(opts.timeout).toBe(600_000);
    const body = form.getBuffer().toString('binary');
    expect(body).toContain('name="model"');
    expect(body).toContain('parakeet-tdt-0.6b-v3');
    expect(body).toContain('name="file"; filename="note.webm"');
  });

  it('override FAILURE falls to the self-hosted STT leg with a warn', async () => {
    setEnv({ STT_BASE_URL: 'http://localhost:5092/v1', STT_MODEL: 'parakeet-env', DASHSCOPE_API_KEY: 'sk-dash' });
    mockGetModelRoleOverrides.mockResolvedValue({ asr: 'my-stt:parakeet-tdt-0.6b-v3' });
    mockResolveRegistryModel.mockResolvedValue(REG);
    mockedPost.mockRejectedValueOnce(new Error('ECONNREFUSED')).mockResolvedValueOnce({ data: { text: 'env-chain transcript' } });
    const text = await transcribeAudio(AUDIO, 'note.webm', 'audio/webm');
    expect(text).toBe('env-chain transcript');
    expect(mockedPost.mock.calls[0][0]).toBe('http://10.0.0.5:11434/v1/audio/transcriptions');
    expect(mockedPost.mock.calls[1][0]).toBe('http://localhost:5092/v1/audio/transcriptions');
    expect(mockedPost.mock.calls[1][2].headers.Authorization).toBe('Bearer digby-local-stt');
    expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining('asr role override "my-stt:parakeet-tdt-0.6b-v3" failed'));
  });

  it('self-hosted STT FAILURE falls to DashScope qwen3-asr-flash on the OpenAI-compatible chat route (input_audio data URI)', async () => {
    setEnv({ STT_BASE_URL: 'http://localhost:5092/v1', DASHSCOPE_API_KEY: 'sk-dash' });
    mockedPost.mockRejectedValueOnce(new Error('socket hang up')).mockResolvedValueOnce({ data: { choices: [{ message: { content: ' dashscope transcript ' } }] } });
    const text = await transcribeAudio(AUDIO, 'clip.m4a', 'audio/mp4');
    expect(text).toBe('dashscope transcript');
    const [url, body, opts] = mockedPost.mock.calls[1];
    expect(url).toBe(COMPAT_CHAT);
    expect(body.model).toBe(DASHSCOPE_ASR_MODEL);
    expect(body.messages[0].content[0].type).toBe('input_audio');
    expect(body.messages[0].content[0].input_audio.data).toBe(`data:audio/mp4;base64,${AUDIO.toString('base64')}`);
    expect(opts.headers.Authorization).toBe('Bearer sk-dash');
    expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining('falling back to DashScope qwen3-asr-flash'));
  });

  it('NO override, NO self-hosted STT: DashScope is the only leg; the MIME falls back to the filename extension', async () => {
    setEnv({ DASHSCOPE_API_KEY: 'sk-dash' });
    mockedPost.mockResolvedValueOnce({ data: { choices: [{ message: { content: 'hi' } }] } });
    expect(await transcribeAudio(AUDIO, 'voice.mp3', 'application/octet-stream')).toBe('hi');
    expect(mockedPost.mock.calls[0][1].messages[0].content[0].input_audio.data.startsWith('data:audio/mpeg;base64,')).toBe(true);
  });

  it('nothing configured at all → a clear error naming the three fixes; no request is made', async () => {
    await expect(transcribeAudio(AUDIO, 'note.webm', 'audio/webm')).rejects.toThrow(/Speech-to-text is not configured.*ASR.*STT_BASE_URL.*DASHSCOPE_API_KEY/);
    expect(mockedPost).not.toHaveBeenCalled();
  });

  it('override failure with NO built-in leg rethrows the override error', async () => {
    mockGetModelRoleOverrides.mockResolvedValue({ asr: 'my-stt:parakeet-tdt-0.6b-v3' });
    mockResolveRegistryModel.mockResolvedValue(REG);
    mockedPost.mockRejectedValueOnce(new Error('HTTP 500'));
    await expect(transcribeAudio(AUDIO, 'note.webm', 'audio/webm')).rejects.toThrow('HTTP 500');
    expect(mockedPost).toHaveBeenCalledTimes(1);
  });

  it('a stale override (no longer resolving) is skipped with a warn and the built-in chain serves', async () => {
    setEnv({ STT_BASE_URL: 'http://stt:5092/v1' });
    mockGetModelRoleOverrides.mockResolvedValue({ asr: 'ghost:model' });
    mockResolveRegistryModel.mockResolvedValue(null);
    mockedPost.mockResolvedValueOnce({ data: 'env transcript' });
    expect(await transcribeAudio(AUDIO, 'note.webm', 'audio/webm')).toBe('env transcript');
    expect(mockedPost.mock.calls[0][0]).toBe('http://stt:5092/v1/audio/transcriptions');
    expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining('"ghost:model" no longer resolves'));
  });

  it('a role-config read failure is fail-open: the built-in chain serves', async () => {
    setEnv({ STT_BASE_URL: 'http://stt:5092/v1' });
    mockGetModelRoleOverrides.mockRejectedValue(new Error('db down'));
    mockedPost.mockResolvedValueOnce({ data: 'env transcript' });
    expect(await transcribeAudio(AUDIO, 'note.webm', 'audio/webm')).toBe('env transcript');
    expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining('asr role config unreadable'));
  });

  it('an OTHER role override (embeddings) does not touch transcription', async () => {
    setEnv({ STT_BASE_URL: 'http://stt:5092/v1' });
    mockGetModelRoleOverrides.mockResolvedValue({ embeddings: 'my-embed:nomic' });
    mockedPost.mockResolvedValueOnce({ data: 'env transcript' });
    await transcribeAudio(AUDIO, 'note.webm', 'audio/webm');
    expect(mockResolveRegistryModel).not.toHaveBeenCalled();
  });

  it('sttConfigured: true with STT_BASE_URL or DASHSCOPE_API_KEY or an asr override; false when none', async () => {
    expect(await sttConfigured()).toBe(false);
    setEnv({ DASHSCOPE_API_KEY: 'sk-dash' });
    expect(await sttConfigured()).toBe(true);
    setEnv({});
    mockGetModelRoleOverrides.mockResolvedValue({ asr: 'my-stt:parakeet-tdt-0.6b-v3' });
    mockResolveRegistryModel.mockResolvedValue(REG);
    expect(await sttConfigured()).toBe(true);
  });
});

describe('synthesizeSpeechProgressively (ticket 2774d2b7 — the spinner that spins and dies)', () => {
  it('synthesizes chunks with bounded concurrency (never more than 4 in flight) and preserves TEXT order regardless of completion order', async () => {
    setEnv({ DASHSCOPE_API_KEY: 'sk-dash' });
    const text = Array.from({ length: 6 }, (_, i) => `Sentence block number ${i} with several more words in it right here today. `.repeat(12)).join('');
    const chunks = splitForSpeech(text);
    expect(chunks.length).toBeGreaterThanOrEqual(5); // enough to exercise the worker pool
    // Each chunk's synthesis is a deferred the TEST resolves LIFO (the MOST
    // RECENTLY registered first), so completion order is provably not text order.
    const deferreds = new Map<string, () => void>();
    let inFlight = 0;
    let maxInFlight = 0;
    mockedPost.mockImplementation(async (_url: string, body: any) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise<void>((resolve) => deferreds.set(body.input.text, resolve));
      inFlight--;
      return { data: { output: { audio: { url: `http://oss/${encodeURIComponent(body.input.text)}.wav` } } } };
    });
    mockedGet.mockResolvedValue({ data: wav(10) });
    const received: { index: number; total: number }[] = [];
    const synthesis = synthesizeSpeechProgressively(text, undefined, { dashscopeKey: 'sk-dash' }, (part, total) => {
      received.push({ index: part.index, total });
    });
    const pump = setInterval(() => {
      const keys = [...deferreds.keys()];
      const last = keys[keys.length - 1]; // LIFO drain — reverse-ish of text order
      if (last !== undefined) { deferreds.get(last)!(); deferreds.delete(last); }
    }, 5);
    const result = await synthesis;
    clearInterval(pump);
    expect(result.delivered).toBe(chunks.length);
    expect(result.model).toBe(DASHSCOPE_TTS_MODEL);
    expect(result.mimeType).toBe('audio/wav');
    expect(maxInFlight).toBeLessThanOrEqual(4); // the measured safe width — never exceeded
    expect(maxInFlight).toBeGreaterThanOrEqual(2); // concurrency actually happened (the latency fix)
    // every chunk delivered, each with the true total — order never lost
    expect(received.map(r => r.index).sort((a, b) => a - b)).toEqual(chunks.map((_, i) => i));
    expect(new Set(received.map(r => r.total))).toEqual(new Set([chunks.length]));
  });

  it('a mid-answer vendor failure keeps the already-delivered chunks and surfaces a PARTIAL error (never a silent short read)', async () => {
    setEnv({ DASHSCOPE_API_KEY: 'sk-dash' });
    // 3+ chunks: the first synthesis succeeds, every later one 429s.
    const text = Array.from({ length: 3 }, (_, i) => `Failing sentence number ${i} goes right here now. `.repeat(6)).join('');
    const chunks = splitForSpeech(text);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    let call = 0;
    mockedPost.mockImplementation(async () => {
      call++;
      if (call > 1) throw new Error('HTTP 429 throttled');
      return { data: { output: { audio: { url: 'http://oss/only.wav' } } } };
    });
    mockedGet.mockResolvedValue({ data: wav(10) });
    const got: number[] = [];
    await expect(synthesizeSpeechProgressively(text, undefined, { dashscopeKey: 'sk-dash' }, (part) => { got.push(part.index); }))
      .rejects.toThrow(/delivered 1 of \d+ parts.*429 throttled/);
    expect(got).toEqual([0]); // the chunk that DID succeed was handed over before the failure surfaced
  });

  it('every chunk failing throws the vendor error itself (nothing delivered → nothing to keep)', async () => {
    setEnv({ DASHSCOPE_API_KEY: 'sk-dash' });
    mockedPost.mockRejectedValue(new Error('HTTP 503 down'));
    await expect(synthesizeSpeechProgressively('One single sentence here.', undefined, { dashscopeKey: 'sk-dash' }, () => {}))
      .rejects.toThrow('HTTP 503 down');
  });

  it('the tts seat override still serves as ONE mp3 chunk (no WAV join)', async () => {
    setEnv({ DASHSCOPE_API_KEY: 'sk-dash' });
    mockGetModelRoleOverrides.mockResolvedValue({ tts: 'my-tts:kokoro' });
    mockResolveRegistryModel.mockResolvedValue({ ...REG, model: 'kokoro', label: 'my-tts' });
    mockedPost.mockResolvedValueOnce({ data: Buffer.from('MP3BYTES'), headers: { 'content-type': 'audio/mpeg' } });
    const got: { index: number; total: number; audio: Buffer }[] = [];
    const result = await synthesizeSpeechProgressively('Hello there.', 'nova', { dashscopeKey: 'sk-dash' }, (part, total) => { got.push({ ...part, total }); });
    expect(got).toHaveLength(1);
    expect(got[0].total).toBe(1);
    expect(got[0].audio.toString()).toBe('MP3BYTES');
    expect(result).toMatchObject({ delivered: 1, mimeType: 'audio/mpeg', model: 'kokoro' });
  });
});

describe('textToSpeech', () => {
  it('tts override: posts OpenAI-style /audio/speech (mp3) and returns the bytes with the served content-type', async () => {
    setEnv({ DASHSCOPE_API_KEY: 'sk-dash' });
    mockGetModelRoleOverrides.mockResolvedValue({ tts: 'my-tts:kokoro' });
    mockResolveRegistryModel.mockResolvedValue({ ...REG, model: 'kokoro', label: 'my-tts' });
    mockedPost.mockResolvedValueOnce({ data: Buffer.from('MP3BYTES'), headers: { 'content-type': 'audio/mpeg' } });
    const spoken = await textToSpeech('Hello there.', 'nova');
    expect(spoken.mimeType).toBe('audio/mpeg');
    expect(spoken.audio.toString()).toBe('MP3BYTES');
    expect(spoken.model).toBe('kokoro');
    const [url, body, opts] = mockedPost.mock.calls[0];
    expect(url).toBe('http://10.0.0.5:11434/v1/audio/speech');
    expect(body).toMatchObject({ model: 'kokoro', input: 'Hello there.', voice: 'nova', response_format: 'mp3' });
    expect(opts.responseType).toBe('arraybuffer');
  });

  it('built-in default: one qwen3-tts-flash request per ≤600-char chunk, WAV URLs fetched and joined into one WAV', async () => {
    setEnv({ DASHSCOPE_API_KEY: 'sk-dash' });
    const text = `${'First sentence number one is right here. '.repeat(16)}${'Second block sentence follows now. '.repeat(16)}`; // > 600 chars → several chunks
    const expectedChunks = splitForSpeech(text);
    expect(expectedChunks.length).toBeGreaterThanOrEqual(2);
    mockedPost.mockResolvedValue({ data: { output: { audio: { url: 'http://oss.example/a.wav', data: '' }, finish_reason: 'stop' } } });
    // First chunk 100 samples, every later chunk 50 samples.
    mockedGet.mockResolvedValueOnce({ data: wav(100, 1) });
    for (let i = 1; i < expectedChunks.length; i++) mockedGet.mockResolvedValueOnce({ data: wav(50, 2) });
    const spoken = await textToSpeech(text);
    expect(spoken.mimeType).toBe('audio/wav');
    expect(spoken.model).toBe(DASHSCOPE_TTS_MODEL);
    expect(spoken.voice).toBe('Cherry');
    expect(mockedPost).toHaveBeenCalledTimes(expectedChunks.length);
    for (const call of mockedPost.mock.calls) {
      expect(call[0]).toBe(MULTIMODAL);
      expect(call[1].model).toBe(DASHSCOPE_TTS_MODEL);
      expect(call[1].input.text.length).toBeLessThanOrEqual(600);
      expect(call[1].input.voice).toBe('Cherry');
    }
    // 44-byte header + the joined PCM — sizes rewritten.
    const pcmBytes = 200 + (expectedChunks.length - 1) * 100;
    expect(spoken.audio.length).toBe(44 + pcmBytes);
    expect(spoken.audio.readUInt32LE(40)).toBe(pcmBytes);
    expect(spoken.audio.readUInt32LE(4)).toBe(36 + pcmBytes);
  });

  it('override failure falls back to the DashScope voice with a warn', async () => {
    setEnv({ DASHSCOPE_API_KEY: 'sk-dash' });
    mockGetModelRoleOverrides.mockResolvedValue({ tts: 'my-tts:kokoro' });
    mockResolveRegistryModel.mockResolvedValue({ ...REG, model: 'kokoro', label: 'my-tts' });
    mockedPost.mockRejectedValueOnce(new Error('HTTP 503')).mockResolvedValueOnce({ data: { output: { audio: { url: 'http://oss/x.wav' } } } });
    mockedGet.mockResolvedValueOnce({ data: wav(10) });
    const spoken = await textToSpeech('Short.');
    expect(spoken.model).toBe(DASHSCOPE_TTS_MODEL);
    expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining('tts role override "my-tts:kokoro" failed'));
  });

  it('nothing configured → a clear error naming the fixes', async () => {
    await expect(textToSpeech('Hi')).rejects.toThrow(/Text-to-speech is not configured.*DASHSCOPE_API_KEY/);
  });
});

describe('pure helpers', () => {
  it('splitForSpeech keeps sentences whole under the budget and bounds the chunk count', () => {
    const chunks = splitForSpeech('One. Two. Three.', 8, 10);
    expect(chunks).toEqual(['One.', 'Two.', 'Three.']);
    expect(splitForSpeech('a'.repeat(1300), 600, 2)).toEqual(['a'.repeat(600), 'a'.repeat(600)]);
    expect(splitForSpeech('   ')).toEqual([]);
  });

  it('concatWav merges same-format PCM and rewrites the RIFF/data sizes; rejects non-WAV input', () => {
    const out = concatWav([wav(3, 1), wav(2, 2)]);
    expect(out.length).toBe(44 + 10);
    expect(out.readUInt32LE(40)).toBe(10);
    expect(out.subarray(44, 50).every(b => b === 1)).toBe(true);
    expect(out.subarray(50, 54).every(b => b === 2)).toBe(true);
    expect(() => concatWav([Buffer.from('not a wav file at all, really not')])).toThrow(/not a WAV/);
    expect(() => concatWav([wav(1), Buffer.from('<html>error page</html>')])).toThrow(/not a WAV/);
  });

  it('dashScopeVoice maps OpenAI voice names onto qwen3-tts-flash voices and passes DashScope names through', () => {
    expect(dashScopeVoice()).toBe('Cherry');
    expect(dashScopeVoice('nova')).toBe('Cherry');
    expect(dashScopeVoice('onyx')).toBe('Ryan');
    expect(dashScopeVoice('Serena')).toBe('Serena');
  });
});
