/**
 * Detect X (Twitter) intent in a user message. Cheap regex matching — no LLM.
 *
 * Returns flags + extracted context (a referenced handle / tweet URL / search
 * topic) so the controller knows which read tool to call when pre-fetching
 * data for the AI's system prompt.
 *
 * For write intents we ONLY flag them — we never auto-post on the user's
 * behalf. The AI will use the x_post_tweet tool explicitly when asked.
 */

export interface XIntent {
  // read-side flags (we may auto-fetch data to inject into the prompt)
  profile: boolean;
  tweet: boolean;
  search: boolean;
  trends: boolean;
  // write-side flags (signal only — never auto-executed)
  post: boolean;
  reply: boolean;
  like: boolean;
  retweet: boolean;
  follow: boolean;
}

export interface XContext {
  handle?: string;        // @jack
  tweetUrl?: string;      // https://x.com/jack/status/12345
  searchQuery?: string;   // captured after "search x for ..."
}

const HANDLE_RE   = /(?:^|\s)@([A-Za-z0-9_]{1,15})\b/;
const TWEET_URL_RE = /\bhttps?:\/\/(?:x|twitter)\.com\/[A-Za-z0-9_]+\/status\/\d+/i;

const KW = {
  profile:  /\b(x|twitter)\s+(profile|account|page|bio)\b|\bwho\s+is\s+@/i,
  tweet:    /\b(tweet|post|x\s+link|twitter\s+link|status\/\d+)\b/i,
  search:   /\b(search\s+(?:on\s+)?(?:x|twitter)|x\s+search|twitter\s+search|find.*on\s+(?:x|twitter))\b/i,
  trends:   /\b(?:x|twitter)\s+trend(?:s|ing)?\b|\btrending\s+on\s+(?:x|twitter)\b/i,
  post:     /\b(post|tweet|share)\s+(this|on\s+(?:x|twitter)|to\s+(?:x|twitter))\b|\bsend\s+(?:a\s+)?tweet\b/i,
  reply:    /\b(reply|respond)\s+(to\s+(?:this|that)?\s+(?:tweet|post|@)|on\s+(?:x|twitter))\b/i,
  like:     /\blike\s+(this|that)?\s*tweet\b|\blike\s+(?:@|https?:)/i,
  retweet:  /\b(?:re\-?tweet|rt|share)\s+(?:this|that)?\s*(?:tweet|post|@|https?:)/i,
  follow:   /\b(?:follow|subscribe\s+to)\s+@/i,
};

export function detectXIntent(message: string): XIntent {
  return {
    profile: KW.profile.test(message),
    tweet:   KW.tweet.test(message)   || TWEET_URL_RE.test(message),
    search:  KW.search.test(message),
    trends:  KW.trends.test(message),
    post:    KW.post.test(message),
    reply:   KW.reply.test(message),
    like:    KW.like.test(message),
    retweet: KW.retweet.test(message),
    follow:  KW.follow.test(message),
  };
}

export function hasAnyXIntent(i: XIntent): boolean {
  return i.profile || i.tweet || i.search || i.trends ||
         i.post || i.reply || i.like || i.retweet || i.follow;
}

export function hasReadIntent(i: XIntent): boolean {
  return i.profile || i.tweet || i.search || i.trends;
}

export function extractXContext(message: string): XContext {
  const ctx: XContext = {};
  const handleMatch = message.match(HANDLE_RE);
  if (handleMatch) ctx.handle = handleMatch[1];
  const tweetMatch = message.match(TWEET_URL_RE);
  if (tweetMatch) ctx.tweetUrl = tweetMatch[0];
  // Naive search-query extraction: text after "search x for" up to next sentence break.
  const searchMatch = message.match(
    /\b(?:search\s+(?:on\s+)?(?:x|twitter)\s+(?:for\s+)?|x\s+search\s+(?:for\s+)?)(["“']?)([^"”'\.\n?!]+)\1/i,
  );
  if (searchMatch) ctx.searchQuery = searchMatch[2].trim();
  return ctx;
}
