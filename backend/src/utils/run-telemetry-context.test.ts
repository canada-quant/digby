/**
 * Audit 2026-10-06 T6-4 (crosscutting X7) — the ambient chat-turn telemetry run
 * id: the leaf, the logger format that stamps it, and the loop_metrics row
 * builder that fills it (platform/loop-metrics.service toRow). The chat-lane
 * wiring (one id per turn == its run_spend runId) is pinned in
 * chat-agent.service.test.ts ("T6-4").
 */
jest.mock('../config/env', () => ({ env: { NODE_ENV: 'test' } }));
const mockCreateMany: jest.Mock = jest.fn(async () => ({ count: 0 }));
jest.mock('../config/database', () => ({ __esModule: true, default: { loopMetric: { createMany: (...a: any[]) => mockCreateMany(...a) }, appErrorLog: { create: jest.fn(async () => ({})) } } }));

import {
  ambientTelemetryRunId, bindTelemetryRunSession, chatRunTelemetryIdDisabled, currentTelemetryRunId, runWithTelemetryRun,
} from './run-telemetry-context';
import { stampTelemetryRun } from './logger';
import { flushLoopMetrics, recordLoopMetric } from '../modules/crossmodel/platform/loop-metrics.service';

beforeEach(() => {
  delete process.env.CHAT_RUN_TELEMETRY_ID_DISABLED;
  mockCreateMany.mockClear();
});

describe('run-telemetry-context', () => {
  it('fills only inside a turn, only for the turn\'s own session; the session can be bound late (chatless / guest)', async () => {
    expect(ambientTelemetryRunId('chat-1')).toBeUndefined();
    await runWithTelemetryRun({ runId: 'chat-run-1', sessionId: 'chat-1' }, async () => {
      await new Promise((r) => setTimeout(r, 1)); // survives an async hop
      expect(ambientTelemetryRunId('chat-1')).toBe('chat-run-1');
      expect(ambientTelemetryRunId('chat-2')).toBeUndefined();
      expect(ambientTelemetryRunId(undefined)).toBeUndefined();
      expect(currentTelemetryRunId()).toBe('chat-run-1');
    });
    runWithTelemetryRun({ runId: 'chat-run-2', sessionId: null }, () => {
      expect(ambientTelemetryRunId('anon-x')).toBeUndefined();
      bindTelemetryRunSession('anon-x');
      bindTelemetryRunSession('anon-y'); // first bind wins
      expect(ambientTelemetryRunId('anon-x')).toBe('chat-run-2');
      expect(ambientTelemetryRunId('anon-y')).toBeUndefined();
    });
    // nested turns shadow the outer one
    runWithTelemetryRun({ runId: 'outer', sessionId: 'a' }, () => {
      runWithTelemetryRun({ runId: 'inner', sessionId: 'b' }, () => {
        expect(ambientTelemetryRunId('a')).toBeUndefined();
        expect(ambientTelemetryRunId('b')).toBe('inner');
      });
      expect(ambientTelemetryRunId('a')).toBe('outer');
    });
  });

  it('CHAT_RUN_TELEMETRY_ID_DISABLED=1 ⇒ nothing is filled (read per call)', () => {
    runWithTelemetryRun({ runId: 'chat-run-1', sessionId: 'chat-1' }, () => {
      process.env.CHAT_RUN_TELEMETRY_ID_DISABLED = '1';
      expect(chatRunTelemetryIdDisabled()).toBe(true);
      expect(ambientTelemetryRunId('chat-1')).toBeUndefined();
      expect(currentTelemetryRunId()).toBeUndefined();
    });
  });
});

describe('logger stampTelemetryRun format', () => {
  const fmt = stampTelemetryRun();
  it('a record of the turn\'s session with no runId (or runId: undefined) takes the turn id; an explicit runId and another session are left alone', () => {
    runWithTelemetryRun({ runId: 'chat-run-1', sessionId: 'chat-1' }, () => {
      expect((fmt.transform({ level: 'warn', message: 'coding tool x failed', sessionId: 'chat-1', runId: undefined }) as any).runId).toBe('chat-run-1');
      expect((fmt.transform({ level: 'warn', message: 'm', sessionId: 'chat-1', runId: 'agent-run-7' }) as any).runId).toBe('agent-run-7');
      expect((fmt.transform({ level: 'warn', message: 'm', sessionId: 'chat-2' }) as any).runId).toBeUndefined();
      expect((fmt.transform({ level: 'warn', message: 'm', source: 'chat-agent' }) as any).runId).toBeUndefined();
    });
    expect((fmt.transform({ level: 'warn', message: 'm', sessionId: 'chat-1' }) as any).runId).toBeUndefined();
  });
});

describe('loop_metrics rows (toRow)', () => {
  it('a row with no runId recorded inside the turn for its own session carries the turn id; explicit / other-session / outside rows are unchanged; the kill switch restores null', async () => {
    runWithTelemetryRun({ runId: 'chat-run-1', sessionId: 'chat-1' }, () => {
      recordLoopMetric({ kind: 'context_compaction', sessionId: 'chat-1', value: 5 });
      recordLoopMetric({ kind: 'guard_strike', sessionId: 'chat-1', runId: 'agent-run-7' });
      recordLoopMetric({ kind: 'hook_delivery', sessionId: 'lane-9' });
      process.env.CHAT_RUN_TELEMETRY_ID_DISABLED = '1';
      recordLoopMetric({ kind: 'context_compaction', sessionId: 'chat-1', value: 6 });
      delete process.env.CHAT_RUN_TELEMETRY_ID_DISABLED;
    });
    recordLoopMetric({ kind: 'context_compaction', sessionId: 'chat-1', value: 7 });
    await flushLoopMetrics();
    const rows = (mockCreateMany.mock.calls as any[]).flatMap((c) => c[0].data);
    expect(rows.map((r: any) => [r.kind, r.sessionId, r.runId])).toEqual([
      ['context_compaction', 'chat-1', 'chat-run-1'],
      ['guard_strike', 'chat-1', 'agent-run-7'],
      ['hook_delivery', 'lane-9', null],
      ['context_compaction', 'chat-1', null],
      ['context_compaction', 'chat-1', null],
    ]);
  });
});
