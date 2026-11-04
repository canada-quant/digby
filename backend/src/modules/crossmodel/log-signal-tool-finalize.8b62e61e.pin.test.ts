/**
 * Characterization pin — log-signal family lane a800a12d (2026-11-01), ticket
 * 8b62e61e. This is the family's FIFTH member and it is a DIFFERENT concern
 * from the four news members (those are pinned in
 * news-log-signal.a800a12d.pin.test.ts): one defective taxonomy at the news
 * formatter ladder vs. a documented DIAGNOSTIC at the tool-call finalize seam.
 *
 * ADJUDICATION: 8b62e61e is a SIBLING of the efdb3d31 emission-side-cut class —
 * NOT a distinct defect, and NOT "cured". It is also NOT a rename artifact
 * (unlike its sibling c18badad, adjudicated in log-signal-family.c3bc6ee2):
 * this ticket's fingerprint matches the CURRENT, post-#2096 wording exactly, so
 * a zero for its named model is a QUIET SEAT, not a fixed line.
 *
 * The live evidence at adjudication time (get_fleet_telemetry view 'errors',
 * hours 24, serving build b2050228):
 *   - the exact fragment `tool-call stream [api-optimize-xiaomi-mimo-v` -> 0 rows;
 *   - the same wording -> 5 rows/24 h under DIFFERENT providers
 *     (moonshot-kimi-k3 ×2, alibaba-deepseek-v4.1-flash ×3).
 * So the emit path is alive and model-agnostic; only the xiaomi-mimo seat was
 * quiet in the window. This pin exists so a future pass cannot read that
 * provider-scoped zero as "fixed", and cannot "fix" the one diagnostic that
 * separates an output-cap cut from a severed head (see
 * .digby/rules/00-current-state.md: "NEVER close f3e56567 nor efdb3d31 on it").
 *
 * THIS PIN asserts: (a) the ticket's fingerprint REPRODUCES from the live row
 * shape through the SHIPPED normalizer (so the line is current, not renamed),
 * (b) it is NOT the old c18badad wording, (c) the seam still emits through
 * finalizeVerdictSummary at warn with the run-model-turn source and still
 * writes the durable TOOL_CALL_FINALIZE metric row, and (d) the volume shape is
 * BOUNDED per attempt (the settled guard settles a turn's stream once), i.e.
 * one diagnostic per failed finalize — not a retry storm.
 */

