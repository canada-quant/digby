/**
 * Email verification for self-serve signup (Phase 2 Cloud, todo ea95fa0b leg 1 item 1).
 *
 * THREAT MODEL this shape closes:
 *  - The RAW token never touches the database. We store sha256(raw); the raw
 *    value only ever exists in the emailed link. A database read (backup, a
 *    support query, an injected SELECT) therefore cannot mint a verification
 *    link or verify an arbitrary account.
 *  - Single-use: consuming stamps `consumedAt`; a second use of the same link
 *    is refused rather than silently succeeding.
 *  - Short-lived: 24 h, so a leaked mailbox archive ages out.
 *  - Resend SUPERSEDES: issuing a new token expires the earlier ones for that
 *    user, so an old link cannot be used to undo a newer decision, and the
 *    table cannot grow one live token per click.
 *
 * ⚠ ENFORCEMENT IS GONE, PERMANENTLY (owner directive 2026-11-07T06:40Z): "we
 * dont want to limit usage by email verfication at all … people need to freely
 * use digby.ai logged in or not". `assertEmailVerifiedForSend` is a NO-OP and
 * there is no policy that turns it back on — see its doc comment. New accounts
 * are created ALREADY VERIFIED (auth.service.ts register stamps
 * `emailVerifiedAt`), the same posture as the 94 grandfathered existing rows, so
 * the "verify your email" prompt never appears on a fresh signup.
 *
 * What this file still owns: the token machinery (mint / verify / resend). It is
 * kept because the verify + resend surfaces ship and an operator may want to
 * confirm an address; nothing in it may gate a SEND.
 */
import { createHash, randomBytes } from 'crypto';
import prisma from '../../../config/database';
import logger from '../../../utils/logger';
import { AppError } from '../../../middleware/app-error';
import { sendDigbyEmail } from '../email/digby-email.service';
import { instancePublicUrl } from '../platform/instance-setup';

/** How long a verification link stays usable. */
export const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;
/** The admin setting that turns hard enforcement on (default OFF — see header). */
export const REQUIRE_VERIFICATION_SETTING = 'require_email_verification';

const sha256 = (raw: string): string => createHash('sha256').update(raw).digest('hex');

/**
 * LEGACY READ — exported for compatibility only. NOTHING GATES ON IT.
 *
 * Before 2026-11-07 this was the policy behind the send gate. It is no longer
 * consulted by `assertEmailVerifiedForSend` (a permanent no-op) or by any other
 * send path, and re-wiring it into one would contradict the owner directive —
 * see the header. The function is kept because the SystemSetting row it reads
 * (`require_email_verification`) still exists on deployed instances and admin
 * surfaces/tests reference the key; deleting the reader would make a stale row
 * silently meaningless with no way to see it.
 *
 * Read failure falls back to 'off' (there is nothing to fail closed on).
 */
export async function emailVerificationRequired(): Promise<boolean> {
  try {
    const row = await prisma.systemSetting.findUnique({ where: { key: REQUIRE_VERIFICATION_SETTING } });
    return row?.value === 'true' || row?.value === '1';
  } catch (err: any) {
    logger.warn(`email-verification: policy read failed, treating as OFF: ${err?.message ?? err}`);
    return false;
  }
}

/** Refusal text when an unverified account tries to send with the policy ON. */
export const UNVERIFIED_SEND_MESSAGE =
  'Please verify your email address before sending. Check your inbox for the verification link, or request a new one.';

/**
 * The typed refusal that USED to be thrown by the verification gate (ticket
 * fdb4523f). ⚠ IT IS NO LONGER THROWN ANYWHERE (owner 2026-11-07T06:40Z — see
 * `assertEmailVerifiedForSend`). Exported for compatibility only: other modules
 * and tests reference it by name, and a `name===` check in chat-agent.service.ts
 * must keep compiling and must keep failing safe if such an error ever resurfaces
 * from a stale build.
 *
 * It carries a `name` for the same reason OrgQuotaExceededError does: the
 * machine-wake seam (chat-agent.service.ts) must tell a POLICY verdict apart
 * from an infra fault. It catches guardOrgSend and treats a recognized verdict
 * as "do not start this wake", but deliberately PROCEEDS on anything else so an
 * unrestorable DB blip never silently swallows every scheduled run.
 *
 * AppError's constructor re-parents the prototype to AppError.prototype, which
 * severs `instanceof` for subclasses (the OrgQuotaExceededError lesson), so the
 * real prototype is restored here. Copy this idiom for any new typed refusal.
 */
export class EmailVerificationRequiredError extends AppError {
  constructor() {
    super(403, UNVERIFIED_SEND_MESSAGE);
    this.name = 'EmailVerificationRequiredError';
    Object.setPrototypeOf(this, EmailVerificationRequiredError.prototype);
  }
}

/**
 * ⛔ PERMANENT NO-OP — DELIBERATE, NOT A POLICY TOGGLE (owner 2026-11-07T06:40Z).
 *
 * OWNER'S WORDS: "we dont want to limit usage by email verfication at all …
 * people need to freely use digby.ai logged in or not … and we dont want to
 * limit by messages or anything for digby.ai … maybe a hard $100 usage cap per
 * user non admins".
 *
 * So this function reads NOTHING — no SystemSetting, no user row — and can never
 * throw. It stays exported because `guardOrgSend` imports it (org-quota.service.ts)
 * and it is the documented seam a future reader will look for; the single call
 * site is kept as the honest answer to "where is the verification gate?" — the
 * answer is "here, and it does nothing".
 *
 * DO NOT restore the setting read "just behind a flag". Email verification is not
 * a usage lever any more; the ONLY usage limit in this product is the lifetime
 * spend cap (org/spend-cap.service.ts). If verification ever needs to matter it
 * must not be on the send path at all, because this same gate refused every
 * unverified account — admins included — on a live instance (measured
 * 2026-11-07: 94 of 94 accounts carried a NULL emailVerifiedAt, so flipping it ON
 * blocked all of them).
 *
 * `EmailVerificationRequiredError` below is likewise never thrown from here; it
 * remains exported because chat-agent.service.ts and existing callers/tests
 * reference it by name, and a few historical rows in logs carry it.
 */
