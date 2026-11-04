/**
 * OWNER-STATUS CONTRACT (todo 908f48a7, monitor lesson 5 — 2026-10-16).
 *
 * Owner-facing status lines from supervisor machine notes were PROSE DERIVED
 * FROM PROXIES, not computed views over the ledger. Specimens (Fleet
 * Supervisor chat c0e22e36, 2026-10-16): 33e56bf7 claimed "103.9 clips/hr …
 * bar met" while its own parenthetical (22 verified decrypts in 26 min) =
 * 50.8/hr and NO target premise held the bar; d4a3eb4e presented a 12.7-min
 * active-window burst as a sustained rate ("keeps building at 103.9
 * clips/hr"); 970e4dcb / ec93e808 / 33e56bf7 / d4a3eb4e / 19e43f7f /
 * 8847b231 / ce0c7009 / ff3bc329 / f561c547 claimed "nothing needs the
 * owner" counted from OPEN CARDS (0) while lane 24f1950e's steps sat blocked
 * on the owner's approved-but-never-landed Tailscale ACL save; eb4f8455 said
 * "fixes started … mid-run on all four" while todo 0ca73af5 read
 * pending/startedAt null.
 *
 * THREE PROXY PAIRS: best-leg rate value → end-to-end/daily rate vs a target;
 * open-card count → work blocked on an owner action; lane run active → todo
 * status + mutating receipts.
 *
 * OBSERVE-ONLY FIRST (the same ladder as todo 6f8b52b7 / PR #1548): the
 * wiring at the machine-wake seam records the loop_metrics kinds
 * owner_status_proxy_mismatch / rate_premise_inconsistent — metric only,
 * never a rewrite, never a retry, never a block. Enforcement is a LATER
 * decision on the measured rate. The "Needs you" side is NOT a detector: it
 * is the harness-computed union (open owner cards + todos/plan steps blocked
 * on an owner action + approved cards whose follow-up action has not landed)
 * rendered at the supervisor status surfaces — the model may add words, never
 * drop items.
 *
 * Kill switch OWNER_STATUS_PROXY_MISMATCH_DISABLED=1 (detector leg only —
 * the union render is not switchable).
 */
import prisma from '../../../config/database';
import { readPremisesLoose } from '../platform/kpi-of-record';
import { isCounterQuestionRow, INLINE_OQ_ID_RE } from '../platform/owner-questions';
import { computeNeedsYouUnion, classifyOwnerGatedRows, type OwnerGatedRow, type OwnerGateCardView } from '../platform/owner-needs-you';

// The Needs-you UNION (computeNeedsYouUnion / needsYouSummary /
// needsYouDirectiveLine / classifyOwnerGatedRows / loadNeedsYouUnion) lives in
// platform/owner-needs-you.ts — the shared leaf every render surface reads
// (the deterministic card path is hygienically isolated from chat-agent
// imports, pinned by project-status.service.test.ts).

// ── The proxy-mismatch detector (pure) ──────────────────────────────────────

export type OwnerStatusProxyPair = 'best_leg_rate' | 'open_card_count' | 'lane_run_active';

/** A register premise flattened for the note-side comparison (readPremisesLoose shape + the goal view's bar/manifest/compareTo). */
export interface OwnerStatusPremiseView {
  key: string;
  value: number;
  unit?: string;
  bar?: number;
  manifest?: string;
  compareTo?: string;
  kind?: string;
  observed?: number;
}

/** A todo row the note may name with progress words. */
export interface OwnerStatusTodoView {
  id: string;
  title: string;
  status: string;
  startedAt?: string | null;
}

/** The ledger view the detector compares a note against. */
export interface OwnerStatusLedgerView {
  openCards: number;
  ownerBlockedItems: number;
  answeredUnlandedItems: number;
  premises: OwnerStatusPremiseView[];
  todos: OwnerStatusTodoView[];
  /** mutating tool calls THIS run made (parts) — an honest "started" when the run itself mutated something */
  mutatingToolCalls: number;
}

export interface OwnerStatusMismatch {
  kind: 'owner_status_proxy_mismatch' | 'rate_premise_inconsistent';
  proxyPair: OwnerStatusProxyPair;
  /** the offending phrase, as delivered (caller clips to 100) */
  claim: string;
  /** why it is proxy-derived, with the ledger numbers (caller clips to 160) */
  evidence: string;
}

