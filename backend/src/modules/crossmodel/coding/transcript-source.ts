/**
 * The transcript READ-SWITCH seam — a LEAF module (MERGE-1 slice 1).
 *
 * Why this file exists at all: `coding-data.service.ts` is a 1,300-line module that
 * imports `middleware/error-handler` -> `config/env`, which calls `process.exit(1)` at
 * import time when the env is not fully populated. That is harmless for production and
 * for suites that mock it, but it makes coding-data.service a hostile import for the
 * ~24 `schedule*.test.ts` suites, which reach `firing-superseded-gate` transitively and
 * never expected that edge. Routing the six former bypass readers through
 * coding-data.service would have turned one legitimate change into 24 test patches.
 *
 * So the switch predicates + the source picker live here as a LEAF module, and
 * `coding-data.service` re-exports them unchanged. Every caller that resolved a
 * transcript table keeps calling the SAME function names.
 *
 * The functions are MOVED, not rewritten: `coding-data.service.ts` remains their single
 * documented owner in the plan (`pickTranscriptSource`), and it re-exports from here.
 *
 * Slice 3 (2026-11-02) removed this module's last `prisma`/`logger` use when the
 * per-chat legacy fallback was retired, so it no longer imports either — it is a pure
 * predicate module now, which is the lightest possible version of the seam.
 */
export type TranscriptSource = 'merged' | 'legacy';

/** Dual-write gate — read per call so ops/tests can toggle without a restart. */
export function transcriptDualWriteEnabled(): boolean {
  return process.env.TRANSCRIPT_DUAL_WRITE !== 'off';
}

/** Read-switch: 'merged' (default) serves crossmodel_messages; 'legacy' forces coding_messages. */
export function transcriptReadMode(): 'merged' | 'legacy' {
  return process.env.TRANSCRIPT_READ === 'legacy' ? 'legacy' : 'merged';
}

/**
 * Which table serves this chat's transcript under the read-switch.
 *
 * MERGE-1 slice 3 (2026-11-02): the per-chat legacy fallback is RETIRED. Until now a
 * chat with legacy rows but ZERO mirrored rows was served from `coding_messages` and
 * logged a warn. That fallback is gone: `merged` now reads the mirror for every chat,
 * unconditionally, and only the release-level `TRANSCRIPT_READ=legacy` switch can
 * route a read to the legacy table.
 *
 * It was retired only after the fleet-wide subset check proved `totalMissingRows === 0`
 * — every legacy message already has a mirror row in the SAME chat — because retiring
 * it ahead of that would make an unmirrored transcript permanently unreadable.
 * `TRANSCRIPT_READ=legacy` remains the one-release rollback until the drop.
 *
 * MERGE-1 slice 1 routed six bypass readers through this seam — firing-superseded-gate,
 * run-executor's steer-adoption count, run-reaper's activity probe,
 * session-history-sync's transcript, session-status's previous card, and the
 * agent_events retention lateral. This is the existing seam, not a new abstraction.
 */
export async function pickTranscriptSource(_chatId: string): Promise<TranscriptSource> {
  return transcriptReadMode();
}