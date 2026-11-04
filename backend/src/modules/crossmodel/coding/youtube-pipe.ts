/**
 * youtube_pipe — the DETERMINISTIC YouTube ingestion pipeline (mirrors web_pipe).
 *
 * Answers often live in VIDEO content (talks, tutorials, interviews, lectures,
 * reviews) that scrape_as_markdown can't read. This tool runs the mechanics as
 * a harness pipeline with exactly ONE model call at the end — same doctrine as
 * web_pipe (reasoning decides WHEN to ingest; determinism does the WORK):
 *
 *   resolve videos (given YouTube urls, or search_engine: site:youtube.com <query>)
 *     → per video, in parallel (tolerant, per-video try/catch):
 *         FAST PATH  captions via youtubei.js (Innertube.getBasicInfo +
 *                    getTranscript) — one ~45s budget per video
 *         SLOW PATH  only when captions fail/are empty AND stt !== false AND the
 *                    STT service is configured: yt-dlp downloads the audio
 *                    (≤150m, 4-min timeout) and the shared STT client transcribes
 *                    it — the self-hosted open-source Parakeet service when
 *                    STT_BASE_URL is set (OpenAI-compatible endpoint), OpenAI
 *                    Whisper-1 otherwise. Videos > 45 min skip STT.
 *         LAST FALLBACK  BrightData web_data_youtube_videos dataset via the MCP
 *                    gateway (proxied — survives YouTube's datacenter-egress
 *                    bot-blocking that kills both direct tiers, ticket dbe1d975)
 *       → store transcripts into session RAG (storeFindings — the same store
 *         search_memory reads), header line + ≤24k chars per video
 *         → ONE Qwen 3.6 27B call: per-video key facts + index + suggested
 *           search_memory queries ("RAG directions")
 *
 * sessionId null = legacy pipeline callers (ToolCache): storage is skipped and
 * the digest omits search_memory hints — same contract as web_pipe.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import axios from 'axios';
import logger from '../../../utils/logger';
import { callMcpTool } from '../mcp-search';
import { webSearchStatus } from '../platform/instance-setup';
// serp-provider-guard is a PURE leaf (zero imports) — safe under the
// partial-factory jest.mock contract on ../mcp-search ({ callMcpTool } only).
import { serpProviderErrorDetail, type SerpProviderError } from '../serp-provider-guard';
import { unwrapSerpJsonText, unwrapSerpLinks } from '../serp-redirects';
import { storeFindings } from './coding-retrieval.service';
import { runHelperSeatCompletion } from './helper-seat';
import * as speech from '../speech';

const execFileAsync = promisify(execFile);

const MAX_VIDEOS = 4;
const CAPTIONS_TIMEOUT_MS = 45_000;
const YTDLP_TIMEOUT_MS = 240_000;          // 4 min wall-clock for the audio download
const MAX_STT_DURATION_SEC = 45 * 60;      // skip the STT slow path for very long videos
const MIN_TRANSCRIPT_CHARS = 50;           // below this a transcript counts as "no speech"
const SUMMARY_MODEL = 'qwen3.6-27b' as const;
// LAST fallback (ticket dbe1d975): YouTube bot-blocks datacenter egress for BOTH
// the caption endpoints (Innertube) and audio download (yt-dlp) — prod hit 100%
// transcript failure incl. a control video. BrightData's youtube dataset is
// fetched through its own proxy infra and often still carries the transcript.
// Dataset collection is slow — give it the full non-scrape budget.
const BRIGHTDATA_DATASET_TIMEOUT_MS = 90_000;

export interface YoutubePipeResult {
  ok: boolean;
  summary: string;
  /** The coding_helper seat spec that wrote the digest (absent on the
   *  index-only fallback) — attribution for the tool trailer. */
  model?: string;
  videos: Array<{
    url: string;
    videoId: string;
    title?: string;
    chars: number;
    method: 'captions' | 'stt' | 'brightdata' | 'failed';
    stored: boolean;
  }>;
  storedChunks: number;
}

/**
 * Pull the 11-char video id out of any YouTube URL shape we accept:
 * watch?v=, youtu.be/, /shorts/, /embed/, /live/ (and /v/). Returns null for
 * non-YouTube or unparseable input — the pipe silently drops those.
 */
