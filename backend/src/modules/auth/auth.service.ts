import { createHash } from 'crypto';
import prisma from '../../config/database';
import redisClient from '../../config/redis';
import { hashPassword, comparePassword } from '../../utils/password';
import { generateAccessToken, generateRefreshToken, verifyRefreshToken } from '../../utils/jwt';
import { AppError } from '../../middleware/error-handler';
// Self-host setup hardening (2026-10-20): SELFHOST_ADMIN_EMAIL bootstraps the first
// administrator on a NON-production instance (pure leaf; never acts on production).
import { selfhostAdminEmailFor } from '../crossmodel/platform/instance-setup';
import logger from '../../utils/logger';
import { recordPasswordChangeCutoff } from './password-change-cutoff';
// Prisma-only leaf (the store table): chat-keyed rows of the account's chats (2026-10-23).
import { storeDeleteChatScoped, type StoreDeleteClient } from '../crossmodel/memory/context-store';
// Phase 2 Cloud: the auto-created personal org (todo ea95fa0b leg 1 item 2).
import { ensurePersonalOrg } from '../crossmodel/org/org.service';
// Phase 2 Cloud: email verification on self-serve signup (leg 1 item 1).
import { issueEmailVerification, resendEmailVerification } from '../crossmodel/org/email-verification.service';
// Phase 2 Cloud: ToS/AUP acceptance at signup (leg 1 item 5).
import { evaluateTermsAcceptance, recordTermsAcceptance } from '../crossmodel/org/terms.service';

const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface ChangePasswordInput {
  currentPassword: string;
  newPassword: string;
}

export interface ChangePasswordResult {
  accessToken: string;
  refreshToken: string;
  /** Refresh-token rows deleted: every device's, the caller's old one included. */
  refreshTokensRevoked: number;
  /** True when the access-token cutoff reached Redis, so other devices' access tokens stop working. */
  accessTokensCutOff: boolean;
}

export interface DeleteAccountInput {
  password: string;
}

/**
 * The account purge's interactive-transaction options (integration recheck
 * 2026-10-23). Explicit and generous: the cascade (user → chats → messages →
 * coding sessions → runs → events …) runs inside the transaction, atomic with
 * the FK-less sweep, and Prisma's DEFAULT 5 s timeout failed a large
 * account's delete — the admin path ran it as a bare statement (no client
 * timeout) before it shared this purge. maxWait covers the pool's connection
 * acquisition (default 2 s). No env knob: a value, not a policy switch.
 */
export const ACCOUNT_PURGE_TX_OPTIONS = Object.freeze({ maxWait: 10_000, timeout: 10 * 60_000 });

/**
 * Hard-delete a user AND the rows the FK cascade cannot reach — the ONE
 * cleanup both delete paths share (review 2026-10-23: the admin hard delete,
 * crossmodel.controller adminDeleteUser, was a bare `prisma.user.delete`, so
 * it left user_memory_facts, the user's context-store namespace, the
 * chat-keyed store rows — thread summaries and the supervisor ledger's cold
 * archive of closed owner directives — and the supervisor chats' memory
 * mirror behind, ownerless, forever). Throws only if the transaction fails;
 * the post-commit passes are best-effort.
 */
