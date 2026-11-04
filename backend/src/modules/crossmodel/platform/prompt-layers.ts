/**
 * PROMPT LAYERS — the one composer every generated system prompt goes through
 * (docs/FRAMEWORK_LESSONS.md, AGENTS.md "2026-09-27 layered prompts").
 *
 * Compose order = precedence, last wins:
 *   [1 core]     project-agnostic principles (core-doctrine.ts) — no dates,
 *                ids, project / model names, owner quotes with dates.
 *   [2 facts]    what the harness does NOW, composed from live values
 *                (framework-facts.ts) — ≤ 2,500 chars, one dated header.
 *   [3 project]  the project's OWN brief (project-brief.model.ts) — absent on
 *                the fleet seat, which reads its roster live each wake.
 *   [4 role]     the seat's duties / loop / style (role-profiles.ts) — generic.
 *   [5 chat]     the owner's per-chat words + the machine-wake envelope.
 *
 * Every layer is fenced by an HTML-comment marker (`<!-- layer:core -->`) so
 * the prompt-hygiene lint and the stale-prompt heals can address ONE layer,
 * and the whole prompt carries `<!-- layers:v2 -->` on its second line — the
 * re-scaffold key: a stored supervisor prompt without it is a pre-layering
 * (v1) prompt and is rebuilt on the next ensure / heal / migrate call.
 *
 * The OPENER stays at offset 0 unchanged (the stock-prompt heals and the UI
 * classifiers key on `startsWith(<opener>)`).
 *
 * The pre-layering builders (`legacy*`) and their PROMPT_LAYERING_DISABLED
 * switch were deleted in build 2026-10-08 S-2 (simplify.md): the switch was
 * never forwarded by docker-compose.app.yml, so the layered path is the only
 * one prod has run since 2026-09-27.
 */

import { renderProjectBrief, PROJECT_BRIEF_BUDGET, type ProjectBrief } from './project-brief.model';

export type PromptLayerId = 'core' | 'facts' | 'project' | 'role' | 'chat';
export type PromptRole = 'fleet_supervisor' | 'project_supervisor' | 'coding_lane' | 'helper' | 'chat';

export const LAYERS_VERSION_MARKER = '<!-- layers:v2 -->';
export const layerMarker = (id: PromptLayerId): string => `<!-- layer:${id} -->`;
const LAYER_MARKER_RE = /^<!-- layer:(core|facts|project|role|chat) -->$/;

/** Per-layer char budgets (the prompt-hygiene lint fails an over-budget layer).
 *
 *  THE PIN RULE: each budget is the MEASURED worst-case layer + 4%, and
 *  prompt-layers.test.ts ("LAYER_BUDGETS sit at measured + 4%") fails when a
 *  budget drifts more than +8% above what the layer measures — so a budget
 *  can only be bumped together with the text that needed it, and the bump
 *  carries ONE justification line here (what rule was added, measured size).
 *  Seven bumps in the 36 h after the 2026-09-27 split (core 10,547 → 15,150)
 *  happened with no compression pass; the backlog audit (CT-8) compressed
 *  core-doctrine.ts + role-profiles.ts with every rule id, header, tool name
 *  and taught phrase kept — fleet core 15,121 → 11,240, fleet role 31,876 →
 *  26,828, project role 23,349 → 19,909 — and re-pinned here. Prefer
 *  compressing an existing bullet over raising a budget: a rule is ONE
 *  sentence, and its worked example belongs in docs/FRAMEWORK_LESSONS.md.
 *
 *  facts ≤ 3,400 by construction (framework-facts.ts FRAMEWORK_FACTS_MAX_CHARS).
 *  The PROJECT budget is PROJECT_BRIEF_BUDGET from the model and is ENFORCED
 *  at render time by renderProjectBrief (the caps alone let 12 goals pass
 *  4,800 chars) — for that layer the lint pins the fit loop rather than being
 *  the only guard. */
