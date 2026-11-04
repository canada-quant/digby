/**
 * Xero MCP Client
 *
 * Calls the Xero API directly using the user's OAuth access token.
 * Unlike Google (which uses a separate MCP container), Xero API calls are
 * simple REST requests that can be made directly from the backend.
 *
 * All functions return formatted context strings for injection into the AI
 * system prompt, or empty string on failure (graceful degradation).
 *
 * Xero API base: https://api.xero.com/api.xro/2.0/
 * Auth: Bearer token + xero-tenant-id header
 */

import axios from 'axios';
import logger from '../../../utils/logger';
import { getValidToken, listXeroAccounts, accountMatchesLabel, xeroAccountDisplayName } from './token-manager';
import { integrationErrorText, kindFromHttpStatus, INTEGRATION_SERVICES } from '../integrations/integration-error';

const XERO_API_BASE = 'https://api.xero.com/api.xro/2.0';

/**
 * Thrown when the caller named a Xero account label that doesn't match any of
 * the user's connected accounts (ticket 64a25e8d). The message doubles as the
 * model's discovery surface — it lists the valid labels (Google parity with
 * google-mcp.ts resolveGoogleAccount's label_not_found failure).
 */
class XeroLabelNotFoundError extends Error {
  constructor(query: string, validLabels: string[]) {
    super(
      validLabels.length === 0
        ? 'No Xero accounts connected — connect one in Account → Integrations.'
        : `Xero account "${query}" not found. Connected accounts: ${validLabels.join(', ')}. Pass one of these as the label parameter.`,
    );
    this.name = 'XeroLabelNotFoundError';
  }
}

// ── Core API call helper ──────────────────────────────────────────────────────

/**
 * Resolve the effective account label for a call (ticket 64a25e8d): an
 * explicit label matches — case-insensitively — the bare label, the org name,
 * or the "Label (Org name)" composite; undefined means the deterministic
 * first-connected account (token-manager getValidToken orderBy createdAt asc).
 * Throws XeroLabelNotFoundError when nothing matches.
 */
async function resolveEffectiveLabel(userId: string, label?: string): Promise<string | undefined> {
  if (!label) return undefined;
  const accounts = await listXeroAccounts(userId);
  const match = accounts.find((a: any) => accountMatchesLabel(a, label));
  if (!match) {
    throw new XeroLabelNotFoundError(label, accounts.map(xeroAccountDisplayName));
  }
  return match.label;
}

/** Catch-block helper: label errors are the model's discovery surface — surface them; everything else degrades to ''. */
/**
 * A Xero API failure the MODEL must see (2026-10-04, found by the live query suite's owner run: 19 Xero calls failed
 * in a night and every one reached the model as "No result from Xero — the integration may not be connected … or
 * nothing matched", so it could not tell the user to reconnect). callXeroApi throws this instead of returning null;
 * each tool's catch turns it into one readable line. XERO_ERROR_SURFACE_DISABLED=1 restores the silent null.
 */
export class XeroApiError extends Error {
  constructor(public readonly endpoint: string, public readonly status: number | null, detail: string) {
    super(xeroApiErrorText(endpoint, status, detail));
    this.name = 'XeroApiError';
  }
}

/**
 * The line the model reads for a failed Xero call (pure). The status → text
 * mapping is shared with the other connector clients
 * (integrations/integration-error.ts, 2026-10-04); a null status = no valid token.
 */
export function xeroApiErrorText(endpoint: string, status: number | null, detail: string): string {
  return integrationErrorText(INTEGRATION_SERVICES.xero, endpoint, status === null ? 'no_token' : kindFromHttpStatus(status), status, detail);
}

export function xeroErrorSurfaceDisabled(): boolean {
  return process.env.XERO_ERROR_SURFACE_DISABLED === '1';
}

function labelErrorOrEmpty(err: any): string {
  return err instanceof XeroLabelNotFoundError || err instanceof XeroApiError ? err.message : '';
}

async function callXeroApi(
  userId: string,
  endpoint: string,
  params?: Record<string, string | number>,
  label?: string,
): Promise<any | null> {
  const effectiveLabel = await resolveEffectiveLabel(userId, label);
  const tokenResult = await getValidToken(userId, effectiveLabel);
  if (!tokenResult) {
    logger.warn(`Xero MCP: No valid token for userId=${userId}, skipping ${endpoint}`);
    if (!xeroErrorSurfaceDisabled()) throw new XeroApiError(endpoint, null, '');
    return null;
  }

  try {
    const response = await axios.get(`${XERO_API_BASE}${endpoint}`, {
      headers: {
        'Authorization': `Bearer ${tokenResult.accessToken}`,
        'xero-tenant-id': tokenResult.tenantId,
        'Accept': 'application/json',
      },
      params,
      timeout: 15000,
    });

    return response.data;
  } catch (error: any) {
    const status = error.response?.status;
    const errMsg = error.response?.data?.Message || error.message;
    logger.warn(`Xero MCP ${endpoint} failed (${status}): ${errMsg}`);
    if (!xeroErrorSurfaceDisabled()) throw new XeroApiError(endpoint, typeof status === 'number' ? status : 0, String(errMsg ?? ''));
    return null;
  }
}

