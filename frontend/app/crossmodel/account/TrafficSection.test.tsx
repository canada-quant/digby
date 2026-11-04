/**
 * Account → Admin → Users & traffic (owner 2026-10-07) — the pure formatters, the SSR-rendered views (node vitest +
 * react-dom/server, the SchedulesSection idiom) and the mount / API pins.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { SourcesView, UsersTable, FlowView } from './TrafficSection';
import type { TrafficFlow, TrafficSources, TrafficUsersPage } from '@/lib/api/traffic';
import { costPerSignup, deviceLabel, flowItemText, fmtUsd, nextSort, pageCount, pct, rangeForDays } from '@/lib/traffic-format';

const readSrc = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const SOURCES: TrafficSources = {
  from: '2026-09-08T00:00:00.000Z',
  to: '2026-10-08T00:00:00.000Z',
  captureEnabled: true,
  totals: { visitors: 15, guestChatters: 5, signups: 5, activated: 4, d7Eligible: 3, retainedD7: 1, costUsd: 1.61 },
  channels: [
    { channel: 'google_ads', label: 'Google Ads', paid: true, visitors: 10, guestChatters: 4, signups: 3, activated: 2, d7Eligible: 1, retainedD7: 1, costUsd: 1.5 },
    { channel: 'facebook_ads', label: 'Facebook / Instagram Ads', paid: true, visitors: 5, guestChatters: 1, signups: 0, activated: 0, d7Eligible: 0, retainedD7: 0, costUsd: 0 },
    { channel: 'unknown', label: 'Unknown (no visitor record)', paid: false, visitors: 0, guestChatters: 0, signups: 2, activated: 2, d7Eligible: 2, retainedD7: 0, costUsd: 0.11 },
  ],
  campaigns: [{ channel: 'google_ads', label: 'Google Ads', paid: true, campaign: 'fall-launch', visitors: 10, guestChatters: 4, signups: 3, activated: 2, d7Eligible: 1, retainedD7: 1, costUsd: 1.5 }],
  funnel: [{ channel: 'google_ads', label: 'Google Ads', landed: 10, signedUp: 3, firstChat: 2, d7Eligible: 1, d7Active: 1, guestChatted: 4 }],
  spendByKind: [{ kind: 'user', usd: 1.25 }, { kind: 'guest', usd: 0.1 }],
  topPaths: [{ path: '/crossmodel', views: 20, visitors: 9 }],
  topLandings: [{ path: '/', visitors: 12 }],
};

const PAGE: TrafficUsersPage = {
  rows: [
    { kind: 'user', id: 'u1', label: 'ads@x.com', channel: 'google_ads', channelLabel: 'Google Ads', campaign: 'fall-launch', signedUpAt: '2026-09-27T12:00:00.000Z', lastActiveAt: '2026-10-07T11:00:00.000Z', chats7: 1, chats30: 2, msgs7: 3, msgs30: 9, cost1: 0.25, cost7: 0.25, cost30: 1.75, costAll: 4.75, ipHash: 'b27b03c1', device: 'chrome/macos/desktop' },
    { kind: 'visitor', id: 'v1', label: 'visitor b82097b6', channel: 'facebook_ads', channelLabel: 'Facebook / Instagram Ads', campaign: null, signedUpAt: null, lastActiveAt: null, chats7: 1, chats30: 1, msgs7: 2, msgs30: 2, cost1: 0, cost7: 0.1, cost30: 0.1, costAll: 0.1, ipHash: 'b82097b6', device: 'safari/ios/mobile' },
  ],
  total: 51, page: 2, pageSize: 25, sort: 'costAll', dir: 'desc',
};

const FLOW: TrafficFlow = {
  subject: { kind: 'user', id: 'u1', label: 'ads@x.com', signedUpAt: '2026-09-27T12:00:00.000Z' },
  attribution: { channel: 'google_ads', channelLabel: 'Google Ads', campaign: 'fall-launch', firstTouch: { utm_source: 'google', gclid: true } },
  visitors: [{ id: 'v-1', ipHash: 'b27b03c1', device: 'chrome/macos/desktop', channel: 'google_ads', channelLabel: 'Google Ads', campaign: 'fall-launch', firstSeen: '2026-09-27T11:31:00.000Z', lastSeen: '2026-10-07T11:00:00.000Z', firstTouch: null, lastTouch: null, isBot: false }],
  cost: { cost1: 0.25, cost7: 0.25, cost30: 1.75, costAll: 4.75 },
  items: [
    { at: '2026-09-27T11:31:00.000Z', kind: 'landing', type: 'landing', path: '/', source: 'client', detail: { channelLabel: 'Google Ads', utm_source: 'google', utm_medium: 'cpc', utm_campaign: 'fall-launch', gclid: true } },
    { at: '2026-09-27T11:45:00.000Z', kind: 'event', type: 'signup_view', path: '/login', source: 'client' },
    { at: '2026-09-27T12:00:00.000Z', kind: 'signup', type: 'account_created', source: 'db' },
    { at: '2026-09-28T12:00:00.000Z', kind: 'first_chat', type: 'first_message', source: 'db' },
    { at: '2026-10-06T00:00:00.000Z', kind: 'chat_day', type: 'chat_activity', source: 'db', detail: { messages: 3, chats: 1 } },
    { at: '2026-10-06T09:00:00.000Z', kind: 'coding_session', type: 'coding_session_started', source: 'db' },
  ],
  truncated: false,
};

describe('traffic formatters', () => {
  it('money, percents, cost per signup', () => {
    expect(fmtUsd(0)).toBe('—');
    expect(fmtUsd(4.75)).toBe('$4.75');
    expect(fmtUsd(0.25)).toBe('$0.250');
    expect(fmtUsd(0.0012)).toBe('$0.0012');
    expect(pct(1, 3)).toBe('33%');
    expect(pct(1, 0)).toBe('—');
    expect(costPerSignup(1.5, 3)).toBe('$0.500');
    expect(costPerSignup(1.5, 0)).toBe('—');
  });
  it('device + timeline text in plain language (click ids as presence only)', () => {
    expect(deviceLabel('safari/ios/mobile')).toBe('Safari · iOS · mobile');
    expect(deviceLabel(null)).toBe('—');
    expect(flowItemText(FLOW.items[0])).toBe('Landed — Google Ads · google / cpc · campaign "fall-launch" · (gclid)');
    expect(flowItemText(FLOW.items[1])).toBe('Saw the sign-up form');
    expect(flowItemText(FLOW.items[4])).toBe('Chat activity — 3 messages in 1 chat');
    expect(flowItemText({ at: '', kind: 'event', type: 'brand_new' })).toBe('brand new');
  });
  it('sort toggling, ranges, page counts', () => {
    expect(nextSort('costAll', 'desc', 'costAll')).toEqual({ sort: 'costAll', dir: 'asc' });
    expect(nextSort('costAll', 'desc', 'label')).toEqual({ sort: 'label', dir: 'asc' });
    expect(nextSort('label', 'asc', 'cost7')).toEqual({ sort: 'cost7', dir: 'desc' });
    expect(rangeForDays(30, new Date('2026-10-07T12:00:00Z'))).toEqual({ from: '2026-09-08', to: '2026-10-07' });
    expect(pageCount(51, 25)).toBe(3);
    expect(pageCount(0, 25)).toBe(1);
  });
});

describe('SourcesView', () => {
  const html = renderToStaticMarkup(createElement(SourcesView, { data: SOURCES }));
  it('Google Ads and Facebook Ads are separate rows under "Paid ads", other channels below', () => {
    expect(html).toContain('data-testid="channel-row-google_ads"');
    expect(html).toContain('data-testid="channel-row-facebook_ads"');
    expect(html.indexOf('Paid ads')).toBeLessThan(html.indexOf('channel-row-google_ads'));
    expect(html.indexOf('channel-row-facebook_ads')).toBeLessThan(html.indexOf('Organic, referral &amp; other'));
    expect(html.indexOf('Organic, referral &amp; other')).toBeLessThan(html.indexOf('channel-row-unknown'));
  });
  it('renders visitors / signups / activated / retained D7 / API cost / cost per signup, campaigns, funnel, paths', () => {
    expect(html).toContain('Retained D7');
    expect(html).toContain('$1.50');
    expect(html).toContain('$0.500'); // 1.5 / 3 signups
    expect(html).toContain('fall-launch');
    expect(html).toContain('data-testid="traffic-funnel"');
    expect(html).toContain('4 chatted as a guest');
    expect(html).toContain('/crossmodel');
    expect(html).toContain('Guests (no visitor id)');
    expect(html).not.toContain('data-testid="capture-off"');
  });
  it('says so when the server capture is switched off', () => {
    expect(renderToStaticMarkup(createElement(SourcesView, { data: { ...SOURCES, captureEnabled: false } }))).toContain('data-testid="capture-off"');
  });
});

describe('UsersTable', () => {
  const html = renderToStaticMarkup(createElement(UsersTable, { page: PAGE, onSort: () => {}, onOpen: () => {} }));
  it('one table for signed-in users (email) and anonymous visitors ("visitor <hash8>"), with the short ip hash + device', () => {
    expect(html).toContain('ads@x.com');
    expect(html).toContain('visitor b82097b6');
    expect(html).toContain('b27b03c1');
    expect(html).toContain('Chrome · macOS · desktop');
    expect(html).toContain('Safari · iOS · mobile');
    expect(html).toContain('$4.75');
    expect(html).toContain('2 / 9'); // chats30 / msgs30
  });
  it('every sortable column is a button; the active sort shows its arrow', () => {
    for (const k of ['label', 'channel', 'signedUp', 'lastActive', 'msgs7', 'msgs30', 'cost7', 'cost30', 'costAll']) expect(html).toContain(`data-testid="sort-${k}"`);
  });
  it('never renders a raw IP', () => {
    expect(html).not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
  });
});

describe('FlowView', () => {
  const html = renderToStaticMarkup(createElement(FlowView, { flow: FLOW }));
  it('a timeline from the landing (with its source) through signup, first chat, chats and coding', () => {
    expect(html).toContain('ads@x.com');
    expect(html).toContain('Google Ads · fall-launch');
    const order = ['Landed — Google Ads', 'Saw the sign-up form', 'Account created', 'First chat message', 'Chat activity', 'Started a coding session'].map((t) => html.indexOf(t));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toContain('all $4.75');
  });
});

describe('mount + API pins', () => {
  it('Account → Admin has a "Users & traffic" section rendering TrafficSection', () => {
    const admin = readSrc('./AdminTab.tsx');
    expect(admin).toContain("{ id: 'traffic', label: 'Users & traffic', icon: Globe }");
    expect(admin).toContain("{section === 'traffic' && <TrafficSection />}");
  });
  it('the API client calls the admin endpoints with server-side params', () => {
    const api = readSrc('../../../lib/api/traffic.ts');
    expect(api).toContain("apiClient.get('/crossmodel/admin/traffic/sources', { params: { from, to } })");
    expect(api).toContain("apiClient.get('/crossmodel/admin/traffic/users', { params: query })");
    expect(api).toContain("apiClient.get('/crossmodel/admin/traffic/flow', { params: subject })");
  });
});
