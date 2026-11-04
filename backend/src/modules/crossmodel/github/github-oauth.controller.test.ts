/**
 * GitHub OAuth — POST /pat connectPat fail-fast on missing encryption key
 * (ticket 387a5760: unset GITHUB_TOKEN_ENCRYPTION_KEY used to surface as a
 * bare 500 with a leaking stack trace on self-hosted instances).
 *
 * Pins:
 *  - 503 EncryptionKeyError naming GITHUB_TOKEN_ENCRYPTION_KEY, thrown BEFORE
 *    the outbound GitHub validation call (no axios, no DB write)
 *  - same for a malformed key (not 64 hex chars)
 *  - a valid key still proceeds to the outbound validation step
 *
 * Boundaries mocked per .digby/notes/learnings.md (config/database and
 * config/redis pull config/env, which exits the process at import).
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {
  gitHubOAuthToken: { upsert: jest.fn() },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: { get: jest.fn(), setEx: jest.fn(), del: jest.fn() },
}));

jest.mock('../langgraph/integration-status-cache', () => ({
  invalidateIntegrationStatusCache: jest.fn(async () => undefined),
}));

// error-handler (required by the last describe) imports config/env, which
// exits the process at import when required for real.
jest.mock('../../../config/env', () => ({ env: { NODE_ENV: 'test' } }));

// The outbound GitHub validation call — asserted NOT to happen when the key
// is missing (fail-fast contract), and mocked to fail fast when present so
// the upsert path is not the thing under test here.
jest.mock('axios');
import axios from 'axios';
const mockedAxios = axios as jest.Mocked<typeof axios>;

// Real crypto module (EncryptionKeyError shape) — no encryption happens in
// these tests; env vars are managed below.

import { GitHubOAuthController } from './github-oauth.controller';
import { EncryptionKeyError } from '../google/crypto';

const GITHUB_KEY = 'GITHUB_TOKEN_ENCRYPTION_KEY';
const VALID_KEY  = 'a'.repeat(64);

const GOOD_PAT = 'ghp_' + 'x'.repeat(36);

let savedKey: string | undefined;

beforeEach(() => {
  savedKey = process.env[GITHUB_KEY];
  process.env[GITHUB_KEY] = VALID_KEY;
  jest.clearAllMocks();
});

afterEach(() => {
  if (savedKey === undefined) delete process.env[GITHUB_KEY];
  else process.env[GITHUB_KEY] = savedKey;
});

const reqFor = (body: any) =>
  ({ user: { id: 'u1' }, body } as any);

const mockRes = () => {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

describe('connectPat — missing/malformed GITHUB_TOKEN_ENCRYPTION_KEY (ticket 387a5760)', () => {
  it('throws EncryptionKeyError (503) naming GITHUB_TOKEN_ENCRYPTION_KEY when the key is unset — before any outbound call or DB write', async () => {
    delete process.env[GITHUB_KEY];
    const res = mockRes();
    const next = jest.fn();
    await new GitHubOAuthController().connectPat(reqFor({ token: GOOD_PAT }), res, next);

    expect(next).toHaveBeenCalledTimes(1);
    const err: any = next.mock.calls[0][0];
    expect(err).toBeInstanceOf(EncryptionKeyError);
    expect(err.statusCode).toBe(503);
    expect(err.message).toContain('GITHUB_TOKEN_ENCRYPTION_KEY');
    expect(err.message).toContain('openssl rand -hex 32');
    // Fail-fast contract: nothing left the process before the error.
    expect(mockedAxios.get).not.toHaveBeenCalled();
    expect(mockPrisma.gitHubOAuthToken.upsert).not.toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('throws EncryptionKeyError (503) when the key is set but not 32 bytes (64 hex chars)', async () => {
    process.env[GITHUB_KEY] = 'abcd';
    const res = mockRes();
    const next = jest.fn();
    await new GitHubOAuthController().connectPat(reqFor({ token: GOOD_PAT }), res, next);

    expect(next).toHaveBeenCalledTimes(1);
    const err: any = next.mock.calls[0][0];
    expect(err).toBeInstanceOf(EncryptionKeyError);
    expect(err.statusCode).toBe(503);
    expect(err.message).toContain('GITHUB_TOKEN_ENCRYPTION_KEY');
    expect(err.message).toContain('32 bytes');
    expect(mockedAxios.get).not.toHaveBeenCalled();
    expect(mockPrisma.gitHubOAuthToken.upsert).not.toHaveBeenCalled();
  });

  it('proceeds to the outbound GitHub validation when the key is valid (no premature 503)', async () => {
    // Outbound validation rejects the token — the error path AFTER the
    // pre-check, proving the request got past it.
    (mockedAxios.get as jest.Mock).mockRejectedValue({ response: { status: 401 } });
    const res = mockRes();
    const next = jest.fn();
    await new GitHubOAuthController().connectPat(reqFor({ token: GOOD_PAT }), res, next);

    expect(mockedAxios.get).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringContaining('GitHub rejected that token') }));
    expect(next).not.toHaveBeenCalled();
  });
});

describe('connectPat — encryption-key error renders via the error handler taxonomy', () => {
  it('errorHandler maps EncryptionKeyError to a 503 body naming the env var (not a bare 500)', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { errorHandler } = require('../../../middleware/error-handler');
    const err = new EncryptionKeyError('GITHUB_TOKEN_ENCRYPTION_KEY is not set on the server');
    const res = mockRes();
    errorHandler(err, { method: 'POST', url: '/api/crossmodel/github/pat', originalUrl: '/api/crossmodel/github/pat' } as any, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({ error: 'GITHUB_TOKEN_ENCRYPTION_KEY is not set on the server' });
  });
});
