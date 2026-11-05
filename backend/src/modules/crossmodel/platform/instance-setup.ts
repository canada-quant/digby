/**
 * instance-setup — what THIS instance has configured, answered from env NAMES.
 *
 * A self-hosted Digby (docker-compose.selfhost.yml, DIGBY_INSTANCE=selfhost)
 * starts with JWT secrets + one model key and every optional feature dark.
 * Before this leaf nothing told the admin WHICH features were dark or how to
 * light them: the Integrations tab rendered Connect buttons that 500'd, the
 * search tool told the model "No search results found", feeds failed with a
 * transient-looking error, the Mac installer paired against digby.ai. This
 * leaf is the ONE table of "feature X needs env/seat Y" the setup checklist,
 * the Integrations / Feeds tabs and the honest tool-result text all read.
 *
 * Pure on purpose: no prisma / logger / config-env import chain. Everything
 * that needs a DB or a live probe (seat servability from listModelRoles, the
 * Docker probe, the registered-endpoint count) is handed in by the controller
 * as `enrichment`. Values NEVER leave this module — only env NAMES and
 * booleans; the controller strips even the names for non-admin viewers.
 *
 * Production (DIGBY_INSTANCE unset, every token set) reads as all-ready; no
 * production code path branches on this module's answer.
 */

import { instanceKind, isProdInstance } from './instance-targets';

export type SetupState = 'ready' | 'partial' | 'missing' | 'off';
export type SetupGroup = 'instance' | 'models' | 'web' | 'integrations' | 'messaging' | 'media' | 'coding';

export interface SetupFeature {
  key: string;
  label: string;
  group: SetupGroup;
  /** ready = works; partial = works with a gap named in `summary`; missing = not set up; off = optional and not enabled. */
  state: SetupState;
  /** The user-facing action works (Connect / search / send …). Safe for every signed-in viewer. */
  configured: boolean;
  /** Core (chat cannot work without it) vs optional. */
  required: boolean;
  /** One user-safe sentence — no env names, no values. */
  summary: string;
  /** In-app help anchor (/help/self-host#…). */
  help: string;
  /** Integrations only: the OAuth app is registered (false = Connect works by another path, e.g. a pasted token). Viewer-safe. */
  oauth?: boolean;
  // ── Admin-only (the controller strips these for non-admins) ─────────────
  /** Env NAMES that are unset and needed for `ready`. */
  missing?: string[];
  /** Env NAMES that are set (so the admin sees progress). */
  present?: string[];
  /** How to fix, in one or two sentences — env names, compose profile, admin page. */
  hint?: string;
  /** Compose profile the feature's container lives in (`docker compose … --profile <x>`). */
  profile?: string;
  /** The OAuth callback this instance expects — paste it into the provider console. */
  redirectUri?: string;
  /** Extra facts (the seat's unservable reason, the probe result, the webhook command). */
  note?: string;
}

export interface SeatView {
  key: string;
  persona?: string;
  effective?: string;
  servable: boolean;
  unservableReason?: string;
  missingEnvKey?: string;
}

export interface SetupEnrichment {
  /** GET /admin/model-roles rows (listModelRoles) — seat truth for every model call. */
  seats?: SeatView[] | null;
  /** isDockerAvailable() from this process; null = not probed. */
  dockerAvailable?: boolean | null;
  /** Enabled custom model endpoints (admin registry). */
  registeredEndpoints?: number | null;
  /**
   * Telegram getWebhookInfo, probed by the controller on a NON-prod instance
   * only: `registered` = the webhook points at this instance's /telegram/webhook,
   * `url` = what Telegram currently holds (null = none). null = the probe failed
   * (Telegram unreachable); undefined = not probed (production never probes, so
   * its row is byte-identical).
   */
  telegramWebhook?: TelegramWebhookProbe | null;
}

export interface TelegramWebhookProbe {
  registered: boolean;
  url: string | null;
}

/** The webhook URL Telegram must call for THIS instance (what the setWebhook note registers). */
export function telegramWebhookUrl(publicUrl: string | null): string | null {
  return publicUrl ? `${publicUrl}/api/crossmodel/telegram/webhook` : null;
}

export interface InstanceSetup {
  instance: {
    kind: string;
    selfHosted: boolean;
    /** The URL browsers use (SELFHOST_PUBLIC_URL, else the first FRONTEND_URL entry); null when neither is set. */
    publicUrl: string | null;
    cookieSecure: boolean;
    nodeEnv: string;
  };
  summary: {
    ready: number;
    total: number;
    /** Keys of REQUIRED features that are not ready — the "chat will not work" list. */
    missingRequired: string[];
  };
  features: SetupFeature[];
}

export const SELF_HOST_HELP = '/help/self-host';
const H = (anchor: string): string => `${SELF_HOST_HELP}#${anchor}`;
/** Anchors as frontend/content/help/manifest.json slugs them (github-slugger parity). */
export const HELP_ANCHORS = {
  requirements: H('requirements'),
  quickStart: H('quick-start'),
  setup: H('setup-checklist-account--admin--setup'),
  lan: H('lan-access-other-devices-on-your-network'),
  tls: H('tls-with-a-real-domain'),
  models: H('model-providers'),
  decisionGate: H('decision-gate-typed-judgments-optional'),
  webSearch: H('web-search-optional'),
  integrations: H('integrations-google-github-x-slack-asana-xero-discord--optional'),
  selfImprove: H('self-improvement-autonomous-fix-loop--your-copy-only'),
  troubleshooting: H('troubleshooting'),
  cloudLink: H('connecting-this-instance-to-a-cloud-digby-digby-edge-phase-3'),
} as const;

const PROVIDER_KEYS = ['MOONSHOT_API_KEY', 'DEEPSEEK_API_KEY', 'ZAI_API_KEY', 'DASHSCOPE_API_KEY'] as const;

