/**
 * evidence-ledger.ts — the authorship-side EVIDENCE LIST for machine-wake
 * notes (feedback a84cc306 — "Wake-note phantom citations recur across
 * supervisors — authorship-side prevention follow-on").
 *
 * The failure (recurrence ledger 2026-09-15: ticket 0e2fcb6f hit 2 occurrences
 * in ~7 minutes across TWO different supervisor seats; family 8e88474e /
 * 5448a836 / 3ed139cd / b216475a): machine-wake rule 6 demands the authoring
 * model "build this run's EVIDENCE LIST — every id a tool result ACTUALLY
 * returned this run" and copy citations verbatim from it — but the harness
 * never SHOWED the model that consolidated list. Across a 24-step sweep (each
 * tool result display-truncated at 8000 chars, mid-run compaction rewriting
 * earlier context) the list exists only as an unaided-memory reconstruction,
 * so the model generates shape-conformant 8-hex ids instead of copying real
 * ones. The pre-delivery guard (guardMachineWakeFinalAnswer) contains those
 * strikes; this ledger attacks PRODUCTION: the harness maintains the list
 * itself and re-injects it every turn (agent.ts, clock-note idiom — transient
 * system note, spliced post-turn), so at authorship time the copy source is
 * in front of the model and survives compaction.
 *
 * What it is NOT: not a new restriction and not an audit — the guard's
 * exoneration semantics are unchanged (an id visible in any tool output or
 * existing in its store still exonerates). A recall miss here just means the
 * status quo (cite from verbatim-visible text, or write "(id not captured)").
 * PRECISION beats recall: a wrong-FAMILY ledger entry would teach a
 * mislabeled citation that the verifier strikes as a phantom (rule 5), so the
 * harvest maps are deliberately conservative (below).
 *
 * CODING-LANE variant (ticket 5036d072, 2026-09-18): the ledger used to be
 * gated OFF for coding-profile machine runs ("their finals ride the
 * run-evidence-guard claim-manifest idiom") — but that is DETECTION, not
 * prevention, and the detection-only coding lanes were the FM-2.6 recidivists
 * (strike telemetry 2026-09-18: 061b4980 ×13, 9a9911bb ×20, d0597e02 ×34 …).
 * Built with lane:'coding', the SAME machinery additionally harvests the
 * receipt families coding finals cite — 'commit' shas from
 * git_commit/git_push/merge_pull_request/check_ci success shapes and 'pr'
 * numbers from open_pull_request/merge_pull_request — keyed on the exact
 * anchors run-receipts.ts uses to call those calls ok (failure shapes never
 * match; run_command stays excluded as sha-dense prior-run laundering), and
 * renders with claims-block wording instead of the rule-6 reference.
 *
 * Pure leaf (no imports) so it is unit-testable without the prisma/graph —
 * same discipline as machine-wake.ts / terminal-stop.ts / agent-send-header.ts.
 */

/** Citation families the wake-note contract labels (rule 5/6 vocabulary),
 *  plus the coding-lane receipt families (ticket 5036d072): 'commit' = git
 *  shas a git_commit/git_push/merge_pull_request/check_ci receipt returned;
 *  'pr' = pull-request numbers from open_pull_request/merge_pull_request. */
export type LedgerFamily = 'msg' | 'sched' | 'chat' | 'ticket' | 'goal' | 'todo' | 'oq' | 'hook' | 'commit' | 'pr';

/**
 * Which lane the ledger serves: 'chat' machine wakes (default) harvest only
 * the fleet-id families; 'coding' machine runs additionally harvest git/PR
 * receipt ids via CODING_RECEIPT_ANCHORS and get claims-block render wording.
 */
export type LedgerLane = 'chat' | 'coding';

/** Most ids listed per family (overflow renders as "+N more"). Freshest kept. */
export const LEDGER_MAX_LISTED_PER_FAMILY = 8;

/** Position-0 literal the injected note starts with (tests + grep anchor). */
export const EVIDENCE_LEDGER_PREFIX = '[EVIDENCE LEDGER';

/** Families whose ids render as their first 8 hex chars (the citation idiom). */
const FAMILY_ORDER_CHAT: LedgerFamily[] = ['msg', 'sched', 'chat', 'ticket', 'goal', 'todo', 'oq', 'hook'];
/** Coding lane: receipt families FIRST — they are what coding finals cite (push/pr/deploy/file_change claims). */
const FAMILY_ORDER_CODING: LedgerFamily[] = ['commit', 'pr', 'ticket', 'goal', 'todo', 'sched', 'oq', 'chat', 'msg', 'hook'];

