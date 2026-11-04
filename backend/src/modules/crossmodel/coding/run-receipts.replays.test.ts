/**
 * run-receipts replay pins (consolidated) — batch-train T3i (2026-10-17).
 *
 * Consolidation of the pure (mock-free) single-ticket replay suites that
 * pin this seam — one file per ticket became one file per seam. Every
 * original suite is preserved verbatim inside its own describe() (the
 * wrapper scopes each replay's module-level consts, so replays cannot
 * collide), and every ticket id stays greppable in its describe title:
 *   crossmodel/coding/run-receipts.1e356736.test.ts
 *   crossmodel/coding/run-receipts.60bfeab1.test.ts
 *   crossmodel/coding/run-receipts.94f608c1.test.ts
 *
 * Deliberately NOT consolidated here: the agent-derail-break family (78
 * files) — each replay carries its own jest.mock bodies (file-scoped; a
 * merge would collide mock registries), so those stay one-file-per-ticket.
 *
 * jest --findRelatedTests note: the seam-name prefix is kept so a change to
 * run-receipts.ts still selects this suite by name.
 */

import { extractReceipt, RECEIPT_TOOLS, NOTIFY_RECEIPT_TOOLS, type ToolReceipt, SUPERVISOR_STATE_RECEIPT_TOOLS } from './run-receipts';
import { verifyClaimsBlock, type ClaimsBlockEntry } from './claims-block';

