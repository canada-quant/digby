/**
 * wall-of-text — re-line an answer whose line breaks were LOST (ticket
 * 6ee7a779, owner feedback on a project-supervisor chat: "bad formatting one
 * big block of text… then double checker fixes it but should show correct the
 * first time").
 *
 * The failure shape (prod, 2026-10-04..06: 44 of 970 supervisor answers over
 * 500 chars, several models): the model wrote real markdown — a '## ' heading,
 * bold labels, '- ' bullets, '1. ' items, even a ``` fence — but every newline
 * arrived as a single SPACE, so the whole answer is ONE line ("…(00:16Z): ##
 * Not quite. **Done (sha bc59c291):** - P1 … - P2 … **Still open — 2
 * items:** 1. **English …:** … 2. **BC …:** …"). CommonMark renders that as
 * one paragraph with literal '##' / '-' characters. The Double Checker's
 * rewrite used to repair it after the fact; supervisor chats now run without
 * the checker, so the lead's text must render right the first time.
 *
 * markdown-normalize.ts already re-lines narrow signatures (≥2 mid-line
 * headings, bold-led '- **x**' lists, collapsed tables); its doctrine bars a
 * generic mid-line '- ' / '2. ' split because ordinary prose carries those.
 * This pass is that split, GATED to the case where it is safe: the text (one
 * unprotected segment) is ≥ WALL_MIN_CHARS long, contains NO newline at all,
 * and carries ≥ 2 structural markers — a 400+-char answer with markdown
 * structure and zero line breaks never came out of a model that way.
 *
 * Markers (each skipped inside a bold span, inline code and code fences):
 *   - mid-line ATX heading ' ## ' … ' ###### ';
 *   - a bold LABEL ending in a colon (' **What changed:**' / ' **Next**:') —
 *     never the one right after a list marker ('1. **Item:**' stays in its item);
 *   - a bold lead (' **Title Case words**') right after sentence-end
 *     punctuation or another bold span;
 *   - ' - ' / ' • ' bullets followed by a capital, '**', '`', '[', '(' or a
 *     digit (not a range like '10 - 12'); any bullet after an 'ACTIONS TAKEN' /
 *     'Receipts:' section label. Bullets count only as ≥2, or ≥1 after a section;
 *   - ' 1. ' ' 2. ' … numbered items forming an ascending run from 1 (≥ 2 long);
 *   - an inline ``` fence pair (rebuilt as a real fenced block; a known
 *     language word right after the opener becomes the info string);
 *   - the doctrine's section labels 'ACTIONS TAKEN' and 'Receipts:'.
 * Paragraph pieces still ≥ 700 chars after the structural split are broken at
 * sentence ends into ~300-char paragraphs (abbreviations skipped).
 *
 * Pure, total, idempotent (its output carries newlines, so a second pass is a
 * no-op). The callers own the kill switch: MARKDOWN_WALL_REPAIR_DISABLED=1
 * (backend persist) / NEXT_PUBLIC_MARKDOWN_WALL_REPAIR_DISABLED=1 (renderer).
 *
 * KEEP IN SYNC with backend/src/modules/crossmodel/wall-of-text.ts (byte-identical below the header).
 */

/** Shorter text is left alone — a short line is never a "wall". */
export const WALL_MIN_CHARS = 400;
/** A paragraph piece at least this long is broken at sentence ends. */
const LONG_PARAGRAPH_CHARS = 700;
/** Target paragraph size for the sentence split. */
const PARAGRAPH_TARGET_CHARS = 300;
const FENCE_LANGS = new Set([
  'bash', 'sh', 'shell', 'zsh', 'console', 'json', 'yaml', 'yml', 'ts', 'typescript', 'js', 'javascript', 'tsx', 'jsx',
  'python', 'py', 'sql', 'diff', 'text', 'txt', 'ini', 'toml', 'go', 'rust', 'html', 'css', 'xml', 'dockerfile', 'powershell', 'ps1',
]);
const ABBREVIATIONS = new Set(['e.g', 'i.e', 'vs', 'etc', 'approx', 'mr', 'mrs', 'ms', 'dr', 'st', 'no', 'fig', 'cf', 'inc', 'ltd', 'jr', 'sr']);

type CutKind = 'para' | 'item';
interface Cut { at: number; kind: CutKind }

/** Odd number of '**' before `i` ⇒ position i is inside a bold span. */
function insideBold(s: string, i: number): boolean {
  return (s.slice(0, i).split('**').length - 1) % 2 === 1;
}

