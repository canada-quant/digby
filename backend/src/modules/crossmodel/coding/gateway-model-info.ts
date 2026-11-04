/**
 * LiteLLM /model/info at RUN TIME (audit 2026-10-08 W2-3).
 *
 * Evidence (lanes.md F5, plumbing.md F4): the One Piece lane's project-pinned
 * `cql-litellm:api-alibaba-qwen3.8-max` ran every run at the 160k-char registry
 * DEFAULT (`context_budget` source "default") — 650 compactions in 18 h on one
 * lane (76 % of the fleet's), the same file re-read 35× in one run, $63. None
 * of the gateway's 48 registry models carries a `contextWindow`: LiteLLM's
 * OpenAI-compatible /v1/models publishes none, and the /model/info probe
 * (capability-detect, audit 2026-10-06 T1-2) only ran when an admin pressed
 * "Detect capabilities".
 *
 * The resolve path now asks the gateway itself: GET <baseUrl>/model/info (then
 * the /v1 alias) lists one row per DEPLOYMENT of a model group with
 * `model_info.max_input_tokens`; the group's usable window is the MIN across
 * its deployments (a router may send any request to any of them). The answer is
 * cached per (endpoint baseUrl, key) in-process — 6 h on success, 30 min on a
 * failure (404 on a non-LiteLLM server, timeout, no data[] list) — fetched
 * single-flight with a 3 s HTTP timeout; the resolve path waits for it at most
 * 1.5 s (RESOLVE_WAIT_MS) and otherwise proceeds on the next sizing tier this
 * time while the fetch keeps filling the cache. Never throws.
 *
 * Under jest (NODE_ENV=test / JEST_WORKER_ID) the run-time fetch is OFF unless
 * GATEWAY_MODEL_INFO_RUNTIME_IN_TEST=1 — ~30 suites resolve registry seats with
 * mocked registries and no axios mock; a real network call (or a fake-timer
 * wait that never fires) there would be a flake (same precedent as
 * self-audit-receipt-rule.ts's store read).
 *
 * The two pure parsers (litellmModelInfoUrls / litellmMaxInputTokens) moved
 * here from capability-detect.ts (which re-exports them) so this leaf never
 * pulls capability-detect's prisma / config graph into the run path.
 *
 * Kill switch GATEWAY_MODEL_INFO_RUNTIME_DISABLED=1 (read per call): no fetch,
 * no cache read — the published-window / family / default tiers only.
 */

import axios from 'axios';
import { createHash } from 'crypto';

const onFlag = (v: unknown): boolean => {
  const s = String(v ?? '').trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'on';
};

export function gatewayModelInfoRuntimeDisabled(): boolean {
  return onFlag(process.env.GATEWAY_MODEL_INFO_RUNTIME_DISABLED);
}

/** Whether the resolve path may fetch: not killed, and not under jest unless opted in. */
export function gatewayModelInfoRuntimeEnabled(): boolean {
  if (gatewayModelInfoRuntimeDisabled()) return false;
  const underJest = process.env.NODE_ENV === 'test' || !!process.env.JEST_WORKER_ID;
  return !underJest || onFlag(process.env.GATEWAY_MODEL_INFO_RUNTIME_IN_TEST);
}

/** The /model/info URLs to try for a base URL ('…/v1' → '…/v1/model/info' then '…/model/info'). Pure. */
export function litellmModelInfoUrls(baseUrl: string): string[] {
  const base = String(baseUrl ?? '').replace(/\/+$/, '');
  const root = base.replace(/\/v1$/i, '');
  return [...new Set([`${base}/model/info`, root === base ? `${base}/v1/model/info` : `${root}/model/info`])];
}

/** min(model_info.max_input_tokens) across the deployments of `model` in a /model/info body, or null. Pure. */
export function litellmMaxInputTokens(body: any, model: string): { tokens: number; deployments: number } | null {
  const list: any[] = Array.isArray(body?.data) ? body.data : [];
  const vals = list
    .filter((d) => String(d?.model_name ?? '') === model)
    .map((d) => Number(d?.model_info?.max_input_tokens))
    .filter((v) => Number.isFinite(v) && v > 0);
  return vals.length ? { tokens: Math.floor(Math.min(...vals)), deployments: vals.length } : null;
}