// ═══════���═══════════════════════════════════════════════════════════════════
// modules/crossmodel/coding/run-receipts.1e356736.test.ts — replay ticket 1e356736 (verbatim below, inside its own scope)
// ═══════════════════════════════════════════════════════════════════════════
describe('replay 1e356736 — consolidated from run-receipts.1e356736.test.ts', () => {
  const NOW = new Date('2026-10-16T09:00:00Z'); // the specimen's timestamp
  const withMeta = (r: ReturnType<typeof extractReceipt>, i: number): ToolReceipt => ({
    ...(r as Omit<ToolReceipt, 'id' | 'chatId' | 'runId'>),
    id: `receipt-1e356736-${i}`,
    chatId: 'fleet-supervisor-chat',
    runId: 'run-1e356736',
  });

  // The account-tools.ts result strings, verbatim shapes read from source:
  const NOTIFY_OK = JSON.stringify({
    ok: true, tool: 'notify_user', channel: 'telegram',
    deliveredTo: '@paul', chars: 148,
  });
  // success + T2-2 outbound redaction note (appendOutboundRedactionNote re-serializes;
  // keys preserved, secretsRedacted + message/note grow — the channel stays top-level)
  const NOTIFY_OK_REDACTED = JSON.stringify({
    ok: true, tool: 'notify_user', channel: 'telegram',
    deliveredTo: 'your Telegram', chars: 152,
    secretsRedacted: { field: 'message', count: 1, patterns: ['env_assignment'] },
    message: '1 value was redacted before sending (patterns: env_assignment). Never re-send the original.',
  });
  const NOTIFY_NOT_CONFIGURED = JSON.stringify({
    ok: false, tool: 'notify_user', reason: 'not_configured',
    message: 'This Digby instance has no Telegram bot configured, so there is no channel to notify through. Say so in the chat answer instead.',
    channel: 'auto',
  });
  const NOTIFY_SEND_FAILED = JSON.stringify({
    ok: false, tool: 'notify_user', reason: 'send_failed',
    message: 'Telegram did not accept the message (bot error or the user blocked the bot). Nothing was delivered — put the update in the chat answer and tell the user the push failed.',
    channel: 'telegram',
  });
  const NOTIFY_NOT_LINKED = JSON.stringify({
    ok: false, tool: 'notify_user', reason: 'telegram_not_linked',
    guidance: 'The user has no linked Telegram. Call telegram_connect_link (read-only — it returns the in-app connect page to show them) or point them to Account → Integrations → Telegram. Do NOT claim a notification was sent.',
  });
  const NOTIFY_RATE_LIMITED = JSON.stringify({
    ok: false, tool: 'notify_user', reason: 'rate_limited',
    message: 'This chat has already sent 5 notifications this hour (cap 5/hour per chat). Batch further updates into the chat answer instead; do not retry this run.',
    scope: 'chat_hourly',
  });
  const NOTIFY_PROSE_FAILURE = 'Tool notify_user failed: telegram service timed out';

  const PUSH_ARGS = { message: 'Board update: goal fa54f4b9 item 4 merged (PR #1572); next: the receipt-drain classification.', channel: 'auto' };

  describe('todo 1e356736 item 1 — notify_user mints receipts', () => {
    it('1. the tool is a RECEIPT_TOOLS member of the notification class (the coverage fold)', () => {
      expect(NOTIFY_RECEIPT_TOOLS).toEqual(['notify_user']);
      for (const t of NOTIFY_RECEIPT_TOOLS) expect(RECEIPT_TOOLS.has(t)).toBe(true);
      expect(RECEIPT_TOOLS.has('notify_user')).toBe(true);
    });

    it('2. ACCEPTANCE: the FS 09:00Z specimen — a delivered push mints an ok receipt carrying ids {channel} ONLY', () => {
      const r = withMeta(extractReceipt('notify_user', PUSH_ARGS, NOTIFY_OK, NOW), 1);
      expect(r).not.toBeNull();
      expect(r.ok).toBe(true);
      expect(r.ids).toEqual({ channel: 'telegram' });
      // PRIVACY CONTRACT: neither the message text nor any slice of it reaches ids
      const idsText = JSON.stringify(r.ids);
      expect(idsText).not.toContain('Board update');
      expect(idsText).not.toContain('goal fa54f4b9');
      expect(idsText).not.toContain('PR #1572');
      // the deliveredTo handle is omitted too — not an id, verifies nothing
      expect(idsText).not.toContain('@paul');
      expect(idsText).not.toContain('deliveredTo');
    });

    it('3. ACCEPTANCE: "I notified the owner" is verifiable from the receipts (the message_sent claim)', () => {
      const r = withMeta(extractReceipt('notify_user', PUSH_ARGS, NOTIFY_OK, NOW), 2);
      const claims: ClaimsBlockEntry[] = [{ type: 'message_sent', ref: 'telegram' }];
      const v = verifyClaimsBlock(claims, [r]);
      expect(v.verified.map((x) => x.claim)).toEqual(claims);
      expect(v.unverified).toEqual([]);
      expect(v.unverifiable).toEqual([]);
      // the receipt id vouches too (message_sent's receipt-id leg)
      const v2 = verifyClaimsBlock([{ type: 'message_sent', ref: 'receipt-1e356736-2' }], [r]);
      expect(v2.verified).toHaveLength(1);
    });

    it('4. a REFUSED push mints ok:false — a refusal delivered NOTHING and never vouches', () => {
      // send_failed keeps the channel extra: the call ran, the delivery failed
      const sf = extractReceipt('notify_user', PUSH_ARGS, NOTIFY_SEND_FAILED, NOW)!;
      expect(sf.ok).toBe(false);
      expect(sf.ids).toEqual({ channel: 'telegram' });
      // not_configured carries the requested channel ('auto' normalizes before the configured check)
      const nc = extractReceipt('notify_user', PUSH_ARGS, NOTIFY_NOT_CONFIGURED, NOW)!;
      expect(nc.ok).toBe(false);
      expect(nc.ids).toEqual({ channel: 'auto' });
      // telegram_not_linked / rate_limited carry no channel — ok:false, empty ids
      expect(extractReceipt('notify_user', PUSH_ARGS, NOTIFY_NOT_LINKED, NOW)).toMatchObject({ ok: false, ids: {} });
      expect(extractReceipt('notify_user', PUSH_ARGS, NOTIFY_RATE_LIMITED, NOW)).toMatchObject({ ok: false, ids: {} });
      // none of them vouch a message_sent claim
      for (const [r, i] of [[sf, 3], [nc, 4]] as const) {
        const v = verifyClaimsBlock([{ type: 'message_sent', ref: 'telegram' }], [withMeta(r, i)]);
        expect(v.verified).toEqual([]);
        expect([...v.unverified, ...v.unverifiable]).toHaveLength(1);
      }
    });

    it('5. the outbound-redaction success shape (T2-2) still parses — keys preserved, channel still top-level', () => {
      const r = extractReceipt('notify_user', { message: 'the password is Hue2024!x' }, NOTIFY_OK_REDACTED, NOW)!;
      expect(r.ok).toBe(true);
      expect(r.ids).toEqual({ channel: 'telegram' });
      // the scrub note never leaks into ids either
      expect(JSON.stringify(r.ids)).not.toContain('Hue');
    });

    it('6. a PROSE execution failure mints ok:false with no ids (never a delivery)', () => {
      const r = extractReceipt('notify_user', PUSH_ARGS, NOTIFY_PROSE_FAILURE, NOW)!;
      expect(r.ok).toBe(false);
      expect(r.ids).toEqual({});
    });

    it('7. cross-claim isolation: a notify_user receipt never vouches a send_chat_message-shaped chat-id ref', () => {
      const r = withMeta(extractReceipt('notify_user', PUSH_ARGS, NOTIFY_OK, NOW), 7);
      // a chat-id ref: the notify receipt's ids carry only the channel token — no chatId
      const v = verifyClaimsBlock([{ type: 'message_sent', ref: 'daee2916-c0de-4111-2222-333344444444' }], [r]);
      expect(v.verified).toEqual([]);
      // and a send_chat_message receipt never vouches a telegram-channel ref (the fold is one-directional at the id level)
      const send = withMeta(extractReceipt('send_chat_message', { chatId: 'daee2916-c0de-4111-2222-333344444444', content: 'hi' }, JSON.stringify({ ok: true, tool: 'send_chat_message', receiptId: 'r-x', ids: { chatId: 'daee2916-c0de-4111-2222-333344444444' }, message: 'queued' }), NOW), 8);
      const v2 = verifyClaimsBlock([{ type: 'message_sent', ref: 'telegram' }], [send]);
      expect(v2.verified).toEqual([]);
    });
  });
});

