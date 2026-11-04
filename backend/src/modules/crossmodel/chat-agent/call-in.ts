/**
 * The lead's `call_in` tool — dynamic roster phase 4 (roster 2026-10-06 D-2; docs/DYNAMIC_ROSTER_PLAN_2026-10-03.md
 * §4 B.5 "Mid-turn scaling: the lead gets a call_in tool to add a checker or colleague from the pools when the question
 * proves harder than it looked — bounded by the existing one-checker / one-council-per-message budget"; option D's
 * tool as a SUPPLEMENT to the turn plan, never the router).
 *
 * Mid-turn, the lead can call in ONE more model for THIS question:
 *   role 'checker'   — an independent second answer from a DIFFERENT model family (verify the lead's answer). Offered
 *                      only when the turn runs no Double Checker (one checker per message);
 *   role 'colleague' — a research colleague (different family) on ONE scoped sub-question the lead briefs.
 * The model comes from the admin's Auto pools (checker / colleague — an empty pool follows its seats,
 * auto-pools.service.ts), the first servable OPEN one whose family differs from the lead's (never frontier-class —
 * owner 2026-10-06 late); none ⇒ an honest refusal.
 * The report comes back as the TOOL RESULT the lead weighs — the lead stays the single writer.
 *
 * Bounds (every one enforced here, never by the model): ONE call per turn (a second call returns the first report
 * again — a whole-orchestration replay sees the same evidence, never a second paid run); a wall-clock window =
 * min(CALL_IN_MAX_MS, the lead's remaining run budget − CALL_IN_RESERVE_MS), refused below CALL_IN_MIN_MS; the worker
 * runs ≤ CALL_IN_MAX_STEPS tool rounds with that window as its own deadline, and a harness race cancels it
 * CALL_IN_HARD_GRACE_MS later. Read-only by construction: the worker runs the cross_checker role (web + retrieval +
 * read-only integrations; no platform / action tools, no ask_user).
 *
 * Where it is offered (callInOffer, pure): a HUMAN turn of a signed-in user on a plain chat — never a supervisor
 * chat, a machine-triggered run (schedule / hook / agent / webhook / continuation), a Dig-deeper rung, a council
 * (Level 3 — the council already has colleagues) or the Quick lane (a one-fast-model promise; Dig deeper is its
 * escalation); and only under the store mode (platform/roster-config.ts callIn: 'off' | 'canary' | 'act', default
 * canary ⇒ the rosterCanaryUserIds only). Kill switch CALL_IN_DISABLED=1 (never offered — today's tool list).
 * Telemetry: loop_metrics `call_in` — phase 'offer' (once per offered turn) and phase 'call' (outcome, model, family,
 * window, timing). Never throws: every failure is a plain tool result telling the lead to answer on its own research.
 */

import type { RosterConfig } from '../platform/roster-config';
import { frontierBlockedFromPick } from '../platform/model-pick';
import { crossCheckArtifactGroundingRule, crossCheckLaneClockNote, crossCheckPlatformScopeRule, crossCheckVerifySilenceRule } from './cross-check-scope';
import { stripCrossCheckActionClaims } from './cross-check-action-claims';
import { webSearchMissingOnInstance } from '../platform/instance-setup';
import { STATUS } from './status-voice';

export const CALL_IN_TOOL = 'call_in';
export type CallInRole = 'checker' | 'colleague';
export const CALL_IN_ROLES: readonly CallInRole[] = ['checker', 'colleague'];

/** Default / bounds of the per-call window (env CALL_IN_MAX_MS). */
export const CALL_IN_MAX_MS_DEFAULT = 180_000;
export const CALL_IN_MAX_MS_FLOOR = 30_000;
export const CALL_IN_MAX_MS_CEILING = 300_000;
/** Below this much usable window the call is refused (a rushed second opinion is noise). */
export const CALL_IN_MIN_MS = 45_000;
/** What the window leaves the lead to weigh the report and write. */
export const CALL_IN_RESERVE_MS = 45_000;
export const CALL_IN_MAX_STEPS = 6;
export const CALL_IN_HARD_GRACE_MS = 15_000;
export const CALL_IN_BRIEF_CHARS = 1_500;
export const CALL_IN_REPORT_CHARS = 12_000;

