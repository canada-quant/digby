/**
 * Plaid MCP Client
 *
 * Calls the Plaid API directly using the user's access token.
 * Plaid API calls are simple REST POST requests to api.plaid.com.
 *
 * All functions return formatted context strings for injection into the AI
 * system prompt. A FAILED Plaid call (2026-10-04, integrations/integration-error.ts)
 * surfaces as ONE readable line per institution — the bank link needs
 * re-linking (ITEM_LOGIN_REQUIRED / 401 / 403), rate-limited, the bank or Plaid
 * down, network, not configured — instead of '' (which the coding executor
 * turned into "No result from Plaid … may not be connected … or nothing
 * matched"); a failed institution next to a working one rides under its data.
 * Not-linked and genuinely-empty results keep ''. INTEGRATION_ERROR_SURFACE_DISABLED=1
 * restores the old silent behaviour.
 *
 * Plaid API base: https://production.plaid.com (or https://sandbox.plaid.com)
 * Auth: client_id + secret in request body (not headers)
 */

import axios from 'axios';
import logger from '../../../utils/logger';
import { getPlaidTokens, hasPlaidConnected } from './token-manager';
import {
  IntegrationApiError, IntegrationErrorKind, INTEGRATION_SERVICES, integrationErrorSurfaceDisabled,
  surfacedOrEmpty, kindFromHttpStatus,
} from '../integrations/integration-error';

const SERVICE = INTEGRATION_SERVICES.plaid;
/** Reads run strict (a failure throws IntegrationApiError) unless the kill switch is set. */
const strictRead = () => !integrationErrorSurfaceDisabled();

// Plaid answers most item errors with HTTP 400 — the error_code carries the class.
const PLAID_REAUTH_CODES = new Set([
  'ITEM_LOGIN_REQUIRED', 'INVALID_ACCESS_TOKEN', 'ITEM_NOT_FOUND', 'ACCESS_NOT_GRANTED',
  'ADDITIONAL_CONSENT_REQUIRED', 'ITEM_LOCKED', 'INVALID_CREDENTIALS', 'USER_SETUP_REQUIRED', 'INSUFFICIENT_CREDENTIALS',
]);
const PLAID_DOWN_CODES = new Set([
  'INSTITUTION_DOWN', 'INSTITUTION_NOT_RESPONDING', 'INSTITUTION_NOT_AVAILABLE', 'INTERNAL_SERVER_ERROR', 'PLANNED_MAINTENANCE',
]);
const PLAID_CONFIG_CODES = new Set(['INVALID_API_KEYS', 'UNAUTHORIZED_ENVIRONMENT']);

/** Plaid error_code / error_type / HTTP status → the shared failure kind (pure; exported for tests). */
export function plaidErrorKind(status: number | null, code?: string, type?: string): IntegrationErrorKind {
  if (code && PLAID_REAUTH_CODES.has(code)) return 'auth';
  if (type === 'RATE_LIMIT_EXCEEDED' || code === 'RATE_LIMIT_EXCEEDED' || status === 429) return 'rate_limited';
  if (code && PLAID_DOWN_CODES.has(code)) return 'down';
  if (code && PLAID_CONFIG_CODES.has(code)) return 'not_configured';
  return kindFromHttpStatus(status);
}

interface PlaidCallOpts {
  /** Reads: a failure throws IntegrationApiError instead of returning null. */
  strict?: boolean;
  /** What was attempted, for the failure line ("balance read for Chase"). */
  operation?: string;
}

/** A linked user whose stored Plaid tokens cannot be read — not "not linked". */
async function noTokenLine(userId: string, operation: string): Promise<string> {
  if (!strictRead()) return '';
  const connected = await Promise.resolve().then(() => hasPlaidConnected(userId)).catch(() => false);
  return connected ? new IntegrationApiError(SERVICE, operation, 'no_token', null, '').message : '';
}

/** Failed institutions ride under the ones that answered. */
const failureTail = (failures: string[]) => (failures.length ? `\n\n${failures.join('\n')}` : '');