/** The text before `i` ends with a list marker ('1. ' / '- ' / '• '). */
function afterListMarker(s: string, i: number): boolean {
  return /(?:^|\s)(?:\d{1,2}\.|[-•])\s*$/.test(s.slice(Math.max(0, i - 8), i));
}

function lastNonSpace(s: string, i: number): string {
  for (let k = i - 1; k >= 0; k--) if (s[k] !== ' ') return s[k];
  return '';
}

function collectCuts(s: string): { cuts: Cut[]; markers: number } {
  const cuts: Cut[] = [];
  let markers = 0;
  let m: RegExpExecArray | null;

  // Code fences (already replaced by \u0000F<n>\u0000 placeholders): a block on both sides.
  const fenceRe = /\u0000F\d+\u0000/g;
  while ((m = fenceRe.exec(s))) {
    markers++;
    if (m.index > 0) cuts.push({ at: m.index, kind: 'para' });
    const end = m.index + m[0].length;
    if (end < s.length) cuts.push({ at: end, kind: 'para' });
  }

  // Section labels the supervisor doctrine closes with.
  let sectionStart = Infinity;
  const sectionRe = / (ACTIONS TAKEN|Receipts:)(?=\s|$)/g;
  while ((m = sectionRe.exec(s))) {
    const at = m.index + 1;
    if (insideBold(s, at)) continue;
    markers++;
    cuts.push({ at, kind: 'para' });
    sectionStart = Math.min(sectionStart, at);
  }

  // Mid-line ATX headings.
  const headingRe = / (#{2,6}) (?=\S)/g;
  while ((m = headingRe.exec(s))) {
    const at = m.index + 1;
    if (insideBold(s, at)) continue;
    markers++;
    cuts.push({ at, kind: 'para' });
  }

  // Bold labels ending in a colon, and bold leads after a sentence end.
  const boldRe = / (\*\*([^*\u0000]{1,80}?)\*\*(:?))/g;
  while ((m = boldRe.exec(s))) {
    const at = m.index + 1;
    if (insideBold(s, at) || afterListMarker(s, at)) continue;
    const inner = m[2];
    const label = inner.endsWith(':') || m[3] === ':';
    const prev = lastNonSpace(s, at);
    const after = s.slice(at + m[1].length, at + m[1].length + 3);
    // A bold lead: Title-case, ≥ 2 words, AND a block signal — sentence-end
    // punctuation / another bold span before it, a whole bold SENTENCE, or a
    // dash / parenthesis right after it ('**What's NOT done yet** — …').
    const lead = /^[A-Z][^\s]*(?:\s+\S+){1,}/.test(inner) && (
      /[.!?)]/.test(prev)
      || s.slice(Math.max(0, at - 3), at).trimEnd().endsWith('**')
      || /[.!?]$/.test(inner)
      || /^ [—–(-]/.test(after));
    if (!label && !lead) continue;
    markers++;
    cuts.push({ at, kind: 'para' });
  }

  // Bullets.
  const bullets: number[] = [];
  const bulletRe = / ([-•]) (?=\S)/g;
  while ((m = bulletRe.exec(s))) {
    const at = m.index + 1;
    if (at === 0 || insideBold(s, at)) continue;
    const next = s[at + 2];
    const prev = lastNonSpace(s, at);
    if (prev === '-' || prev === '•') continue;
    const ok = at > sectionStart
      || /[A-Z*\u0000[(]/.test(next)
      || (/\d/.test(next) && !/\d/.test(prev));
    if (ok) bullets.push(at);
  }
  if (bullets.length >= 2 || (bullets.length === 1 && bullets[0] > sectionStart)) {
    markers += bullets.length;
    for (const at of bullets) cuts.push({ at, kind: 'item' });
  }

  // Numbered items: an ascending run from 1.
  const nums: Array<{ at: number; n: number }> = [];
  const numRe = / (\d{1,2})\. (?=\S)/g;
  while ((m = numRe.exec(s))) {
    const at = m.index + 1;
    if (!insideBold(s, at)) nums.push({ at, n: Number(m[1]) });
  }
  // The LONGEST ascending run starting at a '1.' (a stray "phase 1." in prose
  // before the real list must not steal the list's first item); ties → the later run.
  let chain: number[] = [];
  nums.forEach((start, si) => {
    if (start.n !== 1) return;
    const run = [start.at];
    let want = 2;
    for (const x of nums.slice(si + 1)) if (x.n === want) { run.push(x.at); want++; }
    if (run.length >= chain.length) chain = run;
  });
  if (chain.length >= 2) {
    markers += chain.length;
    for (const at of chain) cuts.push({ at, kind: 'item' });
  }
  return { cuts, markers };
}

/** Break a long paragraph at sentence ends into ~PARAGRAPH_TARGET_CHARS pieces. */
function splitLongParagraph(p: string): string[] {
  if (p.length < LONG_PARAGRAPH_CHARS) return [p];
  const out: string[] = [];
  let start = 0;
  const re = /([.!?])(\*\*)?( +)(?=[A-Z])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(p))) {
    const end = m.index + m[1].length + (m[2]?.length ?? 0);
    if (end - start < PARAGRAPH_TARGET_CHARS || p.length - end < 120) continue;
    if (insideBold(p, end)) continue;
    // The word before the period (whitespace-led: '07:19Z.' is a clock, not the initial 'Z.').
    const word = (/(?:^|\s)([A-Za-z.]+)$/.exec(p.slice(Math.max(start, m.index - 12), m.index)) ?? ['', ''])[1].toLowerCase();
    if (ABBREVIATIONS.has(word) || /^[a-z]$/.test(word) || /\.[a-z]$/.test(word)) continue;
    out.push(p.slice(start, end).trim());
    start = end + m[3].length;
  }
  out.push(p.slice(start).trim());
  return out.filter(Boolean);
}

function renderFence(body: string): string {
  const b = body.trim();
  const m = /^([A-Za-z0-9_+-]{1,20})\s+(\S[\s\S]*)$/.exec(b);
  if (m && FENCE_LANGS.has(m[1].toLowerCase())) return '```' + m[1] + '\n' + m[2].trim() + '\n```';
  return '```\n' + b + '\n```';
}

/**
 * Re-line one unprotected segment whose newlines were lost. Returns the input
 * untouched unless the wall gate holds (see the module header).
 */
export function repairWallOfText(segment: string): string {
  if (!segment || segment.length < WALL_MIN_CHARS) return segment;
  const lead = /^\s*/.exec(segment)![0];
  const rest = segment.slice(lead.length);
  const trail = /\s*$/.exec(rest)![0];
  const core = rest.slice(0, rest.length - trail.length);
  if (core.length < WALL_MIN_CHARS || core.includes('\n') || core.includes('\u0000')) return segment;
  // Blockquotes and tables are other repairs' territory (markdown-normalize).
  if (core.startsWith('>') || core.startsWith('|') || /\|\s*:?-{3,}/.test(core) || /\| \| \S/.test(core)) return segment;
  if (((core.match(/```/g) || []).length) % 2 === 1) return segment; // an unbalanced fence — never guess

  const fences: string[] = [];
  const codes: string[] = [];
  let s = core.replace(/```([\s\S]*?)```/g, (_m: string, body: string) => { fences.push(body); return `\u0000F${fences.length - 1}\u0000`; });
  s = s.replace(/`[^`]+`/g, (code: string) => { codes.push(code); return `\u0000C${codes.length - 1}\u0000`; });

  const { cuts, markers } = collectCuts(s);
  if (markers < 2) return segment;

  // One cut per position ('para' wins over 'item').
  const byAt = new Map<number, CutKind>();
  for (const c of cuts) {
    if (c.at <= 0 || c.at >= s.length) continue;
    if (byAt.get(c.at) !== 'para') byAt.set(c.at, c.kind);
  }
  const ordered = [...byAt.entries()].sort((a, b) => a[0] - b[0]);
  const pieces: Array<{ text: string; kind: CutKind }> = [];
  let prev = 0;
  let prevKind: CutKind = 'para';
  for (const [at, kind] of ordered) {
    const text = s.slice(prev, at).trim();
    if (text) pieces.push({ text, kind: prevKind });
    prev = at;
    prevKind = kind;
  }
  const tail = s.slice(prev).trim();
  if (tail) pieces.push({ text: tail, kind: prevKind });

  const restore = (t: string) => t
    .replace(/\u0000C(\d+)\u0000/g, (_m: string, k: string) => codes[Number(k)])
    .replace(/\u0000F(\d+)\u0000/g, (_m: string, k: string) => renderFence(fences[Number(k)]));

  const out: string[] = [];
  for (let i = 0; i < pieces.length; i++) {
    const { text, kind } = pieces[i];
    const isItem = kind === 'item';
    const body = isItem ? text.replace(/^•\s/, '- ') : text;
    const paras = isItem || body.startsWith('#') || body.startsWith('\u0000F') ? [body] : splitLongParagraph(body);
    if (i > 0) out.push(isItem ? '\n' : '\n\n');
    out.push(paras.map(restore).join('\n\n'));
  }
  return lead + out.join('') + trail;
}