const onFlag = (v: unknown): boolean => {
  const s = String(v ?? '').trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'on';
};
export function callInDisabled(env: Record<string, string | undefined> = process.env): boolean { return onFlag(env.CALL_IN_DISABLED); }

export function callInMaxMs(env: Record<string, string | undefined> = process.env): number {
  const raw = String(env.CALL_IN_MAX_MS ?? '').trim();
  const n = raw ? Number(raw) : NaN;
  if (!Number.isFinite(n) || n <= 0) return CALL_IN_MAX_MS_DEFAULT;
  return Math.min(CALL_IN_MAX_MS_CEILING, Math.max(CALL_IN_MAX_MS_FLOOR, Math.round(n)));
}

/** Seat personas (the same names the status stream and the More-info cards use — never a vendor). */
export const CALL_IN_PERSONA: Record<CallInRole, string> = { checker: 'Double Checker', colleague: 'Triple Checker' };
/** The model card key a call-in's report lands under (free on every turn that may call in: no council; a checker
 *  call only when no Double Checker runs). */
export const CALL_IN_CARD_KEY: Record<CallInRole, string> = { checker: 'double_checker', colleague: 'triple_checker' };

// ── Where it is offered (pure) ───────────────────────────────────────────────

export interface CallInOfferInput {
  userId: string | null | undefined;
  supervisor: boolean;
  machine: boolean;
  escalation: boolean;
  council: boolean;
  quick: boolean;
  /** A Double Checker runs on this turn already (the plan spawned one). */
  checkerRunning: boolean;
}

export interface CallInOffer {
  offered: boolean;
  roles: CallInRole[];
  /** Why not / how (audit string). */
  why: string;
  mode: RosterConfig['callIn'] | 'disabled';
  canary: boolean;
}

export function callInOffer(i: CallInOfferInput, config: RosterConfig, env: Record<string, string | undefined> = process.env): CallInOffer {
  const no = (why: string, mode: CallInOffer['mode'] = config.callIn): CallInOffer => ({ offered: false, roles: [], why, mode, canary: false });
  if (callInDisabled(env)) return no('CALL_IN_DISABLED', 'disabled');
  if (config.callIn === 'off') return no('mode off');
  if (!i.userId) return no('guest');
  if (i.supervisor) return no('supervisor chat');
  if (i.machine) return no('machine turn');
  if (i.escalation) return no('dig deeper rung');
  if (i.council) return no('council turn');
  if (i.quick) return no('quick lane');
  const canary = config.canary.has(i.userId);
  if (config.callIn === 'canary' && !canary) return no('not on the canary');
  const roles: CallInRole[] = i.checkerRunning ? ['colleague'] : ['checker', 'colleague'];
  return { offered: true, roles, why: config.callIn === 'act' ? 'act' : 'canary', mode: config.callIn, canary };
}

// ── Picking the model (pure) ─────────────────────────────────────────────────

export interface CallInCandidateCard {
  spec: string;
  family: string;
  servable: boolean;
  thinkingOff?: boolean;
  /** Seat-governance class (model-catalog.ts) — a frontier card is never called in. */
  frontier?: boolean;
}

/**
 * The model to call in: the role's pool first, then the other pool, de-duplicated; never the lead itself, never a
 * card the catalog says is unservable / no-think / a decision model, never the lead's FAMILY (independent
 * coverage — two 'other'-family models count as the same family), and never a FRONTIER-class model (owner 2026-10-06
 * late: "pickers should never choose frontier" — the card's flag, else the spec's model id, so a frontier-seated
 * Double Checker reached through the seat fallback is skipped too; AUTO_PICK_FRONTIER_ENABLED=1 restores the C-1
 * admission). A spec the catalog does not know stays a candidate (a seat on an unlisted alias — the run path resolves
 * it); its family comes from `familyOf`. Null ⇒ none. Pure over env.
 */
