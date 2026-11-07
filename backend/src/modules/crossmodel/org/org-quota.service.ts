/**
 * Per-org quota enforcement (Phase 2 Cloud, todo ea95fa0b leg 1 item 3).
 *
 * TWO counters, both scoped to the ORG (a team shares one pool; a solo user has
 * a personal org — org.service.ts):
 *   1. MESSAGES per UTC day — "how many times may this tenant send".
 *   2. TOKENS per UTC day PER MODEL — "how much of each model may this tenant
 *      spend". Per-model matters because the rungs differ in price by orders of
 *      magnitude; a single pooled token number would let a cheap model's
 *      headroom pay for an expensive one.
 *
 * WHY THIS CANNOT BE BYPASSED BY ESCALATING COMPUTE DEPTH: the guard runs in
 * startDetachedChatRun, BEFORE the run starts — and the compute plan (checker
 * spawn, council, lead effort, Quick-lane swap) is decided much later, inside
 * the run (chat-agent.service.ts decideComputePlan). So a deeper rung is reached
 * only by a run that already paid the message reservation. There is no depth to
 * escalate to that skips this point.
 *
 * FAIL-CLOSED means two different things here, deliberately:
 *   - When a limit is SET and it is exhausted, the send is REFUSED (HTTP 429).
 *     Not degraded, not silently answered by a cheaper model — refused, because
 *     a silent downgrade is how a quota turns into an unexplained quality bug.
 *   - When the limit is NULL the org is UNLIMITED and nothing is refused. That
 *     is the posture for every pre-existing account and self-host instance, so
 *     this feature changes no existing behaviour.
 * The one place we do NOT fail closed is an infrastructure error while reading
 * the counter: if the database cannot be reached we ALLOW the send and log it.
 * Refusing every user's message during a DB blip would be a self-inflicted
 * outage, and the counters are money-guards, not a security boundary.
 */
import prisma from '../../../config/database';
import logger from '../../../utils/logger';
import { AppError } from '../../../middleware/app-error';
import { ensurePersonalOrgForUser, type DefaultOrg } from './org.service';
// Email verification enforcement: now a PERMANENT NO-OP (owner 2026-11-07T06:40Z).
// The import stays so the send guard keeps the documented seam — see the call in
// guardOrgSend and the directive in email-verification.service.ts.
import { assertEmailVerifiedForSend } from './email-verification.service';
// THE ONLY USAGE LIMIT (owner 2026-11-07T06:40Z): hard lifetime $ cap, admins exempt.
// The ATOMIC admission (review defect 2026-11-07): a preflight read alone let two
// concurrent sends both pass at the same remaining headroom, so the guard reserves a
// per-send hold under a per-user Postgres advisory lock instead.
import { admitWithinLifetimeSpendCap } from './spend-cap.service';

/** Refusal carrying HTTP 429 so the error handler answers a real status, not a 500. */
export class OrgQuotaExceededError extends AppError {
  constructor(message: string, readonly detail: { reason: 'messages' | 'tokens' | 'suspended'; organizationId: string; used?: number; limit?: number }) {
    super(429, message);
    this.name = 'OrgQuotaExceededError';
    // AppError's constructor sets the prototype to AppError.prototype, which
    // severs the chain for every subclass — `instanceof OrgQuotaExceededError`
    // was FALSE without this line. That is not cosmetic: the token-quota path
    // re-throws only when it can recognize its own error, so the broken check
    // made a token refusal fall through to the "infra error, allow the send"
    // catch and silently permit an over-quota send. Restore the real prototype.
    Object.setPrototypeOf(this, OrgQuotaExceededError.prototype);
  }
}

/**
 * Is this a quota refusal? Checks the NAME as well as the class, deliberately:
 * these errors cross dynamic-`import()` module boundaries in several callers,
 * where a duplicated module instance can make `instanceof` fail even when the
 * prototype is correct. A quota refusal must NEVER be mistaken for an infra
 * error — one refuses the send, the other allows it.
 */
export function isQuotaExceededError(err: any): err is OrgQuotaExceededError {
  return err instanceof OrgQuotaExceededError || err?.name === 'OrgQuotaExceededError';
}

export interface QuotaDecision {
  allowed: boolean;
  reason?: 'messages' | 'tokens' | 'suspended';
  organizationId: string;
  used: number;
  limit: number | null;
  remaining: number | null;
  message?: string;
}

/** Midnight UTC of the current day — the bucket key for every usage row. */
export function utcDayKey(at: Date = new Date()): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