// Use production by default; sandbox for testing
const PLAID_ENV = process.env.PLAID_ENV || 'production';
const PLAID_BASE_URL = PLAID_ENV === 'sandbox'
  ? 'https://sandbox.plaid.com'
  : PLAID_ENV === 'development'
    ? 'https://development.plaid.com'
    : 'https://production.plaid.com';

// ── Core API call helper ──────────────────────────────────────────────────────

async function callPlaidApi(
  endpoint: string,
  accessToken: string,
  extraParams?: Record<string, any>,
  opts: PlaidCallOpts = {},
): Promise<any | null> {
  const clientId = process.env.PLAID_CLIENT_ID;
  const secret   = process.env.PLAID_SECRET;
  const operation = opts.operation ?? endpoint;

  if (!clientId || !secret) {
    logger.warn(`Plaid MCP: PLAID_CLIENT_ID or PLAID_SECRET not set`);
    if (opts.strict) throw new IntegrationApiError(SERVICE, operation, 'not_configured', null, 'PLAID_CLIENT_ID / PLAID_SECRET unset');
    return null;
  }

  try {
    const response = await axios.post(`${PLAID_BASE_URL}${endpoint}`, {
      client_id: clientId,
      secret,
      access_token: accessToken,
      ...extraParams,
    }, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 15000,
    });
    return response.data;
  } catch (error: any) {
    const errCode = error.response?.data?.error_code;
    const errMsg  = error.response?.data?.error_message || error.message;
    logger.warn(`Plaid MCP ${endpoint} failed (${errCode}): ${errMsg}`);
    if (opts.strict) {
      // No response at all = network (0); a response without a status = unknown (null).
      const status: number | null = typeof error.response?.status === 'number' ? error.response.status : (error.response ? null : 0);
      const kind = plaidErrorKind(status, errCode, error.response?.data?.error_type);
      const detail = errCode
        ? `${errCode}${error.response?.data?.error_message ? ` — ${error.response.data.error_message}` : ''}`
        : status === 0 ? String(error.code || error.message || '')
        : String(errMsg ?? '').replace(/^Request failed with status code \d+$/, ''); // axios' generic text adds nothing to "HTTP n"
      throw new IntegrationApiError(SERVICE, operation, kind, status, detail);
    }
    return null;
  }
}

/** One strict call for an institution: data, or null with the failure line recorded. Non-strict = callPlaidApi as before. */
async function callForInstitution(
  failures: string[],
  endpoint: string,
  accessToken: string,
  extraParams: Record<string, any> | undefined,
  operation: string,
): Promise<any | null> {
  try {
    return await callPlaidApi(endpoint, accessToken, extraParams, { strict: strictRead(), operation });
  } catch (err) {
    if (err instanceof IntegrationApiError) { failures.push(err.message); return null; }
    throw err;
  }
}

// ── Formatting helpers ────────────────────────────────────────────────────────

function formatCurrency(amount: number | undefined | null, code?: string): string {
  if (amount == null) return 'N/A';
  const formatted = Math.abs(amount).toLocaleString('en-US', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
  const prefix = amount < 0 ? '-' : '';
  return code ? `${prefix}${code} ${formatted}` : `${prefix}$${formatted}`;
}

function formatDate(dateStr: string | undefined | null): string {
  if (!dateStr) return 'N/A';
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return dateStr;
  return date.toLocaleDateString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric',
  });
}

// ── Public tool functions ─────────────────────────────────────────────────────

/** Get all linked accounts across all Plaid items for a user. */
export async function getAccounts(userId: string): Promise<string> {
  try {
    const tokens = await getPlaidTokens(userId);
    if (tokens.length === 0) return noTokenLine(userId, 'accounts read');
    const allAccounts: string[] = [];
    const failures: string[] = [];
    for (const token of tokens) {
      const inst = token.institutionName || 'Unknown Bank';
      const data = await callForInstitution(failures, '/accounts/get', token.accessToken, undefined, `accounts read for ${inst}`);
      if (!data?.accounts?.length) continue;
      const lines = data.accounts.map((acc: any) => {
        const parts = [
          `• ${acc.name || 'Unnamed'} (${acc.subtype || acc.type || 'account'})`,
          acc.mask ? `  Account: ****${acc.mask}` : null,
          acc.balances?.current != null
            ? `  Balance: ${formatCurrency(acc.balances.current, acc.balances.iso_currency_code)}`
            : null,
          acc.balances?.available != null
            ? `  Available: ${formatCurrency(acc.balances.available, acc.balances.iso_currency_code)}`
            : null,
        ].filter(Boolean);
        return parts.join('\n');
      });
      allAccounts.push(`${inst}:\n${lines.join('\n\n')}`);
    }
    if (allAccounts.length === 0) return failures.join('\n');
    logger.info(`Plaid MCP: getAccounts for userId=${userId}`);
    return `[Plaid Bank Accounts]\n${allAccounts.join('\n\n')}${failureTail(failures)}`;
  } catch (err) { return surfacedOrEmpty(err); }
}

