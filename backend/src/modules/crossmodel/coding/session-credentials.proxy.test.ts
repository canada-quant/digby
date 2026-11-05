/**
 * build 2026-10-08 ISO — the shell credential env with the credential proxy
 * (switch CODING_CREDENTIAL_PROXY). Switch off: today's env byte-for-byte, no
 * telemetry. Canary user + healthy proxy: NO raw platform token in the env
 * (the deciding metric), git routed through the proxy, user-managed creds
 * kept, the prompt note explains it. Proxy down: fail-to-direct + a row.
 */
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
const mockGithubToken = jest.fn(async (): Promise<string | null> => 'gho_RAW_GITHUB');
jest.mock('../github/token-manager', () => ({ __esModule: true, getValidToken: (...a: any[]) => (mockGithubToken as any)(...a) }));
jest.mock('../google/token-manager', () => ({ __esModule: true, getValidToken: jest.fn(async () => 'ya29.RAW_GOOGLE') }));
jest.mock('../slack/token-manager', () => ({ __esModule: true, getValidToken: jest.fn(async () => null) }));
jest.mock('../asana/token-manager', () => ({ __esModule: true, getValidToken: jest.fn(async () => null) }));
jest.mock('./credentials.service', () => ({ __esModule: true, getCredentialEnv: jest.fn(async () => ({ CLOUDFLARE_API_TOKEN: 'cf-user-managed-token' })) }));
const mockRecord = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({ __esModule: true, recordLoopMetric: (...a: any[]) => mockRecord(...a), LOOP_METRIC_KINDS: { CREDENTIAL_PROXY: 'credential_proxy' } }));

import { gatherSessionCredentialEnv, credentialEnvNote } from './session-credentials';
import { __resetCredentialProxyMemoForTest, countRawPlatformCreds, verifyCapability, credentialScrubValues, ghProxyShellPrefix, GH_KIT_ROOT } from './credential-proxy';

const U = '83e4fbf9-e18c-42f1-9bf7-7a99caf9d9c4';
const flush = () => new Promise((r) => setTimeout(r, 0));
const saved = { ...process.env };
const realFetch = global.fetch;

beforeEach(() => {
  mockRecord.mockClear();
  __resetCredentialProxyMemoForTest();
  process.env.JWT_SECRET = 'j'.repeat(48);
  process.env.FRONTEND_URL = 'https://digby.ai';
  delete process.env.CODING_CREDENTIAL_PROXY;
  delete process.env.CREDENTIAL_PROXY_GH_DISABLED;
  mockGithubToken.mockImplementation(async () => 'gho_RAW_GITHUB');
  global.fetch = jest.fn(async () => new Response(JSON.stringify({ ok: true, credentialProxy: true }))) as any;
});
afterAll(() => { process.env = saved; global.fetch = realFetch; });

it('switch OFF: the raw tokens are injected exactly as before and nothing is recorded', async () => {
  const env = await gatherSessionCredentialEnv(U, null, { sessionId: 's1', shell: true });
  expect(env.GITHUB_TOKEN).toBe('gho_RAW_GITHUB');
  expect(env.GH_TOKEN).toBe('gho_RAW_GITHUB');
  expect(env.GOOGLE_ACCESS_TOKEN).toBe('ya29.RAW_GOOGLE');
  expect(env.GIT_CONFIG_COUNT).toBe('1');
  expect(env.DIGBY_CREDENTIAL_PROXY_TOKEN).toBeUndefined();
  expect(global.fetch).not.toHaveBeenCalled();
  await flush();
  expect(mockRecord).not.toHaveBeenCalled();
});

it('canary user, healthy proxy: ZERO raw platform credentials in the shell env; git goes through the proxy', async () => {
  process.env.CODING_CREDENTIAL_PROXY = U;
  const env = await gatherSessionCredentialEnv(U, 'Work', { sessionId: 's1', shell: true });
  expect(countRawPlatformCreds(env)).toBe(0);
  expect(JSON.stringify(env)).not.toContain('gho_RAW_GITHUB');
  expect(JSON.stringify(env)).not.toContain('ya29.RAW_GOOGLE');
  expect(env.CLOUDFLARE_API_TOKEN).toBe('cf-user-managed-token'); // user-managed: kept (counted)
  expect(env.GIT_CONFIG_KEY_0).toBe('url.https://digby.ai/api/crossmodel/coding/cred-proxy/git/github.com/.insteadOf');
  expect(env.DIGBY_CREDENTIAL_PROXY_APIS).toBe('github,google');
  expect(verifyCapability(env.DIGBY_CREDENTIAL_PROXY_TOKEN)).toMatchObject({ sessionId: 's1', userId: U, githubLabel: 'Work' });
  const note = credentialEnvNote(env);
  expect(note).toContain('[CREDENTIAL PROXY]');
  expect(note).toContain('CLOUDFLARE_API_TOKEN');
  expect(note).not.toContain('DIGBY_CREDENTIAL_PROXY_TOKEN,');
  await flush();
  expect(mockRecord.mock.calls[0][0]).toMatchObject({ kind: 'credential_proxy', sessionId: 's1', meta: { phase: 'env', mode: 'proxy', rawPlatform: 0, userManaged: 1 } });
});

