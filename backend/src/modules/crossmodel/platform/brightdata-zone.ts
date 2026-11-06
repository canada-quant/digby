/**
 * Bright Data ZONE validation (ticket 02f8c83f).
 *
 * THE DEFECT CLASS: "saved Bright Data key + green config surface, search
 * silently dead." Measured live on digby.cql.ca 2026-11-06: the stored row had
 * `zone: null`, so resolution fell back to `DEFAULT_UNLOCKER_ZONE`
 * ('web_unlocker1') — a zone that does NOT exist on that account. Bright Data
 * answered every SERP and scrape with **HTTP 200 and a zero-byte body**,
 * putting the truth only in headers:
 *
 *     x-brd-status-code: 407
 *     x-brd-err-code:    client_10002
 *     x-brd-error:       Zone not found
 *
 * A 200-with-empty-body looked identical to "no results", so nobody was told
 * the zone was wrong; it was fixed by hand on the box and the code kept the
 * trap armed for the next operator.
 *
 * This leaf owns the two halves of the code fix:
 *  1. `isZoneErrorCode` / `zoneErrorFromHeaders` — classify the provider's own
 *     rejection so the search tier can say ZONE CONFIG ERROR instead of
 *     "returned nothing" (see brightdata-direct's DirectZoneError).
 *  2. `probeAccountZones` — ask the account which zones EXIST
 *     (`GET /zone/get_active_zones`, the documented endpoint; response is
 *     `[{name,type}, …]`), so the admin save path can reject an unresolvable
 *     zone at SAVE time and the status read can flag a dead default.
 *
 * Failure policy: a probe is best-effort and NEVER throws. `ok:false` means
 * "we could not ask" (no token, timeout, non-200, unparseable) — callers must
 * treat that as UNVERIFIED, never as a clean bill of health and never as a
 * reason to block a save (an operator fixing a bad zone must not be stopped by
 * a provider hiccup).
 */

import axios from 'axios';
import crypto from 'crypto';
import logger from '../../../utils/logger';

/** The provider err-code Bright Data returns for a zone that does not exist. */
export const ZONE_NOT_FOUND_CODE = 'client_10002';
/** The documented "which zones does this account have" endpoint. */
export const ACTIVE_ZONES_URL = 'https://api.brightdata.com/zone/get_active_zones';
/** A probe must never make an admin page (or a save) feel hung. */
export const ZONE_PROBE_TIMEOUT_MS = 4_000;
/** The zone list is account-level and changes rarely — one probe per minute. */
const PROBE_CACHE_TTL_MS = 60_000;

export interface ActiveZone {
  name: string;
  type: string;
}

export interface ZoneProbe {
  /** True only when the account's zone list was actually READ. */
  ok: boolean;
  zones: ActiveZone[];
  /** Why the probe could not answer (operator-facing; absent when ok). */
  reason?: string;
}

/** True when a provider err-code names a ZONE problem rather than an ACL/credential one. */
export function isZoneErrorCode(code: unknown): boolean {
  const c = String(code ?? '').trim().toLowerCase();
  return c === ZONE_NOT_FOUND_CODE;
}

/**
 * Extract the provider's zone rejection from response headers, or null.
 * Bright Data wraps these as HTTP 200, so the headers are the ONLY signal.
 */
export function zoneErrorFromHeaders(headers: Record<string, any> | undefined): { code: string; detail: string } | null {
  const h = headers || {};
  const code = String(h['x-brd-err-code'] ?? h['x-brd-err_code'] ?? '').trim();
  if (!isZoneErrorCode(code)) return null;
  const detail = String(h['x-brd-err'] ?? h['x-brd-err-msg'] ?? h['x-brd-error'] ?? 'Zone not found').trim();
  return { code, detail };
}

/** The zone names on an account that can serve the unlocker/SERP tier. */
export function unblockerZones(zones: ActiveZone[]): string[] {
  return zones
    .filter(z => /^(unblocker|serp|browser_api)$/i.test(String(z.type || '')))
    .map(z => z.name)
    .filter(Boolean);
}

