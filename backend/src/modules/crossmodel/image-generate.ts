/**
 * Image generation — the "Image generator" SEAT's runtime (owner ask 2026-09-24:
 * "add image generation model and admin endpoint and defaults to generate
 * images"). The generate_image tool, POST /api/crossmodel/images/generate and
 * the admin Test button all call `generateImage` here.
 *
 * A LEAF like speech.ts: axios + logger (+ the pure chat-images sniffer) are
 * the only static imports; the seat config, the endpoint registry and the
 * Image reader are dynamic-imported so model-roles.service may dynamic-import
 * THIS module (servability + Test) without a cycle.
 *
 * TWO ADAPTERS, one result ({ bytes, mimeType, width, height, model, provider }):
 *   - DashScope native SYNCHRONOUS multimodal-generation route (the same URL
 *     speech.ts uses for TTS) for qwen-image-3.0 / qwen-image-2.0 /
 *     z-image-turbo / wan2.7-image: input.messages[].content = [{image?}…,
 *     {text}], parameters { size 'W*H', n 1, prompt_extend, watermark false,
 *     negative_prompt? }; output.choices[0].message.content[0].image is a
 *     SIGNED URL valid 24 h — downloaded inside the call, never persisted. The
 *     OpenAI-compatible /images/generations route on this host is 404 for every
 *     image model (live probe 2026-09-24), so there is no OpenAI shape here.
 *   - OpenAI-shaped POST {base}/images/generations for the Z.AI built-ins
 *     (glm-image / cogview-4-250304 — size 'WxH'; the result URL's bytes are
 *     JPEG served as image/png, so the magic-byte sniff decides the mime, never
 *     the label) and for any registry endpoint model flagged [image]
 *     (data[0].b64_json preferred, data[0].url accepted). Ticket 99b5545d
 *     (2026-10-24): when a CUSTOM endpoint answers the submit with 202 + a job
 *     id, the call switches to async polling — GET {base}/images/jobs/{id}
 *     (or the body's status_url) every 2 s until the job completes / fails /
 *     the whole-call budget (the polling ceiling) runs out; the sync 200 path
 *     is byte-identical to before.
 *
 * REFERENCE IMAGES: Z.AI has NO image-to-image — an `image` / `image_url`
 * field on /images/generations answers 200 with the reference SILENTLY IGNORED
 * (still billed) and /images/edits is 404 (probe 2026-09-24). This module never
 * sends image input on the OpenAI-shaped adapter. A reference goes to an
 * edit-capable DashScope leg (the image part BEFORE the text part; `size` sent
 * explicitly so qwen-image-3.0 does not auto-upscale to 2048²/2.4 MB). When the
 * SEAT chain has no edit-capable leg (a z-image-turbo / glm-image / cogview
 * head), the same-key IMAGE_EDIT_FALLBACK_CHAIN legs still run a TRUE edit
 * (WI-P 2026-09-25; the result stamps editLegSource 'fallback'). Only when
 * no edit-capable leg is servable at all (no DASHSCOPE_API_KEY) does the Image
 * reader seat DESCRIBE the reference once and the description is folded into
 * the prompt (referenceMode 'described' — the result says so, honestly).
 *
 * CHAIN (first servable leg wins; deduplicated): the seat's effective model →
 * the admin's custom fallback → IMAGE_BUILT_IN_CHAIN (z-image-turbo, the
 * same-key RPM-120 absorber for qwen-image-3.0's RPM 20 → glm-image, a
 * DIFFERENT vendor = the provider-outage hedge (2026-09-17 Z.AI SPOF lesson,
 * both ways) → cogview-4-250304, cheapest last resort). Keyless built-ins are
 * skipped naming the env var; a 429 with Retry-After ≤ 5 s waits once; a
 * content-safety refusal (DashScope DataInspectionFailed / Z.AI content_filter
 * or code 1301) STOPS the chain — no cascade of paid attempts. `spec` pins
 * exactly ONE leg (the admin probe); `probe` picks the leg's smallest size.
 *
 * KEY HYGIENE: no request body or header is ever logged (bodies carry base64);
 * warn lines carry model / provider / HTTP status / a key-scrubbed message; an
 * axios error's `.config` (Authorization + body) is never stringified.
 */

import axios from 'axios';
import logger from '../../utils/logger';
import { sniffMime } from './coding/chat-images';

/** Same native route speech.ts uses for TTS — duplicated literal on purpose (both modules are leaves). */
const DASHSCOPE_MULTIMODAL_URL = 'https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';
const ZAI_IMAGES_BASE_URL = 'https://api.z.ai/api/paas/v4';

/** The seat key (model-roles.service ModelRoleKey). */
export const IMAGE_GENERATE_ROLE = 'image_generate' as const;
/** The seat's built-in default — mirrored by MODEL_ROLES (drift-pinned in model-roles.service.test.ts). */
export const IMAGE_DEFAULT_MODEL = 'qwen-image-3.0';

export type ImageAspect = 'square' | 'landscape' | 'portrait' | 'wide' | 'tall';
export const IMAGE_ASPECTS: readonly ImageAspect[] = ['square', 'landscape', 'portrait', 'wide', 'tall'];
export type ImageProvider = 'dashscope' | 'zai' | 'custom';
export type ImageMime = 'image/png' | 'image/jpeg' | 'image/webp';
export type ReferenceMode = 'none' | 'native' | 'described';
/** Where a native edit's serving leg came from: the seat chain, or IMAGE_EDIT_FALLBACK_CHAIN (implicit same-key legs). */
export type EditLegSource = 'seat' | 'fallback';

export interface GenerateImageInput {
  prompt: string;
  /** Shape; default square. */
  aspect?: ImageAspect;
  /** Optional style hint appended to the prompt (≤200 chars). */
  style?: string;
  /** Let the provider expand the prompt (DashScope prompt_extend; Z.AI glm-image quality hd). Slower. Default off. */
  polish?: boolean;
  /** DashScope negative_prompt (≤500 chars); ignored on the OpenAI-shaped adapter. */
  negativePrompt?: string;
  /** A reference image to edit / re-style (edit-capable DashScope legs only; otherwise described). */
  reference?: { bytes: Buffer; mimeType: string; name?: string };
  /** Pin exactly ONE leg (a built-in id or '<label>:<modelId>') — the admin probe. Empty = the seat chain. */
  spec?: string;
  /** Smallest size + prompt_extend off — the admin Test button. */
  probe?: boolean;
  /** Total wall-clock budget for the call (all legs); default IMAGE_TOTAL_BUDGET_MS. */
  timeoutMs?: number;
}

export interface GeneratedImage {
  bytes: Buffer;
  mimeType: ImageMime;
  width?: number;
  height?: number;
  /** The provider's model id that served. */
  model: string;
  provider: ImageProvider;
  /** The seat/leg spec that served (built-in id or '<label>:<modelId>'). */
  spec: string;
  latencyMs: number;
  referenceMode: ReferenceMode;
  /** Native edits only: 'seat' when the serving leg was in the seat chain, 'fallback' when it joined via IMAGE_EDIT_FALLBACK_CHAIN. */
  editLegSource?: EditLegSource;
  /**
   * Ticket 09a03aef (2026-10-24): when the SERVING leg is not the SEAT's
   * effective spec (specs[0] — never runLegs[0]: the edit path narrows the
   * run set to edit-capable legs, and a head spec that never resolved is not
   * in it either), this names the seat's effective spec. Present ONLY on a
   * substituted serve: a serve on the seat's own model (or a pinned `spec`)
   * never carries it, and a reference edit served by a fallback leg while the
   * seat's spec was merely not edit-capable is covered by `editLegSource`
   * alone — but a seat spec that WAS runnable and failed stamps here too.
   * The generate_image tool result, the `image_generation` loop_metric and
   * the REST response all read it.
   */
  substitutedFor?: string;
  /** The failure class of the leg named above, from ITS OWN error: 'timeout' |
   *  'provider', or 'unavailable' when it never resolved as a runnable leg
   *  (endpoint deleted/disabled/renamed). Never a later leg's error. */
  substitutionReason?: 'timeout' | 'provider' | 'unavailable';
}

/** A chain run that fell through to a later leg: one line naming what the
 *  owner's seat picked vs what actually served (09a03aef — never a silent
 *  swap). */
export function describeImageSubstitution(img: GeneratedImage): string {
  if (!img.substitutedFor) return '';
  const reason = img.substitutionReason === 'timeout' ? 'timed out' : img.substitutionReason === 'unavailable' ? 'was unavailable' : 'failed';
  return `served by ${img.spec} (fallback) — the seated model ${img.substitutedFor} ${reason} before the image was generated`;
}

export type ImageGenerationErrorCode = 'unconfigured' | 'refused' | 'provider' | 'timeout';

export class ImageGenerationError extends Error {
  constructor(public readonly code: ImageGenerationErrorCode, message: string) {
    super(message);
    this.name = 'ImageGenerationError';
    Object.setPrototypeOf(this, ImageGenerationError.prototype);
  }
}

