/**
 * IntegrationsTab — X read-health badge pins (ticket fa956f09, 2026-09-24).
 *
 * The 2026-09-22 X outage was invisible in Account → Integrations: "connected"
 * only reflects the per-user OAuth row, while the platform read path (x-mcp →
 * Bright Data gateway) served empty x_search / x_get_trends results for a
 * full day. The tab now ALSO fetches /x/status and badges a failing read path.
 *
 * Pins use the repo's SOURCE-LEVEL idiom for effectful components
 * (ModelRolesSection.test.tsx precedent: the section fetches in effects — a
 * full SSR render only shows the loading spinner), so these read the
 * component + API-client sources and assert the stable identifiers.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const readSrc = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const TAB = readSrc('./IntegrationsTab.tsx');
const API = readSrc('../../../lib/api/crossmodel.ts');

describe('IntegrationsTab — X read-path health badge (fa956f09)', () => {
  it('fetches /x/status read health alongside the accounts list', () => {
    // The badge can only exist if the health is fetched — pin the wiring.
    expect(TAB).toContain('setXReadHealth(status.readHealth');
    expect(TAB).toContain("await xApi.getStatus()");
  });

  it('a failing read path renders the amber "Reads failing" badge — never just "connected"', () => {
    expect(TAB).toContain("xReadHealth?.status === 'fail'");
    expect(TAB).toContain('Reads failing');
    // The detail line tells the owner it is platform-side (not their auth)…
    expect(TAB).toContain('Your connection is fine; no need to reconnect');
    // …and surfaces the recorded reason + recency.
    expect(TAB).toContain('xReadHealth.lastError');
    expect(TAB).toContain('absoluteDate(xReadHealth.lastErrorAt)');
  });

  it('XStatus carries the readHealth payload (backend → frontend contract)', () => {
    expect(API).toContain('readHealth?: {');
    expect(API).toContain("status: 'ok' | 'fail'");
    expect(API).toContain('failureCount: number');
  });

  it('the badge is additive — the connected badge and account list are untouched', () => {
    expect(TAB).toContain('{xAccounts.length} connected');
    expect(TAB).toContain('xAccounts.map((acct)');
  });
});
