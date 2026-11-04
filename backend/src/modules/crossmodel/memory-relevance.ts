/**
 * Memory Relevance Gate — deterministic, zero-latency filtering of stored user
 * memory before it is injected into model prompts.
 *
 * WHY (2026-07-05 audit): every query received the user's FULL memory (all flat
 * facts + profile summary + focus/topics) in a prominent "USER PROFILE" system
 * block, and the synthesis/follow-up prompts actively encouraged personalization
 * ("connect at least one suggestion to their specific situation"). The result:
 * Digby wove stored personal facts (location, diet, occupation, hobbies…) into
 * answers for completely unrelated questions. Prompt-side rules alone proved
 * insufficient — models use what they see.
 *
 * FIX: don't show models what isn't relevant. This module scores each stored
 * fact against the current user message (+ a little recent user history) with
 * cheap token overlap and only lets matching facts through. A small set of
 * identity/style keys (name, timezone, communication style…) always passes —
 * they shape TONE, not content, and downstream code greps the block for
 * `timezone:`/`name:`. Memory-recall questions ("what do you know about me?")
 * bypass the gate entirely so the user can always inspect their memory.
 *
 * Deliberately deterministic (no LLM call): this runs on the critical path
 * before every query, inside a 5s context-load budget.
 */

/**
 * Fact keys that are ALWAYS injected regardless of topical relevance.
 * These are identity/tone-level facts that personalize HOW Digby speaks, not
 * WHAT it talks about — they can't be "randomly inserted" as off-topic content.
 *
 * NOTE: `timezone` must stay here — query-pipeline.ts and deep-research
 * .pipeline.ts regex the memory block for `timezone:` to build the
 * [CURRENT DATE & TIME] context. `persona`/`tech_level`/`response_style` are
 * grepped by gemini.integration.ts for the synthesis tone block, and `name` by
 * moonshot generateFollowUps.
 */
export const ALWAYS_INJECT_FACT_KEYS = new Set([
  'name',
  'language',
  'timezone',
  'persona',
  'tech_level',
  'response_style',
  'communication_style',
  'communicationstyle',
  // Proactive-offer opt-out (2026-09-08): the keyNorm form of
  // chat-agent/capability-doctrine.ts PROACTIVE_OFFERS_OPTOUT_KEY
  // ('preferences.proactive_offers'). The offers block tells the model to
  // write it when the user says "stop suggesting" and to "honor that fact
  // whenever it is in memory" — a promise the relevance gate would break on
  // every question not semantically about offers (it scored far below
  // MIN_SIMILARITY and was withheld, so the offers fired again the very next
  // turn). It is a preference about HOW Digby ends answers — tone-level, never
  // off-topic content — so it belongs with the identity/style keys.
  // capability-doctrine.test.ts cross-checks the two constants.
  'preferences_proactive_offers',
]);

/**
 * Location-type fact keys. Unlike ALWAYS_INJECT_FACT_KEYS, these are NOT injected
 * unconditionally (that would re-leak "you live in X" into unrelated answers — the
 * exact problem this gate exists to prevent). Instead they pass ONLY when the current
 * message shows LOCAL intent (see hasLocalIntent) — e.g. "best thing to eat at
 * <venue>", "restaurants near me", "what's the weather". Those queries are implicitly
 * about the user's locale, but the place-name in the message ("comox") rarely matches
 * the stored location token ("vancouver"), so plain topical overlap withholds it and
 * the model loses the context it needs to disambiguate the local query.
 * 2026-07-05: added after local-restaurant re-ask clusters where the AI couldn't tell
 * the query was about the user's own region.
 */
const LOCATION_FACT_KEYS = new Set([
  'location', 'city', 'town', 'region', 'country', 'area', 'locale',
  'based_in', 'basedin', 'lives_in', 'livesin', 'hometown', 'home_town',
  'neighborhood', 'neighbourhood', 'address', 'residence', 'timezone_city',
]);

/**
 * Signals that the current message is a LOCATION-relative query — one whose answer
 * depends on where the user is (local food/venues, "near me", weather, directions,
 * local services/events). When true, location-type facts are injected even without
 * a direct token match so the models can ground the query in the user's locale.
 * Deliberately conservative: matches explicit local intent, not any mention of a place.
 */
