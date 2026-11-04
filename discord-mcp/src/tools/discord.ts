/**
 * Discord REST (v10) tool implementations for the discord-mcp service.
 *
 * Auth model (ticket c0e2769b): Discord bots use a single BOT token
 * (DISCORD_BOT_TOKEN) — unlike Slack's per-user OAuth token. All reads are
 * bot-scoped: the bot must be a member of the guild and can only see DM
 * channels a user has opened with the bot.
 *
 * Every tool returns a markdown string (mirroring slack-mcp) and NEVER
 * throws: failures render as `Error <fn>: <reason>` text so the agent keeps
 * the reason in-band. 429 rate limits are retried once honoring retry_after.
 *
 * Tests inject a fake `http` client (any object with `.request()`), so this
 * module needs zero network and zero module mocks.
 */

import axios, { AxiosInstance } from 'axios';

const API_BASE = 'https://discord.com/api/v10';
const MAX_PAGE = 100; // Discord hard per-page cap for message reads
const MAX_LIST = 200; // cap for single-shot list tools
const MAX_SCRAPE = 2000; // hard safety cap for the full-history scrape tool
const RETRY_CAP_MS = 10_000;

// ── shapes (subset of Discord REST v10 payloads we render) ───────────────────

interface DiscordUser {
  id: string;
  username: string;
  global_name?: string | null;
  bot?: boolean;
}

interface DiscordMessage {
  id: string;
  channel_id?: string;
  author?: DiscordUser;
  content?: string;
  timestamp?: string;
  edited_timestamp?: string | null;
  attachments?: { filename: string; url: string }[];
  message_reference?: { message_id?: string };
}

interface DiscordChannel {
  id: string;
  type: number;
  name?: string;
  topic?: string;
  nsfw?: boolean;
  position?: number;
  parent_id?: string | null;
  recipients?: DiscordUser[];
  last_message_id?: string;
}

interface DiscordGuild {
  id: string;
  name: string;
  owner_id?: string;
  approximate_member_count?: number;
}

// ── http core (exported for tests) ───────────────────────────────────────────

export function makeHttp(token: string): AxiosInstance {
  return axios.create({
    baseURL: API_BASE,
    timeout: 20_000,
    headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
  });
}

function errText(err: any): string {
  const status = err?.response?.status;
  if (status) {
    const data = err?.response?.data;
    const msg =
      typeof data?.message === 'string'
        ? data.message
        : typeof data === 'string'
          ? data.slice(0, 200)
          : '';
    return msg ? `${status} ${msg}` : String(status);
  }
  return err?.code || err?.message || 'network error';
}

/**
 * One REST call with a single 429 retry honoring retry_after (seconds, float).
 * Other failures throw an Error whose message is the classified text
 * (`401 Unauthorized`, `ECONNREFUSED`, …) and whose `.status` carries the
 * HTTP status when present.
 */
export async function discordRequest<T>(
  http: AxiosInstance,
  method: 'get' | 'post',
  url: string,
  data?: unknown,
): Promise<T> {
  const call = () => http.request<T>({ method, url, ...(data !== undefined ? { data } : {}) });
  try {
    const res = await call();
    return res.data;
  } catch (err: any) {
    if (err?.response?.status === 429) {
      const body = err.response.data;
      const ra =
        typeof body?.retry_after === 'number'
          ? body.retry_after
          : parseFloat(String(err.response.headers?.['retry-after'] ?? '1'));
      const waitMs = Math.min((Number.isFinite(ra) ? Math.max(ra, 0) : 1) * 1000, RETRY_CAP_MS);
      await new Promise((r) => setTimeout(r, waitMs));
      const retry = await call();
      return retry.data;
    }
    const e = new Error(errText(err));
    (e as any).status = err?.response?.status;
    throw e;
  }
}

// ── formatters ──────────────────────────────────────────────────────────────