export interface ImageBuiltIn {
  provider: 'dashscope' | 'zai';
  envKey: 'DASHSCOPE_API_KEY' | 'ZAI_API_KEY';
  /** Accepts a reference image (DashScope image parts before the text part). */
  edits: boolean;
  /** Per-aspect size string in the provider's grammar ('W*H' DashScope, 'WxH' Z.AI). */
  sizes: Record<ImageAspect, string>;
  /** The size the admin probe requests (smallest the model accepts — or the size verified live). */
  probeSize: string;
  timeoutMs: number;
  /** Retries on a provider 5xx (glm-image answered HTTP 500 code 1234 once in two probes). */
  retries: number;
  /** For the admin model map (read-only). */
  price: string;
  rpm?: number;
  notes: string;
}

/** qwen-image-3.0 / 2.0 / z-image-turbo: any W*H, 512² ≤ pixels ≤ 2048², 1:8 … 8:1 (multiples of 16 chosen). */
const DASHSCOPE_SIZES: Record<ImageAspect, string> = {
  square: '1024*1024', landscape: '1152*864', portrait: '864*1152', wide: '1280*720', tall: '720*1280',
};
/** Custom OpenAI-shaped endpoints (ComfyUI / SD shims): multiples of 64. */
const CUSTOM_SIZES: Record<ImageAspect, string> = {
  square: '1024x1024', landscape: '1152x896', portrait: '896x1152', wide: '1536x896', tall: '896x1536',
};
const CUSTOM_PROBE_SIZE = '512x512';
const CUSTOM_CHAIN_TIMEOUT_MS = 120_000;
/** 2026-10-23 (ticket 04c8ffd1): instance-wide per-request timeout for custom
 *  (registry) image legs, clamped [120 s, 12 min]. A slow local backend
 *  (Qwen-Image behind LiteLLM, 5-10 min/generation) can be unblocked either
 *  here (every custom leg) or per model via the registry entry's imageTimeoutMs
 *  (which wins). Built-in providers keep their tuned 60-150 s timeouts. */