function has(env: NodeJS.ProcessEnv, name: string): boolean {
  return String(env[name] ?? '').trim() !== '';
}
function split(env: NodeJS.ProcessEnv, names: readonly string[]): { present: string[]; missing: string[] } {
  const present: string[] = [];
  const missing: string[] = [];
  for (const n of names) (has(env, n) ? present : missing).push(n);
  return { present, missing };
}

/** The URL browsers use for this instance — the same derivation every absolute-URL builder should share. */
export function instancePublicUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const own = String(env.SELFHOST_PUBLIC_URL ?? '').trim();
  const front = String(env.FRONTEND_URL ?? '').split(',')[0].trim();
  const raw = own || front;
  if (!raw) return null;
  return raw.replace(/\/+$/, '');
}

/** The OAuth callback URL this instance expects for a provider. */
export function oauthRedirectUri(provider: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const base = instancePublicUrl(env);
  return base ? `${base}/api/crossmodel/${provider}/callback` : null;
}

export type WebSearchMode = 'direct' | 'store' | 'gateway' | 'none';
export interface WebSearchStatus {
  configured: boolean;
  mode: WebSearchMode;
  /** Set when a token exists but cannot work as configured (self-host token aimed at the production gateway). */
  problem?: string;
}

/**
 * Is live web search configured on this instance? Direct BrightData REST
 * (BRIGHTDATA_API_TOKEN) or the MCP gateway (MCP_DIGBY_TOKEN + MCP_DIGBY_URL).
 * A gateway token with NO MCP_DIGBY_URL is only valid on production (the
 * default URL is the production gateway, which a self-host's token cannot
 * authorize) — on any other instance that reads as a problem, not as ready.
 */
/**
 * The admin-store Bright Data key (ticket 6f4d42f2: Admin → Settings → Web
 * search, encrypted, env-free). This leaf cannot read the store, so the
 * resolver (platform/search-provider-config.ts) NOTES its last answer here on
 * every resolution and the boot primer keeps it fresh (30 s) in every process;
 * null = never resolved in this process (env decides alone).
 */
let _storeArmed: boolean | null = null;
export function noteWebSearchStoreArmed(armed: boolean | null): void { _storeArmed = armed; }
export function webSearchStoreArmed(): boolean | null { return _storeArmed; }

export function webSearchStatus(env: NodeJS.ProcessEnv = process.env): WebSearchStatus {
  if (has(env, 'BRIGHTDATA_API_TOKEN')) return { configured: true, mode: 'direct' };
  // The LIVE env only (a test fixture never sees the process-wide store note).
  if (env === process.env && _storeArmed === true) return { configured: true, mode: 'store' };
  if (has(env, 'MCP_DIGBY_TOKEN')) {
    if (isProdInstance(env)) return { configured: true, mode: 'gateway' };
    if (!has(env, 'MCP_DIGBY_URL')) {
      return {
        configured: false,
        mode: 'gateway',
        problem: 'MCP_DIGBY_TOKEN is set but MCP_DIGBY_URL is not, so the gateway tier is OFF on this instance (set MCP_DIGBY_URL=http://brightdata-mcp:8000/mcp for the --profile mcp gateway)',
      };
    }
    // The gateway URL must be the gateway's /mcp endpoint — a bare host or a
    // pasted health URL would "configure" search that can never answer.
    const raw = String(env.MCP_DIGBY_URL).trim();
    let shapeOk = false;
    try { const u = new URL(raw); shapeOk = /^https?:$/.test(u.protocol) && /\/mcp\/?$/.test(u.pathname); } catch { shapeOk = false; }
    if (!shapeOk) {
      return {
        configured: false,
        mode: 'gateway',
        problem: `MCP_DIGBY_URL must be the MCP gateway's /mcp endpoint (http://brightdata-mcp:8000/mcp), got ${raw}`,
      };
    }
    // The local gateway is a front for a BrightData account: the brightdata-mcp
    // container reads BRIGHTDATA_API_TOKEN from the same .env and answers every
    // search empty without it (production's gateway box holds its own token).
    return {
      configured: false,
      mode: 'gateway',
      problem: 'the MCP gateway is set (MCP_DIGBY_URL + MCP_DIGBY_TOKEN) but BRIGHTDATA_API_TOKEN is not — the brightdata-mcp container needs it, so every search would come back empty; set BRIGHTDATA_API_TOKEN (the direct API then serves search, gateway or not)',
    };
  }
  return { configured: false, mode: 'none' };
}

/**
 * The tool result a model gets when it calls a web tool on an instance with
 * no search backend. Honest and terminal for the turn: the model must not
 * retry, must not pretend it searched, and must tell the user why live data
 * is missing. (The production path never reaches this text — every prod
 * process has the gateway token.)
 */
export const WEB_SEARCH_UNCONFIGURED_MSG =
  'Web search is NOT configured on this Digby instance (no search backend: no Bright Data key in Admin → Settings → Web search, no BRIGHTDATA_API_TOKEN, and no MCP gateway token + URL). ' +
  'No web tool can run until an admin sets one up (Account → Admin → Settings → Web search, or Account → Admin → Setup). Do NOT retry a web tool this turn and do NOT say you searched. ' +
  'Answer from your own knowledge and the conversation, flag anything time-sensitive as unverified, and tell the user plainly that live web search is not set up on this instance.';

/**
 * True on a NON-production instance that has no search backend — the predicate
 * every PRE-EMPTIVE honesty branch keys on (refusing a feed, skipping the news
 * tick, the identity note, the status-block wording). Production is never
 * "missing" by definition (DIGBY_INSTANCE unset ⇒ prod ⇒ false), so no prod
 * path and no prod-kind test can take these branches; the RESULT-null branches
 * (a tool answered null) use `webSearchStatus().configured` directly instead.
 */
export function webSearchMissingOnInstance(env: NodeJS.ProcessEnv = process.env): boolean {
  return !isProdInstance(env) && !webSearchStatus(env).configured;
}

