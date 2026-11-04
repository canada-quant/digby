/**
 * Trajectory eval suite — case, recording and grader TYPES + the JSON schema
 * (build 2026-10-08 E-1; simplify.md step 3, "the safety net that makes every
 * future guard retirement safe").
 *
 * A CASE is one frozen REAL incident: the input state the agent saw (role,
 * frozen context blocks, the owner / user message or machine wake prompt, the
 * read-tool outputs it could get) plus OUTCOME graders. A RECORDING is one
 * sequence of model outputs for that input (the incident's own outputs, a
 * reference trajectory, or a trial recorded by the live mode). The runner
 * replays a recording — or asks a live seat — through the REAL agent loop
 * (coding/agent.ts runCodingAgent) with mutating tools CAPTURED, never
 * executed, and grades what the run DELIVERED: the final text and the
 * captured side effects. Graders never check the path (which reads, in what
 * order) — only outcomes (a claimed send has a send; an id was seen; the
 * owner's question is answered; a dismissed question is not re-raised).
 *
 * Pure leaf: no imports from the app — the case files are data.
 */

import { z } from 'zod';

/** The seat / chat class the frozen input belongs to (picks the agent profile + role doctrine). */
export const CASE_ROLES = ['fleet_supervisor', 'project_supervisor', 'chat', 'guest_chat', 'checker'] as const;
export type CaseRole = (typeof CASE_ROLES)[number];

/** Who started the turn: an owner on a supervisor chat, a user on a plain chat, or a machine wake. */
export const CASE_TRIGGERS = ['owner_turn', 'user_turn', 'machine_wake'] as const;
export type CaseTrigger = (typeof CASE_TRIGGERS)[number];

/**
 * Matches one captured tool call. Every key is optional except `tool`:
 * - `args`: per-key matchers — a string matches case-insensitively as a
 *   SUBSTRING of that argument (stringified JSON when the arg is an object;
 *   key "*" matches against the whole args JSON); `{ re }` is a regex
 *   (case-insensitive); numbers / booleans match exactly.
 * - `output`: a case-insensitive regex the tool's OUTPUT must match.
 * Lenient on purpose (outcome, not path): "a send to 810c924d" is
 * `{ tool: 'send_chat_message', args: { chatId: '810c924d' } }`.
 */
export interface CallMatcher {
  tool: string | string[];
  args?: Record<string, string | number | boolean | { re: string }>;
  output?: string;
}

interface GraderBase {
  /** Stable id (report rows, judge labels, baselines). Unique within the case. */
  id: string;
  /** One line: what outcome this protects and why (shown on a failure). */
  why: string;
  /** An advisory check is reported but never decides pass / fail. */
  advisory?: boolean;
}

export type GraderSpec =
  /** The final may claim the action only when a matching call was captured (claimed send ⇒ a send). */
  | (GraderBase & { kind: 'claim_requires_call'; pattern: string; flags?: string; anyOf: CallMatcher[]; ignoreNegated?: boolean })
  /** The effect the user asked for happened (a captured call matches one of anyOf). */
  | (GraderBase & { kind: 'must_call'; anyOf: CallMatcher[]; min?: number })
  /** The effect must NOT happen (no captured call matches any of anyOf). */
  | (GraderBase & { kind: 'must_not_call'; anyOf: CallMatcher[] })
  /** The final must match (within the first `withinChars` when set — "answer first"). */
  | (GraderBase & { kind: 'final_matches'; pattern: string; flags?: string; withinChars?: number })
  /** The final must not match — unless one of `unlessCall` was captured (then the statement is backed). */
  | (GraderBase & { kind: 'final_not_matches'; pattern: string; flags?: string; unlessCall?: CallMatcher[]; ignoreNegated?: boolean })
  /** Every id-shaped token in the final (uuid, ≥7-hex sha/prefix, oq_ id) was SEEN this trial (inputs or tool outputs). */
  | (GraderBase & { kind: 'ids_grounded'; allow?: string[] })
  /** Every id-shaped argument the run passed to a tool was seen (a full id, or a ≥8-char prefix of one). */
  | (GraderBase & { kind: 'call_ids_grounded'; tools?: string[] })
  /** Each match of `pattern` (or its capture `group`) must appear in what the run READ (tool outputs; `inputs_and_outputs` adds the frozen inputs). */
  | (GraderBase & { kind: 'fact_grounded'; pattern: string; flags?: string; group?: number; groundIn?: 'tool_outputs' | 'inputs_and_outputs' })
  /** A generous COST bound — never a path check (a run may read in any order). */
  | (GraderBase & { kind: 'max_calls'; max: number; tools?: string[] })
  /** Harness bound on provider calls (retry storms). */
  | (GraderBase & { kind: 'max_model_calls'; max: number })
  /** A headline clock (the first time in the opening) is within `maxSkewMinutes` of the frozen now. */
  | (GraderBase & { kind: 'headline_clock'; maxSkewMinutes: number; withinChars?: number })
  /** The run delivered a non-empty answer. */
  | (GraderBase & { kind: 'final_nonempty' })
  /** One binary LLM rubric — binding only once calibrated on owner labels (judge.ts). */
  | (GraderBase & { kind: 'judge'; rubric: string });