// ═══════���═══════════════════════════════════════════════════════════════════
// modules/crossmodel/coding/run-receipts.60bfeab1.test.ts — replay ticket 60bfeab1 (verbatim below, inside its own scope)
// ═══════════════════════════════════════════════════════════════════════════
describe('replay 60bfeab1 — consolidated from run-receipts.60bfeab1.test.ts', () => {
  const NOW = new Date('2026-10-16T05:24:00Z'); // the specimen's timestamp
  const SPECIMEN_QID = 'oq_05c1345d-1111-2222-3333-444444444444';
  const withMeta = (r: ReturnType<typeof extractReceipt>, i: number): ToolReceipt => ({
    ...(r as Omit<ToolReceipt, 'id' | 'chatId' | 'runId'>),
    id: `receipt-60bfeab1-${i}`,
    chatId: 'supervisor-chat',
    runId: 'run-60bfeab1',
  });

  // The platform-tools.ts result strings, verbatim shapes read from source:
  // success (toolResultEnvelope with ctx.receiptId threaded by agent.ts)
  const ANSWER_OK_SUPERVISOR = JSON.stringify({
    ok: true, tool: 'answer_owner_question', receiptId: 'r-60bfeab1-0001',
    ids: { questionId: SPECIMEN_QID, answeredBy: 'supervisor' },
    message: `Answered owner question ${SPECIMEN_QID.slice(0, 11)} as supervisor; the asking lane (and any linked lane) is being woken with the answer and the decision was recorded in your state ledger. Do not re-flag or re-list this decision.`,
  });
  const ANSWER_OK_OWNER = JSON.stringify({
    ok: true, tool: 'answer_owner_question',
    ids: { questionId: 'oq_1e800549-1111-2222-3333-444444444444', answeredBy: 'owner' },
    message: 'Answered owner question oq_1e800549 as owner; the asking lane (and any linked lane) is being woken with the answer.',
  });
  // refusals: TOP-LEVEL questionId, ok:false (owner-questions.ts resolution vocabulary)
  const ANSWER_NOT_FOUND = JSON.stringify({ ok: false, reason: 'not_found', questionId: SPECIMEN_QID, message: 'No owner question with that id belongs to this owner — copy the oq_ id verbatim from the triage event or list_owner_questions.' });
  const ANSWER_OWNER_ENAGED = JSON.stringify({ ok: false, reason: 'owner_engaged', questionId: SPECIMEN_QID, message: 'REFUSED — triage race guard (ticket 91ec252a) … Nothing was answered, flipped, or woken.' });
  const ANSWER_INVALID = JSON.stringify({ ok: false, reason: 'invalid', message: 'answer_owner_question requires questionId (oq_…) and a non-empty answer.' });
  // scope refusal (a machine lane): PROSE
  const ANSWER_SCOPE_REFUSED = 'answer_owner_question is scoped to the Fleet Supervisor chat (and to user-present turns). A machine lane never answers owner questions — not even its own; this is not a gate on your work: continue with everything the question does not block, and leave the answer to the supervisor (first responder) or the owner.';

  describe('follow-up 60bfeab1 — answer_owner_question mints receipts', () => {
    it('1. the tool is a RECEIPT_TOOLS member of the supervisor-state class (the coverage fold)', () => {
      expect(SUPERVISOR_STATE_RECEIPT_TOOLS).toContain('answer_owner_question');
      for (const t of SUPERVISOR_STATE_RECEIPT_TOOLS) expect(RECEIPT_TOOLS.has(t)).toBe(true);
      expect(RECEIPT_TOOLS.has('answer_owner_question')).toBe(true);
    });

    it('2. ACCEPTANCE: a supervisor claim of the triage answer (specimen oq_05c1345d, 05:24Z) is verifiable from its receipts', () => {
      const r = withMeta(extractReceipt('answer_owner_question', { questionId: SPECIMEN_QID, answer: 'Approved under the project\u2019s standing grant \u2014 proceed.' }, ANSWER_OK_SUPERVISOR, NOW), 1);
      expect(r).not.toBeNull();
      expect(r.ok).toBe(true);
      expect(r.ids).toEqual({ questionId: SPECIMEN_QID, answeredBy: 'supervisor' });

      // the claims-block state_update claim (both claim tables gained the tool)
      const claims: ClaimsBlockEntry[] = [{ type: 'state_update', ref: SPECIMEN_QID }];
      const v = verifyClaimsBlock(claims, [r]);
      expect(v.verified.map((x) => x.claim)).toEqual(claims);
      expect(v.unverified).toEqual([]);
      expect(v.unverifiable).toEqual([]);
      // prefix-tolerant 8-char idiom (the oq_ prefix is not hex-family — full oq_ prefix carries)
      const v2 = verifyClaimsBlock([{ type: 'state_update', ref: 'oq_05c1345d' }], [r]);
      expect(v2.verified).toHaveLength(1);
    });

    it('3. the provenance stamp rides ids — owner and supervisor answers both vouch; the answeredBy value is the tiebreaker data, never a vouch key alone', () => {
      const r = withMeta(extractReceipt('answer_owner_question', { questionId: 'oq_1e800549-1111-2222-3333-444444444444', answer: 'yes' }, ANSWER_OK_OWNER, NOW), 2);
      expect(r.ok).toBe(true);
      expect((r.ids as Record<string, unknown>).answeredBy).toBe('owner');
      const v = verifyClaimsBlock([{ type: 'state_update', ref: 'oq_1e800549-1111-2222-3333-444444444444' }], [r]);
      expect(v.verified).toHaveLength(1);
    });

    it('4. a REFUSED answer mints ok:false but keeps the questionId — a refusal answered NOTHING and never vouches (not_found / owner_engaged / invalid)', () => {
      // not_found: the questionId the caller NAMED rides ids (a real interaction with the caller's input), ok:false
      const nf = extractReceipt('answer_owner_question', { questionId: SPECIMEN_QID, answer: 'x' }, ANSWER_NOT_FOUND, NOW)!;
      expect(nf.ok).toBe(false);
      expect((nf.ids as Record<string, unknown>).questionId).toBe(SPECIMEN_QID);
      // owner_engaged (the 91ec252a triage race guard): same shape
      const oe = extractReceipt('answer_owner_question', { questionId: SPECIMEN_QID, answer: 'x' }, ANSWER_OWNER_ENAGED, NOW)!;
      expect(oe.ok).toBe(false);
      expect((oe.ids as Record<string, unknown>).questionId).toBe(SPECIMEN_QID);
      // invalid (no questionId to carry)
      const inv = extractReceipt('answer_owner_question', {}, ANSWER_INVALID, NOW)!;
      expect(inv.ok).toBe(false);
      expect(inv.ids).toEqual({});
      // none of them vouch a state_update claim — the oq_ ref is not a full
      // UUID, so the miss lands the unverifiable tier (verifyClaimsBlock's
      // state_update rule), never verified either way
      for (const [r, i] of [[nf, 4], [oe, 5], [inv, 6]] as const) {
        const v = verifyClaimsBlock([{ type: 'state_update', ref: SPECIMEN_QID }], [withMeta(r, i)]);
        expect(v.verified).toEqual([]);
        expect([...v.unverified, ...v.unverifiable]).toHaveLength(1);
      }
    });

    it('5. the PROSE scope refusal (a machine lane) mints ok:false with no ids', () => {
      const r = extractReceipt('answer_owner_question', { questionId: SPECIMEN_QID, answer: 'x' }, ANSWER_SCOPE_REFUSED, NOW)!;
      expect(r.ok).toBe(false);
      expect(r.ids).toEqual({});
    });

    it('6. cross-claim isolation: an ANSWER receipt never vouches a chat-id ref, an ARCHIVE receipt never vouches an oq_ ref', () => {
      const ans = withMeta(extractReceipt('answer_owner_question', { questionId: SPECIMEN_QID, answer: 'x' }, ANSWER_OK_SUPERVISOR, NOW), 7);
      const arch = withMeta(extractReceipt('archive_chat', { chatId: 'e87d6f73-1111-2222-3333-444444444444' }, 'Archived chat e87d6f73-1111-2222-3333-444444444444.', NOW), 8);
      const v1 = verifyClaimsBlock([{ type: 'state_update', ref: 'e87d6f73-1111-2222-3333-444444444444' }], [ans]);
      expect(v1.verified).toEqual([]); // answer ids carry no chatId
      const v2 = verifyClaimsBlock([{ type: 'state_update', ref: SPECIMEN_QID }], [arch]);
      expect(v2.verified).toEqual([]); // archive ids carry no oq_
    });

    it('7. a FLAG receipt and an ANSWER receipt for the same oq_ id are both real, both vouch — the two rows are distinct interactions', () => {
      const flag = withMeta(extractReceipt('flag_owner_question', { question: 'q?' }, JSON.stringify({ ok: true, questionId: 'oq_483730f8-1111-2222-3333-444444444444' }), NOW), 9);
      const ans = withMeta(extractReceipt('answer_owner_question', { questionId: 'oq_483730f8-1111-2222-3333-444444444444', answer: 'proceed' }, JSON.stringify({ ok: true, tool: 'answer_owner_question', ids: { questionId: 'oq_483730f8-1111-2222-3333-444444444444', answeredBy: 'supervisor' }, message: 'Answered owner question oq_483730f8 as supervisor.' }), NOW), 10);
      for (const r of [flag, ans]) {
        const v = verifyClaimsBlock([{ type: 'state_update', ref: 'oq_483730f8-1111-2222-3333-444444444444' }], [r]);
        expect(v.verified).toHaveLength(1);
      }
    });
  });
});

