/**
 * Xero Intent Detector
 *
 * Keyword / pattern matching to detect when the user wants Xero accounting data
 * included in the AI response. No LLM call — pure regex matching is fast and
 * cheap enough for every query.
 *
 * Returns flags for each Xero data type so the controller can selectively fetch.
 */

export interface XeroIntent {
  /** User is asking about contacts / customers / suppliers */
  contacts: boolean;
  /** User is asking about invoices / sales */
  invoices: boolean;
  /** User is asking about bills / purchases / accounts payable */
  bills: boolean;
  /** User is asking about chart of accounts / account codes */
  accounts: boolean;
  /** User is asking about bank accounts / balances */
  bank: boolean;
  /** User is asking about profit & loss / income statement */
  profitAndLoss: boolean;
  /** User is asking about balance sheet */
  balanceSheet: boolean;
  /** User is asking about Xero organisation info */
  organisation: boolean;
}

// ── Pattern sets ──────────────────────────────────────────────────────────────

const CONTACTS_PATTERNS: RegExp[] = [
  /\b(xero\s+)?(contact|contacts|customer|customers|supplier|suppliers|vendor|vendors|client|clients)\b/i,
  /\b(who\s+(do\s+)?(i|we)\s+(owe|invoice|bill))\b/i,
  /\b(show|list|find|get|search)\s+(my\s+|our\s+)?(xero\s+)?(contacts?|customers?|suppliers?|clients?)\b/i,
];

const INVOICES_PATTERNS: RegExp[] = [
  /\b(xero\s+)?(invoice|invoices|sales|receivable|receivables|outstanding\s+invoice)\b/i,
  /\b(show|list|get|check|find)\s+(my\s+|our\s+)?(xero\s+)?(invoices?|sales)\b/i,
  /\bwho\s+owes\s+(me|us)\b/i,
  /\b(unpaid|overdue|outstanding)\s+(invoice|invoices|amount)\b/i,
  /\baccounts?\s+receivable\b/i,
];

const BILLS_PATTERNS: RegExp[] = [
  /\b(xero\s+)?(bill|bills|purchase|purchases|payable|payables)\b/i,
  /\b(show|list|get|check|find)\s+(my\s+|our\s+)?(xero\s+)?(bills?|purchases?)\b/i,
  /\bwhat\s+(do\s+)?(i|we)\s+owe\b/i,
  /\b(unpaid|overdue|outstanding)\s+(bill|bills)\b/i,
  /\baccounts?\s+payable\b/i,
];

const ACCOUNTS_PATTERNS: RegExp[] = [
  /\b(xero\s+)?(chart\s+of\s+accounts?|account\s+codes?|coa)\b/i,
  /\b(show|list|get)\s+(my\s+|our\s+)?(xero\s+)?(accounts?|chart\s+of\s+accounts?)\b/i,
  /\baccount\s+(list|codes?|categories)\b/i,
];

const BANK_PATTERNS: RegExp[] = [
  /\b(xero\s+)?(bank\s+account|bank\s+accounts|bank\s+balance|bank\s+balances)\b/i,
  /\b(show|check|get)\s+(my\s+|our\s+)?(xero\s+)?bank\b/i,
  /\bbank\s+(summary|overview|status)\b/i,
];

const PNL_PATTERNS: RegExp[] = [
  /\b(profit\s+(and|&)\s+loss|p\s*&\s*l|income\s+statement|pnl)\b/i,
  /\b(xero\s+)?(revenue|expenses?|net\s+(income|profit|loss))\b/i,
  /\bhow\s+(much|are)\s+(did\s+)?(i|we)\s+(make|earn|spend|profit|lose)\b/i,
  /\b(show|get)\s+(my\s+|our\s+)?(xero\s+)?(profit|loss|revenue|income)\b/i,
];

const BALANCE_SHEET_PATTERNS: RegExp[] = [
  /\bbalance\s+sheet\b/i,
  /\b(total\s+)?(assets?|liabilities|equity)\b/i,
  /\b(xero\s+)?(financial\s+position|net\s+worth)\b/i,
];

const ORG_PATTERNS: RegExp[] = [
  /\bxero\s+(org|organisation|organization|company|business)\b/i,
  /\b(which|what)\s+(xero\s+)?(org|organisation|organization)\b/i,
];

// General "xero" mention — triggers at least organisation info
const XERO_GENERAL: RegExp[] = [
  /\bxero\b/i,
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some(p => p.test(text));
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Detect Xero accounting data intent from a user message.
 */
export function detectXeroIntent(message: string): XeroIntent {
  const contacts     = matchesAny(message, CONTACTS_PATTERNS);
  const invoices     = matchesAny(message, INVOICES_PATTERNS);
  const bills        = matchesAny(message, BILLS_PATTERNS);
  const accounts     = matchesAny(message, ACCOUNTS_PATTERNS);
  const bank         = matchesAny(message, BANK_PATTERNS);
  const profitAndLoss = matchesAny(message, PNL_PATTERNS);
  const balanceSheet = matchesAny(message, BALANCE_SHEET_PATTERNS);
  const organisation = matchesAny(message, ORG_PATTERNS);

  return { contacts, invoices, bills, accounts, bank, profitAndLoss, balanceSheet, organisation };
}

/**
 * Returns true if any Xero-specific intent is detected.
 */
export function hasAnyXeroIntent(intent: XeroIntent): boolean {
  return intent.contacts || intent.invoices || intent.bills || intent.accounts
    || intent.bank || intent.profitAndLoss || intent.balanceSheet || intent.organisation;
}

/**
 * Returns true if the message mentions "xero" at all (even without specific intent).
 * Used to trigger a general Xero data fetch when the user says "check my xero".
 */
export function hasXeroMention(message: string): boolean {
  return matchesAny(message, XERO_GENERAL);
}
