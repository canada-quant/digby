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
 * ENFORCEMENT IS POLICY-GATED, and ON by default for NEW signups only where it
 * is deliberate — see `emailVerificationRequired()`. This matters: every account
 * that existed before this feature has NULL emailVerifiedAt, so a hard
 * enforcement-by-default would lock the entire existing user base out of chat on
 * deploy. The flag is a SystemSetting (admin-flippable live, no deploy), and the
 * default is OFF; the surfaces (token issue, verify, resend, status) ship now so
 * turning it on is a one-row change rather than a code change.
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
 * Is a verified email REQUIRED to send? Default OFF.
 *
 * Read through SystemSetting so the owner can flip it live (the same
 * admin-PUT pattern as deep_research_daily_limit / patience_auto_only) with no
 * deploy. Any read failure falls back to the SAFE default for availability —
 * 'off' — because the failure mode of 'on' during a DB blip is locking every
 * user out of chat.
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