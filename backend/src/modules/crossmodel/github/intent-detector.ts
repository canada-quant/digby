/**
 * GitHub Intent Detector
 *
 * Keyword / pattern matching to detect when the user wants GitHub data
 * included in the AI response. No LLM call — pure regex matching is fast and
 * cheap enough for every query.
 *
 * Returns flags for each GitHub feature so the controller can selectively fetch context.
 */

export interface GitHubIntent {
  repos: boolean;
  issues: boolean;
  pullRequests: boolean;
  codeSearch: boolean;
  files: boolean;
  createIssue: boolean;
  createPR: boolean;
}

// ── Pattern sets ──────────────────────────────────────────────────────────────

const REPOS_PATTERNS: RegExp[] = [
  /\b(my\s+)?repos(?:itories)?\b/i,
  /\bgithub\s+repos(?:itories)?\b/i,
  /\blist\s+repos\b/i,
  /\bshow\s+(me\s+)?repos\b/i,
  /\bmy\s+(github\s+)?repos(?:itories)?\b/i,
  /\b(github|git)\s+repos(?:itories)?\b/i,
];

const ISSUES_PATTERNS: RegExp[] = [
  /\bissues?\b/i,
  /\bbugs?\b/i,
  /\btickets?\b/i,
  /\bopen\s+issue\b/i,
  /\bcreate\s+issue\b/i,
  /\bfile\s+issue\b/i,
  /\blist\s+issues?\b/i,
  /\bshow\s+(me\s+)?issues?\b/i,
  /\bgithub\s+issues?\b/i,
];

const PULL_REQUESTS_PATTERNS: RegExp[] = [
  /\bpull\s+request\b/i,
  /\bPR\b/i,
  /\bmerge\b/i,
  /\bopen\s+PR\b/i,
  /\bcreate\s+PR\b/i,
  /\blist\s+(my\s+)?PRs?\b/i,
  /\bgithub\s+(pull\s+request|PR)\b/i,
];

const CODE_SEARCH_PATTERNS: RegExp[] = [
  /\bsearch\s+code\b/i,
  /\bfind\s+in\s+code\b/i,
  /\bgrep\b/i,
  /\bsearch\s+(for\s+)?.*\bin\s+repo\b/i,
  /\bgithub\s+search\b/i,
  /\bcode\s+search\b/i,
  /\bsearch\s+.*\brepository\b/i,
];

const FILES_PATTERNS: RegExp[] = [
  /\bshow\s+me\s+(the\s+)?file\b/i,
  /\bread.*file\b/i,
  /\bcontents?\s+of\b/i,
  /\bREADME\b/i,
  /\bsource\s+code\b/i,
  /\bgithub\s+file\b/i,
  /\bget\s+file\b/i,
  /\bview\s+file\b/i,
  /\bopen\s+file\b/i,
  /\bfile\s+contents?\b/i,
];

const CREATE_ISSUE_PATTERNS: RegExp[] = [
  /\bcreate\s+issue\b/i,
  /\bopen\s+issue\b/i,
  /\bfile\s+a?\s+bug\b/i,
  /\breport\s+(a\s+)?bug\b/i,
  /\bsubmit\s+(a\s+)?(bug|issue)\b/i,
];

const CREATE_PR_PATTERNS: RegExp[] = [
  /\bcreate\s+PR\b/i,
  /\bopen\s+PR\b/i,
  /\bmake\s+(a\s+)?pull\s+request\b/i,
  /\bsubmit\s+(a\s+)?PR\b/i,
  /\bcreate\s+(a\s+)?pull\s+request\b/i,
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some(p => p.test(text));
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Detect GitHub-related intent from a user message.
 *
 * @param message - Raw user message string
 * @returns Intent flags for each GitHub feature
 */
export function detectGitHubIntent(message: string): GitHubIntent {
  return {
    repos:        matchesAny(message, REPOS_PATTERNS),
    issues:       matchesAny(message, ISSUES_PATTERNS),
    pullRequests: matchesAny(message, PULL_REQUESTS_PATTERNS),
    codeSearch:   matchesAny(message, CODE_SEARCH_PATTERNS),
    files:        matchesAny(message, FILES_PATTERNS),
    createIssue:  matchesAny(message, CREATE_ISSUE_PATTERNS),
    createPR:     matchesAny(message, CREATE_PR_PATTERNS),
  };
}

/**
 * Returns true if any GitHub intent is detected.
 */
export function hasAnyGitHubIntent(intent: GitHubIntent): boolean {
  return intent.repos || intent.issues || intent.pullRequests ||
         intent.codeSearch || intent.files || intent.createIssue || intent.createPR;
}

/**
 * Extract owner/repo context from a message.
 * Matches "owner/repo" patterns like "facebook/react" or "owner/repo".
 */
export function extractRepoContext(message: string): { owner?: string; repo?: string } {
  const match = message.match(/([\w.-]+)\/([\w.-]+)/);
  if (!match) return {};
  return { owner: match[1], repo: match[2] };
}
