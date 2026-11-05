/**
 * claims-block replay pins (consolidated) — batch-train T3i (2026-10-17).
 *
 * Consolidation of the pure (mock-free) single-ticket replay suites that
 * pin this seam — one file per ticket became one file per seam. Every
 * original suite is preserved verbatim inside its own describe() (the
 * wrapper scopes each replay's module-level consts, so replays cannot
 * collide), and every ticket id stays greppable in its describe title:
 *   crossmodel/coding/claims-block.601f05f8.test.ts
 *   crossmodel/coding/claims-block.7177bb71.test.ts
 *
 * Deliberately NOT consolidated here: the agent-derail-break family (78
 * files) — each replay carries its own jest.mock bodies (file-scoped; a
 * merge would collide mock registries), so those stay one-file-per-ticket.
 *
 * jest --findRelatedTests note: the seam-name prefix is kept so a change to
 * claims-block.ts still selects this suite by name.
 */

import { verifyClaimsBlock, refNamesPrFile } from './claims-block';
import type { ToolReceipt } from './run-receipts';

// ═══════���═══════════════════════════════════════════════════════════════════
// modules/crossmodel/coding/claims-block.601f05f8.test.ts — replay ticket 601f05f8 (verbatim below, inside its own scope)
// ═══════════════════════════════════════════════════════════════════════════
describe('replay 601f05f8 — consolidated from claims-block.601f05f8.test.ts', () => {
  const NOW = new Date('2026-09-13T12:00:00.000Z');

  const receipt = (tool: string, ok: boolean, ids: Record<string, unknown> = {}, id = 'aaaabbbb-cccc-dddd-eeee-ffff00001111'): ToolReceipt => ({
    id, chatId: 'c1', runId: 'run1', tool, ok, ids,
    inputHash: null, outputHash: null, createdAt: NOW,
  });

  // The incident's actual todo (421938f3): 17fb995a-… — full-uuid form for the
  // anti-forgery tier, plus a goal row for the goal_update variant.
  const TODO_ID = '17fb995a-1111-4222-8333-abcdefabcdef';
  const GOAL_ID = '48c93a9e-9999-4888-8777-1234567890ab';

  describe('601f05f8 replay — the 421938f3 conviction now verifies', () => {
    it('ticket_update claim citing a todo id is vouched by that todo_update receipt (full uuid)', () => {
      const v = verifyClaimsBlock(
        [{ type: 'ticket_update', ref: TODO_ID }],
        [receipt('todo_update', true, { todoId: TODO_ID })],
      );
      expect(v.verified).toHaveLength(1);
      expect(v.unverified).toHaveLength(0);
    });

    it('goal variant: ticket_update claim citing a goal id is vouched by that goal_update receipt', () => {
      const v = verifyClaimsBlock(
        [{ type: 'ticket_update', ref: GOAL_ID }],
        [receipt('goal_update', true, { goalId: GOAL_ID })],
      );
      expect(v.verified).toHaveLength(1);
      expect(v.unverified).toHaveLength(0);
    });

    it('the ≥8-char prefix form vouches (lanes cite severed prefixes constantly)', () => {
      const v = verifyClaimsBlock(
        [{ type: 'ticket_update', ref: '17fb995a' }],
        [receipt('todo_update', true, { todoId: TODO_ID })],
      );
      expect(v.verified).toHaveLength(1);
    });

    it('a todo receipt also vouches a ref matching its own receipt id (unchanged base leg)', () => {
      const r = receipt('todo_update', true, { todoId: TODO_ID });
      const v = verifyClaimsBlock([{ type: 'ticket_update', ref: r.id }], [r]);
      expect(v.verified).toHaveLength(1);
    });
  });

  describe('601f05f8 — anti-laundering: the widening opens no coarse tier', () => {
    it('a full-uuid ref matching a DIFFERENT todo row stays unverified (no cross-row vouch)', () => {
      const v = verifyClaimsBlock(
        [{ type: 'ticket_update', ref: TODO_ID }],
        [receipt('todo_update', true, { todoId: GOAL_ID })],
      );
      expect(v.verified).toHaveLength(0);
      expect(v.unverified).toHaveLength(1);
    });

    it('a wrong-class ok receipt never vouches a board-id claim (git_commit ≠ ticket update)', () => {
      const v = verifyClaimsBlock(
        [{ type: 'ticket_update', ref: TODO_ID }],
        [receipt('git_commit', true, { sha: '17fb995a1c2d' })],
      );
      expect(v.verified).toHaveLength(0);
      expect(v.unverified).toHaveLength(1);
    });

    it('a FAILED todo_update receipt proves nothing (ok-only discipline)', () => {
      const v = verifyClaimsBlock(
        [{ type: 'ticket_update', ref: TODO_ID }],
        [receipt('todo_update', false, { todoId: TODO_ID })],
      );
      expect(v.verified).toHaveLength(0);
      expect(v.unverified).toHaveLength(1);
    });
  });

  describe('601f05f8 — the pre-existing feedback legs are unchanged', () => {
    it('update_feedback ids.ticketId still vouches (4243f38a regression guard)', () => {
      const TICKET = '601f05f8-aaaa-4bbb-8ccc-ddddeeeeffff';
      const v = verifyClaimsBlock(
        [{ type: 'ticket_update', ref: TICKET }],
        [receipt('update_feedback', true, { ticketId: TICKET })],
      );
      expect(v.verified).toHaveLength(1);
    });

    it('file_feedback receipt id still vouches', () => {
      const r = receipt('file_feedback', true, { ticketId: '99998888-7777-4666-8555-444433332222' });
      const v = verifyClaimsBlock([{ type: 'ticket_update', ref: r.id }], [r]);
      expect(v.verified).toHaveLength(1);
    });
  });
});

