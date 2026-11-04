/**
 * Every UTC clock on screen in the viewer's own time zone (owner 2026-10-16: "i also want utc timezones everywhere
 * in the ui to auto detect and translate into the users browser or device timezone … ie 17:39Z in Message from
 * crossmodel Supervisor · idle since 17:39Z").
 *
 * lib/localize-utc-times.ts already rewrites machine-authored message bodies, but harness-written TITLES ("… · idle
 * since 17:39Z"), "Message from …" lines, task cards, panels, tooltips and toasts are rendered in ~60 places. Rather
 * than thread the helper through each one, the app mounts ONE watcher (app/crossmodel/UtcClockLocalizer.tsx) that
 * rewrites zoned clocks in rendered text nodes and `title` tooltips as they appear, using the same rules as
 * localizeUtcTimes ("17:39Z" → "1:39 PM" in Toronto). Presentation-only — stored text, inputs, textareas, editable
 * regions and code (<code>, <pre>) are never touched, and a node is rewritten only when its text changes, so React's
 * own later updates simply re-run it.
 *
 * The DOM surface is typed structurally (no lib.dom import) so the logic is testable without a browser.
 */

import { hasUtcClock, localizeUtcTimes } from './localize-utc-times';

export interface ElementLike {
  nodeType: number;
  tagName?: string;
  parentNode?: ElementLike | null;
  getAttribute?(name: string): string | null;
  setAttribute?(name: string, value: string): void;
  isContentEditable?: boolean;
}

export interface TextNodeLike {
  nodeType: number;
  nodeValue: string | null;
  parentNode?: ElementLike | null;
}

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

/** Tags whose text is never a display clock (code, scripts) or is the user's own editable input. */
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'CODE', 'PRE', 'KBD', 'SAMP', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION', 'SVG']);

/** True when the element (or an ancestor) is code, a script, an input or an opt-out (`data-no-localize`). */
export function insideSkippedElement(el: ElementLike | null | undefined): boolean {
  for (let cur = el; cur && cur.nodeType === ELEMENT_NODE; cur = cur.parentNode ?? null) {
    const tag = String(cur.tagName || '').toUpperCase();
    if (SKIP_TAGS.has(tag)) return true;
    if (cur.isContentEditable) return true;
    if (cur.getAttribute && cur.getAttribute('data-no-localize') != null) return true;
  }
  return false;
}

/** Cheap pre-check before the regex pass: a digit-colon-digit pair and a Z / UTC marker. */
function mayCarryClock(s: string): boolean {
  return /\d:\d\d/.test(s) && /Z|UTC/.test(s);
}

/** Rewrite one text node's zoned clocks in place. Returns true when it changed. Never throws. */
export function localizeTextNode(node: TextNodeLike): boolean {
  try {
    if (!node || node.nodeType !== TEXT_NODE) return false;
    const text = node.nodeValue;
    if (!text || !mayCarryClock(text) || !hasUtcClock(text)) return false;
    if (insideSkippedElement(node.parentNode)) return false;
    const next = localizeUtcTimes(text);
    if (next === text) return false;
    node.nodeValue = next;
    return true;
  } catch {
    return false;
  }
}

/** Rewrite an element's `title` tooltip. Returns true when it changed. Never throws. */
export function localizeTitleAttr(el: ElementLike): boolean {
  try {
    if (!el || el.nodeType !== ELEMENT_NODE || !el.getAttribute || !el.setAttribute) return false;
    const title = el.getAttribute('title');
    if (!title || !mayCarryClock(title) || !hasUtcClock(title)) return false;
    if (insideSkippedElement(el.parentNode)) return false;
    const next = localizeUtcTimes(title);
    if (next === title) return false;
    el.setAttribute('title', next);
    return true;
  } catch {
    return false;
  }
}

/**
 * Start watching `root` (browser only): one pass over what is already rendered, then every added node, text change
 * and `title` change. Returns a stop function. Our own rewrites produce text with no zoned clock left, so the
 * mutations they cause end the loop on the next check.
 */
export function startDomUtcLocalizer(root: Node): () => void {
  const sweep = (start: Node) => {
    if (start.nodeType === TEXT_NODE) { localizeTextNode(start as unknown as TextNodeLike); return; }
    if (start.nodeType !== ELEMENT_NODE) return;
    localizeTitleAttr(start as unknown as ElementLike);
    const doc = start.ownerDocument || (start as Document);
    const walker = doc.createTreeWalker(start, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.nodeType === TEXT_NODE) localizeTextNode(n as unknown as TextNodeLike);
      else localizeTitleAttr(n as unknown as ElementLike);
    }
  };
  sweep(root);
  const observer = new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'characterData') localizeTextNode(r.target as unknown as TextNodeLike);
      else if (r.type === 'attributes') localizeTitleAttr(r.target as unknown as ElementLike);
      else r.addedNodes.forEach((n) => sweep(n));
    }
  });
  observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['title'] });
  return () => observer.disconnect();
}