/** True when the owner-status proxy detector leg is switched off (the union render is NOT switchable). */
export function ownerStatusProxyDisabled(): boolean {
  return process.env.OWNER_STATUS_PROXY_MISMATCH_DISABLED === '1';
}

/** A claim that nothing needs the owner — "Nothing needs the owner", "Needs you: nothing", "zero open questions account-wide", "no owner action pending". */
export const NOTHING_NEEDS_OWNER_RE =
  /\b(?:nothing(?:\s+[a-z-]+){0,3}?\s+(?:needs?\s+(?:the\s+)?owner|waits?\s+on\s+(?:the\s+owner|you))|needs?\s+you\s*:?\s*\*{0,2}\s*nothing|zero\s+open\s+(?:owner\s+)?questions?|no\s+open\s+(?:owner\s+)?questions?\s+(?:account-wide|at\s+all|anywhere|right\s+now)|(?:nothing|no\s+one|nobody)\s+(?:is\s+)?waiting\s+on\s+(?:the\s+owner|you)|nothing\s+(?:is\s+)?waiting\s+for\s+(?:the\s+owner|you)|no\s+owner\s+action\s+(?:is\s+)?(?:pending|needed|required))\b/i;

/** Bar-met language — "the bar the owner set this morning is now met", "bar is MET", "met the target". */
export const BAR_MET_RE =
  /\b(?:bar|target)\b[^.\n!?]{0,80}?(?:\s(?:is|was|now|already|'s)\s){0,3}(?:met|hit|reached|achieved)\b|\b(?:met|hit|reached|cleared)\s+the\s+(?:bar|target)\b/i;

/** A window named near a rate claim — the honest form (ff3bc329's fix): the note names which window the number came from. */
const WINDOW_NAMED_RE =
  /\b(?:active[- ]window|burst|window|full[- ]window|end[- ]to[- ]end|wall[- ]clock|e2e|in\s+(?:one|a|the|about)\s*\d+(?:\.\d+)?\s*[-\s]?min|\d+(?:\.\d+)?\s*[-\s]?min(?:ute)?s?\s+(?:window|batch|play|burst))\b/i;

/** "22 verified decrypts in one 26-min batch", "79 plays in 29 minutes" — a count over a window, the like-for-like evidence inside the note itself. */
const COUNT_OVER_WINDOW_RE =
  /(\d{1,6})\s+(?:verified\s+|confirmed\s+|decrypted\s+|staged\s+|real\s+)?[a-z-]{0,20}?\s?(?:clips?|plays?|decrypts?|items?|runs?|messages?|batches?)\s+[^.\n]{0,40}?\bin\s+(?:one\s+|a\s+|the\s+|about\s+)?(\d+(?:\.\d+)?)\s*[-\s]?min/i;

/** "N clips/hr" / "N clips per hour" — a typed rate claim. */
const RATE_CLAIM_RE = /(\d+(?:\.\d+)?)\s+([a-z][a-z0-9_-]{1,24})\s*\/\s*(hr|hour|day|week|min|minute|24h)\b|(\d+(?:\.\d+)?)\s+([a-z][a-z0-9_-]{1,24})\s+per\s+(hour|day|week|minute)\b/gi;

/** Progress words that claim work STARTED. */
export const STARTED_WORDS_RE = /\b(started|underway|mid-run|midrun|in\s+flight|kicked\s+off|now\s+running|executing|in\s+progress)\b/i;

/** Mutating tools — an honest "started" when THIS run called one (the todo's "mutating receipt this run" leg). */
const MUTATING_TOOL_RE =
  /^(git_commit|git_push|open_pull_request|merge_pull_request|send_chat_message|start_coding_session|stop_run|todo_update|todo_create|goal_update|goal_create|goal_premise_set|update_schedule|schedule_message|cancel_schedule|store_secret|dispatch_platform_task|notify_user|answer_owner_question|answer_chat_question|approve_request|set_chat_autonomy|update_project|create_project|create_document|update_document|create_canvas|asana_create_task|asana_update_task)$/i;

/** How many mutating tool calls the run's parts carry. Pure. */
export function mutatingToolCallsInParts(parts: Array<{ type?: string; name?: string }> | undefined): number {
  return (parts ?? []).filter((p) => p?.type === 'tool_call' && typeof p.name === 'string' && MUTATING_TOOL_RE.test(p.name)).length;
}

/** Sentence split that keeps decimals ("103.9") intact — only a period BEFORE whitespace/newline ends a sentence. */
function sentences(t: string): string[] {
  return t
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const RATE_PER_NORM: Record<string, string> = { hr: 'hour', hour: 'hour', min: 'minute', minute: 'minute', '24h': 'day', day: 'day', week: 'week' };

function stem(w: string): string {
  const s = w.toLowerCase();
  if (/ies$/.test(s) && s.length > 4) return s.slice(0, -3) + 'y';
  if (/(?:ches|shes|xes|zes)$/.test(s) && s.length > 5) return s.slice(0, -2);
  if (/s$/.test(s) && s.length > 4) return s.slice(0, -1);
  return s;
}

const TITLE_STOPWORDS = new Set([
  'this', 'that', 'with', 'from', 'they', 'have', 'been', 'will', 'your', 'yours', 'the', 'and', 'for', 'are', 'was', 'were', 'into', 'them', 'then', 'when', 'what', 'which', 'their', 'said', 'says', 'just', 'now', 'all', 'each', 'once', 'over', 'under', 'about', 'after', 'before', 'while', 'there', 'here', 'some', 'more', 'most', 'owner', 'audit', 'item', 'lane', 'note', 'wake', 'sweep', 'next', 'since', 'today', 'report', 'whether', 'while', 'very', 'much', 'many', 'both', 'four', 'three', 'five', 'eight', 'work', 'work',
]);

function tokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9-]+/)
      .map(stem)
      .filter((w) => w.length >= 4 && !TITLE_STOPWORDS.has(w) && !/^\d/.test(w)),
  );
}

