/**
 * 2026-10-11 prod replay: the migration CLI runs in a one-shot process (workerq.sh) that never boots the app, so
 * the shared Redis client was never connected — acquireSessionRunLock swallowed "client closed" and every item of
 * the four canary users' first --apply read `run_lock_held` (nothing moved). defaultMigrationDeps must connect it.
 */
const connectRedis = jest.fn(async () => {});
jest.mock('../../../config/redis', () => ({ __esModule: true, connectRedis, default: {} }));
jest.mock('../../../config/database', () => ({ __esModule: true, default: {} }));
const acquireSessionRunLock = jest.fn(async () => true);
jest.mock('./session-run-lock', () => ({ acquireSessionRunLock, releaseSessionRunLock: jest.fn(async () => {}) }));
jest.mock('./workspace.service', () => ({ git: jest.fn() }));

import { defaultMigrationDeps } from './workspace-migration';

describe('defaultMigrationDeps (the CLI process)', () => {
  it('connects the shared Redis client before any run-lock call', async () => {
    const deps = await defaultMigrationDeps('m-test', '/tmp/none');
    expect(connectRedis).toHaveBeenCalledTimes(1);
    await expect(deps.lock('s1')).resolves.toBe(true);
    expect(acquireSessionRunLock).toHaveBeenCalledWith('s1', expect.stringContaining('workspace-migration-'));
  });

  it('an unreachable Redis fails the run loudly instead of reading as held locks', async () => {
    connectRedis.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(defaultMigrationDeps('m-test', '/tmp/none')).rejects.toThrow('ECONNREFUSED');
  });
});