export type GraderKind = GraderSpec['kind'];

/** A read (or mutating) tool's frozen output. First match wins (`args` uses CallMatcher's arg rules). */
export interface ToolFixture {
  tool: string;
  args?: CallMatcher['args'];
  /** Returned to the model verbatim (an object is pretty-printed JSON). */
  output: string | Record<string, unknown> | unknown[];
  note?: string;
}

/** One model output in a recording (the replay model serves them in order, per agent). */
export interface RecordedTurn {
  /** 'lead' (default) or a worker label ('w1', 'w2', … in order of first appearance). */
  agent?: string;
  /**
   * The provider model that produced this output (live recordings stamp it).
   * When set, replay requires the harness to ask THAT model for this turn —
   * a seat-fallback lane that stops failing over shows up as a divergence.
   */
  model?: string;
  content?: string;
  reasoning?: string;
  toolCalls?: Array<{ name: string; args: Record<string, unknown> | string; id?: string }>;
  /** Replay a provider REJECTION on this call (thrown exactly like an axios HTTP error). */
  error?: { status: number; body: string };
  finishReason?: string;
}

export interface Recording {
  /** 'incident' / 'reference' for the frozen pair; live recordings get 'live-<date>-<model>-k<n>'. */
  id: string;
  kind: 'incident' | 'reference' | 'live';
  /** The grade this recording must get when replayed through today's harness. */
  expect: 'pass' | 'fail';
  model?: string;
  note?: string;
  turns: RecordedTurn[];
  /** Stored judge verdicts for this recording (live mode writes them; offline replay reads them). */
  judge?: Record<string, 'pass' | 'fail'>;
}

export interface TrajectoryCase {
  id: string;
  title: string;
  /** 'draft' = frozen incident without a reference trajectory yet (CI checks the incident fails; live runs it). */
  status: 'active' | 'draft';
  incident: { date: string; source: string; refs?: string[]; summary: string };
  /** MAST failure-mode tags (Cemri et al. 2025), e.g. FM-2.6 reasoning-action mismatch. */
  mast?: string[];
  /**
   * 'model' (default): the incident was the MODEL's doing — its recording must
   * still FAIL today (the graders catch it). 'harness': the incident was the
   * harness's — its recording replayed through today's harness must PASS (the
   * fix holds; deleting it breaks the replay).
   */
  focus?: 'model' | 'harness';
  role: CaseRole;
  trigger: CaseTrigger;
  /** The seat the incident ran on (live mode maps a gateway id to its family built-in unless overridden). */
  seat?: { model?: string };
  input: {
    /** The frozen clock (ISO). Rendered into the prompt's date block. */
    now: string;
    timezone?: string;
    chatId?: string;
    chatTitle?: string;
    projectId?: string;
    projectName?: string;
    /** Frozen harness blocks the chat carried ([SUPERVISOR STATE], [BOARD], a lane's status …). */
    context?: string;
    history?: Array<{ role: 'user' | 'assistant'; content: string }>;
    /** The owner / user message, or the machine wake prompt. */
    message: string;
  };
  fixtures: ToolFixture[];
  harness?: {
    /** Tool-round cap for this case (live cost bound); default = the role profile's. */
    maxSteps?: number;
    /** Built-in seat the lead falls back to after a deterministic rejection (content-filter class cases). */
    fallbackModel?: string;
  };
  graders: GraderSpec[];
  recordings: Recording[];
}

