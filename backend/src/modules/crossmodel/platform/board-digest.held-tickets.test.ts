/**
 * SHARED-PROJECT-DISPATCH (supervisor SOTA round 3, 2026-10-20) — the fleet
 * [BOARD] carries ONE held-ticket line (tickets on other accounts held > 2 h
 * waiting on an admin; feedback/held-ticket-escalation.ts). Pins: placement
 * under the header beside the done-bar line, absent ⇒ the block byte-for-byte,
 * and the line carries its own cap allowance so it never truncates the owner
 * questions at the tail.
 */
const mockPrisma: any = {
  crossModelProject: { findUnique: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  crossModelChat: { findMany: jest.fn(async () => []) },
  projectGoal: { findMany: jest.fn(async () => []), groupBy: jest.fn(async () => []) },
  projectTodo: { findMany: jest.fn(async () => []), groupBy: jest.fn(async () => []) },
  ownerQuestion: { findMany: jest.fn(async () => []) },
  systemSetting: { findUnique: jest.fn(async () => null) },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));
jest.mock('../../../config/redis', () => ({ __esModule: true, default: { get: jest.fn(async () => null), incr: jest.fn(async () => 1), del: jest.fn(async () => 1) } }));
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { renderFleetBoardBlock, FLEET_BOARD_BLOCK_CAP, type FleetBoardProject } from './board-digest.service';
import { HELD_TICKETS_BOARD_PREFIX } from '../feedback/held-ticket-escalation';

const NOW = new Date('2026-10-20T12:00:00Z');
const proj = (name: string, projectId: string): FleetBoardProject => ({ name, projectId, activeGoals: 1, blockedGoals: 0, openTodos: 2, blockedTodos: 0, openOwnerQuestions: 0 });
const OQ = [{ id: 'oq_12345678-aaaa-4000-8000-000000000000', status: 'open', createdAt: new Date('2026-10-20T09:00:00Z'), question: 'Ship it?' }];
const HELD = `${HELD_TICKETS_BOARD_PREFIX} 1 ticket on other accounts held > 2 h awaiting an admin: 22d667e7 (46 h, card oq_abcdef12 open). ONE owner card each (Approve / Keep held / Dismiss), applied by the harness — never re-file or work one yourself.`;

describe('renderFleetBoardBlock — the held-ticket line', () => {
  it('rides under the header after the done-bar line; absent ⇒ the block byte-for-byte', () => {
    const base = renderFleetBoardBlock([proj('spark', 'p-spark000')], OQ, NOW, undefined, 'DONE-BAR line');
    expect(renderFleetBoardBlock([proj('spark', 'p-spark000')], OQ, NOW, undefined, 'DONE-BAR line', undefined, undefined)).toBe(base);
    const block = renderFleetBoardBlock([proj('spark', 'p-spark000')], OQ, NOW, undefined, 'DONE-BAR line', undefined, HELD);
    expect(block).toContain(`DONE-BAR line\n${HELD}\nSUPERVISED PROJECTS: 1`);
    expect(block.replace(`${HELD}\n`, '')).toBe(base);
  });

  it('carries its own cap allowance — a block that fit before still shows every owner question with the line added', () => {
    // Fill the block to just under the cap WITHOUT the held line.
    const projects: FleetBoardProject[] = [];
    for (let i = 0; ; i += 1) {
      const next = [...projects, proj(`project-name-${String(i).padStart(3, '0')}`, `p-${String(i).padStart(7, '0')}`)];
      if (renderFleetBoardBlock(next.map((p) => ({ ...p })), OQ, NOW).length > FLEET_BOARD_BLOCK_CAP - 40) break;
      projects.push(next[next.length - 1]);
    }
    const base = renderFleetBoardBlock(projects.map((p) => ({ ...p })), OQ, NOW);
    expect(base).not.toContain('…[truncated]');
    const withHeld = renderFleetBoardBlock(projects.map((p) => ({ ...p })), OQ, NOW, undefined, undefined, undefined, HELD);
    expect(withHeld).not.toContain('…[truncated]');
    expect(withHeld).toContain('OPEN OWNER QUESTIONS (account-wide):\n- oq_12345678 OPEN since');
    expect(withHeld).toContain(HELD);
  });
});