export const LAYER_BUDGETS: Readonly<Record<PromptLayerId, number>> = {
  // core: fleet core measured 11,240 after the CT-8 compression pass; +4%.
  // 11,670 → 12,355 (F2 frontier reflection council, owner 2026-10-06 late): rule reflect.council — "after repeated
  // failures, reflect and consult the frontier council — cite every failure, your goal and where you are"; measured
  // worst case 11,878; +4%.
  // 12,355 → 13,265 (audit 96fb2f25, 2026-10-16): rules truth.owner-ask ("a supervisor reply is an answer, not an
  // outcome — a captured owner request renders answered until typed evidence closes it done") and
  // gate.owner-only-class ("an owner-only class question is answered only by the owner") joined via recordLesson;
  // both bullets compressed before pinning (12,755 → 12,673 measured worst case); budget = measured + 4% = 13,180.
  // 13,180 → 13,789 (ticket 76045f4e, 2026-10-16): rule gate.filer-duplicate-retire ("a filer retires its own fresh
  // duplicate by naming the verified canonical ticket") joined via recordLesson — the filer-duplicate-retire rail's
  // doctrine sentence, compressed once before pinning (435 → 121 chars); measured worst case 13,258 (main's
  // asks.console-action-inline re-pin at 13,140 + this rule); budget = measured + 4%.
  // 13,789 → 14,412 (todo 89df978b, 2026-10-16 rebase): rule runs.budget-observe ("a machine-run budget is
  // observed before enforced — record which runs would have been cut, never cut, cancel or requeue, act only
  // on the measured share") joined via recordLesson alongside main's evidence.scoped-verify re-pin (13,710);
  // compressed twice before pinning (318 → 168 chars); measured worst case 13,896; budget = measured + 4%.
  // 14,412 → 14,672 (merge 2026-10-17, todos b73b1460 + 0f58ddde × 89df978b): all THREE evidence-section bullets
  // now coexist — evidence.scoped-verify (178 → 160 chars, main) + runs.budget-observe (318 → 168 chars, main)
  // + telemetry.board-saturation (246 → 193 → 170 chars, branch), each independently compressed to its floor
  // BEFORE its merge (no text re-compressible without losing the rule); union measured worst case 14,108;
  // budget = measured + 4%.
  // Re-pinned 2026-10-17 (ticket 26786762): rule secrets.owner-card-delivery joined the scope section
  // (the owner-card credential-destruction incident — a delivered credential routes to the encrypted
  // question-secret store with a reveal handle, never the card text); compressed once before pinning
  // (281 → 247 chars); measured worst case 14,355; budget = measured + 4%.
  // Re-pinned 2026-10-17 (stitch, tickets 26786762 × c75b5f34): BOTH rules coexist —
  // secrets.owner-card-delivery (247 chars) + isolation.instance-boundary (186 chars), each
  // independently compressed to its floor BEFORE its merge; union measured worst case 14,562
  // (core budget 14,930 → 15,145 = measured + 4%).
  // Re-pinned 2026-10-17 (ticket 97c06f46): rule evidence.absence-probe joined the evidence
  // section (the supervisor read an access-scoped 404 as lane deletion and filed a false
  // slot-reclaim ticket) — compressed twice before pinning (297 → 223 chars); union measured
  // worst case 14,784; budget = measured + 4% = 15,376.
  // Re-pinned 2026-10-18 (todo 0dd7d3f2): rule gates.reply-truth joined the gate section
  // (the choice-card credential-banner incident — a delivered non-resolving reply must say
  // so, never "needs a credential", and carry its full text) — compressed once before
  // pinning (348 → 231 chars); union measured worst case 15,025; budget = measured + 4%.
  // 2026-10-18 (todo ead881f4, ticket 4a8fcbde): rule evidence.proxy-depth-attribution joined the
  // evidence section (caller-IP attribution derives from the RIGHT of the forwarded chain — the
  // ALB-node-as-attacker class behind the false password-guessing card) — compressed twice before
  // pinning (507 → 243 chars); union measured worst case 15,311; budget = measured + 4%.
  // Re-pinned 2026-10-18 (ticket 35c3ecb0): rule board.sent-not-landed joined the evidence
  // section (the supervisor asserted an owner card "answered and folded, receipt-backed" off
  // its own QUEUED send — the receipt proved the send, not the recipient's fold) — one rule
  // sentence at 306 chars; union measured worst case 15,649; budget = measured + 4% = 16,275.
  // Re-pinned 2026-10-19 (ticket b36a150e): rule evidence.structured-verdict joined the
  // evidence section (the run-outcome structured verdict field — a merge-safety verdict is
  // also emitted as one machine-readable JSON line, read ahead of prose parsing) — the
  // landed rule sentence is 234 chars; union measured worst case 15,919; budget =
  // measured + 4% = 16,556 (review F4: exact ceil, first pin was 16,576).
  // 2026-10-20 (OWNER-DIRECTIVE-FANOUT): the PROJECT tier's scope.project bullet names the harness
  // [OWNER DIRECTIVES IN FORCE] block as binding (+105 chars → project core 15,737); the worst case is
  // still the fleet core at 15,919, so the budget is unchanged (no re-pin; main's 16,920 stands).
  // Re-pinned 2026-10-20 (ticket b03d7033): rule asks.act-or-escalate joined the evidence
  // section (the explanation-only close of an owner state-complaint ask — the reply answered
  // the question, the order it carried died with no action and no report-up) — compressed
  // twice before pinning (311 → 249 chars, at its semantic floor); measured worst case 16,520
  // (core budget 16,920 → 17,181 = measured + 4% exact ceil).
  // Re-pinned 2026-10-22 (fs-code-knowledge): rule evidence.absence-probe gained its code
  // sentence in place ("this code or feature does not exist" needs a direct read of the default
  // branch — an empty semantic code search never proves it; the Fleet Supervisor denied a
  // shipped UI feature off an empty search of a scope with no index) — +129 chars; measured
  // worst case 16,649 (core budget 17,181 → 17,315 = measured + 4% exact ceil).
  // Re-pinned 2026-10-24 (ticket e44e1219): rule evidence.condition-wake-visibility joined the
  // evidence section (the supervisor verified a lane's true registered-wake claim off the
  // schedule count, read zero, and armed redundant one-shots — the wake store was never
  // probed) — compressed once before pinning (396 → 287 chars, at its semantic floor);
  // measured worst case 16,983 (core budget 17,315 → 17,663 = measured + 4% exact ceil).
  // Re-pinned 2026-10-24 (ticket 1a6afc6a): rule evidence.stand-down-on-closed joined the
  // evidence section (the ticket drain dispatched a lane to a ticket 0.554s before it
  // closed done; the lane re-executed the verified-done change) — compressed once before
  // pinning (316 → 270 chars, at its semantic floor); measured worst case 17,267
  // (core budget 17,663 → 17,958 = measured + 4% exact ceil).
  // 2026-10-31 (ticket 5fba7188): rule evidence.answering-build joined the evidence
  // section (a superseded worker colour answered tool calls on the pre-fix build
  // during the zero-gap drain, so a shipped fix read as ABSENT four times). NO
  // re-pin: compressed to 193 chars so the EXISTING ceiling absorbs it — measured
  // worst case 17,461 < 17,958 (17,267 + 193 + 1 newline); +4% would be 18,160.
  core: 17_958,
  // facts: 3,400 → 4,050 (backlog audit 2026-09-28): the FRAMEWORK BACKLOG line
  // (docs/FRAMEWORK_BACKLOG.md is the Fleet Supervisor's living backlog) joined
  // the supervisor-audience block — every-purpose-act render measured 3,893;
  // budget = measured + 4% (FRAMEWORK_FACTS_MAX_CHARS moved with it).
  facts: 4_050,
  project: PROJECT_BRIEF_BUDGET,
  // role: fleet role measured 26,828 after the CT-8 compression pass; +4%.
  role: 27_910,
  chat: 3_000,
};

