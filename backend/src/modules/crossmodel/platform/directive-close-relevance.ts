/**
 * Directive close ↔ evidence relevance (audit 2026-10-06 T5-8; fleet F4,
 * spark F9). OBSERVE-ONLY.
 *
 * The typed-evidence gate and the D2 receipt-match only prove that a cited id
 * EXISTS (and was seen by this supervisor) — never that it is ABOUT the
 * directive being closed. Two prod closes cited real ids for a different
 * incident: the owner's autonomy question was closed "done" with an unrelated
 * Schooltime steer as evidence, and an AGX reflash HOLD was closed with a
 * watchdog lane's S4 power-cycle (the real green signal landed 25 min later;
 * the owner read "directive closed" as the go-ahead).
 *
 * Rule: a close whose evidence shares NO salient token with the directive —
 * an id (≥ 8 hex chars, compared on the 8-char prefix), the directive's scope
 * (project id), or a key noun (≥ 4 letters, not a stopword or a fleet-generic
 * word like supervisor / lane / session / directive) — is a SUSPECT close: the
 * ack carries a one-line warning and one `directive_close_mismatch`
 * loop_metrics row is recorded. The close is never refused.
 *
 * Pure leaf (no imports) so the supervisor-state merge and tests share it.
 * Kill switch DIRECTIVE_CLOSE_RELEVANCE_DISABLED=1.
 */

export function directiveCloseRelevanceDisabled(): boolean {
  return process.env.DIRECTIVE_CLOSE_RELEVANCE_DISABLED === '1';
}

/** Words too common (English or fleet vocabulary) to tie evidence to a directive. */
const STOPWORDS: ReadonlySet<string> = new Set([
  // English
  'about', 'above', 'after', 'again', 'against', 'also', 'among', 'another', 'anything', 'because', 'been', 'before', 'being',
  'below', 'between', 'both', 'cannot', 'could', 'does', 'doing', 'done', 'down', 'during', 'each', 'either', 'else', 'every',
  'from', 'further', 'have', 'having', 'here', 'into', 'itself', 'just', 'least', 'less', 'like', 'make', 'many', 'more',
  'most', 'much', 'must', 'need', 'needs', 'never', 'next', 'none', 'only', 'other', 'over', 'same', 'should', 'since',
  'some', 'such', 'than', 'that', 'their', 'them', 'then', 'there', 'these', 'they', 'this', 'those', 'through', 'under',
  'until', 'upon', 'very', 'want', 'were', 'what', 'when', 'where', 'which', 'while', 'will', 'with', 'within', 'without',
  'would', 'your', 'yours', 'still', 'already', 'until', 'once', 'today', 'tomorrow', 'yesterday', 'now', 'please', 'thanks',
  'going', 'getting', 'keep', 'kept', 'make', 'made', 'sure', 'right', 'okay', 'good', 'great', 'fine', 'well', 'work',
  'works', 'worked', 'working', 'thing', 'things', 'stuff', 'time', 'hour', 'hours', 'minute', 'minutes', 'days', 'week',
  // fleet vocabulary — on both sides of almost every close
  'supervisor', 'supervisors', 'fleet', 'lane', 'lanes', 'session', 'sessions', 'chat', 'chats', 'directive', 'directives',
  'owner', 'owners', 'wake', 'wakes', 'sweep', 'todo', 'todos', 'goal', 'goals', 'project', 'projects', 'ticket', 'tickets',
  'message', 'messages', 'receipt', 'receipts', 'dispatch', 'dispatched', 'steer', 'steered', 'queued', 'queue', 'closed',
  'close', 'open', 'status', 'update', 'updated', 'answered', 'answer', 'question', 'questions', 'evidence', 'verified',
  'verify', 'confirmed', 'confirm', 'resolved', 'resolve', 'fixed', 'complete', 'completed', 'finished', 'started',
  'running', 'run', 'runs', 'schedule', 'scheduled', 'task', 'tasks', 'harness', 'digby', 'agent', 'agents', 'model',
  // generic action verbs any close may carry
  'merged', 'landed', 'shipped', 'pushed', 'opened', 'created', 'added', 'posted', 'sent', 'filed', 'applied', 'acted',
  'handled', 'relayed', 'replied', 'noted', 'recorded', 'reported', 'checked', 'read', 'reads', 'shows', 'showed',
]);

const HEX_ID_RE = /\b(?:oq_)?([0-9a-f]{8})[0-9a-f-]*\b/gi;
const WORD_RE = /[a-z][a-z0-9]{3,}/g;

/** Light normalisation so "deployed" meets "deploy" and "lanes" meets "lane". */
const stem = (w: string): string => {
  if (w.length > 6 && w.endsWith('ing')) return w.slice(0, -3);
  if (w.length > 5 && w.endsWith('ed')) return w.slice(0, -2);
  if (w.length > 5 && w.endsWith('es') && /(?:[sxz]|ch|sh)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 4 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
};

/** Evidence with fewer key nouns than this is undecidable (a bare 'pr #215' / 'session 1a2b3c4d' — provenance is the receipt-match's job). */
export const DIRECTIVE_CLOSE_MIN_EVIDENCE_WORDS = 2;

/** The salient tokens of a text: 8-char id prefixes (`id:xxxxxxxx`) and stemmed key nouns. Pure. */
export function salientTokens(text: string): Set<string> {
  const out = new Set<string>();
  const s = String(text ?? '').toLowerCase();
  HEX_ID_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = HEX_ID_RE.exec(s)) !== null) {
    // An 8-hex run that is all digits (a clock, a count) is not an id.
    if (/[a-f]/.test(m[1])) out.add(`id:${m[1]}`);
  }
  for (const w of s.replace(HEX_ID_RE, ' ').match(WORD_RE) ?? []) {
    if (/^\d/.test(w) || STOPWORDS.has(w)) continue;
    const st = stem(w);
    if (STOPWORDS.has(st)) continue;
    out.add(st);
  }
  return out;
}

export interface DirectiveCloseRelevance {
  related: boolean;
  /** Tokens shared by the directive and the evidence (empty when unrelated). */
  shared: string[];
  /** True when there is nothing to compare — the directive has no salient token, or the evidence is
   *  (almost) only ids / typed refs. Never flagged. */
  undecidable: boolean;
}

/**
 * Does a close's evidence share a salient token with the directive it closes?
 * `scope` (the directive's project id) counts as a directive token. A
 * directive with no salient token is undecidable (never flagged). Pure.
 */
export function directiveCloseRelevance(input: { directiveText: string; scope?: string | null; evidence: string }): DirectiveCloseRelevance {
  const dir = salientTokens(`${input.directiveText ?? ''} ${input.scope && input.scope !== 'fleet' ? input.scope : ''}`);
  const ev = salientTokens(input.evidence ?? '');
  const shared = [...dir].filter((t) => ev.has(t));
  if (shared.length) return { related: true, shared, undecidable: false };
  const evWords = [...ev].filter((t) => !t.startsWith('id:'));
  if (!dir.size || evWords.length < DIRECTIVE_CLOSE_MIN_EVIDENCE_WORDS) return { related: true, shared: [], undecidable: true };
  return { related: false, shared: [], undecidable: false };
}

/** The observe-only ack line for a suspect close. */
export function directiveCloseMismatchNote(directiveId: string, evidence: string): string {
  return `directive ${directiveId} closed with evidence that shares NO id or key noun with the directive (observed only — the close stands): "${String(evidence).replace(/\s+/g, ' ').slice(0, 100)}". If that evidence is about a different item, re-open the directive (status 'open') and close it against an artifact of ITS OWN work.`;
}
