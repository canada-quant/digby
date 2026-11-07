/**
 * Terms of Service / Acceptable Use acceptance (Phase 2 Cloud leg 1 item 5,
 * todo ea95fa0b) — the ONE place the accepted version and the enforcement
 * policy live.
 *
 * WHY A SWITCH RATHER THAN A HARD REQUIREMENT: every pre-existing account has
 * users.termsAcceptedAt = NULL, because the column is new. Turning acceptance
 * into a hard registration requirement on deploy would refuse the entire back
 * catalogue their next sign-in — the same footgun `require_email_verification`
 * exists to avoid. So enforcement defaults OFF and the owner flips it live from
 * SystemSetting, with no deploy. Recording, by contrast, is always ON: an
 * acceptance we did not store cannot be evidenced later.
 *
 * WHY THE VERSION IS STORED: "accepted the terms" is only evidence if you know
 * WHICH terms. TERMS_VERSION mirrors the /terms page's "Last updated" line; when
 * that page is revised, bump this constant in the same commit so new
 * acceptances carry the new version and old rows keep the one they actually
 * agreed to.
 */
import prisma from '../../../config/database';
import logger from '../../../utils/logger';

/**
 * The version a fresh acceptance records. MUST track the /terms page's
 * `LAST_UPDATED` (frontend/app/(site)/terms/page.tsx). Pinned by
 * terms.service.test.ts so the two cannot drift silently.
 */
export const TERMS_VERSION = '2026-10-14';

/** The admin setting that turns a hard acceptance requirement on (default OFF). */
export const REQUIRE_TERMS_SETTING = 'require_terms_acceptance';

/**
 * Is recorded acceptance REQUIRED to register? Default OFF.
 *
 * Read through SystemSetting (the admin-PUT pattern used by
 * require_email_verification / deep_research_daily_limit). Any read failure
 * falls back to 'off' — the availability-safe default, because failing 'on'
 * during a DB blip would refuse every new signup.
 */
export async function termsAcceptanceRequired(): Promise<boolean> {
  try {
    const row = await prisma.systemSetting.findUnique({ where: { key: REQUIRE_TERMS_SETTING } });
    return row?.value === 'true' || row?.value === '1';
  } catch (err: any) {
    logger.warn(`terms: policy read failed, treating as OFF: ${err?.message ?? err}`);
    return false;
  }
}

export interface TermsDecision {
  /** True when the caller may proceed (accepted now, or not required). */
  allowed: boolean;
  /** True when this request recorded a fresh acceptance. */
  recorded: boolean;
  /** The version recorded, when recorded. */
  version: string | null;
  /** Operator-facing refusal text when allowed === false. */
  message?: string;
}

/**
 * Decide whether a registration may proceed, and record the acceptance when one
 * was supplied.
 *
 * Deliberately SEPARATE from the user insert: the caller records acceptance
 * against the already-created user id, so a DB write that fails here is logged
 * and never rolls back a signup that otherwise succeeded (the same
 * non-fatal-but-always-attempted posture as the personal-org creation).
 */
export async function evaluateTermsAcceptance(accepted: boolean | undefined): Promise<TermsDecision> {
  const required = await termsAcceptanceRequired();

  if (accepted === true) {
    return { allowed: true, recorded: true, version: TERMS_VERSION };
  }

  if (required) {
    return {
      allowed: false,
      recorded: false,
      version: null,
      message: 'You must accept the Terms of Service and Acceptable Use to create an account.',
    };
  }

  // Not accepted and not required: proceed, record nothing. A NULL acceptance is
  // honest evidence that none was given — never fabricate a timestamp here.
  return { allowed: true, recorded: false, version: null };
}

/**
 * Stamp the acceptance on a user row. Never throws: the caller has already
 * decided, and a bookkeeping failure must not fail a registration.
 */
export async function recordTermsAcceptance(userId: string, version: string): Promise<boolean> {
  try {
    await prisma.user.update({
      where: { id: userId },
      data: { termsAcceptedAt: new Date(), termsVersion: version },
    });
    return true;
  } catch (err: any) {
    logger.warn(`terms: could not record acceptance for ${userId}: ${err?.message ?? err}`);
    return false;
  }
}