/** The drift the size pin tolerates above the measured layer (prompt-layers.test.ts). */
export const LAYER_BUDGET_MAX_HEADROOM = 1.08;

export interface ComposeInput {
  role: PromptRole;
  /** The stock identity line — stays at offset 0. */
  opener: string;
  core: string;
  /** '' / null omits the layer. */
  facts?: string | null;
  project?: ProjectBrief | null;
  roleProfile: string;
  chat?: { systemPrompt?: string | null; envelope?: string | null } | null;
}

export interface ComposedPrompt {
  text: string;
  layers: Array<{ id: PromptLayerId; chars: number }>;
}

function block(id: PromptLayerId, body: string): string {
  return `${layerMarker(id)}\n${body.trim()}`;
}

/** Compose the layered prompt. Deterministic: same input → same bytes. */
export function composePrompt(input: ComposeInput): ComposedPrompt {
  const parts: string[] = [input.opener.trim(), LAYERS_VERSION_MARKER];
  const layers: ComposedPrompt['layers'] = [];
  const push = (id: PromptLayerId, body: string | null | undefined) => {
    const b = (body ?? '').trim();
    if (!b) return;
    parts.push(block(id, b));
    layers.push({ id, chars: b.length });
  };
  push('core', input.core);
  push('facts', input.facts);
  if (input.project) push('project', renderProjectBrief(input.project));
  push('role', input.roleProfile);
  if (input.chat) {
    const chatParts = [input.chat.systemPrompt, input.chat.envelope].map(s => (s ?? '').trim()).filter(Boolean);
    if (chatParts.length) push('chat', chatParts.join('\n\n'));
  }
  return { text: parts.join('\n\n'), layers };
}

