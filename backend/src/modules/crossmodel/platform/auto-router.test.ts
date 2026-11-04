/**
 * P4: Auto heuristic router + patience-mode normalization.
 * Pure functions — no mocks needed.
 */
import { routeMessageHeuristic, detectCodeIntent } from './auto-router';
import { normalizePatienceMode } from '../types';

describe('normalizePatienceMode (P4 aliases)', () => {
  it('aliases retired modes at the intake boundary', () => {
    expect(normalizePatienceMode('fast')).toBe('single_thinking');
    expect(normalizePatienceMode('single')).toBe('single_thinking');
    // P4: L4 collapses into L3 (frontier chat options killed → one model set left)
    expect(normalizePatienceMode('deep_research_all')).toBe('deep_research');
  });
  it('passes current modes through untouched', () => {
    expect(normalizePatienceMode('single_thinking')).toBe('single_thinking');
    expect(normalizePatienceMode('thinking')).toBe('thinking');
    expect(normalizePatienceMode('deep_research')).toBe('deep_research');
    expect(normalizePatienceMode('browser_agent')).toBe('browser_agent');
    expect(normalizePatienceMode('code')).toBe('code');
    expect(normalizePatienceMode('auto')).toBe('auto'); // per-message, resolved downstream
  });
});

describe('routeMessageHeuristic', () => {
  const noWs = { hasWorkspace: false };

  it('routes short single-part lookups to L1 (single_thinking)', () => {
    expect(routeMessageHeuristic({ content: 'What is the capital of France?', ...noWs }).level).toBe('single_thinking');
    expect(routeMessageHeuristic({ content: 'Who wrote Hamlet?', ...noWs }).level).toBe('single_thinking');
    expect(routeMessageHeuristic({ content: 'define idempotency', ...noWs }).level).toBe('single_thinking');
  });

  it('defaults to L2 (thinking) for anything not clearly L1/L3 — bias cheap', () => {
    expect(routeMessageHeuristic({ content: '', ...noWs }).level).toBe('thinking');
    expect(routeMessageHeuristic({ content: 'Explain how photosynthesis works and also why it matters for climate', ...noWs }).level).toBe('thinking');
    expect(routeMessageHeuristic({ content: 'Tell me a story about a robot who learns to paint', ...noWs }).level).toBe('thinking');
  });

  it('multi-part disqualifies L1 even with a simple opener', () => {
    const r = routeMessageHeuristic({ content: 'What is inflation and also how does it compare across economies?', ...noWs });
    expect(r.level).toBe('thinking');
  });

  it('routes explicit research intent to L3 (deep_research)', () => {
    expect(routeMessageHeuristic({ content: 'Research the effects of intermittent fasting on metabolism', ...noWs }).level).toBe('deep_research');
    expect(routeMessageHeuristic({ content: 'Give me a comprehensive analysis of the EV battery market', ...noWs }).level).toBe('deep_research');
    expect(routeMessageHeuristic({ content: 'Do a deep dive into the causes of the 2008 financial crisis', ...noWs }).level).toBe('deep_research');
  });

  it('audit 2026-10-03: a WEAK research word in an ordinary question no longer convenes the council', () => {
    for (const q of [
      'what is the source of the Nile?',
      "what's a good open source alternative to Photoshop?",
      'what are the latest news about the Fed?',
      'can you cite the line where Hamlet says that?',
      'what does the research say about creatine?',
      'any good literature on stoicism for beginners?',
    ]) {
      expect(routeMessageHeuristic({ content: q, ...noWs }).level).not.toBe('deep_research');
    }
    // the split only NARROWS Level 3: "investigate" never was a trigger and is not one now
    expect(routeMessageHeuristic({ content: 'please investigate why our churn rose last quarter', ...noWs }).level).not.toBe('deep_research');
  });

  it('audit 2026-10-03: a research REQUEST still routes to L3', () => {
    for (const q of [
      'Research the history of Quebec sovereignty and why Canadians are split on it',
      'Can you research the best heat pumps for a cold climate?',
      'please research why our churn rose last quarter',
      'I need some deep research on lithium supply chains',
      'do some research on the 1995 referendum',
      'Write a detailed report on carbon pricing in Canada',
      'Give me a literature review of GLP-1 trials',
    ]) {
      expect(routeMessageHeuristic({ content: q, ...noWs }).level).toBe('deep_research');
    }
  });

  it('AUTO_ROUTE_RESEARCH_CUE_SPLIT_DISABLED=1 restores the old any-cue ⇒ L3 rule', () => {
    const prev = process.env.AUTO_ROUTE_RESEARCH_CUE_SPLIT_DISABLED;
    process.env.AUTO_ROUTE_RESEARCH_CUE_SPLIT_DISABLED = '1';
    try {
      expect(routeMessageHeuristic({ content: 'what is the source of the Nile?', ...noWs }).level).toBe('deep_research');
    } finally {
      if (prev === undefined) delete process.env.AUTO_ROUTE_RESEARCH_CUE_SPLIT_DISABLED; else process.env.AUTO_ROUTE_RESEARCH_CUE_SPLIT_DISABLED = prev;
    }
  });

  it('NEVER routes to L3 on length alone — a long single question stays L2', () => {
    const longSingle = 'What is the best way to explain ' + 'the nuances of quantum entanglement '.repeat(50) + 'to a child?';
    expect(longSingle.length).toBeGreaterThan(1200);
    expect(routeMessageHeuristic({ content: longSingle, ...noWs }).level).toBe('thinking');
  });

  it('routes a very long MULTI-PART brief to L3', () => {
    const brief = '1) Summarize the current state of solid-state batteries\n2) Analyze the manufacturing challenges\n3) ' + 'Discuss supply chain implications for automakers in detail. '.repeat(30);
    expect(brief.length).toBeGreaterThan(1200);
    expect(routeMessageHeuristic({ content: brief, ...noWs }).level).toBe('deep_research');
  });

  it('suggests Code only when code intent AND a resolvable workspace coincide', () => {
    const msg = 'Fix the failing test in tests/auth.spec.ts';
    const withWs = routeMessageHeuristic({ content: msg, hasWorkspace: true });
    expect(withWs.suggestCode).toBe(true);
    expect(withWs.reason).toMatch(/suggest Code/);
    expect(routeMessageHeuristic({ content: msg, hasWorkspace: false }).suggestCode).toBe(false);
  });

  it('needsWorkspace flags bare code/repo intent WITHOUT the workspace precondition (User Space §4a attach trigger)', () => {
    // Code intent fires regardless of hasWorkspace — the send seams consume it
    // to attach the satellite on demand (capability = attachable on demand).
    expect(routeMessageHeuristic({ content: 'Fix the failing test in tests/auth.spec.ts', hasWorkspace: false }).needsWorkspace).toBe(true);
    expect(routeMessageHeuristic({ content: 'there is a bug in the login flow', hasWorkspace: false }).needsWorkspace).toBe(true);
    expect(routeMessageHeuristic({ content: 'What does the retry logic in src/retry.ts do?', hasWorkspace: true }).needsWorkspace).toBe(true);
    // Plain prose never attaches.
    expect(routeMessageHeuristic({ content: 'what is the weather like in Paris?', hasWorkspace: true }).needsWorkspace).toBe(false);
    expect(routeMessageHeuristic({ content: '', hasWorkspace: true }).needsWorkspace).toBe(false);
    // …and it never changes the LEVEL pick by itself (same discipline as suggestCode).
    expect(routeMessageHeuristic({ content: 'Fix the failing test in tests/auth.spec.ts', hasWorkspace: true }).level).not.toBe('deep_research');
  });

  it('code intent never changes the LEVEL pick by itself', () => {
    expect(routeMessageHeuristic({ content: 'What does the retry logic in src/retry.ts do?', hasWorkspace: true }).level).toBe('single_thinking');
  });
});

describe('detectCodeIntent', () => {
  it('detects file mentions, repo paths, PRs and code verbs', () => {
    expect(detectCodeIntent('look at tools.ts')).toBe('file mention');
    expect(detectCodeIntent('the bug is in src/modules/auth')).toBe('repo path');
    expect(detectCodeIntent('open a PR for this')).toBe('PR');
    expect(detectCodeIntent('there is a bug in the login flow')).toBe('code intent');
  });
  it('returns null for plain prose', () => {
    expect(detectCodeIntent('what is the weather like in Paris?')).toBeNull();
    expect(detectCodeIntent('write me a poem about the sea')).toBeNull();
  });
});
