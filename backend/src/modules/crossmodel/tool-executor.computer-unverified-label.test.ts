/**
 * Epistemic labeling of the computer_task tool envelope (Framework Operator
 * firing 3, 2026-09-22 — the canlegal F94 fabricated-success class).
 *
 * Live case (chat 66c9fb5c, F94 close 12:47Z): two computer_task re-gathers
 * returned "verified 3138-byte scp+ssh transfer … 216.1KB/s" reports that
 * ECHOED the genuine prior attempt's byte count and transfer rate verbatim,
 * while box-side SSM reads proved no transfer had occurred and the on-Mac
 * state file disagreed with the tool's report. The lane's audit caught it —
 * but only because it re-verified through an independent channel. A calling
 * lane that trusts the envelope can bank a fabricated external action.
 *
 * The formatter now stamps a deterministic harness-owned label between the
 * header and the sub-agent's narration. These pins hold it there.
 */
jest.mock('../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../config/database', () => ({ __esModule: true, default: {} }));
jest.mock('../../config/redis', () => ({ __esModule: true, default: {} }));
jest.mock('../../config/env', () => ({ __esModule: true, default: {} }));
jest.mock('./mcp-search', () => ({ callMcpTool: jest.fn(), webToolsDegraded: jest.fn(() => false) }));

import { formatComputerTaskToolResult } from './tool-executor';

const fakeResult: any = {
  finalResponse: 'I ran the scp transfer and verified it: 3138 bytes sent at 216.1KB/s. The state file now shows the harvest.',
  steps: 4,
  localStatus: 'paired · online · agent v0.4.2',
};

describe('formatComputerTaskToolResult — the UNVERIFIED narration label (firing 3)', () => {
  it('stamps the label between the header and the narration, BEFORE any success claim', () => {
    const out = formatComputerTaskToolResult(fakeResult);
    const labelAt = out.indexOf('[SUB-AGENT NARRATION — UNVERIFIED]');
    const headerAt = out.indexOf('[Computer task result — steps: 4');
    const claimAt = out.indexOf('verified it: 3138 bytes');
    expect(labelAt).toBeGreaterThan(-1);
    expect(headerAt).toBeGreaterThan(-1);
    expect(claimAt).toBeGreaterThan(-1);
    // label AFTER the header (the header still reads first), BEFORE the claim
    expect(labelAt).toBeGreaterThan(headerAt);
    expect(labelAt).toBeLessThan(claimAt);
    // the label names the live fabrication shape and demands independent verification
    expect(out).toMatch(/fabricated/i);
    expect(out).toMatch(/independent channel/);
  });

  it('the header still carries steps + mac status (the availability answer)', () => {
    const out = formatComputerTaskToolResult(fakeResult);
    expect(out).toContain('[Computer task result — steps: 4 · mac: paired · online · agent v0.4.2]');
  });

  it('a capabilityNotice still PREPENDS as the hard banner, ahead of the label', () => {
    const out = formatComputerTaskToolResult({ ...fakeResult, capabilityNotice: 'No usable Mac is paired.' });
    const bannerAt = out.indexOf('[COMPUTER_TASK — UNAVAILABLE]');
    const labelAt = out.indexOf('[SUB-AGENT NARRATION — UNVERIFIED]');
    expect(bannerAt).toBe(0);
    expect(labelAt).toBeGreaterThan(bannerAt);
  });
});

// cu-diag fix #3 (2026-09-25): harness-measured counters ride the header so
// lanes reason from harness FACTS, not the sub-agent's narration. The header
// stays byte-identical when a result carries no counters (steps-0 paths).
describe('formatComputerTaskToolResult — harness counters in the header (cu-diag fix #3)', () => {
  it("formatComputerTaskToolResult: the header carries the harness counters when present; byte-identical to before when absent", () => {
    const base = { finalResponse: "did it", elapsed: 1, steps: 4, localStatus: "paired · online · agent v0.4.3" };
    expect(formatComputerTaskToolResult(base)).toContain("[Computer task result — steps: 4 · mac: paired · online · agent v0.4.3]");
    const withHarness = formatComputerTaskToolResult({
      ...base,
      harness: { refusedRepeats: 1, noChangeStrikes: 2, degenerateFrames: 0, frameGeometry: "1568×1013", displayCount: null, probesRun: 1, probesPassed: 0, probesConclusive: 1, inputProven: false, frontmostChanges: 0 },
    });
    expect(withHarness).toContain("[Computer task result — steps: 4 · mac: paired · online · agent v0.4.3 · harness: refusedRepeats=1 noChangeStrikes=2 degenerateFrames=0 frame=1568×1013 displays=unknown probe=0/1 FAILED]");
    const proven = formatComputerTaskToolResult({
      ...base,
      harness: { refusedRepeats: 0, noChangeStrikes: 3, degenerateFrames: 1, frameGeometry: "1568×882", displayCount: 2, probesRun: 1, probesPassed: 1, probesConclusive: 1, inputProven: true, frontmostChanges: 1 },
    });
    expect(proven).toContain("displays=2 probe=1/1 input-proven frontmostChanges=1]");
  });
});
