/**
 * instance-setup — the self-host setup leaf's contract (2026-10-20).
 *
 * Pure-function pins, no mocks, no DB, no env landmines (the leaf is
 * import-free beyond instance-targets on purpose). Production (DIGBY_INSTANCE
 * unset) must never read as "missing"; a self-host reads exactly what its env
 * says; values never leave the module.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  computeInstanceSetup,
  instancePublicUrl,
  instanceSiteLabel,
  integrationsMissingOnInstance,
  selfhostAdminEmailFor,
  oauthRedirectUri,
  redactSetupForViewer,
  webSearchMissingOnInstance,
  webSearchStatus,
  webSearchProblemSuffix,
  noteWebSearchStoreArmed,
  webSearchStoreArmed,
  WEB_SEARCH_UNCONFIGURED_MSG,
  WEB_PIPE_UNCONFIGURED_NOTE,
  HELP_ANCHORS,
} from './instance-setup';

const SELFHOST = { DIGBY_INSTANCE: 'selfhost', SELFHOST_PUBLIC_URL: 'https://digby.cql.ca', COOKIE_SECURE: 'true', NODE_ENV: 'production' } as NodeJS.ProcessEnv;
const PROD = { FRONTEND_URL: 'https://digby.ai,http://localhost:8247', NODE_ENV: 'production', BRIGHTDATA_API_TOKEN: 'x', MCP_DIGBY_TOKEN: 'y' } as NodeJS.ProcessEnv;

const feature = (env: NodeJS.ProcessEnv, key: string, enrichment = {}) => {
  const f = computeInstanceSetup(env, enrichment).features.find((x) => x.key === key);
  if (!f) throw new Error(`feature ${key} missing`);
  return f;
};

describe('webSearchStatus', () => {
  it('direct token ⇒ ready (direct); gateway token + URL ⇒ ready (gateway); nothing ⇒ none', () => {
    expect(webSearchStatus({ ...SELFHOST, BRIGHTDATA_API_TOKEN: 't' })).toEqual({ configured: true, mode: 'direct' });
    // a well-formed gateway pair still needs the BrightData token the gateway container runs on (then the direct tier serves)
    expect(webSearchStatus({ ...SELFHOST, MCP_DIGBY_TOKEN: 't', MCP_DIGBY_URL: 'http://brightdata-mcp:8000/mcp' })).toMatchObject({ configured: false, mode: 'gateway' });
    expect(webSearchStatus({ ...SELFHOST, MCP_DIGBY_TOKEN: 't', MCP_DIGBY_URL: 'http://brightdata-mcp:8000/mcp' }).problem).toMatch(/BRIGHTDATA_API_TOKEN is not/);
    expect(webSearchStatus({ ...SELFHOST, MCP_DIGBY_TOKEN: 't', MCP_DIGBY_URL: 'http://brightdata-mcp:8000/mcp', BRIGHTDATA_API_TOKEN: 'b' })).toEqual({ configured: true, mode: 'direct' });
    expect(webSearchStatus(SELFHOST)).toEqual({ configured: false, mode: 'none' });
  });
  it('a self-host gateway token WITHOUT MCP_DIGBY_URL is a problem, not ready (it would aim at production); on prod the default URL is fine', () => {
    const s = webSearchStatus({ ...SELFHOST, MCP_DIGBY_TOKEN: 't' });
    expect(s.configured).toBe(false);
    expect(s.problem).toMatch(/MCP_DIGBY_URL/);
    expect(webSearchStatus({ NODE_ENV: 'production', MCP_DIGBY_TOKEN: 't' } as NodeJS.ProcessEnv)).toEqual({ configured: true, mode: 'gateway' });
  });
  it('webSearchMissingOnInstance is false on production even with no token (prod is never "missing"), true on a token-less self-host', () => {
    expect(webSearchMissingOnInstance({ NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toBe(false);
    expect(webSearchMissingOnInstance(SELFHOST)).toBe(true);
    expect(webSearchMissingOnInstance({ ...SELFHOST, BRIGHTDATA_API_TOKEN: 't' })).toBe(false);
  });
  it('the honest tool texts name the instance, forbid a retry and keep the words callers key on', () => {
    expect(WEB_SEARCH_UNCONFIGURED_MSG).toMatch(/NOT configured on this Digby instance/);
    expect(WEB_SEARCH_UNCONFIGURED_MSG).toMatch(/Do NOT retry/);
    expect(WEB_PIPE_UNCONFIGURED_NOTE).toContain('found no sources');
    expect(WEB_PIPE_UNCONFIGURED_NOTE).toMatch(/gateway/i);
  });
});

describe('instance URL helpers', () => {
  it('SELFHOST_PUBLIC_URL wins, else the first FRONTEND_URL entry, trailing slash stripped; null when neither', () => {
    expect(instancePublicUrl(SELFHOST)).toBe('https://digby.cql.ca');
    expect(instancePublicUrl(PROD)).toBe('https://digby.ai');
    expect(instancePublicUrl({ FRONTEND_URL: 'http://lan:8080/' } as NodeJS.ProcessEnv)).toBe('http://lan:8080');
    expect(instancePublicUrl({} as NodeJS.ProcessEnv)).toBeNull();
  });
  it('oauthRedirectUri derives the callback from the public URL', () => {
    expect(oauthRedirectUri('google', SELFHOST)).toBe('https://digby.cql.ca/api/crossmodel/google/callback');
    expect(oauthRedirectUri('github', PROD)).toBe('https://digby.ai/api/crossmodel/github/callback');
    expect(oauthRedirectUri('x', {} as NodeJS.ProcessEnv)).toBeNull();
  });
  it('instanceSiteLabel is the host users know, digby.ai when unknown', () => {
    expect(instanceSiteLabel(SELFHOST)).toBe('digby.cql.ca');
    expect(instanceSiteLabel({} as NodeJS.ProcessEnv)).toBe('digby.ai');
    expect(instanceSiteLabel({ FRONTEND_URL: 'http://192.168.1.20:8080' } as NodeJS.ProcessEnv)).toBe('192.168.1.20:8080');
  });
});

describe('computeInstanceSetup — integrations', () => {
  it('an OAuth integration with every env set is ready; with OAuth but no MCP key it is partial (connect works, reads do not); with nothing it is missing', () => {
    const full = { ...SELFHOST, GOOGLE_OAUTH_CLIENT_ID: 'a', GOOGLE_OAUTH_CLIENT_SECRET: 'b', GOOGLE_TOKEN_ENCRYPTION_KEY: 'c', GOOGLE_MCP_API_KEY: 'd' };
    expect(feature(full, 'google')).toMatchObject({ state: 'ready', configured: true, missing: [] });
    const noReads = { ...SELFHOST, GOOGLE_OAUTH_CLIENT_ID: 'a', GOOGLE_OAUTH_CLIENT_SECRET: 'b', GOOGLE_TOKEN_ENCRYPTION_KEY: 'c' };
    const g = feature(noReads, 'google');
    expect(g).toMatchObject({ state: 'partial', configured: true, missing: ['GOOGLE_MCP_API_KEY'], profile: 'mcp' });
    expect(g.hint).toMatch(/--profile mcp/);
    const none = feature(SELFHOST, 'google');
    expect(none).toMatchObject({ state: 'missing', configured: false });
    expect(none.missing).toEqual(expect.arrayContaining(['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET', 'GOOGLE_TOKEN_ENCRYPTION_KEY', 'GOOGLE_MCP_API_KEY']));
    expect(none.redirectUri).toBe('https://digby.cql.ca/api/crossmodel/google/callback');
    expect(none.hint).toContain('Callback URL to register: https://digby.cql.ca/api/crossmodel/google/callback');
  });
  it('GitHub: the pasted-token path needs only the encryption key (partial, configured), an OAuth app makes it ready', () => {
    const pat = feature({ ...SELFHOST, GITHUB_TOKEN_ENCRYPTION_KEY: 'k', GITHUB_MCP_API_KEY: 'm' }, 'github');
    expect(pat).toMatchObject({ state: 'partial', configured: true });
    expect(pat.summary).toMatch(/personal access token/);
    expect(feature({ ...SELFHOST, GITHUB_OAUTH_CLIENT_ID: 'a', GITHUB_OAUTH_CLIENT_SECRET: 'b', GITHUB_TOKEN_ENCRYPTION_KEY: 'k', GITHUB_MCP_API_KEY: 'm' }, 'github').state).toBe('ready');
    expect(feature(SELFHOST, 'github').configured).toBe(false);
  });
  it('Xero and Plaid need the Google token-encryption key (they encrypt with google/crypto)', () => {
    expect(feature({ ...SELFHOST, XERO_CLIENT_ID: 'a', XERO_CLIENT_SECRET: 'b' }, 'xero')).toMatchObject({ configured: false, missing: ['GOOGLE_TOKEN_ENCRYPTION_KEY'] });
    expect(feature({ ...SELFHOST, PLAID_CLIENT_ID: 'a', PLAID_SECRET: 'b', GOOGLE_TOKEN_ENCRYPTION_KEY: 'k' }, 'plaid').state).toBe('ready');
  });
  it('a redirect-URI override is used verbatim', () => {
    const f = feature({ ...SELFHOST, SLACK_OAUTH_REDIRECT_URI: 'https://custom.example/cb' }, 'slack');
    expect(f.redirectUri).toBe('https://custom.example/cb');
  });
  it('integrationsMissingOnInstance names every unconfigured key on a self-host and nothing on production', () => {
    const missing = integrationsMissingOnInstance(SELFHOST);
    expect([...missing].sort()).toEqual(['asana', 'discord', 'github', 'google', 'plaid', 'slack', 'telegram', 'x', 'xero']);
    expect(integrationsMissingOnInstance({ NODE_ENV: 'production' } as NodeJS.ProcessEnv).size).toBe(0);
    expect(integrationsMissingOnInstance({ ...SELFHOST, TELEGRAM_BOT_TOKEN: 't' }).has('telegram')).toBe(true); // no username ⇒ no connect link
    expect(integrationsMissingOnInstance({ ...SELFHOST, TELEGRAM_BOT_TOKEN: 't', TELEGRAM_BOT_USERNAME: 'u' }).has('telegram')).toBe(false);
  });
  it('the admin-store key (Admin → Settings → Web search) arms the LIVE status only — a fixture env never sees it', () => {
    try {
      expect(webSearchStoreArmed()).toBeNull();
      noteWebSearchStoreArmed(true);
      expect(webSearchStatus()).toEqual({ configured: true, mode: 'store' }); // process.env: token-less jest
      expect(webSearchStatus(SELFHOST).configured).toBe(false); // a fixture is env-only
      expect(webSearchMissingOnInstance()).toBe(false);
      noteWebSearchStoreArmed(false);
      expect(webSearchStatus().mode).toBe('none');
    } finally {
      noteWebSearchStoreArmed(null);
    }
  });
  it('a gateway URL that is not the /mcp endpoint is a misconfiguration, never "configured"', () => {
    // a well-formed gateway pair still needs the BrightData token the gateway container runs on (then the direct tier serves)
    expect(webSearchStatus({ ...SELFHOST, MCP_DIGBY_TOKEN: 't', MCP_DIGBY_URL: 'http://brightdata-mcp:8000/mcp' })).toMatchObject({ configured: false, mode: 'gateway' });
    expect(webSearchStatus({ ...SELFHOST, MCP_DIGBY_TOKEN: 't', MCP_DIGBY_URL: 'http://brightdata-mcp:8000/mcp' }).problem).toMatch(/BRIGHTDATA_API_TOKEN is not/);
    expect(webSearchStatus({ ...SELFHOST, MCP_DIGBY_TOKEN: 't', MCP_DIGBY_URL: 'http://brightdata-mcp:8000/mcp', BRIGHTDATA_API_TOKEN: 'b' })).toEqual({ configured: true, mode: 'direct' });
    expect(webSearchStatus({ ...SELFHOST, MCP_DIGBY_TOKEN: 't', MCP_DIGBY_URL: 'http://brightdata-mcp:8000/' }).configured).toBe(false);
    expect(webSearchStatus({ ...SELFHOST, MCP_DIGBY_TOKEN: 't', MCP_DIGBY_URL: 'brightdata-mcp:8000/mcp' }).problem).toMatch(/must be the MCP gateway/);
    expect(webSearchStatus({ ...SELFHOST, MCP_DIGBY_TOKEN: 't', MCP_DIGBY_URL: 'http://brightdata-mcp:8000/health' }).configured).toBe(false);
    expect(webSearchProblemSuffix({ ...SELFHOST, MCP_DIGBY_TOKEN: 't' })).toMatch(/Cause on this instance: MCP_DIGBY_TOKEN is set but MCP_DIGBY_URL is not/);
    expect(webSearchProblemSuffix(SELFHOST)).toBe('');
    expect(webSearchProblemSuffix({ ...PROD })).toBe('');
    // Production keeps its default gateway whatever the env says.
    expect(webSearchStatus({ ...PROD, BRIGHTDATA_API_TOKEN: undefined, MCP_DIGBY_URL: 'nonsense' }).configured).toBe(true);
  });
});

describe('computeInstanceSetup — instance, web, messaging, coding', () => {
  it('public URL + cookie/TLS consistency', () => {
    expect(feature(SELFHOST, 'public_url')).toMatchObject({ state: 'ready', configured: true, present: ['SELFHOST_PUBLIC_URL'] });
    expect(feature({ DIGBY_INSTANCE: 'selfhost' } as NodeJS.ProcessEnv, 'public_url')).toMatchObject({ state: 'missing', missing: ['SELFHOST_PUBLIC_URL'] });
    expect(feature(SELFHOST, 'cookies_tls').state).toBe('ready');
    const mismatch = feature({ ...SELFHOST, COOKIE_SECURE: 'false' }, 'cookies_tls');
    expect(mismatch.state).toBe('partial');
    expect(mismatch.hint).toMatch(/COOKIE_SECURE=true/);
    const httpSecure = feature({ DIGBY_INSTANCE: 'selfhost', SELFHOST_PUBLIC_URL: 'http://lan:8080', COOKIE_SECURE: 'true' } as NodeJS.ProcessEnv, 'cookies_tls');
    expect(httpSecure.summary).toMatch(/logins will not stick/);
  });
  it('web search mirrors the search backend (feeds card retired with the feeds subsystem, 43c24152); the gateway-without-URL problem is partial with the fix named', () => {
    expect(feature(SELFHOST, 'web_search')).toMatchObject({ state: 'missing', configured: false, missing: ['BRIGHTDATA_API_TOKEN'] });
    // The 'feeds' feature card was deleted with the topic-feeds subsystem
    // (ticket 43c24152, 2026-10-20) — a topic digest is a schedule on a real
    // chat now; web search readiness is the web_search card alone.
    expect(computeInstanceSetup(SELFHOST, {}).features.some((x: any) => x.key === 'feeds')).toBe(false);
    const p = feature({ ...SELFHOST, MCP_DIGBY_TOKEN: 't' }, 'web_search');
    expect(p).toMatchObject({ state: 'partial', configured: false, missing: ['MCP_DIGBY_URL'] });
    expect(p.hint).toMatch(/MCP_DIGBY_URL=http:\/\/brightdata-mcp:8000\/mcp/);
    expect(feature({ ...SELFHOST, BRIGHTDATA_API_TOKEN: 't' }, 'web_search').state).toBe('ready');
  });
  it('Telegram needs the three vars and an https URL; the note carries the webhook command for THIS instance', () => {
    const tg = feature({ ...SELFHOST, TELEGRAM_BOT_TOKEN: 'a', TELEGRAM_BOT_USERNAME: 'b', TELEGRAM_WEBHOOK_SECRET: 'c' }, 'telegram');
    expect(tg.state).toBe('ready');
    expect(tg.note).toContain('url=https://digby.cql.ca/api/crossmodel/telegram/webhook');
    expect(feature({ ...SELFHOST, SELFHOST_PUBLIC_URL: 'http://lan:8080', COOKIE_SECURE: 'false', TELEGRAM_BOT_TOKEN: 'a', TELEGRAM_BOT_USERNAME: 'b', TELEGRAM_WEBHOOK_SECRET: 'c' }, 'telegram').state).toBe('partial');
    expect(feature(SELFHOST, 'telegram').missing).toEqual(['TELEGRAM_BOT_TOKEN', 'TELEGRAM_BOT_USERNAME', 'TELEGRAM_WEBHOOK_SECRET']);
  });
  it('telegram is only READY once the webhook probe says it is registered; unprobed keeps the pre-probe row', () => {
    const bot = { ...SELFHOST, TELEGRAM_BOT_TOKEN: 'a', TELEGRAM_BOT_USERNAME: 'b', TELEGRAM_WEBHOOK_SECRET: 'c' };
    expect(feature(bot, 'telegram').state).toBe('ready'); // not probed (production path)
    expect(feature(bot, 'telegram', { telegramWebhook: { registered: true, url: 'https://digby.cql.ca/api/crossmodel/telegram/webhook' } })).toMatchObject({ state: 'ready', configured: true });
    const unregistered = feature(bot, 'telegram', { telegramWebhook: { registered: false, url: null } });
    expect(unregistered.state).toBe('partial');
    expect(unregistered.configured).toBe(true);
    expect(unregistered.summary).toMatch(/register the webhook once/);
    expect(feature(bot, 'telegram', { telegramWebhook: { registered: false, url: 'https://digby.ai/api/crossmodel/telegram/webhook' } }).summary).toContain('currently points at https://digby.ai/api/crossmodel/telegram/webhook');
    expect(feature(bot, 'telegram', { telegramWebhook: null }).state).toBe('partial');
    expect(feature(bot, 'telegram', { telegramWebhook: null }).summary).toMatch(/could not verify/);
    expect(feature(bot, 'telegram').note).toContain('getWebhookInfo');
  });
  it('the desktop installers are a self-host-only "off" row (prod never lists it)', () => {
    expect(feature(SELFHOST, 'desktop_app')).toMatchObject({ state: 'off', configured: false, required: false });
    expect(computeInstanceSetup(PROD).features.find((f) => f.key === 'desktop_app')).toBeUndefined();
  });
  it('the Mac agent hint carries this instance\'s API URL for the installer', () => {
    expect(feature(SELFHOST, 'mac_agent').hint).toContain('https://digby.cql.ca/api');
  });
  it('model providers: any key or a registered endpoint; seats come from the enrichment and name the missing env var', () => {
    expect(feature(SELFHOST, 'model_providers')).toMatchObject({ state: 'missing', required: true });
    expect(feature({ ...SELFHOST, DEEPSEEK_API_KEY: 'k' }, 'model_providers').state).toBe('ready');
    expect(feature(SELFHOST, 'model_providers', { registeredEndpoints: 2 }).state).toBe('ready');
    const seats = [{ key: 'chat_orchestrator', persona: 'Digby', effective: 'kimi-k3', servable: false, unservableReason: 'no key', missingEnvKey: 'MOONSHOT_API_KEY' }, { key: 'kids', servable: false }];
    const lead = feature(SELFHOST, 'lead_seat', { seats });
    expect(lead).toMatchObject({ state: 'missing', required: true, missing: ['MOONSHOT_API_KEY'], note: 'no key' });
    expect(lead.hint).toMatch(/Model roles/);
    expect(feature(SELFHOST, 'kids', { seats }).state).toBe('off');
  });
  it('coding sandbox reads the Docker probe: true ready, false missing, null partial', () => {
    expect(feature(SELFHOST, 'coding_sandbox', { dockerAvailable: true }).state).toBe('ready');
    expect(feature(SELFHOST, 'coding_sandbox', { dockerAvailable: false }).state).toBe('missing');
    expect(feature(SELFHOST, 'coding_sandbox', {}).state).toBe('partial');
  });
  it('summary counts required gaps; production with keys has none', () => {
    const s = computeInstanceSetup(SELFHOST);
    expect(s.instance).toMatchObject({ kind: 'selfhost', selfHosted: true, publicUrl: 'https://digby.cql.ca', cookieSecure: true });
    expect(s.summary.missingRequired).toContain('model_providers');
    const p = computeInstanceSetup({ ...PROD, DEEPSEEK_API_KEY: 'k' });
    expect(p.instance.selfHosted).toBe(false);
    expect(p.summary.missingRequired).toEqual([]);
    expect(p.features.find((f) => f.key === 'analytics_isolation')).toBeUndefined(); // prod-only rows absent
  });
  it('every feature links to a self-host help anchor', () => {
    const anchors = new Set(Object.values(HELP_ANCHORS));
    for (const f of computeInstanceSetup(SELFHOST).features) expect(anchors.has(f.help)).toBe(true);
  });
  it('every help anchor is a heading id in the committed /help mirror (frontend/content/help/manifest.json)', () => {
    // A heading rename in docs/SELF_HOST.md regenerates the ids (github-slugger) — this pin fails before a deep link does.
    const manifest = JSON.parse(readFileSync(join(__dirname, '../../../../../frontend/content/help/manifest.json'), 'utf8'));
    const ids = new Set<string>(manifest.docs.find((d: any) => d.slug === 'self-host').headings.map((h: any) => h.id));
    for (const href of Object.values(HELP_ANCHORS)) expect(ids.has(href.split('#')[1])).toBe(true);
  });
});

describe('first-admin bootstrap (SELFHOST_ADMIN_EMAIL)', () => {
  it('matches the configured address case-insensitively on a non-prod instance only', () => {
    expect(selfhostAdminEmailFor('Paul@Example.com', { ...SELFHOST, SELFHOST_ADMIN_EMAIL: 'paul@example.com' })).toBe(true);
    expect(selfhostAdminEmailFor('other@example.com', { ...SELFHOST, SELFHOST_ADMIN_EMAIL: 'paul@example.com' })).toBe(false);
    expect(selfhostAdminEmailFor('paul@example.com', SELFHOST)).toBe(false); // unset
    expect(selfhostAdminEmailFor('paul@example.com', { NODE_ENV: 'production', SELFHOST_ADMIN_EMAIL: 'paul@example.com' } as NodeJS.ProcessEnv)).toBe(false); // never on prod
  });
  it('the setup row names the variable when unset and reads ready when set; absent on production', () => {
    expect(feature(SELFHOST, 'admin_bootstrap')).toMatchObject({ state: 'off', missing: ['SELFHOST_ADMIN_EMAIL'] });
    expect(feature({ ...SELFHOST, SELFHOST_ADMIN_EMAIL: 'a@b.c' }, 'admin_bootstrap').state).toBe('ready');
    expect(computeInstanceSetup(PROD).features.find((f) => f.key === 'admin_bootstrap')).toBeUndefined();
  });
});

describe('redactSetupForViewer', () => {
  it('strips env names, hints, callbacks and notes but keeps the booleans and summary', () => {
    const s = redactSetupForViewer(computeInstanceSetup(SELFHOST));
    // model ids and the registered webhook are admin-only facts
    const rich = redactSetupForViewer(computeInstanceSetup(
      { ...SELFHOST, TELEGRAM_BOT_TOKEN: 'a', TELEGRAM_BOT_USERNAME: 'b', TELEGRAM_WEBHOOK_SECRET: 'c' },
      { seats: [{ key: 'chat_orchestrator', persona: 'Digby', effective: 'cql-litellm:api-anthropic-claude-fable-5-1', servable: true }], telegramWebhook: { registered: false, url: 'https://digby.ai/api/crossmodel/telegram/webhook' } },
    ));
    expect(JSON.stringify(rich)).not.toMatch(/cql-litellm|kimi-k3|points at/);
    // the viewer keeps the OAuth fact (the GitHub card picks the token path from it)
    const gh = redactSetupForViewer(computeInstanceSetup({ ...SELFHOST, GITHUB_TOKEN_ENCRYPTION_KEY: 'k' })).features.find((f) => f.key === 'github')!;
    expect(gh).toMatchObject({ configured: true, oauth: false });
    expect(redactSetupForViewer(computeInstanceSetup({ ...SELFHOST, GITHUB_OAUTH_CLIENT_ID: 'a', GITHUB_OAUTH_CLIENT_SECRET: 'b', GITHUB_TOKEN_ENCRYPTION_KEY: 'k' })).features.find((f) => f.key === 'github')).toMatchObject({ oauth: true });
    expect(rich.features.find((f) => f.key === 'telegram')!.summary).toMatch(/register the webhook once/);
    for (const f of s.features) {
      expect(f.missing).toBeUndefined();
      expect(f.present).toBeUndefined();
      expect(f.hint).toBeUndefined();
      expect(f.redirectUri).toBeUndefined();
      expect(f.note).toBeUndefined();
      expect(typeof f.configured).toBe('boolean');
      expect(typeof f.summary).toBe('string');
    }
    expect(JSON.stringify(s)).not.toMatch(/GOOGLE_OAUTH_CLIENT_ID|BRIGHTDATA_API_TOKEN/);
  });
});
