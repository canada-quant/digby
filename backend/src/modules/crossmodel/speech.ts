/**
 * Speech — speech-to-text and text-to-speech on the ASR / TTS SEATS.
 *
 * 2026-09-22 (owner: no frontier models anywhere; every model call
 * admin-editable): replaces the OpenAI whisper-1 / tts-1 calls that lived in
 * integrations/openai.integration.ts (deleted).
 *
 * SPEECH-TO-TEXT — `transcribeAudio` (chat voice notes from browsers without
 * on-device recognition; the youtube_pipe audio fallback):
 *   1. the `asr` model-role override (a registered endpoint's OpenAI-compatible
 *      POST /audio/transcriptions) — resolved through the model-roles service's
 *      cached read (dynamic import, fail-open);
 *   2. the self-hosted STT service when STT_BASE_URL is set (Parakeet-TDT via
 *      achetronic/parakeet, OpenAI-compatible, CPU-only, no per-request cost;
 *      handles hour-scale YouTube audio);
 *   3. DashScope qwen3-asr-flash (DASHSCOPE_API_KEY) — the cloud safety net for
 *      short clips (the model takes ≤ 5 minutes / 10 MB of audio per request;
 *      verified live 2026-09-22: 241 s OK, 333 s → 400 "audio is too long").
 *   An earlier leg failing → warn + next leg; nothing left → the error surfaces.
 *
 * TEXT-TO-SPEECH — `textToSpeech` (the speaker button on transcripts; the Mac
 * app's voice mode plays the same bytes):
 *   1. the `tts` model-role override (OpenAI-compatible POST /audio/speech →
 *      audio bytes; mp3 requested);
 *   2. DashScope qwen3-tts-flash (built-in default): the multimodal-generation
 *      API returns a 24 kHz mono 16-bit WAV URL per request (24 h expiry);
 *      long answers are split at sentence boundaries into ≤600-character
 *      requests (the documented limit — 1200 chars produced garbled, repeated
 *      audio in the 2026-09-22 live test) and the WAV chunks are concatenated.
 */

import axios from 'axios';
import logger from '../../utils/logger';

const DASHSCOPE_MULTIMODAL_URL = 'https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';
/** OpenAI-compatible chat route — qwen3-asr-flash takes `input_audio` parts here (verified live 2026-09-22). */
const DASHSCOPE_COMPAT_CHAT_URL = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions';
/** Built-in DashScope speech models (intl / Singapore region). */
export const DASHSCOPE_ASR_MODEL = 'qwen3-asr-flash';
export const DASHSCOPE_TTS_MODEL = 'qwen3-tts-flash';
/** qwen3-tts-flash voice used when the caller names none (the old default was OpenAI's "nova"). */
export const DEFAULT_TTS_VOICE = 'Cherry';
/** Voice names an OpenAI-style caller may still send — mapped onto qwen3-tts-flash voices
 *  (48 voices exist: Cherry, Serena, Ethan, Chelsie, Momo, Vivian, Jennifer, Ryan, Katerina, …). */
const OPENAI_VOICE_MAP: Record<string, string> = {
  nova: 'Cherry', alloy: 'Serena', echo: 'Ethan', fable: 'Jennifer', onyx: 'Ryan', shimmer: 'Katerina',
};
/** qwen3-tts-flash text budget per request: 600 characters documented; longer
 *  input is accepted and billed but the audio degrades (live test 2026-09-22). */
const TTS_CHUNK_CHARS = 600;
/** 8 × 600 chars covers the controller's 4096-char read-aloud cap. */
const TTS_MAX_CHUNKS = 8;

// ── Seat resolution (asr / tts overrides are registry specs) ─────────────────

interface NonChatTarget { url: string; model: string; apiKey: string; spec: string }

/**
 * The `<role>` model-role override target, or null when the seat runs its
 * built-in default. Dynamic import + fail-open: a missing/broken config module
 * must never take speech down. Unresolvable specs (endpoint deleted/disabled/
 * renamed) fall back to the built-in chain with a warn.
 */
