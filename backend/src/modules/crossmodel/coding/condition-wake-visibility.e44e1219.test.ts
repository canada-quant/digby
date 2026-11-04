/**
 * Ticket e44e1219 — condition-wake observability tests (REPLAY: the reported
 * mishap, verbatim). A supervisor verifying a lane's "condition wake
 * registered (backstop HH:MMZ)" claim must see the wake in get_chat_status
 * (the probe they already use) and in get_run_receipts (the receipt a
 * registration now mints). The prod specimens (2026-10-24, quoted from the
 * read-only box probe):
 *   store row  fd5159ce…:deploy:canada-quant/digby@b100c529973c
 *              createdAt 03:02:34.886Z, horizonAt 06:02:34.886Z, checks 7
 *   tool text  "Registered a CONDITION WAKE: the harness re-checks every 15 min
 *              and wakes this chat with [CONDITION MET — …]; backstop wake at
 *              06:02Z."
 *   supervisor probe BEFORE the fix: get_chat_status schedules.enabled=0
 *              → (wrongly) "no wake exists".
 */
import { extractReceipt, CONDITION_WAKE_RECEIPT_TOOLS_SET, RECEIPT_TOOLS, receiptMatchesClaim } from './run-receipts';
import { listOpenConditionWakesForChat } from './condition-wake-visibility';

jest.mock('../memory/context-store', () => ({
  storeListNamespace: jest.fn(),
}));

const { storeListNamespace } = jest.requireMock('../memory/context-store') as { storeListNamespace: jest.Mock };

const CHAT = 'fd5159ce-74bb-461f-b6ea-b3ac2f488237';

function row(key: string, value: Record<string, unknown>, createdAt: Date): { key: string; value: Record<string, unknown>; createdAt: Date; updatedAt: Date | null } {
  return { key, value, createdAt, updatedAt: createdAt };
}