/** True when a stored prompt was composed by this module (v2). */
export function isLayeredPrompt(text: string | null | undefined): boolean {
  return typeof text === 'string' && text.includes(LAYERS_VERSION_MARKER);
}

/** Split a composed prompt back into its layers (the lint + the heals address one layer). */
export function splitLayers(text: string): Array<{ id: PromptLayerId | 'opener'; body: string }> {
  const out: Array<{ id: PromptLayerId | 'opener'; body: string }> = [];
  let current: { id: PromptLayerId | 'opener'; lines: string[] } = { id: 'opener', lines: [] };
  for (const line of text.split('\n')) {
    const m = line.match(LAYER_MARKER_RE);
    if (m) {
      out.push({ id: current.id, body: current.lines.join('\n').trim() });
      current = { id: m[1] as PromptLayerId, lines: [] };
      continue;
    }
    if (line === LAYERS_VERSION_MARKER) continue;
    current.lines.push(line);
  }
  out.push({ id: current.id, body: current.lines.join('\n').trim() });
  return out.filter(l => l.body.length > 0 || l.id !== 'opener');
}

/** Normalised sentence set of a text — the cross-layer duplicate check. */
export function sentenceSet(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.split(/(?<=[.!?])\s+(?=[A-Z"'(\[])|\n/)) {
    const s = raw.replace(/^[-*\d.)\s]+/, '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (s.length >= 60) out.add(s);
  }
  return out;
}

/** Sentences (≥ 60 chars, normalised) that appear in more than one layer. */
export function duplicateSentencesAcrossLayers(text: string): string[] {
  const seen = new Map<string, PromptLayerId | 'opener'>();
  const dups = new Set<string>();
  for (const layer of splitLayers(text)) {
    for (const s of sentenceSet(layer.body)) {
      const prev = seen.get(s);
      if (prev && prev !== layer.id) dups.add(s);
      else seen.set(s, layer.id);
    }
  }
  return [...dups].sort();
}