export function pickCallInModels(role: CallInRole, i: {
  lead: string;
  pools: { checker: readonly string[]; colleague: readonly string[] };
  catalog: ReadonlyMap<string, CallInCandidateCard>;
  familyOf: (spec: string) => string;
  env?: Record<string, string | undefined>;
}): Array<{ spec: string; family: string }> {
  const order = role === 'checker' ? [...i.pools.checker, ...i.pools.colleague] : [...i.pools.colleague, ...i.pools.checker];
  const leadFamily = i.catalog.get(i.lead)?.family ?? i.familyOf(i.lead);
  const out: Array<{ spec: string; family: string }> = [];
  for (const spec of order) {
    if (!spec || spec === i.lead || out.some((o) => o.spec === spec)) continue;
    const card = i.catalog.get(spec);
    if (card && (!card.servable || card.thinkingOff)) continue;
    if (frontierBlockedFromPick({ spec, frontier: card?.frontier }, i.env ?? process.env)) continue;
    const family = card?.family ?? i.familyOf(spec);
    if (family === 'decision' || family === leadFamily) continue;
    out.push({ spec, family });
  }
  return out;
}

// ── Prompt text ──────────────────────────────────────────────────────────────

export function callInToolSchema(roles: readonly CallInRole[]): { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } } {
  const both = roles.includes('checker');
  return {
    type: 'function',
    function: {
      name: CALL_IN_TOOL,
      description: `Call in ONE more model for THIS question when it proved harder than it looked.${both ? " role 'checker': an independent second answer from a different model family, to verify yours." : ''} role 'colleague': a research colleague (a different model family) on ONE scoped sub-question you brief. It researches with its own web tools and its report comes back as this tool's result for you to weigh. At most ONE call_in per answer; it takes up to a few minutes. Not for questions you can answer well yourself.`,
      parameters: {
        type: 'object',
        properties: {
          role: { type: 'string', enum: [...roles], description: both ? "'checker' to verify your answer independently; 'colleague' for a scoped research mission." : "'colleague' — a scoped research mission (a Double Checker already runs on this answer)." },
          brief: { type: 'string', description: 'What to verify or find, and the output you want back (specific claims, numbers, sources). The user\'s question is passed along automatically.' },
        },
        required: ['role', 'brief'],
      },
    },
  };
}

/** The doctrine row the lead reads on a turn that offers the tool (rides the chat doctrine's cross-check slot). Pure. */
export function callInDoctrineRow(roles: readonly CallInRole[]): string {
  const checker = roles.includes('checker');
  return [
    '## Calling in help (call_in)',
    `When the question proves harder than it looked — sources conflict, the stakes turn out high, numbers you cannot verify, or a sub-question you cannot cover well — call call_in ONCE:${checker ? " role 'checker' for an independent second answer from another model family that verifies yours," : ''} role 'colleague' for a research colleague on one scoped sub-question. Brief it sharply (what to verify or find, the output you want). Its report returns as the tool result: weigh it, check real disagreements, then answer. Never call it for a question you can answer well yourself, never twice, and never say a second model checked your answer unless its report is in this turn.`,
  ].join('\n');
}

