/**
 * Slack Intent Detector
 *
 * Keyword / pattern matching to detect when the user wants Slack data included
 * in the AI response. No LLM call — pure regex matching is fast and cheap enough
 * for every query.
 *
 * Returns flags for each Slack feature so the controller can selectively fetch context.
 */

export interface SlackIntent {
  channels: boolean;
  messages: boolean;
  search:   boolean;
  users:    boolean;
}

// ── Pattern sets ──────────────────────────────────────────────────────────────

const CHANNELS_PATTERNS: RegExp[] = [
  /\bslack\s+channels?\b/i,
  /\b(my|our|list|which)\s+channels?\b/i,
  /\bchannels?\s+(in|on)\s+slack\b/i,
];

const MESSAGES_PATTERNS: RegExp[] = [
  /\bslack\s+(messages?|chat|thread|conversation)\b/i,
  /\b(messages?|posts?)\s+in\s+#?[\w-]+/i,
  /\brecent\s+(slack\s+)?messages?\b/i,
  /\bcatch\s+up\s+on\b/i,
  /\bwhat('?s| is| was| has been)\s+(being\s+)?(said|posted|discussed|happening)\s+(in|on)\b/i,
];

const SEARCH_PATTERNS: RegExp[] = [
  /\bsearch\s+slack\b/i,
  /\bfind\s+(in\s+)?slack\b/i,
  /\bsearch\s+.*\bin\s+slack\b/i,
  /\bslack\s+search\b/i,
];

const USERS_PATTERNS: RegExp[] = [
  /\bslack\s+(users?|members?|people|team|directory|teammates?)\b/i,
  /\bwho('?s| is)\s+in\s+(the\s+)?(slack\s+)?workspace\b/i,
];

// General "slack" mention — triggers at least a channel listing.
const MENTION_PATTERNS: RegExp[] = [/\bslack\b/i];

// ── Helpers ───────────────────────────────────────────────────────────────────

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some(p => p.test(text));
}

// ── Public API ────────────────────────────────────────────────────────────────

export function detectSlackIntent(message: string): SlackIntent {
  return {
    channels: matchesAny(message, CHANNELS_PATTERNS),
    messages: matchesAny(message, MESSAGES_PATTERNS),
    search:   matchesAny(message, SEARCH_PATTERNS),
    users:    matchesAny(message, USERS_PATTERNS),
  };
}

export function hasAnySlackIntent(intent: SlackIntent): boolean {
  return intent.channels || intent.messages || intent.search || intent.users;
}

export function hasSlackMention(message: string): boolean {
  return matchesAny(message, MENTION_PATTERNS);
}

/**
 * Extract a #channel-name (or a bare channel name after "in"/"channel") from a
 * message, so the controller can pull that channel's recent history. Returns a
 * "#name" string the MCP server resolves to a channel ID, or undefined.
 */
export function extractSlackChannel(message: string): string | undefined {
  const hash = message.match(/#([a-z0-9][\w-]{1,79})/i);
  if (hash) return `#${hash[1]}`;
  const inCh = message.match(/\bin\s+(?:the\s+)?#?([a-z0-9][\w-]{1,79})\s+channel\b/i);
  if (inCh) return `#${inCh[1]}`;
  const chName = message.match(/\bchannel\s+#?([a-z0-9][\w-]{1,79})\b/i);
  if (chName) return `#${chName[1]}`;
  return undefined;
}
