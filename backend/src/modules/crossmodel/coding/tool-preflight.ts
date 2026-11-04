/**
 * Tool-call PRE-FLIGHT — deterministic checks the harness runs on a model's
 * tool call BEFORE it executes (2026-09-09, the update_feedback/update_canvas
 * derailment class — CanLaw cec340f2, tt-rd, spark; watch passes #1-#7).
 *
 * What the incidents looked like: kimi-k3 (and once a GLM lane) decoder-locked
 * on a platform tool it never meant to call — `update_feedback({id:"noop"})`,
 * `{id:"BREAKING_NOW"}`, `{id:"RUN_CMD_NEXT_CALL"}` — while its own reasoning
 * said "call run_command". Every such call round-tripped to the DB, failed
 * "ticket not found", and the streak breaker needed THREE failures per episode
 * before it withheld the tool. Two cheap, deterministic signals identify the
 * shape on the FIRST call:
 *
 *   1. REFERENTIAL GROUNDING — an entity id the model passes to a platform tool
 *      must be an id it could actually know: either shaped like one of ours
 *      (uuid / ≥8-hex prefix — the citation contract) or a string that appears
 *      verbatim somewhere the model legitimately read it (system prompt, user
 *      turns, prior tool results). Narration tokens ("noop", "BREAKING_NOW",
 *      "PLACEHOLDER") are neither. The call is refused WITHOUT executing.
 *
 *   2. INTENT MISMATCH — the turn's reasoning / narration names a DIFFERENT
 *      offered tool as a whole word and never names the tool it emitted. The
 *      breaker uses this to (a) trip immediately instead of after 3 failures
 *      and (b) tell the model which tool it evidently meant.
 *
 * Pure leaf: imports only ./tool-scope (itself import-free), so both the
 * agent loop and its jest scaffolds can load it without touching the
 * platform module graph.
 */
import { modelToolName } from './tool-scope';

/** Arg keys that carry an entity reference: `id`, `chatId`, `todoId`, … */
const ID_ARG_KEY_RE = /^(id|[A-Za-z]+Id)$/; // id, chatId, sourceChatId, deployRunId …

/** Our ids: uuids and the 8-char citation prefixes (hex). Digit-only ids —
 *  GitHub run ids, numeric todo ids — are hex too, so they pass this shape. */
const ID_SHAPE_RE = /^[0-9a-f]{8}/i;

/** A uri value in an id-keyed arg (`verify_durable({id})` accepts the exact
 *  uri; `register_artifact` echoes one back). Ticket bf4654d3: a real S3 uri
 *  assembled from the run's OWN `aws s3 ls` output was convicted because the
 *  verbatim test demanded the exact final path, which the listing only
 *  implied (bucket + segments named, filename constructed). */
const URI_SHAPE_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

/** Extract the plain text a model could have READ this run: system + user
 *  content and tool results. Assistant turns are excluded on purpose — an
 *  earlier derailed call's own arguments must not ground a later one. */
export function groundingHaystack(messages: ReadonlyArray<unknown>): string {
  const out: string[] = [];
  for (const m of messages) {
    const msg = m as { role?: unknown; content?: unknown } | null | undefined;
    if (!msg || msg.role === 'assistant') continue;
    if (typeof msg.content === 'string') out.push(msg.content);
    else if (Array.isArray(msg.content)) {
      for (const part of msg.content as Array<{ type?: unknown; text?: unknown }>) {
        if (part && typeof part.text === 'string') out.push(part.text);
      }
    }
  }
  return out.join('\n');
}

export interface UngroundedIdArg { key: string; value: string }

const IDENT_CHAR_RE = /[A-Za-z0-9_]/;
/** `value` occurs in `haystack` as a WHOLE token — not glued inside a longer
 *  identifier. A plain substring test grounded the narration token "noop" the
 *  moment the prompt named the decision-gate purpose `supervisor_turn_noop`
 *  (the DECISION GATE ROLL-OUT facts line, 2026-09-27): the 13b2f286 replay
 *  then executed the placeholder call instead of refusing it. A value that
 *  starts or ends with a non-identifier character keeps the verbatim test on
 *  that side (an id like "-x" or "a/b" has no token edge there). */
export function occursAsToken(haystack: string, value: string): boolean {
  if (!value) return false;
  const leftEdge = IDENT_CHAR_RE.test(value[0]);
  const rightEdge = IDENT_CHAR_RE.test(value[value.length - 1]);
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(value, from);
    if (at < 0) return false;
    const before = at > 0 ? haystack[at - 1] : '';
    const after = haystack[at + value.length] ?? '';
    const leftOk = !leftEdge || !before || !IDENT_CHAR_RE.test(before);
    const rightOk = !rightEdge || !after || !IDENT_CHAR_RE.test(after);
    if (leftOk && rightOk) return true;
    from = at + 1;
  }
}

/**
 * Entity-id args the model could not have obtained legitimately. Empty array
 * = the call is grounded (or carries no id-shaped args at all).
 *
 * A value is grounded when it (a) is shaped like one of our ids, or (b) occurs
 * verbatim in `haystack` (see groundingHaystack). Empty strings are left to
 * the tool's own validation — they are a missing param, not an invention.
 */
