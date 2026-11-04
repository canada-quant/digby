/**
 * embed-backfill.service.ts — tests for the memory-embed-backfill cron
 * (ticket d7bf73c2: unified-memory embeds dropped to keyword-only under
 * DashScope 429 throttling and never backfilled).
 *
 * This file is the ticket's REPLAY TEST: it replays the production incident
 * (a 429'd embed batch landing NULL rows) and asserts the repair path fills
 * them. References ticket d7bf73c2.
 */
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    $executeRawUnsafe: jest.fn(async () => 1),
    $queryRawUnsafe: jest.fn(async () => []),
  },
}));
jest.mock('../rag.service', () => ({
  __esModule: true,
  // 2026-11-01: the backfill now embeds through a PINNED spec
  // (embedTextsForSpec), not the seat-following embedTexts — so the repair
  // keeps working while the embeddings SEAT is the broken thing, and it can
  // never write into a different vector space than the corpus.
  embedTextsForSpec: jest.fn(async () => [[0.1, 0.2, 0.3]]),
  authoritativeEmbedTargetSpec: jest.fn(() => 'dashscope:text-embedding-v4'),
  embedTexts: jest.fn(async () => [[0.1, 0.2, 0.3]]),
  embeddingsBackendConfigured: jest.fn(async () => true),
}));
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import prisma from '../../../config/database';
import { embedTextsForSpec } from '../rag.service';
import {
  runMemoryEmbedBackfillOnce, backfillDisabled, backfillBatchSize, backfillMaxAgeDays,
  BACKFILL_BATCH_SIZE_DEFAULT, BACKFILL_MAX_AGE_DAYS_DEFAULT, __resetBackfillCooldownForTests,
  BACKFILL_REJECT_COOLDOWN_MS_DEFAULT, SOURCE,
} from './embed-backfill.service';
import { describeEmbedFailure } from './embed-failure';

const NOW = new Date('2026-10-17T04:00:00Z');
/** A NULL-embedding row as the scan returns it (created 1h ago — inside the window). */
const nullRow = (id: string, hoursOld = 1): { id: string; title: string | null; content: string; createdAt: Date } => ({
  id, title: 't', content: 'c', createdAt: new Date(NOW.getTime() - hoursOld * 3_600_000),
});

const mockQuery = prisma.$queryRawUnsafe as jest.Mock;
const mockExec = prisma.$executeRawUnsafe as jest.Mock;
const mockEmbed = embedTextsForSpec as jest.Mock;