/**
 * Tools whose BARE "id" fields map unambiguously to one family. EXCLUDED on
 * purpose: goal_list / goal_get / goal_update (goal rows inline todos AND
 * dependency id arrays — a bare-"id" harvest would mislabel todo ids as
 * 'goal', and a wrong-family citation is a phantom strike); get_chat_status
 * (shape carries no reliable top-level entity id); run_command / check_ci /
 * github_* (sha-dense free text — 8-hex tokens there are commits, not
 * citable fleet ids); search_memory / read_document (content blobs quoting
 * PRIOR runs' ids — harvesting them would launder stale citations into this
 * run's ledger).
 */
const BARE_ID_TOOL_FAMILY: Record<string, LedgerFamily> = {
  list_chats: 'chat',
  get_chat_messages: 'msg',
  list_schedules: 'sched',
  schedule_get: 'sched',
  schedule_message: 'sched',
  update_schedule: 'sched',
  cancel_schedule: 'sched',
  list_feedback: 'ticket',
  get_feedback: 'ticket',
  update_feedback: 'ticket',
  todo_list: 'todo',
  todo_get: 'todo',
  todo_create: 'todo',
  todo_update: 'todo',
  hook_list: 'hook',
  hook_subscribe: 'hook',
  hook_update: 'hook',
};

/**
 * Tools whose NAMED family-carrying fields are harvested (in addition to all
 * BARE_ID tools). goal_* tools land here: their named goalId/todoId fields
 * are family-self-labeling even though their bare "id" fields are ambiguous.
 * oq_ values are self-identifying everywhere in this set.
 */
const NAMED_ONLY_TOOLS = new Set([
  'goal_list', 'goal_get', 'goal_create', 'goal_update',
  'send_chat_message', 'create_chat', 'get_chat_status', 'start_coding_session',
  'list_owner_questions', 'flag_owner_question', 'answer_owner_question',
  'file_feedback', 'dispatch_platform_task',
  'move_chat', 'rename_chat', 'archive_chat', 'hook_unsubscribe',
  'unsubscribe_drive_watch',
]);

/** Named JSON fields → family (family-self-labeling; applied to every tool in the harvest set). */
const NAMED_FIELD_FAMILY: Record<string, LedgerFamily> = {
  messageid: 'msg',
  lastmessageid: 'msg',
  chatid: 'chat',
  sessionid: 'chat', // sessionId IS the chat id on every caller (agent.ts receipt comment)
  parentchatid: 'chat',
  scheduleid: 'sched',
  ticketid: 'ticket',
  goalid: 'goal',
  todoid: 'todo',
  questionid: 'oq',
  hookid: 'hook',
};

/** Prose confirmations a few create-tools return instead of JSON rows. */
const PROSE_ANCHORS: Array<[RegExp, LedgerFamily]> = [
  [/\bCreated chat ([0-9a-f]{8}(?:-[0-9a-f]{4}){0,4}[0-9a-f]{0,12})\b/gi, 'chat'],
  [/\bCreated goal ([0-9a-f]{8}(?:-[0-9a-f]{4}){0,4}[0-9a-f]{0,12})\b/gi, 'goal'],
  [/\bCreated todo ([0-9a-f]{8}(?:-[0-9a-f]{4}){0,4}[0-9a-f]{0,12})\b/gi, 'todo'],
];

/**
 * CODING-LANE receipt anchors (ticket 5036d072) — consulted ONLY when the
 * ledger is built with lane:'coding'. Each key is a receipted coding tool;
 * each regex keys on that tool's EXACT success shape (the same anchors
 * run-receipts.ts uses to call the call ok), so an id is harvested only when
 * the tool actually returned it: the failure shapes (COMMIT BLOCKED /
 * COMMIT REFUSED, MERGE UNCONFIRMED, "PR blocked: …", "check_ci failed: …")
 * never match. run_command stays EXCLUDED here too — sha-dense free text
 * quoting prior runs launders stale citations into this run's ledger.
 * merge_pull_request carries BOTH the PR number and the merge sha (two
 * capture groups). check_ci's head sha is the API-confirmed remote commit:
 * GitHub answered CI FOR that sha (an invented sha gets the "may not be on
 * the remote yet" error shape instead). 'commit' values normalize to first-8
 * hex through the named machinery; 'pr' values render as the bare number
 * (the claims-block pr-ref idiom).
 */