export async function purgeUserAccount(userId: string): Promise<void> {
  // FK-less cleanup BEFORE the cascade (inside the transaction). The
  // context store's namespace is ":"-joined — [userId, 'memory'] rows live
  // under "userId:memory"; a prefix match can only hit this user's
  // namespaces (UUIDs contain no ':').
  let supervisorChatIds: string[] = [];
  let chatIds: string[] = [];
  await prisma.$transaction(async (tx) => {
    await tx.userMemoryFact.deleteMany({ where: { userId } });
    // 2026-10-20: the fact value history (memory/fact-versions.ts) — FK-less like user_memory_facts.
    await tx.userMemoryFactVersion.deleteMany({ where: { userId } });
    await tx.contextStoreEntry.deleteMany({
      where: { namespacePath: { startsWith: `${userId}:` } },
    });
    // 2026-10-23 (fs-durable-memory review): the store also keys rows by
    // CHAT id — the thread summary [chatId,'thread'] and a supervisor's
    // cold closed-row archive [chatId,'supervisor-archive'] (owner
    // directive text + evidence). The chats cascade below; their rows
    // would not. Exact namespace paths (primary-key lookups, chunked).
    const chats = await tx.crossModelChat.findMany({ where: { userId }, select: { id: true } });
    chatIds = chats.map((c) => c.id);
    await storeDeleteChatScoped(chatIds, tx as unknown as StoreDeleteClient);
    supervisorChatIds = (await tx.supervisorState.findMany({ where: { userId }, select: { chatId: true } })).map((r) => r.chatId);
    await tx.user.delete({ where: { id: userId } });
  }, ACCOUNT_PURGE_TX_OPTIONS);

  // Second pass AFTER the commit (fs-durable-memory re-review, 2026-10-23):
  // the in-tx sweep runs before the cascade, so a supervisor write whose
  // cold-archive puts land after it — and whose hot write still beats the
  // user delete — would leave rows behind. Past this point a supervisor
  // write fails on the chat FK and purges its own rows (upsertDoc).
  // Best-effort: the account is already gone.
  if (chatIds.length) {
    await storeDeleteChatScoped(chatIds).catch((err: any) => {
      logger.warn(`purgeUserAccount: post-commit chat-keyed store sweep failed: ${err?.message ?? err}`);
    });
  }

  // The supervisor ledger's memory mirror lives in the chat scope of
  // digby_memory (FK-less, outside Prisma's schema): cleared after the
  // commit, best-effort — a failure never un-deletes the account.
  if (supervisorChatIds.length) {
    try {
      const { memClear } = await import('../crossmodel/memory/unified-memory.service');
      for (const id of supervisorChatIds) await memClear({ type: 'chat', id }).catch(() => {});
    } catch (err: any) {
      logger.warn(`purgeUserAccount: supervisor chat-scope memory cleanup failed: ${err?.message ?? err}`);
    }
  }
}

export interface RegisterInput {
  email: string;
  password: string;
  firstName?: string;
  lastName?: string;
  /** Phase 2 Cloud leg 1 item 5 — the client's ToS/AUP checkbox. */
  acceptedTerms?: boolean;
}

export interface LoginInput {
  email: string;
  password: string;
}

export class AuthService {
  async register(data: RegisterInput) {
    // Normalize email to lowercase — prevents case-sensitive duplicates
    const normalizedEmail = data.email.toLowerCase().trim();

    // Check if user already exists (case-insensitive for legacy accounts)
    let existingUser = await prisma.user.findUnique({
      where: { email: normalizedEmail },
    });
    if (!existingUser) {
      // Fallback: case-insensitive search for legacy accounts with mixed-case emails
      existingUser = await prisma.user.findFirst({
        where: { email: { equals: normalizedEmail, mode: 'insensitive' } },
      });
    }

    if (existingUser) {
      throw new AppError(400, 'User already exists');
    }

    // ToS/AUP acceptance (Phase 2 Cloud leg 1 item 5). Evaluated BEFORE the user
    // row exists so a policy refusal cannot leave an account behind. Recording is
    // unconditional when the client sent `acceptedTerms: true` (evidence must
    // exist even while enforcement is still OFF); refusing is policy-gated.
    const terms = await evaluateTermsAcceptance(data.acceptedTerms);
    if (!terms.allowed) {
      throw new AppError(400, terms.message ?? 'Terms acceptance is required');
    }

    // Hash password
    const hashedPassword = await hashPassword(data.password);

    // Create user and account — always store email as lowercase
    const user = await prisma.user.create({
      data: {
        email: normalizedEmail,
        password: hashedPassword,
        firstName: data.firstName,
        lastName: data.lastName,
        // AUTO-VERIFIED AT CREATION (owner directive 2026-11-07T06:40Z: "we dont
        // want to limit usage by email verfication at all … people need to freely
        // use digby.ai logged in or not"). Every NEW account is stamped verified
        // the same way the 94 grandfathered pre-existing accounts were backfilled,
        // so all 94 + every new signup share ONE posture. The verification gate
        // itself is a permanent no-op (org/email-verification.service.ts), so this
        // is belt AND braces: even a stale build that still consulted the setting
        // cannot block a new signup, and the "verify your email" prompt never
        // appears because the account is already verified.
        emailVerifiedAt: new Date(),
        // Self-host first-admin bootstrap (2026-10-20): the SELFHOST_ADMIN_EMAIL
        // address registers as ADMIN on a non-production instance; undefined
        // keeps the schema default (USER) everywhere else.
        ...(selfhostAdminEmailFor(normalizedEmail) ? { role: 'ADMIN' as const } : {}),
        accounts: {
          create: {
            type: 'local',
            provider: 'email',
          },
        },
      },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        role: true,
        emailVerifiedAt: true,
        createdAt: true,
      },
    });

