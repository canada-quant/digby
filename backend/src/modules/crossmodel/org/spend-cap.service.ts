/**
 * THE ONE USAGE LIMIT (owner directive 2026-11-07T06:40Z).
 *
 * OWNER'S WORDS: "we dont want to limit usage by email verfication at all …
 * people need to freely use digby.ai logged in or not…and we dont want to limit
 * by messages or anything for digby.ai … maybe a hard $100 usage cap per user
 * non admins".
 *
 * So the product now has exactly ONE ceiling and it is measured in MONEY, not in
 * messages and not in verification state:
 *
 *   - email verification gates NOTHING (org/email-verification.service.ts is a
 *     permanent no-op; new accounts are created verified);
 *   - message counts gate NOTHING (every new org is created with
 *     `dailyMessageLimit: null` = unlimited; `defaultOrgDailyLimit` is gone);
 *   - guests / anonymous visitors are untouched (no login wall);
 *   - THIS file is the only refusal a normal user can hit: a hard LIFETIME
 *     model-spend cap, EXEMPT for admins.
 *
 * WHY LIFETIME AND NOT PER-DAY: a daily bucket invites a user to burn the same
 * allowance every day forever, which is not a spend control. The cap only ever
 * moves against actual paid inference, and once a user is at it nothing they do
 * resets it. Ops still have the escape hatch (see `lifetimeSpendCapUsd`).
 *
 * ATTRIBUTION: reuses the ONE proven rule from the visitor analytics service —
 * a `loop_metrics` row of kind `run_spend` bills to the owner of the chat its
 * `sessionId` names (`crossmodel_chats."userId"`). This module deliberately does
 * NOT invent a second rule: it calls that file's `resolveSpendSql` verbatim, so
 * the number the cap enforces and the number the admin "Users & traffic" table
 * shows can never disagree. A user's OWN chat spend is counted; a visitor's
 * pre-signup guest spend (re-keyed to its linked user elsewhere) is NOT charged
 * to the account here — the directive's cap is on the ACCOUNT's usage, and
 * counting anonymous browsing against a brand-new signup would be a surprise
 * refusal, not a spend control.
 *
 * DURABILITY: `loop_metrics` is swept at 30 days, so the lifetime total is the
 * live rows from the rollup split forward PLUS `spend_daily_rollups` before it —
 * the same live+rollup split `visitor-analytics.service.ts` uses (`spendSplit`).
 * Without the rollup half, every user's lifetime spend would silently reset to
 * ~$0 every 30 days and the cap would be unenforceable in practice.
 *
 * FAIL-OPEN ON THE READ, FAIL-CLOSED ON THE DECISION. Mirror of
 * `assertOrgTokensAvailable`'s posture (org-quota.service.ts): a database blip
 * while READING the total must not refuse every user's message — that is a
 * self-inflicted outage, and the counter is a money guard, not a security
 * boundary. Once a number IS known, an over-cap user is refused. Getting the
 * two arms confused in the other direction is the real defect (an over-cap send
 * slipping through as if it were an infra error), which is why this module
 * recognizes its own refusal by CLASS **and** NAME: these errors cross
 * dynamic-`import()` module boundaries where a duplicated module instance can
 * make `instanceof` false even with a correct prototype.
 *
 * ATOMICITY (review defect 2026-11-07 — the fix in this file). A preflight read
 * followed by a run is not a cap: two concurrent sends both read the same total
 * and both pass. The ledger is written AFTER a run, so it can never be an
 * admission gate on its own. `admitWithinLifetimeSpendCap` is the gate: a
 * Postgres transaction-scoped advisory lock on the user id, the committed total
 * AND the live holds read inside that lock, and one hold row written before the
 * transaction commits. `assertWithinLifetimeSpendCap` (the plain preflight) is
 * kept for callers/tests that only want the read, and `guardOrgSend` uses the
 * atomic one.
 */