// ── Formatting helpers ────────────────────────────────────────────────────────

function formatCurrency(amount: number | undefined | null, code?: string): string {
  if (amount == null) return 'N/A';
  const formatted = amount.toLocaleString('en-US', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
  return code ? `${code} ${formatted}` : `$${formatted}`;
}

function formatDate(dateStr: string | undefined | null): string {
  if (!dateStr) return 'N/A';
  const msMatch = dateStr.match(/\/Date\((\d+)\)\//);
  const date = msMatch ? new Date(parseInt(msMatch[1], 10)) : new Date(dateStr);
  if (isNaN(date.getTime())) return dateStr;
  return date.toLocaleDateString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric',
  });
}

// ── Public tool functions ─────────────────────────────────────────────────────

/** Get organisation info. Pass `label` to read from a specific connected account (default: first-connected). */
export async function getOrganisation(userId: string, label?: string): Promise<string> {
  try {
    const data = await callXeroApi(userId, '/Organisation', undefined, label);
    if (!data?.Organisations?.[0]) return '';
    const org = data.Organisations[0];
    const lines = [
      `Organisation: ${org.Name || 'Unknown'}`,
      org.LegalName ? `Legal Name: ${org.LegalName}` : null,
      org.BaseCurrency ? `Base Currency: ${org.BaseCurrency}` : null,
      org.CountryCode ? `Country: ${org.CountryCode}` : null,
    ].filter(Boolean);
    logger.info(`Xero MCP: getOrganisation for userId=${userId}`);
    return `[Xero Organisation]\n${lines.join('\n')}`;
  } catch (err: any) { return labelErrorOrEmpty(err); }
}

/** List contacts (customers/suppliers). */
export async function getContacts(userId: string, search = '', max = 10, label?: string): Promise<string> {
  try {
    const params: Record<string, string | number> = { page: 1 };
    if (search) params.where = `Name.Contains("${search}")`;
    const data = await callXeroApi(userId, '/Contacts', params, label);
    if (!data?.Contacts?.length) return '';
    const contacts = data.Contacts.slice(0, max);
    const lines = contacts.map((c: any) => {
      const parts = [
        `• ${c.Name || 'Unnamed'}`,
        c.EmailAddress ? `  Email: ${c.EmailAddress}` : null,
        c.ContactStatus ? `  Status: ${c.ContactStatus}` : null,
      ].filter(Boolean);
      return parts.join('\n');
    });
    logger.info(`Xero MCP: getContacts for userId=${userId} (${contacts.length})`);
    return `[Xero Contacts — ${contacts.length}]\n${lines.join('\n\n')}`;
  } catch (err: any) { return labelErrorOrEmpty(err); }
}

/** List invoices (sales). */
export async function getInvoices(userId: string, status?: string, max = 10, label?: string): Promise<string> {
  try {
    const params: Record<string, string | number> = { page: 1, order: 'Date DESC' };
    if (status) params.where = `Status=="${status}"`;
    const data = await callXeroApi(userId, '/Invoices', params, label);
    if (!data?.Invoices?.length) return '';
    const invoices = data.Invoices.slice(0, max);
    const lines = invoices.map((inv: any) => [
      `• Invoice ${inv.InvoiceNumber || inv.InvoiceID?.substring(0, 8)}`,
      `  To: ${inv.Contact?.Name || 'Unknown'}`,
      `  Date: ${formatDate(inv.Date)}  Due: ${formatDate(inv.DueDate)}`,
      `  Status: ${inv.Status}  Total: ${formatCurrency(inv.Total, inv.CurrencyCode)}`,
      inv.AmountDue != null ? `  Due: ${formatCurrency(inv.AmountDue, inv.CurrencyCode)}` : null,
    ].filter(Boolean).join('\n'));
    logger.info(`Xero MCP: getInvoices for userId=${userId} (${invoices.length})`);
    return `[Xero Invoices — ${invoices.length} most recent]\n${lines.join('\n\n')}`;
  } catch (err: any) { return labelErrorOrEmpty(err); }
}

/** List bills (purchases / accounts payable). */
export async function getBills(userId: string, status?: string, max = 10, label?: string): Promise<string> {
  try {
    let where = 'Type=="ACCPAY"';
    if (status) where += ` AND Status=="${status}"`;
    const data = await callXeroApi(userId, '/Invoices', { page: 1, order: 'Date DESC', where }, label);
    if (!data?.Invoices?.length) return '';
    const bills = data.Invoices.slice(0, max);
    const lines = bills.map((b: any) => [
      `• Bill ${b.InvoiceNumber || b.InvoiceID?.substring(0, 8)}`,
      `  From: ${b.Contact?.Name || 'Unknown'}`,
      `  Date: ${formatDate(b.Date)}  Due: ${formatDate(b.DueDate)}`,
      `  Status: ${b.Status}  Total: ${formatCurrency(b.Total, b.CurrencyCode)}`,
    ].filter(Boolean).join('\n'));
    logger.info(`Xero MCP: getBills for userId=${userId} (${bills.length})`);
    return `[Xero Bills — ${bills.length} most recent]\n${lines.join('\n\n')}`;
  } catch (err: any) { return labelErrorOrEmpty(err); }
}

