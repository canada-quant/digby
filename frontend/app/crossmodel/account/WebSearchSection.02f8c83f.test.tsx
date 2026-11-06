/**
 * Ticket 02f8c83f — "a nonexistent Bright Data zone looks healthy while search
 * is silently dead", the ADMIN UI half.
 *
 * The defect, measured live on digby.cql.ca 2026-11-06: the stored search row
 * had `zone: null`, so the backend fell back to DEFAULT_UNLOCKER_ZONE
 * ('web_unlocker1') — a zone the account does not have. Bright Data answered
 * every search with **HTTP 200 and a zero-byte body** (x-brd-err-code
 * client_10002 / 407 "Zone not found"), so search returned nothing at all.
 *
 * The settings page rendered exactly:
 *
 *     <span className="font-mono">{status.zone ?? '(default: web_unlocker1)'}</span>
 *
 * i.e. a saved, readable key next to a green default — the trap in one line.
 *
 * Pins (source-level, the repo's idiom for effectful account components —
 * SupervisorsSection.test.tsx / PatienceAutoOnlySection.test.tsx):
 *  1. The panel shows the RESOLVED zone (`resolvedZone`), not the raw stored
 *     value, and never the old unconditional '(default: web_unlocker1)' string.
 *  2. A zone known NOT to exist renders a destructive problem banner; an
 *     UNVERIFIED zone renders a warning; only a verified zone stays quiet.
 *  3. `describeZoneState` never calls an unverified or dead zone healthy, and
 *     names the provider err-code / HTTP 200-with-empty-body consequence.
 *  4. The API client type carries the new fields the panel reads.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { describeZoneState } from './WebSearchSection';
import type { WebSearchConfigStatus } from '@/lib/api/crossmodel';

const readSrc = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const SECTION = readSrc('./WebSearchSection.tsx');
const API = readSrc('../../../lib/api/crossmodel.ts');

type ZoneFacts = Pick<WebSearchConfigStatus, 'resolvedZone' | 'zoneVerified' | 'zoneProbeError' | 'zoneError' | 'zone'>;

const facts = (over: Partial<ZoneFacts> = {}): ZoneFacts => ({
  resolvedZone: 'web_unlocker1',
  zoneVerified: null,
  zoneProbeError: null,
  zoneError: null,
  zone: null,
  ...over,
});

describe('WebSearchSection — the zone surface (ticket 02f8c83f)', () => {
  it('shows the RESOLVED zone and never the old unconditional default string', () => {
    expect(SECTION).toContain('data-testid="web-search-zone-in-use"');
    expect(SECTION).toContain('status.resolvedZone');
    // The exact trap line from the ticket must be gone.
    expect(SECTION).not.toContain("status.zone ?? '(default: web_unlocker1)'");
    expect(SECTION).toContain("' (default)'");
  });

  it('a zone that does NOT exist renders a destructive banner, not a green row', () => {
    expect(SECTION).toContain('data-testid="web-search-zone-problem"');
    expect(SECTION).toContain('status.zoneVerified === false');
    expect(SECTION).toContain('Zone does not exist — search is silently dead');
    expect(SECTION).toContain('border-destructive/40');
    // …and it offers the account's real zones so the fix is one paste.
    expect(SECTION).toContain('status.activeZones.join');
  });

  it('an UNVERIFIED zone renders a warning badge/banner — never silent success', () => {
    expect(SECTION).toContain('data-testid="web-search-zone-unverified"');
    expect(SECTION).toContain('status.zoneVerified === null');
    expect(SECTION).toContain('status.zoneProbeError');
    expect(SECTION).toContain('Zone exists on the account');
  });

  it('an observed zone rejection is reported by describeZoneState even when the probe could not answer', () => {
    expect(SECTION).toContain('s.zoneError');
    // The banner is gated on the VERDICT, not on a possibly-stale rejection
    // record (reviewer F3): a repaired zone must stop rendering red.
    expect(SECTION).toContain('status.zoneVerified === false ?');
    expect(SECTION).not.toContain('status.zoneVerified === false || status.zoneError');
  });

  it('F4: the zone rows render for an env-only instance (no stored row at all)', () => {
    // The "Zone in use / exists" block must sit OUTSIDE the storeConfigured
    // gate, or a verified env-only instance showed no zone line while the docs
    // promised it always shows the zone in use. Ordering is the assertion: the
    // zone block must come BEFORE the store-key block.
    const zoneBlock = SECTION.indexOf('data-testid="web-search-zone-in-use"');
    const storeBlock = SECTION.indexOf('{status?.storeConfigured && (');
    expect(zoneBlock).toBeGreaterThan(-1);
    expect(storeBlock).toBeGreaterThan(-1);
    expect(zoneBlock).toBeLessThan(storeBlock);
    expect(SECTION).toContain('status && status.source !== null && status.resolvedZone && (');
  });

  it('the API client type carries every new field the panel reads', () => {
    expect(API).toContain('resolvedZone: string | null;');
    expect(API).toContain('zoneVerified: boolean | null;');
    expect(API).toContain('zoneProbeError: string | null;');
    expect(API).toContain('activeZones: string[];');
    expect(API).toContain('zoneError: { zone: string; code: string; at: string } | null;');
  });
});

describe('describeZoneState — the one-line truth, never "healthy" for a dead default', () => {
  it('REPLAYS THE INCIDENT: null stored zone + default missing from the account says search is DEAD', () => {
    const msg = describeZoneState(facts({ zone: null, resolvedZone: 'web_unlocker1', zoneVerified: false }));
    expect(msg).toContain('"web_unlocker1"');
    expect(msg).toContain('built-in default');
    expect(msg).toContain('does NOT exist');
    expect(msg).toContain('HTTP 200 with an empty body');
    expect(msg).toContain('silently dead');
    expect(msg).toContain('API key itself is fine');
    expect(msg).not.toMatch(/healthy|fine and dandy/i);
  });

  it('an UNVERIFIED zone is explicitly NOT the same as healthy', () => {
    const msg = describeZoneState(facts({ zoneVerified: null, zoneProbeError: 'getaddrinfo ENOTFOUND' }));
    expect(msg).toContain('could not be verified');
    expect(msg).toContain('ENOTFOUND');
    expect(msg).toContain('NOT the same as healthy');
    expect(msg).toContain('get_active_zones');
  });

  it('an OBSERVED rejection is reported with its err-code and time, even if the probe was down', () => {
    const msg = describeZoneState(facts({
      zoneVerified: null,
      zoneError: { zone: 'web_unlocker1', code: 'client_10002', at: '2026-11-06T04:12:00.000Z' },
    }));
    expect(msg).toContain('REFUSED');
    expect(msg).toContain('client_10002');
    expect(msg).toContain('silently dead');
  });

  it('a VERIFIED zone reads as existing (the only case that may sound reassuring)', () => {
    const msg = describeZoneState(facts({ zone: 'web_unlocker2', resolvedZone: 'web_unlocker2', zoneVerified: true }));
    expect(msg).toContain('"web_unlocker2"');
    expect(msg).toContain('exists on this Bright Data account');
    expect(msg).not.toContain('silently dead');
  });

  it('nothing resolved says search is not configured (no phantom zone)', () => {
    expect(describeZoneState(facts({ resolvedZone: null, zoneVerified: null }))).toContain('not configured');
  });
});