/**
 * Owner-authority kill switches (2026-10-20) — an IMPORT-FREE leaf so the
 * owner-question, supervisor-ledger, goal-board and tool modules (and suites
 * that mock any of them with partial objects) all read the same switch.
 *
 *   OWNER_DIRECTIVE_FANOUT_DISABLED=1   no [OWNER DIRECTIVES IN FORCE] block on
 *       project-supervisor wakes / lane run starts, no mirror of a banked
 *       answer / ruling onto the asking project's supervisor ledger, no
 *       "Fleet-wide owner rules" section in the project brief.
 *   OWNER_PROVENANCE_STRICT_DISABLED=1  a supervisor's / a preset default's
 *       answer is banked as "Owner ANSWERED" with the owner stamp again, a
 *       duplicate inherits 'owner', the brief lists every answered question as
 *       an owner decision, and a supervisor / default HOLD stays blockKind
 *       'owner' — the pre-fix provenance.
 *   OWNER_DISMISS_RAILS_DISABLED=1      dismiss_owner_question from a
 *       supervisor seat on a machine turn skips the owner-only-class, owner-
 *       engaged and project-scope rails, and every supervisor dismissal arms
 *       the 24 h re-flag cooldown again.
 *   OWNER_QUESTION_PAYLOAD_CLASS_DISABLED=1  (ticket 1a56f816) the flag-time
 *       PAYLOAD leg of the owner-only class admission is skipped: a card whose
 *       own typed options are human-action-shaped ("Done — ran it, output
 *       pasted below" / "not at that machine") or that pairs a named physical
 *       machine with a credential the platform does not hold (sudo / console
 *       password) or a run-it-and-paste-the-output instruction is triaged to
 *       the supervisor again — the pre-fix routing (the regex allowlist only).
 *   OWNER_QUESTION_TRIAGE_EARLY_RELEASE_DISABLED=1  (ticket 1a56f816) the
 *       surfacing sweep no longer releases a triage window early when the
 *       owner posted in the filing chat after the card was filed; only the
 *       SLA elapsed surfaces a card (the pre-fix behaviour).
 */

export function ownerDirectiveFanoutDisabled(): boolean {
  return process.env.OWNER_DIRECTIVE_FANOUT_DISABLED === '1';
}

export function ownerProvenanceStrictDisabled(): boolean {
  return process.env.OWNER_PROVENANCE_STRICT_DISABLED === '1';
}

export function ownerDismissRailsDisabled(): boolean {
  return process.env.OWNER_DISMISS_RAILS_DISABLED === '1';
}

/** Ticket 1a56f816: skip the flag-time PAYLOAD leg of the owner-only class
 *  admission (typed human-action options, physical device + an unobtainable
 *  credential, run-it-and-paste instructions) — the pre-fix routing. */
export function ownerQuestionPayloadClassDisabled(): boolean {
  return process.env.OWNER_QUESTION_PAYLOAD_CLASS_DISABLED === '1';
}

/** Ticket 1a56f816: never release a triage window early on owner engagement —
 *  only the SLA elapsed surfaces a card (the pre-fix behaviour). */
export function ownerQuestionTriageEarlyReleaseDisabled(): boolean {
  return process.env.OWNER_QUESTION_TRIAGE_EARLY_RELEASE_DISABLED === '1';
}