/**
 * First-admin bootstrap for a NON-production instance: the address named by
 * SELFHOST_ADMIN_EMAIL becomes ADMIN when it registers or next signs in (the
 * docs used to offer only a psql UPDATE). Never on production (role changes
 * there go through Account → Admin → Users), never with the var unset.
 */
export function selfhostAdminEmailFor(email: string | null | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  if (isProdInstance(env)) return false;
  const want = String(env.SELFHOST_ADMIN_EMAIL ?? '').trim().toLowerCase();
  return !!want && want === String(email ?? '').trim().toLowerCase();
}

/** The hostname users know this instance by ("digby.cql.ca"), for copy that used to say "digby.ai". */
export function instanceSiteLabel(env: NodeJS.ProcessEnv = process.env): string {
  const url = instancePublicUrl(env);
  if (!url) return 'digby.ai';
  try { return new URL(url).host || 'digby.ai'; } catch { return 'digby.ai'; }
}

/** Appended to the system context on an instance with no search backend (after the platform identity, which promises web search). */
export const WEB_SEARCH_UNCONFIGURED_IDENTITY_NOTE = `[THIS INSTANCE — NO LIVE WEB SEARCH]
This self-hosted Digby instance has NO web search or page-reading backend configured (an admin has not set one up yet). This overrides every line above that says web search is always available: search_engine, scrape_as_markdown, scrape_batch, web_pipe and the cloud browser reader cannot run here. Do not call them and never narrate a search. Answer from your own knowledge, the conversation, the user's files and connected integrations; when a question needs current facts, say in one sentence that live web search is not set up on this instance (an admin enables it under Account → Admin → Setup). News digests and URL ingestion are unavailable for the same reason.
[/THIS INSTANCE — NO LIVE WEB SEARCH]`;

/** web_pipe's zero-source note on an instance with no search backend (keeps the "found no sources" + "gateway" words its callers key on). */
export const WEB_PIPE_UNCONFIGURED_NOTE = 'web_pipe found no sources: web search is NOT configured on this Digby instance (no BRIGHTDATA_API_TOKEN and no MCP gateway token + URL) — nothing was searched or fetched. Do not retry web tools this turn; answer from your knowledge or the user\'s files and say live web data is unavailable on this instance. An admin enables it in Account → Admin → Settings → Web search (or Account → Admin → Setup).';

/** Integration keys (google / github / x / xero / slack / asana / plaid / discord) whose Connect path cannot work on this NON-prod instance. */
export function integrationsMissingOnInstance(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const out = new Set<string>();
  if (isProdInstance(env)) return out;
  for (const rule of INTEGRATION_RULES) {
    const f = integrationFeature(rule, env, true);
    if (!f.configured) out.add(rule.key);
  }
  if (!has(env, 'TELEGRAM_BOT_TOKEN') || !has(env, 'TELEGRAM_BOT_USERNAME')) out.add('telegram'); // the connect link is minted from the username
  return out;
}

interface SeatRule {
  seat: string;
  key: string;
  label: string;
  group: SetupGroup;
  required: boolean;
  help: string;
  /** What the gap costs, in user words (used for partial/missing summaries). */
  gap: string;
  /** Optional capability: unservable reads as `off`, not `missing`. */
  optional?: boolean;
}

const SEAT_RULES: SeatRule[] = [
  { seat: 'chat_orchestrator', key: 'lead_seat', label: 'Digby (lead model)', group: 'models', required: true, help: HELP_ANCHORS.models, gap: 'Chat cannot answer: the lead seat has no servable model.' },
  { seat: 'double_checker', key: 'double_checker', label: 'Double Checker', group: 'models', required: false, help: HELP_ANCHORS.models, gap: 'Ensemble answers run on the lead alone; the cross-check is skipped with a note.' },
  { seat: 'triple_checker', key: 'triple_checker', label: 'Triple Checker (research council)', group: 'models', required: false, help: HELP_ANCHORS.models, gap: 'Deep Research councils run short one colleague.' },
  { seat: 'utility', key: 'utility', label: 'Utility (titles, follow-ups, memory)', group: 'models', required: false, help: HELP_ANCHORS.models, gap: 'Chat titles, follow-up chips and memory extraction are skipped.' },
  { seat: 'embeddings', key: 'embeddings', label: 'Embeddings (Files, knowledge, memory search)', group: 'models', required: false, help: HELP_ANCHORS.models, gap: 'Uploads cannot be indexed and memory search has no vectors.' },
  { seat: 'rerank', key: 'rerank', label: 'Reranker', group: 'models', required: false, help: HELP_ANCHORS.models, gap: 'Retrieval falls back to the fused keyword + vector order.' },
  { seat: 'coding_default', key: 'coding_model', label: 'Coding model', group: 'coding', required: false, help: HELP_ANCHORS.models, gap: 'Coding sessions have no servable model.' },
  { seat: 'coding_helper', key: 'helper_seat', label: 'The Helper (digests, verifier)', group: 'coding', required: false, help: HELP_ANCHORS.models, gap: 'Web / YouTube digests and helper workers fall back to the lead model.' },
  { seat: 'decision', key: 'decision_gate', label: 'Decision gate', group: 'models', required: false, optional: true, help: HELP_ANCHORS.decisionGate, gap: 'Every harness judgment runs its pre-gate behaviour (nothing is removed).' },
  { seat: 'vision_describe', key: 'vision', label: 'Image reader', group: 'media', required: false, help: HELP_ANCHORS.models, gap: 'Image attachments are described for text-only models only when this seat is servable; otherwise they are dropped with a notice.' },
  { seat: 'pdf_ocr', key: 'pdf_ocr', label: 'PDF reader (OCR)', group: 'media', required: false, help: HELP_ANCHORS.models, gap: 'Scanned PDFs fall back to plain text extraction.' },
  { seat: 'asr', key: 'stt', label: 'Speech-to-text', group: 'media', required: false, help: HELP_ANCHORS.models, gap: 'Voice notes and caption-less YouTube videos cannot be transcribed.' },
  { seat: 'tts', key: 'tts', label: 'Text-to-speech', group: 'media', required: false, help: HELP_ANCHORS.models, gap: 'Read-aloud is unavailable.' },
  { seat: 'image_generate', key: 'image_generate', label: 'Image generator', group: 'media', required: false, help: HELP_ANCHORS.models, gap: 'The generate_image tool reports itself unavailable.' },
  { seat: 'computer_vision', key: 'computer_vision', label: 'Computer-use vision', group: 'media', required: false, optional: true, help: HELP_ANCHORS.models, gap: 'Computer use on a paired Mac is unavailable.' },
  { seat: 'browser_agent', key: 'browser_agent', label: 'Browser agent', group: 'web', required: false, help: HELP_ANCHORS.models, gap: 'browser_task cannot run its sub-session.' },
  { seat: 'kids', key: 'kids', label: 'Digby Kids', group: 'models', required: false, optional: true, help: HELP_ANCHORS.models, gap: 'Child sub-accounts cannot chat.' },
];

