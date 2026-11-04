/**
 * iMessage Intent Detector
 *
 * Pure regex matching (no LLM) to decide whether a chat message wants the user's
 * recent iMessages pulled into context. Cheap enough to run on every query.
 */

export interface IMessageIntent {
  read: boolean;   // wants to read/see messages or conversations
  send: boolean;   // wants to send/reply to someone
}

const READ_PATTERNS: RegExp[] = [
  /\bi-?messages?\b/i,
  /\btexts?\b/i,
  /\btext\s+messages?\b/i,
  /\bmessages?\s+from\b/i,
  /\b(recent|latest|unread|new)\s+(texts?|messages?|i-?messages?)\b/i,
  /\bconversations?\b/i,
  /\bwho\s+(texted|messaged)\b/i,
  /\bdid\s+\w+\s+(text|message)\b/i,
  /\bcheck\s+my\s+(texts?|messages?|imessages?)\b/i,
];

const SEND_PATTERNS: RegExp[] = [
  /\b(send|text|message|reply\s+to|imessage)\b.*\b(to|saying|that)\b/i,
  /\bsend\s+(a\s+)?(text|message|imessage)\b/i,
  /\btext\s+\w+\s+(saying|that|about)\b/i,
  /\breply\s+to\b/i,
];

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(text));
}

export function detectIMessageIntent(message: string): IMessageIntent {
  return {
    read: matchesAny(message, READ_PATTERNS),
    send: matchesAny(message, SEND_PATTERNS),
  };
}

export function hasAnyIMessageIntent(intent: IMessageIntent): boolean {
  return intent.read || intent.send;
}
