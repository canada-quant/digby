/**
 * Asana Intent Detector
 *
 * Keyword / pattern matching to detect when the user wants Asana data included
 * in the AI response. No LLM call — pure regex matching is fast and cheap.
 *
 * Returns flags for each Asana feature so the controller can selectively fetch context.
 */

export interface AsanaIntent {
  tasks:    boolean;
  projects: boolean;
  search:   boolean;
}

// ── Pattern sets ──────────────────────────────────────────────────────────────

const TASKS_PATTERNS: RegExp[] = [
  /\b(my|our)\s+(asana\s+)?tasks?\b/i,
  /\basana\s+tasks?\b/i,
  /\b(what('?s| is)|show|list)\s+.*\b(due|assigned|on my plate|to do|to-do|todo)\b/i,
  /\b(tasks?|to-?dos?)\s+(due|assigned to me|in asana)\b/i,
  /\bwhat\s+(do\s+i|should\s+i|am\s+i)\s+(need\s+to\s+)?(do|work\s+on)\b/i,
];

const PROJECTS_PATTERNS: RegExp[] = [
  /\basana\s+projects?\b/i,
  /\b(my|our|list|which)\s+projects?\b/i,
  /\bprojects?\s+in\s+asana\b/i,
];

const SEARCH_PATTERNS: RegExp[] = [
  /\bsearch\s+asana\b/i,
  /\bfind\s+(a\s+)?task\b/i,
  /\bsearch\s+(for\s+)?.*\bin\s+asana\b/i,
  /\basana\s+search\b/i,
];

// General "asana" mention — triggers a tasks fetch.
const MENTION_PATTERNS: RegExp[] = [/\basana\b/i];

// ── Helpers ───────────────────────────────────────────────────────────────────

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some(p => p.test(text));
}

// ── Public API ────────────────────────────────────────────────────────────────

export function detectAsanaIntent(message: string): AsanaIntent {
  return {
    tasks:    matchesAny(message, TASKS_PATTERNS),
    projects: matchesAny(message, PROJECTS_PATTERNS),
    search:   matchesAny(message, SEARCH_PATTERNS),
  };
}

export function hasAnyAsanaIntent(intent: AsanaIntent): boolean {
  return intent.tasks || intent.projects || intent.search;
}

export function hasAsanaMention(message: string): boolean {
  return matchesAny(message, MENTION_PATTERNS);
}