/** Get chart of accounts. */
export async function getAccounts(userId: string, label?: string): Promise<string> {
  try {
    const data = await callXeroApi(userId, '/Accounts', undefined, label);
    if (!data?.Accounts?.length) return '';
    const grouped: Record<string, any[]> = {};
    for (const acc of data.Accounts) {
      const type = acc.Type || 'Other';
      if (!grouped[type]) grouped[type] = [];
      grouped[type].push(acc);
    }
    const sections = Object.entries(grouped).map(([type, accs]) => {
      const items = accs.slice(0, 10).map((a: any) =>
        `  • ${a.Code || '—'} ${a.Name}${a.Status === 'ARCHIVED' ? ' (archived)' : ''}`
      );
      return `${type}:\n${items.join('\n')}`;
    });
    logger.info(`Xero MCP: getAccounts for userId=${userId} (${data.Accounts.length})`);
    return `[Xero Chart of Accounts — ${data.Accounts.length}]\n${sections.join('\n\n')}`;
  } catch (err: any) { return labelErrorOrEmpty(err); }
}

/** Get bank account list. */
export async function getBankSummary(userId: string, label?: string): Promise<string> {
  try {
    const data = await callXeroApi(userId, '/Accounts', { where: 'Type=="BANK"' }, label);
    if (!data?.Accounts?.length) return '';
    const lines = data.Accounts.map((a: any) =>
      `• ${a.Name}${a.CurrencyCode ? ` (${a.CurrencyCode})` : ''} — ${a.Status || 'Active'}`
    );
    logger.info(`Xero MCP: getBankSummary for userId=${userId}`);
    return `[Xero Bank Accounts — ${data.Accounts.length}]\n${lines.join('\n')}`;
  } catch (err: any) { return labelErrorOrEmpty(err); }
}
/** Parse Xero report rows into readable text lines. */
function parseReportRows(rows: any[]): string[] {
  const lines: string[] = [];
  for (const row of rows) {
    if (row.RowType === 'Section' && row.Title) {
      lines.push(`\n${row.Title}:`);
      for (const sub of row.Rows || []) {
        if (sub.Cells) {
          const label = sub.Cells[0]?.Value || '';
          const value = sub.Cells[1]?.Value || '';
          if (label && value) {
            const bold = sub.RowType === 'SummaryRow';
            lines.push(`  ${bold ? '** ' : ''}${label}: ${value}${bold ? ' **' : ''}`);
          }
        }
      }
    }
  }
  return lines;
}

/** Get profit and loss report (YTD). */
export async function getProfitAndLoss(userId: string, label?: string): Promise<string> {
  try {
    const effectiveLabel = await resolveEffectiveLabel(userId, label);
    const tokenResult = await getValidToken(userId, effectiveLabel);
    if (!tokenResult) return '';
    const now = new Date();
    const response = await axios.get(`${XERO_API_BASE}/Reports/ProfitAndLoss`, {
      headers: {
        'Authorization': `Bearer ${tokenResult.accessToken}`,
        'xero-tenant-id': tokenResult.tenantId,
        'Accept': 'application/json',
      },
      params: { fromDate: `${now.getFullYear()}-01-01`, toDate: now.toISOString().split('T')[0] },
      timeout: 15000,
    });
    const report = response.data?.Reports?.[0];
    if (!report?.Rows?.length) return '';
    const lines = parseReportRows(report.Rows);
    logger.info(`Xero MCP: getProfitAndLoss for userId=${userId}`);
    return `[Xero Profit & Loss — YTD]\n${lines.join('\n')}`;
  } catch (error: any) {
    if (error instanceof XeroLabelNotFoundError) return error.message;
    logger.warn(`Xero MCP: getProfitAndLoss failed: ${error.message}`);
    return '';
  }
}

/** Get balance sheet report. */
export async function getBalanceSheet(userId: string, label?: string): Promise<string> {
  try {
    const effectiveLabel = await resolveEffectiveLabel(userId, label);
    const tokenResult = await getValidToken(userId, effectiveLabel);
    if (!tokenResult) return '';
    const response = await axios.get(`${XERO_API_BASE}/Reports/BalanceSheet`, {
      headers: {
        'Authorization': `Bearer ${tokenResult.accessToken}`,
        'xero-tenant-id': tokenResult.tenantId,
        'Accept': 'application/json',
      },
      params: { date: new Date().toISOString().split('T')[0] },
      timeout: 15000,
    });
    const report = response.data?.Reports?.[0];
    if (!report?.Rows?.length) return '';
    const lines = parseReportRows(report.Rows);
    logger.info(`Xero MCP: getBalanceSheet for userId=${userId}`);
    return `[Xero Balance Sheet]\n${lines.join('\n')}`;
  } catch (error: any) {
    if (error instanceof XeroLabelNotFoundError) return error.message;
    logger.warn(`Xero MCP: getBalanceSheet failed: ${error.message}`);
    return '';
  }
}