export function findUngroundedIdArgs(args: unknown, haystack: string): UngroundedIdArg[] {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return [];
  const bad: UngroundedIdArg[] = [];
  for (const [key, raw] of Object.entries(args as Record<string, unknown>)) {
    if (!ID_ARG_KEY_RE.test(key) || typeof raw !== 'string') continue;
    const value = raw.trim();
    if (!value) continue;
    if (ID_SHAPE_RE.test(value)) continue;
    if (occursAsToken(haystack, value)) continue;
    if (URI_SHAPE_RE.test(value) && uriGroundedInHaystack(value, haystack)) continue;
    bad.push({ key, value });
  }
  return bad;
}

/** Schemes whose authority is a HOSTNAME-or-bucket we can require verbatim in
 *  the haystack. Anything else (`urn:`, `mailto:`, …) never reaches segment
 *  grounding at all — those either occur whole or stay ungrounded. */
const URI_SCHEME_ALLOWLIST_RE = /^(s3|https?|gs|ftp):\/\//i;
/** An authority strong enough to ground on alone-side: at least 5 chars and
 *  not a bare dictionary word. `https://am/pp` was grounded by the prose word
 *  "am" (bf4654d3 adversarial review): short common-word authorities make the
 *  "bucket appears in haystack" half meaningless. */
const URI_AUTHORITY_MIN_LEN = 5;
const URI_AUTHORITY_COMMON_WORD_RE = /^(am|is|to|in|of|on|or|at|by|it|an|as|we|he|so|no|do|if|us|http|https|s3|ws|wss|ftp|localhost)$/i;

/** A uri arg is grounded when the model could have assembled it from text it
 *  legitimately read: either the full uri (verbatim — e.g. `register_artifact`
 *  echoing one back) or BOTH halves of it — the scheme+authority (`s3://bucket`)
 *  AND every ≥4-char path segment. Ticket bf4654d3: the run's own
 *  `aws s3 ls` output named the bucket and the checkpoint filename; only the
 *  exact final path was constructed. Requiring both halves keeps a purely
 *  invented path (`s3://bucket/hallucinated-name`) ungrounded — a bucket from
 *  the haystack plus a fabricated segment still fails.
 *
 *  Hardened after the adversarial review: the decomposed path requires (1) an
 *  allowlisted scheme, (2) an authority ≥5 chars that is not a common word,
 *  and (3) at least one ≥4-char segment actually present (the old vacuous
 *  `every()` over zero qualifying segments grounded `https://am/pp` on the
 *  prose word "am"). */
export function uriGroundedInHaystack(uri: string, haystack: string): boolean {
  if (occursAsToken(haystack, uri)) return true;
  if (!URI_SCHEME_ALLOWLIST_RE.test(uri)) return false;
  const schemeCut = uri.indexOf('://');
  if (schemeCut < 0) return false;
  const rest = uri.slice(schemeCut + 3);
  const slash = rest.indexOf('/');
  const authority = slash < 0 ? rest : rest.slice(0, slash);
  if (!authority || authority.length < URI_AUTHORITY_MIN_LEN) return false;
  if (URI_AUTHORITY_COMMON_WORD_RE.test(authority)) return false;
  if (!occursAsToken(haystack, authority)) return false;
  const segments = (slash < 0 ? '' : rest.slice(slash + 1)).split('/');
  const checkable = segments.filter((s) => s.length >= 4);
  if (checkable.length === 0) return false; // vacuous every() grounded short paths
  return checkable.every((s) => occursAsToken(haystack, s));
}

/**
 * The tool the turn's own words say it meant, when that is unambiguous:
 * some OTHER offered tool is named as a whole word and the called tool is
 * never named. Returns null when the narration names the called tool, names
 * nothing, or is too short to mean anything (a stray "verify" in a sentence
 * must not convict a legitimate call).
 *
 * DECISION-ADJACENCY (ticket d2cceee3, 2026-09-23): the CONVICTION leg
 * scans only the narration's FINAL SENTENCE — the segment where the model
 * states the action it is taking. A long agentic monologue legitimately
 * carries offered-tool names as ordinary ENGLISH VERBS in earlier
 * checklist/summary sentences ("GPU/ports verify", "verify/abort (~3)
 * steps", "Mia + S6 verify (quick probe)") while its final sentence
 * faithfully announces the very call it makes ("Write w2_fire.sh +
 * w2_watch.sh now." → write_file). Counting the earlier verbs convicted
 * exactly that faithful lane 5× on SUCCESSFUL write_file calls and
 * auto-filed this mishap — a false positive, not a derailment (the four
 * pinned model-side quadrants all name the other tool AS the action in the
 * decision sentence: "Now web_pipe…", "Shell first: run_command…"). Every
 * ACQUITTAL leg below (literal, alias, prose self-naming) keeps the WHOLE
 * text: acquitting broadly and convicting narrowly is the safe direction
 * for a heuristic net.
 */
export function detectIntendedTool(
  narration: string,
  calledName: string,
  offeredNames: Iterable<string>,
  callArgs?: unknown,
): string | null {
  // Single-string form (unit pins, single-channel callers): the whole
  // narration is one channel.
  return detectIntendedToolChannels(narration || '', '', calledName, offeredNames, callArgs);
}

