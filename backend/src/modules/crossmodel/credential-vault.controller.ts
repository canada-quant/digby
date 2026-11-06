/**
 * One-tap "vault this" — the HTTP door (feedback ticket f95e1e30, part 2).
 *
 * POST /api/crossmodel/chats/:chatId/messages/:messageId/vault
 *
 * The owner's OWN paste → the encrypted coding-credentials vault, without an
 * agent in the loop. The transcript renders a button on a row whose content the
 * server has already identified as credential-shaped (see
 * platform/credential-paste.ts for the detection seam and why it is derived at
 * read time); clicking it lands here.
 *
 * WHAT THIS ROUTE MAY AND MAY NOT SEE:
 *  - The client sends NO value, ever, and the request body is IGNORED. The value
 *    is lifted SERVER-SIDE from the persisted `crossmodel_messages` row — the
 *    same bytes `store_secret` lifts when an agent cites `fromMessageId`.
 *  - The response names ENV KEYS, scanner pattern names and refusal reasons.
 *    A value, a prefix or a length never appears in it.
 *  - Auth is the app-level `/api/crossmodel` guard (crossmodel.routes.ts mounts
 *    this router behind it), but the ownership proof is re-done HERE: the row is
 *    resolved and `row.chat.userId === caller` is required, exactly like
 *    confirmations.controller's confirm door. A row in someone else's chat and a
 *    row that does not exist answer the SAME 404 — no existence leak either way.
 *
 * WHY STORE THROUGH `executeSecretHandoffTool` (a black box, never
 * re-implemented here): that handler already owns the entire sanctioned lift —
 * owner-row validation, named-assignment and scanner extraction, the
 * infra-managed-key guard, the slot-mismatch refusal, PEM validation, the
 * encryption call, the audit row and the loop metric. Re-implementing any of it
 * in this route would be a second, divergent door to secrets. This route is
 * provenance + authorisation only.
 */
import { Request, Response } from 'express';
import prisma from '../../config/database';
import logger from '../../utils/logger';
import { vaultPastedCredential, credentialPasteFlag, isOwnerTypedRow, DEFAULT_PASTE_BASE } from './platform/credential-paste';

/** Env key compaction: an `envKey` query hint is a BASE name, never a full
 *  value carrier. Upper-snaked and length-capped so a caller cannot smuggle a
 *  value through the name. */
function readBaseHint(raw: unknown): string {
  const s = String(raw ?? '').trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!s) return DEFAULT_PASTE_BASE;
  return s.slice(0, 24).replace(/_+$/, '') || DEFAULT_PASTE_BASE;
}