const LOCAL_INTENT_RE = /\b(near\s?by|near\s+me|around\s+(?:here|me)|close\s+to\s+me|in\s+my\s+area|local(?:ly)?|restaurant|restaurants|cafe|café|coffee\s+shop|eatery|bistro|diner|menu|where\s+to\s+eat|things?\s+to\s+eat|what\s+to\s+(?:eat|order|do)|places?\s+to\s+(?:eat|go|visit|drink)|weather|forecast|temperature\s+(?:today|now|outside)|directions?\s+to|how\s+(?:do\s+i|to)\s+get\s+to|open\s+(?:now|today|late)|opening\s+hours|hours\s+(?:of\s+operation|today)|nearby|commute|traffic|parking|events?\s+(?:near|around|this\s+weekend|tonight|today))\b/;

/**
 * Place-anchored query signals (2026-08-20, feedback 711aa37f): the user asked
 * "is there a sketchers in mayfair mall" and, with no local-intent token, the
 * gate withheld their stored location — so the model answered about a mall in
 * the wrong state. Store/venue existence, hours, and "nearest/closest" queries
 * are implicitly about the user's own area even when the venue name shares no
 * token with the stored location. Word list favors concrete place nouns that
 * rarely appear in non-local contexts; a rare false positive only surfaces
 * location as CAUTION-wrapped background, never as asserted content.
 */
const LOCAL_PLACE_RE = /\b(is\s+there\s+(?:a|an|any)|are\s+there\s+(?:a|an|any)|nearest|closest|downtown|uptown|mall|plaza|shopping\s+cent(?:er|re)|supermarket|grocery\s+store|pharmacy|drugstore|convenience\s+store|hardware\s+store|liquor\s+store|pet\s+store|book\s*store|gym|hotel|airport|(?:gas|train|bus|subway)\s+station|hospital|clinic|dentist|veterinarian|library|cinema|movie\s+theat(?:er|re)|arena|stadium|farmers?\s+market|campground|campsite|trailhead|zoo|museum|post\s+office|mechanic|car\s+wash|ev\s+charg(?:er|ing)|laundromat|barber|salon|bakery|butcher)\b/;

export function hasLocalIntent(message: string): boolean {
  const m = (message || '').toLowerCase();
  return LOCAL_INTENT_RE.test(m) || LOCAL_PLACE_RE.test(m);
}

/** Common English stopwords + generic chat verbs — never count as topical overlap. */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'your', 'yours', 'all', 'any',
  'can', 'could', 'would', 'should', 'may', 'might', 'shall', 'will', 'must',
  'has', 'have', 'had', 'was', 'were', 'been', 'being', 'this', 'that', 'these',
  'those', 'with', 'without', 'from', 'into', 'onto', 'about', 'above', 'below',
  'over', 'under', 'again', 'then', 'than', 'when', 'where', 'while', 'which',
  'who', 'whom', 'whose', 'what', 'why', 'how', 'here', 'there', 'their',
  'them', 'they', 'she', 'her', 'him', 'his', 'its', 'our', 'ours', 'out',
  'off', 'per', 'via', 'get', 'gets', 'got', 'let', 'lets', 'like', 'just',
  'also', 'very', 'much', 'more', 'most', 'some', 'such', 'only', 'other',
  'own', 'same', 'too', 'does', 'did', 'doing', 'don', 'dont', 'doesnt',
  'please', 'thanks', 'thank', 'hello', 'okay', 'yes', 'yeah', 'nope',
  'want', 'wants', 'need', 'needs', 'make', 'makes', 'give', 'gives',
  'tell', 'show', 'know', 'think', 'user', 'users', 'thing', 'things',
  'something', 'anything', 'everything', 'nothing', 'someone', 'anyone',
  'one', 'two', 'new', 'now', 'today', 'currently', 'current', 'really',
  'good', 'best', 'better', 'great', 'nice', 'help', 'use', 'uses', 'using',
  'way', 'ways', 'lot', 'bit', 'etc', 'and', 'because', 'since', 'before',
  'after', 'between', 'each', 'few', 'many', 'both', 'either', 'neither',
]);

/** Tokenize text into lowercase topical tokens (stopwords + short tokens removed). */
export function topicalTokens(text: string): string[] {
  if (!text) return [];
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[‘’‚‛]/g, "'")
    .split(/[^a-z0-9]+/)
    .filter(t => t.length >= 3 && !STOPWORDS.has(t) && !/^\d+$/.test(t));
}

/**
 * Loose stem match: tokens count as matching when equal, or when one prefixes
 * the other with at least 4 shared leading chars ("cook" ~ "cooking",
 * "vegetarian" ~ "vegetarians"). Keeps the gate cheap but tolerant of plurals
 * and simple inflection.
 */
