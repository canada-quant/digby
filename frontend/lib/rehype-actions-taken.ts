/**
 * "ACTIONS TAKEN" as a card (owner 2026-10-08: "actions taken would look nicer if it was formatted").
 *
 * Supervisor answers close with the wake marker line "ACTIONS TAKEN" (backend platform/core-doctrine.ts
 * WAKE_ACTION_MARKER) followed by a list, one action per item — "goal_create → goal 534c37aa — …". This rehype
 * pass finds that heading line (a paragraph or heading whose whole text is the marker, optional bold / colon) with a
 * list right after it, and replaces both with ONE `div[data-actions-taken]` holding the list
 * (`ul|ol[data-actions-list]`, items `li[data-action-item]`). An item that LEADS with a snake_case tool name and an
 * arrow / dash ("todo_create ×3 → …") gets that name split into `span[data-action-tool]` so the renderer shows it as
 * a label. Rendering: markdown-content.tsx. Text is never changed, only grouped; anything that does not match the
 * shape is left exactly as it was.
 */

interface HastText { type: 'text'; value: string }
interface HastElement { type: 'element'; tagName: string; properties?: Record<string, unknown>; children: HastNode[] }
type HastNode = HastText | HastElement | { type: string; children?: HastNode[]; value?: string };

function textOf(node: HastNode): string {
  if (node.type === 'text') return (node as HastText).value;
  return ((node as { children?: HastNode[] }).children ?? []).map(textOf).join('');
}

const MARKER_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
/** "ACTIONS TAKEN", any case, optional trailing colon. */
export function isActionsTakenMarker(text: string): boolean {
  return /^actions taken:?$/i.test(text.replace(/\s+/g, ' ').trim());
}

/** A leading tool name: `snake_case` (≥1 underscore), optional "×3", then an arrow / dash / colon. */
const TOOL_LEAD_RE = /^(\s*)([a-z][a-z0-9]*(?:_[a-z0-9]+)+)((?:\s*[×x]\s*\d+)?)\s*(?:→|->|—|–|:)\s*/;

function markToolLead(li: HastElement): void {
  // Loose lists wrap the item in <p>: look one level down.
  let host: HastElement = li;
  const firstEl = li.children.find(c => c.type === 'element') as HastElement | undefined;
  const firstText = li.children.find(c => c.type === 'text' && (c as HastText).value.trim()) as HastText | undefined;
  if (!firstText && firstEl && firstEl.tagName === 'p') host = firstEl;
  const idx = host.children.findIndex(c => c.type === 'text' ? !!(c as HastText).value.trim() : true);
  if (idx < 0 || host.children[idx].type !== 'text') return;
  const t = host.children[idx] as HastText;
  const m = TOOL_LEAD_RE.exec(t.value);
  if (!m) return;
  const tool = `${m[2]}${m[3] ? ` ${m[3].replace(/\s+/g, '').replace(/^x/, '×')}` : ''}`;
  const rest = t.value.slice(m[0].length);
  const replacement: HastNode[] = [
    { type: 'element', tagName: 'span', properties: { dataActionTool: true }, children: [{ type: 'text', value: tool }] },
  ];
  if (rest) replacement.push({ type: 'text', value: rest });
  host.children.splice(idx, 1, ...replacement);
}

function walk(node: HastNode): void {
  const kids = (node as { children?: HastNode[] }).children;
  if (!kids) return;
  for (let i = 0; i < kids.length; i++) {
    const el = kids[i];
    if (el.type !== 'element') continue;
    const e = el as HastElement;
    if (MARKER_TAGS.has(e.tagName) && isActionsTakenMarker(textOf(e))) {
      let j = i + 1;
      while (j < kids.length && kids[j].type === 'text' && !(kids[j] as HastText).value.trim()) j++;
      const list = kids[j] as HastElement | undefined;
      if (list && list.type === 'element' && (list.tagName === 'ul' || list.tagName === 'ol')) {
        list.properties = { ...(list.properties ?? {}), dataActionsList: true };
        for (const li of list.children) {
          if (li.type === 'element' && (li as HastElement).tagName === 'li') {
            const item = li as HastElement;
            item.properties = { ...(item.properties ?? {}), dataActionItem: true };
            markToolLead(item);
          }
        }
        const card: HastElement = { type: 'element', tagName: 'div', properties: { dataActionsTaken: true }, children: [list] };
        kids.splice(i, j - i + 1, card);
        continue;
      }
    }
    walk(e);
  }
}

/** The rehype plugin (attacher → transformer). */
export function rehypeActionsTaken() {
  return (tree: HastNode) => { walk(tree); };
}