describe('runMemoryEmbedBackfillOnce — the repair cron (ticket d7bf73c2)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __resetBackfillCooldownForTests();
    delete process.env.MEMORY_EMBED_BACKFILL_DISABLED;
    mockExec.mockResolvedValue(1);
    mockQuery.mockResolvedValue([]);
    mockEmbed.mockResolvedValue([[0.1, 0.2, 0.3]]);
  });

  it('re-embeds NULL rows and writes vectors in place, oldest first, batch-bounded', async () => {
    // The scan returns rows in created_at ASC order (the SQL contract) —
    // oldest first, so the summary's "oldest" reads off rows[0].
    mockQuery.mockResolvedValue([nullRow('r3', 2), nullRow('r1'), nullRow('r2')]);
    const summary = await runMemoryEmbedBackfillOnce({ now: NOW });
    expect(summary).toContain('scanned 3 embedded 3 failed 0');
    expect(summary).toContain('oldest 2h');
    // One embed call per row, the title embedded WITH the content (memStore mirror).
    expect(mockEmbed).toHaveBeenCalledTimes(3);
    // embedTextsForSpec(spec, texts, opts) — the PINNED spec comes first.
    for (const call of mockEmbed.mock.calls) {
      expect(call[0]).toBe('dashscope:text-embedding-v4');
      expect(call[1][0]).toBe('t\nc');
    }
    // Vector written in place, guarded by AND embedding IS NULL.
    expect(mockExec).toHaveBeenCalledTimes(3);
    for (const call of mockExec.mock.calls) {
      expect(call[0]).toContain('UPDATE digby_memory SET embedding = $2::vector WHERE id = $1 AND embedding IS NULL');
    }
  });

  it('the scan window: ≥10 min old (never races an in-call 429 backoff), ≤ max-age, ascending', async () => {
    mockQuery.mockResolvedValue([]);
    await runMemoryEmbedBackfillOnce({ now: NOW });
    const [sql, maxAgeCutoff, minAgeCutoff, limit] = mockQuery.mock.calls[0];
    expect(sql).toContain('WHERE embedding IS NULL');
    expect(sql).toContain('ORDER BY created_at ASC LIMIT $3');
    expect(limit).toBe(BACKFILL_BATCH_SIZE_DEFAULT);
    expect(maxAgeCutoff).toEqual(new Date(NOW.getTime() - BACKFILL_MAX_AGE_DAYS_DEFAULT * 86_400_000));
    expect(minAgeCutoff).toEqual(new Date(NOW.getTime() - 10 * 60_000));
  });

  it('a transient embed failure leaves the row NULL (the next tick retries) and counts failed', async () => {
    mockQuery.mockResolvedValue([nullRow('r1')]);
    mockEmbed.mockRejectedValueOnce(Object.assign(new Error('Request failed with status code 503'), { response: { status: 503, data: {} } }));
    const summary = await runMemoryEmbedBackfillOnce({ now: NOW });
    expect(summary).toContain('embedded 0 failed 1');
    expect(mockExec).not.toHaveBeenCalled();
    // No cooldown for a transient cause — the next tick retries the row.
    const summary2 = await runMemoryEmbedBackfillOnce({ now: NOW });
    expect(summary2).toContain('cooldown 0');
  });

  it('a provider-REJECTED row goes on the cooldown — one call per hour, not per tick', async () => {
    mockQuery.mockResolvedValue([nullRow('r1')]);
    const rejection = Object.assign(new Error('Request failed with status code 400'), { response: { status: 400, data: { code: 'DataInspectionFailed', message: 'inappropriate content' } } });
    mockEmbed.mockRejectedValue(rejection);
    await runMemoryEmbedBackfillOnce({ now: NOW });
    expect(mockEmbed).toHaveBeenCalledTimes(1);
    // Next tick, same row still NULL: skipped by the cooldown, NO new call.
    await runMemoryEmbedBackfillOnce({ now: new Date(NOW.getTime() + 15 * 60_000) });
    expect(mockEmbed).toHaveBeenCalledTimes(1);
    // After the cooldown expires the row is retried again.
    await runMemoryEmbedBackfillOnce({ now: new Date(NOW.getTime() + BACKFILL_REJECT_COOLDOWN_MS_DEFAULT + 60_000) });
    expect(mockEmbed).toHaveBeenCalledTimes(2);
  });

  it('a 429 during backfill is transient: NO cooldown, and the row retries next tick', async () => {
    mockQuery.mockResolvedValue([nullRow('r1')]);
    mockEmbed.mockRejectedValue(Object.assign(new Error('Request failed with status code 429'), { response: { status: 429, data: { code: 'Throttling', message: 'Too many requests' } } }));
    await runMemoryEmbedBackfillOnce({ now: NOW });
    await runMemoryEmbedBackfillOnce({ now: new Date(NOW.getTime() + 15 * 60_000) });
    expect(mockEmbed).toHaveBeenCalledTimes(2); // retried — a throttle never poisons the row
  });

  it('a zero-row UPDATE (another writer filled it first) counts as a success, not a failure', async () => {
    mockQuery.mockResolvedValue([nullRow('r1')]);
    mockExec.mockResolvedValueOnce(0);
    const summary = await runMemoryEmbedBackfillOnce({ now: NOW });
    expect(summary).toContain('embedded 1 failed 0');
  });

  it('a malformed provider answer (no vector) counts failed and never writes SQL', async () => {
    mockQuery.mockResolvedValue([nullRow('r1')]);
    mockEmbed.mockResolvedValueOnce([null] as any);
    const summary = await runMemoryEmbedBackfillOnce({ now: NOW });
    expect(summary).toContain('embedded 0 failed 1');
    expect(mockExec).not.toHaveBeenCalled();
  });

  it('the kill switch short-circuits before any query or embed', async () => {
    process.env.MEMORY_EMBED_BACKFILL_DISABLED = '1';
    expect(await runMemoryEmbedBackfillOnce({ now: NOW })).toContain('disabled');
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockEmbed).not.toHaveBeenCalled();
  });

  it('a missing table / DB fault is quiet and non-fatal (the next tick retries)', async () => {
    mockQuery.mockRejectedValue(new Error('relation "digby_memory" does not exist'));
    const summary = await runMemoryEmbedBackfillOnce({ now: NOW });
    expect(summary).toContain('scan skipped');
    expect(mockEmbed).not.toHaveBeenCalled();
  });

  it('the summary is bounded to 200 chars (cron_jobs.lastStatus)', async () => {
    mockQuery.mockResolvedValue([]);
    const summary = await runMemoryEmbedBackfillOnce({ now: NOW });
    expect(summary.length).toBeLessThanOrEqual(200);
  });
});

