/**
 * Account → Admin → Users & traffic — pure formatting helpers (owner 2026-10-07). Kept out of the component so the
 * vitest suite can pin them without rendering.
 */
import type { TrafficFlowItem, TrafficUserSort } from './api/traffic';

/** API cost: cents for ≥ $1, sub-cent precision below it, '—' for zero. */
export function fmtUsd(n: number | null | undefined): string {
  const v = Number(n) || 0;
  if (v === 0) return '—';
  if (Math.abs(v) >= 1) return `$${v.toFixed(2)}`;
  if (Math.abs(v) >= 0.01) return `$${v.toFixed(3)}`;
  return `$${v.toFixed(4)}`;
}

/** n / d as a whole percent, '—' when d is 0. */
export function pct(n: number, d: number): string {
  if (!d) return '—';
  return `${Math.round((n / d) * 100)}%`;
}

/** Cost per signup for a channel row, '—' without signups. */
export function costPerSignup(costUsd: number, signups: number): string {
  return signups > 0 ? fmtUsd(costUsd / signups) : '—';
}

const BROWSERS: Record<string, string> = { chrome: 'Chrome', safari: 'Safari', firefox: 'Firefox', edge: 'Edge', opera: 'Opera', samsung: 'Samsung Internet', other: 'Other browser' };
const OSES: Record<string, string> = { ios: 'iOS', android: 'Android', windows: 'Windows', macos: 'macOS', chromeos: 'ChromeOS', linux: 'Linux', other: 'Other OS' };

/** "chrome/macos/desktop" → "Chrome · macOS · desktop"; '—' when unknown. */
export function deviceLabel(family: string | null | undefined): string {
  if (!family) return '—';
  const [b, o, d] = family.split('/');
  return [BROWSERS[b] ?? b, OSES[o] ?? o, d].filter(Boolean).join(' · ');
}

const EVENT_TEXT: Record<string, string> = {
  page_view: 'Viewed a page',
  signup_view: 'Saw the sign-up form',
  login_view: 'Saw the sign-in form',
  signup_cta: 'Clicked a sign-up prompt',
  signup_complete: 'Signed up',
  login: 'Signed in',
  first_chat: 'First chat message',
  chat_sent: 'Sent a chat message',
  dig_deeper: 'Tapped Dig deeper',
  coding_session_started: 'Started a coding session',
};

/** One timeline line, plain language. */
export function flowItemText(item: TrafficFlowItem): string {
  const d = (item.detail ?? {}) as Record<string, unknown>;
  switch (item.kind) {
    case 'landing': {
      const bits = [d.channelLabel ? String(d.channelLabel) : 'Landed'];
      const src = [d.utm_source, d.utm_medium].filter(Boolean).join(' / ');
      if (src) bits.push(src);
      if (d.utm_campaign) bits.push(`campaign "${String(d.utm_campaign)}"`);
      if (d.referrer) bits.push(`from ${String(d.referrer)}`);
      const clicks = ['gclid', 'gbraid', 'wbraid', 'fbclid', 'msclkid', 'ttclid', 'li_fat_id'].filter((k) => d[k]);
      if (clicks.length) bits.push(`(${clicks.join(', ')})`);
      return `Landed — ${bits.join(' · ')}`;
    }
    case 'signup': return 'Account created';
    case 'first_chat': return 'First chat message';
    case 'chat_day': return `Chat activity — ${Number(d.messages) || 0} message${Number(d.messages) === 1 ? '' : 's'} in ${Number(d.chats) || 0} chat${Number(d.chats) === 1 ? '' : 's'}`;
    case 'coding_session': return 'Started a coding session';
    default: return EVENT_TEXT[item.type] ?? item.type.replace(/_/g, ' ');
  }
}

/** Clicking a header: the same column flips direction; a new column starts descending (text columns ascending). */
export function nextSort(current: TrafficUserSort, dir: 'asc' | 'desc', clicked: TrafficUserSort): { sort: TrafficUserSort; dir: 'asc' | 'desc' } {
  if (current === clicked) return { sort: clicked, dir: dir === 'asc' ? 'desc' : 'asc' };
  return { sort: clicked, dir: clicked === 'label' || clicked === 'channel' ? 'asc' : 'desc' };
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** The [from, to] (inclusive YYYY-MM-DD) of the last `days` days ending today (UTC). */
export function rangeForDays(days: number, now: Date = new Date()): { from: string; to: string } {
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const from = new Date(to.getTime() - (Math.max(1, days) - 1) * 86_400_000);
  return { from: ymd(from), to: ymd(to) };
}

/** Total pages for a paginated table (≥ 1). */
export function pageCount(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil((Number(total) || 0) / Math.max(1, pageSize)));
}

/** Labels for the spend buckets that are not a user or a visitor. */
export const SPEND_KIND_LABELS: Record<string, string> = {
  user: 'Signed-in users',
  visitor: 'Guests (attributed to a visitor)',
  guest: 'Guests (no visitor id)',
  chatless: 'Signed-in, no chat (e.g. Telegram)',
  decision_gate: 'Decision gate (no chat)',
  other: 'Other (deleted chats, kids, unattributed)',
};
