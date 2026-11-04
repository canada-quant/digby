/**
 * rehype-stream-words (Digby Frontier redesign, 2026-10-06): while an answer
 * STREAMS, every word of its prose is wrapped in `<span class="dg-word">` so a
 * newly appended word fades in (opacity + a 3px blur clearing, 420ms) instead
 * of popping. React keeps the already-rendered spans (same position, same
 * type), so only the words that just arrived animate. Code (`pre`/`code`),
 * math-ish `kbd` and SVG are left untouched. On `complete` the message leaves
 * the streaming context and renders as normal markdown again.
 *
 * Pure + dependency-free (a hand-rolled hast walk) — pinned in vitest.
 */

interface HastText { type: 'text'; value: string }
interface HastElement { type: 'element'; tagName: string; properties?: Record<string, unknown>; children: HastNode[] }
interface HastRoot { type: 'root'; children: HastNode[] }
type HastNode = HastText | HastElement | HastRoot | { type: string; children?: HastNode[]; value?: string };

const SKIP_TAGS = new Set(['pre', 'code', 'kbd', 'svg', 'script', 'style']);

/** Split a text value into word spans, keeping whitespace as plain text. */
export function splitWords(value: string): HastNode[] {
  const out: HastNode[] = [];
  const re = /(\s+)/;
  for (const piece of value.split(re)) {
    if (!piece) continue;
    if (re.test(piece)) out.push({ type: 'text', value: piece });
    else out.push({ type: 'element', tagName: 'span', properties: { className: ['dg-word'] }, children: [{ type: 'text', value: piece }] });
  }
  return out;
}

function walk(node: HastNode): void {
  const kids = (node as { children?: HastNode[] }).children;
  if (!kids) return;
  const next: HastNode[] = [];
  for (const child of kids) {
    if (child.type === 'text') {
      next.push(...splitWords((child as HastText).value));
    } else {
      if (!(child.type === 'element' && SKIP_TAGS.has((child as HastElement).tagName))) walk(child);
      next.push(child);
    }
  }
  (node as { children: HastNode[] }).children = next;
}

/** The rehype plugin (attacher → transformer). */
export function rehypeStreamWords() {
  return (tree: HastNode) => { walk(tree); };
}