// ── Runtime validation (zod) — a malformed case fails CI with the file and path ──

const matcherArg = z.union([z.string(), z.number(), z.boolean(), z.object({ re: z.string() })]);
const callMatcher = z.object({
  tool: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
  args: z.record(z.string(), matcherArg).optional(),
  output: z.string().optional(),
}).strict();
const base = { id: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/), why: z.string().min(8), advisory: z.boolean().optional() };
const grader = z.discriminatedUnion('kind', [
  z.object({ ...base, kind: z.literal('claim_requires_call'), pattern: z.string().min(1), flags: z.string().optional(), anyOf: z.array(callMatcher).min(1), ignoreNegated: z.boolean().optional() }).strict(),
  z.object({ ...base, kind: z.literal('must_call'), anyOf: z.array(callMatcher).min(1), min: z.number().int().positive().optional() }).strict(),
  z.object({ ...base, kind: z.literal('must_not_call'), anyOf: z.array(callMatcher).min(1) }).strict(),
  z.object({ ...base, kind: z.literal('final_matches'), pattern: z.string().min(1), flags: z.string().optional(), withinChars: z.number().int().positive().optional() }).strict(),
  z.object({ ...base, kind: z.literal('final_not_matches'), pattern: z.string().min(1), flags: z.string().optional(), unlessCall: z.array(callMatcher).optional(), ignoreNegated: z.boolean().optional() }).strict(),
  z.object({ ...base, kind: z.literal('ids_grounded'), allow: z.array(z.string()).optional() }).strict(),
  z.object({ ...base, kind: z.literal('call_ids_grounded'), tools: z.array(z.string()).optional() }).strict(),
  z.object({ ...base, kind: z.literal('fact_grounded'), pattern: z.string().min(1), flags: z.string().optional(), group: z.number().int().nonnegative().optional(), groundIn: z.enum(['tool_outputs', 'inputs_and_outputs']).optional() }).strict(),
  z.object({ ...base, kind: z.literal('max_calls'), max: z.number().int().nonnegative(), tools: z.array(z.string()).optional() }).strict(),
  z.object({ ...base, kind: z.literal('max_model_calls'), max: z.number().int().positive() }).strict(),
  z.object({ ...base, kind: z.literal('headline_clock'), maxSkewMinutes: z.number().positive(), withinChars: z.number().int().positive().optional() }).strict(),
  z.object({ ...base, kind: z.literal('final_nonempty') }).strict(),
  z.object({ ...base, kind: z.literal('judge'), rubric: z.string().min(20) }).strict(),
]);
const turn = z.object({
  agent: z.string().optional(),
  model: z.string().optional(),
  content: z.string().optional(),
  reasoning: z.string().optional(),
  toolCalls: z.array(z.object({ name: z.string().min(1), args: z.union([z.record(z.string(), z.unknown()), z.string()]), id: z.string().optional() }).strict()).optional(),
  error: z.object({ status: z.number().int(), body: z.string() }).strict().optional(),
  finishReason: z.string().optional(),
}).strict();
const recording = z.object({
  id: z.string().min(1),
  kind: z.enum(['incident', 'reference', 'live']),
  expect: z.enum(['pass', 'fail']),
  model: z.string().optional(),
  note: z.string().optional(),
  turns: z.array(turn).min(1),
  judge: z.record(z.string(), z.enum(['pass', 'fail'])).optional(),
}).strict();

