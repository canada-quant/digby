/**
 * PROMPT HYGIENE — the pure lint behind platform/prompt-hygiene.test.ts (CI)
 * and platform/lesson-writer.ts (the repair loops' only way to add doctrine).
 *
 * A GENERIC prompt block (layer 1 core, layer 4 role profiles, the machine-
 * wake preamble, the hook template, the chat playbook, tool descriptions,
 * sweep bodies) must not carry:
 *   - a project name (the static denylist + prompt-hygiene.projects.json —
 *     names captured from live crossmodel_projects rows; the allowlist may
 *     NEVER name a project);
 *   - a ticket / owner-question / confirmation id, a PR number;
 *   - a calendar date or a HH:MMZ clock inside RULE text (a sentence carrying
 *     must / never / always / only, or a bullet) — the facts layer's dated
 *     header is the one allowed date, on its own header line;
 *   - an owner-quote marker "(owner 20…" — a quote is doctrine only when
 *     generic, and then it is undated;
 *   - a literal built-in model id (seats are admin-editable; a prompt that
 *     names a model rots the moment the seat moves);
 *   - an env-flag TOGGLE instruction (`SOME_FLAG=1`) — a flag may be NAMED,
 *     never set, by a prompt;
 *   - more chars than its layer budget (prompt-layers.ts LAYER_BUDGETS);
 *   - and, across the layers of ONE composed prompt, the same sentence twice.
 *
 * Allowlist: `prompt-hygiene.allow.json` rows `{token, reason, expires,
 * sources?}` — an expired row FAILS the lint (someone must renew it with a
 * reason), and a row whose token names a project is refused by the lint
 * itself. Inline `// hygiene-allow: <token> — <reason> — expires <date>`
 * comments are the code-side mirror the reviewer reads; the JSON is what the
 * lint enforces.
 *
 * PURE: no imports beyond the layer budgets. The test wires the sources.
 */

import { LAYER_BUDGETS, type PromptLayerId, duplicateSentencesAcrossLayers, splitLayers } from './prompt-layers';

export type HygieneRule =
  | 'project_name'
  | 'incident_id'
  | 'dated_rule'
  | 'owner_quote_marker'
  | 'model_id'
  | 'env_toggle'
  | 'over_budget'
  | 'duplicate_sentence'
  | 'allowlist_expired'
  | 'allowlist_names_project';

export interface HygieneFinding {
  rule: HygieneRule;
  source: string;
  token: string;
  /** A short excerpt around the hit (≤ 160 chars). */
  excerpt: string;
}

export interface AllowlistEntry {
  token: string;
  reason: string;
  /** ISO date; the lint fails once today > expires. */
  expires: string;
  /** Optional: restrict the allowance to these source names (prefix match). */
  sources?: string[];
}

/** The static project-name denylist (the design's list + the inventory's
 *  incident artifacts). Case-insensitive whole-word match. */
export const STATIC_PROJECT_DENYLIST: readonly string[] = [
  'CanLaw', 'canlegal', 'canlegal-bench', 'spark', 'spark-cluster', 'dflash2', 'dflash2E', 'Nebius', 'nebius', 'RunPod',
  'SFT-2', 'Teranet', 'Mayfair', 'One Piece', 'tt-rd', 'IDEaS', 'HX300', 'Post-CPT', 'Serve GLM', 'inference project',
];

/** Built-in model ids a prompt must not name (seats are admin-editable). Mirrors
 *  model-roles.service builtInOptionsFor without importing its Prisma graph. */
export const MODEL_ID_DENYLIST: readonly string[] = [
  'kimi-k3', 'kimi-k2.6', 'glm-5.3', 'glm-5.2', 'glm-5.3-flash', 'deepseek-flash', 'deepseek-v4-pro', 'deepseek-v4-flash',
  'qwen3.6-27b', 'qwen3.6-flash', 'qwen-image-3.0', 'text-embedding-v4', 'qwen3-rerank', 'qwen-vl-max',
  'gpt-5.6', 'gpt-5.6-sol', 'gpt-5.6-luna', 'grok-4.5', 'gemini-3.5-flash', 'gemini-3.1-pro-preview', 'claude-sonnet-4',
  'GLM-5.3', 'GLM-5.2', 'Kimi K3', 'DeepSeek V4', 'Gemini', 'Grok',
];

const INCIDENT_ID_RE = /\boq_[0-9a-f]{8}|\bcf_[0-9a-f]{8}|\bticket [0-9a-f]{8}\b|\bfeedback [0-9a-f]{8}\b|\bPR #\d+/g;
const DATE_RE = /\b20\d\d-\d\d-\d\d\b|\b\d\d:\d\dZ\b/g;
const OWNER_QUOTE_RE = /\(owner 20\d\d/g;
const ENV_TOGGLE_RE = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+){1,}=[01]\b/g;
const RULE_SENTENCE_RE = /\b(must|never|always|only)\b/i;

function excerpt(text: string, idx: number, len: number): string {
  const start = Math.max(0, idx - 60);
  const end = Math.min(text.length, idx + len + 60);
  return text.slice(start, end).replace(/\s+/g, ' ').trim().slice(0, 160);
}