/**
 * Channel-aware form (the agent-loop call sites): a turn's narration is TWO
 * channels — reasoning and content — and the DECISION-SENTENCE scoping must
 * take the final sentence of EACH, not of their concatenation. The incident
 * (d2cceee3) put the announce sentence at the reasoning tail ("Write
 * w2_fire.sh + w2_watch.sh now.") while the content channel was empty or a
 * short status line; conversely a slip pin (agent-tool-scope, 7b2a0969 era)
 * names its intended tool in the reasoning line while the content line that
 * FOLLOWS it names nothing — a concatenation-final scope would lose both.
 * Acquittal legs keep the WHOLE concatenated text (broad acquittal);
 * conviction scans the union of the two final sentences (narrow conviction).
 */
export function detectIntendedToolChannels(
  reasoning: string,
  content: string,
  calledName: string,
  offeredNames: Iterable<string>,
  callArgs?: unknown,
): string | null {
  const text = `${reasoning || ''}\n${content || ''}`.slice(-6000); // the tail is where the decision is made
  if (text.length < 12) return null;
  if (mentions(text, calledName)) return null;
  // Alias self-naming (7b2a0969 review N1): the model-facing rename
  // (tool-scope.ts, 2026-09-22 — update_feedback→triage_ticket) means a lane
  // can faithfully narrate "call triage_ticket" while the emitted name has
  // already internalized to update_feedback. Convicting on that is a
  // self-redirect ("you evidently meant update_feedback" while calling
  // update_feedback) and a false +1 intent weight — the same contract
  // violation this ticket fixes for the prose form.
  if (modelToolName(calledName) !== calledName && mentions(text, modelToolName(calledName))) return null;
  // Ticket 7b2a0969: prose self-naming acquits exactly like the literal form —
  // "register the watched resource" names register_watched_resource. Without
  // this, a lane naming its own call in prose was convicted of intending an
  // ALREADY-COMPLETED sibling (list_schedules) recapped in the same
  // narration, and the +1 intent weight turned one legitimate refusal into a
  // phantom "3× streak" ticket + a wrong "you evidently meant" redirect.
  if (proseMentionsTool(text, calledName)) return null;
  // DECISION-ADJACENCY (ticket d2cceee3): conviction scans the FINAL
  // SENTENCE OF EACH CHANNEL — see detectIntendedToolChannels' docstring.
  // The acquittal legs above keep the whole concatenated text (broad
  // acquittal, narrow conviction).
  const decisions = [finalSentence(reasoning || ''), finalSentence(content || '')].filter((d) => d.length >= 4);
  if (!decisions.length) return null; // no channel carries a decision sentence
  const decisionText = decisions.join('\n');
  const counts = new Map<string, number>();
  for (const name of offeredNames) {
    if (!name || name === calledName) continue;
    // 022eb482: CONVICTION uses the standalone counter — a mention glued
    // into a filename/compound (verify-wave.sh) is not intent evidence.
    // 1d1967eb (narrowed, review F1): a mention that is the SEARCH TARGET
    // of the called code-search tool — the call's own pattern/query/regex
    // payload, or a search cue directly precedes THAT occurrence — is not
    // intent evidence. Occurrence-LOCAL, never name-global: an explicit
    // intent verb on the same name ("Now call file_feedback to file the
    // finding" while grep({pattern:'file_feedback'}) runs) still counts
    // and still convicts. Payload-gated, NOT a blanket quoted strip: a
    // QUOTED intent statement ("I should have called 'file_feedback'
    // instead.") still convicts, because the quoted name is not the
    // payload of the call that was actually made.
    const view = stripSearchTargetMentions(decisionText, name, calledName, callArgs);
    const n = countStandaloneMentions(view, name);
    if (n > 0) counts.set(name, n);
  }
  if (!counts.size) return null;
  // Most-mentioned wins; ties → the one mentioned LAST (closest to the call).
  let best: string | null = null;
  let bestCount = 0;
  let bestPos = -1;
  for (const [name, n] of counts) {
    const pos = decisionText.lastIndexOf(name);
    if (n > bestCount || (n === bestCount && pos > bestPos)) { best = name; bestCount = n; bestPos = pos; }
  }
  return best;
}

function mentions(text: string, name: string): boolean {
  return countMentions(text, name) > 0;
}

/**
 * The narration's FINAL SENTENCE (ticket d2cceee3 decision-adjacency): the
 * text after the last INTERIOR sentence boundary — a [.!?] run followed by
 * actual whitespace — through to the end. Trailing whitespace is trimmed
 * first so a text ENDING in a terminator ("Now grep the seam names.") is one
 * whole sentence, not an empty tail (the bug class that would have acquitted
 * every pinned single-sentence conviction). `w2_fire.sh` does not split (the
 * dot sits inside a token, unflowered by whitespace); "done. Now grep…"
 * splits after "done. " — "Now grep…" is the decision.
 */
function finalSentence(text: string): string {
  const trimmed = text.trim();
  const re = /[.!?]+\s/g;
  let last = -1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(trimmed)) !== null) {
    last = m.index + m[0].length;
  }
  return last < 0 ? trimmed : trimmed.slice(last).trim();
}

function countMentions(text: string, name: string): number {
  const re = new RegExp(`(?<![A-Za-z0-9_])${escapeRe(name)}(?![A-Za-z0-9_])`, 'g');
  return (text.match(re) || []).length;
}