let _cache: { at: number; key: string; probe: ZoneProbe } | null = null;

/** Test seam: forget the cached zone list. */
export function __clearZoneProbeCache(): void {
  _cache = null;
}

/**
 * Ask the account which zones exist. Never throws.
 *
 * Cached for 60 s per process (keyed on the token's tail — a different key is a
 * different account). `ok:false` carries the reason the probe could not answer.
 */
export async function probeAccountZones(token: string, opts: { timeoutMs?: number; skipCache?: boolean } = {}): Promise<ZoneProbe> {
  const tok = String(token || '').trim();
  if (!tok) return { ok: false, zones: [], reason: 'no API token to probe with' };
  // Hash the key: two accounts whose tokens share a suffix must never share a
  // cached verdict (reviewer F5). In-memory only — the key never leaves this
  // function and the digest is not reversible.
  const key = crypto.createHash('sha256').update(tok).digest('hex').slice(0, 16);
  if (!opts.skipCache && _cache && _cache.key === key && Date.now() - _cache.at < PROBE_CACHE_TTL_MS) {
    return _cache.probe;
  }
  let probe: ZoneProbe;
  try {
    const r = await axios.get(ACTIVE_ZONES_URL, {
      headers: { Authorization: `Bearer ${tok}` },
      timeout: opts.timeoutMs ?? ZONE_PROBE_TIMEOUT_MS,
      validateStatus: () => true,
    });
    const status = typeof r?.status === 'number' ? r.status : 200;
    if (status < 200 || status >= 300) {
      probe = { ok: false, zones: [], reason: `zone list request answered HTTP ${status}` };
    } else {
      const data = typeof r.data === 'string' ? safeJson(r.data) : r.data;
      const raw: any[] = Array.isArray(data) ? data : Array.isArray(data?.zones) ? data.zones : [];
      const zones: ActiveZone[] = raw
        .map((z: any) => ({ name: String(z?.name ?? z?.zone ?? '').trim(), type: String(z?.type ?? '').trim() }))
        .filter((z: ActiveZone) => !!z.name);
      // An empty/absent list is NOT proof the account has no zones — it is a
      // shape we do not understand. Treated as unverified (never 'invalid').
      probe = zones.length
        ? { ok: true, zones }
        : { ok: false, zones: [], reason: 'the zone list came back empty or in an unrecognized shape' };
    }
  } catch (e: any) {
    probe = { ok: false, zones: [], reason: String(e?.message || e || 'zone list request failed').slice(0, 160) };
  }
  try {
    logger.info(
      `BrightData zone probe: ${probe.ok ? `${probe.zones.length} active zone(s)` : `unavailable (${probe.reason})`}`,
      { source: 'brightdata-zone', tool: 'zone-probe' },
    );
  } catch { /* logging is best-effort */ }
  _cache = { at: Date.now(), key, probe };
  return probe;
}

function safeJson(text: string): any {
  try { return JSON.parse(text); } catch { return null; }
}

/**
 * The operator-facing save-time error for a zone the account does not have
 * (pure — easy to pin). Names the zone the operator must change, the
 * provider's own err-code, what search USED to do (silent 200s), and the zones
 * that DO exist so the fix is one paste away.
 */
export function zoneSaveErrorMessage(zone: string, zones: ActiveZone[], opts: { fromDefault?: boolean } = {}): string {
  const have = unblockerZones(zones);
  const listed = have.length ? have.join(', ') : zones.map(z => z.name).join(', ');
  const lead = opts.fromDefault
    ? `No zone was given, so search would fall back to the default "${zone}" — which does not exist on this Bright Data account`
    : `Zone "${zone}" does not exist on this Bright Data account`;
  return `${lead} (provider err-code ${ZONE_NOT_FOUND_CODE} / HTTP 407 "Zone not found"). `
    + 'Left as is, every search and page read would answer HTTP 200 with an empty body — the settings page would look healthy while search is dead. '
    + `Active zones on this account: ${listed || '(none listed)'}. `
    + 'Save again with one of those zone names in the Zone field. The API key itself is fine — do not rotate it.';
}