/** Get balances for all linked accounts. */
export async function getBalances(userId: string): Promise<string> {
  try {
    const tokens = await getPlaidTokens(userId);
    if (tokens.length === 0) return noTokenLine(userId, 'balance read');
    const allBalances: string[] = [];
    const failures: string[] = [];
    for (const token of tokens) {
      const inst = token.institutionName || 'Unknown Bank';
      const data = await callForInstitution(failures, '/accounts/balance/get', token.accessToken, undefined, `balance read for ${inst}`);
      if (!data?.accounts?.length) continue;
      const lines = data.accounts.map((acc: any) => {
        const bal = acc.balances || {};
        return [
          `• ${acc.name || 'Unnamed'} (****${acc.mask || '????'})`,
          `  Current: ${formatCurrency(bal.current, bal.iso_currency_code)}`,
          bal.available != null ? `  Available: ${formatCurrency(bal.available, bal.iso_currency_code)}` : null,
          bal.limit != null ? `  Limit: ${formatCurrency(bal.limit, bal.iso_currency_code)}` : null,
        ].filter(Boolean).join('\n');
      });
      allBalances.push(`${inst}:\n${lines.join('\n\n')}`);
    }
    if (allBalances.length === 0) return failures.join('\n');
    logger.info(`Plaid MCP: getBalances for userId=${userId}`);
    return `[Plaid Account Balances]\n${allBalances.join('\n\n')}${failureTail(failures)}`;
  } catch (err) { return surfacedOrEmpty(err); }
}
/**
 * Get transactions, PAGINATED and count-first (ticket 7ac4b499): never silently
 * truncates. `offset` skips the newest N, `max` caps how many are returned
 * (default 50, hard cap 500; `max: 0` = count-only summary, no rows; a negative
 * or non-finite max falls back to the default). Pages
 * through Plaid's 100-per-request cap server-side, so a single call can return
 * the whole window the caller asked for. `''` only when no institution
 * responded at all (executor maps that to "not connected"); an offset past
 * the end returns an explicit out-of-range line instead.
 */
