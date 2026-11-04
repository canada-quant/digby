/**
 * Tests for the memory relevance gate (memory-relevance.ts).
 *
 * The gate decides which stored user facts are injected into a query's
 * context. Regression target: stored personal facts (diet, location, hobbies…)
 * must NOT be injected into topically unrelated chats, while identity/style
 * keys, recall questions, and genuinely related topics must still pass.
 */

import {
  filterFactsByRelevance,
  isMemoryRecallQuery,
  isTextRelevantToMessage,
  topicalTokens,
} from './memory-relevance';

const FACTS: Record<string, string> = {
  name: 'Rome',
  timezone: 'America/Vancouver',
  diet: 'eats seafood, family eats everything',
  location: 'lives in Vancouver, BC',
  occupation: 'runs a farmers market startup',
  hobbies: 'rock climbing and sailing',
};

describe('filterFactsByRelevance', () => {
  it('withholds all topical facts for a completely unrelated question', () => {
    const { relevant, withheldCount, recallBypass } = filterFactsByRelevance(
      FACTS,
      'Write me a regex that matches ISO 8601 dates'
    );
    expect(recallBypass).toBe(false);
    expect(relevant).not.toHaveProperty('diet');
    expect(relevant).not.toHaveProperty('location');
    expect(relevant).not.toHaveProperty('occupation');
    expect(relevant).not.toHaveProperty('hobbies');
    expect(withheldCount).toBe(4);
  });

  it('always passes identity/style keys (name, timezone)', () => {
    const { relevant } = filterFactsByRelevance(FACTS, 'Explain quantum entanglement');
    expect(relevant).toHaveProperty('name', 'Rome');
    expect(relevant).toHaveProperty('timezone', 'America/Vancouver');
  });

  it("always passes the proactive-offer opt-out ('preferences.proactive_offers' — the capability doctrine's key) on an unrelated question", () => {
    // 2026-09-08: the offers block promises to honor this fact "whenever it is
    // in memory"; the dotted key normalizes to 'preferences_proactive_offers',
    // which must be in ALWAYS_INJECT_FACT_KEYS or the gate withholds it here.
    const { relevant, withheldCount } = filterFactsByRelevance(
      { ...FACTS, 'preferences.proactive_offers': 'off' },
      'Explain quantum entanglement'
    );
    // array path — jest would otherwise read the dot as a nesting separator
    expect(relevant).toHaveProperty(['preferences.proactive_offers'], 'off');
    expect(withheldCount).toBe(4); // the topical facts are still withheld
  });

  it('passes a fact when the question topically relates to it', () => {
    const { relevant } = filterFactsByRelevance(
      FACTS,
      'What are good seafood restaurants nearby?'
    );
    expect(relevant).toHaveProperty('diet');
  });

  it('matches simple inflections (climbing ~ climb)', () => {
    const { relevant } = filterFactsByRelevance(FACTS, 'Best places to climb this summer?');
    expect(relevant).toHaveProperty('hobbies');
  });

  it('uses recent user messages for follow-up continuity', () => {
    const { relevant } = filterFactsByRelevance(
      FACTS,
      'what about the second one?',
      ['Compare sailing routes around Vancouver Island']
    );
    expect(relevant).toHaveProperty('hobbies'); // "sailing" overlap via history
    expect(relevant).toHaveProperty('location'); // "Vancouver" overlap via history
  });

  it('injects everything for memory-recall questions', () => {
    const { relevant, recallBypass } = filterFactsByRelevance(FACTS, 'What do you know about me?');
    expect(recallBypass).toBe(true);
    expect(Object.keys(relevant).sort()).toEqual(Object.keys(FACTS).sort());
  });

  it('injects everything when the user explicitly asks for personalization', () => {
    const { recallBypass } = filterFactsByRelevance(FACTS, 'Recommend something for me based on my interests');
    expect(recallBypass).toBe(true);
  });

  it('never leaks internal __ keys', () => {
    const { relevant } = filterFactsByRelevance(
      { ...FACTS, __rejections: 'joint health' as any },
      'What do you know about me?'
    );
    expect(relevant).not.toHaveProperty('__rejections');
  });

  it('injects location for a local-business query even when the venue name does not match', () => {
    // "comox" never overlaps the stored "vancouver" token, but the query is clearly
    // location-relative — the models need the user's locale to ground it.
    const { relevant } = filterFactsByRelevance(FACTS, 'Best thing to eat at dockside comox');
    expect(relevant).toHaveProperty('location');
  });

  it('does NOT inject location for a non-local query that mentions no local intent', () => {
    const { relevant } = filterFactsByRelevance(FACTS, 'Explain the difference between TCP and UDP');
    expect(relevant).not.toHaveProperty('location');
  });

  it('injects location for a store-existence query with no venue-token match (feedback 711aa37f)', () => {
    // "mayfair mall" shares no token with the stored "Vancouver" location, but a
    // store-existence question is about the user's own area — the model needs the
    // locale to pick the right Mayfair (the user meant Victoria, BC; the model
    // answered for Milwaukee when location was withheld).
    const { relevant } = filterFactsByRelevance(FACTS, 'is there a sketchers in mayfair mall');
    expect(relevant).toHaveProperty('location');
  });

  it('injects location for place-noun and nearest/closest queries', () => {
    expect(filterFactsByRelevance(FACTS, 'what time does the mall close today').relevant)
      .toHaveProperty('location');
    expect(filterFactsByRelevance(FACTS, 'nearest pharmacy that is still open').relevant)
      .toHaveProperty('location');
    expect(filterFactsByRelevance(FACTS, 'any good trails at the campground').relevant)
      .toHaveProperty('location');
  });

  it('still withholds location for non-local questions', () => {
    expect(filterFactsByRelevance(FACTS, 'what is the capital of france').relevant)
      .not.toHaveProperty('location');
    expect(filterFactsByRelevance(FACTS, 'explain how recursion works').relevant)
      .not.toHaveProperty('location');
    expect(filterFactsByRelevance(FACTS, 'write a regex for emails').relevant)
      .not.toHaveProperty('location');
  });
});

describe('isMemoryRecallQuery', () => {
  it.each([
    'what do you know about me?',
    "What's my name?",
    'do you remember me',
    'tell me about my preferences',
  ])('detects "%s" as recall', (q) => {
    expect(isMemoryRecallQuery(q)).toBe(true);
  });

  it.each([
    'write a regex for emails',
    'who won the game last night?',
    'summarize this document',
  ])('does not flag "%s"', (q) => {
    expect(isMemoryRecallQuery(q)).toBe(false);
  });
});

describe('isTextRelevantToMessage', () => {
  it('rejects an unrelated profile summary', () => {
    expect(
      isTextRelevantToMessage(
        'User runs a farmers market startup in Vancouver and enjoys sailing',
        'How do I center a div in CSS?'
      )
    ).toBe(false);
  });

  it('accepts a related profile summary', () => {
    expect(
      isTextRelevantToMessage(
        'User runs a farmers market startup in Vancouver',
        'What permits do I need for a farmers market stall?'
      )
    ).toBe(true);
  });
});

describe('topicalTokens', () => {
  it('drops stopwords and short tokens', () => {
    expect(topicalTokens('what is the best way to do this')).toEqual([]);
  });
});