/** Normalized "<noun>/<per>" unit key: "clips/hr" and "clips per hour" and "clips/24h" → "clip/hour" / "clip/day". '' when the unit carries no rate denominator. */
export function normalizeRateUnit(unit: string): string {
  const m = /^([a-z0-9_-]+)\s*(?:\/|per\s+)\s*(hr|hour|day|week|min|minute|24h)$/i.exec(String(unit ?? '').trim());
  if (!m) return '';
  return `${stem(m[1])}/${RATE_PER_NORM[m[2].toLowerCase()]}`;
}

interface RateClaim {
  value: number;
  unitKey: string;
  phrase: string;
  index: number;
}

/** All typed rate claims in a note. Pure. */
export function rateClaims(text: string): RateClaim[] {
  const t = String(text ?? '');
  const out: RateClaim[] = [];
  RATE_CLAIM_RE.lastIndex = 0;
  for (const m of t.matchAll(RATE_CLAIM_RE)) {
    const value = Number(m[1] ?? m[4]);
    const noun = String(m[2] ?? m[5] ?? '');
    const per = String(m[3] ?? m[6] ?? '').toLowerCase();
    if (!Number.isFinite(value) || !noun) continue;
    out.push({ value, unitKey: `${stem(noun)}/${RATE_PER_NORM[per]}`, phrase: m[0], index: m.index ?? 0 });
  }
  return out;
}

function sameRate(a: number, b: number): boolean {
  return Math.abs(a - b) <= Math.max(0.05, Math.abs(b) * 0.005);
}

/** The register's like-for-like verdict for a target premise: met only when the compareTo leg's observed/value clears the bar. */
function likeForLikeMet(target: OwnerStatusPremiseView, byKey: Map<string, OwnerStatusPremiseView>): { met: boolean; legValue?: number; legKey?: string } {
  if (!Number.isFinite(Number(target.bar))) return { met: false };
  const leg = target.compareTo ? byKey.get(target.compareTo) : undefined;
  if (!leg) return { met: false };
  const legValue = Number.isFinite(Number(leg.observed)) ? Number(leg.observed) : Number(leg.value);
  if (!Number.isFinite(legValue)) return { met: false };
  return { met: legValue >= Number(target.bar), legValue, legKey: leg.key };
}

/** A rate phrase that names the BAR itself ("the 100 clips/hr target", "target of 100 clips/hr") — a threshold mention, never a measured-value claim (the kpi-of-record isThresholdMention shape). */
function isThresholdMention(t: string, c: RateClaim): boolean {
  const pre = t.slice(Math.max(0, c.index - 24), c.index);
  const post = t.slice(c.index + c.phrase.length, c.index + c.phrase.length + 16);
  return /\b(?:target|bar|threshold|quota|goal)\s*(?:of\s+|:\s*)?$/i.test(pre) || /^\s*(?:target|bar|threshold|quota|goal)\b/i.test(post);
}

