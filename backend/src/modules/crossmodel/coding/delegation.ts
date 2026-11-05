/**
 * Digby Code — delegation plumbing shared by the agent loop (audit: the
 * delegation-upgrade bundle). Pure helpers, unit-tested in delegation.test.ts:
 *
 *  - Worker model tiering (#10): resolveWorkerModel maps a per-delegation tier
 *    override ('premium' | 'helper') or the role's helperTier default onto a
 *    concrete model id.
 *  - Structured worker result envelope: workers END their final message with a
 *    fenced JSON status footer; parseWorkerEnvelope/buildWorkerSummary turn it
 *    into machine-readable status for the plan link + the orchestrator's
 *    summary (prose-only workers keep the old heuristic behavior).
 *  - Delegation resume-notes: renderCompletedDelegationsNote /
 *    spliceCompletedDelegationsNote write a harness note into DISPATCH-phase
 *    checkpoints, positioned BEFORE the in-flight assistant turn so
 *    trimToPreModel (run-state.ts) retains it — a resumed parent sees which
 *    delegations already completed inside the rewound turn and does not
 *    re-dispatch finished work.
 */

import { clipAtBoundary, clippedTail, reportClipV2Disabled, workerReportCapChars, workerReportBudgetSentence, LEGACY_REPORT_CAP } from './report-clip';
import { HELPER_MODEL } from './coding-model';
import { CodingRole, ROLES } from './roles';

// ── Worker model tiering (audit #10) ─────────────────────────────────────────

/**
 * The model a delegated worker runs on. Precedence:
 *   1. an explicit per-delegation override — 'helper' (fast low-cost model) or
 *      'premium' (the orchestrator's full model), from the delegate tool's
 *      `model` param; any OTHER non-empty string passes through as a concrete
 *      model id (programmatic callers);
 *   2. the role's helperTier default (roles.ts) — mechanical roles run on the
 *      helper model unless the orchestrator escalates;
 *   3. the orchestrator's own model.
 *
 * `helperModel` is the instance's coding_helper ROLE model (model-roles
 * config; defaults to the built-in HELPER_MODEL). On Digby Edge the built-in
 * helper (DashScope) has no key, so every helper-tier delegation 401'd until
 * the admin could point the seat at a custom endpoint.
 */
export function resolveWorkerModel(role: CodingRole, requested: string | undefined, orchestratorModel: string, helperModel: string = HELPER_MODEL, seatModel?: string): string {
  if (requested === 'helper') return helperModel;
  if (requested === 'premium') return orchestratorModel;
  if (requested) return requested;
  // Per-role worker seat (harness roadmap item 4, 2026-09-19): the admin's
  // model for this role's seat (model-roles coding_reviewer / coding_architect /
  // coding_explorer, resolved by the caller) — below an explicit request,
  // above the tier rule. '' / undefined = no seat opinion → the tier rule.
  if (seatModel) return seatModel;
  return ROLES[role].helperTier ? helperModel : orchestratorModel;
}

/** Which model-roles seat, if any, speaks for a worker role (harness roadmap
 *  item 4). reviewer + cross_checker share the Reviewer seat (both are second
 *  opinions — independence is the point); planner + architect the Architect
 *  seat; explorer + web_researcher the Explorer seat. coder / editor run the
 *  lane's own model (that IS the coding seat), the verifier the Helper tier. */
export const WORKER_ROLE_SEATS: Partial<Record<CodingRole, 'coding_reviewer' | 'coding_architect' | 'coding_explorer'>> = {
  reviewer: 'coding_reviewer',
  cross_checker: 'coding_reviewer',
  planner: 'coding_architect',
  architect: 'coding_architect',
  explorer: 'coding_explorer',
  web_researcher: 'coding_explorer',
};

/** Per-role worker seats (harness roadmap item 4) — see WORKER_ROLE_SEATS above. */

// ── Read-only role vs file-output brief (ticket 68a36304) ───────────────────