async function resolveNonChatRole(role: 'asr' | 'tts', pathSuffix: string): Promise<NonChatTarget | null> {
  let spec = '';
  try {
    const { getModelRoleOverrides } = await import('./model-endpoints/model-roles.service');
    spec = ((await getModelRoleOverrides()) as Record<string, string>)[role] ?? '';
    if (!spec) return null;
    const { resolveRegistryModel } = await import('./model-endpoints/model-endpoints.service');
    const reg = await resolveRegistryModel(spec);
    if (!reg) {
      logger.warn(`speech: ${role} role override "${spec}" no longer resolves — using the built-in chain`);
      return null;
    }
    return { url: `${reg.baseUrl}${pathSuffix}`, model: reg.model, apiKey: reg.apiKey ?? '', spec };
  } catch (err: any) {
    logger.warn(`speech: ${role} role config unreadable (${err?.message || err}) — using the built-in chain`);
    return null;
  }
}

// ── Speech-to-text ───────────────────────────────────────────────────────────

async function postTranscription(
  url: string,
  opts: { model: string; apiKey: string; timeoutMs: number },
  audioBuffer: Buffer,
  filename: string,
  mimeType: string,
): Promise<string> {
  const FormData = require('form-data');
  const form = new FormData();
  form.append('file', audioBuffer, { filename, contentType: mimeType });
  form.append('model', opts.model);
  form.append('response_format', 'text');

  const response = await axios.post(url, form, {
    headers: { 'Authorization': `Bearer ${opts.apiKey}`, ...form.getHeaders() },
    timeout: opts.timeoutMs,
    // Long-form transcripts (hour-scale videos) and their audio uploads must
    // not trip axios' default body limits.
    maxContentLength: 100 * 1024 * 1024,
    maxBodyLength: 200 * 1024 * 1024,
  });

  return typeof response.data === 'string'
    ? response.data.trim()
    : (response.data?.text || '').trim();
}

/** Normalize a browser/yt-dlp MIME to what DashScope names in a data URI. */
function asrDataUriMime(mimeType: string, filename: string): string {
  const m = (mimeType || '').toLowerCase().split(';')[0].trim();
  if (m && m !== 'application/octet-stream') return m;
  const ext = (filename.split('.').pop() || '').toLowerCase();
  const byExt: Record<string, string> = { wav: 'audio/wav', mp3: 'audio/mpeg', m4a: 'audio/mp4', webm: 'audio/webm', ogg: 'audio/ogg', flac: 'audio/flac', aac: 'audio/aac' };
  return byExt[ext] || 'audio/wav';
}

/** DashScope qwen3-asr-flash through the OpenAI-compatible chat route: the audio
 *  rides inline as a base64 data URI in an `input_audio` part; the transcript is
 *  the message content string. Formats verified live: wav, mp3, webm/opus,
 *  ogg/opus, m4a. ≤5 min / 10 MB per request. */
async function transcribeWithDashScope(audioBuffer: Buffer, filename: string, mimeType: string, apiKey: string): Promise<string> {
  const dataUri = `data:${asrDataUriMime(mimeType, filename)};base64,${audioBuffer.toString('base64')}`;
  const response = await axios.post(DASHSCOPE_COMPAT_CHAT_URL, {
    model: DASHSCOPE_ASR_MODEL,
    messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: dataUri } }] }],
    stream: false,
    asr_options: { enable_itn: false },
  }, {
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    timeout: 120_000,
    maxBodyLength: 20 * 1024 * 1024,
  });
  const content = response.data?.choices?.[0]?.message?.content;
  const text = typeof content === 'string'
    ? content
    : Array.isArray(content) ? content.map((c: any) => (typeof c?.text === 'string' ? c.text : '')).join('') : '';
  return text.trim();
}

/** What the built-in ASR chain would run on this instance (for status text). */
export function builtInAsrChain(): string[] {
  const legs: string[] = [];
  const sttBaseUrl = (process.env.STT_BASE_URL || '').trim();
  if (sttBaseUrl) legs.push(`self-hosted STT ${sttBaseUrl} (model ${(process.env.STT_MODEL || 'whisper-1').trim()})`);
  if (process.env.DASHSCOPE_API_KEY) legs.push(`DashScope ${DASHSCOPE_ASR_MODEL}`);
  return legs;
}