/**
 * Pure detector: the proxy-derived owner-status claims in a supervisor note,
 * against the ledger view. One entry per offending claim (never a rewrite —
 * the wiring records a metric only).
 */
export function detectOwnerStatusProxyMismatches(text: string, ledger: OwnerStatusLedgerView): OwnerStatusMismatch[] {
  const t = String(text ?? '');
  if (!t.trim()) return [];
  const out: OwnerStatusMismatch[] = [];
  const union = computeNeedsYouUnion({
    openCards: ledger.openCards,
    ownerBlocked: ledger.ownerBlockedItems,
    answeredUnlanded: ledger.answeredUnlandedItems,
  });

  // ── Proxy pair 2: open-card count → work blocked on an owner action ──
  // "Nothing needs the owner" counted OPEN CARDS while an approved-but-never-
  // landed action (or an owner-gated todo) sat on the board.
  const needsNothing = NOTHING_NEEDS_OWNER_RE.exec(t);
  if (needsNothing && union.total > 0) {
    out.push({
      kind: 'owner_status_proxy_mismatch',
      proxyPair: 'open_card_count',
      claim: needsNothing[0],
      evidence: `needs-you union is ${union.total} (open cards ${union.openCards}, owner-blocked ${union.ownerBlocked}, approved-not-landed ${union.answeredUnlanded}) — "nothing needs the owner" was counted from open cards alone`,
    });
  }

  // ── Proxy pair 1: best-leg rate value → end-to-end/daily rate vs a target ──
  const byUnit = new Map<string, OwnerStatusPremiseView[]>();
  const byKey = new Map<string, OwnerStatusPremiseView>();
  for (const p of ledger.premises ?? []) {
    if (!p || typeof p.key !== 'string' || !Number.isFinite(Number(p.value))) continue;
    byKey.set(p.key, p);
    const u = normalizeRateUnit(String(p.unit ?? ''));
    if (u) {
      const arr = byUnit.get(u) ?? [];
      arr.push(p);
      byUnit.set(u, arr);
    }
  }
  const claims = rateClaims(t).slice(0, 6);
  // The note's own like-for-like evidence — NOTE-scoped, not sentence-scoped:
  // the specimen's claim ("103.9 clips/hr") and its contradiction ("22
  // verified decrypts in one 26-min batch") sit in DIFFERENT sentences (the
  // headline vs the table row), so the evidence is looked up per claim over
  // the whole note (first window that does not contain the claim phrase —
  // the claim's own sentence names the target, not the evidence).
  const noteWindows: Array<{ phrase: string; count: number; minutes: number }> = [];
  for (const s of sentences(t)) {
    const cow = COUNT_OVER_WINDOW_RE.exec(s);
    if (cow) noteWindows.push({ phrase: cow[0].trim(), count: Number(cow[1]), minutes: Number(cow[2]) });
  }
  for (const c of claims) {
    const sameUnit = byUnit.get(c.unitKey) ?? [];
    if (!sameUnit.length) continue; // no registered rate of this unit — nothing to compare like-for-like
    const matched = sameUnit.find((p) => sameRate(c.value, Number(p.value)) || sameRate(c.value, Number(p.observed)));
    const sent = sentences(t).find((s) => s.includes(c.phrase)) ?? '';
    const cow = noteWindows.find((w) => !sent.includes(w.phrase) && w.count > 0 && w.minutes > 0);
    const implied = cow ? (cow.count / cow.minutes) * 60 : NaN;
    const sentenceNamesWindow = WINDOW_NAMED_RE.test(sent);
    const barMet = BAR_MET_RE.test(sent);
    if (!matched) {
      // The note implies a rate the register does not hold (the 162.9-plays-
      // presented-as-clips shape, specimen f561c547).
      out.push({
        kind: 'rate_premise_inconsistent',
        proxyPair: 'best_leg_rate',
        claim: c.phrase,
        evidence: `no registered premise of unit ${c.unitKey} holds ${c.value} (register: ${sameUnit.slice(0, 3).map((p) => `${p.key}=${p.observed ?? p.value}`).join(', ')})`,
      });
      continue;
    }
    if (barMet) {
      const target = sameUnit.find((p) => Number.isFinite(Number(p.bar)) || p.kind === 'kpi' || p.key.toLowerCase().startsWith('target:'));
      if (!target) {
        out.push({
          kind: 'owner_status_proxy_mismatch',
          proxyPair: 'best_leg_rate',
          claim: c.phrase,
          evidence: `"met" claim with no target premise of unit ${c.unitKey} on the register — the bar has no typed holder (specimen 33e56bf7)`,
        });
      } else {
        const verdict = likeForLikeMet(target, byKey);
        if (!verdict.met) {
          out.push({
            kind: 'owner_status_proxy_mismatch',
            proxyPair: 'best_leg_rate',
            claim: c.phrase,
            evidence: `bar-met claim while the like-for-like register comparison is NOT met: ${target.key} bar=${target.bar} vs ${verdict.legKey}=${verdict.legValue}`,
          });
        }
      }
      // no continue — the in-note implied-rate contradiction below is an
      // INDEPENDENT finding (specimen 33e56bf7 carried both: a bar-met claim
      // with no typed holder AND a 22-in-26-min parenthetical implying 50.8/hr)
    }
    // Window substitution: the claimed number is a window-scoped leg presented
    // without its window while a like-for-like sibling exists (specimen d4a3eb4e).
    const manifest = String(matched.manifest ?? '').toLowerCase();
    const windowScoped = manifest.includes('active') || manifest.includes('burst');
    const e2eSibling = sameUnit.some((p) => {
      const m2 = String(p.manifest ?? '').toLowerCase();
      return m2 !== manifest && (m2.includes('e2e') || m2.includes('end-to-end') || m2.includes('full-window') || m2.includes('full window'));
    });
    if (windowScoped && e2eSibling && !sentenceNamesWindow) {
      out.push({
        kind: 'owner_status_proxy_mismatch',
        proxyPair: 'best_leg_rate',
        claim: c.phrase,
        evidence: `quoted ${matched.key} (manifest "${matched.manifest}") without naming its window while a like-for-like leg exists on the register — a burst presented as a sustained rate (specimen d4a3eb4e)`,
      });
      continue;
    }
    if (cow && Number.isFinite(implied) && implied > 0 && !sameRate(c.value, implied) && Math.abs(c.value - implied) / Math.max(implied, c.value) > 0.25) {
      out.push({
        kind: 'owner_status_proxy_mismatch',
        proxyPair: 'best_leg_rate',
        claim: c.phrase,
        evidence: `the note's own count-over-window ("${cow.phrase}") implies ${Math.round(implied * 10) / 10}/hour, not ${c.value}/hour (specimen 33e56bf7: 22 in 26 min = 50.8/hr)`,
      });
    }
  }

  // ── Proxy pair 3: lane run active → todo status + mutating receipts ──
  // "fixes started … mid-run" while the todo row reads pending/startedAt null.
  if ((ledger.mutatingToolCalls ?? 0) === 0) {
    for (const s of sentences(t)) {
      if (!STARTED_WORDS_RE.test(s)) continue;
      const sTokens = tokens(s);
      const named = (ledger.todos ?? []).filter((td) => {
        if (!td || typeof td.status !== 'string') return false;
        const idHit = new RegExp(`\\b${td.id.slice(0, 8)}\\b`, 'i').test(s);
        if (idHit) return true;
        const tTokens = tokens(String(td.title ?? ''));
        let shared = 0;
        for (const w of sTokens) if (tTokens.has(w)) shared++;
        return shared >= 2;
      });
      if (!named.length) continue;
      const unStarted = named.filter((td) => !['in_progress', 'done', 'dropped'].includes(td.status));
      if (named.length && unStarted.length === named.length) {
        out.push({
          kind: 'owner_status_proxy_mismatch',
          proxyPair: 'lane_run_active',
          claim: s.slice(0, 100),
          evidence: `"started" claim while every matching todo is un-started: ${unStarted.slice(0, 2).map((td) => `${td.id.slice(0, 8)} [${td.status}] startedAt=${td.startedAt ? 'set' : 'null'}`).join(', ')}; this run made no mutating tool call (specimen eb4f8455)`,
        });
        break; // one row per note for this pair
      }
    }
  }
  return out.slice(0, 8);
}