export const TRAJECTORY_CASE_SCHEMA = z.object({
  $schema: z.string().optional(),
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  title: z.string().min(8),
  status: z.enum(['active', 'draft']),
  incident: z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), source: z.string().min(4), refs: z.array(z.string()).optional(), summary: z.string().min(20) }).strict(),
  mast: z.array(z.string().regex(/^FM-\d\.\d$|^harness$/)).optional(),
  focus: z.enum(['model', 'harness']).optional(),
  role: z.enum(CASE_ROLES),
  trigger: z.enum(CASE_TRIGGERS),
  seat: z.object({ model: z.string().optional() }).strict().optional(),
  input: z.object({
    now: z.string().refine((s) => Number.isFinite(Date.parse(s)), 'input.now must be an ISO timestamp'),
    timezone: z.string().optional(),
    chatId: z.string().optional(),
    chatTitle: z.string().optional(),
    projectId: z.string().optional(),
    projectName: z.string().optional(),
    context: z.string().optional(),
    history: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string() }).strict()).optional(),
    message: z.string().min(1),
  }).strict(),
  fixtures: z.array(z.object({
    tool: z.string().min(1),
    args: z.record(z.string(), matcherArg).optional(),
    output: z.union([z.string(), z.record(z.string(), z.unknown()), z.array(z.unknown())]),
    note: z.string().optional(),
  }).strict()),
  harness: z.object({ maxSteps: z.number().int().positive().optional(), fallbackModel: z.string().optional() }).strict().optional(),
  graders: z.array(grader).min(1),
  recordings: z.array(recording).min(1),
}).strict();

/** Parse + validate one case file's JSON; throws a readable error naming the file. */
export function parseTrajectoryCase(json: unknown, file = '<case>'): TrajectoryCase {
  const r = TRAJECTORY_CASE_SCHEMA.safeParse(json);
  if (!r.success) {
    const issues = r.error.issues.slice(0, 8).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new Error(`trajectory case ${file} is invalid — ${issues}`);
  }
  const c = r.data as unknown as TrajectoryCase;
  const ids = new Set<string>();
  for (const g of c.graders) {
    if (ids.has(g.id)) throw new Error(`trajectory case ${file}: duplicate grader id "${g.id}"`);
    ids.add(g.id);
  }
  const recIds = new Set<string>();
  for (const rec of c.recordings) {
    if (recIds.has(rec.id)) throw new Error(`trajectory case ${file}: duplicate recording id "${rec.id}"`);
    recIds.add(rec.id);
  }
  if (!c.recordings.some((rec) => rec.kind === 'incident')) {
    throw new Error(`trajectory case ${file}: needs an incident recording (the frozen trajectory)`);
  }
  if ((c.focus ?? 'model') === 'model' && !c.recordings.some((rec) => rec.kind === 'incident' && rec.expect === 'fail')) {
    throw new Error(`trajectory case ${file}: a model-focus case needs an incident recording with expect "fail" (the frozen failure the graders must catch)`);
  }
  const harnessHolds = c.focus === 'harness' && c.recordings.some((rec) => rec.kind === 'incident' && rec.expect === 'pass');
  if (c.status === 'active' && !harnessHolds && !c.recordings.some((rec) => rec.kind === 'reference' && rec.expect === 'pass')) {
    throw new Error(`trajectory case ${file}: an active case needs a reference recording with expect "pass" (proves the graders accept valid work); mark it status "draft" until one exists`);
  }
  if (!c.graders.some((g) => !g.advisory && g.kind !== 'judge')) {
    throw new Error(`trajectory case ${file}: needs at least one binding deterministic grader (a judge alone is advisory until calibrated)`);
  }
  for (const g of c.graders) {
    for (const p of [(g as any).pattern].filter(Boolean)) {
      try { new RegExp(p, (g as any).flags ?? 'i'); } catch (e: any) { throw new Error(`trajectory case ${file}: grader ${g.id} pattern does not compile — ${e?.message}`); }
    }
  }
  return c;
}