// ═══════���═══════════════════════════════════════════════════════════════════
// modules/crossmodel/coding/claims-block.7177bb71.test.ts — replay ticket 7177bb71 (verbatim below, inside its own scope)
// ═══════════════════════════════════════════════════════════════════════════
describe('replay 7177bb71 — consolidated from claims-block.7177bb71.test.ts', () => {
  const NOW = new Date('2026-10-11T14:34:06.000Z');

  const receipt = (tool: string, ok: boolean, ids: Record<string, unknown> = {}, id = '76bc7668-1111-2222-3333-444455556666'): ToolReceipt => ({
    id, chatId: '7d269dc5', runId: 'd4e48d87', tool, ok, ids,
    inputHash: null, outputHash: null, createdAt: NOW,
  });

  const claim = (type: 'file_change', ref: string) => ({ type, ref }) as const;

  // The incident's PR receipt shape (run d4e48d87, receipt 76bc7668): PR #1433
  // with the struck path in its changed-files list.
  const INCIDENT_FILES = [
    'scripts/framework-audit/probe-022eb482-b.js',
    'scripts/framework-audit/probe-022eb482-c.js',
    'scripts/framework-audit/probe-022eb482-d.js',
    'scripts/framework-audit/probe-022eb482-e.js',
    'scripts/framework-audit/probe-022eb482.js',
  ];
  const INCIDENT_PATH = 'scripts/framework-audit/probe-022eb482-e.js';
  const prReceipt = (files: string[] = INCIDENT_FILES, ok = true) =>
    receipt('open_pull_request', ok, { prNumber: 1433, url: 'https://github.com/example-org/crossmodel/pull/1433', files, fileCount: files.length, additions: 490, deletions: 0 });

  describe('7177bb71 replay — the raw-shell-commit shape (incident chat 7d269dc5 / run d4e48d87)', () => {
    it('a file_change path claim whose path is in the PR receipt files[] VERIFIES (no git_commit receipts needed)', () => {
      const out = verifyClaimsBlock([claim('file_change', INCIDENT_PATH)], [prReceipt()]);
      expect(out.verified).toHaveLength(1);
      expect(out.unverified).toHaveLength(0);
      expect(out.verified[0].claim.ref).toBe(INCIDENT_PATH);
    });

    it('the incident combination — git_push + open_pull_request receipts, no git_commit — verifies the path claim end to end', () => {
      const receipts = [
        receipt('git_push', true, { sha: '1cc55aef8e9cc33eaedefa6310c0e08a9cb0ebcc', branch: 'digby/session-7d269dc5' }, '197a86e9-1111-2222-3333-444455556666'),
        prReceipt(),
      ];
      const out = verifyClaimsBlock([claim('file_change', INCIDENT_PATH)], receipts);
      expect(out.verified).toHaveLength(1);
      expect(out.unverified).toHaveLength(0);
    });

    it('a ref naming the PR receipt id vouches (receipt-id channel unchanged)', () => {
      expect(verifyClaimsBlock([claim('file_change', '76bc7668-1111-2222-3333-444455556666')], [prReceipt()]).verified).toHaveLength(1);
    });
  });

  describe('7177bb71 anti-laundering — a PR receipt never rides the coarse tier', () => {
    it('a PR receipt whose files[] does NOT contain the path never vouches it', () => {
      const other = prReceipt(['backend/src/app.ts', 'frontend/lib/x.ts']);
      expect(verifyClaimsBlock([claim('file_change', INCIDENT_PATH)], [other]).unverified).toHaveLength(1);
    });

    it('an AMBIGUOUS basename (two listed files share it) never vouches', () => {
      const amb = prReceipt(['a/probe-022eb482-e.js', 'b/probe-022eb482-e.js']);
      expect(verifyClaimsBlock([claim('file_change', 'probe-022eb482-e.js')], [amb]).unverified).toHaveLength(1);
      expect(verifyClaimsBlock([claim('file_change', 'c/probe-022eb482-e.js')], [amb]).unverified).toHaveLength(1); // exact path miss + ambiguous basename
    });

    it('a UN-AMBIGUOUS basename match vouches (basename unique in the list)', () => {
      const uni = prReceipt(['scripts/framework-audit/probe-022eb482-e.js', 'other/deeper/note.md']);
      expect(verifyClaimsBlock([claim('file_change', 'probe-022eb482-e.js')], [uni]).verified).toHaveLength(1);
    });

    it('a uuid ref matching no receipt id stays unverified (anti-forgery tier unchanged)', () => {
      expect(verifyClaimsBlock([claim('file_change', '9c8b7a6d-1111-2222-3333-444455556666')], [prReceipt()]).unverified).toHaveLength(1);
    });

    it('an ok:false PR receipt (failed open) vouches nothing', () => {
      expect(verifyClaimsBlock([claim('file_change', INCIDENT_PATH)], [prReceipt(INCIDENT_FILES, false)]).unverified).toHaveLength(1);
    });

    it('a PR receipt with no files[] parsed (shape absent) never vouches a path', () => {
      const bare = receipt('open_pull_request', true, { prNumber: 1432 });
      expect(verifyClaimsBlock([claim('file_change', INCIDENT_PATH)], [bare]).unverified).toHaveLength(1);
    });

    it('refs normalize slashes and a leading ./ or / (prose-shaped refs still match)', () => {
      expect(refNamesPrFile('./scripts/framework-audit/probe-022eb482-e.js', INCIDENT_FILES)).toBe(true);
      expect(refNamesPrFile('/scripts/framework-audit//probe-022eb482-e.js', INCIDENT_FILES)).toBe(true);
      expect(refNamesPrFile('scripts/framework-audit/probe-022eb482-e.js', INCIDENT_FILES)).toBe(true);
      expect(refNamesPrFile('scripts/framework-audit/missing.js', INCIDENT_FILES)).toBe(false);
      expect(refNamesPrFile('', INCIDENT_FILES)).toBe(false);
    });
  });

  describe('7177bb71 regression — the git_commit legs are byte-stable', () => {
    it('any ok git_commit still vouches a path ref (coarse tier unchanged)', () => {
      const commit = receipt('git_commit', true, { sha: '84fe3ae0b1' }, '11111111-1111-4222-8333-444455556666');
      expect(verifyClaimsBlock([claim('file_change', 'backend/src/app.ts')], [commit]).verified).toHaveLength(1);
    });

    it('a uuid ref against a git_commit receipt still requires the receipt-id match', () => {
      const commit = receipt('git_commit', true, { sha: '84fe3ae0b1' }, '11111111-1111-4222-8333-444455556666');
      expect(verifyClaimsBlock([claim('file_change', '9c8b7a6d-1111-2222-3333-444455556666')], [commit]).unverified).toHaveLength(1);
    });
  });
});