it('build 2026-10-11 ISO-GH: proxy mode + GitHub connected → the gh kit rides the env (code, no secret); the note says gh works; the row says ghKit', async () => {
  process.env.CODING_CREDENTIAL_PROXY = '1';
  const env = await gatherSessionCredentialEnv(U, null, { sessionId: 's1', shell: true });
  expect(countRawPlatformCreds(env)).toBe(0);
  expect(env.DIGBY_GH_KIT_DIR).toMatch(new RegExp(`^${GH_KIT_ROOT}/[0-9a-f]{12}$`));
  expect(env.DIGBY_GH_KIT_GH).toContain('#!/bin/sh');
  expect(env.DIGBY_GH_KIT_FW).toContain("require('http')");
  expect(JSON.stringify(env)).not.toContain('gho_RAW_GITHUB');
  expect(env.GH_TOKEN).toBeUndefined(); // the capability reaches gh only inside the wrapper's exec
  expect(ghProxyShellPrefix(env)).toContain('__digby_gh_kit');
  for (const k of ['DIGBY_GH_KIT_DIR', 'DIGBY_GH_KIT_GH', 'DIGBY_GH_KIT_GIT', 'DIGBY_GH_KIT_FW']) expect(credentialScrubValues(env)).not.toContain(env[k]);
  const note = credentialEnvNote(env);
  expect(note).toContain('The gh CLI works through the proxy too');
  expect(note).not.toContain('NOT authenticated');
  expect(note).not.toContain('DIGBY_GH_KIT');
  await flush();
  expect(mockRecord.mock.calls[0][0]).toMatchObject({ meta: { phase: 'env', mode: 'proxy', rawPlatform: 0, ghKit: true } });
});

it('ISO-GH: the canary incident shape (no GitHub link — the test account) gets no kit: gh exactly as direct mode (no token)', async () => {
  process.env.CODING_CREDENTIAL_PROXY = '1';
  mockGithubToken.mockImplementation(async () => null);
  const env = await gatherSessionCredentialEnv(U, null, { sessionId: 's1', shell: true });
  expect(env.DIGBY_GH_KIT_DIR).toBeUndefined();
  expect(env.DIGBY_CREDENTIAL_PROXY_APIS).toBe('google');
  expect(ghProxyShellPrefix(env)).toBe('');
  expect(credentialEnvNote(env)).toContain('The gh CLI is NOT authenticated here.');
  await flush();
  expect(mockRecord.mock.calls[0][0]).toMatchObject({ meta: { mode: 'proxy', ghKit: false } });
});

it('ISO-GH kill switch CREDENTIAL_PROXY_GH_DISABLED=1: proxy mode as before the kit (gh unauthenticated, prefix unchanged)', async () => {
  process.env.CODING_CREDENTIAL_PROXY = '1';
  process.env.CREDENTIAL_PROXY_GH_DISABLED = '1';
  const env = await gatherSessionCredentialEnv(U, null, { sessionId: 's1', shell: true });
  expect(countRawPlatformCreds(env)).toBe(0);
  expect(env.DIGBY_GH_KIT_DIR).toBeUndefined();
  expect(ghProxyShellPrefix(env)).toBe('');
  expect(credentialEnvNote(env)).toContain('The gh CLI is NOT authenticated here.');
});

it('a chat run (no shell) never mints a capability', async () => {
  process.env.CODING_CREDENTIAL_PROXY = '1';
  const env = await gatherSessionCredentialEnv(U, null, { sessionId: 's1', shell: false });
  expect(env.GITHUB_TOKEN).toBe('gho_RAW_GITHUB');
  expect(env.DIGBY_CREDENTIAL_PROXY_TOKEN).toBeUndefined();
});

it('proxy unreachable: fail-to-direct (today\'s env) + a row naming why', async () => {
  process.env.CODING_CREDENTIAL_PROXY = '1';
  global.fetch = jest.fn(async () => { throw new Error('ECONNREFUSED'); }) as any;
  const env = await gatherSessionCredentialEnv(U, null, { sessionId: 's2', shell: true });
  expect(env.GITHUB_TOKEN).toBe('gho_RAW_GITHUB');
  await flush();
  expect(mockRecord.mock.calls[0][0]).toMatchObject({ meta: { phase: 'env', mode: 'fail_to_direct', reason: 'proxy_unreachable', rawPlatform: 3 } });
});