    // Personal org (Phase 2 Cloud, todo ea95fa0b leg 1 item 2): every account
    // gets exactly one auto-created org + OWNER membership, so "signup with or
    // without a team" is ONE code path downstream. Deliberately NOT fatal: the
    // send guard self-heals a missing org lazily (org.service.ts), and refusing
    // a registration that otherwise succeeded over org bookkeeping would be the
    // worse failure. A throw here is logged, not surfaced.
    try {
      await ensurePersonalOrg(user.id, user.email, user.firstName);
    } catch (err: any) {
      logger.warn(`register: personal org creation failed for ${user.id} (send path will self-heal): ${err?.message ?? err}`);
    }

    // ToS/AUP acceptance recording (Phase 2 Cloud leg 1 item 5). Non-fatal like
    // the org above: a bookkeeping failure must not fail a registration that
    // otherwise succeeded. Only recorded when the client actually accepted —
    // terms.service decides that, and returns recorded:false otherwise, so this
    // never fabricates an acceptance timestamp.
    if (terms.recorded && terms.version) {
      await recordTermsAcceptance(user.id, terms.version);
    }

    // Email verification (Phase 2 Cloud leg 1 item 1) — NO LONGER ISSUED AT
    // SIGNUP (owner 2026-11-07T06:40Z). The account is created already verified
    // (see `emailVerifiedAt: new Date()` above), so mailing a "verify your
    // email" link would be a prompt with nothing left to do — exactly the
    // friction the owner's directive removes. `issueEmailVerification` stays
    // exported and is still reachable from the resend surface (a user who WANTS
    // to confirm an address, or an operator whose account predates the
    // backfill), and the one guard here is the verification state itself rather
    // than a hard-coded skip, so the export cannot silently drift out of use.
    // Non-fatal posture unchanged: nothing in this block may fail a signup.
    let verificationMailed = false;
    if (!user.emailVerifiedAt) {
      try {
        const issued = await issueEmailVerification(user.id, user.email);
        verificationMailed = issued.mailed;
      } catch (err: any) {
        logger.warn(`register: verification issue failed for ${user.id}: ${err?.message ?? err}`);
      }
    }

    // Generate tokens
    const accessToken = generateAccessToken({
      userId: user.id,
      email: user.email,
      role: user.role,
    });

    const refreshToken = generateRefreshToken({
      userId: user.id,
      email: user.email,
      role: user.role,
    });

    // Store refresh token in database
    await prisma.refreshToken.create({
      data: {
        userId: user.id,
        token: refreshToken,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
      },
    });