function seatFeature(rule: SeatRule, seats: SeatView[]): SetupFeature | null {
  const seat = seats.find(s => s.key === rule.seat);
  if (!seat) return null;
  const servable = !!seat.servable;
  const state: SetupState = servable ? 'ready' : rule.optional ? 'off' : rule.required ? 'missing' : 'partial';
  const missing = seat.missingEnvKey ? [seat.missingEnvKey] : [];
  return {
    key: rule.key,
    label: rule.label,
    group: rule.group,
    state,
    configured: servable,
    required: rule.required,
    summary: servable ? `Ready${seat.effective ? ` (${seat.effective})` : ''}.` : rule.gap,
    help: rule.help,
    missing,
    present: [],
    hint: servable
      ? undefined
      : `Assign a servable model to the "${seat.persona || rule.label}" seat (Account → Admin → Endpoints → Model roles)${seat.missingEnvKey ? `, or add ${seat.missingEnvKey} to .env and restart` : ''}.`,
    note: seat.unservableReason,
  };
}

interface IntegrationRule {
  key: string;
  label: string;
  /** Env needed before Connect works (OAuth app + the token-encryption key). */
  connect: readonly string[];
  /** Alternative connect path (GitHub: a pasted personal access token only needs the encryption key). */
  altConnect?: { names: readonly string[]; label: string };
  /** Env the READ path needs (the MCP container's shared secret). */
  reads?: readonly string[];
  /** OAuth provider path segment for the callback (none = no OAuth redirect). */
  oauthPath?: string;
  /** The env var that overrides the callback. */
  redirectEnv?: string;
  profile?: string;
  console: string;
}