describe('backfill env knobs', () => {
  it('batch size clamps to [1,200]; max-age defaults and honours the env', () => {
    expect(backfillDisabled({})).toBe(false);
    expect(backfillDisabled({ MEMORY_EMBED_BACKFILL_DISABLED: '1' })).toBe(true);
    expect(backfillBatchSize({})).toBe(BACKFILL_BATCH_SIZE_DEFAULT);
    expect(backfillBatchSize({ MEMORY_EMBED_BACKFILL_BATCH_SIZE: '200' })).toBe(200);
    expect(backfillBatchSize({ MEMORY_EMBED_BACKFILL_BATCH_SIZE: '999' })).toBe(200);
    expect(backfillBatchSize({ MEMORY_EMBED_BACKFILL_BATCH_SIZE: 'nope' })).toBe(BACKFILL_BATCH_SIZE_DEFAULT);
    expect(backfillMaxAgeDays({})).toBe(BACKFILL_MAX_AGE_DAYS_DEFAULT);
    expect(backfillMaxAgeDays({ MEMORY_EMBED_BACKFILL_MAX_AGE_DAYS: '30' })).toBe(30);
  });
});

describe('the incident replay (ticket d7bf73c2) — a 429’d store lands NULL rows, the cron repairs them', () => {
  it('end-to-end: throttle-exhausted batch rows are NULL, and runMemoryEmbedBackfillOnce fills them within one tick', async () => {
    // 1. The incident shape: 7 rows, every batch call 429s, in-call retries exhausted.
    const { embedRowsWithRetry } = await import('./embed-failure');
    let calls = 0;
    const throttled = jest.fn(async () => {
      calls++;
      throw Object.assign(new Error('Request failed with status code 429'), { response: { status: 429, data: { code: 'Throttling', message: 'Too many requests' } } });
    });
    const r = await embedRowsWithRetry(['a', 'b', 'c', 'd', 'e', 'f', 'g'], throttled, { retryMax: 20, rateLimitRetries: 2 });
    expect(calls).toBe(3); // 1 + 2 retries
    expect(r.embeddings.every(e => e === null)).toBe(true);
    expect(describeEmbedFailure(Object.assign(new Error('m'), { response: { status: 429, data: {} } })).kind).toBe('http_4xx');

    // 2. Those rows land in digby_memory with embedding NULL (memStore's else-branch).
    // 3. The cron — one tick, throttle window closed — fills every one.
    mockQuery.mockResolvedValue(['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((_, i) => nullRow(`r${i}`, 1)));
    mockEmbed.mockClear();
    mockEmbed.mockResolvedValue([[0.1, 0.2, 0.3]]);
    mockExec.mockClear();
    const summary = await runMemoryEmbedBackfillOnce({ now: new Date(NOW.getTime() + 15 * 60_000) });
    expect(summary).toContain('scanned 7 embedded 7 failed 0');
    expect(mockExec).toHaveBeenCalledTimes(7);
  });
});

describe('throttle-stop and tick deadline (adversarial review 2bae74f9, round-1 F2 + round-2 follow-up 4)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __resetBackfillCooldownForTests();
    delete process.env.MEMORY_EMBED_BACKFILL_DISABLED;
    mockExec.mockResolvedValue(1);
    mockQuery.mockResolvedValue([]);
    mockEmbed.mockResolvedValue([[0.1, 0.2, 0.3]]);
  });

  const throttle = Object.assign(new Error('Request failed with status code 429'), { response: { status: 429, data: { code: 'Throttling', message: 'Too many requests' } } });

  it('a 429 mid-tick STOPS the row loop — the cron never feeds the throttle it repairs', async () => {
    mockQuery.mockResolvedValue([nullRow('r1'), nullRow('r2'), nullRow('r3'), nullRow('r4')]);
    // First row succeeds, second 429s: the remaining two rows must NOT be called.
    mockEmbed
      .mockResolvedValueOnce([[0.1, 0.2, 0.3]])
      .mockRejectedValueOnce(throttle);
    const summary = await runMemoryEmbedBackfillOnce({ now: NOW });
    expect(summary).toContain('scanned 4 embedded 1 failed 1');
    expect(summary).toContain('stopped 2');
    expect(mockEmbed).toHaveBeenCalledTimes(2); // the loop broke — rows r3/r4 ride the next tick
    // And the throttle does NOT poison the rows: no cooldown, next tick retries.
    expect(summary).toContain('cooldown 0');
    mockEmbed.mockClear();
    mockEmbed.mockResolvedValue([[0.1, 0.2, 0.3]]);
    await runMemoryEmbedBackfillOnce({ now: new Date(NOW.getTime() + 15 * 60_000) });
    expect(mockEmbed).toHaveBeenCalledTimes(4);
  });

  it('the tick deadline stops the row loop before the cron lease lapses (worst case bounded to 8 min < 10-min lease)', async () => {
    mockQuery.mockResolvedValue([nullRow('r1'), nullRow('r2'), nullRow('r3')]);
    mockEmbed.mockImplementation(async () => {
      // DETERMINISTIC margins, both directions (CI flake fix, 2026-10-19: the
      // old shape — deadline 0 + a 5 ms embed — raced on loaded runners; ONE
      // real millisecond between tickStart and the first deadline check — an
      // await of the mocked prisma scan sits between them — stopped ALL rows
      // and the pin read "Expected 1 call, Received 0"; shard 1/4 failed twice
      // in a row on PR #1784 while passing on main): the first row's check runs
      // a few microtask hops after tickStart (<< 100 ms even under load), while
      // after ONE 250 ms embed the elapsed time necessarily exceeds the 100 ms
      // deadline — so exactly the first row embeds and the rest are stopped.
      await new Promise(r => setTimeout(r, 250));
      return [[0.1, 0.2, 0.3]];
    });
    const summary = await runMemoryEmbedBackfillOnce({ now: NOW, tickDeadlineMs: 100 });
    expect(mockEmbed).toHaveBeenCalledTimes(1); // the first row finished; the rest are deadline-stopped
    expect(summary).toContain('stopped 2');
  });
});