// ═══════���═══════════════════════════════════════════════════════════════════
// modules/crossmodel/coding/run-receipts.94f608c1.test.ts — replay ticket 94f608c1 (verbatim below, inside its own scope)
// ═══════════════════════════════════════════════════════════════════════════
describe('replay 94f608c1 — consolidated from run-receipts.94f608c1.test.ts', () => {
  const NOW = new Date('2026-10-16T03:09:00Z');
  const withMeta = (r: ReturnType<typeof extractReceipt>, i: number): ToolReceipt => ({
    ...(r as Omit<ToolReceipt, 'id' | 'chatId' | 'runId'>),
    id: `receipt-94f608c1-${i}`,
    chatId: 'supervisor-chat',
    runId: 'run-94f608c1',
  });

  // The verbatim platform-tools.ts result strings (read from the source this run):
  const ARCHIVE_OK = 'Archived chat e87d6f73-1111-2222-3333-444444444444.';
  const RESTORE_OK = 'Restored chat e87d6f73-1111-2222-3333-444444444444 from the archive.';
  const ARCHIVE_REFUSED = 'archive_chat requires a chat id.';
  const FLAG_CREATED = JSON.stringify({ ok: true, questionId: 'oq_483730f8-1111-2222-3333-444444444444' });
  const FLAG_TRIAGED = JSON.stringify({ ok: true, questionId: 'oq_211513ed-1111-2222-3333-444444444444', triage: 'supervisor', message: 'Routed to the Fleet Supervisor first.' });
  const FLAG_DEDUED = JSON.stringify({ ok: false, reason: 'deduped', questionId: 'oq_483730f8-1111-2222-3333-444444444444' });
  const FLAG_REFUSED = JSON.stringify({ ok: false, reason: 'rate_capped' });
  const STATE_SAVED = JSON.stringify({ applied: ['notes: replaced 3 note(s)', 'directive: closed d384f859b'], errors: [] }, null, 1);
  const STATE_PARTIAL = JSON.stringify({ applied: ['notes: replaced 1 note(s)'], errors: ['dispatch: fabricated citation xyz — item dropped'] }, null, 1);
  const STATE_REFUSED_PROSE = 'update_supervisor_state is only available on the Fleet Supervisor chat';

  describe('audit 94f608c1 — supervisor-state mutations mint receipts', () => {
    it('1. the three tools are RECEIPT_TOOLS members (the coverage fold)', () => {
      for (const t of SUPERVISOR_STATE_RECEIPT_TOOLS) expect(RECEIPT_TOOLS.has(t)).toBe(true);
      expect(RECEIPT_TOOLS.has('archive_chat')).toBe(true);
      expect(RECEIPT_TOOLS.has('flag_owner_question')).toBe(true);
      expect(RECEIPT_TOOLS.has('update_supervisor_state')).toBe(true);
      // the request's alias name is NOT registered — the REAL tool name is
      expect(RECEIPT_TOOLS.has('save_supervisor_state')).toBe(false);
    });

    it('2. ACCEPTANCE: a supervisor claim of an archive is verifiable from its receipts (specimen 1 — FS 03:09Z archive of e87d6f73)', () => {
      const receipt = withMeta(extractReceipt('archive_chat', { chatId: 'e87d6f73-1111-2222-3333-444444444444', archived: true }, ARCHIVE_OK, NOW), 1);
      expect(receipt).not.toBeNull();
      expect(receipt.ok).toBe(true);
      expect(receipt.ids).toEqual({ chatId: 'e87d6f73-1111-2222-3333-444444444444', archived: true });

      const claims: ClaimsBlockEntry[] = [{ type: 'state_update', ref: 'e87d6f73-1111-2222-3333-444444444444' }];
      const v = verifyClaimsBlock(claims, [receipt]);
      expect(v.verified.map((x) => x.claim)).toEqual(claims);
      expect(v.unverified).toEqual([]);
      expect(v.unverifiable).toEqual([]);
    });

    it('3. ACCEPTANCE: specimen 2 — LiteLLM supervisor c6941c11\'s archive of review lane 26be18cc', () => {
      const receipt = withMeta(extractReceipt('archive_chat', { chatId: '26be18cc-1111-2222-3333-444444444444' }, 'Archived chat 26be18cc-1111-2222-3333-444444444444.', NOW), 2);
      expect(receipt.ok).toBe(true);
      const v = verifyClaimsBlock([{ type: 'state_update', ref: '26be18cc' }], [receipt]);
      expect(v.verified).toHaveLength(1); // prefix-tolerant 8-char idiom
    });

    it('4. a RESTORE receipt never vouches an "archived" reading — the archived flag rides ids', () => {
      const r = extractReceipt('archive_chat', { chatId: 'x', archived: false }, RESTORE_OK, NOW)!;
      expect(r.ok).toBe(true);
      expect(r.ids).toEqual({ chatId: 'e87d6f73-1111-2222-3333-444444444444', archived: false });
      // the chat id still matches a state_update claim (the restore IS a real
      // mutation of the same chat), but the archived flag is there for consumers
      const v = verifyClaimsBlock([{ type: 'state_update', ref: 'e87d6f73' }], [withMeta(r, 3)]);
      expect(v.verified).toHaveLength(1);
    });

    it('5. an archive REFUSAL mints ok:false — a validation prose never vouches', () => {
      const r = extractReceipt('archive_chat', {}, ARCHIVE_REFUSED, NOW)!;
      expect(r.ok).toBe(false);
      expect(r.ids).toEqual({});
      const v = verifyClaimsBlock([{ type: 'state_update', ref: 'e87d6f73-1111-2222-3333-444444444444' }], [withMeta(r, 4)]);
      expect(v.verified).toEqual([]);
      expect(v.unverified).toHaveLength(1);
    });

    it('6. ACCEPTANCE: an oq_ id claim (flag_owner_question) is verifiable — created, triaged and deduped shapes', () => {
      for (const [text, ok, i] of [[FLAG_CREATED, true, 5], [FLAG_TRIAGED, true, 6]] as const) {
        const r = withMeta(extractReceipt('flag_owner_question', { question: '…' }, text, NOW), i);
        expect(r.ok).toBe(ok);
        expect((r.ids as Record<string, unknown>).questionId).toBe(
          (i === 5 ? 'oq_483730f8' : 'oq_211513ed') + '-1111-2222-3333-444444444444',
        );
        const v = verifyClaimsBlock([{ type: 'state_update', ref: String((r.ids as Record<string, unknown>).questionId) }], [r]);
        expect(v.verified).toHaveLength(1); // the two UNVERIFIABLE baseline ids, now vouched
      }
      // dedup bump: the questionId is REAL (row interaction) but ok:false — a
      // dedup is not a NEW question, it must not vouch a claim
      const d = extractReceipt('flag_owner_question', { question: '…' }, FLAG_DEDUED, NOW)!;
      expect(d.ok).toBe(false);
      expect((d.ids as Record<string, unknown>).questionId).toBe('oq_483730f8-1111-2222-3333-444444444444');
    });

    it('7. a flag REFUSAL mints ok:false', () => {
      const r = extractReceipt('flag_owner_question', { question: '…' }, FLAG_REFUSED, NOW)!;
      expect(r.ok).toBe(false);
      expect(r.ids).toEqual({});
    });

    it('8. ACCEPTANCE: the supervisor-state save (update_supervisor_state — the request\'s save_supervisor_state) is verifiable', () => {
      const r = withMeta(extractReceipt('update_supervisor_state', { notes: ['…'] }, STATE_SAVED, NOW), 8);
      expect(r.ok).toBe(true);
      expect(r.ids).toEqual({ supervisor_state: 'supervisor_state', applied: 2 });
      // finish-run's own suggestion string ("its id, or \"supervisor_state\"") vouches
      const v = verifyClaimsBlock([{ type: 'state_update', ref: 'supervisor_state' }], [r]);
      expect(v.verified).toHaveLength(1);
      // receipt-id anchor (finish-run FR-3 shape) also vouches
      const v2 = verifyClaimsBlock([{ type: 'state_update', ref: r.id }], [r]);
      expect(v2.verified).toHaveLength(1);
    });

    it('9. a save with errors mints ok:false (a failed item never vouches), a prose refusal mints ok:false', () => {
      const p = extractReceipt('update_supervisor_state', { notes: ['…'] }, STATE_PARTIAL, NOW)!;
      expect(p.ok).toBe(false);
      expect((p.ids as Record<string, unknown>).applied).toBe(1);
      const f = extractReceipt('update_supervisor_state', {}, STATE_REFUSED_PROSE, NOW)!;
      expect(f.ok).toBe(false);
      expect(f.ids).toEqual({});
    });

    it('10. cross-claim isolation: an archive receipt never vouches an oq_ ref, a flag receipt never vouches a chat id', () => {
      const arch = withMeta(extractReceipt('archive_chat', { chatId: 'e87d6f73-1111-2222-3333-444444444444' }, ARCHIVE_OK, NOW), 10);
      const flag = withMeta(extractReceipt('flag_owner_question', { question: '…' }, FLAG_CREATED, NOW), 11);
      const v1 = verifyClaimsBlock([{ type: 'state_update', ref: 'oq_483730f8-1111-2222-3333-444444444444' }], [arch]);
      expect(v1.verified).toEqual([]); // archive ids carry no oq_
      const v2 = verifyClaimsBlock([{ type: 'state_update', ref: 'e87d6f73-1111-2222-3333-444444444444' }], [flag]);
      expect(v2.verified).toEqual([]); // flag ids carry no chatId
    });
  });
});