jest.mock('../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// log-signal-sweep.service imports config/database, whose env schema
// process.exit(1)s in a keyless test environment — mock it out like the
// sibling log-signal-family.c3bc6ee2 pin does.
const mockPrisma: any = {
  crossModelMessage: { create: jest.fn(async () => ({})), findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  crossModelChat: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  chatCodingState: { findFirst: jest.fn(async () => null) },
  codingSchedule: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  userFeatureRequest: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  projectGoal: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  projectTodo: { findFirst: jest.fn(async () => null), findMany: async () => [] },
  appErrorLog: { findMany: jest.fn(async () => []) },
};
jest.mock('../../config/database', () => ({ __esModule: true, default: mockPrisma }));

jest.mock('../../config/redis', () => ({
  __esModule: true,
  default: { get: jest.fn(async () => null), set: jest.fn(async () => 'OK'), del: jest.fn(async () => 1), keys: jest.fn(async () => []) },
  redis: { get: jest.fn(async () => null), set: jest.fn(async () => 'OK'), del: jest.fn(async () => 1), keys: jest.fn(async () => []) },
}));

import * as fs from 'fs';
import * as path from 'path';

import { diagnoseToolCallFinalize } from './coding/tool-arguments';
import { finalizeVerdictSummary } from './coding/tool-call-finalize-meta';
import { FINGERPRINT_MAX_LEN, normalizeLogMessage } from './fleet/log-signal-sweep.service';

const BACKEND_SRC = path.resolve(__dirname, '../..');
function read(rel: string): string {
  return fs.readFileSync(path.join(BACKEND_SRC, rel), 'utf8').replace(/\r\n/g, '\n');
}

/**
 * The ticket's fingerprint, verbatim from the filed report (already normalized
 * by the sweep: lowercased, every number -> `<n>`, capped at 120 chars).
 */
const TICKET_FINGERPRINT =
  'tool-call stream [api-optimize-xiaomi-mimo-v<n>-pro]: gateway-or-ours gateway recv=<n> acc=<n> drop=<n> frag=<n> buf=<n>';

/**
 * The live row this ticket fingerprinted (its example raw message), rebuilt as
 * the seam would actually render it. Numbers are per-event, so the
 * normalized fingerprint must be invariant to them.
 */
const liveRow = (n: number) =>
  `tool-call stream [api-optimize-xiaomi-mimo-v2.6-pro]: GATEWAY-OR-OURS ` +
  finalizeVerdictSummary({
    receivedBytes: n,
    accumulatedBytes: n,
    droppedBytes: 0,
    fragments: 25,
    undrainedBufferBytes: 0,
    finishReason: 'tool_calls',
    streamCompleted: true,
  }) +
  ` verdict=no_complete_payload — receivedBytes=${n} accumulatedBytes=${n} droppedBytes=0 ` +
  `fragments=25 undrainedBufferBytes=0 finishReason=tool_calls slots=1 named=1 unnamed=0 ` +
  `broken=0:goal_update:len${n}:Unexpected end of JSON input discardedComplete=[] claims=none`;

describe('8b62e61e — the tool-call finalize diagnosis is a documented sibling of efdb3d31, not a rename', () => {
  it('THE REPLAY: the filed fingerprint reproduces from the live row shape (so the line is CURRENT)', () => {
    const fp = normalizeLogMessage(liveRow(134));
    expect(fp.length).toBe(FINGERPRINT_MAX_LEN);
    expect(fp).toBe(TICKET_FINGERPRINT);
  });

  it('the fingerprint is INVARIANT to the per-event numbers (one class, not one per drop)', () => {
    // The sweep normalizes every number to <n>: a different cut length or byte
    // count must land on the SAME fingerprint, or the class could never reach
    // a recurrence bar and every drop would file its own ticket.
    expect(normalizeLogMessage(liveRow(39))).toBe(TICKET_FINGERPRINT);
    expect(normalizeLogMessage(liveRow(67))).toBe(TICKET_FINGERPRINT);
    expect(normalizeLogMessage(liveRow(411))).toBe(TICKET_FINGERPRINT);
  });

  it('it is NOT the c18badad wording — this zero is a quiet seat, not PR #2096\'s rename', () => {
    // c18badad's fingerprint carried `finalize diagnosis`; #2096 renamed THAT
    // line, which is why its literal reads 0 today. Asserting the distinction
    // stops a future pass from applying c18badad's verdict to this ticket.
    expect(TICKET_FINGERPRINT).not.toContain('finalize diagnosis');
    expect(TICKET_FINGERPRINT).toContain('gateway-or-ours');
    expect(TICKET_FINGERPRINT).toContain('recv=<n> acc=<n>');
    // The normalized live row proves the old wording is gone from this emit:
    expect(normalizeLogMessage(liveRow(134))).not.toContain('finalize diagnosis');
  });

  it('the emit site still renders through finalizeVerdictSummary at warn, on the fingerprint wording', () => {
    const src = read('modules/crossmodel/coding/coding-model.ts');
    // The one diagnostic that separates an output-cap cut from a severed head
    // — never "fix" it into silence.
    expect(src).toContain('GATEWAY-OR-OURS ${finalizeVerdictSummary(');
    expect(src).toContain('tool-call stream [${provider.model}]: GATEWAY-OR-OURS');
    expect(src).toContain("source: 'run-model-turn'");
    // …and it is emitted only for a non-ok verdict (a clean turn says nothing).
    expect(src).toContain("if (diag.verdict !== 'ok')");
  });

  it('the durable TOOL_CALL_FINALIZE metric row survives alongside the warn (measurable, not just logged)', () => {
    const src = read('modules/crossmodel/coding/coding-model.ts');
    expect(src).toContain('LOOP_METRIC_KINDS.TOOL_CALL_FINALIZE');
    expect(src).toContain('recordLoopMetric({');
  });

  it('volume is BOUNDED per attempt — the settled guard makes one diagnostic per failed finalize', () => {
    // A retry STORM would emit N rows per turn. `finish()` is settled-guarded,
    // and it is the only path to this warn.
    const src = read('modules/crossmodel/coding/coding-model.ts');
    expect(src).toContain('if (settled) return; // stream.destroy() fires end/close/error — resolve once');
    // Every terminal stream event funnels into the SAME guarded finish().
    expect(src).toContain('stream.on(');
  });

  it('the class is the documented efdb3d31 residual and its verdict logic is model-INDEPENDENT', () => {
    // The same live row still diagnoses as no_complete_payload under the real
    // slot accounting — the culprit naming was never the bug (efdb3d31).
    const diag = diagnoseToolCallFinalize(
      { 0: { id: 'c1', name: 'goal_update', args: '{"goalId": "8f0dcd6f", "progressNote": ' } } as any,
      'tool_calls',
    );
    expect(diag.verdict).toBe('no_complete_payload');
    expect(diag.slots).toBe(1);
    expect(diag.named).toBe(1);
    expect(diag.broken[0]).toMatchObject({ name: 'goal_update' });

    // The discriminator reads the BYTES, never the model: the same accounting
    // under a different provider label produces the same verdict text.
    const summary = finalizeVerdictSummary({
      receivedBytes: 134, accumulatedBytes: 134, droppedBytes: 0,
      fragments: 25, undrainedBufferBytes: 0, finishReason: 'tool_calls', streamCompleted: true,
    });
    expect(summary).toBe('gateway recv=134 acc=134 drop=0 frag=25 buf=0 fr=tool_calls sc=1');
    // No provider/model token can appear in the verdict summary by construction.
    expect(summary).not.toMatch(/xiaomi|moonshot|deepseek|kimi/i);
  });
});