const CODING_RECEIPT_ANCHORS: Record<string, Array<{ re: RegExp; captures: Array<{ group: number; family: 'commit' | 'pr' }> }>> = {
  git_commit: [{ re: /\[[\w./-]+ ([0-9a-f]{7,40})\]/g, captures: [{ group: 1, family: 'commit' }] }],
  git_push: [{ re: /Pushed \S+ to GitHub[\s\S]{0,240}?\bsha ([0-9a-f]{7,40})\b/g, captures: [{ group: 1, family: 'commit' }] }],
  open_pull_request: [{ re: /^Opened PR #(\d{1,10}): \S+/gm, captures: [{ group: 1, family: 'pr' }] }],
  merge_pull_request: [{
    re: /^MERGED [\w.-]+\/[\w.-]+#(\d{1,10}) \(squash sha ([0-9a-f]{7,40})\)/gm,
    captures: [{ group: 1, family: 'pr' }, { group: 2, family: 'commit' }],
  }],
  check_ci: [{ re: /^CI for ([0-9a-f]{7,40}): (?:SUCCESS|FAILURE|PENDING|NONE)\b/gm, captures: [{ group: 1, family: 'commit' }] }],
};

/** "field": "value" pairs, field names matched case-insensitively. */
const FIELD_VALUE_RE = /"([A-Za-z]+)"\s*:\s*"([^"]{1,80})"/g;

/** oq_<hex> owner-question ids are self-identifying (the fleet's oq_ idiom). */
const OQ_VALUE_RE = /\boq_[0-9a-f]{8,}\b/gi;

/** Hex/uuid id shape: 8+ hex with optional uuid dash grouping. */
const HEX_ID_RE = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){0,4}[0-9a-f]{0,12}$/i;

export interface EvidenceLedger {
  /** Feed one executed tool result (the FULL model-facing text, not the display slice). Never throws. */
  ingest(toolName: unknown, resultText: unknown): void;
  /** The transient per-turn system note, or null while nothing citable has been observed. */
  render(): string | null;
  /** Test/introspection hook: current per-family id counts. */
  size(): number;
}

function normalizeHexId(raw: string): string | null {
  const v = String(raw || '').trim().toLowerCase();
  if (!HEX_ID_RE.test(v)) return null;
  return v.replace(/-/g, '').slice(0, 8);
}

/**
 * Build the run-local evidence ledger. Insertion-ordered Maps per family;
 * re-ingesting an id moves it to the most-recent end, and render lists the
 * FRESHEST observations (a sweep lane cites its freshest pulls) in
 * observation order — document order within a single tool result.
 */