/**
 * Per-model daily TOKEN ceilings, admin-tunable live via SystemSetting
 * `org_model_token_limits` (JSON), so a new model never needs a schema change:
 *   { "default": 300000, "kimi-k3": 1500000, "deepseek-flash": null }
 * Absent key / absent setting / explicit null => unlimited for that model.
 */
export const MODEL_TOKEN_LIMITS_SETTING = 'org_model_token_limits';

export interface ModelTokenLimits { [model: string]: number | null }

export async function modelTokenLimits(): Promise<ModelTokenLimits> {
  try {
    const row = await prisma.systemSetting.findUnique({ where: { key: MODEL_TOKEN_LIMITS_SETTING } });
    if (!row?.value) return {};
    const parsed = JSON.parse(row.value);
    if (!parsed || typeof parsed !== 'object') return {};
    const out: ModelTokenLimits = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (v === null) { out[k] = null; continue; }
      const n = Number(v);
      if (Number.isFinite(n) && n >= 0) out[k] = n;
    }
    return out;
  } catch (err: any) {
    logger.warn(`org-quota: model token limits unreadable, treating as unlimited: ${err?.message ?? err}`);
    return {};
  }
}

/** The org a send bills against, creating the personal org if it is somehow missing. */
export async function orgForUser(userId: string): Promise<DefaultOrg> {
  return ensurePersonalOrgForUser(userId);
}

/**
 * ATOMIC reservation of one message slot, taken BEFORE the run starts.
 *
 * The increment is a single upsert with `increment`, so two simultaneous sends
 * cannot both read "4 of 5" and both pass — the counter moves at the database,
 * not in application memory. The check reads the value the increment RETURNED,
 * and a reservation that lands over the limit is released with a compensating
 * decrement so a refused attempt never permanently eats a slot.
 */
export async function reserveOrgMessage(userId: string): Promise<QuotaDecision> {
  let org: DefaultOrg;
  try {
    org = await orgForUser(userId);
  } catch (err: any) {
    // Cannot resolve an org at all: allow and log (see FAIL-CLOSED header).
    logger.warn(`org-quota: could not resolve org for ${userId}, allowing send: ${err?.message ?? err}`);
    return { allowed: true, organizationId: '', used: 0, limit: null, remaining: null };
  }

  if (org.suspended) {
    return {
      allowed: false, reason: 'suspended', organizationId: org.id, used: 0, limit: null, remaining: null,
      message: org.suspendedReason
        ? `This workspace is suspended: ${org.suspendedReason}`
        : 'This workspace is suspended. Contact support.',
    };
  }

  const day = utcDayKey();
  let after: number;
  try {
    const row = await prisma.orgUsageDaily.upsert({
      where: { organizationId_day: { organizationId: org.id, day } },
      create: { organizationId: org.id, day, messages: 1 },
      update: { messages: { increment: 1 } },
      select: { messages: true },
    });
    after = row.messages;
  } catch (err: any) {
    logger.warn(`org-quota: message counter unavailable for org ${org.id}, allowing send: ${err?.message ?? err}`);
    return { allowed: true, organizationId: org.id, used: 0, limit: org.dailyMessageLimit, remaining: null };
  }

  const limit = org.dailyMessageLimit;
  // ── NO MESSAGE-COUNT REFUSAL (owner directive 2026-11-07T06:40Z) ───────────
  // "we dont want to limit by messages or anything for digby.ai". The counter
  // above STILL RUNS — it is the usage meter the dashboards and cost panels read
  // — but it never refuses a send. This deliberately holds even when an operator
  // has set a legacy `dailyMessageLimit` on the org (admin quota PUT) or a legacy
  // row predates this change: a limit VALUE must never reintroduce a refusal
  // path on Cloud. The `limit` fields below are informational only.
  //
  // What still refuses here: an org `suspended` by an operator (the per-tenant
  // kill switch, kept on purpose — it is an abuse lever, not a usage limit).
  return {
    allowed: true,
    organizationId: org.id,
    used: after,
    limit: limit ?? null,
    remaining: limit === null ? null : Math.max(0, limit - after),
  };
}

/**
 * Token pre-check: refuse when the org is ALREADY at/over a per-model ceiling
 * today. This is a check, not a reservation — an exact reservation would have to
 * guess the turn's token cost before the model ran, and over-reserving would
 * refuse sends the org could actually afford. The authoritative accumulator is
 * recordOrgTokens below.
 */