/** The called-in worker's doctrine. Pure. */
export function callInWorkerDoctrine(i: { role: CallInRole; brief: string; windowMs: number; systemContext?: string; imageBlock?: string; now?: Date; webSearchConfigured?: boolean }): string {
  const persona = `the ${CALL_IN_PERSONA[i.role]}`;
  const secs = Math.max(30, Math.round(i.windowMs / 1000));
  const head = i.role === 'checker'
    ? `You are ${persona}, CALLED IN mid-answer by Digby's lead: an INDEPENDENT model of a different family answering the SAME user question, so the lead can verify its own answer. The lead asked you specifically to:\n${i.brief}\n\nYour deliverable is a COMPLETE independent answer to the user's question that explicitly checks the points above (agree / disagree / could not verify, with the evidence).`
    : `You are ${persona}, a research colleague CALLED IN mid-answer by Digby's lead for ONE scoped mission on the user's question:\n${i.brief}\n\nYour deliverable is a concise structured report on that mission: the findings, with sources and numbers where they matter, and what you could not verify.`;
  return [
    head,
    `${i.webSearchConfigured === false
      ? 'This instance has NO live web search: answer from your own knowledge, the user\'s files and retrieval (search_memory), and say plainly where you could not verify.'
      : 'You have your OWN live web tools (search_engine / scrape_as_markdown / web_pipe) and retrieval (search_memory): research whenever the point is time-sensitive, disputable or you are not fully certain, and say plainly where you could not verify. Skip browser_task — it is too slow for this window.'} You CANNOT ask the user anything or act on their behalf; the lead owns all user interaction and actions. You have about ${secs}s and at most ${CALL_IN_MAX_STEPS} tool rounds — finish inside them. END with the deliverable — your final message IS your report.`,
    crossCheckLaneClockNote(i.now ?? new Date()),
    crossCheckArtifactGroundingRule(),
    crossCheckPlatformScopeRule(),
    crossCheckVerifySilenceRule(),
    i.imageBlock || '',
    i.systemContext || '',
  ].filter(Boolean).join('\n\n');
}

// ── The tool ─────────────────────────────────────────────────────────────────

export interface CallInWorkerRequest {
  role: CallInRole;
  model: string;
  doctrine: string;
  /** The worker's own run deadline (the window). */
  windowMs: number;
  maxSteps: number;
  isCancelled: () => boolean;
  emit: (type: string, data: any) => void;
}

export interface CallInWorkerResult {
  finalText?: string;
  parts?: Array<{ type?: string; name?: string }>;
  modelErrored?: boolean;
}

export interface CallInRecord {
  role: CallInRole;
  model: string;
  family: string;
  ok: boolean;
  outcome: 'ok' | 'empty' | 'error' | 'timeout' | 'cancelled';
  ms: number;
  windowMs: number;
  chars: number;
  webToolCalls: number;
}

export interface CallInDeps {
  roles: readonly CallInRole[];
  /** The lead model right now (it can change on a fallback). */
  leadModel: () => string;
  /** The lead's run budget: when its loop started and its deadline (ms). */
  leadBudget: () => { startedAt: number; deadlineMs: number };
  /** The checker / colleague pools + catalog (the live Auto pools; the caller falls back to the seats). */
  candidates: () => Promise<{ pools: { checker: readonly string[]; colleague: readonly string[] }; catalog: ReadonlyMap<string, CallInCandidateCard> }>;
  familyOf: (spec: string) => string;
  /** null = servable; a string = why not. */
  unservable: (spec: string) => Promise<string | null>;
  runWorker: (req: CallInWorkerRequest) => Promise<CallInWorkerResult>;
  /** Shared description of the user's attached images ('' when none). */
  imageBlock?: () => Promise<string>;
  systemContext?: string;
  send: (type: string, data: any) => void;
  /** A finished report as a More-info card. */
  onCard?: (cardKey: string, card: { model: string; response: string; time: number; modelUsed: string; persona: string; webSearchUsed: boolean; error?: string }) => void;
  record: (meta: Record<string, unknown>) => void;
  isCancelled?: () => boolean;
  now?: () => number;
  env?: Record<string, string | undefined>;
}

const countWeb = (parts: CallInWorkerResult['parts']): number => (parts ?? []).filter((p) => p?.type === 'tool_call' && /search|scrape|web_pipe|browser/i.test(String(p?.name ?? ''))).length;

/**
 * One turn's call_in tool: { schema, execute } for the lead's extraTools, plus the record of what ran (the roster and
 * the team note read it at finalize). Never throws.
 */