export async function assertEmailVerifiedForSend(_userId: string): Promise<void> {
  // Intentionally empty. See the directive above.
}

/** Where the emailed link points. Null when the instance has no public URL. */
export function verificationLinkFor(rawToken: string): string | null {
  const base = instancePublicUrl();
  if (!base) return null;
  // The FRONTEND route — the page calls POST /api/auth/verify-email with the
  // token, so a link opened in any browser (not just the signing-up one) works.
  return `${base}/verify-email?token=${encodeURIComponent(rawToken)}`;
}

/**
 * Issue a fresh token and email it. Returns whether the mail actually went out
 * (the token row is created either way, so the user can still be verified from
 * the resend surface later). NEVER throws on a mail failure — a signup that
 * otherwise succeeded must not fail because SMTP is down.
 */
export async function issueEmailVerification(userId: string, email: string): Promise<{ mailed: boolean; error?: string }> {
  const raw = randomBytes(32).toString('hex');
  const tokenHash = sha256(raw);

  // Supersede: retire this user's live tokens so only the newest link works.
  await prisma.emailVerificationToken.updateMany({
    where: { userId, consumedAt: null },
    data: { consumedAt: new Date() },
  }).catch((err: any) => logger.warn(`email-verification: supersede failed for ${userId}: ${err?.message ?? err}`));

  await prisma.emailVerificationToken.create({
    data: { userId, tokenHash, expiresAt: new Date(Date.now() + VERIFICATION_TTL_MS) },
  });

  const link = verificationLinkFor(raw);
  if (!link) {
    // No public URL (a bare dev box): the token exists but we cannot build a
    // clickable link. Say so honestly rather than emailing a broken one.
    logger.warn(`email-verification: no public URL configured — cannot send a usable link for ${userId}`);
    return { mailed: false, error: 'This instance has no public URL set (SELFHOST_PUBLIC_URL), so a verification link cannot be built.' };
  }

  const result = await sendDigbyEmail({
    to: email,
    subject: 'Verify your Digby email address',
    text: [
      'Confirm your email address to finish setting up your Digby account.',
      '',
      link,
      '',
      'This link expires in 24 hours and works once.',
      "If you didn't create a Digby account, you can ignore this message.",
    ].join('\n'),
  }, { sessionId: userId });

  if (!result.ok) {
    logger.warn(`email-verification: send failed for ${userId}: ${result.error}`);
    return { mailed: false, error: result.error };
  }
  return { mailed: true };
}

/**
 * Consume a token: mark the user verified and burn the token.
 *
 * Idempotency posture: a token is burned exactly once. A REPEAT use of an
 * already-consumed token is refused — but if the account is already verified we
 * answer success, because the user's intent is satisfied and telling them "this
 * link is invalid" when their email is in fact verified is a worse experience
 * than a no-op. An EXPIRED token is always refused.
 */
export async function consumeEmailVerification(rawToken: string): Promise<{ userId: string; alreadyVerified: boolean }> {
  const token = String(rawToken ?? '').trim();
  if (!token) throw new AppError(400, 'Verification token is required');

  const row = await prisma.emailVerificationToken.findUnique({
    where: { tokenHash: sha256(token) },
    select: { id: true, userId: true, expiresAt: true, consumedAt: true },
  });
  if (!row) throw new AppError(400, 'This verification link is not valid.');

  const user = await prisma.user.findUnique({ where: { id: row.userId }, select: { emailVerifiedAt: true } });
  if (!user) throw new AppError(400, 'This verification link is not valid.');

  if (row.consumedAt) {
    // Already used. Fine if the account is verified; otherwise it is a stale link.
    if (user.emailVerifiedAt) return { userId: row.userId, alreadyVerified: true };
    throw new AppError(400, 'This verification link has already been used. Request a new one.');
  }
  if (row.expiresAt.getTime() < Date.now()) {
    throw new AppError(400, 'This verification link has expired. Request a new one.');
  }

  const now = new Date();
  // Burn the token and stamp the user together: a crash between the two would
  // otherwise leave a live token whose account reads unverified.
  await prisma.$transaction([
    prisma.emailVerificationToken.update({ where: { id: row.id }, data: { consumedAt: now } }),
    prisma.user.update({ where: { id: row.userId }, data: { emailVerifiedAt: now } }),
  ]);
  logger.info(`email-verification: user ${row.userId} verified`, { source: 'auth' });
  return { userId: row.userId, alreadyVerified: false };
}

/** Resend for a signed-in but unverified user. Refused when already verified. */
export async function resendEmailVerification(userId: string): Promise<{ mailed: boolean; error?: string }> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, emailVerifiedAt: true } });
  if (!user) throw new AppError(401, 'Account not found');
  if (user.emailVerifiedAt) throw new AppError(400, 'This email address is already verified.');
  return issueEmailVerification(userId, user.email);
}