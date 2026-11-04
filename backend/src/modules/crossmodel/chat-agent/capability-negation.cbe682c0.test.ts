/**
 * Replay pin for ticket cbe682c0 — "Cross-chat run control: asked to stop the
 * run in chat <id> — no supported path from within a chat".
 *
 * The mishap: a user asked their chat to stop the run in another chat. The
 * ensemble's L2 cross-checker lane — a cross_checker-role worker whose toolset
 * is DELIBERATELY reduced (roles.ts grants WEB + RETRIEVE + INTEGRATIONS +
 * file_feedback; workers never get platform tools) — answered the capability
 * question from ITS OWN tool list, found no stop_run there, ran a web search
 * that (correctly) found no public Digby docs, and concluded "no supported
 * path from within a chat". The claim reconciled into the user-visible answer
 * and was filed as this ticket — while the MAIN lane actually held a live
 * stop_run {chatId} platform tool (shipped 4298cd1c2 on 2026-09-24, deployed
 * before the ask; taught by the capability playbook's trigger table) and the
 * same account's get_chat_status could have shown the target's active run.
 *
 * The invariant behind the fix (the 4th member of the reduced-toolset defense
 * family, after 0cbfa36e action claims, ce9ee48d artifact citations and
 * 31738d9a state claims): a lane that cannot see the platform tool surface is
 * structurally INCAPABLE of proving a platform capability absent — its
 * "not supported" is its reduced toolset mistaken for the platform's. Layers
 * pinned here:
 *
 *  1. The cross_checker ROLE prompt (roles.ts — every cross-checker lane:
 *     L2 checker, council colleagues, one-shot drafters) now states the
 *     toolset is a reduced subset and FORBIDS capability-negation conclusions
 *     from it, naming cross-chat run control as the incident example.
 *  2. The L2 checkerDoctrine (chat-agent.service.ts, unexported — wiring pin
 *     via readFileSync, the f08fcd6f idiom) carries the same rule.
 *  3. crossCheckDraftsHeader — the orchestrator-side never-adopt framing —
 *     gains the CAPABILITY NEGATIONS clause: a draft's "Digby has no way to X"
 *     is never adoptable; the orchestrator settles capability questions
 *     against ITS OWN tool surface.
 *  4. docs/DIGBY_PLATFORM_API.md documents the control tools' REST twins
 *     (stop_run / answer_chat_question / approve_request / pause+resume),
 *     closing the "no documented path" half of the ticket.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { ROLES } from '../coding/roles';
import { crossCheckDraftsHeader, stripCrossCheckActionClaims } from './cross-check-action-claims';

const SERVICE_SOURCE = readFileSync(join(__dirname, 'chat-agent.service.ts'), 'utf8');
const ROLES_SOURCE = readFileSync(join(__dirname, '../coding/roles.ts'), 'utf8');
const API_DOC = readFileSync(join(__dirname, '../../../../../docs/DIGBY_PLATFORM_API.md'), 'utf8');

/** The incident shape: a cross-check draft negating a platform capability. */
const INCIDENT_DRAFT_NEGATION =
  'The tool surface available in a chat includes no way to view or stop runs in another chat, ' +
  'and a web search surfaced no documented path for stopping/cancelling another chat\'s run ' +
  '(or its schedule). No supported path exists.';