export function createEvidenceLedger(opts?: { lane?: LedgerLane }): EvidenceLedger {
  const lane: LedgerLane = opts?.lane ?? 'chat';
  const familyOrder = lane === 'coding' ? FAMILY_ORDER_CODING : FAMILY_ORDER_CHAT;
  const buckets = new Map<LedgerFamily, Map<string, string>>();
  const add = (family: LedgerFamily, rendered: string) => {
    if (!rendered) return;
    let bucket = buckets.get(family);
    if (!bucket) {
      bucket = new Map<string, string>();
      buckets.set(family, bucket);
    }
    bucket.delete(rendered); // re-observation moves it to the most-recent end
    bucket.set(rendered, rendered);
  };
  const addHex = (family: LedgerFamily, raw: unknown) => {
    const normalized = normalizeHexId(String(raw ?? ''));
    if (normalized) add(family, normalized);
  };
  /**
   * Family-collision resolution (reviewer N1, feedback a84cc306): a NAMED
   * family-carrying field (goalId, chatId, …) is ground-truth typed; a BARE
   * "id" is a positional heuristic — and todo_get's nested goal brief
   * (goals.service.ts todoView) carries a bare "id" that is a GOAL id, which
   * would otherwise render under the todo family and teach a wrong-family
   * citation the verifier strikes as a phantom. NAMED WINS, in either
   * document order: a bare add is skipped when a named field already owns
   * the id (any family ≠ the bare one), and a named add purges a same-id
   * bare entry sighted earlier (same result or a previous one).
   */
  const namedFamilyById = new Map<string, LedgerFamily>();
  const bareFamilyById = new Map<string, LedgerFamily>();
  const addNamed = (family: LedgerFamily, raw: unknown) => {
    const normalized = normalizeHexId(String(raw ?? ''));
    if (!normalized) return;
    namedFamilyById.set(normalized, family);
    const bareFam = bareFamilyById.get(normalized);
    if (bareFam && bareFam !== family) {
      const bucket = buckets.get(bareFam);
      if (bucket) bucket.delete(normalized);
      bareFamilyById.delete(normalized);
    }
    add(family, normalized);
  };
  const addBare = (family: LedgerFamily, raw: unknown) => {
    const normalized = normalizeHexId(String(raw ?? ''));
    if (!normalized) return;
    const namedFam = namedFamilyById.get(normalized);
    if (namedFam && namedFam !== family) return; // named ground truth owns this id — never mislabel
    bareFamilyById.set(normalized, family);
    add(family, normalized);
  };

  const ingest = (toolName: unknown, resultText: unknown): void => {
    try {
      const tool = typeof toolName === 'string' ? toolName : '';
      const text = typeof resultText === 'string' ? resultText : '';
      if (!tool || !text) return;
      const bareFamily = BARE_ID_TOOL_FAMILY[tool];
      const namedOnly = NAMED_ONLY_TOOLS.has(tool);
      const codingAnchors = lane === 'coding' ? CODING_RECEIPT_ANCHORS[tool] : undefined;
      if (!bareFamily && !namedOnly && !codingAnchors) return; // not a harvest tool — see the maps' comments

      for (const m of text.matchAll(FIELD_VALUE_RE)) {
        const field = (m[1] || '').toLowerCase();
        const value = m[2] || '';
        const namedFamily = NAMED_FIELD_FAMILY[field];
        if (namedFamily) {
          if (namedFamily === 'oq') {
            const oq = /^(oq_[0-9a-f]{8,})/i.exec(value.trim());
            if (oq) add('oq', `oq_${oq[1].slice(3).toLowerCase().replace(/-/g, '').slice(0, 8)}`);
          } else {
            addNamed(namedFamily, value);
          }
        } else if (bareFamily && field === 'id') {
          addBare(bareFamily, value);
        }
      }
      if (namedOnly || bareFamily) {
        for (const m of text.matchAll(OQ_VALUE_RE)) {
          add('oq', `oq_${m[0].slice(3).toLowerCase().replace(/-/g, '').slice(0, 8)}`);
        }
        for (const [re, family] of PROSE_ANCHORS) {
          re.lastIndex = 0;
          for (const m of text.matchAll(re)) addNamed(family, m[1]);
        }
      }
      if (codingAnchors) {
        for (const anchor of codingAnchors) {
          anchor.re.lastIndex = 0;
          for (const m of text.matchAll(anchor.re)) {
            for (const cap of anchor.captures) {
              const raw = m[cap.group];
              if (raw == null) continue;
              // 'commit' rides the named hex machinery (first-8 normalize +
              // wrong-family purge); 'pr' renders as the bare number.
              if (cap.family === 'commit') addNamed('commit', raw);
              else add('pr', String(raw));
            }
          }
        }
      }
    } catch { /* the ledger is best-effort ergonomics — never break a run */ }
  };

  const render = (): string | null => {
    const parts: string[] = [];
    for (const family of familyOrder) {
      const bucket = buckets.get(family);
      if (!bucket || bucket.size === 0) continue;
      const listed = Array.from(bucket.values()).slice(-LEDGER_MAX_LISTED_PER_FAMILY);
      const overflow = bucket.size - listed.length;
      parts.push(`${family} ${listed.join(', ')}${overflow > 0 ? ` (+${overflow} more)` : ''}`);
    }
    if (!parts.length) return null;
    // Same [EVIDENCE LEDGER prefix on both lanes — the transient-message
    // detector and the post-turn splice anchor on it (transient-messages.ts).
    if (lane === 'coding') {
      return (
        `${EVIDENCE_LEDGER_PREFIX} — ids a tool result ACTUALLY returned this run (harness-maintained, refreshed every turn — the receipt list your final answer and its claims block cite): ` +
        parts.join(' · ') +
        `. Cite an id ONLY copied VERBATIM from this ledger or from a tool result visible verbatim in front of you (hex-family ids as their first 8 chars); where you captured no id, write (id not captured) — never remember, reconstruct, lengthen, or invent one.]`
      );
    }
    return (
      `${EVIDENCE_LEDGER_PREFIX} — ids a tool result ACTUALLY returned this run (harness-maintained, refreshed every turn — this IS the EVIDENCE LIST of machine-wake rule 6, built FOR you): ` +
      parts.join(' · ') +
      `. Cite an id ONLY as its first 8 chars copied VERBATIM from this ledger or from a tool result visible verbatim in front of you; where you captured no id, write (id not captured) — never remember, reconstruct, lengthen, or invent one.]`
    );
  };

  const size = (): number => {
    let n = 0;
    for (const bucket of buckets.values()) n += bucket.size;
    return n;
  };

  return { ingest, render, size };
}
