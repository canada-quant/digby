/**
 * User-added MCP servers (ticket e294f9a4) — QUICK-START TEMPLATES.
 *
 * A catalog of common REMOTE MCP servers that pre-fills the Add form. Every
 * URL below was confirmed on the vendor's OWN documentation (page in
 * `docsUrl`) on `verifiedAt`; a vendor whose remote endpoint could not be
 * confirmed would carry `url: null` + `urlRequired: true` (the form then asks
 * for it). Auth kinds:
 *   none            — public server, no credential.
 *   optional_bearer — works anonymously (rate-limited / fewer tools); a token
 *                     in `Authorization: Bearer …` lifts the limits.
 *   bearer          — needs a token in `Authorization: Bearer …` (PAT / API key).
 *   header          — needs a token in a vendor header (`headerName`).
 *   oauth           — the vendor documents OAuth sign-in ONLY. v1 has no MCP
 *                     OAuth flow, so the template is shown but marked
 *                     "OAuth sign-in — coming next"; Test answers the honest 401.
 *
 * Filesystem / stdio servers are deliberately absent — Digby connects to
 * REMOTE servers only (a stdio server would run inside the backend).
 * Pure data; the frontend renders whatever GET /mcp-servers/templates serves.
 */

export type McpTemplateAuthKind = 'none' | 'optional_bearer' | 'bearer' | 'header' | 'oauth';

export interface McpServerTemplate {
  id: string;
  name: string;
  description: string;
  /** Confirmed public remote URL; null ⇒ the user must supply it. */
  url: string | null;
  urlRequired: boolean;
  /** Placeholder / hint for the URL field (e.g. optional query params). */
  urlHint?: string;
  transport: 'auto' | 'streamable_http' | 'sse';
  auth: {
    kind: McpTemplateAuthKind;
    /** Header the token goes in (bearer kinds: Authorization). */
    headerName?: string;
    /** What to paste ("GitHub personal access token"). */
    tokenLabel?: string;
    /** Where to create one. */
    tokenHelpUrl?: string;
    /** One honest line about the auth situation. */
    note?: string;
  };
  docsUrl: string;
  verifiedAt: string;
  category: 'dev' | 'docs' | 'productivity' | 'payments' | 'data' | 'automation' | 'search' | 'custom';
}

const VERIFIED = '2026-10-06';

