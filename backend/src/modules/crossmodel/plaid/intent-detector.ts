/**
 * Plaid Intent Detector
 *
 * Keyword / pattern matching to detect when the user wants Plaid banking data
 * included in the AI response. No LLM call — pure regex matching is fast and
 * cheap enough for every query.
 *
 * Returns flags for each Plaid data type so the controller can selectively fetch.
 */

export interface PlaidIntent {
  /** User is asking about bank accounts / account list */
  accounts: boolean;
  /** User is asking about account balances */
  balances: boolean;
  /** User is asking about recent transactions / spending */
  transactions: boolean;
  /** User is asking about recurring transactions / subscriptions */
  recurring: boolean;
  /** User is asking about identity / account holder info */
  identity: boolean;
}

// ── Pattern sets ──────────────────────────────────────────────────────────────

const ACCOUNTS_PATTERNS: RegExp[] = [
  /\b(plaid\s+)?(bank\s+account|bank\s+accounts|linked\s+account|linked\s+accounts|connected\s+account|connected\s+accounts)\b/i,
  /\b(show|list|get|check)\s+(my\s+|our\s+)?(plaid\s+)?(bank\s+)?(accounts?)\b/i,
  /\b(which|what)\s+(bank|accounts?)\s+(do\s+)?(i|we)\s+have\b/i,
];

const BALANCES_PATTERNS: RegExp[] = [
  /\b(plaid\s+)?(balance|balances|bank\s+balance|account\s+balance|how\s+much\s+(do\s+)?(i|we)\s+have)\b/i,
  /\b(show|check|get|what('s|s|\s+is))\s+(my\s+|our\s+)?(plaid\s+)?(bank\s+)?(balance|balances)\b/i,
  /\b(available|current)\s+(balance|funds)\b/i,
  /\bhow\s+much\s+(money|cash)\s+(do\s+)?(i|we)\s+have\b/i,
  /\bhow\s+much\s+is\s+in\s+my\b/i,
];

const TRANSACTIONS_PATTERNS: RegExp[] = [
  /\b(plaid\s+)?(transaction|transactions|spending|purchases|payments|charges|debits|credits)\b/i,
  /\b(show|list|get|check|find)\s+(my\s+|our\s+)?(plaid\s+)?(recent\s+)?(transaction|transactions|spending|purchases)\b/i,
  /\bwhat\s+(did\s+)?(i|we)\s+(spend|buy|purchase|pay)\b/i,
  /\bwhere\s+(did\s+)?(i|we)\s+spend\b/i,
  /\b(recent|latest|last)\s+(transaction|transactions|purchase|purchases|payment|payments)\b/i,
  /\bspending\s+(summary|breakdown|analysis|report|history)\b/i,
];

const RECURRING_PATTERNS: RegExp[] = [
  /\b(plaid\s+)?(recurring|subscription|subscriptions|monthly\s+charge|monthly\s+payment|auto.?pay|direct\s+debit)\b/i,
  /\b(show|list|get|check)\s+(my\s+|our\s+)?(plaid\s+)?(recurring|subscriptions?)\b/i,
  /\bwhat\s+(recurring|monthly)\s+(charges?|payments?|bills?)\b/i,
];

const IDENTITY_PATTERNS: RegExp[] = [
  /\b(plaid\s+)?(account\s+holder|account\s+owner|bank\s+identity)\b/i,
  /\bwho\s+owns?\s+(the\s+)?(bank\s+)?account\b/i,
];

// General "plaid" mention — triggers at least accounts + balances
const PLAID_GENERAL: RegExp[] = [
  /\bplaid\b/i,
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some(p => p.test(text));
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Detect Plaid banking data intent from a user message.
 */
export function detectPlaidIntent(message: string): PlaidIntent {
  const accounts     = matchesAny(message, ACCOUNTS_PATTERNS);
  const balances     = matchesAny(message, BALANCES_PATTERNS);
  const transactions = matchesAny(message, TRANSACTIONS_PATTERNS);
  const recurring    = matchesAny(message, RECURRING_PATTERNS);
  const identity     = matchesAny(message, IDENTITY_PATTERNS);

  return { accounts, balances, transactions, recurring, identity };
}

/**
 * Returns true if any Plaid-specific intent is detected.
 */
export function hasAnyPlaidIntent(intent: PlaidIntent): boolean {
  return intent.accounts || intent.balances || intent.transactions
    || intent.recurring || intent.identity;
}

/**
 * Returns true if the message mentions "plaid" at all (even without specific intent).
 * Used to trigger a general Plaid data fetch when the user says "check my plaid".
 */
export function hasPlaidMention(message: string): boolean {
  return matchesAny(message, PLAID_GENERAL);
}
