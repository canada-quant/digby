/**
 * cu-diag 2026-09-25 fix #6 — computer-use lock: wait-then-refuse with a
 * NAMED holder.
 *
 * The evening's three "refusing to double-drive" rows were contenders that
 * gave up after 15 s while the holder finished seconds later, and the refusal
 * said only "another session" — the supervisor could not tell the owner WHO
 * had the Mac. Now the contender waits up to 60 s (COMPUTER_LOCK_WAIT_MS), the
 * holder records {chatId, lane, since} in a sibling key with the lock's TTL,
 * a refusal can describe it, and release drops the record only when the
 * releaser actually owned the lock.
 *
 * Redis is a tiny in-memory fake: set NX/PX, get, del, and the compare-and-
 * delete Lua script the module uses (evaluated by hand — the fake recognizes
 * the script text).
 */

const store = new Map<string, string>();
const redisMock = {
  set: jest.fn(async (key: string, value: string, opts?: { NX?: boolean; PX?: number }) => {
    if (opts?.NX && store.has(key)) return null;
    store.set(key, value);
    return "OK";
  }),
  get: jest.fn(async (key: string) => store.get(key) ?? null),
  del: jest.fn(async (key: string) => (store.delete(key) ? 1 : 0)),
  eval: jest.fn(async (_script: string, args: { keys: string[]; arguments: string[] }) => {
    const [key] = args.keys;
    const [token] = args.arguments;
    if (store.get(key) === token) { store.delete(key); return 1; }
    return 0;
  }),
};
jest.mock("../../../config/redis", () => ({ __esModule: true, default: redisMock }));
jest.mock("../../../utils/logger", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import {
  acquireComputerUseLock,
  releaseComputerUseLock,
  recordComputerUseHolder,
  describeComputerUseHolder,
  computerUseLockHeld,
  lockWaitMs,
  LOCK_WAIT_MS_DEFAULT,
} from "./use-lock";

beforeEach(() => {
  store.clear();
  jest.clearAllMocks();
  delete process.env.COMPUTER_LOCK_WAIT_MS;
});

describe("lock wait window (fix #6)", () => {
  it("defaults to 60 s and honors COMPUTER_LOCK_WAIT_MS (=15000 restores the old wait)", () => {
    expect(LOCK_WAIT_MS_DEFAULT).toBe(60_000);
    expect(lockWaitMs()).toBe(60_000);
    process.env.COMPUTER_LOCK_WAIT_MS = "15000";
    expect(lockWaitMs()).toBe(15_000);
    process.env.COMPUTER_LOCK_WAIT_MS = "garbage";
    expect(lockWaitMs()).toBe(60_000);
  });

  it("a contender WAITS and wins the lock once the holder releases inside the window", async () => {
    const holder = await acquireComputerUseLock("u1", 60_000, "mac-1", 0);
    expect(holder).toBeTruthy();
    // Release the holder 1.5 s in — the contender polls every 1 s.
    setTimeout(() => { void releaseComputerUseLock("u1", holder as string, "mac-1"); }, 1500);
    const t0 = Date.now();
    const contender = await acquireComputerUseLock("u1", 60_000, "mac-1", 5000);
    expect(contender).toBeTruthy();
    expect(contender).not.toBe(holder);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1000);
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it("a contender that outlasts the window is refused (null), the holder keeps the lock", async () => {
    const holder = await acquireComputerUseLock("u1", 60_000, "mac-1", 0);
    const contender = await acquireComputerUseLock("u1", 60_000, "mac-1", 0);
    expect(contender).toBeNull();
    expect(await computerUseLockHeld("u1", "mac-1")).toBe(true);
    await releaseComputerUseLock("u1", holder as string, "mac-1");
    expect(await computerUseLockHeld("u1", "mac-1")).toBe(false);
  });
});

describe("holder record (fix #6)", () => {
  it("records {chatId, lane, since} next to BOTH lock keys and a contender can read it", async () => {
    const token = await acquireComputerUseLock("u1", 60_000, "mac-1", 0);
    await recordComputerUseHolder("u1", "mac-1", { chatId: "chat-42", lane: "coding session chat-42" }, 60_000);
    const h = await describeComputerUseHolder("u1", "mac-1");
    expect(h).toEqual({ chatId: "chat-42", lane: "coding session chat-42", since: expect.any(String) });
    expect(Date.parse(h!.since as string)).toBeGreaterThan(0);
    // The legacy per-user key carries the record too (old-color deploy-window guard).
    expect(store.has("computer-use:lock:u1:holder")).toBe(true);
    expect(store.has("computer-use:lock:u1:mac-1:holder")).toBe(true);
    await releaseComputerUseLock("u1", token as string, "mac-1");
  });

  it("release drops the holder record ONLY when the releaser owned the lock", async () => {
    const token = await acquireComputerUseLock("u1", 60_000, "mac-1", 0);
    await recordComputerUseHolder("u1", "mac-1", { chatId: "chat-1", lane: "lane A" }, 60_000);
    // A stranger with a stale token must not delete the live holder's record.
    await releaseComputerUseLock("u1", "not-the-token", "mac-1");
    expect(await describeComputerUseHolder("u1", "mac-1")).toMatchObject({ chatId: "chat-1" });
    expect(await computerUseLockHeld("u1", "mac-1")).toBe(true);
    // The real owner's release clears both.
    await releaseComputerUseLock("u1", token as string, "mac-1");
    expect(await describeComputerUseHolder("u1", "mac-1")).toBeNull();
    expect(await computerUseLockHeld("u1", "mac-1")).toBe(false);
  });

  it("no record → null (a legacy holder degrades the refusal to 'another session', never to 'free')", async () => {
    await acquireComputerUseLock("u1", 60_000, "mac-1", 0);
    expect(await describeComputerUseHolder("u1", "mac-1")).toBeNull();
    expect(await computerUseLockHeld("u1", "mac-1")).toBe(true);
  });

  it("holder record and lock-held reads fail SOFT on redis errors", async () => {
    redisMock.get.mockRejectedValueOnce(new Error("redis down"));
    expect(await describeComputerUseHolder("u1", "mac-1")).toBeNull();
    redisMock.get.mockRejectedValueOnce(new Error("redis down"));
    expect(await computerUseLockHeld("u1", "mac-1")).toBe(false);
    redisMock.set.mockRejectedValueOnce(new Error("redis down"));
    await expect(recordComputerUseHolder("u1", "mac-1", { chatId: "c" }, 60_000)).resolves.toBeUndefined();
  });
});
