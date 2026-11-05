import { modelToolName } from '../coding/tool-scope';
/**
 * Lane-scope exemption for cross_checker-role lanes (L2 cross-checker and
 * deep-research council colleagues) — ticket f08fcd6f.
 *
 * The problem: these lanes run with web + retrieval tools ONLY (roles.ts
 * grants the cross_checker role WEB + RETRIEVE + INTEGRATIONS + file_feedback;
 * workers never get platform/fleet tools), yet main-lane contract text reaches
 * them verbatim on two surfaces:
 *
 *  (A) Supervisor chat, non-machine turns — the fleet-supervisor system
 *      context (fleet-citation mandates, the update_supervisor_state duty,
 *      claim-bar rules) is appended to the checker doctrine; every one of
 *      those mandates is addressed to the main lane and is unsatisfiable by a
 *      lane with no fleet tools.
 *  (B) deep_research chats, machine wakes — the machine-wake FRESHNESS
 *      CONTRACT ("pull every fleet-state claim fresh via tools THIS run … an
 *      answer without ANY tool call is rejected") is baked into the wake
 *      payload that council colleagues receive as their user message, with no
 *      exemption. (The council lane has no machineWake gate at all. The L2
 *      checker is skipped on machine wakes BY DEFAULT — the machine preset
 *      plus machineTurnSkipsChecker — but since 2026-09-26 the compute-policy
 *      gate can ACT to add a checker BEHIND a machine wake's answer (the
 *      gateSpawnedOnMachine carve-out at the shouldSpawnChecker call in
 *      chat-agent.service.ts), which is why the L2 exemption was aligned to
 *      `isSupervisorChat || args.machineWake` on 2026-10-03 — the same flag
 *      the preamble keys on.)
 *
 * The exemption below scopes the lane to payload/reconciliation critique: it
 * tells the model which instructions are NOT addressed to it, forbids
 * fleet-action attempts, and replaces "verify fresh" with "cite as
 * payload-derived" for fleet state it cannot check.
 *
 * A second, GENERAL rule lives here too — crossCheckArtifactGroundingRule
 * (ticket ce9ee48d): the phantom-artifact-citation defense for EVERY L2
 * cross-check run, not just fleet-scoped ones. During the 2026-09-17 00:13Z
 * Fleet Supervisor deploy-recovery wake, the L2 draft narrated a "Progress
 * Recap (00:13:34Z)" block — shell commands, a curl to a nonexistent OpenAI
 * credits path returning "$12.40", YAML edits — and attributed it to the
 * orchestrator's context, but no such block existed on ANY persisted surface.
 * The draft had woven REAL fragments (the wake clock from its own injected
 * context + a credits topic) into a FALSE but plausibly-sourced artifact.
 * Unlike the action-claim class (ticket 0cbfa36e — claims false BY
 * CONSTRUCTION because the lane has no action tools, strippable
 * deterministically), an artifact citation cannot be pattern-stripped: the
 * lane CAN legitimately quote what is genuinely in its context. The defense
 * is therefore prompt-side grounding: quote only what is present verbatim,
 * name where it is read from, and say "not present in my provided context"
 * instead of reconstructing.
 *
 * Kept in a leaf module (no imports) so it is unit-testable without pulling in
 * the chat-agent service's import graph — the machine-wake.ts pattern.
 */

/**
 * The exemption note appended to a cross_checker-role lane's doctrine when the
 * run's prompt/system context carries main-lane fleet contract text. Appended
 * (not replaced) so normal ensemble behavior elsewhere is untouched.
 */
export function crossCheckFleetScopeNote(): string {
  return (
    `[LANE SCOPE — cross-check lane exemption (ticket f08fcd6f): you are an independent cross-check / research lane with web + retrieval tools ONLY. You have NO fleet tools — no list_chats, get_chat_messages, get_chat_status, goal_list, todo_list, schedule_get, or ${modelToolName('update_supervisor_state')}. Any fleet-citation, freshness-contract, claim-bar, or supervisor-state instructions in the prompt or system context are addressed to the MAIN lane, not to you:\n` +
    `- Do NOT attempt fleet tool calls, supervisor-state updates, or any fleet action — you cannot perform them.\n` +
    `- NEVER claim to have performed an action yourself: no "ACTIONS TAKEN"-style sections, no "I sent / dispatched / filed / updated …" claims, and no receipt or message ids cited as your own — you have no such capability, every such claim is a fabrication, and the harness strips action-claim blocks from your draft before it reaches the main lane (ticket 0cbfa36e).\n` +
    `- Do NOT report fleet state as freshly verified by you. Treat fleet details in the payload as GIVEN context that may be stale or truncated: cite them as payload-derived (e.g. "per the wake payload"), and label anything decision-relevant that you could not check as UNVERIFIED-by-lane.\n` +
    `- Your value is reconciliation critique and web-verifiable research: check the payload's factual/technical claims against your own sources where relevant, flag internal inconsistencies, and state honestly what only the main lane's fleet tools could confirm.]`
  );
}