function tokensMatch(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.min(a.length, b.length) < 4) return false;
  return a.startsWith(b) || b.startsWith(a);
}

/** Does any token from `candidateTokens` topically overlap the message token set? */
export function hasTopicalOverlap(candidateTokens: string[], messageTokens: string[]): boolean {
  if (candidateTokens.length === 0 || messageTokens.length === 0) return false;
  for (const c of candidateTokens) {
    for (const m of messageTokens) {
      if (tokensMatch(c, m)) return true;
    }
  }
  return false;
}

/**
 * Detect questions that are ABOUT the user's memory/identity or that explicitly
 * ask for personalization — these bypass the relevance gate (all facts injected)
 * so the user can inspect memory and get genuinely personalized answers when
 * they ask for them.
 */
export function isMemoryRecallQuery(message: string): boolean {
  const m = (message || '').toLowerCase().replace(/[‘’]/g, "'");
  return /\b(what do you (know|remember) about me|do you (know|remember) (me|my|anything about me)|what('s| is) my name|who am i\b|about me\b|my (memory|profile|preferences|facts)|what have you (learned|stored)|remember (about|of) me|based on (what you know|my (profile|preferences|interests))|personali[sz]e|recommend (something |anything )?for me|tailor(ed)? (to|for) me|know about my)\b/.test(m);
}

export interface FactRelevanceResult {
  /** Facts that should be injected into the prompt. */
  relevant: Record<string, string>;
  /** Count of topical facts withheld as irrelevant to the current message. */
  withheldCount: number;
  /** True when the recall/personalization bypass fired (all facts injected). */
  recallBypass: boolean;
}

/**
 * Filter stored flat facts down to the ones relevant to the current message.
 *
 * - Identity/style keys (ALWAYS_INJECT_FACT_KEYS) always pass.
 * - Memory-recall / explicit-personalization questions inject everything.
 * - Every other fact must topically overlap the current message or the most
 *   recent user messages (follow-ups often carry no topic words themselves).
 */
export function filterFactsByRelevance(
  facts: Record<string, string>,
  currentMessage: string,
  recentUserMessages: string[] = [],
): FactRelevanceResult {
  const entries = Object.entries(facts).filter(([k]) => !k.startsWith('__'));
  if (entries.length === 0) return { relevant: {}, withheldCount: 0, recallBypass: false };

  if (isMemoryRecallQuery(currentMessage)) {
    return { relevant: Object.fromEntries(entries), withheldCount: 0, recallBypass: true };
  }

  // Current message weighs most; include up to the last 2 user messages so
  // short follow-ups ("what about the second one?") keep topical continuity.
  const messageTokens = topicalTokens(
    [currentMessage, ...recentUserMessages.slice(-2)].join(' ')
  );

  // Location-relative query? Then location-type facts pass even without a token match.
  const localIntent = hasLocalIntent([currentMessage, ...recentUserMessages.slice(-1)].join(' '));

  const relevant: Record<string, string> = {};
  let withheldCount = 0;
  for (const [key, value] of entries) {
    const keyNorm = key.toLowerCase().replace(/[^a-z]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
    if (ALWAYS_INJECT_FACT_KEYS.has(keyNorm) || ALWAYS_INJECT_FACT_KEYS.has(key.toLowerCase())) {
      relevant[key] = value;
      continue;
    }
    if (localIntent && (LOCATION_FACT_KEYS.has(keyNorm) || LOCATION_FACT_KEYS.has(key.toLowerCase()))) {
      relevant[key] = value;
      continue;
    }
    const factTokens = topicalTokens(`${key.replace(/_/g, ' ')} ${String(value)}`);
    if (hasTopicalOverlap(factTokens, messageTokens)) {
      relevant[key] = value;
    } else {
      withheldCount++;
    }
  }
  return { relevant, withheldCount, recallBypass: false };
}

/**
 * Relevance check for free-text memory blocks (profile summary, currentFocus,
 * recent topics). Same rules as facts: recall queries always pass, otherwise
 * the text must topically overlap the current message context.
 */
export function isTextRelevantToMessage(
  text: string,
  currentMessage: string,
  recentUserMessages: string[] = [],
): boolean {
  if (!text) return false;
  if (isMemoryRecallQuery(currentMessage)) return true;
  const messageTokens = topicalTokens(
    [currentMessage, ...recentUserMessages.slice(-2)].join(' ')
  );
  return hasTopicalOverlap(topicalTokens(text), messageTokens);
}