/**
 * Ticket 68a36304 (mishap 2026-09-13, canlegal-bench session): an orchestrator
 * delegated an annotation task to a web_researcher whose brief demanded
 * "WRITE it to the file tmp/annot/out_crit5_a.json using your file-writing
 * tool" — but every read-only role's toolset has no write_file / edit_file /
 * run_command, and its role prompt says "Do NOT modify files". The analysis
 * came back in chat because the persistence step was unexecutable — exactly
 * what the brief's output contract existed to avoid.
 *
 * The dispatch gate (agent.ts ctx.delegate, coding lane only) refuses such
 * briefs UP FRONT with the re-route instead of burning a worker that can only
 * half-deliver.
 *
 * Detection is deliberately NARROW, and every class below is pinned in
 * delegation.68a36304.test.ts (including the adversarial-review round-2
 * corpus). False negatives are SELF-HEALING (the role prompts tell the worker
 * to return the content and say the file was not written); false positives
 * cost one round-trip and the refusal names the re-phrase escape hatch — so
 * the patterns are tuned toward precision:
 *   - Only base/gerund verb forms ("write", "saving") — past participles
 *     ("exported data", "stored credentials", "written to the log") are
 *     adjectives/narration in analysis briefs, not demands.
 *   - A matched demand is SKIPPED when a negator governs it ("do NOT save the
 *     output to a file", "write NOTHING to any file") — a brief that already
 *     instructs inline reporting must not be refused.
 *   - Tool ids only count when GOVERNED by a use-verb ("use write_file") or
 *     the incident's possessive phrasing ("your file-writing tool") — a bare
 *     mention ("grep for write_file callers") is an analysis target.
 */

/** A file-WRITING capability the read-only role lacks, as demanded: tool ids
 *  governed by a use-verb, or the incident's possessive "your file-writing
 *  tool" phrasing. Bare mentions of write_file/edit_file (an analysis brief
 *  ABOUT the tool) must not match. */
const WRITE_TOOL_HINT_RE = /\b(?:(?:use|using|via|with|call|calling|invoke|invoking|run|running)\s+(?:the\s+|your\s+)?(?:write[_-]file|edit[_-]file)\b|your\s+(?:write|writing|file[-\s]writing)\s+tools?\b|file[-\s]writing\s+tools?\b)/i;

/** Writing verbs, BASE + GERUND forms only. Past tense / participles
 *  (wrote/written/saved/stored/exported/emitted/dumped/persisted) are
 *  excluded: in read/report briefs they are adjectives and narration
 *  ("report which fields map to the exported file"), not demands. */
const WRITE_TO_DEST_VERB_SRC = String.raw`\b(?:writes?|writing|saves?|saving|stores?|storing|persists?|persisting|dumps?|dumping|emits?|emitting|exports?|exporting)\b`;
/** …verb → destination preposition → "file"/"disk": "WRITE it to the file tmp/x.json", "save it as a file". */
const VERB_TO_FILE_RE = new RegExp(
  WRITE_TO_DEST_VERB_SRC + String.raw`[^.!?\n]{0,120}?\b(?:to|into|as|onto)\b[^.!?\n]{0,60}?(?:(?:the|a|an|your)\s+)?(?:file|disk)\b`, 'i');
/** …verb → destination preposition → a path-like token: "save the array to out.csv", "persist it to tmp/annot/x.json". */
const OUTPUT_PATH_SRC = String.raw`[\w./~@-]+\.(?:json|jsonl|md|markdown|txt|csv|tsv|ya?ml|xml|html?|log|ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|sql|sh|toml|ini|env)`;
const VERB_TO_PATH_RE = new RegExp(
  WRITE_TO_DEST_VERB_SRC + String.raw`[^.!?\n]{0,120}?\b(?:to|into|as|onto)\b[^.!?\n]{0,60}?(?:(?:the|a|an|your)\s+)?` + OUTPUT_PATH_SRC, 'i');
/** …verb → destination preposition → an artifact NOUN without "file"/extension:
 *  "save the results as a CSV", "export the digest to a text document",
 *  "store the matrix as a new markdown doc" (review round-2 under-detection —
 *  natural demand phrasings that never say "file"). */
const ARTIFACT_NOUN_SRC = String.raw`(?:csv|tsv|json|jsonl|ya?ml|xml|html|spreadsheet|markdown|doc|document|director(?:y|ies))`;
const VERB_TO_ARTIFACT_RE = new RegExp(
  WRITE_TO_DEST_VERB_SRC + String.raw`[^.!?\n]{0,80}?\b(?:to|into|as|onto)\b[^.!?\n]{0,40}?` + ARTIFACT_NOUN_SRC + String.raw`\b`, 'i');
/** Writing verb directly ahead of "file": "write the file", "edit this file". No
 *  participles (adjective collisions) and no "outputs"/"updates" (noun collisions). */
