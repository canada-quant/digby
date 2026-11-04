/**
 * Tickets 14c64064 + 263859eb — todo_create/goal id breaker streaks
 * (backend replay suite).
 *
 * Two 3× streaks the same evening (2026-09-25), both auto-filed at breaker
 * trip. Adjudication (owner doctrine 2026-09-10: self-heal + attribute):
 *
 * 263859eb — the lane re-typed a REAL goal id with a single wrong hex
 *   character ("0c08e0e2-7c25-…" for "0c08e0e2-0c25-…", hamming distance 1).
 *   The framework's own "Did you mean" error named the exact correct id —
 *   and the model re-passed the SAME wrong id twice more. MODEL behavior
 *   (correction offered and ignored), but the framework already owned the
 *   deterministic cure for this exact class — chat-id-near-match
 *   (owner-endorsed 2026-09-18): a full 36-char shape that misses exactly
 *   resolves to the ONE caller-visible candidate sharing the 8-char time
 *   prefix within hamming distance ≤2. It had simply never been extended to
 *   goal/todo ids. This suite replays the fix: canonicalGoalId/
 *   canonicalTodoId now auto-heal the full-shape near-miss on attempt 1.
 *
 * 14c64064 — the lane passed a PROVABLY FABRICATED dependency todo id
 *   ("e83f3f00-0000-0000-000000000001" — sequential zeros, never issued by
 *   Prisma's uuid()) and a bogus assigneeChatId. Pure MODEL behavior: no
 *   framework resolver can heal an invented id, and none should (an invented
 *   suffix must never silently resolve — the 2026-08-30 doctrine). Pinned
 *   here: the fabricated shape does NOT resolve through the new near-match
 *   path (its 8-char prefix matches nothing) — the guard stays closed.
 *
 * The scope line (both tickets): the 2026-08-30 "never silently resolve"
 * doctrine guards PREFIX reconstruction (8–35 chars); a full-shape id with
 * 1–2 wrong characters is a typo, and the owner drew exactly this line for
 * chat ids. Visibility gating is inherited from the prefix-hint access gate:
 * a typo can never resolve into another account's goal/todo.
 */