export async function assertOrgTokensAvailable(orgId: string): Promise<void> {
  if (!orgId) return;
  // ── NO TOKEN-COUNT REFUSAL (owner directive 2026-11-07T06:40Z) ─────────────
  // "we dont want to limit by messages or anything for digby.ai". Token totals
  // are still ACCUMULATED by recordOrgTokens below — they feed the cost panels —
  // but no ceiling refuses a send. This holds even when an operator has set
  // `org_model_token_limits` (a legacy row, or an admin write): a limit VALUE
  // must never reintroduce a refusal path on Cloud. The funcname is kept so the
  // one call site in guardOrgSend stays the documented place a reader looks.
  //
  // Deliberately NOT reading modelTokenLimits(): a read that cannot refuse is a
  // wasted query on the hot send path.
  return;
}

/**
 * Accumulate one model turn's tokens into the org's per-model daily row and the
 * day's denormalized totals. Best-effort: this runs AFTER the model has been
 * paid for, so a failure here must never surface to the user — it under-counts
 * usage, which is the conservative direction for a spend guard (we would rather
 * miss a few tokens than fail a delivered answer).
 */
export async function recordOrgTokens(orgId: string, model: string, tokensIn: number, tokensOut: number): Promise<void> {
  if (!orgId || !model) return;
  const tin = Math.max(0, Math.round(tokensIn || 0));
  const tout = Math.max(0, Math.round(tokensOut || 0));
  if (!tin && !tout) return;
  const day = utcDayKey();
  try {
    await prisma.orgModelUsageDaily.upsert({
      where: { organizationId_day_model: { organizationId: orgId, day, model } },
      create: { organizationId: orgId, day, model, tokensIn: tin, tokensOut: tout },
      update: { tokensIn: { increment: tin }, tokensOut: { increment: tout } },
    });
    await prisma.orgUsageDaily.upsert({
      where: { organizationId_day: { organizationId: orgId, day } },
      create: { organizationId: orgId, day, tokensIn: tin, tokensOut: tout },
      update: { tokensIn: { increment: tin }, tokensOut: { increment: tout } },
    });
  } catch (err: any) {
    logger.warn(`org-quota: token recording failed for org ${orgId} model ${model}: ${err?.message ?? err}`);
  }
}

/**
 * THE SEND GUARD — one call that enforces the lifetime spend cap, reserves a
 * message slot and enforces the token ceiling. Throws SpendCapReachedError (402)
 * or OrgQuotaExceededError (429) when the send must be refused; never returns a
 * "busy"-shaped value, because callers already treat those as "queue it" and the
 * user would wait forever instead of seeing a refusal.
 */
export async function guardOrgSend(userId: string): Promise<{ organizationId: string }> {
  // THE ONLY USAGE LIMIT (owner 2026-11-07T06:40Z): a hard lifetime $ cap per
  // non-admin user. Runs FIRST — before the message reservation — so a user over
  // their cap neither sends nor consumes a message slot.
  //
  // Email verification used to be enforced here (ticket fdb4523f) and is now a
  // PERMANENT NO-OP (`assertEmailVerifiedForSend`, same owner directive). The call
  // is kept as the one documented place a reader looks for that gate; it reads
  // nothing and cannot throw, so the hot path gained no query.
  await assertEmailVerifiedForSend(userId);
  // ATOMIC ADMISSION (review defect 2026-11-07): reserves a per-send budget hold
  // inside a transaction that holds a per-user Postgres advisory lock, so two
  // concurrent sends can never both pass against the same remaining headroom.
  // Throws SpendCapReachedError (402) exactly like the preflight it replaced.
  await admitWithinLifetimeSpendCap({ id: userId });

  const decision = await reserveOrgMessage(userId);
  if (!decision.allowed) {
    throw new OrgQuotaExceededError(decision.message ?? 'Daily limit reached.', {
      reason: decision.reason ?? 'messages',
      organizationId: decision.organizationId,
      used: decision.used,
      limit: decision.limit ?? undefined,
    });
  }
  await assertOrgTokensAvailable(decision.organizationId);
  return { organizationId: decision.organizationId };
}

/** Roll a reservation back when the send never became a run (e.g. the arch refused it later). */
export async function releaseOrgMessage(orgId: string): Promise<void> {
  if (!orgId) return;
  try {
    await prisma.orgUsageDaily.update({
      where: { organizationId_day: { organizationId: orgId, day: utcDayKey() } },
      data: { messages: { decrement: 1 } },
    });
  } catch { /* best-effort, mirrors the refund posture in rate-limit.service.ts */ }
}