// ── The ledger loader (async grounding — the unbacked-claim.ts shape) ───────

/**
 * Load the ledger view for a supervisor chat's owner-scope: open owner cards,
 * owner-gated blocked todos/goals classified by gate state, the recent todos a
 * note may name, and the goal registers in scope. Returns null on ANY read
 * error (fail-closed: the wiring records nothing, never flags on a DB hiccup).
 */
export async function loadOwnerStatusLedgerView(input: {
  userId: string;
  /** a project supervisor's project scope; null = the owner's whole account (fleet) */
  projectId?: string | null;
  parts?: Array<{ type?: string; name?: string }> | undefined;
}): Promise<OwnerStatusLedgerView | null> {
  // Per-leg fail-soft: EVERY read is its own async IIFE with an internal
  // catch, so a partial prisma surface (a test mock, a degraded client) can
  // never mint an orphaned rejection — a bare Promise.all over direct calls
  // lets one leg's rejection go unobserved when a sibling throws synchronously
  // while the array is being built (the W6 replay suites caught exactly that).
  const leg = <T,>(body: () => Promise<T>, fallback: T): Promise<T> =>
    (async () => {
      try {
        return await body();
      } catch {
        return fallback;
      }
    })();
  try {
    const todoScope = input.projectId ? { projectId: input.projectId } : { userId: input.userId };
    const goalScope = todoScope;
    const [openCards, gatedTodos, gatedGoals, recentTodos, goalRows] = await Promise.all([
      leg(async () => {
        if (!input.projectId) return prisma.ownerQuestion.count({ where: { userId: input.userId, status: 'open' } });
        const chats = await prisma.crossModelChat.findMany({ where: { projectId: input.projectId }, select: { id: true } });
        return chats.length ? prisma.ownerQuestion.count({ where: { status: 'open', chatId: { in: chats.map((c: any) => c.id) } } }) : 0;
      }, 0),
      leg(async () => (await prisma.projectTodo.findMany({
        where: { ...todoScope, status: 'blocked', OR: [{ gateQuestionId: { not: null } }, { blockKind: 'owner' }] },
        select: { id: true, title: true, status: true, startedAt: true, gateQuestionId: true, blockedReason: true },
        take: 60,
      })) as Array<OwnerStatusTodoView & { gateQuestionId: string | null; blockedReason: string | null }>, []),
      leg(async () => (await prisma.projectGoal.findMany({
        where: { ...goalScope, status: 'blocked', OR: [{ gateQuestionId: { not: null } }, { blockKind: 'owner' }] },
        select: { id: true, title: true, gateQuestionId: true, blockedReason: true },
        take: 60,
      })) as Array<{ id: string; title: string; gateQuestionId: string | null; blockedReason: string | null }>, []),
      leg(async () => (await prisma.projectTodo.findMany({
        where: todoScope,
        orderBy: { updatedAt: 'desc' },
        take: 60,
        select: { id: true, title: true, status: true, startedAt: true },
      })) as OwnerStatusTodoView[], []),
      leg(async () => (await prisma.projectGoal.findMany({
        where: goalScope,
        select: { premises: true },
        take: 60,
      })) as Array<{ premises: unknown }>, []),
    ]);
    // Classify the gated rows with the SHARED classifier (the same doctrine
    // the project card renders, 2026-09-15): open gate → subsumed by its open
    // card; answered gate still blocking → approved-but-never-landed; no
    // resolvable gate → the team's own rule, not an owner item.
    const gatedRows: OwnerGatedRow[] = [...(gatedTodos ?? []), ...(gatedGoals ?? [])].filter((r) => !!r) as unknown as OwnerGatedRow[];
    const gateIds = new Set<string>();
    for (const r of gatedRows) {
      if (r.gateQuestionId) gateIds.add(String(r.gateQuestionId));
      INLINE_OQ_ID_RE.lastIndex = 0;
      const inline = INLINE_OQ_ID_RE.exec(String(r.blockedReason ?? ''))?.[0];
      if (inline) gateIds.add(inline);
    }
    const cardsById = new Map<string, OwnerGateCardView>();
    if (gateIds.size) {
      const rows = await leg(async () => prisma.ownerQuestion.findMany({
        where: { id: { in: [...gateIds] } },
        select: { id: true, status: true, answer: true, chosenOption: true, answeredBy: true },
      }), [] as any[]);
      for (const r of rows as any[]) cardsById.set(String(r.id), r);
    }
    const classified = classifyOwnerGatedRows(gatedRows, cardsById);
    const premises = (goalRows ?? []).flatMap((g) => readPremisesLoose(g?.premises)).slice(0, 400);
    return {
      openCards: Number(openCards) || 0,
      ownerBlockedItems: classified.ownerBlocked.length,
      answeredUnlandedItems: classified.answeredUnlanded.length,
      premises,
      todos: recentTodos ?? [],
      mutatingToolCalls: mutatingToolCallsInParts(input.parts),
    };
  } catch {
    return null;
  }
}

