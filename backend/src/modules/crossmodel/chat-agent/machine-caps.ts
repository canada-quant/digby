/**
 * The caps that ACTUALLY govern a machine wake (audit 2026-09-26
 * supervisors-auto-4, fix 3): a supervisor / machine wake is bounded by the
 * per-chat daily FIRING cap (coding/schedule.service.ts `dailyCapExceeded`
 * over the FIRES_KEY counter + `capForSession`) and — ONLY when the owner set
 * one on the project — the PROJECT spend cap (coding/spend-cap.service.ts
 * `getLaneSpendCap`: ProjectSettings.spendCapUsdPerDay, folder-inherited).
 * Read them ONCE at finalize for the row's `caps` field.
 *
 * Owner directive 2026-09-27: there is NO other cost cap — no chat-level row,
 * no env default, no fleet budget. `spendCapUsdPerDay: null` on a row means
 * "checked, none set"; `spendCapScope` is present only as 'project'.
 *
 * Fail-open, bounded, never throws: every reader is independent, anything
 * that errors or exceeds MACHINE_CAPS_TIMEOUT_MS is omitted, and a row with
 * nothing readable gets no `caps` at all (null). Dynamic imports keep the
 * heavy schedule / spend-cap chains out of the chat-agent import graph.
 */

export const MACHINE_CAPS_TIMEOUT_MS = 1500;

export interface MachineCaps {
  /** the chat's daily machine-firing cap: firings used in the live window (null = counter unreadable), the cap, when the window resets */
  dailyFirings?: { used: number | null; cap: number; resetsAt?: string };
  /** the user-set PROJECT spend cap governing this chat; null = no cap set (the default — no other cap exists) */
  spendCapUsdPerDay?: number | null;
  /** where the spend cap came from — absent when no cap is set; only 'project' exists */
  spendCapScope?: 'project';
}

function bounded<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([
    p.catch(() => undefined as T | undefined),
    new Promise<undefined>((res) => setTimeout(() => res(undefined), ms).unref()),
  ]);
}

async function readDailyFirings(chatId: string): Promise<MachineCaps['dailyFirings'] | undefined> {
  const m = await import('../coding/schedule.service');
  const st = await m.capStateForSession(chatId);
  if (!st || typeof st.dailyCapLimit !== 'number' || !Number.isFinite(st.dailyCapLimit)) return undefined;
  return {
    used: typeof st.dailyFiresUsed === 'number' && Number.isFinite(st.dailyFiresUsed) ? st.dailyFiresUsed : null,
    cap: st.dailyCapLimit,
    ...(st.capWindowResetsAt ? { resetsAt: st.capWindowResetsAt } : {}),
  };
}

async function readSpendCap(chatId: string): Promise<Pick<MachineCaps, 'spendCapUsdPerDay' | 'spendCapScope'> | undefined> {
  // The ONE cap resolver (getLaneSpendCap) — the same chain checkSpendCap
  // enforces and get_spend / get_chat_autonomy expose, so the compute_policy
  // stamp can never disagree with the surface that skips. The kill switch is
  // checked FIRST and short-circuits (an ops flip to SPEND_CAP_DISABLED=1 must
  // read "no cap" here the same second it stops the sweeper from skipping).
  const m = await import('../coding/spend-cap.service');
  if (m.spendCapDisabled()) return { spendCapUsdPerDay: null };
  const lane = await m.getLaneSpendCap(chatId);
  if (lane.spendCapUsdPerDay != null && lane.spendCapSource === 'project') return { spendCapUsdPerDay: lane.spendCapUsdPerDay, spendCapScope: 'project' };
  return { spendCapUsdPerDay: null };
}

/** The governing caps for one machine wake's chat, or null when nothing was readable in time. Never throws. */
export async function readMachineCaps(chatId: string, opts: { timeoutMs?: number } = {}): Promise<MachineCaps | null> {
  if (!chatId) return null;
  const ms = Math.max(1, Math.floor(opts.timeoutMs ?? MACHINE_CAPS_TIMEOUT_MS));
  try {
    const [firings, spend] = await Promise.all([
      bounded(readDailyFirings(chatId), ms),
      bounded(readSpendCap(chatId), ms),
    ]);
    const out: MachineCaps = { ...(firings ? { dailyFirings: firings } : {}), ...(spend ?? {}) };
    return Object.keys(out).length ? out : null;
  } catch {
    return null;
  }
}