/**
 * CONVICTION-scoped mention count (ticket 022eb482, 2026-10-11; separator
 * set widened with '/' by 738295c3, 2026-10-25): a mention GLUED into a
 * longer hyphen/dot/slash compound token — `verify-wave.sh`, `verify.sh`,
 * `re-verify`, `build/extract/verify` — is a FILENAME, path or compound
 * word, not a tool mention. The wild instances: five SUCCEEDING edit_file
 * calls whose decision sentence was "applying the remaining
 * `verify-wave.sh` edits…" (the base countMentions boundary class
 * [A-Za-z0-9_] treats `-` as an edge, so the filename counted as TWO
 * whole-word `verify` mentions), and — one separator over — a batch of
 * edit_file calls narrated "…labels in build/extract/verify), then running
 * the pipeline." while editing exactly those three files (the '/' enumeration
 * counted as a bare `verify` mention). Both convicted edit_file→verify ×5,
 * tripping the 2c98b460 success-side guard on a lane faithfully editing
 * the very files it named. The glue test requires an identifier char on
 * the FAR side of the hyphen/dot/slash, so sentence-final "Now verify."
 * (dot then whitespace) and a leading "- verify" bullet still count, and a
 * bare CLI "--verify" (two hyphens) still counts. Used ONLY by the
 * conviction leg of detectIntendedToolChannels; every ACQUITTAL leg keeps
 * the broad countMentions — a lane naming its own call inside a filename
 * still acquits (the safe direction for a heuristic net).
 */
function countStandaloneMentions(text: string, name: string): number {
  const re = new RegExp(`(?<![A-Za-z0-9_])${escapeRe(name)}(?![A-Za-z0-9_])`, 'g');
  let n = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const after = m.index + name.length;
    const prevCh = m.index > 0 ? text[m.index - 1] : '';
    const nextCh = text[after] ?? '';
    // 738295c3: the glue separator set is a SET — '-', '.' and '/' all bind a
    // mention into a path/compound on the FAR side. '/' was missing: the wild
    // instance was a PIPELINE-FILE ENUMERATION ("labels in build/extract/verify,
    // then running the pipeline") read as a bare `verify` intent mention while
    // the model was calling edit_file on the three named files — 5 counted
    // misses, the re-anchor and the 2c98b460 trip, all on a lane faithfully
    // editing the very files it listed. Same shape as 022eb482's
    // verify-wave.sh: the far side of EVERY separator must carry an identifier
    // char, so sentence-final "Now verify." and a leading "- verify" bullet
    // still count, and a bare CLI "--verify" (two hyphens) still counts.
    const glueL = (prevCh === '-' || prevCh === '.' || prevCh === '/') && m.index > 1 && IDENT_CHAR_RE.test(text[m.index - 2]);
    const glueR = (nextCh === '-' || nextCh === '.' || nextCh === '/') && IDENT_CHAR_RE.test(text[after + 1] ?? '');
    if (!glueL && !glueR) n += 1;
  }
  return n;
}

/** Code-search tools whose payloads are SEARCH TARGETS: a name inside the
 * pattern/query/regex argument of one of these is what is being searched
 * FOR, never a tool the model meant to call. 1d1967eb — the read-only
 * review census that ast_searched for the literal 'file_feedback'.
 * Review F3: web_pipe / youtube_pipe / search_memory take `query` too and
 * a census-shaped lane can run them just as well as ast_search. */
const CODE_SEARCH_TOOL_RE = /^(ast_search|grep|search_code_semantic|glob|github_search_code|web_pipe|youtube_pipe|search_memory)$/;

/** The payload keys that carry a search target. */
const SEARCH_PAYLOAD_KEYS = ['pattern', 'query', 'regex', 'regexp'] as const;

/** One `name` occurrence in `decisionText`, positioned at `at`. */
function replaceMentionWith(text: string, at: number, len: number): string {
  return text.slice(0, at) + ' '.repeat(len) + text.slice(at + len);
}

/**
 * 1d1967eb (narrowed after review F1/F2): the conviction view of the
 * decision text with this call's SEARCH-TARGET mentions REMOVED — every
 * OTHER mention of the name is kept. Occurrence-LOCAL, never name-global:
 * "Now call file_feedback to file the finding" while grep({pattern:
 * 'file_feedback'}) runs keeps the intent-verb mention and convicts
 * (review F1's hole). A whole-token occurrence of the name is a search
 * target when the called tool is a code-search tool AND either
 * (a) the occurrence is QUOTED and the call's own pattern/query/regex
 *     payload carries the name as a whole token — the model is spelling
 *     out what it is searching for (the actual mishap shape), or
 * (b) a code-search cue ("search for X", "grep for X", "enumerating X")
 *     directly precedes THAT occurrence — a search-enumeration VERB takes
 *     the name as its OBJECT, incompatible with intent phrasing ("call X").
 * An UNQUOTED mention beside an intent verb ("call file_feedback") keeps
 * its mention and convicts even when the payload carries the name; a
 * quoted INTENT statement with a different payload ("I should have called
 * 'file_feedback'" while grepping for something else) keeps it too.
 */