describe('ticket e44e1219: condition wakes become supervisor-visible', () => {
  beforeEach(() => {
    storeListNamespace.mockReset();
  });

  describe('get_chat_status conditionWakes (listOpenConditionWakesForChat)', () => {
    // The replayed specimen below has horizonAt 2026-10-24T06:02:34.886Z.
    // Freeze the clock between its createdAt (03:02Z) and horizon (06:02Z) so
    // the row is OPEN no matter when this suite runs — pre-fix this was a
    // time bomb: it expired at 06:02Z on 2026-10-24 and the suite went red on
    // every branch thereafter (the filter drops past-horizon rows by design).
    beforeEach(() => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2026-10-24T04:00:00.000Z'));
    });
    afterEach(() => {
      jest.useRealTimers();
    });

    it('surfaces the lane\u2019s OPEN wake with its horizon — the "backstop 06:02Z" claim becomes verifiable', async () => {
      // The exact prod row shape (probe 2026-10-24: value.v exists, spec.kind/repo/sha).
      // horizonAt must be runtime-FUTURE: listOpenConditionWakesForChat drops
      // rows whose horizon has passed (the backstop owns the tail), so the
      // prod-copied '2026-10-24T06:02:34.886Z' went stale at that wall-clock
      // instant and red-lit every later CI run (observed 2026-10-24 07:11Z,
      // run 40072429081 shard 4/4 — the fixed-clock time-bomb class).
      const horizonAt = new Date(Date.now() + 3 * 3600_000).toISOString();
      storeListNamespace.mockResolvedValue([
        row(
          `${CHAT}:deploy:canada-quant/digby@b100c529973c`,
          {
            v: 1,
            spec: { sha: 'b100c529973c', kind: 'deploy', repo: 'digby', owner: 'canada-quant' },
            chatId: CHAT,
            createdAt: '2026-10-24T03:02:34.886Z',
            horizonAt,
            checks: 7,
            lastSummary: 'Deploy run 40055858118 (Deploy to AWS EC2) for b100c529973c is in_progress.',
            backstopHookEventId: '0d0d188f-25b5-4490-8661-b05254ad7a01',
          },
          new Date('2026-10-24T03:02:34.900Z'),
        ),
      ]);
      const wakes = await listOpenConditionWakesForChat(CHAT);
      expect(wakes).toHaveLength(1);
      expect(wakes[0].condition).toBe('deploy');
      expect(wakes[0].repo).toBe('canada-quant/digby');
      expect(wakes[0].sha).toBe('b100c529973c');
      expect(wakes[0].horizonAt).toBe(horizonAt);
      expect(wakes[0].checks).toBe(7);
      expect(wakes[0].summary).toMatch(/deploy of canada-quant\/digby@b100c529973c concluded/);
    });

    it('filters to THIS chat (other lanes\u2019 wakes are not mine) and skips rows past their horizon', async () => {
      storeListNamespace.mockResolvedValue([
        row('65ab3672-0000-0000-0000-000000000000:deploy:canada-quant/digby@deadbeef123', { spec: { kind: 'deploy', owner: 'canada-quant', repo: 'digby', sha: 'deadbeef123' }, horizonAt: '2999-01-01T00:00:00.000Z' }, new Date()),
        row(`${CHAT}:ci:canada-quant/digby@1234abcdef0`, { spec: { kind: 'ci', owner: 'canada-quant', repo: 'digby', sha: '1234abcdef0' }, horizonAt: '2000-01-01T00:00:00.000Z' }, new Date()),
      ]);
      const wakes = await listOpenConditionWakesForChat(CHAT);
      // The other chat's row is filtered; the past-horizon row is skipped
      // (the backstop owns the tail — surfacing it would resurrect stale state).
      expect(wakes).toHaveLength(0);
    });

    it('degrades to [] on a store failure — visibility never breaks the status read', async () => {
      storeListNamespace.mockRejectedValue(new Error('store down'));
      await expect(listOpenConditionWakesForChat(CHAT)).resolves.toEqual([]);
    });
  });

  describe('await_condition registration mints a receipt', () => {
    const ARGS = { condition: 'deploy', repo: 'canada-quant/digby', sha: 'b100c529973c' };

    it('the not-met answer ("Registered a CONDITION WAKE: …") mints ok:true with the condition identity', () => {
      const text = 'CONDITION NOT MET after 600s (deploy of canada-quant/digby@b100c529973c concluded) — last read: Deploy run 40055858118 is in_progress.\n'
        + 'Registered a CONDITION WAKE: the harness re-checks every 15 min and wakes this chat with [CONDITION MET — …]; backstop wake at 06:02Z. '
        + 'This run is ending — write a one-line status and stop; do not poll.';
      const r = extractReceipt('await_condition', ARGS, text, new Date());
      expect(r).not.toBeNull();
      expect(r!.ok).toBe(true);
      expect(r!.ids).toMatchObject({ condition: 'deploy', repo: 'canada-quant/digby', sha: 'b100c529973c' });
    });

    it('the end-turn notice ("registered a CONDITION WAKE for: …") also mints ok:true', () => {
      const text = '[HARNESS — WAITING ON A CONDITION] await_condition registered a CONDITION WAKE for: deploy of canada-quant/digby@b100c529973c concluded. '
        + 'The harness re-checks it every 15 min and wakes this chat with [CONDITION MET — …] the moment it is met (backstop wake at 06:02Z if it never is).';
      const r = extractReceipt('await_condition', ARGS, text, new Date());
      expect(r).not.toBeNull();
      expect(r!.ok).toBe(true);
    });

    it('a met-in-tool answer registered NO wake — ok:false (the call ran; nothing was armed)', () => {
      const text = 'CONDITION MET (deploy of canada-quant/digby@b100c529973c concluded; waited 240s harness-side, deadline-shielded): Deploy run 40055858118 for b100c529973c concluded SUCCESS.';
      const r = extractReceipt('await_condition', ARGS, text, new Date());
      expect(r).not.toBeNull();
      expect(r!.ok).toBe(false);
      expect(r!.ids).toMatchObject({ condition: 'deploy', repo: 'canada-quant/digby', sha: 'b100c529973c' });
    });

    it('a thrown / aborted / refusal head is not-executed: ok:false with the identity kept', () => {
      for (const head of ['Tool await_condition failed: GitHub API 502', 'Tool "await_condition" exceeded 600s and was aborted.']) {
        const r = extractReceipt('await_condition', ARGS, head, new Date());
        expect(r).not.toBeNull();
        expect(r!.ok).toBe(false);
      }
    });
  });

  describe('a wait receipt never launders a completion claim', () => {
    it('await_condition is NOT a RECEIPT_TOOLS member (no intent / claim-class membership)', () => {
      expect(RECEIPT_TOOLS.has('await_condition')).toBe(false);
      expect(CONDITION_WAKE_RECEIPT_TOOLS_SET.has('await_condition')).toBe(true);
    });

    it('receiptMatchesClaim: an ok wake receipt vouches NO deploy / pr_created / commit claim', () => {
      const wake = {
        id: 'r1', chatId: 'c1', runId: null, tool: 'await_condition', ok: true,
        ids: { condition: 'deploy', repo: 'canada-quant/digby', sha: 'b100c529973c' },
        inputHash: 'x', outputHash: 'y', createdAt: new Date(),
      } as any;
      expect(receiptMatchesClaim({ kind: 'deploy', text: 'deploy 40055858118 concluded success' }, [wake])).toBe(false);
      expect(receiptMatchesClaim({ kind: 'pr_created', prNumber: 1932 }, [wake])).toBe(false);
      expect(receiptMatchesClaim({ kind: 'commit_pushed', sha: 'b100c529973c' }, [wake])).toBe(false);
      expect(receiptMatchesClaim({ kind: 'probe', text: 'lane FD verified' }, [wake])).toBe(false);
    });
  });
});
