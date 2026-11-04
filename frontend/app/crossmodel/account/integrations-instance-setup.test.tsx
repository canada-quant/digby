/**
 * IntegrationsTab / page.tsx — the "not set up on this instance"
 * states (self-host setup hardening, 2026-10-20). Source-level pins (the tabs
 * fetch in effects): every provider card gates on GET /instance/setup, the
 * gated branch shows a NotSetUpNotice (admin: env names + how-to; user: who
 * fixes it) and NEVER the "just click Connect" copy, the redirect handler
 * toasts the backend's not_configured bounce with its reason, the Telegram
 * card follows the same gate, the GitHub token form is the Connect path when
 * the OAuth app is off and is withheld when the token key is missing,
 * headlines read the web-search state, and the Mac card builds its
 * one-liners from the page origin.
 * (FeedsTab was deleted with the topic-feeds subsystem, ticket 43c24152,
 *  2026-10-20 — its gate pins moved out of this suite with it.)
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const readSrc = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const TAB = readSrc('./IntegrationsTab.tsx');
const MAC = readSrc('./IMessageCard.tsx');
const PAGE = readSrc('../page.tsx');
const PLAID = readSrc('./PlaidLinkButton.tsx');

const PROVIDERS = ['google', 'github', 'x', 'xero', 'slack', 'asana', 'plaid', 'telegram'];

describe('IntegrationsTab — instance setup gates', () => {
  it('loads the setup once and derives every gate from it', () => {
    expect(TAB).toContain('instanceSetupApi.get()');
    expect(TAB).toContain("const gate = (key: string): InstanceSetupFeature | null => (integrationUnavailable(setup, key) ? featureByKey(setup, key) : null);");
  });
  it.each(PROVIDERS)('%s card: badge + NotSetUpNotice in the gated branch', (key) => {
    expect(TAB).toContain(`gate('${key}')`);
    expect(TAB).toContain(`<NotSetUpNotice feature={gate('${key}')!}`);
  });
  it('the notice gives admins the env names + hint + help link and users the who-fixes-it line', () => {
    expect(TAB).toContain('function NotSetUpNotice({ feature, label, admin }');
    expect(TAB).toContain('data-testid={`not-set-up-${feature.key}`}');
    expect(TAB).toContain('notSetUpCopy(label)');
    expect(TAB).toContain('helpHref(feature)');
    expect(TAB).toContain('feature.missing');
  });
  it('never says "just click Connect and approve" under a card without a Connect button', () => {
    for (const key of ['slack', 'asana']) {
      expect(TAB).toContain(`{gate('${key}') ? null : <> Digby hosts the integration — just click Connect and approve.</>}`);
    }
  });
  it('toasts the not_configured bounce with the backend reason for every OAuth provider', () => {
    for (const label of ['Google Workspace', 'Xero', 'Slack', 'Asana', 'GitHub', 'X.com']) {
      expect(TAB).toContain(`toast.error(notConfiguredToast('${label}', params.get('reason')));`);
    }
    expect(TAB).not.toContain('API credentials need to be added');
  });
  it('GitHub: the token form is the Connect path when the OAuth app is off, and is withheld when the token key is missing', () => {
    expect(TAB).toContain('data-testid="github-oauth-off"');
    expect(TAB).toContain('if (githubOAuthOff && githubAccounts.length === 0) setGithubShowPat(true);');
    expect(TAB).toContain("{!gate('github') && (");
    expect(TAB).toContain('data-testid="github-pat-block"');
    expect(TAB).toContain('This instance has no GitHub OAuth app, so a token is the way to connect.');
  });
  it('Telegram: the setup feature outranks /telegram/status and a pending webhook is said out loud', () => {
    expect(TAB).toContain("gate('telegram') ? null : telegramStatus?.configured !== false ?");
    expect(TAB).toContain('data-testid="telegram-webhook-pending"');
    expect(TAB).toContain('data-testid="telegram-webhook-pending-copy"');
    expect(TAB).toContain("telegramFeature.configured && telegramFeature.state === 'partial'");
  });
  it('self-host banner + the production desktop app hidden on a self-host', () => {
    expect(TAB).toContain('data-testid="instance-banner"');
    expect(TAB).toContain('data-testid="mac-app-selfhost"');
  });
});

describe('Mac agent card — one-liners come from the page origin', () => {
  it('builds the install + update commands with the shared helpers (API URL + tarball host)', () => {
    expect(MAC).toContain("import { macAgentInstallCommand, macAgentUpdateCommand } from '@/lib/instance-setup';");
    expect(MAC).toContain('macAgentInstallCommand(installOrigin');
    expect(MAC).toContain('macAgentUpdateCommand(installOrigin)');
    expect(MAC).toContain('window.location.origin');
  });
});

describe('Headlines read the web-search state', () => {
  it('the home news card says headlines need web search instead of showing an empty list', () => {
    expect(PAGE).toContain('if (result.unconfigured) {');
    expect(PAGE).toContain('setNewsUnconfigured(true)');
    expect(PAGE).toContain('data-testid="news-unconfigured"');
    expect(PAGE).toContain('webSearchConfigured: !webSearchUnavailable(instanceSetup)');
  });
  it('Plaid surfaces the backend reason instead of a generic credentials line', () => {
    expect(PLAID).toContain("e?.response?.data?.error || (e?.response ? 'Plaid is not set up on this instance yet");
    expect(PLAID).toContain('Could not reach Digby');
    expect(PLAID).not.toContain('API credentials need to be added');
  });
});
