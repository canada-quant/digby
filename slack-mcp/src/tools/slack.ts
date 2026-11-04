import { WebClient } from '@slack/web-api';

const MAX_LIST = 100;

function truncate(text: string, max: number = 300): string {
  if (!text) return '';
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

function tsToDate(ts?: string): string {
  if (!ts) return 'N/A';
  const seconds = parseFloat(ts);
  if (Number.isNaN(seconds)) return ts;
  return new Date(seconds * 1000).toISOString().replace('T', ' ').split('.')[0] + ' UTC';
}

/** Post a message AS THE USER (user-token scope chat:write) — the write twin of the reads above. */
export async function slackPostMessage(token: string, channel: string, text: string, threadTs?: string): Promise<string> {
  try {
    const client = new WebClient(token);
    const result = await client.chat.postMessage({ channel, text, ...(threadTs ? { thread_ts: threadTs } : {}) });
    return `Posted to ${result.channel ?? channel} — ts ${result.ts ?? 'unknown'}`;
  } catch (err: any) {
    console.error('[slackPostMessage]', err.message);
    const missing = /missing_scope|not_allowed_token_type|invalid_auth/i.test(String(err?.data?.error || err.message));
    return `Error slackPostMessage: ${err?.data?.error || err.message}${missing ? ' — reconnect Slack in Account → Integrations to grant posting (chat:write)' : ''}`;
  }
}

export async function slackListChannels(
  token: string,
  limit: number = 50,
  types?: string,
): Promise<string> {
  try {
    const client = new WebClient(token);
    const result = await client.conversations.list({
      limit: Math.min(limit, MAX_LIST),
      types: types || 'public_channel,private_channel',
      exclude_archived: true,
    });

    const channels = result.channels || [];
    if (channels.length === 0) {
      return 'No channels found.';
    }

    const lines = ['# Channels\n'];
    for (const ch of channels) {
      // Ticket 24541fb3: label conversation KIND, not just visibility — im/mpim
      // now appear in the listing and the agent needs to tell them apart.
      const kind = ch.is_mpim ? '👥 group DM'
        : ch.is_im ? '💬 DM'
        : ch.is_private ? '🔒 private' : '#️⃣ public';
      lines.push(
        `## ${ch.name || ch.id} ${kind}`,
        `  ID: ${ch.id}`,
        `  Members: 👥 ${ch.num_members ?? 'N/A'}`,
      );
      const topic = ch.topic?.value;
      const purpose = ch.purpose?.value;
      if (topic) lines.push(`  Topic: ${truncate(topic, 200)}`);
      if (purpose) lines.push(`  Purpose: ${truncate(purpose, 200)}`);
      lines.push('');
    }
    lines.push(`\nTotal: ${channels.length} channel(s)`);
    return lines.join('\n');
  } catch (err: any) {
    console.error('[slackListChannels]', err.message);
    return `Error slackListChannels: ${err.message}`;
  }
}

export async function slackChannelHistory(
  token: string,
  channel: string,
  limit: number = 20,
): Promise<string> {
  try {
    const client = new WebClient(token);

    let channelId = channel;
    let channelLabel = channel;
    if (channel.startsWith('#')) {
      const name = channel.slice(1);
      const list = await client.conversations.list({
        limit: MAX_LIST,
        // Ticket 24541fb3: resolve names across ALL conversation types — im/mpim
        // have real names the listing prints (mpdm-…/DM names), and a #name the
        // listing itself showed must resolve when handed back as a history query.
        types: 'public_channel,private_channel,im,mpim',
        exclude_archived: true,
      });
      const match = (list.channels || []).find((c) => c.name === name);
      if (!match || !match.id) {
        return `Error slackChannelHistory: channel "${channel}" not found.`;
      }
      channelId = match.id;
      channelLabel = `#${match.name}`;
    }

    const result = await client.conversations.history({
      channel: channelId,
      limit: Math.min(limit, MAX_LIST),
    });

    const messages = result.messages || [];
    if (messages.length === 0) {
      return `No messages found in ${channelLabel}.`;
    }

    const lines = [`# History: ${channelLabel} (${channelId})\n`];
    for (const msg of messages) {
      const author = msg.user ? `<@${msg.user}>` : msg.bot_id ? `bot:${msg.bot_id}` : '(unknown)';
      lines.push(
        `## ${author} — ${tsToDate(msg.ts)}`,
        `  ${truncate(msg.text || '(no text)', 500)}`,
        '',
      );
    }
    lines.push(`\nShowing ${messages.length} message(s)`);
    return lines.join('\n');
  } catch (err: any) {
    console.error('[slackChannelHistory]', err.message);
    return `Error slackChannelHistory: ${err.message}`;
  }
}

export async function slackSearchMessages(
  token: string,
  query: string,
  count: number = 20,
): Promise<string> {
  try {
    const client = new WebClient(token);
    const result = await client.search.messages({
      query,
      count: Math.min(count, MAX_LIST),
    });

    const matches = result.messages?.matches || [];
    if (matches.length === 0) {
      return `No messages found matching: "${query}"`;
    }

    const total = result.messages?.total ?? matches.length;
    const lines = [`# Search Results for "${query}"\n`, `Total matches: ${total.toLocaleString()}\n`];
    for (const m of matches) {
      const channelName = m.channel?.name ? `#${m.channel.name}` : m.channel?.id || '(unknown channel)';
      const author = m.username ? `@${m.username}` : m.user ? `<@${m.user}>` : '(unknown)';
      lines.push(
        `## ${channelName} — ${author}`,
        `  ${truncate(m.text || '(no text)', 400)}`,
      );
      if (m.permalink) lines.push(`  ${m.permalink}`);
      lines.push('');
    }
    lines.push(`\nShowing ${matches.length} of ${total.toLocaleString()} total matches`);
    return lines.join('\n');
  } catch (err: any) {
    console.error('[slackSearchMessages]', err.message);
    return `Error slackSearchMessages: ${err.message}`;
  }
}

export async function slackListUsers(
  token: string,
  limit: number = 50,
): Promise<string> {
  try {
    const client = new WebClient(token);
    const result = await client.users.list({
      limit: Math.min(limit, MAX_LIST),
    });

    const members = (result.members || []).filter((u) => !u.is_bot && !u.deleted && u.id !== 'USLACKBOT');
    if (members.length === 0) {
      return 'No users found.';
    }

    const lines = ['# Workspace Members\n'];
    for (const u of members) {
      const realName = u.real_name || u.profile?.real_name || '(no name)';
      lines.push(
        `## ${realName} (@${u.name})`,
        `  ID: ${u.id}`,
      );
      const title = u.profile?.title;
      if (title) lines.push(`  Title: ${title}`);
      lines.push('');
    }
    lines.push(`\nTotal: ${members.length} member(s)`);
    return lines.join('\n');
  } catch (err: any) {
    console.error('[slackListUsers]', err.message);
    return `Error slackListUsers: ${err.message}`;
  }
}

export async function slackGetAuth(token: string): Promise<string> {
  try {
    const client = new WebClient(token);
    const result = await client.auth.test();

    const lines = [
      '# Slack Auth Identity',
      '',
      `**Team:** ${result.team || 'N/A'}`,
      `**User:** ${result.user || 'N/A'}`,
      `**URL:** ${result.url || 'N/A'}`,
      `**User ID:** ${result.user_id || 'N/A'}`,
      `**Team ID:** ${result.team_id || 'N/A'}`,
    ];
    return lines.join('\n').trim();
  } catch (err: any) {
    console.error('[slackGetAuth]', err.message);
    return `Error slackGetAuth: ${err.message}`;
  }
}