/** Every model group's window in a /model/info body (min across deployments). Pure. */
export function litellmWindowsByModel(body: any): Map<string, number> {
  const out = new Map<string, number>();
  const list: any[] = Array.isArray(body?.data) ? body.data : [];
  for (const d of list) {
    const name = String(d?.model_name ?? '');
    const v = Number(d?.model_info?.max_input_tokens);
    if (!name || !Number.isFinite(v) || v <= 0) continue;
    const prev = out.get(name);
    out.set(name, prev === undefined ? Math.floor(v) : Math.min(prev, Math.floor(v)));
  }
  return out;
}

export const MODEL_INFO_TTL_MS = 6 * 60 * 60_000;
export const MODEL_INFO_FAIL_TTL_MS = 30 * 60_000;
export const MODEL_INFO_FETCH_TIMEOUT_MS = 3_000;
export const RESOLVE_WAIT_MS = 1_500;

interface Entry { ok: boolean; windows: Map<string, number>; expiresAt: number; url?: string }
const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<Entry>>();

function cacheKey(baseUrl: string, apiKey?: string | null): string {
  const k = apiKey ? createHash('sha1').update(apiKey).digest('hex').slice(0, 12) : '';
  return `${String(baseUrl ?? '').replace(/\/+$/, '')}|${k}`;
}

async function fetchEntry(baseUrl: string, apiKey?: string | null): Promise<Entry> {
  for (const url of litellmModelInfoUrls(baseUrl)) {
    try {
      const resp = await axios.get(url, {
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
        timeout: MODEL_INFO_FETCH_TIMEOUT_MS,
      });
      if (!Array.isArray(resp?.data?.data)) continue;
      return { ok: true, windows: litellmWindowsByModel(resp.data), expiresAt: Date.now() + MODEL_INFO_TTL_MS, url };
    } catch { /* try the alias path, then cache the miss */ }
  }
  return { ok: false, windows: new Map(), expiresAt: Date.now() + MODEL_INFO_FAIL_TTL_MS };
}

/** Start (or join) the single-flight fetch for one endpoint; resolves to the cached entry. Never rejects. */
export function refreshGatewayModelInfo(baseUrl: string, apiKey?: string | null): Promise<Entry> {
  const key = cacheKey(baseUrl, apiKey);
  const running = inflight.get(key);
  if (running) return running;
  const p = fetchEntry(baseUrl, apiKey)
    .catch((): Entry => ({ ok: false, windows: new Map(), expiresAt: Date.now() + MODEL_INFO_FAIL_TTL_MS }))
    .then((e) => { cache.set(key, e); inflight.delete(key); return e; });
  inflight.set(key, p);
  return p;
}

/**
 * The gateway-published input window (tokens) for `model` on the endpoint at
 * `baseUrl`, or null (unknown / not LiteLLM / not answered within `waitMs`).
 * A fresh cache entry answers at once; otherwise the fetch starts (or is
 * joined) and is awaited at most `waitMs`. Never throws.
 */
export async function gatewayModelInfoWindow(o: { baseUrl: string; apiKey?: string | null; model: string; waitMs?: number }): Promise<number | null> {
  try {
    if (gatewayModelInfoRuntimeDisabled() || !o.baseUrl || !o.model) return null;
    const key = cacheKey(o.baseUrl, o.apiKey);
    const hit = cache.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.windows.get(o.model) ?? null;
    const p = refreshGatewayModelInfo(o.baseUrl, o.apiKey);
    const waitMs = Math.max(0, o.waitMs ?? RESOLVE_WAIT_MS);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), waitMs); (timer as any)?.unref?.(); });
    const e = await Promise.race([p, timeout]).finally(() => { if (timer) clearTimeout(timer); });
    return e ? (e.windows.get(o.model) ?? null) : null;
  } catch {
    return null;
  }
}

/** Test seam. */
export function __resetGatewayModelInfoForTests(): void {
  cache.clear();
  inflight.clear();
}