const CHANNEL_TYPES: Record<number, string> = {
  0: 'text',
  1: 'dm',
  2: 'voice',
  3: 'group-dm',
  4: 'category',
  5: 'announcement',
  13: 'stage',
  15: 'forum',
  16: 'media',
};

function truncate(text: string, max: number = 300): string {
  if (!text) return '';
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

function isoToDate(iso?: string): string {
  if (!iso) return 'N/A';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().replace('T', ' ').split('.')[0] + ' UTC';
}

/** Snowflake IDs encode their creation time ((id >> 22) + Discord epoch). */
function snowflakeToDate(id?: string): string {
  if (!id || !/^\d+$/.test(id)) return 'N/A';
  try {
    const ms = Number((BigInt(id) >> 22n) + 1420070400000n);
    return new Date(ms).toISOString().replace('T', ' ').split('.')[0] + ' UTC';
  } catch {
    return 'N/A';
  }
}

function authorLabel(author?: DiscordUser): string {
  if (!author) return '(webhook/system)';
  const name = author.global_name || author.username || 'unknown';
  return author.bot ? `${name} [bot]` : `@${name}`;
}

function renderError(fn: string, err: any): string {
  console.error(`[discord/${fn}]`, err?.message || err);
  const hint =
    err?.status === 401
      ? ' — invalid bot token, or the bot lacks access to this guild/channel/DM'
      : err?.status === 403
        ? ' — the bot lacks permission for this action (check channel permissions / MESSAGE CONTENT intent)'
        : '';
  return `Error ${fn}: ${err?.message || String(err)}${hint}`;
}

// ── tools ────────────────────────────────────────────────────────────────────

/** List guilds (servers) the bot is a member of. */
export async function discordListGuilds(
  token: string,
  limit: number = 50,
  http: AxiosInstance = makeHttp(token),
): Promise<string> {
  const fn = 'discordListGuilds';
  try {
    const guilds = await discordRequest<DiscordGuild[]>(
      http,
      'get',
      `/users/@me/guilds?limit=${Math.min(Math.max(limit, 1), MAX_LIST)}`,
    );
    if (!Array.isArray(guilds) || guilds.length === 0) {
      return 'No guilds found (the bot has not been added to any server).';
    }
    const lines = ['# Guilds\n'];
    for (const g of guilds) {
      lines.push(
        `## ${g.name || '(unnamed guild)'}`,
        `  ID: ${g.id}`,
      );
      if (g.approximate_member_count != null) lines.push(`  Members: ~${g.approximate_member_count}`);
      lines.push('');
    }
    lines.push(`Total: ${guilds.length} guild(s)`);
    return lines.join('\n');
  } catch (err: any) {
    return renderError(fn, err);
  }
}

/** List channels in a guild (text/voice/categories/forums, with type labels). */
export async function discordListChannels(
  token: string,
  guildId: string,
  http: AxiosInstance = makeHttp(token),
): Promise<string> {
  const fn = 'discordListChannels';
  try {
    const channels = await discordRequest<DiscordChannel[]>(http, 'get', `/guilds/${guildId}/channels`);
    if (!Array.isArray(channels) || channels.length === 0) {
      return `No channels found in guild ${guildId}.`;
    }
    const sorted = [...channels].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    const lines = [`# Channels in guild ${guildId}\n`];
    for (const ch of sorted) {
      const type = CHANNEL_TYPES[ch.type] ?? `type-${ch.type}`;
      const label = ch.name ? `#${ch.name}` : '(unnamed)';
      lines.push(
        `## ${label} (${type})`,
        `  ID: ${ch.id}`,
      );
      if (ch.topic) lines.push(`  Topic: ${truncate(ch.topic, 200)}`);
      if (ch.nsfw) lines.push(`  NSFW: yes`);
      if (ch.last_message_id) lines.push(`  Last message: ${snowflakeToDate(ch.last_message_id)}`);
      lines.push('');
    }
    lines.push(`Total: ${sorted.length} channel(s)`);
    return lines.join('\n');
  } catch (err: any) {
    return renderError(fn, err);
  }
}

/** Recent messages in a channel (newest first, like Slack history). */
export async function discordChannelHistory(
  token: string,
  channelId: string,
  limit: number = 20,
  before?: string,
  http: AxiosInstance = makeHttp(token),
): Promise<string> {
  const fn = 'discordChannelHistory';
  try {
    const qs = `limit=${Math.min(Math.max(limit, 1), MAX_PAGE)}${before ? `&before=${before}` : ''}`;
    const messages = await discordRequest<DiscordMessage[]>(
      http,
      'get',
      `/channels/${channelId}/messages?${qs}`,
    );
    if (!Array.isArray(messages) || messages.length === 0) {
      return `No messages found in channel ${channelId}${before ? ` before ${before}` : ''}.`;
    }
    const lines = [`# History: channel ${channelId} (newest first)\n`];
    for (const msg of messages) {
      lines.push(
        `## ${authorLabel(msg.author)} — ${isoToDate(msg.timestamp)}`,
        `  ${truncate(msg.content || '(no text — embed/attachment only)', 500)}`,
      );
      if (msg.message_reference?.message_id) lines.push(`  ↩ reply to message ${msg.message_reference.message_id}`);
      const files = (msg.attachments ?? []).map((a) => a.filename).filter(Boolean);
      if (files.length > 0) lines.push(`  📎 attachments: ${files.join(', ')}`);
      if (msg.edited_timestamp) lines.push(`  (edited ${isoToDate(msg.edited_timestamp)})`);
      lines.push('');
    }
    const oldest = messages[messages.length - 1];
    lines.push(
      `Showing ${messages.length} message(s)`,
      `Continue older history with before=${oldest.id}`,
    );
    return lines.join('\n');
  } catch (err: any) {
    return renderError(fn, err);
  }
}

/** Post a message to a channel as the bot. */
export async function discordSendMessage(
  token: string,
  channelId: string,
  content: string,
  replyTo?: string,
  http: AxiosInstance = makeHttp(token),
): Promise<string> {
  const fn = 'discordSendMessage';
  try {
    const msg = await discordRequest<DiscordMessage>(http, 'post', `/channels/${channelId}/messages`, {
      content,
      ...(replyTo ? { message_reference: { message_id: replyTo } } : {}),
    });
    return `Sent to channel ${channelId} — message id ${msg?.id ?? 'unknown'}`;
  } catch (err: any) {
    return renderError(fn, err);
  }
}

/** List DM channels open with the bot (users must DM the bot first). */
export async function discordListDms(
  token: string,
  http: AxiosInstance = makeHttp(token),
): Promise<string> {
  const fn = 'discordListDms';
  try {
    const dms = await discordRequest<DiscordChannel[]>(http, 'get', '/users/@me/channels');
    const privateOnly = (Array.isArray(dms) ? dms : []).filter((c) => c.type === 1 || c.type === 3);
    if (privateOnly.length === 0) {
      return 'No DM channels open with this bot (a user must DM the bot first to open one).';
    }
    const lines = ['# DM Channels\n'];
    for (const ch of privateOnly) {
      const names = (ch.recipients ?? [])
        .map((r) => `@${r.global_name || r.username || r.id}`)
        .join(', ');
      lines.push(
        `## ${names || '(unknown recipients)'} (${ch.type === 3 ? 'group DM' : 'DM'})`,
        `  ID: ${ch.id}`,
        `  Last message: ${snowflakeToDate(ch.last_message_id)}`,
        '',
      );
    }
    lines.push(`Total: ${privateOnly.length} DM channel(s) — read with discord_channel_history`);
    return lines.join('\n');
  } catch (err: any) {
    return renderError(fn, err);
  }
}

/** DM a user by ID (creates/reuses the DM channel, then posts). */
export async function discordSendDm(
  token: string,
  userId: string,
  content: string,
  http: AxiosInstance = makeHttp(token),
): Promise<string> {
  const fn = 'discordSendDm';
  try {
    const ch = await discordRequest<DiscordChannel>(http, 'post', '/users/@me/channels', {
      recipient_id: userId,
    });
    if (!ch?.id) throw new Error('Discord returned no DM channel id');
    const recipient = (ch.recipients ?? []).find((r) => r.id === userId);
    const who = recipient ? `@${recipient.global_name || recipient.username}` : `user ${userId}`;
    const msg = await discordRequest<DiscordMessage>(http, 'post', `/channels/${ch.id}/messages`, {
      content,
    });
    return `DM sent to ${who} — message id ${msg?.id ?? 'unknown'}`;
  } catch (err: any) {
    return renderError(fn, err);
  }
}

/**
 * Full channel-history scrape: paginates the before-cursor until history is
 * exhausted or the cap is hit, rendering a oldest-first transcript.
 */
export async function discordScrapeChannel(
  token: string,
  channelId: string,
  maxMessages: number = 500,
  before?: string,
  http: AxiosInstance = makeHttp(token),
): Promise<string> {
  const fn = 'discordScrapeChannel';
  const cap = Math.min(Math.max(Math.floor(maxMessages), 1), MAX_SCRAPE);
  try {
    const all: DiscordMessage[] = [];
    let cursor = before;
    let exhausted = false;
    while (all.length < cap) {
      const want = Math.min(MAX_PAGE, cap - all.length);
      const qs = `limit=${want}${cursor ? `&before=${cursor}` : ''}`;
      const page = await discordRequest<DiscordMessage[]>(
        http,
        'get',
        `/channels/${channelId}/messages?${qs}`,
      );
      if (!Array.isArray(page) || page.length === 0) {
        exhausted = true;
        break;
      }
      all.push(...page);
      cursor = page[page.length - 1].id; // oldest id in the page = next cursor
      if (page.length < want) exhausted = true;
    }
    if (all.length === 0) {
      return `No messages found in channel ${channelId}${before ? ` before ${before}` : ''}.`;
    }
    const lines = [
      `# Full history: channel ${channelId} (oldest → newest)`,
      `Scraped ${all.length} message(s)${exhausted ? ' — channel history exhausted' : ` — reached the ${cap}-message cap`}`,
      '',
    ];
    for (const msg of [...all].reverse()) {
      lines.push(
        `## ${authorLabel(msg.author)} — ${isoToDate(msg.timestamp)}`,
        `  ${truncate(msg.content || '(no text — embed/attachment only)', 800)}`,
      );
      const files = (msg.attachments ?? []).map((a) => a.filename).filter(Boolean);
      if (files.length > 0) lines.push(`  📎 attachments: ${files.join(', ')}`);
      lines.push('');
    }
    if (!exhausted) {
      lines.push(`Reached the ${cap}-message cap — oldest message id ${cursor}: call again with before=${cursor} to continue scraping.`);
    }
    return lines.join('\n');
  } catch (err: any) {
    return renderError(fn, err);
  }
}

/** Bot identity (mirror of slack_get_auth). */
export async function discordGetBotInfo(
  token: string,
  http: AxiosInstance = makeHttp(token),
): Promise<string> {
  const fn = 'discordGetBotInfo';
  try {
    const me = await discordRequest<DiscordUser>(http, 'get', '/users/@me');
    const lines = [
      '# Discord Bot Identity',
      '',
      `**Username:** ${me.username || 'N/A'}`,
      `**Display name:** ${me.global_name || 'N/A'}`,
      `**Bot user ID:** ${me.id || 'N/A'}`,
    ];
    return lines.join('\n').trim();
  } catch (err: any) {
    return renderError(fn, err);
  }
}