function wordRe(token: string): RegExp {
  const esc = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9_])${esc}(?![A-Za-z0-9_])`, 'gi');
}

/** Lines that are rule text: bullets, numbered steps, or sentences with a rule verb. */
function isRuleLine(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  if (/^[-*]\s|^\d+\.\s/.test(t)) return true;
  return RULE_SENTENCE_RE.test(t);
}

export interface LintOpts {
  source: string;
  text: string;
  /** Layer id for the budget check (omit for a non-layer source). */
  layer?: PromptLayerId;
  projectNames?: readonly string[];
  allow?: readonly AllowlistEntry[];
  now?: Date;
  /** The facts layer: its header line may carry ONE date. */
  datedHeaderAllowed?: boolean;
}

function allowed(token: string, source: string, allow: readonly AllowlistEntry[], now: Date): boolean {
  const t = token.toLowerCase();
  return allow.some(a => {
    if (a.token.toLowerCase() !== t && !t.includes(a.token.toLowerCase())) return false;
    if (a.sources && !a.sources.some(s => source.startsWith(s))) return false;
    return new Date(a.expires).getTime() >= now.getTime();
  });
}

/** Lint ONE generic block. Pure; returns findings (empty = clean). */
export function lintPromptText(opts: LintOpts): HygieneFinding[] {
  const { source, text } = opts;
  const allow = opts.allow ?? [];
  const now = opts.now ?? new Date();
  const out: HygieneFinding[] = [];
  const push = (rule: HygieneRule, token: string, idx: number) => {
    if (allowed(token, source, allow, now)) return;
    out.push({ rule, source, token, excerpt: excerpt(text, idx, token.length) });
  };

  for (const name of [...STATIC_PROJECT_DENYLIST, ...(opts.projectNames ?? [])]) {
    if (!name || name.length < 3) continue;
    const re = wordRe(name);
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) push('project_name', name, m.index + (m[1]?.length ?? 0));
  }
  for (const m of text.matchAll(INCIDENT_ID_RE)) push('incident_id', m[0], m.index ?? 0);
  for (const m of text.matchAll(OWNER_QUOTE_RE)) push('owner_quote_marker', m[0], m.index ?? 0);
  for (const m of text.matchAll(ENV_TOGGLE_RE)) push('env_toggle', m[0], m.index ?? 0);
  for (const id of MODEL_ID_DENYLIST) {
    const re = wordRe(id);
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) push('model_id', id, m.index + (m[1]?.length ?? 0));
  }
  // Dates: only inside rule lines; the facts header line is exempt when allowed.
  let offset = 0;
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    const headerExempt = opts.datedHeaderAllowed && i === 0 && line.startsWith('## ');
    if (!headerExempt && isRuleLine(line)) {
      for (const m of line.matchAll(DATE_RE)) push('dated_rule', m[0], offset + (m.index ?? 0));
    }
    offset += line.length + 1;
  });
  if (opts.layer) {
    const budget = LAYER_BUDGETS[opts.layer];
    if (text.length > budget) out.push({ rule: 'over_budget', source, token: `${text.length} > ${budget}`, excerpt: `${opts.layer} layer is ${text.length} chars (budget ${budget})` });
  }
  return out;
}

/** Lint a COMPOSED prompt: each layer against its budget + the cross-layer duplicate check. */
export function lintComposedPrompt(opts: Omit<LintOpts, 'text' | 'layer'> & { text: string; genericLayers?: PromptLayerId[] }): HygieneFinding[] {
  const generic = new Set<PromptLayerId>(opts.genericLayers ?? ['core', 'facts', 'role', 'chat']);
  const out: HygieneFinding[] = [];
  for (const layer of splitLayers(opts.text)) {
    if (layer.id === 'opener') continue;
    if (layer.id === 'project') {
      // The project layer is ALLOWED to name its project; only the budget applies.
      if (layer.body.length > LAYER_BUDGETS.project) out.push({ rule: 'over_budget', source: `${opts.source}#project`, token: `${layer.body.length} > ${LAYER_BUDGETS.project}`, excerpt: 'project brief over budget' });
      continue;
    }
    if (!generic.has(layer.id)) continue;
    out.push(...lintPromptText({ ...opts, source: `${opts.source}#${layer.id}`, text: layer.body, layer: layer.id, datedHeaderAllowed: layer.id === 'facts' }));
  }
  for (const s of duplicateSentencesAcrossLayers(opts.text)) {
    out.push({ rule: 'duplicate_sentence', source: opts.source, token: s.slice(0, 80), excerpt: s.slice(0, 160) });
  }
  return out;
}

/** Validate the allowlist itself: no expired rows, no project names. */
export function lintAllowlist(allow: readonly AllowlistEntry[], projectNames: readonly string[] = [], now: Date = new Date()): HygieneFinding[] {
  const out: HygieneFinding[] = [];
  for (const a of allow) {
    if (!a.expires || Number.isNaN(new Date(a.expires).getTime()) || new Date(a.expires).getTime() < now.getTime()) {
      out.push({ rule: 'allowlist_expired', source: 'prompt-hygiene.allow.json', token: a.token, excerpt: `expired ${a.expires} — ${a.reason}` });
    }
    for (const name of [...STATIC_PROJECT_DENYLIST, ...projectNames]) {
      if (name.length >= 3 && wordRe(name).test(a.token)) {
        out.push({ rule: 'allowlist_names_project', source: 'prompt-hygiene.allow.json', token: a.token, excerpt: `the allowlist may never name a project (${name})` });
      }
    }
  }
  return out;
}

/** One-line rendering for a failing assertion. */
export function formatFindings(findings: readonly HygieneFinding[]): string {
  return findings.map(f => `[${f.rule}] ${f.source}: "${f.token}" — …${f.excerpt}…`).join('\n');
}