export const credentialVaultController = {
  /**
   * Vault every credential-shaped value of ONE owner message.
   *
   * Answers:
   *   401 — no authenticated user (the app-level guard normally answers first;
   *         this is the belt behind those braces for a re-mounted router).
   *   400 — a message id that is not a uuid (never a DB round trip).
   *   404 — the row does not exist, does not belong to :chatId, or its chat is
   *         not the caller's. One status for all three: no existence leak.
   *   403 — the row belongs to the caller's chat but is not the OWNER's words
   *         (an agent relay, a schedule/hook wake, a machine inject). Named
   *         honestly so a caller knows the row exists and why it is refused.
   *   200 { ok:false, reason } — an honest refusal (nothing credential-shaped,
   *         kill switch on, the store leg refused). Nothing was stored.
   *   200 { ok:true, stored[], notStored[] } — every env key stored AND every
   *         value not stored. Never a silent partial vault.
   */
  async postVaultMessage(req: Request, res: Response) {
    const userId = (req as any).user?.id;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { chatId, messageId } = req.params;
    // A message id is a uuid in this schema; anything else cannot resolve and
    // must not reach Prisma (a malformed id there is a ~2.5 KB validation log
    // line per call — the class coding-data.service:300 already guards).
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(messageId ?? ''))) {
      return res.status(400).json({ error: 'Invalid message id' });
    }

    let row: { id: string; chatId: string; role: string; content: string; metadata: unknown; chatUserId: string } | null;
    try {
      const found = await prisma.crossModelMessage.findUnique({
        where: { id: messageId },
        select: {
          id: true,
          chatId: true,
          role: true,
          content: true,
          metadata: true,
          chat: { select: { userId: true } },
        },
      });
      row = found && found.chat
        ? { id: found.id, chatId: found.chatId, role: found.role, content: found.content, metadata: found.metadata, chatUserId: found.chat.userId }
        : null;
    } catch (err: any) {
      logger.error(`credential-vault: message lookup failed: ${err.message}`);
      return res.status(500).json({ error: 'Could not read that message' });
    }

    // The ticket's constraint: prove ownership of the ROW's chat, and answer the
    // same 404 for "no such row", "row in another chat" and "row in a foreign
    // chat" — an unauthorised caller learns nothing about whether it exists.
    if (!row || row.chatId !== chatId || row.chatUserId !== userId) {
      return res.status(404).json({ error: 'Message not found' });
    }
    // Inside your own chat, a machine-authored row is still not your paste.
    if (!isOwnerTypedRow({ role: row.role, content: row.content, metadata: row.metadata })) {
      return res.status(403).json({
        error: 'That message was not typed by you (an assistant row, an agent send, or a schedule / hook / webhook wake), so it is not treated as your credential paste.',
        code: 'NOT_OWNER_TYPED',
      });
    }

    // Cheap pre-check so an ordinary message never runs the store leg at all.
    if (!credentialPasteFlag(String(row.content ?? ''))) {
      return res.json({
        ok: false,
        reason: 'no_secret_found',
        stored: [],
        notStored: [],
        message: 'Nothing in that message matches a credential shape this instance knows, so there is nothing to vault and nothing was stored.',
      });
    }

    const base = readBaseHint(req.query?.envKey);
    try {
      const result = await vaultPastedCredential(
        { userId, chatId: row.chatId },
        { messageId: row.id, messageText: String(row.content ?? ''), baseEnvKey: base },
      );
      if (!result.ok) {
        return res.json({ ok: false, reason: result.reason, stored: [], notStored: [], message: result.message });
      }

      // ── Door provenance ────────────────────────────────────────────────
      // The store leg writes its OWN `coding_credential.store` row with
      // via:'store_secret' — that row is the audit of the LIFT (which row it
      // came from, which pattern matched) and is not ours to rewrite. This
      // route adds ONE more row per key with via:'owner_vault_button' so the
      // two doors are separable in telemetry: "did the owner click, or did an
      // agent notice?" — the exact question part (2) exists to move.
      // `messageId` is the row id, never a value.
      for (const s of result.stored) {
        try {
          await prisma.activity.create({
            data: {
              userId,
              action: 'coding_credential.store',
              resource: 'platform',
              metadata: {
                via: 'owner_vault_button',
                chatId: row.chatId,
                messageId: row.id,
                envKey: s.injectedKey,
                pattern: s.pattern,
                replaced: s.replaced,
              },
            },
          });
        } catch { /* the audit row never fails the store */ }
      }

      // Stamp the row so the button becomes "stored as $X" on the next render
      // (and stays that way across reloads). Names only — the flag is the same
      // value-free shape the read seam produces.
      //
      // `notStored` is persisted too (review finding #4): a PARTIAL vault must
      // remain retryable. Without it the client would see a non-empty `vaulted`
      // and render a dead "stored as $X" note, leaving an agent as the only path
      // to the values that failed — the exact dependence this ticket removes.
      try {
        const existingMeta = row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
          ? (row.metadata as Record<string, unknown>)
          : {};
        const priorFlag = existingMeta.credentialPaste && typeof existingMeta.credentialPaste === 'object'
          ? (existingMeta.credentialPaste as { count?: number; patterns?: string[]; vaulted?: string[] })
          : null;
        const patterns = credentialPasteFlag(String(row.content ?? ''))?.patterns ?? priorFlag?.patterns ?? [];
        const vaulted = Array.from(new Set([...(Array.isArray(priorFlag?.vaulted) ? priorFlag!.vaulted! : []), ...result.stored.map((s) => s.injectedKey)]));
        const stillPending = result.notStored.map((n) => n.envKey).filter((k) => !!k);
        await prisma.crossModelMessage.update({
          where: { id: row.id },
          data: {
            metadata: {
              ...existingMeta,
              credentialPaste: {
                count: priorFlag?.count ?? patterns.length,
                patterns,
                vaulted,
                // Omitted entirely when everything stored — an empty array would
                // read as "pending" to a truthiness check.
                ...(stillPending.length ? { notStored: stillPending } : {}),
              },
            } as any,
          },
        });
      } catch (err: any) {
        // Fail-open: the credentials ARE stored; only the "already vaulted"
        // badge is missing. Never turn a successful store into an error.
        logger.warn(`credential-vault: vaulted stamp failed for ${row.id}: ${err.message}`);
      }

      return res.json({
        ok: true,
        stored: result.stored.map((s) => ({ envKey: s.envKey, injectedKey: s.injectedKey, pattern: s.pattern, replaced: s.replaced })),
        notStored: result.notStored,
        message: result.message,
      });
    } catch (err: any) {
      logger.error(`credential-vault: store leg failed for ${row.id}: ${err.message}`);
      return res.status(500).json({ error: 'The vault could not store that value. Nothing was changed — the credential is still in the transcript.' });
    }
  },
};

export default credentialVaultController;