describe('layer 1 — cross_checker role prompt forbids capability negation from the reduced toolset (ticket cbe682c0)', () => {
  it('declares the toolset a REDUCED SUBSET, not the platform surface', () => {
    expect(ROLES.cross_checker.prompt).toContain('REDUCED SUBSET');
    expect(ROLES.cross_checker.prompt).toMatch(/web \+ retrieval \+ connector reads ONLY/i);
  });

  it('forbids concluding "not supported" from the lane\'s own tool list', () => {
    expect(ROLES.cross_checker.prompt).toMatch(/NEVER infer what Digby can or cannot do from your own tool list/i);
    expect(ROLES.cross_checker.prompt).toMatch(/do NOT conclude "not supported" \/ "no path exists"/);
  });

  it('names cross-chat run control — the incident\'s exact capability — as out of lane scope', () => {
    // The ticket's user asked to "stop the run in chat <id>"; the checker
    // negated it from its own toolset. The prompt must name that class.
    expect(ROLES.cross_checker.prompt).toContain('stopping a run in another chat');
    expect(ROLES.cross_checker.prompt).toContain('stop_run');
  });

  it('rejects a web search as evidence of Digby-internal capability', () => {
    expect(ROLES.cross_checker.prompt).toContain('a web search cannot verify it');
  });

  it('cites the ticket for traceability', () => {
    // Layered prompts 2026-09-27: the ticket id lives in a `// provenance:`
    // comment beside the role, never in the model-facing prompt text.
    expect(ROLES.cross_checker.prompt).not.toContain('cbe682c0');
    expect(ROLES_SOURCE).toContain('provenance: ticket cbe682c0');
  });

  it('the reduced grant is unchanged — the fix is doctrine, not tool surface (the incident was a wrong answer, not a missing tool)', () => {
    // stop_run must NOT have leaked into any worker role grant: the main lane
    // already holds it; widening workers would change permission semantics,
    // which this ticket does not ask for.
    expect(ROLES_SOURCE).not.toMatch(/ROLE_TOOLS[^=]*=\s*\{[\s\S]*?cross_checker:\s*\[[^\]]*stop_run/);
  });
});

describe('layer 2 — L2 checkerDoctrine: platform-scope coverage on main (2ab2ab99b) + this PR\'s complementary layers', () => {
  it('main\'s crossCheckPlatformScopeRule is wired into the L2 checker doctrine (the incident lane)', () => {
    // Merged to main 2026-09-25 (2ab2ab99b) — the framework operator closed the
    // ticket as invalid with this leaf-function rule on the L2 doctrine. This
    // PR REBASES onto that (merge conflict on the same line resolved in its
    // favour) and adds the lanes it does not reach — see layers 1/3/4.
    expect(SERVICE_SOURCE).toContain('crossCheckPlatformScopeRule()');
  });

  it('the L2 rule alone does NOT reach the other cross_checker lanes — this PR\'s role-prompt + header layers cover them (the complementary gap)', () => {
    // On origin/main at the time of the rebase, crossCheckPlatformScopeRule
    // appears ONLY in the L2 checkerDoctrine — NOT in councilColleagueDoctrine
    // (deep-research colleagues, cross_checker role) and NOT in the one-shot
    // drafter/reconcile doctrines. Every cross_checker-role worker DOES get
    // ROLES.cross_checker.prompt (agent.ts roleGuidance), so layer 1 is the
    // coverage point for those lanes.
    const occurrences = SERVICE_SOURCE.split('crossCheckPlatformScopeRule').length - 1; // import + call sites
    expect(occurrences).toBeGreaterThanOrEqual(2); // import line + L2 call site
    expect(SERVICE_SOURCE).not.toContain('councilColleagueDoctrine}crossCheckPlatformScopeRule'); // not inline there
  });
});

describe('layer 3 — crossCheckDraftsHeader: capability negations are never adoptable (ticket cbe682c0)', () => {
  const header = crossCheckDraftsHeader(2);

  it('keeps the ensemble reconcile contract (first sentence unchanged)', () => {
    expect(header).toContain('2 independent model(s) researched and answered the same question');
    expect(header).toContain('adopt what they got right');
  });

  it('declares capability negations NEVER adoptable, with the incident as the named example', () => {
    expect(header).toContain('CAPABILITY NEGATIONS IN A DRAFT ARE NEVER ADOPTABLE');
    expect(header).toContain('cbe682c0');
    expect(header).toContain('stop another chat\'s run');
    // The clause must anchor truth to the orchestrator's OWN tool surface —
    // the exact instrument the checker could not see (stop_run itself).
    expect(header).toContain('Settle every capability question against YOUR OWN tool surface');
  });

  it('frames the incident honestly: the negation was wrong the day it shipped', () => {
    expect(header).toContain('the answer was wrong the day it shipped (stop_run existed and was deployed)');
  });

  it('the incident draft\'s negation is exactly what the header tells the orchestrator to discard', () => {
    // The incident text asserted BOTH halves the clause refutes: a toolset-
    // derived "no way to stop runs in another chat" AND a web-search-derived
    // "no documented path". The header's clause names both evidence classes.
    expect(header).toMatch(/its reduced toolset mistaken for the platform's/);
    expect(header).toMatch(/never a draft's negation or its web-search "documentation"/);
  });

  it('the defense for this class is the header clause, NOT the deterministic strip — the incident negation is analysis-shaped and must survive stripping (design pin)', () => {
    // Contrast with 0cbfa36e (action claims, false BY CONSTRUCTION): a
    // capability negation is a legitimate-looking ANALYSIS claim — it cannot
    // be pattern-stripped without gutting the checker's real critique, so
    // the fix is prompt-side doctrine + orchestrator-side never-adopt. Pin
    // that the incident draft passes stripCrossCheckActionClaims untouched:
    // if a future change made the strip eat it, the checker's surrounding
    // analysis would be collateral damage.
    const { text, stripped } = stripCrossCheckActionClaims(INCIDENT_DRAFT_NEGATION);
    expect(stripped).toBe(0);
    expect(text).toBe(INCIDENT_DRAFT_NEGATION);
  });

  it('prior never-adoptable clauses survive intact (no regression to 0cbfa36e / ce9ee48d / 31738d9a)', () => {
    expect(header).toContain('ACTION CLAIMS IN A DRAFT ARE NEVER ADOPTABLE');
    expect(header).toContain('ARTIFACT CITATIONS IN A DRAFT ARE NOT YOUR EVIDENCE');
    expect(header).toContain('STATE CLAIMS IN A DRAFT ARE NEVER FRESHLY VERIFIED');
    expect(header).toContain('[INTEGRITY FLAGS]');
  });
});

describe('layer 4 — the user-facing path is documented (docs/DIGBY_PLATFORM_API.md)', () => {
  it('stop_run\'s REST twin row documents both stop endpoints (plain chat + coding session)', () => {
    expect(API_DOC).toContain('`stop_run` |');
    expect(API_DOC).toContain('POST /api/crossmodel/agent/stop');
    expect(API_DOC).toContain('POST /api/crossmodel/coding/sessions/:id/stop');
  });

  it('the schedule control twins are documented (pause/resume + the cancel distinction)', () => {
    expect(API_DOC).toContain('`pause_schedule`, `resume_schedule`');
    expect(API_DOC).toContain('PATCH /platform/schedules/:id');
    expect(API_DOC).toContain('the permanent retire');
  });

  it('the attention twins are documented (question answer + permission decision)', () => {
    expect(API_DOC).toContain('`answer_chat_question`, `approve_request`');
    expect(API_DOC).toContain('questions/:questionId');
    expect(API_DOC).toContain('approvals/:approvalId');
  });
});