import prisma from '../../../config/database';
import logger from '../../../utils/logger';
import { AppError } from '../../../middleware/app-error';
import { randomUUID } from 'crypto';
// Admin exemption = the repo's ONE admin predicate (ADMIN role, plus the owner
// e-mail — production instances only). Never a second inline role check: the
// owner-email rule is exactly the kind of thing that forks and then rots.
import { isAdminViewer } from '../view/view-mode';
// The proven attribution + live/rollup split. Imported, never re-implemented.
import { resolveSpendSql, spendSplit, isoDay, SqlParams } from '../visitors/visitor-analytics.service';

/** The env knob that tunes (or disables) the cap. */
export const SPEND_CAP_ENV = 'DIGBY_LIFETIME_SPEND_CAP_USD';

/** The env knob that tunes ONE admitted send's budget HOLD (see `admitWithinLifetimeSpendCap`). */
export const SPEND_RESERVATION_ENV = 'DIGBY_SPEND_RESERVATION_USD';

/** Default hold per admitted send, in US dollars. */
export const RESERVE_USD_DEFAULT = 1;

/**
 * How long a hold lives, in ms (30 minutes). A reservation is a HOLD, not a
 * charge — the real spend lands in `loop_metrics` `run_spend` and is counted by
 * `userLifetimeSpendUsd`. The TTL is what guarantees a crashed / killed /
 * timed-out run cannot permanently hold budget: past `expiresAt` the row is
 * invisible to the admission read, so the only thing that can keep a user at the
 * cap afterwards is real, recorded spend.
 */
export const RESERVATION_TTL_MS = 30 * 60 * 1000;

/**
 * THE DEFAULT CAP, in US dollars. This is the DEFAULT, not the effective value —
 * `lifetimeSpendCapUsd()` resolves the effective one per call (env-tunable).
 */
export const LIFETIME_SPEND_CAP_USD = 100;

/**
 * The raw-SQL seams. `RawQueryClient` is satisfied by both the Prisma client and
 * a `$transaction` client, which is what lets the lifetime read run INSIDE the
 * admission transaction (i.e. after the advisory lock is held, before the hold
 * row is written).
 */
export type RawQueryClient = {
  $queryRawUnsafe: <T = unknown>(sql: string, ...params: unknown[]) => Promise<T>;
};

/** One raw-SQL seam, so the tests can drive the same shape the visitors service uses. */
type RawDb = RawQueryClient;

function db(): RawDb {
  return prisma as unknown as RawDb;
}

/**
 * The effective lifetime cap: `null` means NO CAP.
 *
 *   unset / blank           → 100 (the owner's number)
 *   'unlimited' / 'none'    → null (no cap — an ops escape hatch, not a user one)
 *   '0'                     → null (documented way to switch the cap off)
 *   malformed / negative    → 100 (never fail open to "unlimited" on a typo: a
 *                             fat-fingered knob must not silently uncap spend)
 *   any other number        → that number of US dollars
 *
 * `env` is injected (the `defaultOrgDailyLimit(env)` convention in org.service.ts)
 * so the branch table is testable without touching process.env.
 */
export function lifetimeSpendCapUsd(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = String(env[SPEND_CAP_ENV] ?? '').trim();
  if (!raw) return LIFETIME_SPEND_CAP_USD;
  const lowered = raw.toLowerCase();
  if (lowered === 'unlimited' || lowered === 'none') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return LIFETIME_SPEND_CAP_USD; // malformed / negative → the default
  if (n === 0) return null; // deliberate off switch
  return n;
}

/**
 * The effective budget HOLD per admitted send, in US dollars
 * (`DIGBY_SPEND_RESERVATION_USD`, default 1).
 *
 *   unset / blank / malformed / negative / 0  → 1
 *   any positive number                       → that number
 *
 * WHY 0 IS NOT ALLOWED to mean "hold nothing": a zero hold restores exactly the
 * race this whole mechanism exists to close (two concurrent sends both read the
 * same total, both pass). An operator can still make the cap looser by raising
 * `DIGBY_LIFETIME_SPEND_CAP_USD`, or switch it off entirely; the HOLD itself is
 * never permitted to become a no-op.
 */
export function spendReservationUsd(env: NodeJS.ProcessEnv = process.env): number {
  const raw = String(env[SPEND_RESERVATION_ENV] ?? '').trim();
  if (!raw) return RESERVE_USD_DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return RESERVE_USD_DEFAULT;
  return n;
}