export function createCallInTool(deps: CallInDeps): { tool: { schema: any; execute: (args: any) => Promise<string> }; record: () => CallInRecord | null } {
  const now = deps.now ?? (() => Date.now());
  let used = false;
  let firstReport: string | null = null;
  let rec: CallInRecord | null = null;
  const lead0 = (): string => { try { return deps.leadModel(); } catch { return ''; } };
  const telemetry = (meta: Record<string, unknown>) => { try { deps.record({ phase: 'call', leadModel: lead0(), ...meta }); } catch { /* telemetry never breaks the tool */ } };

  const execute = async (args: any): Promise<string> => {
    try {
      if (used) {
        telemetry({ outcome: 'repeat' });
        return firstReport
          ? `call_in was already used for this answer (one per answer) — here is its report again:\n${firstReport}`
          : 'call_in was already used for this answer (one per answer) — finish with what you have.';
      }
      const role = String(args?.role ?? '').trim().toLowerCase() as CallInRole;
      const brief = String(args?.brief ?? '').replace(/\s+/g, ' ').trim().slice(0, CALL_IN_BRIEF_CHARS);
      if (!CALL_IN_ROLES.includes(role)) {
        telemetry({ outcome: 'refused', reason: 'bad_role' });
        return `call_in needs role ${deps.roles.map((r) => `'${r}'`).join(' or ')} — nothing was started.`;
      }
      if (!deps.roles.includes(role)) {
        telemetry({ outcome: 'refused', reason: 'checker_running', role });
        return "A Double Checker already runs on this answer (one checker per answer) — use role 'colleague' for a scoped research mission, or answer and let the running check reconcile. Nothing was started.";
      }
      if (!brief) {
        telemetry({ outcome: 'refused', reason: 'no_brief', role });
        return 'call_in needs a brief (what to verify or find, and the output you want) — nothing was started.';
      }
      const b = deps.leadBudget();
      const left = b.deadlineMs - (now() - b.startedAt) - CALL_IN_RESERVE_MS;
      const windowMs = Math.min(callInMaxMs(deps.env), left);
      if (!Number.isFinite(windowMs) || windowMs < CALL_IN_MIN_MS) {
        telemetry({ outcome: 'refused', reason: 'no_time', role, leftMs: Math.max(0, Math.round(left)) });
        return 'Not enough time left in this answer for a call_in — answer with what you have, and say plainly where you could not verify.';
      }
      used = true;
      const lead = lead0();
      const fail = (why: string, extra: Record<string, unknown>): string => {
        telemetry({ outcome: 'refused', reason: why, role, ...extra });
        return `No model of another family can be called in here (${why}) — answer on your own research, and say plainly where you could not verify.`;
      };
      let cand: Awaited<ReturnType<CallInDeps['candidates']>>;
      try { cand = await deps.candidates(); } catch { return fail('pools unavailable', {}); }
      const picks = pickCallInModels(role, { lead, pools: cand.pools, catalog: cand.catalog, familyOf: deps.familyOf, ...(deps.env ? { env: deps.env } : {}) });
      let model: { spec: string; family: string } | null = null;
      for (const p of picks.slice(0, 4)) {
        const why = await deps.unservable(p.spec).catch(() => 'servability probe failed');
        if (!why) { model = p; break; }
      }
      if (!model) return fail(picks.length ? 'no servable candidate' : 'no other-family candidate', { candidates: picks.length });

      const persona = CALL_IN_PERSONA[role];
      const label = persona;
      deps.send('agent-activity', { kind: 'sub_start', label });
      deps.send('progress', { message: STATUS.callIn.start(`the ${persona}`, brief), stage: 'query' });
      const t0 = now();
      let latch = false;
      const cancelled = () => latch || !!deps.isCancelled?.();
      const emit = (type: string, data: any) => {
        try {
          if (type === 'subagent:tool_call') deps.send('agent-activity', { kind: 'tool', label, name: String(data?.name ?? ''), detail: String(data?.args?.query || data?.args?.url || '').slice(0, 80) });
          else if (type === 'subagent:tool_result') deps.send('agent-activity', { kind: 'tool_done', label, name: String(data?.name ?? ''), size: String(data?.result ?? '').length });
        } catch { /* activity is best-effort */ }
      };
      const doctrine = callInWorkerDoctrine({ role, brief, windowMs, systemContext: deps.systemContext, imageBlock: deps.imageBlock ? await deps.imageBlock().catch(() => '') : '', now: new Date(now()), webSearchConfigured: !webSearchMissingOnInstance() });
      let outcome: CallInRecord['outcome'] = 'ok';
      let result: CallInWorkerResult | null = null;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        result = await Promise.race([
          deps.runWorker({ role, model: model.spec, doctrine, windowMs, maxSteps: CALL_IN_MAX_STEPS, isCancelled: cancelled, emit }),
          new Promise<CallInWorkerResult>((_, rej) => { timer = setTimeout(() => rej(new Error('call_in window')), windowMs + CALL_IN_HARD_GRACE_MS); (timer as any)?.unref?.(); }),
        ]);
      } catch (err: any) {
        latch = true; // stop a wedged worker from spending further
        outcome = /call_in window/.test(String(err?.message ?? '')) ? 'timeout' : 'error';
      } finally {
        if (timer) clearTimeout(timer);
      }
      const ms = now() - t0;
      const raw = (result?.finalText ?? '').trim();
      if (outcome === 'ok') {
        if (deps.isCancelled?.()) outcome = 'cancelled';
        else if (result?.modelErrored) outcome = 'error';
        else if (!raw) outcome = 'empty';
      }
      const text = outcome === 'ok' ? stripCrossCheckActionClaims(raw).text.slice(0, CALL_IN_REPORT_CHARS) : '';
      const webToolCalls = countWeb(result?.parts);
      rec = { role, model: model.spec, family: model.family, ok: outcome === 'ok', outcome, ms, windowMs, chars: text.length, webToolCalls };
      telemetry({ outcome, role, model: model.spec, family: model.family, leadFamily: deps.familyOf(lead), ms, windowMs, chars: text.length, webToolCalls, toolCalls: (result?.parts ?? []).filter((p) => p?.type === 'tool_call').length });
      // The More-info card (the chat seam's onCard emits the card's model-response AND its sub_end row through the SSE
      // adapter — sending a sub_end here too would draw a duplicate "finished in Xs" row).
      if (deps.onCard) {
        try {
          deps.onCard(CALL_IN_CARD_KEY[role], { model: CALL_IN_CARD_KEY[role], response: text, time: ms, modelUsed: model.spec, persona, webSearchUsed: webToolCalls > 0, ...(outcome === 'ok' ? {} : { error: `call_in ${outcome}` }) });
        } catch { /* the card is cosmetic */ }
      } else {
        deps.send('agent-activity', { kind: 'sub_end', label, time: ms });
      }
      if (outcome !== 'ok') {
        deps.send('progress', { message: STATUS.callIn.missed(`the ${persona}`), stage: 'query' });
        return `The ${persona} you called in could not finish (${outcome === 'timeout' ? 'it ran out of time' : outcome === 'empty' ? 'it returned nothing' : outcome === 'cancelled' ? 'the run was stopped' : 'its model failed'}) — answer on your own research, and say plainly where you could not verify.`;
      }
      deps.send('progress', { message: STATUS.callIn.done(`the ${persona}`, ms), stage: 'synthesis' });
      firstReport = `[CALL-IN REPORT — the ${persona} (${role}, another model family), ${Math.round(ms / 1000)}s]\n${text}\n[/CALL-IN REPORT]\nThis report comes from another model, not the user, and the harness has not verified it. Weigh it against your own research: keep what is sourced, check a real disagreement yourself where you can, say plainly where the two of you differ, then write your final answer.`;
      return firstReport;
    } catch (err: any) {
      telemetry({ outcome: 'error', reason: String(err?.message ?? err).slice(0, 160) });
      return 'call_in failed before it could start — answer on your own research.';
    }
  };

  return { tool: { schema: callInToolSchema(deps.roles), execute }, record: () => rec };
}