export interface TranscribeOpts {
  /** Probe-only: run the DashScope leg alone (no override, no self-hosted STT). */
  onlyDashScope?: boolean;
}

export async function transcribeAudio(audioBuffer: Buffer, filename: string, mimeType: string, opts?: TranscribeOpts): Promise<string> {
  const sttBaseUrl = opts?.onlyDashScope ? '' : (process.env.STT_BASE_URL || '').trim().replace(/\/+$/, '');
  const dashscopeKey = (process.env.DASHSCOPE_API_KEY || '').trim();
  const hasBuiltInLeg = !!sttBaseUrl || !!dashscopeKey;

  const override = opts?.onlyDashScope ? null : await resolveNonChatRole('asr', '/audio/transcriptions');
  if (override) {
    try {
      return await postTranscription(override.url, {
        model: override.model,
        apiKey: override.apiKey,
        // Self-hosted override servers can be CPU-only too: long YouTube audio
        // (≤45min) transcribes in minutes.
        timeoutMs: 600_000,
      }, audioBuffer, filename, mimeType);
    } catch (err: any) {
      if (!hasBuiltInLeg) throw err;
      logger.warn(`transcribeAudio: asr role override "${override.spec}" failed (${err?.message || err}) — falling back to the built-in STT chain`);
    }
  }
  if (sttBaseUrl) {
    try {
      return await postTranscription(`${sttBaseUrl}/audio/transcriptions`, {
        model: (process.env.STT_MODEL || 'whisper-1').trim(),
        apiKey: (process.env.STT_API_KEY || 'digby-local-stt').trim(),
        // Self-hosted CPU: long YouTube audio (≤45min) transcribes in minutes.
        timeoutMs: 600_000,
      }, audioBuffer, filename, mimeType);
    } catch (err: any) {
      if (!dashscopeKey) throw err;
      logger.warn(`transcribeAudio: STT service at ${sttBaseUrl} failed (${err?.message || err}) — falling back to DashScope ${DASHSCOPE_ASR_MODEL} (≤5 min of audio)`);
    }
  }
  if (dashscopeKey) return transcribeWithDashScope(audioBuffer, filename, mimeType, dashscopeKey);
  throw new Error('Speech-to-text is not configured on this instance: assign a model to the Speech-to-text (ASR) seat (Account → Admin → Endpoints → Model roles), set STT_BASE_URL (self-hosted STT), or set DASHSCOPE_API_KEY.');
}

/** True when SOME leg of speech-to-text can run here (gates the youtube_pipe slow path). */
export async function sttConfigured(): Promise<boolean> {
  if ((process.env.STT_BASE_URL || '').trim() || (process.env.DASHSCOPE_API_KEY || '').trim()) return true;
  return !!(await resolveNonChatRole('asr', '/audio/transcriptions'));
}

// ── Text-to-speech ───────────────────────────────────────────────────────────

export interface SpeechAudio { audio: Buffer; mimeType: string; model: string; voice: string }