export const MCP_SERVER_TEMPLATES: readonly McpServerTemplate[] = Object.freeze([
  {
    id: 'github', name: 'GitHub', category: 'dev',
    description: 'Repos, issues, pull requests, Actions and code search via GitHub\'s hosted MCP server.',
    url: 'https://api.githubcopilot.com/mcp/', urlRequired: false, transport: 'streamable_http',
    auth: { kind: 'bearer', headerName: 'Authorization', tokenLabel: 'GitHub personal access token', tokenHelpUrl: 'https://github.com/settings/personal-access-tokens', note: 'OAuth is GitHub\'s default; a PAT in Authorization: Bearer is officially supported.' },
    docsUrl: 'https://github.com/github/github-mcp-server', verifiedAt: VERIFIED,
  },
  {
    id: 'linear', name: 'Linear', category: 'productivity',
    description: 'Issues, projects, cycles and comments in Linear.',
    url: 'https://mcp.linear.app/mcp', urlRequired: false, transport: 'streamable_http',
    auth: { kind: 'bearer', headerName: 'Authorization', tokenLabel: 'Linear API key', tokenHelpUrl: 'https://linear.app/settings/account/security', note: 'Linear accepts an API key (read-only restricted keys work too) in Authorization: Bearer.' },
    docsUrl: 'https://linear.app/docs/mcp', verifiedAt: VERIFIED,
  },
  {
    id: 'supabase', name: 'Supabase', category: 'data',
    description: 'Projects, tables, SQL, migrations, edge functions and logs.',
    url: 'https://mcp.supabase.com/mcp', urlRequired: false, transport: 'streamable_http',
    urlHint: 'Optional: append ?project_ref=<ref>&read_only=true to scope it to one project, read-only.',
    auth: { kind: 'bearer', headerName: 'Authorization', tokenLabel: 'Supabase personal access token', tokenHelpUrl: 'https://supabase.com/dashboard/account/tokens' },
    docsUrl: 'https://supabase.com/docs/guides/getting-started/mcp', verifiedAt: VERIFIED,
  },
  {
    id: 'stripe', name: 'Stripe', category: 'payments',
    description: 'Customers, payments, invoices, subscriptions and the Stripe docs.',
    url: 'https://mcp.stripe.com', urlRequired: false, transport: 'streamable_http',
    auth: { kind: 'bearer', headerName: 'Authorization', tokenLabel: 'Stripe restricted / agent API key', tokenHelpUrl: 'https://dashboard.stripe.com/apikeys', note: 'Use a RESTRICTED key. Stripe documents that from 2026-10-31 only Agent-tagged keys are accepted.' },
    docsUrl: 'https://docs.stripe.com/mcp', verifiedAt: VERIFIED,
  },
  {
    id: 'cloudflare', name: 'Cloudflare API', category: 'dev',
    description: 'Cloudflare\'s unified API server (Workers, DNS, R2, KV, …).',
    url: 'https://mcp.cloudflare.com/mcp', urlRequired: false, transport: 'streamable_http',
    auth: { kind: 'bearer', headerName: 'Authorization', tokenLabel: 'Cloudflare API token', tokenHelpUrl: 'https://dash.cloudflare.com/profile/api-tokens' },
    docsUrl: 'https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/', verifiedAt: VERIFIED,
  },
  {
    id: 'cloudflare-docs', name: 'Cloudflare Docs', category: 'docs',
    description: 'Search the Cloudflare developer documentation. Public — no token needed.',
    url: 'https://docs.mcp.cloudflare.com/mcp', urlRequired: false, transport: 'streamable_http',
    auth: { kind: 'none' },
    docsUrl: 'https://github.com/cloudflare/mcp-server-cloudflare', verifiedAt: VERIFIED,
  },
  {
    id: 'neon', name: 'Neon', category: 'data',
    description: 'Neon Postgres projects, branches, SQL and migrations.',
    url: 'https://mcp.neon.tech/mcp', urlRequired: false, transport: 'streamable_http',
    auth: { kind: 'bearer', headerName: 'Authorization', tokenLabel: 'Neon API key', tokenHelpUrl: 'https://console.neon.tech/app/settings/api-keys' },
    docsUrl: 'https://neon.com/docs/ai/neon-mcp-server', verifiedAt: VERIFIED,
  },
  {
    id: 'zapier', name: 'Zapier', category: 'automation',
    description: 'Run the actions you enabled in Zapier MCP across 8,000+ apps.',
    url: 'https://mcp.zapier.com/api/v1/connect', urlRequired: false, transport: 'streamable_http',
    auth: { kind: 'bearer', headerName: 'Authorization', tokenLabel: 'Zapier MCP connection token', tokenHelpUrl: 'https://mcp.zapier.com', note: 'Generate a connection token in Zapier MCP and paste it here.' },
    docsUrl: 'https://docs.zapier.com/mcp/overview/how-connections-work', verifiedAt: VERIFIED,
  },
  {
    id: 'huggingface', name: 'Hugging Face', category: 'data',
    description: 'Search models, datasets, Spaces and papers on the Hub.',
    url: 'https://huggingface.co/mcp', urlRequired: false, transport: 'streamable_http',
    auth: { kind: 'optional_bearer', headerName: 'Authorization', tokenLabel: 'Hugging Face access token (optional)', tokenHelpUrl: 'https://huggingface.co/settings/tokens', note: 'Works anonymously with fewer tools; a token unlocks the rest.' },
    docsUrl: 'https://huggingface.co/docs/hub/hf-mcp-server', verifiedAt: VERIFIED,
  },
  {
    id: 'deepwiki', name: 'DeepWiki', category: 'docs',
    description: 'Ask questions about any public GitHub repository\'s documentation. Public — no token needed.',
    url: 'https://mcp.deepwiki.com/mcp', urlRequired: false, transport: 'streamable_http',
    auth: { kind: 'none' },
    docsUrl: 'https://docs.devin.ai/work-with-devin/deepwiki-mcp', verifiedAt: VERIFIED,
  },
  {
    id: 'context7', name: 'Context7', category: 'docs',
    description: 'Up-to-date library and framework documentation for coding.',
    url: 'https://mcp.context7.com/mcp', urlRequired: false, transport: 'streamable_http',
    auth: { kind: 'optional_bearer', headerName: 'Authorization', tokenLabel: 'Context7 API key (optional)', tokenHelpUrl: 'https://context7.com/dashboard', note: 'Works without a key at a lower rate limit.' },
    docsUrl: 'https://github.com/upstash/context7', verifiedAt: VERIFIED,
  },
  {
    id: 'exa', name: 'Exa', category: 'search',
    description: 'Neural web search, code search and company research.',
    url: 'https://mcp.exa.ai/mcp', urlRequired: false, transport: 'streamable_http',
    auth: { kind: 'header', headerName: 'x-api-key', tokenLabel: 'Exa API key (optional)', tokenHelpUrl: 'https://dashboard.exa.ai/api-keys', note: 'Keyless use works at a free rate limit; the key goes in the x-api-key header.' },
    docsUrl: 'https://exa.ai/docs/reference/exa-mcp', verifiedAt: VERIFIED,
  },
  {
    id: 'paypal', name: 'PayPal', category: 'payments',
    description: 'Invoices, orders, disputes, subscriptions and transactions.',
    url: 'https://mcp.paypal.com/http', urlRequired: false, transport: 'streamable_http',
    urlHint: 'Sandbox: https://mcp.sandbox.paypal.com/http',
    auth: { kind: 'bearer', headerName: 'Authorization', tokenLabel: 'PayPal access token', tokenHelpUrl: 'https://developer.paypal.com/dashboard/applications', note: 'PayPal documents a Bearer credential built from your app\'s client id + secret; OAuth login is the other option.' },
    docsUrl: 'https://developer.paypal.com/tools/mcp-server/', verifiedAt: VERIFIED,
  },
  {
    id: 'atlassian', name: 'Atlassian (Jira & Confluence)', category: 'productivity',
    description: 'Jira issues and Confluence pages via the Rovo MCP server.',
    url: 'https://mcp.atlassian.com/v2/mcp', urlRequired: false, transport: 'streamable_http',
    auth: { kind: 'oauth', headerName: 'Authorization', tokenLabel: 'Basic <base64(email:api_token)> — only if your org admin enabled API-token access', tokenHelpUrl: 'https://id.atlassian.com/manage-profile/security/api-tokens', note: 'OAuth by default. An API token works ONLY when an org admin enabled it: put "Basic <base64(email:token)>" in a custom Authorization header.' },
    docsUrl: 'https://support.atlassian.com/atlassian-rovo-mcp-server/docs/getting-started-with-the-atlassian-remote-mcp-server/', verifiedAt: VERIFIED,
  },
  {
    id: 'notion', name: 'Notion', category: 'productivity',
    description: 'Search, read and write Notion pages and databases.',
    url: 'https://mcp.notion.com/mcp', urlRequired: false, transport: 'streamable_http',
    auth: { kind: 'oauth', note: 'Notion\'s hosted server requires OAuth sign-in (no token option) — coming next in Digby.' },
    docsUrl: 'https://developers.notion.com/docs/get-started-with-mcp', verifiedAt: VERIFIED,
  },
  {
    id: 'sentry', name: 'Sentry', category: 'dev',
    description: 'Issues, events, releases and performance data.',
    url: 'https://mcp.sentry.dev/mcp', urlRequired: false, transport: 'streamable_http',
    urlHint: 'Optional scoping: /mcp/<org-slug> or /mcp/<org-slug>/<project-slug>',
    auth: { kind: 'oauth', note: 'Sentry\'s hosted server uses OAuth only — coming next in Digby.' },
    docsUrl: 'https://mcp.sentry.dev', verifiedAt: VERIFIED,
  },
  {
    id: 'asana', name: 'Asana', category: 'productivity',
    description: 'Tasks, projects and goals (Digby also has a built-in Asana connector above).',
    url: 'https://mcp.asana.com/v2/mcp', urlRequired: false, transport: 'streamable_http',
    auth: { kind: 'oauth', note: 'Asana\'s MCP server needs a pre-registered OAuth app — not supported yet. The built-in Asana connection above already gives Digby your tasks.' },
    docsUrl: 'https://developers.asana.com/docs/using-asanas-mcp-server', verifiedAt: VERIFIED,
  },
  {
    id: 'square', name: 'Square', category: 'payments',
    description: 'Payments, orders, catalog and customers.',
    url: 'https://mcp.squareup.com/mcp', urlRequired: false, transport: 'streamable_http',
    auth: { kind: 'oauth', note: 'Square\'s remote server uses OAuth only — coming next in Digby.' },
    docsUrl: 'https://developer.squareup.com/docs/mcp', verifiedAt: VERIFIED,
  },
  {
    id: 'custom', name: 'Other MCP server', category: 'custom',
    description: 'Any remote MCP server that speaks Streamable HTTP or SSE.',
    url: null, urlRequired: true, transport: 'auto',
    urlHint: 'https://… the server\'s MCP endpoint (usually ends in /mcp, or /sse for older servers)',
    auth: { kind: 'optional_bearer', headerName: 'Authorization', tokenLabel: 'Token (if the server needs one)' },
    docsUrl: 'https://modelcontextprotocol.io/docs/learn/architecture', verifiedAt: VERIFIED,
  },
]);

export function templateById(id: string | null | undefined): McpServerTemplate | null {
  if (!id) return null;
  return MCP_SERVER_TEMPLATES.find((t) => t.id === id) ?? null;
}
