/**
 * Settings placement pins (owner audit 2026-09-21).
 *
 * "I don't like how the browser available and computer use available shows in
 * the sidebar — seems out of place… shouldn't that go in the integrations
 * section of settings?" — plus a pass over every settings tab for anything
 * else misfiled. These pins keep each surface where it now belongs:
 *
 *  - the paired Mac's Browser / Computer-use status renders ONLY in the Mac
 *    agent card under Account → Integrations, never in the chat sidebar's
 *    admin-only "Connected instances" list (which is about paired self-hosted
 *    instances);
 *  - the Mac desktop-app download lives with the Mac agent, not under
 *    Appearance;
 *  - the Integrations header describes the whole tab, not just Google;
 *  - the Mac block leads Integrations, and every account tab is deep-linkable.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (rel: string) => readFileSync(join(__dirname, rel), 'utf8');
const SIDEBAR_INSTANCES = read('../components/ConnectedInstancesSection.tsx');
const MAC_CARD = read('./IMessageCard.tsx');
const INTEGRATIONS = read('./IntegrationsTab.tsx');
const ACCOUNT_PAGE = read('./page.tsx');

describe('Mac agent status lives in Integrations, not the sidebar', () => {
  it('the sidebar Connected-instances section carries no browser / computer-use rows and no iMessage status fetch', () => {
    expect(SIDEBAR_INSTANCES).not.toContain('Browser: available');
    expect(SIDEBAR_INSTANCES).not.toContain('Computer use:');
    expect(SIDEBAR_INSTANCES).not.toContain('localBrowser');
    expect(SIDEBAR_INSTANCES).not.toContain('computerUse');
    expect(SIDEBAR_INSTANCES).not.toContain('imessageApi');
  });

  it('the Mac agent card renders all three capability gates from the one status payload', () => {
    expect(MAC_CARD).toContain('data-mac-capabilities');
    expect(MAC_CARD).toContain('status.localBrowser.available');
    expect(MAC_CARD).toContain('status.computerUse.available');
    expect(MAC_CARD).toContain("'available on this Mac' : 'cloud (read-only)'");
    expect(MAC_CARD).toContain("'ready' : 'not available'");
    // the card is titled for the device, not one of its features
    expect(MAC_CARD).toContain('<span className="text-sm font-semibold">Mac agent</span>');
  });
});

describe('Integrations tab layout', () => {
  it('the Mac block (desktop app + agent card) leads the list, before Google', () => {
    const mac = INTEGRATIONS.indexOf('data-your-mac');
    const google = INTEGRATIONS.indexOf('── Google Workspace section ──');
    expect(mac).toBeGreaterThan(0);
    expect(mac).toBeLessThan(google);
    expect(INTEGRATIONS).toContain('href="/Digby.dmg"');
    expect(INTEGRATIONS.match(/<IMessageCard \/>/g)).toHaveLength(1);
  });

  it('messaging tools sit together and the coming-soon WhatsApp block is last', () => {
    // Exact section comments — the bare names also match the icon-helper
    // comments near the top of the file (`── GitHub icon ──`).
    const order = [
      '── Your Mac —', '── Google Workspace section ──', '── GitHub section', '── Slack section ──', '── Asana section ──',
      '── Xero Accounting section ──', '── Plaid Banking section ──', '── Telegram section', '── X.com (Twitter) section ──',
      '── WhatsApp section ──', '{/* Privacy notice */}',
    ].map((m) => INTEGRATIONS.indexOf(m));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('the header copy describes the whole tab, not just Google Workspace', () => {
    expect(INTEGRATIONS).not.toContain('Connect Google Workspace accounts so Digby can read emails');
    expect(INTEGRATIONS).toContain('Connect your Mac, workspace tools, finance and messaging accounts');
  });
});

describe('Account page', () => {
  it('Appearance no longer hosts the desktop-app download', () => {
    expect(ACCOUNT_PAGE).not.toContain('<h2 className="text-sm font-semibold mb-1">Desktop App</h2>');
    expect(ACCOUNT_PAGE).not.toContain('/Digby.dmg');
  });

  it('every tab id is a valid ?tab= deep link (the old allow-list dropped memory / appearance / coding)', () => {
    expect(ACCOUNT_PAGE).toContain("TABS.some((t) => t.id === tab) || tab === 'admin'");
    expect(ACCOUNT_PAGE).not.toContain("if (tab === 'integrations') return 'integrations';");
  });
});

describe('Feeds tab (RETIRED, ticket 43c24152, 2026-10-20)', () => {
  it('is gone: no Feeds tab, no FeedsTab import, no feeds case in the render switch', () => {
    // Topic feeds were deprecated (owner directive 2026-10-20): a topic digest
    // is a schedule on a real chat now. The whole Feeds UI surface is deleted.
    expect(ACCOUNT_PAGE).not.toContain("label: 'Feeds'");
    expect(ACCOUNT_PAGE).not.toContain("import { FeedsTab } from './FeedsTab';");
    expect(ACCOUNT_PAGE).not.toContain("<FeedsTab />");
    expect(ACCOUNT_PAGE).not.toContain("icon: Rss");
  });

  it('child-account filter no longer names feeds (the tab does not exist)', () => {
    expect(ACCOUNT_PAGE).toContain("TABS.filter((t) => !['kids', 'integrations', 'developer'].includes(t.id))");
    expect(ACCOUNT_PAGE).not.toContain("'feeds'");
  });
});

describe('Advanced tab (RETIRED, ticket c99b404a, 2026-10-27)', () => {
  it('is gone: no Advanced tab, no AdvancedTab import, no advanced case in the render switch', () => {
    // The owner deprecated the tab outright: since roster 2026-10-06 B-3 it
    // was one read-only line — nothing to set. The full pin suite lives in
    // advanced-tab-retirement.c99b404a.test.ts.
    expect(ACCOUNT_PAGE).not.toContain("label: 'Advanced'");
    expect(ACCOUNT_PAGE).not.toContain("import { AdvancedTab } from './AdvancedTab';");
    expect(ACCOUNT_PAGE).not.toContain('<AdvancedTab />');
  });

  it('the child-account filter no longer names advanced (the tab does not exist)', () => {
    expect(ACCOUNT_PAGE).not.toContain("'advanced'");
  });
});