export async function getTransactions(userId: string, days = 30, max = 50, offset = 0): Promise<string> {
  try {
    const tokens = await getPlaidTokens(userId);
    if (tokens.length === 0) return noTokenLine(userId, 'transactions read');
    // Non-finite args (Number('abc') → NaN) must fall back to defaults, never
    // poison downstream arithmetic: Math.max(0, NaN) is NaN, which would leak
    // into the Plaid request body and the "showing NaN–NaN" header.
    // Clamp to 730d: /transactions/get serves at most 24 months of history, and
    // an absurd days (1e8) would RangeError the startDate Date below into the
    // catch — surfacing as a misleading "not connected" ''.
    const lookback  = Number.isFinite(days)   ? Math.max(1, Math.min(730, Math.floor(days))) : 30;
    // sanitize max BEFORE the count-only test: `max: 0` is count-only, but a
    // negative or non-finite max is a bad argument, not a request for 1 row —
    // fall back to the default (50) instead of Math.max(1, -3) === 1.
    const rawMax = Number.isFinite(max) ? Math.floor(max) : 50;
    const cap = rawMax < 0 ? 50 : rawMax;
    const countOnly = cap === 0;
    const pageSize  = countOnly ? 1 : Math.min(500, Math.max(1, cap));
    const skip      = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;
    // Conservative page size: Plaid documents up to 500 per request, but 100
    // (its own default) keeps each round-trip small while the loop still pages
    // server-side for larger limits.
    const PLAID_PAGE = 100;
    const endDate   = new Date().toISOString().split('T')[0];
    const startDate = new Date(Date.now() - lookback * 86400000).toISOString().split('T')[0];
    const allTx: string[] = [];
    const failures: string[] = [];
    for (const token of tokens) {
      const instName = token.institutionName || 'Unknown Bank';
      const collected: any[] = [];
      let total: number | null = null;
      let cursor = skip;
      // count-only mode still needs one request to learn total_transactions;
      // ask Plaid for 1 row and drop it.
      while (collected.length < pageSize) {
        const want = Math.min(PLAID_PAGE, pageSize - collected.length);
        const data = await callForInstitution(failures, '/transactions/get', token.accessToken, {
          start_date: startDate, end_date: endDate,
          options: { count: want, offset: cursor },
        }, `transactions read for ${instName}`);
        if (!data) break; // API error for this institution — keep what we have (strict: its line rides in `failures`)
        if (total === null && typeof data.total_transactions === 'number') {
          total = data.total_transactions;
        }
        const batch: any[] = Array.isArray(data.transactions) ? data.transactions : [];
        if (batch.length === 0) break; // window exhausted
        collected.push(...batch);
        cursor += batch.length;
        if (batch.length < want) break; // short page = end of window
      }
      if (total === null && collected.length === 0) continue; // no response at all
      const inst = instName;
      // If Plaid never reported total_transactions, the collected length is a
      // FLOOR, not the window total: a full last page would otherwise render
      // "showing 1–180 of 180" — silently asserting the window is exhausted.
      // Render "of ≥N" and advertise a probe offset instead.
      const totalKnown = total !== null;
      const windowTotal = total ?? collected.length;
      const totalLabel = totalKnown ? String(windowTotal) : `${windowTotal}+`;
      if (countOnly) {
        // count-only asks Plaid for 1 row, so collected.length is 0-or-1 and
        // says nothing about the window size — never render it as a floor.
        allTx.push(`${inst} — ${totalKnown ? windowTotal : 'an unknown number of'} transactions in window (${startDate} → ${endDate}). Pass offset/limit to page through them.`);
        continue;
      }
      const from = skip + 1;
      const to   = skip + collected.length;
      if (collected.length === 0) {
        // A genuinely empty window is not a paging error — say so plainly
        // instead of "offset 0 is past the end".
        if (totalKnown && windowTotal === 0) {
          allTx.push(`${inst} — no transactions in window (${startDate} → ${endDate}).`);
          continue;
        }
        const rangeHint = totalKnown ? `Use offset 0–${Math.max(0, windowTotal - 1)}.` : 'The window is empty at this offset.';
        allTx.push(`${inst} — ${totalKnown ? windowTotal : 'an unknown number of'} transactions in window (${startDate} → ${endDate}): offset ${skip} is past the end. ${rangeHint}`);
        continue;
      }
      const lines = collected.map((tx: any) => {
        return [
          `• ${formatDate(tx.date)} — ${tx.name || tx.merchant_name || 'Unknown'}`,
          `  Amount: ${formatCurrency(tx.amount, tx.iso_currency_code)}`,
          tx.category?.length ? `  Category: ${tx.category.join(' > ')}` : null,
          tx.merchant_name && tx.merchant_name !== tx.name ? `  Merchant: ${tx.merchant_name}` : null,
          tx.pending ? `  (Pending)` : null,
        ].filter(Boolean).join('\n');
      });
      const more = (totalKnown ? to < windowTotal : true) ? `; more available: pass offset=${to}` : '';
      allTx.push(`${inst} — ${totalLabel} transactions in window (${startDate} → ${endDate}); showing ${from}–${to} of ${totalLabel} (offset=${skip}, limit=${pageSize})${more}:\n${lines.join('\n\n')}`);
    }
    if (allTx.length === 0) return failures.join('\n');
    logger.info(`Plaid MCP: getTransactions for userId=${userId} (${lookback} days, offset ${skip}, limit ${pageSize})`);
    return `[Plaid Transactions — Last ${lookback} Days]\n${allTx.join('\n\n')}${failureTail(failures)}`;
  } catch (err) { return surfacedOrEmpty(err); }
}