function stripSearchTargetMentions(decisionText: string, name: string, calledName: string, callArgs?: unknown): string {
  if (!name || !CODE_SEARCH_TOOL_RE.test(calledName)) return decisionText;
  // Does the call's own payload carry the name as a whole token?
  const args = (callArgs && typeof callArgs === 'object' && !Array.isArray(callArgs)) ? callArgs as Record<string, unknown> : {};
  let payloadCarries = false;
  for (const key of SEARCH_PAYLOAD_KEYS) {
    const v = args[key];
    if (typeof v === 'string' && occursAsToken(v, name)) { payloadCarries = true; break; }
  }
  if (!payloadCarries) {
    // Only the cue leg can strip. No early gate: the per-occurrence loop
    // below tests the slice ENDING at each occurrence (CUE_BEFORE_NAME_RE
    // is $-anchored for that use — testing it against the whole text, as
    // an earlier draft did, never matches and silently disabled the leg).
  }
  const re = new RegExp(`(?<![A-Za-z0-9_])${escapeRe(name)}(?![A-Za-z0-9_])`, 'g');
  let view = decisionText;
  let m: RegExpExecArray | null;
  while ((m = re.exec(view)) !== null) {
    const at = m.index;
    const prevCh = at > 0 ? view[at - 1] : '';
    const nextCh = view[at + name.length] ?? '';
    const quoted = /^['"`]$/.test(prevCh) && nextCh === prevCh;
    const cueAdjacent = CUE_BEFORE_NAME_RE.test(view.slice(Math.max(0, at - 48), at));
    if (cueAdjacent || (quoted && payloadCarries)) {
      view = replaceMentionWith(view, at, name.length);
      re.lastIndex = at + name.length;
    }
  }
  return view;
}

/** A code-search cue ENDING right before a name occurrence (with optional
 * trailing quote/space): "searching for ", "grep for ", "enumerating ", … */
const CUE_BEFORE_NAME_RE = /(?:search(?:ing|ed)? for|grep(?:ping)? for|grep|ast_search(?:ing)? for|enumerating|census of|scanning(?: for)?)\s*['"`]?$/i;

/**
 * PROSE-FORM self-naming (ticket 7b2a0969, 2026-09-23): a model often names
 * the tool it is about to call in PROSE — "register the watched resource",
 * "observe the resource", "open a pull request" — not as the snake_case
 * identifier. The literal-only `mentions` check above missed that form, so a
 * lane whose narration named its own call in prose was still treated as
 * "never names the tool it emitted" and a recap of an ALREADY-COMPLETED
 * sibling call (e.g. list_schedules, executed earlier in the same batch) was
 * convicted as "the tool you evidently meant" — adding the +1 intent
 * fast-trip weight that turned ONE legitimate refusal into a "3× streak"
 * and auto-filed a phantom mishap ticket.
 *
 * This predicate closes that gap: TRUE when the narration contains the
 * called tool's tokens as an IN-ORDER word sequence ("register the watched
 * resource" matches register_watched_resource — the stopwords the/the/a are
 * allowed BETWEEN the tool's own words). Token match is exact + word-bounded
 * per token (word boundaries let "list projects" match list_projects and
 * stop "list_projector" matching), and the sequence must appear within a
 * 12-word window so unrelated mentions of the same words across a long turn
 * cannot chain into a false acquittal.
 */
export function proseMentionsTool(text: string, calledName: string): boolean {
  if (!text || !calledName) return false;
  const tokens = calledName.split('_').filter(Boolean);
  // A one-word tool name is fully covered by the literal check (its prose
  // form IS the identifier). Two tokens are the minimum for a distinct prose
  // form; past four, prose drift makes the sequence unreliable.
  if (tokens.length < 2 || tokens.length > 4) return false;
  const words = text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const WINDOW = 12;
  for (let start = 0; start + tokens.length <= words.length; start += 1) {
    if (!proseTokenMatches(words[start], tokens[0])) continue;
    // Require the remaining tokens to follow IN ORDER within the window,
    // allowing only articles/prepositions BETWEEN the tool's own words
    // ("register the watched resource"). Any other word breaks the run.
    let ti = 1;
    let wi = start + 1;
    while (ti < tokens.length && wi < words.length && wi - start <= WINDOW) {
      if (proseTokenMatches(words[wi], tokens[ti])) { ti += 1; wi += 1; }
      else if (STOPWORDS.has(words[wi])) wi += 1;
      else break;
    }
    if (ti === tokens.length) return true; // full in-order sequence found
  }
  return false;
}

/** One word of the narration matches one token of the tool name: EXACT
 *  equality only (case-insensitive via the caller's lowercase). Deliberately
 *  NO inflection matching — "verifying the durable stamps" does NOT acquit
 *  verify_durable (the cea13871 pin's shape: an inflected mention is weaker
 *  evidence than the announce-form, and that leg's intent weight is
 *  adjudicated-correct behavior). Every broadening of this predicate weakens
 *  the containment; every narrowing just restores pre-7b2a0969 behavior, so
 *  the conservative side is exact-match. */
function proseTokenMatches(word: string, token: string): boolean {
  return !!word && !!token && word === token;
}

/** Articles/prepositions allowed BETWEEN the called tool's own words in a
 *  prose self-naming — "register the watched resource". */
const STOPWORDS = new Set(['the', 'a', 'an', 'of', 'for', 'to', 'and', 'in', 'on', 'with', 'at', 'by', 'from', 'up']);

/**
 * MEASURE-FIRST intent-attribution discount probe (ticket 58e675c9,
 * 2026-09-22 — shortfall-hunt cycle 2 finding 2; wild instance 92b485bd).
 *
 * detectIntendedTool is whole-word mention counting: it has NO notion that a
 * named tool's answer is already pre-computed in the wake context, or that
 * the emitted calls were ORDERED by the schedule preamble. Wild instance:
 * the Fleet Supervisor lane emitted schedule_get ×5 — ordered by the
 * standing sweep preamble's drift check (the supervisor preamble names
 * schedule_get in that checklist) — while its reasoning named
 * get_chat_status, a duty every supervisor wake's [FLEET LIVENESS] block
 * pre-computes. The 2c98b460 success-side guard steered at 3 and tripped at
 * 5 on that noisy evidence; adjudication found NO framework defect, and the
 * tuning proposal ordered MEASUREMENT BEFORE any detector change.
 *
 * This probe computes — but NEVER applies — the two proposed discounts, so
 * the agent loop can log a guard_miss row (seam 'tool_intent_attribution')
 * for each mismatch that WOULD have been discounted. One measurement cycle
 * answers "how much of the guard's conviction volume is this noise?" before
 * anyone weakens a containment.
 */

export interface IntentDiscount {
  /** Which proposed heuristic matched. */
  reason: 'precomputed_duty' | 'preamble_ordered';
  /** What matched: the block's matched render signature, or the called tool name. */
  marker: string;
  /** preamble_ordered only: a ≤160-char window of the wake-text line,
   *  centered on the first whole-word mention — the adjudicator sees a
   *  CHECKLIST line vs prose (a bare line-head slice could cut the mention
   *  itself off a long doctrine line). */
  line: string;
}

/** Wake blocks whose content PRE-COMPUTES a tool's answer set — a narration
 *  mention of a listed tool on a wake carrying one of the markers references
 *  an already-answered duty, not an intent to call (the ticket's proposal (a):
 *  a small per-profile pre-computed-tool list). v1: the supervisor
 *  [FLEET LIVENESS] block (fleet + project supervisor wakes,
 *  supervisor-state.service.ts:903) renders the per-lane schedules / runs /
 *  heartbeat table — the get_chat_status answer set (its render note,
 *  supervisor-state.service.ts:1063, says the fleet [FLEET LIVENESS] table
 *  already carries the per-schedule cadence the drift checklist would
 *  otherwise schedule_get).
 *  Markers are the two RENDER SIGNATURES, never the bare prose form: the
 *  standing doctrine also mentions `[FLEET LIVENESS]` in brackets
 *  (supervisor.service.ts:339) and that mention survives even when the block
 *  itself failed to render — this probe measures the BLOCK, so only its
 *  actual header (and the owner-briefing render) counts. */
const PRECOMPUTED_DUTY_BLOCKS: ReadonlyArray<{ markers: readonly string[]; tools: readonly string[] }> = [
  {
    markers: [
      // supervisor-state.service.ts:903 — the block header itself.
      '[FLEET LIVENESS — per-project machine heartbeat',
      // owner-briefing.service.ts:390 — the unbracketed owner-briefing render.
      'FLEET LIVENESS (measured right now',
    ],
    tools: ['get_chat_status'],
  },
];

/** audit 2026-10-06 T1-9 kill switch: the measurement row reads the full (system-inclusive) haystack again. */
export function intentMeasureSystemExcludeDisabled(): boolean { return process.env.INTENT_MEASURE_SYSTEM_EXCLUDE_DISABLED === '1'; }

/**
 * The run's STANDING ORDERS as plain text: system + user content, excluding
 * tool results (a result echoing a name would make every repeat call look
 * "ordered") and excluding [HARNESS NOTICE] user messages (the harness's own
 * re-anchor / derail notices name the called tool — they are the guard's
 * OUTPUT and must not self-justify later mismatches).
 */
export function wakePromptHaystack(messages: ReadonlyArray<unknown>, opts?: { excludeSystem?: boolean }): string {
  const out: string[] = [];
  for (const m of messages) {
    const msg = m as { role?: unknown; content?: unknown } | null | undefined;
    if (!msg || (msg.role !== 'system' && msg.role !== 'user')) continue;
    // audit 2026-10-06 T1-9: the MEASUREMENT haystack (excludeSystem) is the
    // wake / task text only — the system prompt names every core tool
    // ("list_dir/read_file to read…", "Prefer edit_file…"), so with it every
    // coding-lane mismatch read as 'preamble_ordered' (113 rows / 50 h, all
    // doctrine lines) and the probe could not tell an ordered checklist from a
    // derail. The ARMED discount keeps the full haystack (unchanged).
    if (opts?.excludeSystem && msg.role === 'system') continue;
    const push = (t: string) => { if (!t.includes('[HARNESS NOTICE')) out.push(t); };
    if (typeof msg.content === 'string') push(msg.content);
    else if (Array.isArray(msg.content)) {
      for (const part of msg.content as Array<{ type?: unknown; text?: unknown }>) {
        if (part && typeof part.text === 'string') push(part.text);
      }
    }
  }
  return out.join('\n');
}

/**
 * The proposed discount for one detected mismatch, or null when no proposed
 * heuristic applies. Checked in order; the FIRST match wins:
 *   (a) PRECOMPUTED_DUTY — the convicted ("intended") tool's answer set is
 *       injected pre-computed in this wake (a listed block marker present).
 *   (b) PREAMBLE_ORDERED — the CALLED tool is named as a whole word in the
 *       standing orders (the batch plausibly executes an ordered checklist
 *       duty; the matched line rides the telemetry for adjudication).
 * MEASURE-FIRST: callers log this and change NOTHING.
 */
export function intentMismatchDiscount(
  intended: string,
  calledName: string,
  wakeText: string,
): IntentDiscount | null {
  if (!wakeText) return null;
  for (const block of PRECOMPUTED_DUTY_BLOCKS) {
    if (!intended || !block.tools.includes(intended)) continue;
    const marker = block.markers.find((m) => wakeText.includes(m));
    if (marker) return { reason: 'precomputed_duty', marker, line: '' };
  }
  if (calledName && mentions(wakeText, calledName)) {
    const line = wakeText.split('\n').find((l) => mentions(l, calledName)) || '';
    // Center the window on the first WHOLE-WORD mention — a bare indexOf can
    // land on a substring inside a longer token (e.g. schedule_getTING) and
    // mis-center the 160-char snippet the adjudicator reads.
    const wholeWord = new RegExp(`(?<![A-Za-z0-9_])${escapeRe(calledName)}(?![A-Za-z0-9_])`);
    const idx = wholeWord.exec(line)?.index ?? 0;
    const start = Math.max(0, idx - 60);
    const snippet = line.slice(start, start + 160).trim();
    return { reason: 'preamble_ordered', marker: calledName, line: snippet };
  }
  return null;
}

/**
 * TRUE when a run_command `command` is a shell NO-OP — empty, `true`, `:`,
 * `exit [0]`, optionally with a trailing comment (ticket 9e2c69a2).
 *
 * Why this exists: run_command is exempt from BOTH loop breakers (the failure
 * derail-breaker and the identical-call breaker) because rebuild/retry and
 * poll loops are legitimate iteration. A 2026-09-15 kimi-k3 lane slipped
 * through that exemption with ~30 consecutive run_command({"command":"true"})
 * calls — every one SUCCEEDED (no failure streak), identical signature (but
 * run_command-exempt), while the model's narration intended a board tool
 * ("TaskGet", a name that does not exist) and later confabulated that the
 * run's toolset lacked send_chat_message/todo_*. A no-op shell is never
 * legitimate iteration, so the identical-call breaker treats it as breakable.
 */
const NOOP_SHELL_RE = /^\s*(true|:|exit(\s+0)?)?\s*(#.*)?$/;
export function isNoopShellCommand(command: unknown): boolean {
  if (typeof command !== 'string') return false;
  return NOOP_SHELL_RE.test(command);
}

/* ────────────────────────────────────────────────────────────────────────
 * NARRATED-TOOL-EMIT LOOP detection (ticket 177a31b7, 2026-09-20).
 *
 * THE INCIDENT: a kimi-k3 coding run (spark-cluster chat 28de72e5) decoder-
 * locked on ANNOUNCING an imminent tool call — "Sending the window-gate
 * relay to 521020fe NOW:" and near-identical variants — dozens of times
 * over 30+ minutes while the structured tool call NEVER executed (no
 * receipt; the peer lane never received the relay). Every existing breaker
 * missed it: the failure derail-breaker needs failing CALLS, the identical-
 * call breaker needs REPEATED CALLS, the leak lane needs tool-call MARKUP in
 * the prose, and the provider repetition lane needs degenerate intra-stream
 * output — each wedge turn was a short, well-formed, call-free announcement
 * that finalized, then a continue lane resurrected the run and the model
 * re-announced.
 *
 * What identifies the shape deterministically:
 *   1. TOOL-INTENT PHRASING — the text announces an imminent action: an
 *      offered tool is named as a whole word, OR an announce verb
 *      (sending/calling/running/…) pairs with an immediacy tail ("NOW:",
 *      "now.", "immediately"). A status line ("Still blocked on the
 *      reviewer verdict — no change.") matches neither channel and is never
 *      counted (the verdict-wait posture's one-line park answer must not
 *      convict a correctly-waiting lane).
 *   2. NEAR-IDENTICAL REPETITION across turns — normalized text equal or
 *      prefix-contains (variants diverge only in the tail: "NOW:" vs
 *      "NOW — attempt 3"). A 24-char floor keeps a bare "Sending now" from
 *      ever matching.
 * Pure leaf, same no-imports contract as the rest of this file.
 */

/** Verbs that announce the model is about to perform an action. */
const NARR_ANNOUNCE_VERB_RE = /\b(?:re-?)?(?:sending|calling|running|executing|invoking|dispatching|posting|pushing|merging|firing|triggering|issuing|submitting|applying|committing|deploying|scheduling|arming|writing|creating|updating|starting|stopping|cancelling|canceling|retrying|forwarding|relaying|publishing|closing|marking|registering|verifying|probing|checking|reading|fetching|scraping|searching|downloading|installing|attaching|notifying|answering|reporting|logging|signing|whitelisting|allowlisting)\b/i;

/** The announcement carries an immediacy marker ("NOW", "immediately",
 *  "next", "this call/turn") anywhere in the decision tail — the incident's
 *  variants trail text past the marker ("NOW — attempt 2:"), so the marker
 *  is not anchored to the very end. */
const NARR_IMMEDIACY_RE = /\b(?:now|immediately|right away|this (?:call|turn|round)|next)\b/i;

export interface NarratedToolIntent {
  /** The offered tool the narration names, when one is unambiguous. */
  tool: string | null;
}

/**
 * TRUE when a call-free turn's text reads as the announcement of an imminent
 * tool call rather than as content (an answer, a status line, a finding).
 * Returns the named offered tool when the narration names one.
 *
 * Two channels, BOTH gated on announce phrasing so a statement that merely
 * NAMES a tool ("The send_chat_message receipt confirmed delivery.") never
 * convicts:
 *   - TOOL channel: an offered tool is named as a whole word AND the text
 *     carries an announce verb or an immediacy tail.
 *   - ANNOUNCE channel: an announce verb pairs with an immediacy punchline
 *     ("Sending the window-gate relay to 521020fe NOW:") — the incident's
 *     shape, which names no tool at all.
 */
export function detectNarratedToolIntent(
  text: string,
  offeredNames: Iterable<string>,
): NarratedToolIntent | null {
  const tail = (text || '').slice(-800); // the announcement lives at the end of the turn
  if (tail.trim().length < 8) return null;
  const verbHit = NARR_ANNOUNCE_VERB_RE.test(tail);
  const tailHit = NARR_IMMEDIACY_RE.test(tail);
  if (!verbHit && !tailHit) return null; // a statement, not an announcement
  const counts = new Map<string, number>();
  for (const name of offeredNames) {
    if (!name) continue;
    const n = countMentions(tail, name);
    if (n > 0) counts.set(name, n);
  }
  if (counts.size) {
    // Most-mentioned wins; ties → the one mentioned LAST (detectIntendedTool idiom).
    let tool: string | null = null;
    let bestCount = 0;
    let bestPos = -1;
    for (const [name, n] of counts) {
      const pos = tail.lastIndexOf(name);
      if (n > bestCount || (n === bestCount && pos > bestPos)) { tool = name; bestCount = n; bestPos = pos; }
    }
    if (tool) return { tool };
  }
  if (verbHit && tailHit) return { tool: null };
  return null;
}

/** Case/punctuation-insensitive comparison form of a narration turn. */
export function normalizeNarration(text: string): string {
  return (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 200);
}

const NARR_SAME_MIN_CHARS = 24;

/**
 * "Same announcement" across turns: normalized-equal, or one is a prefix of
 * the other with ≥24 normalized chars in common — the incident's variants
 * ("…NOW:" / "…NOW — attempt 3") diverge only in the tail.
 */
export function sameNarration(a: string, b: string): boolean {
  const na = normalizeNarration(a);
  const nb = normalizeNarration(b);
  if (na.length < NARR_SAME_MIN_CHARS || nb.length < NARR_SAME_MIN_CHARS) return false;
  if (na === nb) return true;
  const [shorter, longer] = na.length <= nb.length ? [na, nb] : [nb, na];
  return longer.startsWith(shorter);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The structured refusal for an ungrounded-id call. Starts with the platform
 * `{"ok": false` envelope so looksLikeToolFailure (and the learning nudger)
 * see it as a failure shape.
 */
export function ungroundedIdRefusal(tool: string, bad: UngroundedIdArg[], intended: string | null): string {
  const shown = bad.map((b) => `${b.key}=${JSON.stringify(b.value)}`).join(', ');
  // Ticket c5615f58 (2026-09-12): a lane decoder-locked on get_chat_messages
  // ({chatId:"this-chat"}) and re-emitted it through three refusals — the generic
  // grounding sentence + the intent redirect never told it HOW to obtain a chat
  // id. When the rejected reference is a CHAT arg, name the recovery path
  // explicitly (message-only: the refusal still refuses; grounding unchanged).
  const chatRefused = bad.some((b) => b.key === 'chatId' || b.key.endsWith('ChatId'));
  // Ticket 7b2a0969 (2026-09-23): a lane called register_watched_resource with
  // projectId="cql-litellm-gateway" — the project NAME slugified, not an id.
  // The generic grounding sentence never told it HOW to obtain a project id
  // (the c5615f58 gap, projectId edition): name the recovery path explicitly.
  const projectRefused = bad.some((b) => b.key === 'projectId');
  return JSON.stringify({
    ok: false,
    tool,
    reason: 'ungrounded_id',
    rejected: bad,
    message:
      `NOT EXECUTED: ${tool} was called with ${shown}, which is not an id you obtained this run — ids come from a prior tool result (list_*/get_*), the brief, or the user, never from narration. ` +
      (intended
        ? `Your reasoning named ${intended} — you evidently meant to call ${intended}; call it now with its real parameters.`
        : `If you have no such id, you do not need ${tool} right now — call the tool that advances the task instead.`) +
      (chatRefused
        ? ` To target a chat, call list_chats first and use an id from its rows (a chat TITLE is not an id); for the chat you are running in, use your own session's chat id from your context.`
        : '') +
      (projectRefused
        ? ` To file under a project, call list_projects first and use an id from its rows (a project NAME or slug is not an id) — or omit projectId and it defaults to the current project when known.`
        : ''),
  }, null, 1);
}

/** The structured refusal for a call to a tool that was not offered this round
 *  (withheld by a breaker, not loaded, or outside this lane's schema). */
export function toolNotOfferedRefusal(tool: string, offered: Iterable<string>, hint?: string): string {
  const names = [...offered];
  return JSON.stringify({
    ok: false,
    tool,
    reason: 'tool_not_offered',
    message:
      `NOT EXECUTED: ${tool} is not in your tool list this round${hint ? ` (${hint})` : ''}. ` +
      `Choose from the tools you were offered: ${names.slice(0, 60).join(', ')}${names.length > 60 ? ', …' : ''}.`,
  }, null, 1);
}