const VERB_FILE_ADJACENT_RE = /\b(?:writes?|writing|saves?|saving|stores?|storing|persists?|persisting|dumps?|dumping|edits?|editing)\s+(?:the|a|an|your|this)?\s*file\b/i;
/** "create a file" / "creates the output file" — adjacency only, so "create a summary of the file" stays clean. */
const CREATE_FILE_RE = /\bcreates?\s+(?:a|an|the|your|one)?\s*(?:new|single|final|output|result|empty|markdown|text|json|csv|data)?\s*file\b/i;

/** A negator in the window BEFORE the match governs the verb: "do NOT save the
 *  output to a file" is a brief instructing INLINE reporting — never refuse it. */
const NEGATOR_BEFORE_RE = /\b(?:not|never|nothing|dont|don't|avoid|without|rather\s+than|instead\s+of)\b/i;
/** …and a negation INSIDE the match voids the demand: "write NOTHING to any file". */
const NEGATOR_INSIDE_RE = /\b(?:nothing|no\s+(?:file|output|artifact))\b/i;
/** Question/research forms govern the verb too (review round-2 FP class):
 *  "research the idiomatic WAY TO persist config to disk" asks ABOUT the
 *  action, it does not demand it. */
const QUESTION_FORM_BEFORE_RE = /\b(?:how|way|ways|means|methods?|approaches?|strateg(?:y|ies)|technique(?:s)?|pattern(?:s)?)\s+to\s*$/i;

/** The first write-demand match in the brief that is NOT negation-governed. */
function findFileWriteDemand(brief: string): RegExpExecArray | null {
  const patterns = [WRITE_TOOL_HINT_RE, VERB_TO_FILE_RE, VERB_TO_PATH_RE, VERB_TO_ARTIFACT_RE, VERB_FILE_ADJACENT_RE, CREATE_FILE_RE];
  for (const re of patterns) {
    const m = re.exec(brief);
    if (!m) continue;
    const before = brief.slice(Math.max(0, m.index - 35), m.index);
    if (NEGATOR_BEFORE_RE.test(before) || NEGATOR_INSIDE_RE.test(m[0]) || QUESTION_FORM_BEFORE_RE.test(before)) continue; // governed → try the next pattern
    return m;
  }
  return null;
}

/**
 * The dispatch-time refusal for a brief that demands a file artifact from a
 * read-only role, or null when the pairing is fine. Writer roles are never
 * gated; the message must be a CONTRACT (learnings 251e9329): it names the
 * mismatch, both re-routes, the read-only escape hatch, and that no budget
 * was consumed.
 */
export function readOnlyFileWriteRefusal(role: CodingRole, task: string): string | null {
  if (ROLES[role].writes) return null; // writer roles can produce file artifacts
  const brief = String(task || '');
  if (!brief) return null;
  const m = findFileWriteDemand(brief);
  if (!m) return null;
  const snippet = brief.slice(Math.max(0, m.index - 40), m.index + m[0].length + 40).replace(/\s+/g, ' ').trim();
  const label = ROLES[role].label;
  return `[DELEGATION REFUSED — read-only role cannot produce a file artifact (ticket 68a36304)] `
    + `The ${label} worker has NO file-writing tools (its role prompt says "Do NOT modify files"), so this brief's file-output requirement cannot be executed. `
    + `Matched demand: "…${snippet}…". `
    + `Re-route: (a) delegate({role:'coder'} or {role:'editor'}) when the deliverable is a file, or (b) keep the ${label} worker for the analysis and write the file yourself from its returned content. `
    + `If the file is only something to READ or analyze (not a deliverable), re-phrase the brief and re-dispatch. `
    + `This refusal ran no worker and consumed no delegation budget.`;
}

// ── Structured worker result envelope ────────────────────────────────────────

export interface WorkerEnvelope {
  status: 'done' | 'blocked' | 'partial';
  blockedReason?: string;
  artifacts?: string[];
}

/**
 * Appended to every DELEGATED worker's role prompt (agent.ts sets
 * opts.resultEnvelope only on the delegate path — runChatWorker's harness
 * pre-step drafts are consumed verbatim and must NOT carry a footer).
 */
export const WORKER_ENVELOPE_INSTRUCTION = `REPORT FORMAT (harness contract): END your final message with a machine-readable status footer — a fenced JSON block AFTER your prose report:
\`\`\`json
{"status": "done", "blockedReason": "<required when status is blocked — why>", "artifacts": ["<file paths / URLs you produced or changed>"]}
\`\`\`
status must be exactly one of: "done" (the assigned task is fully complete), "partial" (some of it is done, the rest is not — say what remains in your prose), or "blocked" (you could not complete it — always set blockedReason). The harness parses this footer to set plan-step status; without it your status is guessed from prose.`;

const ENVELOPE_STATUSES = new Set(['done', 'blocked', 'partial']);
/** Bound the tolerant bare-JSON fallback scan (chars from the end / parse attempts). */
const ENVELOPE_SCAN_TAIL = 6000;
const ENVELOPE_SCAN_ATTEMPTS = 20;

function coerceEnvelope(o: any): WorkerEnvelope | null {
  if (!o || typeof o !== 'object' || Array.isArray(o) || !ENVELOPE_STATUSES.has(o.status)) return null;
  const env: WorkerEnvelope = { status: o.status };
  if (typeof o.blockedReason === 'string' && o.blockedReason.trim()) env.blockedReason = o.blockedReason.trim().slice(0, 500);
  if (Array.isArray(o.artifacts)) {
    const a = o.artifacts
      .filter((x: any) => typeof x === 'string' && x.trim())
      .map((x: string) => x.trim().slice(0, 200))
      .slice(0, 10);
    if (a.length) env.artifacts = a;
  }
  return env;
}

/**
 * Tolerant envelope parse: the LAST JSON object in the text that carries a
 * valid `status` wins — fenced blocks first (the instructed shape), then a
 * bounded bare `{...}` scan of the tail (models sometimes drop the fence).
 * Returns the envelope plus the text WITHOUT it (the prose report), or null
 * when there is no envelope (prose fallback = pre-envelope behavior).
 */
export function parseWorkerEnvelope(text: string): { envelope: WorkerEnvelope; prose: string } | null {
  if (!text || !text.includes('{')) return null;
  // 1) fenced code blocks — scan from the last one back.
  const fences = [...text.matchAll(/```[a-zA-Z]*[ \t]*\r?\n?([\s\S]*?)```/g)];
  for (let i = fences.length - 1; i >= 0; i--) {
    let env: WorkerEnvelope | null = null;
    try { env = coerceEnvelope(JSON.parse(fences[i][1].trim())); } catch { /* not the envelope */ }
    if (env) {
      const start = fences[i].index!;
      return { envelope: env, prose: (text.slice(0, start) + text.slice(start + fences[i][0].length)).trim() };
    }
  }
  // 2) bare JSON object in the tail (bounded brace-matching scan from the end).
  const tail = text.slice(-ENVELOPE_SCAN_TAIL);
  const base = text.length - tail.length;
  let attempts = 0;
  for (let open = tail.lastIndexOf('{'); open !== -1 && attempts < ENVELOPE_SCAN_ATTEMPTS; open = open === 0 ? -1 : tail.lastIndexOf('{', open - 1)) {
    attempts += 1;
    let depth = 0;
    for (let j = open; j < tail.length; j++) {
      if (tail[j] === '{') depth += 1;
      else if (tail[j] === '}') {
        depth -= 1;
        if (depth === 0) {
          let env: WorkerEnvelope | null = null;
          try { env = coerceEnvelope(JSON.parse(tail.slice(open, j + 1))); } catch { /* keep scanning */ }
          if (env) return { envelope: env, prose: (text.slice(0, base + open) + text.slice(base + j + 1)).trim() };
          break;
        }
      }
    }
  }
  return null;
}

export interface WorkerSummary {
  /** What the orchestrator sees as the delegate tool result (prose + status line). */
  summary: string;
  /** Parsed status; 'unknown' = no envelope (prose-only worker). */
  status: 'done' | 'blocked' | 'partial' | 'unknown';
  envelope: WorkerEnvelope | null;
  /** Plan-step blocked flag: the envelope decides; prose falls back to the legacy head-of-summary heuristic. */
  blocked: boolean;
}

/** Legacy prose heuristic (pre-envelope behavior): only the summary HEAD is scanned. */
const BLOCKED_PROSE_RE = /\bblocked\b|could not|unable to|failed to/i;

/**
 * Turn a worker's final text into the orchestrator-facing summary + a
 * machine-readable status. With an envelope: prose (footer stripped) + a
 * harness-written `[WORKER STATUS: …]` line, and the envelope status drives
 * `blocked` regardless of where the word appears in the prose. Without one:
 * exactly the old behavior (raw text sliced to 4000; blocked sniffed from the
 * first 200 chars).
 */
export function buildWorkerSummary(finalText: string, emptyFallback: string, opts?: { cap?: number; restHint?: string }): WorkerSummary {
  // audit 2026-10-08 W2-6 (report-clip.ts): a boundary cut at the worker cap
  // (default 12,000) with a "(… N more chars — <how to read the rest>)" tail,
  // instead of a hard mid-word 4,000 slice. REPORT_CLIP_V2_DISABLED=1 restores it.
  const v2 = !reportClipV2Disabled();
  const cap = v2 ? (opts?.cap ?? workerReportCapChars()) : LEGACY_REPORT_CAP;
  const clip = (t: string): string => {
    if (!v2) return t.slice(0, LEGACY_REPORT_CAP);
    const c = clipAtBoundary(t, cap);
    return c.omitted > 0 ? c.text + clippedTail(c.omitted, opts?.restHint || 'the rest was cut; re-delegate a narrower question if you need it') : c.text;
  };
  const parsed = finalText.trim() ? parseWorkerEnvelope(finalText) : null;
  if (!parsed) {
    const summary = clip(finalText.trim() ? finalText : emptyFallback);
    return { summary, status: 'unknown', envelope: null, blocked: BLOCKED_PROSE_RE.test(summary.slice(0, 200)) };
  }
  const e = parsed.envelope;
  const prose = parsed.prose.trim() || '(worker returned only a status envelope)';
  const artifactsNote = e.artifacts?.length ? ` | artifacts: ${e.artifacts.join(', ').slice(0, 400)}` : '';
  const statusLine = `\n\n[WORKER STATUS: ${e.status}${e.blockedReason ? ` — ${e.blockedReason}` : ''}${artifactsNote}]`;
  return { summary: clip(prose) + statusLine, status: e.status, envelope: e, blocked: e.status === 'blocked' };
}

/** The worker report contract + (W2-6) the report budget sentence. */
export function workerEnvelopeInstruction(): string {
  return reportClipV2Disabled() ? WORKER_ENVELOPE_INSTRUCTION : `${WORKER_ENVELOPE_INSTRUCTION}\n${workerReportBudgetSentence(workerReportCapChars())}`;
}

// ── Delegation resume-notes ──────────────────────────────────────────────────

export interface CompletedDelegation {
  title: string;
  role: string;
  status: string;
  /** The clipped orchestrator-facing summary (prose + a [WORKER STATUS] line). */
  summary: string;
  /**
   * Worktree-relative path of the DURABLE full report (ticket 95210e7e),
   * written at completion by coding/worker-report-store.ts. Present only when
   * the run had a worktree and the write succeeded.
   */
  reportPath?: string;
  /**
   * The worker's FULL final text. Used as the note's own carrier when there is
   * no `reportPath` (chat mode, workspace tools off, or a failed write) — the
   * note is then the only surviving copy, so it carries the report itself
   * instead of a head fragment.
   */
  report?: string;
}

export const COMPLETED_DELEGATIONS_MARKER = '[COMPLETED DELEGATIONS THIS RUN';

/** Chars of a report kept inline when a durable copy exists (the rest is one read_file away). */
export const NOTE_REPORT_HEAD_CHARS = 600;
/** Total chars of report text the note carries inline when there is NO durable copy. */
export const NOTE_REPORT_BUDGET_CHARS = 8_000;

/**
 * Compact harness note listing delegations that finished inside the in-flight turn.
 *
 * TICKET 95210e7e — this note is a RESUME lifeline, not a preview. It used to
 * collapse each verdict to a single 200-char line (`summary.replace(/\s+/g,' ')
 * .slice(0,200)`), which on a real reviewer report is exactly its first
 * sentence; the second half — where an adversarial review puts its findings —
 * was unrecoverable after a deploy restarted the server mid-turn, and the
 * review had to be re-derived by hand against the live system.
 *
 * Now every entry names the DURABLE full report written at completion
 * (`.digby/session/worker-reports/…`) so the resumed turn can read_file the
 * whole thing. When there is no durable copy (no worktree / the write failed),
 * the note carries the report INLINE inside a bounded budget — a truncated
 * body that says so beats a lost verdict.
 */
export function renderCompletedDelegationsNote(items: CompletedDelegation[]): string {
  const shown = items.slice(-12);
  // PER-ENTRY FLOOR (ticket 95210e7e review finding 7): a shared budget with no
  // floor lets the FIRST needy worker spend it all, and every later worker —
  // possibly the reviewer whose findings matter most — collapses to the very
  // 200-char head this ticket exists to remove. Reserve a fair share each, then
  // let an entry that needs less leave its remainder for the rest.
  const floor = Math.max(200, Math.floor(NOTE_REPORT_BUDGET_CHARS / Math.max(1, shown.length)));
  let budget = NOTE_REPORT_BUDGET_CHARS;
  const lines = shown.map(d => {
    const oneLine = d.summary.replace(/\s+/g, ' ').trim();
    const label = `- ${d.title} (${d.role}) → ${d.status}`;
    if (d.reportPath) {
      // The pointer branch still spends context (ticket 95210e7e review
      // finding 1): a 600-char head × 12 entries is 7.2 KB injected into every
      // dispatch checkpoint, so it is charged against the SAME budget as the
      // inline branch. Pre-fix the budget was decremented only inline, and the
      // documented bound was optimistic by ~9 KB.
      const head = oneLine.slice(0, Math.max(0, Math.min(NOTE_REPORT_HEAD_CHARS, budget)));
      budget -= head.length;
      const more = oneLine.length > head.length ? ' …' : '';
      return `${label}: ${head}${more}\n  FULL REPORT (durable): ${d.reportPath} — read_file it for the complete text; do NOT re-derive this work or re-dispatch the worker.`;
    }
    // No durable copy but the caller supplied the report text: this note IS
    // the surviving copy, so it carries the report (bounded by the shared budget).
    if (!d.report?.trim()) return `${label}: ${oneLine.slice(0, 200)}`; // legacy summary-only shape
    // Strip the worker's JSON status footer HERE, not only at the call site
    // (ticket 95210e7e review finding 5): the caller's `workerProse` made the
    // strip real but UNPINNED — mutating it back to the raw text left every
    // test green. Stripping in the renderer makes the guarantee a property of
    // the note, and it is cheap insurance against a future caller that passes
    // the raw final text. (In the same module, so no new import.)
    const body = (parseWorkerEnvelope(d.report)?.prose.trim() || d.report.trim());
    const keep = Math.min(body.length, Math.max(0, budget), Math.max(floor, 0));
    if (keep <= 0) return `${label}: ${oneLine.slice(0, 200)} …(the rest was not retained — no durable copy existed for this worker)`;
    budget -= keep;
    const cut = body.length > keep ? ` …(${body.length - keep} more chars were cut from this note and no durable copy exists — treat the worker's report as PARTIAL)` : '';
    return `${label}: ${body.slice(0, keep)}${cut}`;
  });
  return `${COMPLETED_DELEGATIONS_MARKER} — harness note, not typed by the user] The interrupted turn already ran these delegated workers to COMPLETION; the turn is being regenerated, so their tool results are not in the transcript. Build on these results — do NOT re-dispatch the same work. Entries marked "FULL REPORT (durable)" name a file on disk holding the worker's complete verdict: read_file it before deciding anything the summary does not settle.\n${lines.join('\n')}`;
}

/**
 * Copy of `messages` with the completed-delegations note spliced in BEFORE the
 * in-flight assistant tool_calls turn (same end-scan as run-state.ts
 * trimToPreModel, which cuts from that message on a 'dispatch' resume — the
 * note sits before the cut, so it survives while the turn's tool results are
 * rewound). Used ONLY on dispatch-phase checkpoint snapshots; the live
 * transcript never carries the note. No in-flight turn found → appended (a
 * defensive fallback that cannot occur on the dispatch path by construction).
 */
export function spliceCompletedDelegationsNote(messages: any[], items: CompletedDelegation[]): any[] {
  const out = [...messages];
  if (!items.length) return out;
  const note = { role: 'user', content: renderCompletedDelegationsNote(items) };
  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i];
    if (m?.role === 'tool') continue; // partial results of the in-flight turn
    if (m?.role === 'assistant' && Array.isArray(m?.tool_calls) && m.tool_calls.length) {
      out.splice(i, 0, note);
      return out;
    }
    break; // the first non-tool message from the end decides (trimToPreModel parity)
  }
  out.push(note);
  return out;
}