/** Get recurring transactions (subscriptions, regular payments). */
export async function getRecurringTransactions(userId: string): Promise<string> {
  try {
    const tokens = await getPlaidTokens(userId);
    if (tokens.length === 0) return noTokenLine(userId, 'recurring transactions read');
    const allRecurring: string[] = [];
    const failures: string[] = [];
    for (const token of tokens) {
      const inst = token.institutionName || 'Unknown Bank';
      const accountsData = await callForInstitution(failures, '/accounts/get', token.accessToken, undefined, `accounts read for ${inst}`);
      if (!accountsData?.accounts?.length) continue;
      const accountIds = accountsData.accounts.map((a: any) => a.account_id);
      const data = await callForInstitution(failures, '/transactions/recurring/get', token.accessToken, {
        account_ids: accountIds,
      }, `recurring transactions read for ${inst}`);
      if (!data) continue;
      const streams: string[] = [];
      if (data.inflow_streams?.length) {
        const inflowLines = data.inflow_streams.slice(0, 10).map((s: any) =>
          `  + ${s.description || s.merchant_name || 'Unknown'}: ${formatCurrency(s.average_amount?.amount, s.average_amount?.iso_currency_code)} (${s.frequency || 'recurring'})`
        );
        streams.push(`Income:\n${inflowLines.join('\n')}`);
      }
      if (data.outflow_streams?.length) {
        const outflowLines = data.outflow_streams.slice(0, 15).map((s: any) =>
          `  - ${s.description || s.merchant_name || 'Unknown'}: ${formatCurrency(s.average_amount?.amount, s.average_amount?.iso_currency_code)} (${s.frequency || 'recurring'})`
        );
        streams.push(`Expenses/Subscriptions:\n${outflowLines.join('\n')}`);
      }
      if (streams.length > 0) allRecurring.push(`${inst}:\n${streams.join('\n\n')}`);
    }
    if (allRecurring.length === 0) return failures.join('\n');
    logger.info(`Plaid MCP: getRecurringTransactions for userId=${userId}`);
    return `[Plaid Recurring Transactions]\n${allRecurring.join('\n\n')}${failureTail(failures)}`;
  } catch (err) { return surfacedOrEmpty(err); }
}

/** Get account holder identity information. */
export async function getIdentity(userId: string): Promise<string> {
  try {
    const tokens = await getPlaidTokens(userId);
    if (tokens.length === 0) return noTokenLine(userId, 'identity read');
    const allIdentity: string[] = [];
    const failures: string[] = [];
    for (const token of tokens) {
      const inst = token.institutionName || 'Unknown Bank';
      const data = await callForInstitution(failures, '/identity/get', token.accessToken, undefined, `identity read for ${inst}`);
      if (!data?.accounts?.length) continue;
      const lines: string[] = [];
      for (const acc of data.accounts) {
        if (!acc.owners?.length) continue;
        for (const owner of acc.owners) {
          const parts = [
            owner.names?.length ? `  Name: ${owner.names.join(', ')}` : null,
            owner.emails?.length ? `  Email: ${owner.emails.map((e: any) => e.data).join(', ')}` : null,
            owner.phone_numbers?.length ? `  Phone: ${owner.phone_numbers.map((p: any) => p.data).join(', ')}` : null,
          ].filter(Boolean);
          if (parts.length > 0) {
            lines.push(`• ${acc.name || 'Account'} (****${acc.mask || '????'}):\n${parts.join('\n')}`);
          }
        }
      }
      if (lines.length > 0) allIdentity.push(`${inst}:\n${lines.join('\n\n')}`);
    }
    if (allIdentity.length === 0) return failures.join('\n');
    logger.info(`Plaid MCP: getIdentity for userId=${userId}`);
    return `[Plaid Account Identity]\n${allIdentity.join('\n\n')}${failureTail(failures)}`;
  } catch (err) { return surfacedOrEmpty(err); }
}

