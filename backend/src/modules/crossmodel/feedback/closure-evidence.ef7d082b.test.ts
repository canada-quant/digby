/**
 * REPLAY PIN — ticket ef7d082b (mishap, breaker trip 2026-09-13, session
 * 4d6d85b2 "Open Feedback Tickets Burn Down", run 6f488285).
 *
 * The mishap: 3× identical update_feedback refusals —
 *   {"ok": false, "reason": "replay_test_unciting", "ticketId":
 *    "4806298b-7032-4c21-9d9e-cc6af9d6a24f", "message": "replayTestPath
 *    \"backend/src/modules/crossmodel/integrations/openai.integration.test.ts\"
 *    exists but never mentions this ticket's id prefix \"4806298b\" — a replay
 *    test must cite the ticket it pins (add a comment or test name carrying
 *    \"4806298b\"). …"}
 *
 * ADJUDICATION (engineering lane b92ef13f, 2026-09-13): MODEL behavior, not a
 * framework defect. Per the 251e9329 attribution rule ("BEFORE calling a
 * tool-failure streak model behavior, diff the refusal text against the tools
 * it names — a broken advertised recovery path is a deterministic framework
 * defect"), the refusal here was self-describing and CORRECT on every call:
 * it named the offending path, the missing prefix, and the exact remedy
 * (cite "4806298b" in the file). The lane re-issued the same arguments
 * unchanged instead of following the remedy; PR #715 (commit 24235e60,
 * "test(cites): 4806298b — replay-test headers cite the ticket id") later did
 * exactly what the refusal said, proving the advertised path worked.
 *
 * These tests replay the mishap through the REAL gate (temp REPLAY_TEST_ROOT):
 * (1) the exact scenario — an existing test file that never cites 4806298b —
 * produces the replay_test_unciting refusal naming the path + prefix + remedy,
 * deterministically, three times in a row (the streak was informational, not
 * a malfunction); (2) the advertised remedy works: the same path WITH the cite
 * passes the citation check. Mock harness copied from closure-evidence.test.ts.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {
  userFeatureRequest: { findUnique: jest.fn() },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

import { verifyMachineCloseEvidence } from './closure-evidence';

// The ticket the tripped lane was trying to close, and the path it passed.
const TICKET_ID = '4806298b-7032-4c21-9d9e-cc6af9d6a24f';
const PREFIX = '4806298b';
const LANE_PATH = 'backend/src/modules/crossmodel/integrations/openai.integration.test.ts';

let root: string;
const ENV = { ...process.env };

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-root-ef7d082b-'));
  process.env.REPLAY_TEST_ROOT = root;
});

afterAll(() => {
  process.env = ENV;
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.userFeatureRequest.findUnique.mockResolvedValue({
    id: TICKET_ID, type: 'bug_report', title: 'OpenAI integration regressions (replay-cited)',
  });
});

function writeLanePath(content: string): string {
  const abs = path.join(root, LANE_PATH);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return LANE_PATH;
}

describe('ef7d082b replay — the unciting refusal is deterministic, correct, and self-describing', () => {
  it('three consecutive closes with an existing-but-unciting replayTestPath refuse identically, naming path + prefix + remedy', async () => {
    // The file EXISTS (as the lane's grep confirmed) but never cites 4806298b —
    // exactly the state of openai.integration.test.ts before PR #715.
    const rel = writeLanePath(`describe('openai integration', () => {\n  it('streams', () => {});\n});\n`);
    for (let attempt = 1; attempt <= 3; attempt++) {
      const v = await verifyMachineCloseEvidence({ ticketId: TICKET_ID, evidence: { replayTestPath: rel } });
      expect(v).toMatchObject({ ok: false, reason: 'replay_test_unciting' });
      const msg = (v as any).message as string;
      expect(msg).toContain(LANE_PATH);            // names the offending path
      expect(msg).toContain(`"${PREFIX}"`);        // names the missing prefix
      expect(msg).toContain(`add a comment or test name carrying "${PREFIX}"`); // the remedy
    }
  });

  it('the advertised remedy works: the same path WITH the 4806298b cite passes the citation check (what PR #715 did)', async () => {
    const rel = writeLanePath(
      `// Replay headers cite their tickets (verified-close convention): 4806298b\ndescribe('openai integration', () => {\n  it('streams', () => {});\n});\n`,
    );
    const v = await verifyMachineCloseEvidence({ ticketId: TICKET_ID, evidence: { replayTestPath: rel } });
    expect(v).toMatchObject({ ok: true, verified: ['replayTestPath'] });
    expect((v as any).auditNote).toContain(`cites ${PREFIX}`);
  });
});