jest.mock("../../../utils/logger", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const REAL_GOAL = "0c08e0e2-0c25-4b4e-8193-91ad0fea4088";
const TYPED_GOAL = "0c08e0e2-7c25-4b4e-8193-91ad0fea4088"; // one wrong hex char (263859eb)
const FABRICATED = "e83f3f00-0000-0000-000000000001"; // never issued (14c64064)

const mockPrisma: any = {
  projectGoal: { findUnique: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
  projectTodo: { findUnique: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
  crossModelProject: { findUnique: jest.fn(), findMany: jest.fn() },
  projectMember: { findMany: jest.fn() },
};
jest.mock("../../../config/database", () => ({ __esModule: true, default: mockPrisma }));
jest.mock("../../../config/redis", () => ({
  __esModule: true,
  default: { connect: jest.fn(), quit: jest.fn(), get: jest.fn(), set: jest.fn(), del: jest.fn(), keys: jest.fn() },
}));
jest.mock('../coding/schedule.service', () => ({
  __esModule: true,
  scheduleViewForLane: jest.fn(async () => null),
}));
jest.mock("../../../middleware/error-handler", () => {
  class AppError extends Error {
    status: number;
    constructor(status: number, message: string) { super(message); this.status = status; }
  }
  return { __esModule: true, AppError };
});
jest.mock("../memory/context-store", () => ({
  __esModule: true,
  getChatContextStore: jest.fn(),
}));
jest.mock("./loop-metrics.service", () => ({
  __esModule: true,
  recordLoopMetric: jest.fn(),
  LOOP_METRIC_KINDS: { GOAL_TODO_NEAR_MATCH_RESOLVED: 'goal_todo_near_match_resolved' },
}));

import { canonicalGoalIdForTool } from "./goals.service";
import { hammingDistance, nearMatchChatId, isFullChatIdShape } from "./chat-id-near-match";

beforeEach(() => {
  jest.clearAllMocks();
  // getProjectAccess: the caller owns every project in these fixtures (the
  // access gate's own behavior is covered by the goals.service.test.ts suites).
  // NB: the project row's owner field is `userId` (getProjectAccess reads
  // project.userId === userId → 'owner').
  mockPrisma.crossModelProject.findUnique.mockImplementation(async ({ where }: any) => ({
    id: where.id,
    userId: "user-1",
    members: [],
  }));
});

describe("263859eb + 14c64064 — goal/todo full-shape near-miss resolution", () => {
  it("pure helpers: hamming distance and the unique-candidate rule (the chat-id contract, unchanged)", () => {
    expect(hammingDistance(REAL_GOAL, TYPED_GOAL)).toBe(1);
    expect(hammingDistance("aaaaaaaa", "bbbbbbbb")).toBe(8);
    const one = [{ id: REAL_GOAL }];
    expect(nearMatchChatId(one, TYPED_GOAL)?.id).toBe(REAL_GOAL);
    // Ambiguity → null (two candidates within distance 2 — never guess).
    const two = [{ id: REAL_GOAL }, { id: "0c08e0e2-0c25-4b4e-8193-91ad0fea4188" }];
    expect(nearMatchChatId(two, TYPED_GOAL)).toBeNull();
    // Distance 3+ → null (a different id, not a typo).
    expect(nearMatchChatId(one, "0c08e0e2-0c25-4b4e-8193-91ad0fea4999")).toBeNull();
    expect(isFullChatIdShape(TYPED_GOAL)).toBe(true);
    expect(isFullChatIdShape("0c08e0e2")).toBe(false); // a prefix — the 2026-08-30 guard's domain
  });

  it("REPLAY (263859eb): the one-wrong-hex-char goal id resolves to the real goal on attempt 1 — the 3× streak class dies here", async () => {
    mockPrisma.projectGoal.findMany.mockResolvedValue([{ id: REAL_GOAL, projectId: "proj-1" }]);
    const resolved = await canonicalGoalIdForTool(TYPED_GOAL, "user-1");
    expect(resolved).toBe(REAL_GOAL);
    // The near-match query shares the candidate's 8-char time prefix.
    expect(mockPrisma.projectGoal.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { startsWith: "0c08e0e2" } } }),
    );
  });

  it("REPLAY (14c64064): a FABRICATED id (sequential zeros, never issued) does NOT resolve — the invented-suffix guard stays closed", async () => {
    mockPrisma.projectTodo.findMany.mockResolvedValue([]);
    const { canonicalTodoIdForTool } = await import("./goals.service") as any;
    const resolved = await canonicalTodoIdForTool(FABRICATED, "user-1");
    expect(resolved).toBe(FABRICATED); // unchanged → the 404 + shape-hint path still fires
  });

  it("cross-account safety: a near-miss whose only candidate is INVISIBLE to the caller resolves to nothing (no existence leak)", async () => {
    mockPrisma.projectGoal.findMany.mockResolvedValue([{ id: REAL_GOAL, projectId: "proj-1" }]);
    // The caller is NOT the owner and NOT a member → getProjectAccess returns
    // null → the candidate is invisible → no near-match (scoped 404 path).
    mockPrisma.crossModelProject.findUnique.mockResolvedValue({ id: "proj-1", userId: "someone-else", members: [] });
    const resolved = await canonicalGoalIdForTool(TYPED_GOAL, "user-1");
    expect(resolved).toBe(TYPED_GOAL); // unchanged → the scoped 404 (no hint) still fires
  });

  it("scope guard (source pins): the near-match applies ONLY to full 36-char shapes and every heal is counted", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const src = fs.readFileSync(path.join(__dirname, "goals.service.ts"), "utf8");
    expect(src).toMatch(/if \(!isFullChatIdShape\(id\)\) return null;/);
    expect(src).toMatch(/GOAL_TODO_NEAR_MATCH_RESOLVED/);
    // Both canonical resolvers consult it AFTER prefix resolution misses.
    expect(src.match(/nearMatchFullShapeId\('goal'/g)?.length).toBeGreaterThanOrEqual(1);
    expect(src.match(/nearMatchFullShapeId\('todo'/g)?.length).toBeGreaterThanOrEqual(1);
  });
});