/** Human money for the message: whole dollars stay whole ("$100"), cents keep two places ("$12.50"). */
export function formatUsd(n: number): string {
  const v = Number.isFinite(n) ? n : 0;
  return Number.isInteger(v) ? `$${v}` : `$${v.toFixed(2)}`;
}

/** The user-facing refusal. NAMES the cap and says it is a LIFETIME limit. */
export function spendCapMessage(capUsd: number): string {
  return `You've reached your ${formatUsd(capUsd)} lifetime usage limit. Contact support if you need more.`;
}

/**
 * The typed refusal for the lifetime spend cap.
 *
 * WHY 402 (Payment Required) and not 403: 403 says "you are not allowed", which
 * is false — the caller is authenticated and permitted, they have exhausted a
 * metered allowance. 402 is the payment/entitlement verdict, it is what an
 * operator reading access logs needs to distinguish "over their cap" from
 * "removed account / unverified" (both 401/403 elsewhere), and the CLIENTS do not
 * branch on 402 anywhere, so it surfaces as the ordinary thrown-status JSON error
 * with the message that names the number (the one thing the user needs).
 *
 * AppError's constructor re-parents the prototype to AppError.prototype, which
 * severs `instanceof` for every subclass (the OrgQuotaExceededError /
 * EmailVerificationRequiredError lesson), so the real prototype is restored here.
 * Copy this idiom for any new typed refusal.
 */
export class SpendCapReachedError extends AppError {
  constructor(readonly capUsd: number, readonly spentUsd: number) {
    super(402, spendCapMessage(capUsd));
    this.name = 'SpendCapReachedError';
    Object.setPrototypeOf(this, SpendCapReachedError.prototype);
  }
}

/**
 * Is this OUR refusal? Class OR name, deliberately (see the header): a false
 * negative here would let an over-cap send through as if it were an infra fault,
 * and a false positive would refuse a send on a DB blip.
 */
export function isSpendCapError(err: any): err is SpendCapReachedError {
  return err instanceof SpendCapReachedError || err?.name === 'SpendCapReachedError';
}

/**
 * A user's LIFETIME paid-model spend in US dollars.
 *
 * = SUM(loop_metrics.value) over `kind='run_spend'` rows whose sessionId is a
 *   chat that user owns, from the live/rollup split forward
 * + SUM(spend_daily_rollups.usd) for `subjectKind='user'`, `subjectId=<user>`
 *   on days BEFORE the split (so the total survives the 30-day sweep).
 *
 * Positional parameters only (SqlParams): the user id is NEVER interpolated into
 * the SQL text. Returns 0 for an empty total; THROWS if the read itself fails, so
 * the caller can apply the fail-open-on-read rule in exactly one place.
 *
 * `client` exists for ONE reason: the admission path must read this total INSIDE
 * the transaction that holds the per-user advisory lock (`admitWithinLifetimeSpendCap`).
 * Reading it on the pool instead would read outside the lock and reintroduce the
 * exact race the cap now closes.
 */