describe('rejectCooldown prune (round-2 follow-up 5)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __resetBackfillCooldownForTests();
    delete process.env.MEMORY_EMBED_BACKFILL_DISABLED;
    mockExec.mockResolvedValue(1);
    mockQuery.mockResolvedValue([]);
    mockEmbed.mockResolvedValue([[0.1, 0.2, 0.3]]);
  });

  it('expired entries are pruned at the START of a pass (the map stays bounded across long-lived processes)', async () => {
    // Put one row on the cooldown via a provider rejection two hours ago.
    mockQuery.mockResolvedValue([nullRow('r1')]);
    mockEmbed.mockRejectedValue(Object.assign(new Error('Request failed with status code 400'), { response: { status: 400, data: { code: 'DataInspectionFailed', message: 'inappropriate content' } } }));
    await runMemoryEmbedBackfillOnce({ now: new Date(NOW.getTime() - 2 * 3_600_000) });
    expect(mockEmbed).toHaveBeenCalledTimes(1);
    // Two hours later the entry is expired: the prune deletes it and the row is
    // ELIGIBLE again (same behaviour as before the prune — expiry worked lazily
    // too; this pins that the prune makes no functional difference, only bounds the map).
    mockEmbed.mockClear();
    mockEmbed.mockResolvedValue([[0.1, 0.2, 0.3]]);
    await runMemoryEmbedBackfillOnce({ now: NOW });
    expect(mockEmbed).toHaveBeenCalledTimes(1);
    expect(SOURCE).toBe('memory-embed-backfill');
  });
});