/** Split read-aloud text at sentence boundaries into ≤ TTS_CHUNK_CHARS pieces (bounded count). */
export function splitForSpeech(text: string, chunkChars = TTS_CHUNK_CHARS, maxChunks = TTS_MAX_CHUNKS): string[] {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const sentences = clean.match(/[^.!?。！？]+[.!?。！？]+["')\]]*\s*|[^.!?。！？]+$/g) || [clean];
  const chunks: string[] = [];
  let cur = '';
  for (const s of sentences) {
    if ((cur + s).length > chunkChars && cur) {
      chunks.push(cur.trim());
      cur = '';
      if (chunks.length >= maxChunks) break;
    }
    if (s.length > chunkChars) {
      // A single run-on sentence longer than the budget: hard-split it.
      for (let i = 0; i < s.length && chunks.length < maxChunks; i += chunkChars) chunks.push(s.slice(i, i + chunkChars).trim());
      cur = '';
      continue;
    }
    cur += s;
  }
  if (cur.trim() && chunks.length < maxChunks) chunks.push(cur.trim());
  return chunks;
}

/** Concatenate same-format 16-bit PCM WAV buffers into one WAV (headers merged). */
export function concatWav(parts: Buffer[]): Buffer {
  if (!parts.length) throw new Error('No TTS audio chunks to join');
  if (parts.length === 1) {
    const only = parts[0];
    if (only.length < 44 || only.toString('ascii', 0, 4) !== 'RIFF') throw new Error('TTS chunk is not a WAV file');
    return only;
  }
  const dataChunks: Buffer[] = [];
  let header: Buffer | null = null;
  for (const buf of parts) {
    if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF') throw new Error('TTS chunk is not a WAV file');
    // Walk chunks to find 'data' (fmt may be followed by LIST etc.).
    let off = 12;
    let dataStart = -1; let dataLen = 0;
    while (off + 8 <= buf.length) {
      const id = buf.toString('ascii', off, off + 4);
      const len = buf.readUInt32LE(off + 4);
      if (id === 'data') { dataStart = off + 8; dataLen = Math.min(len, buf.length - dataStart); break; }
      off += 8 + len + (len % 2);
    }
    if (dataStart < 0) throw new Error('TTS WAV chunk has no data section');
    if (!header) header = buf.subarray(0, dataStart);
    dataChunks.push(buf.subarray(dataStart, dataStart + dataLen));
  }
  const data = Buffer.concat(dataChunks);
  const out = Buffer.concat([Buffer.from(header!), data]);
  out.writeUInt32LE(36 + data.length + (header!.length - 44), 4); // RIFF size
  out.writeUInt32LE(data.length, header!.length - 4);              // data size (the header ends with the data chunk header)
  return out;
}

/** One qwen3-tts-flash request → WAV bytes (the API returns a short-lived URL). */
async function synthesizeChunkWithDashScope(text: string, voice: string, apiKey: string): Promise<Buffer> {
  const response = await axios.post(DASHSCOPE_MULTIMODAL_URL, {
    model: DASHSCOPE_TTS_MODEL,
    input: { text, voice, language_type: 'Auto' }, // Auto = detect; also Chinese/English/German/…
  }, {
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    timeout: 60_000,
  });
  const audioUrl: string | undefined = response.data?.output?.audio?.url;
  const inlineB64: string | undefined = response.data?.output?.audio?.data;
  if (inlineB64) return Buffer.from(inlineB64, 'base64');
  if (!audioUrl) throw new Error(`DashScope ${DASHSCOPE_TTS_MODEL} returned no audio (${JSON.stringify(response.data?.output ?? response.data ?? {}).slice(0, 200)})`);
  const audio = await axios.get(audioUrl, { responseType: 'arraybuffer', timeout: 60_000 });
  return Buffer.from(audio.data);
}

/** Map a voice name (OpenAI-style or DashScope) onto the built-in DashScope voice. */
export function dashScopeVoice(voice?: string): string {
  const v = (voice || '').trim();
  if (!v) return DEFAULT_TTS_VOICE;
  const mapped = OPENAI_VOICE_MAP[v.toLowerCase()];
  return mapped || v;
}

/** How many qwen3-tts-flash requests may be in flight at once when the built-in
 *  DashScope voice synthesizes a long answer (ticket 2774d2b7: the old strict
 *  one-after-the-other loop spent ~14 s per 600-char chunk — a multi-paragraph
 *  answer took 50-130 s end-to-end and the client's 45 s timeout killed the
 *  spinner before any audio played). Concurrency is measured, not guessed: on
 *  2026-10-23 a live 4-wide wave of 590-char chunks answered 200 ×4 while an
 *  8-wide wave drew two 429s — 4 is the safe width for this key. Chunks keep
 *  their TEXT order in the joined audio regardless of completion order. */
const TTS_CHUNK_CONCURRENCY = 4;

/** Progressive synthesis (ticket 2774d2b7): synthesizes the answer's chunks with
 *  bounded concurrency and hands each one to `onChunk` — in TEXT order index —
 *  as soon as it is ready, so a streaming caller can flush audio to the browser
 *  while later chunks are still synthesizing. `onChunk` gets the chunk's TEXT
 *  index and the TOTAL chunk count (a client may play chunks out of completion
 *  order but must concatenate by index). Returns what served. */
export async function synthesizeSpeechProgressively(
  text: string,
  voice: string | undefined,
  opts: { dashscopeKey: string },
  onChunk: (part: { index: number; audio: Buffer; mimeType: string }, total: number) => Promise<void> | void,
): Promise<{ delivered: number; model: string; voice: string; mimeType: string }> {
  const input = text.slice(0, 4096);
  const override = await resolveNonChatRole('tts', '/audio/speech');
  const dashscopeKey = (opts.dashscopeKey || '').trim();
  if (override) {
    try {
      const response = await axios.post(override.url, {
        model: override.model,
        input,
        voice: (voice || '').trim() || 'alloy',
        response_format: 'mp3',
      }, {
        headers: { ...(override.apiKey ? { 'Authorization': `Bearer ${override.apiKey}` } : {}), 'Content-Type': 'application/json' },
        responseType: 'arraybuffer',
        timeout: 60_000,
      });
      const ct = String(response.headers?.['content-type'] || 'audio/mpeg').split(';')[0].trim();
      const audio = Buffer.from(response.data);
      await onChunk({ index: 0, audio, mimeType: ct.startsWith('audio/') ? ct : 'audio/mpeg' }, 1); // one piece — the client plays it alone
      return { delivered: 1, model: override.model, voice: (voice || '').trim() || 'alloy', mimeType: ct.startsWith('audio/') ? ct : 'audio/mpeg' };
    } catch (err: any) {
      if (!dashscopeKey) throw err;
      logger.warn(`textToSpeech: tts role override "${override.spec}" failed (${err?.message || err}) — falling back to DashScope ${DASHSCOPE_TTS_MODEL}`);
    }
  }
  if (!dashscopeKey) {
    throw new Error('Text-to-speech is not configured on this instance: assign a model to the Text-to-speech seat (Account → Admin → Endpoints → Model roles) or set DASHSCOPE_API_KEY.');
  }
  const dsVoice = dashScopeVoice(voice);
  const chunks = splitForSpeech(input);
  if (!chunks.length) throw new Error('Nothing to speak');
  let delivered = 0;
  let next = 0; // TEXT order — the emitted index the client concatenates by
  let firstErr: Error | null = null;
  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= chunks.length || firstErr) return;
      try {
        const audio = await synthesizeChunkWithDashScope(chunks[i], dsVoice, dashscopeKey);
        await onChunk({ index: i, audio, mimeType: 'audio/wav' }, chunks.length);
        delivered++;
      } catch (err: any) {
        // First failure stops the line (a 429 usually throttles the rest of the
        // wave too): record it, let the other workers drain their in-flight
        // chunks, then surface it after the loop.
        if (!firstErr) firstErr = err instanceof Error ? err : new Error(String(err));
        return;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(TTS_CHUNK_CONCURRENCY, chunks.length) }, worker));
  if (delivered === 0) {
    // Nothing arrived at all — the whole request failed; the caller reports it.
    throw firstErr ?? new Error('Text-to-speech produced no audio');
  }
  if (firstErr) {
    // Partial answer: what already arrived has been handed to onChunk; surface
    // the tail failure (flagged partial) so the caller can end the stream with
    // an error line instead of a silent short read.
    const partial = new Error(`Text-to-speech delivered ${delivered} of ${chunks.length} parts; the rest failed (${(firstErr as Error).message})`);
    (partial as Error & { partial?: boolean }).partial = true;
    throw partial;
  }
  return { delivered: chunks.length, model: DASHSCOPE_TTS_MODEL, voice: dsVoice, mimeType: 'audio/wav' };
}

export async function textToSpeech(text: string, voice?: string): Promise<SpeechAudio> {
  const parts: (Buffer | undefined)[] = [];
  const { model, voice: usedVoice, mimeType } = await synthesizeSpeechProgressively(
    text,
    voice,
    { dashscopeKey: process.env.DASHSCOPE_API_KEY || '' },
    (part) => { parts[part.index] = part.audio; },
  );
  const filled = parts.filter((p): p is Buffer => !!p);
  // Override leg: exactly one mp3 piece that plays alone; built-in leg: join the WAV chunks in text order.
  const audio = mimeType === 'audio/wav' ? concatWav(filled) : filled[0];
  return { audio, mimeType, model, voice: usedVoice };
}

export default { transcribeAudio, textToSpeech, sttConfigured };