export async function userLifetimeSpendUsd(
  userId: string,
  now: Date = new Date(),
  client: RawQueryClient = db(),
): Promise<number> {
  const id = String(userId ?? '').trim();
  if (!id) return 0;

  const p = new SqlParams();
  const split = spendSplit(now);
  // The live window runs from the split to "now" (+1 min so a row stamped in the
  // current millisecond is not lost to a clock skew).
  const liveSql = resolveSpendSql(p, split, new Date(now.getTime() + 60_000));
  const pLiveUid = p.add(id); // live rows: resolved subject id
  const pRollUid = p.add(id); // rollup rows: subjectId
  const pSplitDay = p.add(isoDay(split)); // rollup rows: strictly older days

  const sql = `WITH roll AS (
      SELECT COALESCE(SUM("usd"), 0)::float AS usd
      FROM "spend_daily_rollups"
      WHERE "subjectKind" = 'user' AND "subjectId" = ${pRollUid} AND "day" < ${pSplitDay}::date
    ), liv AS (
      SELECT COALESCE(SUM(live.usd), 0)::float AS usd
      FROM (${liveSql}) live
      WHERE live.kind = 'user' AND live.sid = ${pLiveUid}
    )
    SELECT (roll.usd + liv.usd)::float AS usd FROM roll, liv`;

  const rows = await client.$queryRawUnsafe<Array<{ usd: unknown }>>(sql, ...p.values);
  const first = Array.isArray(rows) ? rows[0] : null;
  const n = Number(first?.usd ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/**
 * The LIVE budget holds for one user: SUM(reservedUsd) of admission rows whose
 * `expiresAt` is still in the future. Expired rows are ignored, not deleted, so a
 * read never has to write (the sweep is a separate, best-effort job).
 *
 * Runs on the same client seam as the spend read above so it can be issued INSIDE
 * the admission transaction, under the advisory lock.
 */
export async function activeReservationsUsd(
  userId: string,
  now: Date = new Date(),
  client: RawQueryClient = db(),
): Promise<number> {
  const id = String(userId ?? '').trim();
  if (!id) return 0;
  const rows = await client.$queryRawUnsafe<Array<{ usd: unknown }>>(
    `SELECT COALESCE(SUM("reservedUsd"), 0)::float AS usd
       FROM "spend_cap_admissions"
      WHERE "userId" = $1 AND "expiresAt" > $2`,
    id,
    now,
  );
  const first = Array.isArray(rows) ? rows[0] : null;
  const n = Number(first?.usd ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/** What the cap needs to know about a subject. `role`/`email` are LOADED, not trusted. */
export interface SpendCapSubject {
  id: string;
}

/**
 * THE CAP CHECK — throws `SpendCapReachedError` (402) when this user is at or
 * over the lifetime cap. Admins are EXEMPT (no query spent on them at all).
 *
 * Order of operations is the correctness argument:
 *  1. Read the user row (`role`, `email`) so the admin test uses the repo's ONE
 *     predicate. A missing row = fail open (deleted-account race must not 402).
 *  2. ADMIN → return before the spend query (the exemption costs nothing).
 *  3. Resolve the cap; `null` (ops escape hatch) → return before the query.
 *  4. Read the spend total. An UNREADABLE total fails OPEN (log + allow) — a DB
 *     blip must not refuse every user, and the cap is a money guard, not a
 *     security boundary.
 *  5. Only then: `spent >= cap` → throw. Fail-CLOSED on a known number, at
 *     exactly the cap, because a lifetime limit that allows the next dollar is
 *     not a $100 limit.
 */
export async function assertWithinLifetimeSpendCap(user: SpendCapSubject): Promise<void> {
  const userId = String(user?.id ?? '').trim();
  if (!userId) return; // nothing to charge — never a reason to refuse

  let row: { role: string | null; email: string | null } | null;
  try {
    row = await prisma.user.findUnique({ where: { id: userId }, select: { role: true, email: true } });
  } catch (err: any) {
    logger.warn(`spend-cap: user row unreadable for ${userId}, allowing send: ${err?.message ?? err}`);
    return; // fail-open on the READ
  }
  if (!row) return; // deleted-account race: nothing to cap
  if (isAdminViewer(row)) return; // ADMINS ARE EXEMPT (the owner directive)

  const cap = lifetimeSpendCapUsd();
  if (cap === null) return; // no cap configured

  let spent: number;
  try {
    spent = await userLifetimeSpendUsd(userId);
  } catch (err: any) {
    logger.warn(`spend-cap: lifetime spend unreadable for ${userId}, allowing send: ${err?.message ?? err}`);
    return; // fail-open on the READ
  }
  if (!Number.isFinite(spent)) return; // an unreadable total is not a verdict

  if (spent >= cap) {
    logger.info(`spend-cap: ${userId} at ${formatUsd(spent)} lifetime spend (cap ${formatUsd(cap)}) — refusing send`, { source: 'org' });
    throw new SpendCapReachedError(cap, spent);
  }
}

// ── ATOMIC ADMISSION (the fix for the check-then-run race) ───────────────────

/** What an admitted send gets back: proof of the hold, and what it was decided on. */
export interface SpendAdmission {
  /** `null` when the send was admitted WITHOUT a hold (admin / no cap / blank id). */
  admissionId: string | null;
  /** The hold written for this send, in USD. 0 when no hold was taken. */
  reservedUsd: number;
  /** Settled lifetime spend measured under the lock (0 when no tx was opened). */
  committedUsd: number;
  /** When the hold stops counting. `null` when no hold was taken. */
  expiresAt: Date | null;
}

/** The tx-client subset the admission needs. Both prisma and a tx client satisfy it. */
type AdmissionTx = RawQueryClient & {
  $executeRawUnsafe: (sql: string, ...params: unknown[]) => Promise<unknown>;
  spendCapAdmission: { create: (args: any) => Promise<any> };
};

/**
 * Transaction bounds for the admission. The advisory lock is WAITED INSIDE the
 * transaction, so the window has to cover a short queue of admissions for one
 * user (Prisma's defaults are maxWait 2 s / timeout 5 s). These are generous but
 * finite on purpose: a lock wait that outlives them surfaces as a transaction
 * error, which takes the documented fail-open (infra) arm rather than pinning a
 * request open. Mirrors ACCOUNT_PURGE_TX_OPTIONS in auth.service.ts.
 */
export const ADMISSION_TX_OPTIONS = Object.freeze({ maxWait: 5_000, timeout: 10_000 });

/**
 * ATOMIC PER-USER ADMISSION — the real cap.
 *
 * WHY THIS EXISTS AT ALL. The previous guard was a CHECK-THEN-RUN preflight: read
 * the lifetime total, refuse if `spent >= cap`, otherwise let the send go. That is
 * a race, not a cap. Two sends arriving together both read $99.50, both pass, both
 * spend, and the account settles past $100. A single multi-model run can also cross
 * the cap without another check. The ledger (`loop_metrics` run_spend +
 * `spend_daily_rollups`) records cost AFTER the run, so no read of it can be an
 * admission gate on its own — there has to be a HOLD in front of it.
 *
 * THE MECHANISM, in order, inside ONE transaction:
 *  1. `SELECT pg_advisory_xact_lock(hashtext($1))` on the user id. A
 *     transaction-scoped POSTGRES advisory lock: transaction-scoped means it is
 *     released automatically on COMMIT/ROLLBACK (nothing to leak on a crash), and
 *     keying it on `hashtext(userId)` means admissions for ONE user serialize
 *     while different users never block each other.
 *  2. Read `committed = userLifetimeSpendUsd(...)` on the TX client — INSIDE the
 *     lock. Reading on the pool would read outside it and reintroduce the race.
 *  3. Read `held = SUM(reservedUsd)` of this user's unexpired holds — also inside
 *     the tx.
 *  4. `committed + held + RESERVE_USD > cap` → throw `SpendCapReachedError`. Note
 *     `>` not `>=`: the hold is a provision against spend that has NOT happened, so
 *     a send that lands exactly ON the cap is still allowed ($98.99 + $1 hold =
 *     $99.99 passes; the settled-spend arm keeps its own `spent >= cap` refusal).
 *  5. INSERT one hold row (`expiresAt = now + RESERVATION_TTL_MS`) and return it.
 *
 * THE HONEST LIMIT (do not oversell this): the ledger is written after a run, so a
 * single admitted run can spend MORE than its $1 hold — the hold bounds how many
 * CONCURRENT sends can be admitted against the same remaining headroom, not what
 * one run costs. Because holds are counted alongside settled spend, the guard errs
 * conservative: it can refuse a send a few dollars early, never a dollar late.
 *
 * FAIL-OPEN, on infra only. A thrown DB error that is NOT our own refusal (no
 * transaction, deadlock victim, dropped connection) allows the send and logs a
 * warning — mirroring `assertOrgTokensAvailable`'s old posture: the cap is a money
 * guard, not a security boundary, and refusing every user during a DB blip is a
 * self-inflicted outage. Our own refusal is recognized by CLASS **or** NAME
 * (`isSpendCapError`) because these cross dynamic-import boundaries.
 */
export async function admitWithinLifetimeSpendCap(user: SpendCapSubject): Promise<SpendAdmission> {
  const userId = String(user?.id ?? '').trim();
  // Nothing to charge — never a reason to refuse, and no tx is opened.
  if (!userId) return { admissionId: null, reservedUsd: 0, committedUsd: 0, expiresAt: null };

  // ── 1. ADMIN TEST, BEFORE THE TRANSACTION (the exemption costs no tx) ──────
  let row: { role: string | null; email: string | null } | null;
  try {
    row = await prisma.user.findUnique({ where: { id: userId }, select: { role: true, email: true } });
  } catch (err: any) {
    logger.warn(`spend-cap: user row unreadable for ${userId}, allowing send: ${err?.message ?? err}`);
    return { admissionId: null, reservedUsd: 0, committedUsd: 0, expiresAt: null }; // fail-open on the READ
  }
  if (!row) return { admissionId: null, reservedUsd: 0, committedUsd: 0, expiresAt: null }; // deleted-account race
  if (isAdminViewer(row)) return { admissionId: null, reservedUsd: 0, committedUsd: 0, expiresAt: null }; // ADMINS ARE EXEMPT

  // ── 2. NO CAP → NO HOLD (a hold nobody checks is a row written for nothing) ─
  const cap = lifetimeSpendCapUsd();
  if (cap === null) return { admissionId: null, reservedUsd: 0, committedUsd: 0, expiresAt: null };

  const reserveUsd = spendReservationUsd();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + RESERVATION_TTL_MS);

  try {
    return await prisma.$transaction(async (txRaw) => {
      const tx = txRaw as unknown as AdmissionTx;

      // ── 3. THE LOCK. First statement in the transaction, deliberately: every
      //    read below must happen under it or the admission is not atomic.
      await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtext($1))', userId);

      // ── 4. THE TWO NUMBER READS, both on the TX client (inside the lock).
      const committed = await userLifetimeSpendUsd(userId, now, tx);
      const held = await activeReservationsUsd(userId, now, tx);

      // ── 5. THE DECISION. `>` on the hold comparison: a hold is a provision for
      //    spend that has not happened, so landing exactly on the cap is inside it.
      const projected = committed + held + reserveUsd;
      if (projected > cap) {
        logger.info(
          `spend-cap: ${userId} at ${formatUsd(committed)} lifetime spend + ${formatUsd(held)} in live holds ` +
            `+ ${formatUsd(reserveUsd)} new hold = ${formatUsd(projected)} (cap ${formatUsd(cap)}) — refusing send`,
          { source: 'org' },
        );
        throw new SpendCapReachedError(cap, committed);
      }

      // ── 6. THE HOLD. Committed with the lock in the same transaction.
      const admissionId = randomUUID();
      await tx.spendCapAdmission.create({
        data: { id: admissionId, userId, reservedUsd: reserveUsd, createdAt: now, expiresAt },
      });
      return { admissionId, reservedUsd: reserveUsd, committedUsd: committed, expiresAt };
    }, ADMISSION_TX_OPTIONS as any);
  } catch (err: any) {
    // OUR VERDICT → refuse. Anything else is infra → allow (fail-open, logged).
    if (isSpendCapError(err)) throw err;
    logger.warn(`spend-cap: admission unavailable for ${userId}, allowing send: ${err?.message ?? err}`);
    return { admissionId: null, reservedUsd: 0, committedUsd: 0, expiresAt: null };
  }
}

/**
 * Best-effort sweep of holds that expired. Called opportunistically; never throws.
 * A live row is self-cleaning on its own (the admission read filters on
 * `expiresAt`), so this only keeps the table small — a missed sweep costs disk,
 * never correctness.
 */
export async function sweepExpiredAdmissions(now: Date = new Date()): Promise<number> {
  try {
    const res: any = await (prisma as any).spendCapAdmission.deleteMany({ where: { expiresAt: { lte: now } } });
    return Number(res?.count ?? 0);
  } catch (err: any) {
    logger.warn(`spend-cap: expired-admission sweep failed (harmless): ${err?.message ?? err}`);
    return 0;
  }
}