/**
 * The lane clock + provenance stamp composed into EVERY L2 cross-check lane's
 * doctrine (ticket 31738d9a). Root cause of the incident: the checker lane is
 * handed NO clock of its own (runChatWorker injects none), so when it wanted
 * a headline time for its "Fleet sweep" draft it INVENTED one — 26 minutes in
 * the future of the live harness clock — and presented projected fleet state
 * ("benchmark banked 26/27") as observed fact. Giving the lane its real run
 * clock removes the need to invent one; the rule then forbids the two
 * confabulation shapes the incident exhibited: future-dating and
 * state-claims-as-observation. Position in the doctrine: immediately BEFORE
 * crossCheckArtifactGroundingRule so the pinned artifact-rule/image-block
 * adjacency is preserved.
 */
export function crossCheckLaneClockNote(now: Date): string {
  return (
    `[LANE CLOCK + PROVENANCE — hard rule (ticket 31738d9a): your run's real clock is ${now.toISOString()} — the ONLY current time you have. NEVER state or headline a clock reading LATER than this as the current time: a projected completion or ETA must be labeled as a projection ("expected by …", "ETA …"), never written as the time now. The same provenance discipline governs state claims: report as fact ONLY what YOUR OWN tools observed this run — anything inferred, estimated, or carried from the payload is labeled as such ("per the payload", "not probed — I could not check this"), and an id you cite (message, ticket, receipt) must be one you actually read in your context or your tool results. The harness deterministically annotates drafts that violate these rules (future clocks; ids absent from your context) before the main lane sees them.]`
  );
}

/**
 * The artifact-grounding rule composed into EVERY L2 cross-check lane's
 * doctrine (ticket ce9ee48d — see the module doc above for the incident).
 * Position in the doctrine matters: it is emitted immediately BEFORE the
 * lane's image block + system context so "below" reads truthfully.
 */
export function crossCheckArtifactGroundingRule(): string {
  return (
    `[ARTIFACT GROUNDING — hard rule (ticket ce9ee48d): quote, paraphrase, or summarize an artifact (a block, recap, message, log, command output, or file) ONLY when it is present verbatim in YOUR provided context below — and name where you are reading it from (the section header, or the message/part id when one is shown). If you cannot see it, say exactly "not present in my provided context" and move on — NEVER reconstruct, infer, or narrate its contents. A timestamp, a topic, or a secondhand mention of an artifact is NOT the artifact: real fragments woven into the invented contents of an unseen artifact are a fabrication. The main assistant's context, tool results, and recaps are NEVER visible to you unless they appear below.]`
  );
}

/**
 * Platform-scope rule (peer verification 2026-09-25, false-gap ticket
 * cbe682c0): the Double Checker filed "no way to stop runs in another chat"
 * while the main assistant was staging stop_run — and web-searched
 * "digby.ai docs how to stop a run" / "digby.ai pricing" on two probe turns
 * (317 s / 88 s). Digby's own platform/account tools (run control,
 * schedules, tickets, memory, integrations, sharing) live on the MAIN lane;
 * the checker never has them and must never treat their absence in its own
 * tool list as a product gap. Injected on EVERY cross-check turn.
 */
export function crossCheckPlatformScopeRule(): string {
  return (
    `[PLATFORM SCOPE — hard rule: Digby's own platform and account tools (stopping/steering runs, schedules, hooks, tickets, memory, knowledge, integrations, sharing, spend) belong to the MAIN assistant, not to you — your tool list is web + retrieval only, by design. NEVER report a Digby capability as missing, never file a ticket about a Digby capability gap, and never web-search digby.ai for docs, pricing, or how-tos — the main assistant's own context is the source of truth for what Digby can do; answer the user's actual question. file_feedback is ONLY for a harness malfunction you hit yourself in this lane (a tool that errored), never for a capability you do not have.]`
  );
}

/**
 * Verify-silence rule (rule evidence.verify-silent — the cohesive-chat
 * program's verifier case): an independent verification pass that could not
 * fetch the same evidence the main lane cites (a blank read, a tool miss, a
 * page or thread that did not load for it) says so and stays SILENT on that
 * finding — it never contradicts a receipt it could not retrieve. "Could not
 * verify" is a valid verdict; "refuted" needs the evidence in hand. The main
 * lane's reconcile pass treats an unverifiable cross-check as no signal, not
 * as a disagreement. Injected on EVERY cross-check turn (after the platform-
 * scope rule; the same principle is stated once in the supervisor core
 * doctrine for delegated researchers and in the coding worker roles).
 */
export function crossCheckVerifySilenceRule(): string {
  return (
    `[VERIFY SILENCE — hard rule: when you could NOT fetch the same evidence the main assistant cites (a blank read, a tool miss, a page or thread that did not load for you), say exactly that and stay SILENT on that finding — never contradict a receipt, id, message or result you could not retrieve yourself. "Could not verify" is a valid verdict; "refuted" or "this is wrong" needs the evidence in your own tool results. Your draft's disagreements are only the ones you can show.]`
  );
}