const INTEGRATION_RULES: IntegrationRule[] = [
  { key: 'google', label: 'Google Workspace', connect: ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET', 'GOOGLE_TOKEN_ENCRYPTION_KEY'], reads: ['GOOGLE_MCP_API_KEY'], oauthPath: 'google', redirectEnv: 'GOOGLE_OAUTH_REDIRECT_URI', profile: 'mcp', console: 'Google Cloud Console → APIs & Services → Credentials (OAuth client, Web application)' },
  { key: 'github', label: 'GitHub', connect: ['GITHUB_OAUTH_CLIENT_ID', 'GITHUB_OAUTH_CLIENT_SECRET', 'GITHUB_TOKEN_ENCRYPTION_KEY'], altConnect: { names: ['GITHUB_TOKEN_ENCRYPTION_KEY'], label: 'paste a personal access token' }, reads: ['GITHUB_MCP_API_KEY'], oauthPath: 'github', redirectEnv: 'GITHUB_OAUTH_REDIRECT_URI', profile: 'mcp', console: 'GitHub → Settings → Developer settings → OAuth Apps' },
  { key: 'x', label: 'X.com', connect: ['X_OAUTH_CLIENT_ID', 'X_OAUTH_CLIENT_SECRET', 'X_TOKEN_ENCRYPTION_KEY'], reads: ['X_MCP_API_KEY'], oauthPath: 'x', redirectEnv: 'X_OAUTH_REDIRECT_URI', profile: 'mcp', console: 'X Developer Portal → your app → User authentication settings (OAuth 2.0, PKCE)' },
  // Xero + Plaid encrypt their tokens with the GOOGLE key (xero/token-manager.ts, plaid/token-manager.ts import google/crypto).
  { key: 'xero', label: 'Xero Accounting', connect: ['XERO_CLIENT_ID', 'XERO_CLIENT_SECRET', 'GOOGLE_TOKEN_ENCRYPTION_KEY'], oauthPath: 'xero', redirectEnv: 'XERO_OAUTH_REDIRECT_URI', console: 'developer.xero.com → My Apps' },
  { key: 'slack', label: 'Slack', connect: ['SLACK_CLIENT_ID', 'SLACK_CLIENT_SECRET', 'SLACK_TOKEN_ENCRYPTION_KEY'], reads: ['SLACK_MCP_API_KEY'], oauthPath: 'slack', redirectEnv: 'SLACK_OAUTH_REDIRECT_URI', profile: 'mcp', console: 'api.slack.com/apps → your app → OAuth & Permissions (user token scopes)' },
  { key: 'asana', label: 'Asana', connect: ['ASANA_CLIENT_ID', 'ASANA_CLIENT_SECRET', 'ASANA_TOKEN_ENCRYPTION_KEY'], reads: ['ASANA_MCP_API_KEY'], oauthPath: 'asana', redirectEnv: 'ASANA_OAUTH_REDIRECT_URI', profile: 'mcp', console: 'app.asana.com/0/my-apps → Developer console' },
  { key: 'plaid', label: 'Plaid Banking', connect: ['PLAID_CLIENT_ID', 'PLAID_SECRET', 'GOOGLE_TOKEN_ENCRYPTION_KEY'], console: 'dashboard.plaid.com → Team settings → Keys (PLAID_ENV picks sandbox / development / production)' },
  { key: 'discord', label: 'Discord', connect: ['DISCORD_MCP_API_KEY'], profile: 'mcp', console: 'discord.com/developers/applications → Bot → Reset Token (the bot token goes ONLY into the discord-mcp container as DISCORD_BOT_TOKEN)' },
];

function integrationFeature(rule: IntegrationRule, env: NodeJS.ProcessEnv, selfHosted: boolean): SetupFeature {
  const connect = split(env, rule.connect);
  const alt = rule.altConnect ? split(env, rule.altConnect.names) : null;
  const reads = rule.reads ? split(env, rule.reads) : { present: [], missing: [] };
  const oauthReady = connect.missing.length === 0;
  const altReady = !!alt && alt.missing.length === 0;
  const canConnect = oauthReady || altReady;
  const readsReady = reads.missing.length === 0;
  const redirectOverride = rule.redirectEnv ? String(env[rule.redirectEnv] ?? '').trim() : '';
  const redirectUri = rule.oauthPath ? (redirectOverride || oauthRedirectUri(rule.oauthPath, env) || undefined) : undefined;

  let state: SetupState;
  let summary: string;
  if (canConnect && readsReady) {
    state = oauthReady ? 'ready' : 'partial';
    summary = oauthReady ? 'Ready.' : `Connect works by ${rule.altConnect!.label}; no OAuth app is registered.`;
  } else if (canConnect) {
    state = 'partial';
    summary = `Accounts can connect${oauthReady ? '' : ` by ${rule.altConnect!.label}`}, but Digby cannot read them yet (the ${rule.label} MCP container is not set up on this instance).`;
  } else {
    state = 'missing';
    summary = 'Not set up on this instance.';
  }
  const present = [...connect.present, ...reads.present];
  const missing = [...connect.missing, ...(canConnect ? reads.missing : [...reads.missing])];
  const hintParts: string[] = [];
  if (!canConnect) {
    hintParts.push(`Create the app at ${rule.console}, then set ${connect.missing.join(', ')} in .env${rule.altConnect ? ` (or just ${rule.altConnect.names.join(', ')} to ${rule.altConnect.label})` : ''}.`);
  }
  if (rule.oauthPath && redirectUri) hintParts.push(`Callback URL to register: ${redirectUri}${redirectOverride ? '' : rule.redirectEnv ? ` (derived from this instance's public URL; override with ${rule.redirectEnv})` : ''}.`);
  if (!readsReady) hintParts.push(`For reads, set ${reads.missing.join(', ')} (any strong random string, shared with the container) and start the stack with --profile ${rule.profile}.`);
  if (rule.key === 'discord' && !canConnect) hintParts.push('Set DISCORD_MCP_URL=http://discord-mcp:8000/mcp (the compose default).');
  const noteParts: string[] = [];
  if (selfHosted && rule.oauthPath && !redirectOverride && !instancePublicUrl(env)) noteParts.push('No public URL is set, so the OAuth callback cannot be derived — set SELFHOST_PUBLIC_URL.');
  return {
    key: rule.key,
    label: rule.label,
    group: 'integrations',
    state,
    configured: canConnect,
    required: false,
    summary,
    help: HELP_ANCHORS.integrations,
    ...(rule.oauthPath ? { oauth: oauthReady } : {}),
    missing,
    present,
    hint: hintParts.length ? hintParts.join(' ') : undefined,
    profile: rule.profile,
    redirectUri,
    note: noteParts.length ? noteParts.join(' ') : undefined,
  };
}

/** Build the full checklist. `env` defaults to process.env; `enrichment` is what the controller could probe. */
export function computeInstanceSetup(env: NodeJS.ProcessEnv = process.env, enrichment: SetupEnrichment = {}): InstanceSetup {
  const kind = instanceKind(env);
  const selfHosted = !isProdInstance(env);
  const publicUrl = instancePublicUrl(env);
  const nodeEnv = String(env.NODE_ENV ?? 'development');
  const cookieSecure = env.COOKIE_SECURE === 'true' ? true : env.COOKIE_SECURE === 'false' ? false : nodeEnv === 'production';
  const features: SetupFeature[] = [];

  // ── Instance ────────────────────────────────────────────────────────────
  features.push({
    key: 'public_url',
    label: 'Public URL',
    group: 'instance',
    state: publicUrl ? 'ready' : 'missing',
    configured: !!publicUrl,
    required: true,
    summary: publicUrl ? `This instance is reached at ${publicUrl}.` : 'No public URL is set, so OAuth callbacks, share links, the Telegram webhook and the Mac agent cannot be derived.',
    help: HELP_ANCHORS.lan,
    missing: publicUrl ? [] : ['SELFHOST_PUBLIC_URL'],
    present: publicUrl ? [has(env, 'SELFHOST_PUBLIC_URL') ? 'SELFHOST_PUBLIC_URL' : 'FRONTEND_URL'] : [],
    hint: publicUrl ? undefined : 'Set SELFHOST_PUBLIC_URL in .env to the URL browsers use (http://<lan-ip>:8080 or https://your.domain), then rebuild (the frontend bakes it in).',
  });

  const isHttps = !!publicUrl && /^https:/i.test(publicUrl);
  const cookieMismatch = !!publicUrl && isHttps !== cookieSecure;
  features.push({
    key: 'cookies_tls',
    label: 'Cookies & TLS',
    group: 'instance',
    state: cookieMismatch ? 'partial' : 'ready',
    configured: !cookieMismatch,
    required: true,
    summary: cookieMismatch
      ? (isHttps ? 'The public URL is https but cookies are not marked Secure.' : 'The public URL is plain http but cookies are marked Secure, so logins will not stick.')
      : (isHttps ? 'TLS with Secure cookies.' : 'Plain http with non-Secure cookies (fine on a LAN; use TLS on the internet).'),
    help: HELP_ANCHORS.tls,
    missing: [],
    present: has(env, 'COOKIE_SECURE') ? ['COOKIE_SECURE'] : [],
    hint: cookieMismatch ? (isHttps ? 'Set COOKIE_SECURE=true in .env and restart.' : 'Set COOKIE_SECURE=false in .env until TLS is enabled (see TLS with a real domain).') : undefined,
  });

  if (selfHosted) {
    const capiOn = has(env, 'META_CAPI_ACCESS_TOKEN') && env.META_CAPI_DISABLED !== '1';
    features.push({
      key: 'analytics_isolation',
      label: 'Analytics isolation',
      group: 'instance',
      state: capiOn ? 'partial' : 'ready',
      configured: !capiOn,
      required: false,
      summary: capiOn ? 'This instance would report signup events to a Meta ad account.' : 'No server-side ad reporting leaves this instance.',
      help: HELP_ANCHORS.quickStart,
      missing: [],
      present: capiOn ? ['META_CAPI_ACCESS_TOKEN'] : [],
      hint: capiOn ? 'Unset META_CAPI_ACCESS_TOKEN or set META_CAPI_DISABLED=1. The browser tags are build-time flags (NEXT_PUBLIC_GOOGLE_ADS_TAG_DISABLED / NEXT_PUBLIC_META_PIXEL_DISABLED), off by default in the self-host compose.' : undefined,
    });
  }

  if (selfHosted) {
    const adminEmail = has(env, 'SELFHOST_ADMIN_EMAIL');
    features.push({
      key: 'admin_bootstrap',
      label: 'First administrator',
      group: 'instance',
      state: adminEmail ? 'ready' : 'off',
      configured: adminEmail,
      required: false,
      summary: adminEmail
        ? 'The address in SELFHOST_ADMIN_EMAIL becomes an administrator when it registers or next signs in.'
        : 'No bootstrap address is set: the first registered user is a normal user until promoted.',
      help: HELP_ANCHORS.setup,
      missing: adminEmail ? [] : ['SELFHOST_ADMIN_EMAIL'],
      present: adminEmail ? ['SELFHOST_ADMIN_EMAIL'] : [],
      hint: adminEmail ? undefined : 'Set SELFHOST_ADMIN_EMAIL=you@example.com in .env and restart; that account is promoted at its next sign-in. Existing admins can also promote users under Account → Admin → Users.',
    });
  }

  const cloudOff = env.CLOUD_LINK_DISABLED === '1';
  features.push({
    key: 'cloud_link',
    label: 'Cloud link (Digby Edge)',
    group: 'instance',
    state: cloudOff ? 'off' : 'ready',
    configured: !cloudOff,
    required: false,
    summary: cloudOff ? 'The tunnel client is disabled on this instance.' : 'This instance can pair to a cloud Digby from Admin → Cloud link.',
    help: HELP_ANCHORS.cloudLink,
    missing: [],
    present: cloudOff ? ['CLOUD_LINK_DISABLED'] : [],
    hint: cloudOff ? 'Remove CLOUD_LINK_DISABLED=1 to allow pairing.' : undefined,
  });

  if (selfHosted) {
    const repos = split(env, ['SELF_REPO', 'GITHUB_REPO_SLUG', 'INFRA_WATCH_REPO']);
    const any = repos.present.length > 0;
    features.push({
      key: 'self_improve',
      label: 'Self-improvement loop (your fork)',
      group: 'instance',
      state: any ? (repos.missing.length ? 'partial' : 'ready') : 'off',
      configured: any,
      required: false,
      summary: any ? (repos.missing.length ? 'Some loop targets are set; the rest report nothing.' : 'The loop targets your own repository.') : 'Not enabled: the fix → PR → merge → rebuild loop reports nothing about any repository.',
      help: HELP_ANCHORS.selfImprove,
      missing: repos.missing,
      present: repos.present,
      hint: repos.missing.length ? `Point ${repos.missing.join(', ')} at YOUR fork (owner/name). The production repository is refused by the isolation boundary.` : undefined,
    });
  }

  // ── Models ──────────────────────────────────────────────────────────────
  const providers = split(env, PROVIDER_KEYS);
  const endpoints = enrichment.registeredEndpoints ?? null;
  const anyProvider = providers.present.length > 0 || (endpoints !== null && endpoints > 0);
  features.push({
    key: 'model_providers',
    label: 'Model providers',
    group: 'models',
    state: anyProvider ? 'ready' : 'missing',
    configured: anyProvider,
    required: true,
    summary: anyProvider
      ? `${providers.present.length} provider key${providers.present.length === 1 ? '' : 's'} set${endpoints ? ` and ${endpoints} custom endpoint${endpoints === 1 ? '' : 's'} registered` : ''}.`
      : 'No model provider is configured, so chat has nothing to call.',
    help: HELP_ANCHORS.models,
    missing: anyProvider ? [] : [...PROVIDER_KEYS],
    present: providers.present,
    hint: anyProvider ? undefined : 'Set at least one of DEEPSEEK_API_KEY / MOONSHOT_API_KEY / ZAI_API_KEY / DASHSCOPE_API_KEY in .env, or register your own OpenAI-compatible endpoint (Account → Admin → Endpoints) and assign it to the Digby seat under Model roles.',
    note: 'Seats below show which model calls are servable right now.',
  });

  const seats = enrichment.seats ?? null;
  if (seats) {
    for (const rule of SEAT_RULES) {
      const f = seatFeature(rule, seats);
      if (f) features.push(f);
    }
  }

  // ── Web ─────────────────────────────────────────────────────────────────
  const ws = webSearchStatus(env);
  const wsPresent = split(env, ['BRIGHTDATA_API_TOKEN', 'MCP_DIGBY_TOKEN', 'MCP_DIGBY_URL']).present;
  features.push({
    key: 'web_search',
    label: 'Web search',
    group: 'web',
    state: ws.configured ? 'ready' : ws.problem ? 'partial' : 'missing',
    configured: ws.configured,
    required: false,
    summary: ws.configured
      ? (ws.mode === 'direct' ? 'Live search and page reading via the BrightData API.' : ws.mode === 'store' ? 'Live search and page reading via the Bright Data key saved in Admin → Settings → Web search.' : 'Live search and page reading via the MCP gateway.')
      : ws.problem
        ? 'A gateway token is set but aimed at the wrong gateway, so searches fail.'
        : 'Not set up on this instance: Digby answers from its own knowledge and says so; web digests cannot run.',
    help: HELP_ANCHORS.webSearch,
    missing: ws.configured ? [] : ws.problem ? ['MCP_DIGBY_URL'] : ['BRIGHTDATA_API_TOKEN'],
    present: wsPresent,
    hint: ws.configured
      ? undefined
      : ws.problem
        ? `${ws.problem}. Set MCP_DIGBY_URL=http://brightdata-mcp:8000/mcp and run the stack with --profile mcp, or set BRIGHTDATA_API_TOKEN for the direct API.`
        : 'Easiest: paste a Bright Data API key (brightdata.com, Web Unlocker zone) under Account → Admin → Settings → Web search — stored encrypted, live within 30 s, no restart. Or set BRIGHTDATA_API_TOKEN in .env (takes precedence). The MCP gateway (--profile mcp, MCP_DIGBY_URL=http://brightdata-mcp:8000/mcp + an MCP_DIGBY_TOKEN you invent) is optional and needs the env key.',
    profile: ws.configured && ws.mode === 'gateway' ? 'mcp' : undefined,
  });
  // (The 'feeds' feature card was retired with the topic-feeds subsystem,
  //  ticket 43c24152, 2026-10-20 — web search itself is the card above.)
  const browserOn = env.BROWSER_SERVICE_ENABLED === '1';
  const browserSecret = has(env, 'BROWSER_SERVICE_SECRET');
  features.push({
    key: 'browser_service',
    label: 'Hosted browser (browser_task)',
    group: 'web',
    state: browserOn && browserSecret ? 'ready' : browserOn ? 'partial' : 'off',
    configured: browserOn && browserSecret,
    required: false,
    summary: browserOn && browserSecret
      ? 'browser_task runs in a hosted hardened Chromium.'
      : browserOn
        ? 'Enabled without a shared secret, so the backend cannot reach it.'
        : 'Not enabled: browser_task uses a paired Mac when online, else read-only cloud scraping (needs web search).',
    help: HELP_ANCHORS.webSearch,
    missing: browserOn ? (browserSecret ? [] : ['BROWSER_SERVICE_SECRET']) : ['BROWSER_SERVICE_ENABLED', 'BROWSER_SERVICE_SECRET'],
    present: split(env, ['BROWSER_SERVICE_ENABLED', 'BROWSER_SERVICE_SECRET', 'BROWSER_SERVICE_URL']).present,
    hint: browserOn && browserSecret ? undefined : (selfHosted
      ? 'Optional: start the stack with --profile browser (the browser-service container) and set BROWSER_SERVICE_ENABLED=1 + a BROWSER_SERVICE_SECRET in .env (the compose file hands the same secret to the container); until then browser_task uses a paired Mac when one is online, else read-only page fetches through web search.'
      : 'Run the browser-service container (docker-compose.base.yml) and set BROWSER_SERVICE_ENABLED=1 + the same BROWSER_SERVICE_SECRET on both sides.'),
  });

  // ── Integrations ────────────────────────────────────────────────────────
  for (const rule of INTEGRATION_RULES) features.push(integrationFeature(rule, env, selfHosted));

  // ── Messaging ───────────────────────────────────────────────────────────
  const tg = split(env, ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_BOT_USERNAME', 'TELEGRAM_WEBHOOK_SECRET']);
  const tgReady = tg.missing.length === 0;
  const tgHttps = isHttps;
  // The bot only works once Telegram has been told the webhook URL — a step no
  // env var proves. A non-prod controller probes getWebhookInfo and hands the
  // answer in; undefined (production, or no token / URL to compare) keeps the
  // pre-probe row exactly as it was.
  const tgProbe = enrichment.telegramWebhook;
  const tgWebhookState: SetupState = !tgReady ? 'missing'
    : !tgHttps ? 'partial'
    : tgProbe === undefined ? 'ready'
    : tgProbe === null ? 'partial'
    : tgProbe.registered ? 'ready' : 'partial';
  const tgSummary = !tgReady ? 'Not set up on this instance.'
    : !tgHttps ? 'Bot configured, but Telegram can only call a public https webhook.'
    : tgProbe === undefined ? 'Bot configured.'
    : tgProbe === null ? 'Bot configured — could not verify the webhook registration (Telegram API unreachable from this box). Register it once with the command below if you have not.'
    : tgProbe.registered ? 'Bot configured and the webhook is registered.'
    : `Bot configured — register the webhook once (command below)${tgProbe.url ? `; Telegram currently points at ${tgProbe.url}` : '; Telegram has no webhook for this bot yet'}.`;
  features.push({
    key: 'telegram',
    label: 'Telegram',
    group: 'messaging',
    state: tgWebhookState,
    configured: tgReady,
    required: false,
    summary: tgSummary,
    help: HELP_ANCHORS.integrations,
    missing: tg.missing,
    present: tg.present,
    hint: tgReady
      ? (tgHttps ? undefined : 'Give this instance a public https URL (TLS with a real domain) before registering the webhook.')
      : 'Create a bot with @BotFather, set TELEGRAM_BOT_TOKEN, TELEGRAM_BOT_USERNAME and a TELEGRAM_WEBHOOK_SECRET you invent, restart, then register the webhook once.',
    note: publicUrl ? `Register the webhook: curl "https://api.telegram.org/bot<TOKEN>/setWebhook" -d url=${telegramWebhookUrl(publicUrl)} -d secret_token=<TELEGRAM_WEBHOOK_SECRET>   # check: curl "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"` : undefined,
  });

  const smtp = split(env, ['DIGBY_SMTP_USER', 'DIGBY_SMTP_PASS']);
  features.push({
    key: 'email',
    label: 'Email as Digby',
    group: 'messaging',
    state: smtp.missing.length === 0 ? 'ready' : 'off',
    configured: smtp.missing.length === 0,
    required: false,
    summary: smtp.missing.length === 0 ? `Digby can send email${has(env, 'DIGBY_SMTP_FROM') ? '' : ' (DIGBY_SMTP_FROM is unset — mail is sent as the mailbox address; set it to use a different From)'}.` : 'Not enabled: the send_email_as_digby tool reports itself unconfigured.',
    help: HELP_ANCHORS.quickStart,
    missing: smtp.missing,
    present: smtp.present,
    hint: smtp.missing.length === 0 ? undefined : 'Set DIGBY_SMTP_HOST / DIGBY_SMTP_PORT / DIGBY_SMTP_USER / DIGBY_SMTP_PASS / DIGBY_SMTP_FROM for a mailbox Digby may send from (an app password works for Gmail).',
  });

  if (selfHosted) {
    features.push({
      key: 'desktop_app',
      label: 'Desktop app (Digby.dmg / Digby-Setup.exe)',
      group: 'messaging',
      state: 'off',
      configured: false,
      required: false,
      summary: 'The installers this instance serves are the production builds: they sign into digby.ai, not this instance. Use the browser here; the Mac agent still pairs from the one-liner on the Your Mac card.',
      help: HELP_ANCHORS.integrations,
      missing: [],
      present: [],
      hint: 'To ship your own desktop build, point the home / update URLs in macos-app/Sources/Digby/main.swift at this instance and rebuild (macos-app/README.md); the Integrations tab and the public site hide the download links on a self-host.',
    });
  }

  features.push({
    key: 'mac_agent',
    label: 'Mac agent (iMessage, browser, computer use)',
    group: 'messaging',
    state: publicUrl ? 'ready' : 'partial',
    configured: !!publicUrl,
    required: false,
    summary: publicUrl ? `Pair a Mac from Account → Integrations → Your Mac; the installer must be given this instance's API URL.${isHttps ? '' : ' Agent self-updates need an https public URL (the agent ignores http adverts) — re-run the update one-liner instead.'}` : 'The installer needs this instance\'s public URL to pair against.',
    help: HELP_ANCHORS.integrations,
    missing: [],
    present: [],
    hint: publicUrl ? `The one-liner on the Your Mac card already fetches the installer and the agent from this instance and pairs against ${publicUrl}/api; a hand-typed install must do the same: curl -fsSL ${publicUrl}/install-digby-agent.sh | DIGBY_INSTALL_HOST=${publicUrl} bash -s -- <code> ${publicUrl}/api` : 'Set SELFHOST_PUBLIC_URL first.',
  });

  // ── Coding ──────────────────────────────────────────────────────────────
  const docker = enrichment.dockerAvailable;
  const dockerHost = has(env, 'DOCKER_HOST') ? ['DOCKER_HOST'] : [];
  features.push({
    key: 'coding_sandbox',
    label: 'Coding sandbox (Docker)',
    group: 'coding',
    state: docker === true ? 'ready' : docker === false ? 'missing' : 'partial',
    configured: docker === true,
    required: false,
    summary: docker === true
      ? 'Docker is reachable; coding sessions run in per-session containers.'
      : docker === false
        ? 'Docker is not reachable from the backend, so coding sessions cannot start their containers.'
        : 'Docker was not probed by this process.',
    help: HELP_ANCHORS.requirements,
    missing: docker === false ? ['DOCKER_HOST'] : [],
    present: dockerHost,
    hint: docker === false ? 'The self-host stack reaches Docker through the docker-socket-proxy service (DOCKER_HOST=tcp://docker-socket-proxy:2375). Check `docker compose ps docker-socket-proxy` and the worker service (CODING_WORKER_CONCURRENCY).' : undefined,
  });

  const ready = features.filter(f => f.state === 'ready').length;
  const missingRequired = features.filter(f => f.required && f.state !== 'ready').map(f => f.key);
  return {
    instance: { kind, selfHosted, publicUrl, cookieSecure, nodeEnv },
    summary: { ready, total: features.length, missingRequired },
    features,
  };
}

/** The viewer-safe projection: no env names, no hints, no callback URLs. */
export function redactSetupForViewer(setup: InstanceSetup): InstanceSetup {
  const seatKeys = new Set<string>(SEAT_RULES.map(r => r.key));
  return {
    ...setup,
    features: setup.features.map(f => ({
      key: f.key, label: f.label, group: f.group, state: f.state, configured: f.configured, required: f.required, summary: viewerSummary(f, seatKeys), help: f.help,
      ...(f.oauth !== undefined ? { oauth: f.oauth } : {}),
    })),
  };
}

/**
 * The summary a NON-admin may read: model ids are admin-only (seat rows say
 * "Ready." / their gap line only) and the webhook URL Telegram currently holds
 * stays with the admin. Everything else is already names + booleans.
 */
function viewerSummary(f: SetupFeature, seatKeys: Set<string>): string {
  if (seatKeys.has(f.key)) return f.state === 'ready' ? 'Ready.' : f.summary;
  if (f.key === 'telegram') return f.summary.replace(/; Telegram currently points at \S+/, '');
  return f.summary;
}

/** The cause webSearchStatus() found, as a sentence to append to a model-facing "not configured" text ('' when it is a plain absence). */
export function webSearchProblemSuffix(env: NodeJS.ProcessEnv = process.env): string {
  const s = webSearchStatus(env);
  return !s.configured && s.problem ? ` Cause on this instance: ${s.problem}.` : '';
}