export const IMAGE_CUSTOM_TIMEOUT_MAX_MS = 720_000;
export function imageCustomTimeoutMs(): number {
  const n = Number(process.env.IMAGE_CUSTOM_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? Math.min(IMAGE_CUSTOM_TIMEOUT_MAX_MS, Math.max(CUSTOM_CHAIN_TIMEOUT_MS, Math.floor(n))) : CUSTOM_CHAIN_TIMEOUT_MS;
}
/** Per-request axios timeout for a custom (registry) image leg. Review F1
 * (61d33af9): the probe budget is 180 s, but this leg cap used to be 120 s —
 * a 21-step self-hosted backend (~122 s) died with an axios abort even inside
 * the budget. The leg cap now DERIVES from the probe budget so an env-raised
 * budget actually reaches the leg (never below the old 120 s floor, and the
 * budget's own 300 s ceiling clamps the top). Only the PROBE path raises it —
 * a normal (chain) generate keeps the 120 s plan budget (review 2026-09-24).
 * 2026-10-23 (04c8ffd1): `perModelMs` (the registry entry's imageTimeoutMs)
 * WINS over the env / default chain value; the probe flag still derives from
 * the probe budget but never below the chain value it starts from. */
function customLegTimeoutMs(probe: boolean, perModelMs?: number): number {
  const chain = perModelMs && perModelMs > 0 ? perModelMs : imageCustomTimeoutMs();
  return probe ? Math.max(chain, imageProbeTimeoutMs()) : chain;
}

/** 09a03aef (2026-10-24): the pixel scale from the admin Test's smallest
 *  custom size (512×512) to a CHAIN size the seat will actually serve. The
 *  probe path generates at 512² under the probe budget, but real chat
 *  traffic runs the chain at full size under the CHAIN budget — a backend
 *  measured at 48.8 s per 512² scales to ~190 s at portrait 896×1152 and
 *  then aborts at the stock 120 s custom-leg timeout while a built-in serves.
 *  Pixel-proportional (diffusion work scales with pixel count, the live
 *  measurements agree: 218.6 s @1024² ≈ 3.9× the 48.8 s @512² class). */
const PROBE_CUSTOM_PIXELS = 512 * 512;
export function probeSizeScale(aspect: ImageAspect = 'square'): number {
  const size = CUSTOM_SIZES[aspect] || CUSTOM_SIZES.square;
  const m = /^(\d+)x(\d+)$/.exec(size);
  if (!m) return 1;
  return (Number(m[1]) * Number(m[2])) / PROBE_CUSTOM_PIXELS;
}

/** 09a03aef: the chain-representativeness verdict for a custom image leg's
 *  admin Test. Pure: probe latency × pixel scale vs the leg's real chain
 *  timeout (the entry's imageTimeoutMs when set, else the instance default).
 *  Empty verdict when the scaled latency fits — or when there is nothing to
 *  warn about (a raised per-entry timeout makes the implied latency fit). */
export function probeChainRepresentativeness(probeLatencyMs: number, chainTimeoutMs: number, aspect: ImageAspect = 'square'): string {
  const scale = probeSizeScale(aspect);
  const projected = probeLatencyMs * scale;
  if (projected <= chainTimeoutMs) return '';
  const s = (ms: number) => `${Math.round(ms / 1000)} s`;
  return `HEADS-UP: the Test ran at the smallest size (512×512, ${(probeLatencyMs / 1000).toFixed(1)} s); scaled to the chain's ${aspect} size (${CUSTOM_SIZES[aspect]}, ×${scale.toFixed(1)} pixels) this model implies ~${s(projected)} per image — ABOVE its ${s(chainTimeoutMs)} chain timeout, so real chat traffic on this seat will time out on this leg and fall to a built-in fallback model. Raise the endpoint model's imageTimeoutMs (Account → Admin → Endpoints) to ≥ ${s(projected)} (or set IMAGE_CUSTOM_TIMEOUT_MS) or the seat will silently serve the fallback.`;
}

/**
 * Every built-in the seat offers, exactly as the 2026-09-24 live probe measured
 * them (request/response shapes, sizes, latencies). Keys == model-roles
 * IMAGE_BUILT_IN_OPTIONS (drift-pinned). The RPM-2/5 premium tiers
 * (qwen-image-3.0-pro, 2.0-pro, -max, edit-max, wan2.7-image-pro) are
 * deliberately NOT offered.
 */
export const IMAGE_BUILT_INS: Record<string, ImageBuiltIn> = {
  'qwen-image-3.0': {
    provider: 'dashscope', envKey: 'DASHSCOPE_API_KEY', edits: true, sizes: DASHSCOPE_SIZES, probeSize: '512*512',
    timeoutMs: 60_000, retries: 0, price: '$0.03 / image (+ $0.003 per input image)', rpm: 20,
    notes: '4.4 s at 1024² with prompt_extend off (48 s on); best text rendering of the lineup; 1–3 reference images for edits (size sent explicitly to keep 1K output)',
  },
  'qwen-image-2.0': {
    provider: 'dashscope', envKey: 'DASHSCOPE_API_KEY', edits: true, sizes: DASHSCOPE_SIZES, probeSize: '512*512',
    timeoutMs: 60_000, retries: 0, price: '$0.035 / image', rpm: 120,
    notes: '4.9 s at 1024²; edits in 4.5 s; older generation than 3.0',
  },
  'z-image-turbo': {
    provider: 'dashscope', envKey: 'DASHSCOPE_API_KEY', edits: false, sizes: DASHSCOPE_SIZES, probeSize: '512*512',
    timeoutMs: 60_000, retries: 0, price: '$0.015 / image ($0.03 with polish — thinking tier)', rpm: 120,
    notes: '4.4 s at 1024² with prompt_extend off (34 s on); text only; the same-key high-RPM fallback for qwen-image-3.0',
  },
  'wan2.7-image': {
    provider: 'dashscope', envKey: 'DASHSCOPE_API_KEY', edits: true,
    sizes: { square: '1024*1024', landscape: '1152*864', portrait: '864*1152', wide: '1344*768', tall: '768*1344' },
    // 768² is the documented floor; 1024² is the size verified live on the sync route (15.8 s).
    probeSize: '1024*1024', timeoutMs: 90_000, retries: 0, price: '$0.03 / image', rpm: 300,
    notes: '15.8 s at 1024² on the sync multimodal route (the image-generation route is async-only); ≥768 px per side; edits',
  },
  'glm-image': {
    provider: 'zai', envKey: 'ZAI_API_KEY', edits: false,
    sizes: { square: '1024x1024', landscape: '1472x1088', portrait: '1088x1472', wide: '1728x960', tall: '960x1728' },
    probeSize: '1024x1024', timeoutMs: 150_000, retries: 1, price: '$0.015 / image',
    notes: '30–50 s at 1024² (quality standard; hd ≈ 90 s — used only with polish); ≥1024 px per side, multiples of 32; JPEG bytes served as image/png; text only — image input is silently ignored by the API; one retry on HTTP 500 (code 1234 seen live)',
  },
  'cogview-4-250304': {
    provider: 'zai', envKey: 'ZAI_API_KEY', edits: false,
    sizes: { square: '1024x1024', landscape: '1152x864', portrait: '864x1152', wide: '1440x720', tall: '720x1440' },
    probeSize: '512x512', timeoutMs: 60_000, retries: 0, price: '$0.01 / image',
    notes: '8 s at 1024²; 512–2048 px, multiples of 16; older-generation quality; the dated id is required (bare "cogview-4" is Unknown Model)',
  },
};
export const IMAGE_BUILT_IN_IDS: readonly string[] = Object.keys(IMAGE_BUILT_INS);
/** The built-in fallback order appended after the seat model + its custom fallback. */
export const IMAGE_BUILT_IN_CHAIN: readonly string[] = ['z-image-turbo', 'glm-image', 'cogview-4-250304'];
/**
 * Edit-capable fallbacks appended when a REFERENCE image is present (review
 * 2026-09-24): the built-in chain has no edit-capable leg, so an edit used to
 * run on exactly ONE leg — a 429 on the RPM-20 default failed the edit
 * outright. Same DashScope key; only legs not already in the chain are added,
 * and never for a pinned `spec` (the admin probe tests one leg).
 *
 * WI-P (2026-09-25): these legs are appended EVEN WHEN the seat chain has no
 * edit-capable leg at all (the admin seated z-image-turbo / glm-image /
 * cogview) — a reference then still gets a true same-key edit instead of the
 * Image reader's description.
 */
export const IMAGE_EDIT_FALLBACK_CHAIN: readonly string[] = ['qwen-image-2.0', 'wan2.7-image', 'qwen-image-3.0'];

/** Total wall-clock budget for one generateImage call across all legs. */
export const IMAGE_TOTAL_BUDGET_MS = 240_000;
/** The admin Test button's budget — glm-image needs 30–50 s. Ticket 61d33af9
 * (2026-10-10): a self-hosted image backend at the OpenAI Images default shape
 * legitimately takes ~118 s (15.4 s fixed + ~5.1 s/step × 20 steps), so a 55 s
 * budget reported a HEALTHY backend as "timed out" (Caddy logged the client —
 * our own axios — closing at 54.9 s, status 0). The probe budget is now 180 s;
 * the DELIVERY side must stream keepalives (POST /admin/model-roles/test/stream,
 * model-roles.service.ts testModelRoleStream) or the ALB's 60 s idle timeout
 * (live-verified 2026-10-10) cuts the request before the answer arrives. Env
 * IMAGE_PROBE_TIMEOUT_MS (clamped 55 s–5 min); IMAGE_PROBE_TIMEOUT_DISABLED=1
 * restores 55 s. */
export const IMAGE_PROBE_TIMEOUT_MS = 180_000;
/** 55 s — the pre-61d33af9 budget, the floor the env clamp never goes below. */
export const IMAGE_PROBE_LEGACY_TIMEOUT_MS = 55_000;
/** The env override, clamped [55 s, 5 min]; IMAGE_PROBE_TIMEOUT_DISABLED=1 restores the legacy 55 s. */
export function imageProbeTimeoutMs(): number {
  if (process.env.IMAGE_PROBE_TIMEOUT_DISABLED === '1') return IMAGE_PROBE_LEGACY_TIMEOUT_MS;
  const n = Number(process.env.IMAGE_PROBE_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? Math.min(300_000, Math.max(IMAGE_PROBE_LEGACY_TIMEOUT_MS, Math.floor(n))) : IMAGE_PROBE_TIMEOUT_MS;
}
export const IMAGE_PROBE_PROMPT = 'Digby connection test: a small blue circle on a white background';
/** A leg is not started with less than this left of the budget. */
const MIN_LEG_MS = 5_000;
/** Largest image bytes accepted from a provider (a 2048² PNG is ~5.5 MB). */
export const MAX_IMAGE_OUTPUT_BYTES = 12 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 60_000;
/** A 429's Retry-After above this is not worth waiting for — the next leg serves. */
const RETRY_AFTER_MAX_MS = 5_000;
// ── Async image jobs (ticket 99b5545d, 2026-10-24) ────────────────────────────
/** A slow OpenAI-shaped image backend (local ComfyUI-class, 5–10 min/image)
 *  may answer the submit with HTTP 202 + a job id instead of holding the
 *  request open. Digby then polls the job's status endpoint until it finishes;
 *  the WHOLE-CALL budget (imageCallBudgetMs, ≤ 13 min) is the polling ceiling —
 *  no request hangs (Cloudflare's ~100 s proxy cut never fires), and the
 *  per-request axios timeout stops being the kill switch for slow generations. */
export const IMAGE_ASYNC_POLL_INTERVAL_MS = 2_000;
/** One status GET's own axios timeout — each poll is a fresh, short request. */
const IMAGE_ASYNC_POLL_TIMEOUT_MS = 30_000;
/** The poll loop stops (timeout) with less than this left of the call budget. */
const MIN_POLL_MS = 1_000;
/** Consecutive transient (network / 429 / 5xx) status-GET failures tolerated before giving up. */
const IMAGE_ASYNC_POLL_MAX_ERRORS = 5;
/** Consecutive status bodies carrying NO recognizable job state before the poll
 *  loop gives up with a provider error (review f246 finding 6: an unparseable
 *  body — empty, an HTML error page, alien JSON — used to spin to the
 *  whole-call budget as a generic timeout, hiding the broken-shim cause). */
const IMAGE_ASYNC_POLL_MAX_UNPARSEABLE = 3;
const ASYNC_JOB_DONE = new Set(['succeeded', 'success', 'completed', 'complete', 'done']);
const ASYNC_JOB_FAILED = new Set(['failed', 'failure', 'error', 'errored', 'cancelled', 'canceled', 'rejected']);
const STYLE_MAX_CHARS = 200;
const NEGATIVE_PROMPT_MAX_CHARS = 500;
const DESCRIPTION_MAX_CHARS = 1_500;

/** 2026-10-23 (04c8ffd1): the whole-call budget. Scales up from the default
 *  240 s ONLY when a custom leg's per-request timeout is RAISED above the stock
 *  120 s floor (per-entry or env) and needs more than the budget would give it
 *  (+ the 60 s download allowance), capped at 13 min — real margin under the
 *  agent tool's 15-min hard race (review B2: a 780 s cap left only 60 s for the
 *  pre-leg setup and post-leg storage that run OUTSIDE this deadline).
 *
 *  Review B3 (04c8ffd1): only a leg ABOVE the 120 s floor lifts the budget.
 *  The stock 120 s custom leg already fits the flat 240 s budget — lifting for
 *  it silently tripled the documented IMAGE_PROBE_TIMEOUT_DISABLED=1 restore
 *  (55 s → 180 s) on every custom-leg probe and overrode the probe budget's
 *  authority on the stock path. With this shape an explicit budget is the
 *  authority whenever the chain runs at stock timeouts, byte-identical to
 *  pre-04c8ffd1: (undefined,0)=240k · (55k,120k)=55k · (180k,120k)=180k;
 *  raised legs scale: (undefined,300k)=360k · (180k,480k)=540k · cap 780k. */
export const IMAGE_CALL_BUDGET_MAX_MS = 780_000;
export function imageCallBudgetMs(explicitTimeoutMs: number | undefined, maxCustomLegTimeoutMs: number): number {
  const base = explicitTimeoutMs && explicitTimeoutMs > 0 ? explicitTimeoutMs : IMAGE_TOTAL_BUDGET_MS;
  const raised = maxCustomLegTimeoutMs > CUSTOM_CHAIN_TIMEOUT_MS ? maxCustomLegTimeoutMs : 0;
  const needed = raised > 0 ? raised + DOWNLOAD_TIMEOUT_MS : 0;
  return Math.min(IMAGE_CALL_BUDGET_MAX_MS, Math.max(base, needed));
}

/** Which .env variable a seat value needs: built-ins name their provider key; '<label>:<modelId>' specs → null (the registry carries the key). */
export function imageSpecEnvKey(spec: string): 'DASHSCOPE_API_KEY' | 'ZAI_API_KEY' | null {
  return IMAGE_BUILT_INS[String(spec || '').trim()]?.envKey ?? null;
}

// ── Chain resolution ─────────────────────────────────────────────────────────

interface ImageLeg {
  /** What the admin sees: a built-in id or '<label>:<modelId>'. */
  spec: string;
  /** The provider's model id. */
  model: string;
  provider: ImageProvider;
  apiKey: string;
  edits: boolean;
  sizes: Record<ImageAspect, string>;
  probeSize: string;
  timeoutMs: number;
  retries: number;
  /** The OpenAI-shaped route (zai + custom legs). */
  imagesUrl?: string;
  /** 2026-10-23 (04c8ffd1): the registry entry's per-model image timeout, when
   *  it carried one (drives the call-budget scaling, not the axios timeout —
   *  that is already folded into `timeoutMs`). Present only when set. */
  imageTimeoutMs?: number;
}

/** The seat's effective model, its custom fallback and the built-in chain (dynamic import, fail-open to the default). */
async function seatChainSpecs(): Promise<string[]> {
  let effective = IMAGE_DEFAULT_MODEL;
  let fallback = '';
  try {
    const roles = await import('./model-endpoints/model-roles.service');
    const overrides = await roles.getModelRoleOverrides();
    effective = overrides[IMAGE_GENERATE_ROLE] || roles.roleDefaultModel(IMAGE_GENERATE_ROLE, overrides) || IMAGE_DEFAULT_MODEL;
    fallback = (await roles.resolveRoleFallback(IMAGE_GENERATE_ROLE)) || '';
  } catch (err: any) {
    logger.warn(`image-generate: seat config unreadable (${err?.message || err}) — using the built-in default ${IMAGE_DEFAULT_MODEL}`);
  }
  const out: string[] = [];
  for (const s of [effective, fallback, ...IMAGE_BUILT_IN_CHAIN]) {
    const v = String(s || '').trim();
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

/** One spec → a runnable leg, or null (reason appended to `skipped`).
 * `probe` (F1, 61d33af9 review): on the admin probe path a custom leg's
 * per-request timeout derives from the probe budget (env-raised budgets must
 * reach the leg); a normal chain generate keeps the 120 s plan budget. */
async function legForSpec(spec: string, skipped: string[], probe = false): Promise<ImageLeg | null> {
  const builtIn = IMAGE_BUILT_INS[spec];
  if (builtIn) {
    const apiKey = (process.env[builtIn.envKey] || '').trim();
    if (!apiKey) { skipped.push(`${spec} needs ${builtIn.envKey}`); return null; }
    return {
      spec, model: spec, provider: builtIn.provider, apiKey, edits: builtIn.edits, sizes: builtIn.sizes,
      probeSize: builtIn.probeSize, timeoutMs: builtIn.timeoutMs, retries: builtIn.retries,
      ...(builtIn.provider === 'zai' ? { imagesUrl: `${ZAI_IMAGES_BASE_URL}/images/generations` } : {}),
    };
  }
  if (!spec.includes(':')) {
    logger.warn(`image-generate: "${spec}" is not an image model Digby knows — skipping this leg`);
    skipped.push(`"${spec}" is not a known image model`);
    return null;
  }
  try {
    const { resolveRegistryModel } = await import('./model-endpoints/model-endpoints.service');
    const reg = await resolveRegistryModel(spec);
    if (!reg) {
      logger.warn(`image-generate: "${spec}" no longer resolves (endpoint deleted/disabled/renamed) — skipping this leg`);
      skipped.push(`"${spec}" no longer resolves`);
      return null;
    }
    if (reg.image !== true) {
      logger.warn(`image-generate: "${spec}" is registered but not flagged [image] — skipping this leg`);
      skipped.push(`"${spec}" is not flagged [image]`);
      return null;
    }
    return {
      spec, model: reg.model, provider: 'custom', apiKey: reg.apiKey ?? '', edits: false, sizes: CUSTOM_SIZES,
      // F1 (61d33af9 review): the leg's per-request timeout derives from the probe
      // budget on the PROBE path (env-raised budgets must reach the leg); a normal
      // chain generate keeps the 120 s plan budget. 2026-10-23 (04c8ffd1): a
      // per-entry imageTimeoutMs (slow local backends, 5-10 min/generation) wins
      // over the env / default chain value.
      probeSize: CUSTOM_PROBE_SIZE, timeoutMs: customLegTimeoutMs(probe === true, reg.imageTimeoutMs), retries: 0,
      // 2026-10-25 (todo 87b020c4, owner ruling oq_7af5537b): the entry's
      // imagesUrl, when set, is the images-route BASE override for the
      // long-running image class (tailnet-direct — e.g. http://100.64.0.1:4001/v1,
      // mirroring baseUrl's /v1 path prefix);
      // absent = the endpoint's baseUrl (the Cloudflare route — the documented
      // fallback per the ruling: clear imagesUrl and the seat reverts). Chat
      // traffic resolves reg.url / reg.baseUrl and never reads this field.
      imagesUrl: `${reg.imagesUrl ?? reg.baseUrl}/images/generations`,
      ...(reg.imageTimeoutMs && reg.imageTimeoutMs > 0 ? { imageTimeoutMs: reg.imageTimeoutMs } : {}),
    };
  } catch (err: any) {
    logger.warn(`image-generate: registry lookup for "${spec}" failed (${err?.message || err}) — skipping this leg`);
    skipped.push(`"${spec}" could not be resolved`);
    return null;
  }
}

export function imageUnconfiguredMessage(skipped: string[] = []): string {
  return 'Image generation is not configured on this instance: assign a model to the Image generator seat (Account → Admin → Endpoints → Model roles) or set DASHSCOPE_API_KEY / ZAI_API_KEY.'
    + (skipped.length ? ` (${skipped.join('; ')})` : '');
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function isTimeout(err: any): boolean {
  return err?.code === 'ECONNABORTED' || err?.code === 'ETIMEDOUT' || /timeout|timed out/i.test(String(err?.message || ''));
}

/** Key-material scrub shared by every error/log surface here (local copy of
 *  scrubError's redact — model-roles.service cannot be statically imported). */
function redactKeyMaterial(s: string, apiKey?: string): string {
  let out = s.replace(/Bearer\s+[^\s"'\\)]+/gi, 'Bearer •••');
  if (apiKey) {
    out = out.split(apiKey).join('•••');
    const escaped = JSON.stringify(apiKey).slice(1, -1);
    if (escaped !== apiKey) out = out.split(escaped).join('•••');
    // Z.AI keys are `id.secret` — scrub each half too (an echo may quote one side).
    for (const part of apiKey.split('.')) if (part.length >= 8) out = out.split(part).join('•••');
  }
  return out;
}

/** Key-scrubbed one-line error text. */
function describeError(err: any, apiKey?: string): string {
  const redact = (s: string): string => redactKeyMaterial(s, apiKey);
  if (err instanceof ImageGenerationError) return redact(err.message).slice(0, 500);
  const status = err?.response?.status;
  let body = '';
  try {
    const data = err?.response?.data;
    body = data == null || Buffer.isBuffer(data) || data instanceof ArrayBuffer
      ? ''
      : redact(JSON.stringify(data) ?? '').slice(0, 200);
  } catch { body = ''; }
  if (status) return `HTTP ${status}${body && body !== '{}' ? ` — ${body}` : ''}`;
  if (isTimeout(err)) return `timed out${err?.message ? ` (${redact(String(err.message)).slice(0, 120)})` : ''}`;
  return redact(String(err?.message || err?.code || 'connection failed')).slice(0, 300);
}

function summarize(x: unknown): string {
  try { return (JSON.stringify(x) ?? '').slice(0, 200); } catch { return ''; }
}

/** Truncate a job identifier for log/throw surfaces. A 202's job id may be a
 *  FULL status URL (Location header / body status_url) carrying a signature
 *  query (`?token=`, `?X-Amz-Signature=`) — never print those raw (review f246
 *  finding 10); the shape (origin+path) identifies the job well enough. */
function safeJobLabel(jobId: string): string {
  const t = String(jobId || '').trim();
  if (/^https?:\/\//i.test(t)) {
    try { const u = new URL(t); return `${u.origin}${u.pathname}`; } catch { return t.slice(0, 120); }
  }
  return t.length > 120 ? `${t.slice(0, 117)}…` : t;
}

/** DashScope content-safety code (input or output) — a refusal, not a retryable failure. */
function isDashScopeRefusalCode(code: unknown): boolean {
  return typeof code === 'string' && /DataInspectionFailed|InappropriateContent/i.test(code);
}
/** Z.AI / Zhipu content-safety code ("1301: sensitive content"). */
function isZaiRefusalCode(code: unknown): boolean {
  return String(code ?? '') === '1301';
}

function retryAfterMs(header: unknown): number | null {
  if (header == null) return null;
  const s = String(Array.isArray(header) ? header[0] : header).trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return Number(s) * 1000;
  const at = Date.parse(s);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

/** Read the pixel size from the bytes themselves (PNG IHDR, JPEG SOFn, WebP VP8/VP8L/VP8X) — the provider's word is not needed. */
export function readImageDimensions(buf: Buffer, mime: string): { width: number; height: number } | null {
  try {
    if (mime === 'image/png') {
      if (buf.length < 24 || buf.toString('ascii', 12, 16) !== 'IHDR') return null;
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (mime === 'image/jpeg') {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) return null;
        const marker = buf[i + 1];
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; } // standalone markers
        const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
        if (isSof) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
        i += 2 + buf.readUInt16BE(i + 2);
      }
      return null;
    }
    if (mime === 'image/webp') {
      if (buf.length < 30) return null;
      const chunk = buf.toString('ascii', 12, 16);
      if (chunk === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
      if (chunk === 'VP8L') {
        const b0 = buf[21], b1 = buf[22], b2 = buf[23], b3 = buf[24];
        return { width: 1 + (((b1 & 0x3f) << 8) | b0), height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)) };
      }
      if (chunk === 'VP8X') return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
    }
  } catch { /* malformed header — dimensions unknown */ }
  return null;
}

interface LegOutput { bytes: Buffer; mimeType: ImageMime; width?: number; height?: number }

/** Sniff + bound the bytes a leg produced (Z.AI labels JPEG as png; a provider error page is not an image). */
function acceptImageBytes(bytes: Buffer, model: string): LegOutput {
  if (!bytes?.length) throw new ImageGenerationError('provider', `${model} returned an empty image`);
  if (bytes.length > MAX_IMAGE_OUTPUT_BYTES) {
    throw new ImageGenerationError('provider', `${model} returned ${(bytes.length / 1024 / 1024).toFixed(1)} MB — above the ${MAX_IMAGE_OUTPUT_BYTES / 1024 / 1024} MB limit`);
  }
  const sniffed = sniffMime(bytes);
  if (sniffed !== 'image/png' && sniffed !== 'image/jpeg' && sniffed !== 'image/webp') {
    throw new ImageGenerationError('provider', `${model} returned ${sniffed ?? 'bytes that are not a PNG/JPEG/WebP image'}`);
  }
  const dims = readImageDimensions(bytes, sniffed);
  return { bytes, mimeType: sniffed, ...(dims ? dims : {}) };
}

/** Smallest timeout a clamped request is given — a 0 ms axios timeout means "no timeout". */
const MIN_REQUEST_MS = 1_000;
/** A per-request timeout bounded by the call's deadline (review 2026-09-24: retries + the URL download used to escape the budget). */
function clampToDeadline(timeoutMs: number, deadline: number): number {
  return Math.max(MIN_REQUEST_MS, Math.min(timeoutMs, deadline - Date.now()));
}

/** Provider URLs expire (DashScope 24 h signed, Z.AI 30 d) — fetch NOW, keep the bytes. The download shares the call's deadline. */
async function downloadImage(url: string, model: string, deadline: number): Promise<Buffer> {
  const resp = await axios.get(url, { responseType: 'arraybuffer', timeout: clampToDeadline(DOWNLOAD_TIMEOUT_MS, deadline), maxContentLength: MAX_IMAGE_OUTPUT_BYTES + 1024 });
  const bytes = Buffer.from(resp.data ?? []);
  if (!bytes.length) throw new ImageGenerationError('provider', `${model}: the image URL returned no bytes`);
  return bytes;
}

function buildPrompt(prompt: string, style?: string): string {
  const s = String(style || '').trim().slice(0, STYLE_MAX_CHARS);
  return `${prompt.trim()}${s ? `\nStyle: ${s}` : ''}`;
}

// ── Adapters ─────────────────────────────────────────────────────────────────

interface LegRequest {
  prompt: string;
  polish: boolean;
  probe: boolean;
  negativePrompt?: string;
  /** Present ONLY for edit-capable DashScope legs (referenceMode 'native'). */
  reference?: { bytes: Buffer; mimeType: string };
  /** Absolute wall-clock deadline of the whole generateImage call — every attempt AND the URL download are clamped to it. */
  deadline: number;
}

/**
 * DashScope native synchronous multimodal-generation route. Body verified live
 * 2026-09-24 for every DashScope built-in: messages[0].content = [{image}…,
 * {text}], parameters { size 'W*H', n 1, prompt_extend, watermark false,
 * negative_prompt? }. Errors arrive as HTTP 4xx { code, message } (handled in
 * runLeg) or, rarely, as a 200 with output.code.
 */
async function dashscopeImageLeg(leg: ImageLeg, req: LegRequest, size: string, timeoutMs: number): Promise<LegOutput> {
  const content: Array<Record<string, string>> = [];
  if (req.reference) content.push({ image: `data:${req.reference.mimeType};base64,${req.reference.bytes.toString('base64')}` });
  content.push({ text: req.prompt });
  const negative = String(req.negativePrompt || '').trim().slice(0, NEGATIVE_PROMPT_MAX_CHARS);
  const body = {
    model: leg.model,
    input: { messages: [{ role: 'user', content }] },
    parameters: {
      size,
      n: 1,
      prompt_extend: req.polish && !req.probe,
      watermark: false,
      ...(negative ? { negative_prompt: negative } : {}),
    },
  };
  const resp = await axios.post(DASHSCOPE_MULTIMODAL_URL, body, {
    headers: { 'Authorization': `Bearer ${leg.apiKey}`, 'Content-Type': 'application/json' },
    timeout: timeoutMs,
    maxBodyLength: 20 * 1024 * 1024,
  });
  const data = resp.data ?? {};
  const code = data.code || data.output?.code;
  if (code) {
    const message = data.message || data.output?.message || '';
    if (isDashScopeRefusalCode(code)) throw new ImageGenerationError('refused', `${leg.model} refused the request on content-safety grounds (${code}${message ? `: ${String(message).slice(0, 160)}` : ''})`);
    throw new ImageGenerationError('provider', `DashScope ${leg.model}: ${code}${message ? ` ${String(message).slice(0, 160)}` : ''}`);
  }
  const choice = data.output?.choices?.[0];
  if (choice?.finish_reason === 'content_filter') throw new ImageGenerationError('refused', `${leg.model} refused the request on content-safety grounds (content_filter)`);
  const parts: any[] = Array.isArray(choice?.message?.content) ? choice.message.content : [];
  const url: string | undefined = parts.find(p => typeof p?.image === 'string' && p.image)?.image;
  if (!url) throw new ImageGenerationError('provider', `DashScope ${leg.model} returned no image (${summarize(data.output ?? data)})`);
  const out = acceptImageBytes(await downloadImage(url, leg.model, req.deadline), leg.model);
  const usage = data.usage ?? {};
  const w = Number(usage.output_width ?? usage.width);
  const h = Number(usage.output_height ?? usage.height);
  return (out.width && out.height) || !(w > 0 && h > 0) ? out : { ...out, width: w, height: h };
}

/**
 * OpenAI-shaped POST {base}/images/generations — the Z.AI built-ins and any
 * registry model flagged [image]. NEVER carries image input: Z.AI ignores it
 * silently (200, unrelated output, billed — probe 2026-09-24) and a custom
 * /images/edits multipart route is a later item; references reach this
 * adapter only as a written description inside the prompt.
 *
 * Ticket 99b5545d (2026-10-24): a slow local backend may answer the submit with
 * HTTP 202 + a job id instead of an image. That is the async-job shape: Digby
 * polls the job's status endpoint (each poll a fresh short request) until it
 * finishes or the whole-call budget (the polling ceiling) runs out. Everything
 * else — 200 sync answers, refusals, error bodies — is byte-identical to the
 * pre-99b5545d path. Only custom (registry) legs take the async route; the
 * built-in providers are synchronous and never answer 202.
 */
async function openaiImagesLeg(leg: ImageLeg, req: LegRequest, size: string, timeoutMs: number): Promise<LegOutput> {
  const body: Record<string, unknown> = { model: leg.model, prompt: req.prompt, size, n: 1, response_format: 'b64_json' };
  // Z.AI glm-image: `quality: 'hd'` is ~3× slower for the same price — only when the caller asked for polish.
  if (leg.provider === 'zai' && leg.model === 'glm-image' && req.polish && !req.probe) body.quality = 'hd';
  const resp = await axios.post(leg.imagesUrl!, body, {
    headers: { ...(leg.apiKey ? { 'Authorization': `Bearer ${leg.apiKey}` } : {}), 'Content-Type': 'application/json' },
    timeout: timeoutMs,
    maxContentLength: 2 * MAX_IMAGE_OUTPUT_BYTES,
  });
  // Ticket 99b5545d: 202 Accepted + job id → poll the status endpoint until the
  // image is ready. validateStatus is axios's DEFAULT (2xx) so a 202 reaches
  // here rather than throwing; treat it as the async-job handoff, never as the
  // sync "returned no image" failure.
  if (resp.status === 202 && leg.provider === 'custom') {
    const jobId = extractAsyncJobId(resp.data);
    const headerStatusUrl = typeof resp.headers?.location === 'string' && resp.headers.location.trim() ? resp.headers.location : '';
    if (jobId || headerStatusUrl) {
      logger.info(`image-generate: ${leg.model} accepted an async job (${safeJobLabel(jobId || headerStatusUrl)}) — polling until it completes`);
      return await pollAsyncImageJob(leg, asyncJobStatusUrl(leg, jobId, headerStatusUrl || null, resp.data), jobId || headerStatusUrl, req);
    }
    // No async handoff: a 202 may already carry the image INLINE ({data:[{b64_json|url}]}) —
    // that shape delivered pre-99b5545d, so fall through to the unchanged sync
    // parse below (review f246 finding 8). A 202 carrying neither a job id nor
    // an image is a provider-shape error, not a timeout — and never the sync
    // "returned no image" lie.
    const first202: any = Array.isArray((resp.data as any)?.data) ? (resp.data as any).data[0] : undefined;
    const inlineImage =
      (typeof first202?.b64_json === 'string' && first202.b64_json.length > 0) ||
      (typeof first202?.url === 'string' && first202.url.length > 0);
    if (!inlineImage) {
      throw new ImageGenerationError('provider', `${leg.model} answered 202 with no job id (${summarize(resp.data)})`);
    }
  }
  const data = resp.data ?? {};
  const first = Array.isArray(data.data) ? data.data[0] : undefined;
  const b64: string | undefined = typeof first?.b64_json === 'string' && first.b64_json ? first.b64_json : undefined;
  const url: string | undefined = typeof first?.url === 'string' && first.url ? first.url : undefined;
  if (!b64 && !url) {
    if (Array.isArray(data.content_filter) && data.content_filter.length) {
      throw new ImageGenerationError('refused', `${leg.model} refused the request on content-safety grounds (content_filter)`);
    }
    throw new ImageGenerationError('provider', `${leg.model} returned no image (${summarize(data)})`);
  }
  const bytes = b64 ? Buffer.from(b64, 'base64') : await downloadImage(url!, leg.model, req.deadline);
  return acceptImageBytes(bytes, leg.model);
}

/** The job id a 202 body carries — OpenAI-flavoured shapes first ({id:…,
 *  object:'image.generation.job'}), then the common flat keys (job_id, jobId),
 *  then a bare string body. Absent/blank → null. A BARE `id` key is trusted
 *  only when the body corroborates that it names a job (object/status/state/
 *  job/task key, or a status URL) — review f246 finding 11: `202 {id:"evt_1"}`
 *  must not flip the leg into polling a wrong route. */
function extractAsyncJobId(data: unknown): string | null {
  if (typeof data === 'string') {
    const t = data.trim();
    return t && t.length <= 256 ? t : null;
  }
  if (data && typeof data === 'object') {
    const d = data as Record<string, unknown>;
    for (const k of ['job_id', 'jobId', 'task_id', 'taskId']) {
      const v = d[k];
      if (typeof v === 'string' && v.trim() && v.length <= 256) return v.trim();
    }
    const id = d['id'];
    if (typeof id === 'string' && id.trim() && id.length <= 256) {
      // A JOB-ish corroborator: an object/type naming a job/task/generation/
      // image, a status/state field, a nested job/task object, or a status URL.
      // `object:'event.received'` is NOT one (review f246 finding 11).
      const objStr = typeof d['object'] === 'string' ? d['object'] : '';
      const typeStr = typeof d['type'] === 'string' ? d['type'] : '';
      const corroborated =
        /job|task|generation|image/i.test(objStr) || /job|task/i.test(typeStr)
        || (typeof d['status'] === 'string') || (typeof d['state'] === 'string')
        || d['job'] != null || d['task'] != null
        || (typeof d['status_url'] === 'string') || (typeof d['statusUrl'] === 'string') || (typeof d['location'] === 'string');
      if (corroborated) return id.trim();
    }
  }
  return null;
}

/** Resolve a status reference (body status_url or the Location header value)
 *  against the submit endpoint — absolute passes through, anything else gets
 *  RFC 3986 resolution (a slash-less `Location: v1/jobs/j9` used to be
 *  percent-encoded into the derived route and 404 — review f246 finding 9). */
function resolveStatusRef(ref: string, leg: ImageLeg): string {
  if (/^https?:\/\//i.test(ref)) return ref;
  try { return new URL(ref, leg.imagesUrl!).toString(); } catch { return ref; }
}

/** Where a job's status lives. A 202 may carry an explicit status URL (body
 *  status_url/statusUrl/location — highest precedence), or the standard HTTP
 *  Location HEADER (an absolute or relative reference); otherwise Digby
 *  derives it from the submit endpoint's base: POST {base}/images/generations
 *  → GET {base}/images/jobs/{id}. The derived shape is the contract the
 *  lab-side shim implements. */
function asyncJobStatusUrl(leg: ImageLeg, jobId: string | null, locationRef: string | null, data: unknown): string {
  const explicit: string =
    ((typeof (data as any)?.status_url === 'string' && (data as any).status_url.trim()) as string | false)
    || ((typeof (data as any)?.statusUrl === 'string' && (data as any).statusUrl.trim()) as string | false)
    || ((typeof (data as any)?.location === 'string' && (data as any).location.trim()) as string | false)
    || '';
  if (explicit) return resolveStatusRef(explicit, leg);
  if (locationRef) return resolveStatusRef(locationRef, leg);
  // The body's `id` may itself BE the status URL (a signed location the
  // provider hands back as the job handle) — use it as-is, never percent-
  // encode a URL into the derived route (review f246 finding 10's shape).
  if (jobId && /^https?:\/\//i.test(jobId)) return jobId;
  return `${leg.imagesUrl!.replace(/\/images\/generations$/, '')}/images/jobs/${encodeURIComponent(jobId!)}`;
}

/**
 * Poll a 202'd image job until it finishes. Each status GET is a fresh short
 * request (≤ 30 s), so nothing ever hangs and the ~100 s proxy cut never fires;
 * the loop runs INSIDE the whole-call deadline (LegRequest.deadline) — the
 * ticket's "the 12-min budget becomes the polling ceiling" — and stops with a
 * timeout error when the budget is exhausted. Terminal states:
 *  - done: the payload carries image bytes (b64_json inline, a URL to
 *    download, or raw image bytes the sniffer recognizes) → LegOutput.
 *  - failed: the job's own error → provider error (message from the body,
 *    key-scrubbed).
 *  - budget exhausted / too many consecutive transient poll errors /
 *    too many consecutive UNRECOGNIZABLE status bodies (review f246
 *    finding 6: a broken status route surfaces as a provider error naming
 *    the body, never a silent spin to the timeout).
 */
async function pollAsyncImageJob(leg: ImageLeg, statusUrl: string, jobIdOrRef: string | null, req: LegRequest): Promise<LegOutput> {
  const jobLabel = safeJobLabel(jobIdOrRef ?? statusUrl);
  // The bearer key rides a poll ONLY to the submit endpoint's own origin —
  // an explicit status URL is provider-controlled text and may be cross-origin
  // (review f246 finding 7); a cross-origin poll goes unauthenticated, like
  // downloadImage's fetches.
  const pollAuth: boolean = (() => {
    try { return new URL(statusUrl).origin === new URL(leg.imagesUrl!).origin; } catch { return true; }
  })();
  let consecutiveErrors = 0;
  let consecutiveUnparseable = 0;
  let polls = 0;
  for (;;) {
    polls++;
    let resp: any;
    try {
      resp = await axios.get(statusUrl, {
        headers: { ...((leg.apiKey && pollAuth) ? { 'Authorization': `Bearer ${leg.apiKey}` } : {}) },
        timeout: clampToDeadline(IMAGE_ASYNC_POLL_TIMEOUT_MS, req.deadline),
        maxContentLength: 2 * MAX_IMAGE_OUTPUT_BYTES,
        responseType: 'arraybuffer',
      });
    } catch (pollErr: any) {
      // Transient (network / 429 / 5xx) status failures are tolerated a few
      // times in a row; a 4xx means the job id / status route is wrong — that
      // is a provider-shape error, not worth retrying.
      const status: number | undefined = pollErr?.response?.status;
      if (typeof status === 'number' && status >= 400 && status < 500 && status !== 429) {
        throw new ImageGenerationError('provider', `${leg.model} async job ${jobLabel}: status endpoint answered HTTP ${status}`);
      }
      if (++consecutiveErrors > IMAGE_ASYNC_POLL_MAX_ERRORS) {
        throw new ImageGenerationError('provider', `${leg.model} async job ${jobLabel}: the status endpoint failed ${IMAGE_ASYNC_POLL_MAX_ERRORS}+ times in a row (${describeError(pollErr, leg.apiKey)})`);
      }
      logger.warn(`image-generate: async job ${jobLabel} status poll failed (${describeError(pollErr, leg.apiKey)}) — poll ${polls}, tolerated ${consecutiveErrors}/${IMAGE_ASYNC_POLL_MAX_ERRORS}`);
    }
    if (resp) {
      consecutiveErrors = 0;
      const finished = parseAsyncJobStatus(resp);
      if (!finished.recognized) {
        // Review f246 finding 6: an empty / non-JSON / alien status body means
        // the status route is broken — say so after a bounded run instead of
        // burning the whole budget as a generic timeout.
        if (++consecutiveUnparseable >= IMAGE_ASYNC_POLL_MAX_UNPARSEABLE) {
          throw new ImageGenerationError(
            'provider',
            `${leg.model} async job ${jobLabel}: ${IMAGE_ASYNC_POLL_MAX_UNPARSEABLE} consecutive status responses carried no recognizable job state (broken status route? last body: ${(finished.preview || '').slice(0, 160)})`,
          );
        }
      } else {
        consecutiveUnparseable = 0;
      }
      if (finished.state === 'failed') {
        throw new ImageGenerationError('provider', `${leg.model} async job ${jobLabel} failed${finished.detail ? ` — ${redactKeyMaterial(finished.detail, leg.apiKey).slice(0, 200)}` : ''}`);
      }
      if (finished.state === 'done') {
        const payload = finished.payload;
        if (payload == null) {
          // Done with no image anywhere — a broken provider response.
          throw new ImageGenerationError('provider', `${leg.model} async job ${jobLabel} completed with no image${finished.detail ? ` — ${redactKeyMaterial(finished.detail, leg.apiKey).slice(0, 200)}` : ''}`);
        }
        const bytes = payload.bytes ?? await downloadImage(payload.url!, leg.model, req.deadline);
        return acceptImageBytes(bytes, leg.model);
      }
      // 'running' — fall through to the interval wait.
    }
    const remaining = req.deadline - Date.now();
    if (remaining < MIN_POLL_MS + IMAGE_ASYNC_POLL_TIMEOUT_MS) {
      throw new ImageGenerationError('timeout', `${leg.model} async job ${jobLabel} timed out: the polling budget ran out (${Math.max(0, remaining)} ms left, ${polls} polls) before the job completed`);
    }
    await sleep(Math.min(IMAGE_ASYNC_POLL_INTERVAL_MS, Math.max(MIN_POLL_MS, remaining - IMAGE_ASYNC_POLL_TIMEOUT_MS)));
  }
}

/** Read one status GET's answer: a JSON job-status body (normal) or raw image
 *  bytes (a shim that answers the FINAL poll with the image directly).
 *  `recognized:false` = the body carries NO recognizable job state (empty,
 *  non-JSON, alien JSON) — the poll loop bounds those instead of silently
 *  spinning to the budget (review f246 finding 6); `preview` is a short body
 *  snippet for that error. */
function parseAsyncJobStatus(resp: any): { state: 'running' | 'done' | 'failed'; payload?: { bytes?: Buffer; url?: string }; detail?: string; recognized: boolean; preview: string } {
  const contentType = String(resp?.headers?.['content-type'] || '');
  let raw: any = resp?.data;
  // The poll ships responseType 'arraybuffer' so a raw-image final answer
  // arrives intact — decode text-ish bodies to a string before JSON-parsing.
  const isBytes = Buffer.isBuffer(raw) || raw instanceof ArrayBuffer || (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(raw));
  const buf = isBytes ? Buffer.from(raw as any) : null;
  if (buf) raw = buf.toString('utf8');
  const preview = typeof raw === 'string' ? raw.trim().slice(0, 200) : '';
  // Raw image answer: the poll IS the delivery (no JSON status envelope).
  // Sniff the BYTES, not the content-type label — a shim may mislabel or omit
  // the header on the final poll (review f246 finding 6); a content-type that
  // CLAIMS image/* but carries non-image bytes falls through to the JSON path
  // and surfaces as unparseable rather than delivering garbage.
  if (buf && buf.length > 0 && (/^image\//i.test(contentType) || sniffMime(buf))) {
    if (sniffMime(buf)) return { state: 'done', payload: { bytes: buf }, recognized: true, preview };
  }
  let parsed: any = raw;
  let parsedJson = false;
  if (typeof parsed === 'string' && parsed.trim()) {
    try { parsed = JSON.parse(parsed); parsedJson = true; } catch { parsed = { detail: parsed }; }
  } else if (parsed && typeof parsed === 'object') {
    // An already-decoded JSON body (axios parses by content-type when the
    // caller did not force arraybuffer — and tests hand objects directly).
    parsedJson = true;
  }
  // `||` not `??` (review f246 finding 12): an EMPTY string body must not
  // survive as a string primitive — it becomes {} and reads as unparseable.
  parsed = parsed || {};
  // OpenAI images-job flavour: { id, status: 'completed'|'failed'|'in_progress', …, output/output_data: [ { b64_json | url } ]}
  const status: unknown =
    typeof parsed.status === 'string' ? parsed.status
      : typeof parsed.state === 'string' ? parsed.state
        : typeof parsed?.job?.status === 'string' ? parsed.job.status : undefined;
  const images: any[] =
    Array.isArray(parsed?.output) ? parsed.output
      : Array.isArray(parsed?.output_data) ? parsed.output_data
        : Array.isArray(parsed?.data) ? parsed.data
          : Array.isArray(parsed?.images) ? parsed.images : [];
  const detail = String(parsed?.error?.message ?? parsed?.message ?? parsed?.detail ?? '').trim();
  const flatStatus = String(status ?? '').trim().toLowerCase();
  const failed = ASYNC_JOB_FAILED.has(flatStatus) || /fail|error|cancel|reject/i.test(String(parsed?.error?.code ?? parsed?.error ?? ''));
  if (failed) return { state: 'failed', detail: detail || summarize(parsed), recognized: true, preview };
  const firstImage = images.find((im: any) => im && (typeof im.b64_json === 'string' || typeof im.url === 'string' || typeof im.image === 'string'));
  if (firstImage) {
    const b64 = typeof firstImage.b64_json === 'string' && firstImage.b64_json ? firstImage.b64_json : undefined;
    const url = typeof firstImage.url === 'string' && firstImage.url ? firstImage.url
      : typeof firstImage.image === 'string' && /^https?:\/\//i.test(firstImage.image) ? firstImage.image : undefined;
    if (b64 || url) return { state: 'done', payload: b64 ? { bytes: Buffer.from(b64, 'base64') } : { url: url! }, recognized: true, preview };
  }
  if (ASYNC_JOB_DONE.has(flatStatus)) {
    // Completed but no recognizable image in the body — a provider-shape error.
    return { state: 'done', payload: null as any, recognized: true, preview };
  }
  // A body with a recognizable status/id shape but a non-terminal status reads
  // as running; a body with NOTHING recognizable reads as unparseable — that
  // is finding 6's signal. A non-JSON body NEVER counts as recognizable (its
  // `{detail}` wrapper is exactly the broken-shim HTML case); a JSON body with
  // no status/images/id is alien JSON — also unparseable.
  const recognized = parsedJson
    && (flatStatus !== '' || images.length > 0 || parsed?.id != null || parsed?.job != null || parsed?.task != null);
  return { state: 'running', detail, recognized, preview };
}

/**
 * One leg with its retry rules: a 429 with a short Retry-After waits once; a
 * 5xx retries `leg.retries` times; a refusal (from a 4xx body) propagates.
 * Every ATTEMPT is clamped to the call's deadline (review 2026-09-24: the
 * retry used to re-run with the full per-leg timeout, so a 55 s admin probe
 * could hold the request 55 s + 55 s + a 60 s download while the provider
 * kept billing), and a retry / Retry-After wait is skipped when less than
 * MIN_LEG_MS of the budget would remain for it.
 */
async function runLeg(leg: ImageLeg, req: LegRequest, size: string, timeoutMs: number): Promise<LegOutput> {
  let attempt = 0;
  let waited = false;
  for (;;) {
    try {
      const attemptTimeout = clampToDeadline(timeoutMs, req.deadline);
      return leg.provider === 'dashscope'
        ? await dashscopeImageLeg(leg, req, size, attemptTimeout)
        : await openaiImagesLeg(leg, req, size, attemptTimeout);
    } catch (err: any) {
      if (err instanceof ImageGenerationError) throw err;
      const status: number | undefined = err?.response?.status;
      const data = err?.response?.data;
      const code = data?.code ?? data?.error?.code;
      if (isDashScopeRefusalCode(code) || (leg.provider !== 'dashscope' && isZaiRefusalCode(code))) {
        const message = String(data?.message ?? data?.error?.message ?? '').slice(0, 160);
        throw new ImageGenerationError('refused', `${leg.model} refused the request on content-safety grounds (${code}${message ? `: ${message}` : ''})`);
      }
      const remaining = req.deadline - Date.now();
      if (status === 429 && !waited) {
        const wait = retryAfterMs(err?.response?.headers?.['retry-after']);
        if (wait != null && wait <= RETRY_AFTER_MAX_MS && remaining - wait >= MIN_LEG_MS) {
          waited = true;
          logger.warn(`image-generate: ${leg.model} (${leg.provider}) rate-limited — waiting ${wait} ms once (Retry-After)`);
          await sleep(wait);
          continue;
        }
      }
      if (typeof status === 'number' && status >= 500 && attempt < leg.retries) {
        if (remaining < MIN_LEG_MS) {
          logger.warn(`image-generate: ${leg.model} (${leg.provider}) HTTP ${status}${code ? ` code ${code}` : ''} — no retry, ${Math.max(0, remaining)} ms of the budget left`);
          throw err;
        }
        attempt++;
        logger.warn(`image-generate: ${leg.model} (${leg.provider}) HTTP ${status}${code ? ` code ${code}` : ''} — retrying once`);
        continue;
      }
      throw err;
    }
  }
}

/** The Image reader seat describes the reference ONCE for text-only legs (referenceMode 'described'). */
async function describeReference(reference: NonNullable<GenerateImageInput['reference']>): Promise<string> {
  try {
    const { describeImageWithVision } = await import('./image-describe');
    const text = (await describeImageWithVision(reference.bytes, reference.mimeType, reference.name || 'reference-image')).trim();
    if (!text) throw new Error('empty description');
    return text.slice(0, DESCRIPTION_MAX_CHARS);
  } catch (err: any) {
    throw new ImageGenerationError('provider', `No edit-capable image model is servable for the reference image, and the Image reader seat could not describe it (${String(err?.message || err).slice(0, 200)}).`);
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function generateImage(input: GenerateImageInput): Promise<GeneratedImage> {
  const t0 = Date.now();
  const prompt = String(input.prompt || '').trim();
  if (!prompt) throw new ImageGenerationError('provider', 'A prompt is required to generate an image');
  const aspect: ImageAspect = IMAGE_ASPECTS.includes(input.aspect as ImageAspect) ? (input.aspect as ImageAspect) : 'square';
  const pinned = String(input.spec || '').trim();
  const specs = pinned ? [pinned] : await seatChainSpecs();
  const skipped: string[] = [];
  const legs: ImageLeg[] = [];
  for (const s of specs) {
    // F1 (61d33af9 review): the probe flag rides into legForSpec so a custom
    // leg's per-request timeout derives from the probe budget on THIS path.
    const leg = await legForSpec(s, skipped, input.probe === true);
    if (leg) legs.push(leg);
  }
  if (!legs.length) throw new ImageGenerationError('unconfigured', imageUnconfiguredMessage(skipped));

  let referenceMode: ReferenceMode = 'none';
  let runLegs = legs;
  let promptText = buildPrompt(prompt, input.style);
  /** Specs that joined ONLY through IMAGE_EDIT_FALLBACK_CHAIN — the result stamps editLegSource 'fallback' when one serves. */
  const fallbackSpecs = new Set<string>();
  if (input.reference?.bytes?.length) {
    const editLegs = legs.filter(l => l.edits);
    const seatHasEditLeg = editLegs.length > 0;
    // Same-key edit-capable fallbacks (never for a pinned spec): a 429 or a
    // slow first leg no longer fails the edit outright — and (WI-P 2026-09-25)
    // a seat chain with NO edit-capable leg still gets a true edit on these
    // legs instead of a described reference.
    if (!pinned) {
      for (const s of IMAGE_EDIT_FALLBACK_CHAIN) {
        if (editLegs.some(l => l.spec === s)) continue;
        const extra = await legForSpec(s, skipped);
        if (extra?.edits) { editLegs.push(extra); fallbackSpecs.add(extra.spec); }
      }
      if (!seatHasEditLeg && editLegs.length) {
        logger.info(`image-generate: the seat chain has no edit-capable leg — the reference runs on the same-key edit legs ${editLegs.map(l => l.spec).join(', ')} (editLegSource fallback)`);
      }
    }
    if (editLegs.length) {
      runLegs = editLegs;
      referenceMode = 'native';
    } else {
      const description = await describeReference(input.reference);
      promptText += `\nReference image (described by the Image reader — this model takes text only): ${description}`;
      referenceMode = 'described';
    }
  }
  // 2026-10-23 (04c8ffd1): the budget scales with a custom leg's per-request
  // timeout (per-entry or env) so a raised leg cap is not strangled by the old
  // flat 240 s whole-call budget. `legs` (ALL resolved legs), not `runLegs` —
  // the budget must still cover a seated custom leg that an edit narrowed out
  // of the run set. Built-ins never scale it (max stays 0 unless a custom leg
  // resolved).
  const maxCustomLegTimeoutMs = legs.reduce((m, l) => l.provider === 'custom' ? Math.max(m, l.timeoutMs) : m, 0);
  const deadline = t0 + imageCallBudgetMs(input.timeoutMs, maxCustomLegTimeoutMs);
  const req: LegRequest = {
    prompt: promptText,
    polish: input.polish === true,
    probe: input.probe === true,
    negativePrompt: input.negativePrompt,
    ...(referenceMode === 'native' ? { reference: { bytes: input.reference!.bytes, mimeType: input.reference!.mimeType } } : {}),
    deadline,
  };

  let lastErr: any = null;
  let lastLeg: ImageLeg | null = null;
  /** 09a03aef (review): the budget died before ANY leg ran — the thrown code
   *  must read 'timeout', not fall through isTimeout() on the synthetic
   *  "budget is exhausted" message (which names no timeout). */
  let budgetDied = false;
  // 09a03aef: substitution attribution. `substitutedFor` is the SEAT's
  // effective spec — specs[0], never runLegs[0]: the edit path can narrow the
  // run set to edit-capable legs (a text-only seated spec never carries the
  // request — editLegSource alone covers that shape), and a spec that never
  // resolved is in neither list. The reason is THAT leg's OWN failure class —
  // a later leg's error must never relabel it (a seated model that timed out
  // stays 'timeout' even when a later leg 401s first). 'unavailable' = the
  // seat's spec did not resolve as a runnable leg at all (endpoint
  // deleted/disabled/renamed); the stamp then says exactly that.
  const seatSpec = pinned ? '' : (specs[0] || '');
  let seatSpecReason: 'timeout' | 'provider' | 'unavailable' | null =
    seatSpec && !legs.some(l => l.spec === seatSpec) ? 'unavailable' : null;
  for (const leg of runLegs) {
    const remaining = deadline - Date.now();
    if (remaining < MIN_LEG_MS) {
      if (!lastErr) { lastErr = new Error('the time budget is exhausted'); budgetDied = true; }
      break;
    }
    const size = req.probe ? leg.probeSize : leg.sizes[aspect];
    // prompt_extend / hd roughly doubles a DashScope leg's latency (4 s → 48 s
    // measured), and so does a reference image (an edit measured 42.9 s live) —
    // the plan's 120 s budget for both (review 2026-09-24).
    const slow = req.polish || !!req.reference;
    const legTimeout = leg.provider === 'dashscope' && slow && !req.probe ? leg.timeoutMs * 2 : leg.timeoutMs;
    try {
      const out = await runLeg(leg, req, size, Math.min(legTimeout, remaining));
      return {
        ...out, model: leg.model, provider: leg.provider, spec: leg.spec, latencyMs: Date.now() - t0, referenceMode,
        ...(referenceMode === 'native' ? { editLegSource: (fallbackSpecs.has(leg.spec) ? 'fallback' : 'seat') as EditLegSource } : {}),
        ...(seatSpec && seatSpecReason && leg.spec !== seatSpec
          ? { substitutedFor: seatSpec, substitutionReason: seatSpecReason }
          : {}),
      };
    } catch (err: any) {
      if (err instanceof ImageGenerationError && err.code === 'refused') throw err;
      lastErr = err;
      lastLeg = leg;
      if (leg.spec === seatSpec) seatSpecReason = isTimeout(err) ? 'timeout' : 'provider';
      logger.warn(`image-generate: leg ${leg.model} (${leg.provider}) failed — ${describeError(err, leg.apiKey)}`);
    }
  }
  const code: ImageGenerationErrorCode = budgetDied || isTimeout(lastErr) ? 'timeout' : 'provider';
  throw new ImageGenerationError(code, `Image generation failed${lastLeg ? ` (last leg ${lastLeg.model} via ${lastLeg.provider})` : ''}: ${describeError(lastErr, lastLeg?.apiKey)}`);
}

export interface ImageProbeResult {
  ok: boolean;
  latencyMs: number;
  detail: string;
  /** The generated thumbnail (the admin page renders it). */
  image?: { mediaType: string; data: string };
}

/**
 * The admin Test button: generate the smallest image the pinned leg allows
 * (prompt_extend off) and hand back the bytes as base64 — the page shows the
 * picture, which proves more than "HTTP 200". Never throws; errors come back
 * key-scrubbed in `detail`.
 */
export async function probeImageGenerate(spec: string, timeoutMs: number = imageProbeTimeoutMs()): Promise<ImageProbeResult> {
  const t0 = Date.now();
  try {
    const img = await generateImage({ prompt: IMAGE_PROBE_PROMPT, aspect: 'square', probe: true, spec, timeoutMs });
    const dims = img.width && img.height ? `${img.width}×${img.height} ` : '';
    // 09a03aef: the probe runs at the SMALLEST size under the probe budget —
    // for a custom (registry) leg, append what that latency implies at CHAIN
    // sizes under the CHAIN timeout, so a green Test that would time out on
    // 100% of real traffic says so in its own detail line. The chain timeout
    // here is the same value legForSpec() uses on the chain path (the entry's
    // imageTimeoutMs when set, else the instance default).
    let chainRepresentativeness = '';
    if (spec.includes(':')) {
      try {
        const { resolveRegistryModel } = await import('./model-endpoints/model-endpoints.service');
        const reg = await resolveRegistryModel(spec);
        if (reg?.image === true) {
          chainRepresentativeness = probeChainRepresentativeness(
            img.latencyMs,
            reg.imageTimeoutMs && reg.imageTimeoutMs > 0 ? reg.imageTimeoutMs : imageCustomTimeoutMs(),
          );
        }
      } catch { /* a registry miss must not break the Test button */ }
    }
    return {
      ok: true,
      latencyMs: img.latencyMs,
      detail: `${img.model} OK — ${dims}${img.mimeType}, ${img.bytes.length.toLocaleString()} bytes (${img.provider}, ${(img.latencyMs / 1000).toFixed(1)}s)${chainRepresentativeness ? ` — ${chainRepresentativeness}` : ''}`,
      image: { mediaType: img.mimeType, data: img.bytes.toString('base64') },
    };
  } catch (err: any) {
    return { ok: false, latencyMs: Date.now() - t0, detail: describeError(err) };
  }
}

export default { generateImage, probeImageGenerate, imageSpecEnvKey };