export function extractVideoId(url: string): string | null {
  if (typeof url !== 'string' || !url.trim()) return null;
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.toLowerCase().replace(/^(www\.|m\.)/, '');
  const isYoutube = host === 'youtube.com' || host.endsWith('.youtube.com')
    || host === 'youtube-nocookie.com' || host.endsWith('.youtube-nocookie.com');
  let id: string | null = null;
  if (host === 'youtu.be') {
    id = u.pathname.split('/').filter(Boolean)[0] || null;
  } else if (isYoutube) {
    if (u.pathname === '/watch') {
      id = u.searchParams.get('v');
    } else {
      const m = u.pathname.match(/^\/(shorts|embed|live|v)\/([^/?&#]+)/);
      if (m) id = m[2];
    }
  }
  return id && /^[\w-]{11}$/.test(id) ? id : null;
}

/** Extract YouTube video links (deduped by video id) from the SERP JSON text
 *  search_engine returns — web_pipe's topLinks pattern, filtered to videos. */
export function youtubeLinksFromSerp(serpText: string, n: number): Array<{ url: string; videoId: string; title?: string }> {
  const out: Array<{ url: string; videoId: string; title?: string }> = [];
  const seen = new Set<string>();
  const push = (url: string, title?: any) => {
    if (out.length >= n) return;
    const videoId = extractVideoId(url);
    if (!videoId || seen.has(videoId)) return;
    seen.add(videoId);
    out.push({ url, videoId, title: typeof title === 'string' && title.trim() ? title.trim() : undefined });
  };
  try {
    const parsed = JSON.parse(serpText);
    const organic: any[] = Array.isArray(parsed?.organic) ? parsed.organic : [];
    for (const o of organic) {
      if (typeof o?.link === 'string' && /^https?:\/\//.test(o.link)) push(o.link, o.title);
    }
  } catch {
    // Non-JSON SERP (rare) — fall back to raw URL extraction.
    const urls = serpText.match(/https?:\/\/[^\s"'\\)\]}>]+/g) || [];
    for (const u of urls) push(u);
  }
  return out;
}

/** Join caption segments (TranscriptSegment nodes from youtubei.js) into plain
 *  text. Defensive: anything without a snippet (e.g. section headers) is skipped. */
export function transcriptSegmentsToText(segments: any[]): string {
  if (!Array.isArray(segments)) return '';
  const parts: string[] = [];
  for (const seg of segments) {
    const snippet = seg?.snippet;
    const raw = typeof snippet?.text === 'string' ? snippet.text : (snippet ? String(snippet) : '');
    const clean = raw.replace(/\s+/g, ' ').trim();
    if (clean) parts.push(clean);
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

/** One non-streaming summarizer call — the pipe's single model invocation.
 *  Runs the instance's coding_helper SEAT (model-roles config; default Qwen),
 *  so an Edge box without DashScope keys can point it at a custom endpoint.
 *  Reasoning-shaped built-ins are rejected for this seat at save time
 *  (model-roles NON_STREAMING_ROLES). Mirrors web-pipe.ts: the call goes through
 *  helper-seat.ts → helper-completion.ts (thinking-off for custom endpoints,
 *  closed + UNCLOSED <think> stripping, EMPTY answer THROWS → index-only
 *  fallback below) plus the seat HEALTH fallback (owner 2026-09-14): a custom
 *  seat that 4xx's, times out, is unreachable or answers empty is retried ONCE
 *  on the built-in helper, with an honest attribution line in the digest. */
async function qwenSummarize(prompt: string, timeoutMs = 60_000, sessionId?: string | null): Promise<{ text: string; model: string; attribution?: string }> {
  const r = await runHelperSeatCompletion({
    messages: [{ role: 'user', content: prompt }],
    maxTokens: 1400, temperature: 0.3, timeoutMs,
    caller: 'youtube_pipe', builtIn: SUMMARY_MODEL, sessionId: sessionId ?? undefined,
  });
  logger.info(`youtube_pipe: digest via ${r.model} (${r.label})${r.fallback ? ` — helper seat fallback from ${r.fallback.from}: ${r.fallback.reason}` : ''}`);
  return { text: r.text, model: r.model, attribution: r.attribution };
}

/** Race a promise against a wall-clock budget (clears its timer either way). */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => { if (timer) clearTimeout(timer); });
}

// youtubei.js session — created once per process, cached at module level. A
// failed create is NOT cached (next video retries with a fresh session).
type InnertubeClient = import('youtubei.js').Innertube;
let innertubePromise: Promise<InnertubeClient> | null = null;
function getInnertube(): Promise<InnertubeClient> {
  if (!innertubePromise) {
    // youtubei.js v18+ ships ESM ONLY — a static import would compile to a CJS
    // require() (module: commonjs) and crash under jest AND on prod's Node 20
    // (no require(esm) until 22.12). The Function-wrapped dynamic import below
    // survives the CJS transpile as a real import() (Node ≥ 12.17).
    const load = new Function('s', 'return import(s)') as (s: string) => Promise<typeof import('youtubei.js')>;
    innertubePromise = load('youtubei.js')
      .then(m => m.Innertube.create())
      .catch(err => { innertubePromise = null; throw err; });
  }
  return innertubePromise;
}

/** The STT slow path needs BOTH a LONG-FORM transcription endpoint and yt-dlp
 *  for the audio download. Long-form = the self-hosted STT service (Parakeet via
 *  STT_BASE_URL) or the admin's Speech-to-text (ASR) seat override — NOT the
 *  DashScope qwen3-asr-flash safety-net leg, which takes ≤3 minutes of audio
 *  per request and would fail on almost every video. (OpenAI whisper-1 left the
 *  chain 2026-09-22 — no frontier models.) */
async function sttConfigured(): Promise<boolean> {
  if ((process.env.STT_BASE_URL || '').trim()) return true;
  try {
    const { resolveRoleModel } = await import('../model-endpoints/model-roles.service');
    return !!(await resolveRoleModel('asr'));
  } catch {
    return false;
  }
}

// yt-dlp presence is detected once: ENOENT → warn once, disable the slow path
// for the rest of the process lifetime (no per-video retry spam).
let ytdlpMissing = false;

async function downloadAudio(url: string): Promise<{ buffer: Buffer; filename: string; mimeType: string } | null> {
  if (ytdlpMissing) return null;
  const bin = process.env.YTDLP_PATH || 'yt-dlp';
  const base = path.join(os.tmpdir(), `ytpipe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  try {
    await execFileAsync(bin, [
      '-f', 'bestaudio[ext=m4a]/bestaudio',
      '--max-filesize', '150m',
      '--no-playlist',
      '-o', `${base}.%(ext)s`,
      url,
    ], { timeout: YTDLP_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 });
  } catch (err: any) {
    if (err?.code === 'ENOENT') {
      ytdlpMissing = true;
      logger.warn('youtube_pipe: yt-dlp not installed — STT fallback disabled');
      return null;
    }
    throw err; // real download failure (timeout, geo-block, size cap) — the video fails, tolerated per-video
  }
  // The extension is format-dependent — find whatever file yt-dlp wrote.
  const written = (await fs.readdir(os.tmpdir())).find(f => f.startsWith(path.basename(base) + '.'));
  if (!written) throw new Error('yt-dlp produced no output file');
  const filePath = path.join(os.tmpdir(), written);
  try {
    const buffer = await fs.readFile(filePath);
    if (!buffer.length) throw new Error('yt-dlp produced an empty file');
    const ext = written.split('.').pop()?.toLowerCase() || '';
    const mimeType = ({ m4a: 'audio/mp4', mp3: 'audio/mpeg', webm: 'audio/webm', ogg: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav', flac: 'audio/flac' } as Record<string, string>)[ext] || 'application/octet-stream';
    return { buffer, filename: written, mimeType };
  } finally {
    await fs.unlink(filePath).catch(() => {});
  }
}

/**
 * Pull a transcript string out of one web_data_youtube_videos dataset record.
 * BrightData's YouTube dataset has carried the transcript under several field
 * names/shapes — handle plain string fields, segment arrays of {text}, and
 * plain string arrays. Returns '' when the record has none (honest absence).
 */
export function transcriptFromDatasetRecord(record: any): string {
  if (!record || typeof record !== 'object') return '';
  const candidates = [record.transcript, record.formatted_transcript, record.video_transcript, record.subtitles, record.captions];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.replace(/\s+/g, ' ').trim();
    if (Array.isArray(c)) {
      const parts = c
        .map((seg: any) => (typeof seg === 'string' ? seg : typeof seg?.text === 'string' ? seg.text : ''))
        .map(s => s.replace(/\s+/g, ' ').trim())
        .filter(Boolean);
      if (parts.length) return parts.join(' ').replace(/\s+/g, ' ').trim();
    }
  }
  return '';
}

/** BrightData-proxied transcript via the gateway's web_data_youtube_videos
 *  dataset tool. Returns null when the dataset is unavailable or carries no
 *  transcript — the video stays honestly 'failed'. */
async function brightDataTranscript(
  target: { url: string; videoId: string },
): Promise<{ text: string; title?: string } | null> {
  const raw = await callMcpTool(
    'web_data_youtube_videos',
    { url: `https://www.youtube.com/watch?v=${target.videoId}` },
    BRIGHTDATA_DATASET_TIMEOUT_MS,
  ).catch(() => null);
  if (typeof raw !== 'string' || !raw.trim()) return null;
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null; // dataset answered with non-JSON — nothing extractable
  }
  const records = Array.isArray(parsed) ? parsed : [parsed];
  for (const rec of records) {
    const text = transcriptFromDatasetRecord(rec);
    if (text.length >= MIN_TRANSCRIPT_CHARS) {
      const title = typeof rec?.title === 'string' && rec.title.trim() ? rec.title.trim() : undefined;
      return { text, title };
    }
  }
  return null;
}

/** One video: captions fast path → STT slow path → BrightData dataset LAST
 *  fallback, or failed. Never throws. */
async function ingestVideo(
  target: { url: string; videoId: string; title?: string },
  allowStt: boolean,
  onProgress?: (message: string) => void,
): Promise<YoutubePipeResult['videos'][number] & { text: string }> {
  const direct = await ingestVideoDirect(target, allowStt, onProgress);
  if (direct.method !== 'failed') return direct;
  // Existing paths first — this is the LAST fallback (proxied, so it survives
  // YouTube's datacenter-egress bot-blocking that kills captions AND yt-dlp).
  try {
    onProgress?.(`Trying BrightData transcript — ${(direct.title || target.videoId).slice(0, 60)}`);
    const bd = await brightDataTranscript(target);
    if (bd) {
      logger.info(`youtube_pipe: BrightData dataset transcript for ${target.videoId} (${bd.text.length} chars)`);
      return { ...direct, title: direct.title || bd.title, chars: bd.text.length, method: 'brightdata' as const, text: bd.text };
    }
    logger.info(`youtube_pipe: BrightData dataset had no transcript for ${target.videoId}`);
  } catch (err: any) {
    logger.warn(`youtube_pipe: BrightData dataset fallback failed for ${target.videoId} (${err?.message || err})`);
  }
  return direct;
}

/** Captions fast path + STT slow path (the direct-to-YouTube tiers). */
async function ingestVideoDirect(
  target: { url: string; videoId: string; title?: string },
  allowStt: boolean,
  onProgress?: (message: string) => void,
): Promise<YoutubePipeResult['videos'][number] & { text: string }> {
  const base = { url: target.url, videoId: target.videoId, title: target.title };
  try {
    // ── FAST PATH: captions via youtubei.js (one ~45s budget: info + transcript) ──
    let durationSec: number | undefined;
    let text = '';
    try {
      const attempt = (async () => {
        const yt = await getInnertube();
        const info = await yt.getBasicInfo(target.videoId);
        const transcript = await info.getTranscript();
        return { info, transcript };
      })();
      const { info, transcript } = await withTimeout(attempt, CAPTIONS_TIMEOUT_MS, 'captions fetch');
      if (!base.title) base.title = info.basic_info?.title || undefined;
      const dur = Number(info.basic_info?.duration);
      if (Number.isFinite(dur) && dur > 0) durationSec = dur;
      text = transcriptSegmentsToText(transcript?.transcript?.content?.body?.initial_segments ?? []);
    } catch (err: any) {
      logger.info(`youtube_pipe: captions unavailable for ${target.videoId} (${err?.message || err})`);
    }
    if (text.length >= MIN_TRANSCRIPT_CHARS) {
      return { ...base, chars: text.length, method: 'captions' as const, stored: false, text };
    }

    // ── SLOW PATH: yt-dlp audio → STT (Parakeet when STT_BASE_URL is set) ────
    if (!allowStt || !(await sttConfigured())) {
      return { ...base, chars: 0, method: 'failed' as const, stored: false, text: '' };
    }
    if (durationSec && durationSec > MAX_STT_DURATION_SEC) {
      logger.info(`youtube_pipe: skipping STT for ${target.videoId} — ${Math.round(durationSec / 60)}min exceeds the 45min cap`);
      return { ...base, chars: 0, method: 'failed' as const, stored: false, text: '' };
    }
    onProgress?.(`Transcribing audio — ${(base.title || target.videoId).slice(0, 60)}`);
    const audio = await downloadAudio(target.url);
    if (!audio) return { ...base, chars: 0, method: 'failed' as const, stored: false, text: '' };
    text = (await speech.transcribeAudio(audio.buffer, audio.filename, audio.mimeType) || '').trim();
    if (text.length >= MIN_TRANSCRIPT_CHARS) {
      return { ...base, chars: text.length, method: 'stt' as const, stored: false, text };
    }
    return { ...base, chars: 0, method: 'failed' as const, stored: false, text: '' };
  } catch (err: any) {
    logger.warn(`youtube_pipe: ${target.videoId} failed (${err?.message || err}) — continuing with the other videos`);
    return { ...base, chars: 0, method: 'failed' as const, stored: false, text: '' };
  }
}

/**
 * sessionId null = no session RAG store available (legacy pipeline models call
 * the pipe via ToolCache): storage is skipped and the digest omits
 * search_memory hints, since those callers have no search_memory tool.
 */
export async function runYoutubePipe(
  sessionId: string | null,
  args: { query?: string; urls?: string[]; focus?: string; stt?: boolean },
  onProgress?: (message: string) => void,
): Promise<YoutubePipeResult> {
  // ── 1. Resolve target videos (deterministic) ───────────────────────────────
  let targets: Array<{ url: string; videoId: string; title?: string }> = [];
  const seen = new Set<string>();
  // SERP redirect wrappers (2026-09-14): a https://www.google.com/goto?url=…
  // wrapper around a YouTube link has NO extractable video id, so without the
  // unwrap the pipe silently found zero videos. Given urls get the same pass
  // (a model may hand back a wrapper it saw in a search_engine result);
  // non-wrappers never touch the network.
  const givenUrls = (Array.isArray(args.urls) ? args.urls : []).filter((u): u is string => typeof u === 'string');
  for (const { url: u } of await unwrapSerpLinks(givenUrls.map(url => ({ url })))) {
    if (targets.length >= MAX_VIDEOS) break;
    const videoId = extractVideoId(u);
    if (!videoId || seen.has(videoId)) continue;
    seen.add(videoId);
    targets.push({ url: u, videoId });
  }

  // Zero-target cause honesty (ticket ca805a61, review finding 2 of the
  // superseded branch): a dying search backend answers with the vendor's own
  // error/debug TEXT as a truthy result — youtubeLinksFromSerp's video-id
  // filter makes the pipe FUNCTIONALLY immune (the error page's URLs carry no
  // video ids, so nothing is ingested), but the zero-target summary then read
  // as "no videos exist" for a dead backend. Name the cause instead.
  let zeroTargetNote: string | null = null;
  if (!targets.length && args.query) {
    onProgress?.(`Searching YouTube — ${args.query.slice(0, 60)}`);
    // The search tier (ticket ca805a61) classifies the provider error body as
    // a FAILED attempt and nulls the result — onSerpProviderError hands the
    // pipe the classified detail so the note names the code (throttle vs
    // query-block), mirroring web_pipe's zero-source note.
    const tierErr: { d: SerpProviderError | null } = { d: null };
    const serp = await callMcpTool('search_engine', { query: `site:youtube.com ${args.query.slice(0, 200)}` }, undefined, {
      onSerpProviderError: (d) => { if (!tierErr.d) tierErr.d = d; },
    }); // callMcpTool is direct-first
    if (serp) {
      // LOCAL defense in depth (same class as web_pipe's layer): a body that
      // reached the pipe un-nulled (a differently-shaped error body, a mock,
      // or the kill switch) must still never be parsed as links.
      const localErr = serpProviderErrorDetail(String(serp));
      if (localErr) {
        zeroTargetNote = `youtube_pipe found no videos: the search backend answered with an error/debug body instead of results (x-brd-error-code=${localErr.code ?? 'unknown'}${localErr.status ? `, HTTP ${localErr.status}` : ''}) — the search provider is failing; retry shortly, use search_engine to confirm, or pass known video urls directly.`;
      } else {
        // callMcpTool already unwraps at its chokepoint; this pass covers a SERP
        // that arrived wrapped anyway (no-op — pure string checks — when clean).
        targets = youtubeLinksFromSerp(await unwrapSerpJsonText(String(serp)), MAX_VIDEOS);
      }
    } else if (tierErr.d) {
      zeroTargetNote = `youtube_pipe found no videos: the search backend failed (SERP error${tierErr.d.code ? `, x-brd-error-code=${tierErr.d.code}` : ''}${tierErr.d.status ? `, HTTP ${tierErr.d.status}` : ''}) — the search provider answered with an error instead of results; retry shortly, use search_engine to confirm, or pass known video urls directly.`;
    } else if (!webSearchStatus().configured) {
      // Self-host setup hardening (2026-10-20): a search that never ran (null,
      // no provider error) on an instance with no search backend is a
      // configuration gap, never "search returned none". A healthy SERP with no
      // YouTube hits keeps the plain note.
      zeroTargetNote = 'youtube_pipe found no videos: web search is NOT configured on this Digby instance (no BrightData token or MCP gateway), so a query cannot be searched — pass known video urls directly, or an admin sets up web search (Account → Admin → Setup).';
    }
  }
  if (!targets.length) {
    return { ok: false, summary: zeroTargetNote ?? 'youtube_pipe found no videos (no YouTube urls given and search returned none).', videos: [], storedChunks: 0 };
  }

  // ── 2. Ingest in parallel (captions fast path → STT slow path, tolerant) ───
  onProgress?.(`Ingesting ${targets.length} video${targets.length === 1 ? '' : 's'}…`);
  const ingested = await Promise.all(targets.map(t => ingestVideo(t, args.stt !== false, onProgress)));
  const good = ingested.filter(v => v.method !== 'failed' && v.chars > 0);
  if (!good.length) {
    return {
      ok: false,
      summary: `youtube_pipe could not get a transcript for any of the ${targets.length} video(s) (no captions${args.stt === false ? '' : ', the STT fallback was unavailable or failed'}, and the BrightData dataset fallback returned no transcript).`,
      videos: ingested.map(({ text: _t, ...v }) => v),
      storedChunks: 0,
    };
  }

  // ── 3. Embed to session RAG (the store search_memory reads) ────────────────
  const stored = sessionId
    ? await storeFindings(sessionId, 'youtube_pipe',
        good.map(v => ({
          ref: `${v.title || v.videoId} — ${v.url}`,
          content: `[YouTube transcript: ${v.title || v.videoId} (${v.url})]\n${v.text.slice(0, 24_000)}`,
        })),
      ).catch(() => 0)
    : 0;

  // ── 4. ONE summarize call (Qwen) — digest + RAG directions ─────────────────
  onProgress?.('Digesting…');
  const focusLine = args.focus ? `\nFOCUS: ${args.focus}` : '';
  const corpus = good.map((v, i) => `--- VIDEO ${i + 1}: ${v.title || v.videoId} (${v.url}) [${v.method}] ---\n${v.text.slice(0, 9000)}`).join('\n\n');
  let summary = '';
  let digestModel: string | undefined;
  try {
    // Gate on the store actually SUCCEEDING (owner 2026-09-04) — same contract
    // as web_pipe: never promise search_memory queries for unstored content.
    const ragItem = stored > 0 ? '\n3. 2-3 suggested search_memory queries for retrieving stored detail.' : '';
    const digest = await qwenSummarize(
      `Digest these YouTube transcripts into:\n1. The key facts per video (cite which video).\n2. One line per video: what it contains.${ragItem}${focusLine}\n\n${corpus}`,
      undefined,
      sessionId,
    );
    // Helper-seat health fallback (owner 2026-09-14): a re-seated digest says
    // so in the digest itself — same contract as web_pipe.
    summary = digest.attribution ? `${digest.text}\n\n[${digest.attribution}]` : digest.text;
    digestModel = digest.model;
  } catch (err: any) {
    // Includes the EMPTY-answer case (names the model + fix) — never a blank digest.
    logger.warn(`youtube_pipe: summarize failed (${err.message}) — returning index only`);
    summary = good.map((v, i) => `${i + 1}. ${v.title || v.videoId} — ${v.url} (${v.chars} chars stored via ${v.method})`).join('\n');
  }

  return {
    ok: true,
    summary,
    videos: ingested.map(({ text: _t, ...v }) => ({ ...v, stored: v.method !== 'failed' && v.chars > 0 })),
    storedChunks: stored,
    ...(digestModel ? { model: digestModel } : {}),
  };
}