    return {
      user,
      accessToken,
      refreshToken,
    };
  }

  async login(data: LoginInput) {
    // Normalize email to lowercase
    const normalizedEmail = data.email.toLowerCase().trim();

    // Find user (case-insensitive for legacy accounts with mixed-case emails)
    let user = await prisma.user.findUnique({
      where: { email: normalizedEmail },
    });
    if (!user) {
      // Fallback: case-insensitive search for legacy accounts
      user = await prisma.user.findFirst({
        where: { email: { equals: normalizedEmail, mode: 'insensitive' } },
      });
    }

    if (!user || !user.isActive) {
      throw new AppError(401, 'Invalid credentials');
    }

    // Verify password
    const isValidPassword = await comparePassword(data.password, user.password);

    if (!isValidPassword) {
      throw new AppError(401, 'Invalid credentials');
    }

    // Self-host first-admin bootstrap (2026-10-20): an already-registered
    // SELFHOST_ADMIN_EMAIL account is promoted at sign-in on a non-production
    // instance (idempotent; a failed update never blocks the login).
    if (user.role !== 'ADMIN' && selfhostAdminEmailFor(user.email)) {
      try {
        user = await prisma.user.update({ where: { id: user.id }, data: { role: 'ADMIN' } });
      } catch { /* promotion is best-effort; the setup page names the variable */ }
    }

    // Generate tokens (carry Digby Kids flags so the client + middleware can
    // lock a child session down without an extra DB round-trip)
    const accessToken = generateAccessToken({
      userId: user.id,
      email: user.email,
      role: user.role,
      isChild: user.isChild,
      parentId: user.parentId,
    });

    const refreshToken = generateRefreshToken({
      userId: user.id,
      email: user.email,
      role: user.role,
      isChild: user.isChild,
      parentId: user.parentId,
    });

    // Store refresh token
    await prisma.refreshToken.create({
      data: {
        userId: user.id,
        token: refreshToken,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });

    return {
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
        isChild: user.isChild,
        parentId: user.parentId,
        childAge: user.childAge,
      },
      accessToken,
      refreshToken,
    };
  }

  async refresh(token: string) {
    // Verify refresh token
    const payload = verifyRefreshToken(token);

    // Check if token exists in database
    const storedToken = await prisma.refreshToken.findUnique({
      where: { token },
    });

    if (!storedToken || storedToken.expiresAt < new Date()) {
      throw new AppError(401, 'Invalid refresh token');
    }

    // Get user
    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
    });

    if (!user || !user.isActive) {
      throw new AppError(401, 'User not found');
    }

    // Generate new tokens
    const accessToken = generateAccessToken({
      userId: user.id,
      email: user.email,
      role: user.role,
      isChild: user.isChild,
      parentId: user.parentId,
    });

    const newRefreshToken = generateRefreshToken({
      userId: user.id,
      email: user.email,
      role: user.role,
      isChild: user.isChild,
      parentId: user.parentId,
    });

    // Delete old refresh token and create new one
    await prisma.refreshToken.delete({
      where: { token },
    });

    await prisma.refreshToken.create({
      data: {
        userId: user.id,
        token: newRefreshToken,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });

    return {
      accessToken,
      refreshToken: newRefreshToken,
    };
  }

  async logout(token: string) {
    // Delete refresh token from database
    await prisma.refreshToken.deleteMany({
      where: { token },
    });
  }

  /**
   * Delete an account permanently (App Store 5.1.1(v) / Play Data-deletion
   * — the mobile Settings screen's "Delete account" action, M2-prep).
   *
   * HARD DELETE (not the admin soft-delete): store review requires the data
   * to actually go. The User row's FKs are all Cascade (verified 2026-09-25 —
   * no Restrict anywhere in the schema), so `user.delete` tears down chats →
   * messages, coding sessions → runs → events → receipts, refresh tokens,
   * push tokens, OAuth tokens, memory, projects, etc. in one Postgres
   * cascade. FK-less surfaces need MANUAL cleanup (they would otherwise
   * be orphaned): the memory-fact retrieval index (user_memory_facts + its
   * version history), the context store's user-scoped namespace ([userId, …]
   * rows in "store"), its CHAT-keyed rows of the user's chats (thread summary
   * + supervisor cold archive — 2026-10-23) and, after the commit, the
   * chat-scope memory mirror of the user's supervisor chats.
   *
   * Mod/content reports (user_feature_requests.userId) and message feedback
   * (message_feedback.userId) are SetNull-or-nullable by design — reports
   * SURVIVE the reporter's deletion (a moderation trail must not vanish with
   * the account that filed it).
   *
   * Access tokens are stateless JWTs (15-min TTL): hard-deleting the user
   * kills every refresh immediately; a live access token can survive up to
   * its TTL, which the store reviewers accept as standard JWT practice.
   * Password re-auth closes the drive-by window: a stolen bearer token
   * alone cannot delete the account.
   */
  async deleteAccount(userId: string, data: DeleteAccountInput) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, password: true, email: true, deletedAt: true },
    });

    if (!user) {
      // Already gone (double-tap on the confirm dialog) — idempotent success.
      return { deleted: true };
    }

    const isValidPassword = await comparePassword(data.password, user.password);
    if (!isValidPassword) {
      throw new AppError(401, 'Invalid credentials');
    }

    await purgeUserAccount(userId);

    logger.info(`User account deleted: ${user.email}`);

    return { deleted: true };
  }

  /**
   * Change the signed-in user's password (2026-10-12; after the 2026-10-11
   * security incident, signed-in users had no way to do this).
   *
   * Re-auths with the current password and hashes the new one exactly like
   * register (utils/password, bcrypt cost 10). Then ONE transaction writes the
   * hash, deletes EVERY refresh-token row of the user (all devices, the
   * caller's old one included) and stores a freshly minted refresh token for
   * the caller. The controller hands the new pair back the way login does, so
   * the tab that changed the password stays signed in. Access tokens are
   * stateless JWTs: the password-change cutoff (./password-change-cutoff)
   * makes the auth middlewares reject every access token issued before now.
   *
   * Refusals: a Digby Kids child account (the parent sets its password via
   * PATCH /crossmodel/children/:id) → 403; an account with no password hash →
   * 400; a wrong current password → 400, NOT 401, because the web client's
   * axios interceptor treats a 401 as an expired session and would refresh
   * and retry. Never logs a password or a hash.
   */
  async changePassword(userId: string, data: ChangePasswordInput): Promise<ChangePasswordResult> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        role: true,
        password: true,
        isActive: true,
        deletedAt: true,
        isChild: true,
        parentId: true,
      },
    });

    if (!user || !user.isActive || user.deletedAt) {
      throw new AppError(401, 'Unauthorized');
    }
    if (user.isChild) {
      throw new AppError(403, "A child account's password is set by the parent, who can change it under Account → Kids.");
    }
    if (!user.password) {
      throw new AppError(400, 'This account has no password set, so there is no password to change.');
    }

    const isValidPassword = await comparePassword(data.currentPassword, user.password);
    if (!isValidPassword) {
      throw new AppError(400, 'Current password is incorrect');
    }

    const hashedPassword = await hashPassword(data.newPassword);

    // The cutoff is taken BEFORE the caller's new tokens are minted, so their
    // iat is ≥ the cutoff and they pass; every older access token fails.
    const cutoffSec = Math.floor(Date.now() / 1000);
    const tokenPayload = {
      userId: user.id,
      email: user.email,
      role: user.role,
      isChild: user.isChild,
      parentId: user.parentId,
    };
    const accessToken = generateAccessToken(tokenPayload);
    const refreshToken = generateRefreshToken(tokenPayload);

    const [, revoked] = await prisma.$transaction([
      prisma.user.update({ where: { id: user.id }, data: { password: hashedPassword } }),
      prisma.refreshToken.deleteMany({ where: { userId: user.id } }),
      prisma.refreshToken.create({
        data: {
          userId: user.id,
          token: refreshToken,
          expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
        },
      }),
    ]);
    const refreshTokensRevoked = typeof revoked?.count === 'number' ? revoked.count : 0;

    const accessTokensCutOff = await recordPasswordChangeCutoff(user.id, cutoffSec);
    const userIdHash = createHash('sha256').update(user.id).digest('hex').slice(0, 16);
    if (accessTokensCutOff) {
      logger.info(`Password changed: user ${userIdHash}; ${refreshTokensRevoked} refresh token(s) revoked, older access tokens cut off`);
    } else {
      logger.warn(`Password changed: user ${userIdHash}; ${refreshTokensRevoked} refresh token(s) revoked, but the access-token cutoff did not reach Redis (other devices keep their access token until it expires)`);
    }

    // One loop_metrics row (the auth_login_failed pattern). The dynamic import
    // keeps this service import-light; it never throws.
    void import('../crossmodel/platform/loop-metrics.service')
      .then(({ recordLoopMetric, LOOP_METRIC_KINDS }) => recordLoopMetric({
        kind: LOOP_METRIC_KINDS.AUTH_PASSWORD_CHANGED,
        meta: { userIdHash, refreshTokensRevoked, accessCutoff: accessTokensCutOff },
      }))
      .catch(() => undefined);

    return { accessToken, refreshToken, refreshTokensRevoked, accessTokensCutOff };
  }

  async me(userId: string) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        role: true,
        avatar: true,
        createdAt: true,
        isChild: true,
        parentId: true,
        childAge: true,
      },
    });

    if (!user) {
      throw new AppError(404, 'User not found');
    }

    return user;
  }
}

export default new AuthService();
