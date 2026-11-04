/**
 * P4 — pattern-library dedup pins (UI overhaul Phase 4).
 *
 * SOURCE-LEVEL pins (the phase0/c1 idiom — anchor on stable identifiers):
 *
 * 1. ONE markdown table renderer: the four surfaces that used to carry
 *    byte-alike copies of the react-markdown table override (one of which had
 *    silently dropped the iOS momentum-scroll fix) must import the shared
 *    markdownTableComponents slice, and the shared module must keep the fix.
 *
 * 2. Dialog phone gutter: DialogContent's edge gutter rides WIDTH
 *    (w-[calc(100%-2rem)]). ~14 callers pass an unprefixed max-w-* which
 *    tailwind-merge resolves against a max-width-based gutter — stripping it
 *    made those dialogs edge-to-edge on small phones. Width is a different
 *    tw-merge group, so caller max-w-* caps the dialog without removing the
 *    gutter — as long as no caller passes an unprefixed w-* utility. Both
 *    halves are pinned.
 *
 * 3. Dead primitives stay dead: the zero-importer shadcn primitives deleted in
 *    P4 (including the competing Radix toast system — Sonner is the toast
 *    system) must not quietly return.
 *
 * 4. DigbyLoader styles are global: the per-instance <style> tag is gone; the
 *    float keyframes live once in globals.css.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';

const FRONTEND_ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string): string => readFileSync(join(FRONTEND_ROOT, rel), 'utf8');

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === 'node_modules' || name === '.next') continue;
      yield* walk(p);
    } else if (/\.(tsx?|jsx?)$/.test(name)) yield p;
  }
}

// ── 1. one markdown table renderer ──────────────────────────────────────────
const SHARED_TABLE = 'components/ui/custom/prompt/markdown-table.tsx';
const TABLE_SITES = [
  'components/ui/custom/prompt/markdown-content.tsx',
  'app/help/help-markdown.tsx',
  'app/crossmodel/components/CanvasPanel.tsx',
  'app/crossmodel/shared/chat/[token]/page.tsx',
];

describe('P4.1 — the four markdown table surfaces use the shared MarkdownTable slice', () => {
  it('the shared module owns the scroll container and the iOS momentum fix', () => {
    const src = read(SHARED_TABLE);
    expect(src).toContain("WebkitOverflowScrolling: 'touch'");
    expect(src).toContain('overflow-x-auto');
    expect(src).toContain('export function markdownTableComponents');
  });

  for (const rel of TABLE_SITES) {
    it(`${rel} imports the shared slice and carries no local table copy`, () => {
      const src = read(rel);
      expect(src).toContain('markdownTableComponents(');
      // A re-grown local copy would re-introduce the wrapper inline:
      expect(src).not.toContain('WebkitOverflowScrolling');
      expect(src).not.toMatch(/table:\s*\(\{\s*children\s*\}\)/);
    });
  }
});

// ── 2. dialog phone gutter ───────────────────────────────────────────────────
describe('P4.2 — DialogContent keeps its phone-edge gutter', () => {
  it('the gutter rides width (tw-merge-proof against caller max-w-*)', () => {
    const src = read('components/ui/dialog.tsx');
    expect(src).toContain('w-[calc(100%-2rem)]');
    expect(src).toContain('max-w-[calc(100%-2rem)]');
  });

  it('no DialogContent call site passes an unprefixed w-* utility (it would strip the gutter width)', () => {
    const violations: string[] = [];
    for (const base of ['app', 'components']) {
      for (const abs of walk(join(FRONTEND_ROOT, base))) {
        const rel = abs.slice(FRONTEND_ROOT.length).replace(/\\/g, '/');
        if (rel === 'components/ui/dialog.tsx') continue;
        if (/\.test\.(t|j)sx?$/.test(rel)) continue;
        const src = readFileSync(abs, 'utf8');
        // Every <DialogContent …> opening tag with a string-literal className.
        for (const m of src.matchAll(/<DialogContent\b[^>]*className="([^"]*)"/gs)) {
          for (const cls of m[1].split(/\s+/)) {
            if (/^w-/.test(cls)) violations.push(`${rel}: <DialogContent className contains "${cls}">`);
          }
        }
      }
    }
    expect(
      violations,
      'unprefixed w-* on DialogContent strips the phone gutter (same tw-merge group as the default width) — ' +
        'size dialogs with max-w-* instead:\n' + violations.join('\n'),
    ).toEqual([]);
  });
});

// ── 3. dead primitives stay dead ─────────────────────────────────────────────
const DELETED_PRIMITIVES = [
  'accordion', 'alert', 'aspect-ratio', 'avatar', 'breadcrumb', 'button-group',
  'calendar', 'carousel', 'collapsible', 'context-menu', 'drawer', 'field',
  'hover-card', 'input-group', 'input-otp', 'item', 'kanban', 'kbd',
  'native-select', 'pagination', 'sheet', 'slider', 'timeline', 'toast', 'tooltip',
];

describe('P4.3 — deleted zero-importer primitives do not return', () => {
  it('none of the P4-deleted components/ui files exist', () => {
    const returned = DELETED_PRIMITIVES.filter((name) =>
      existsSync(join(FRONTEND_ROOT, 'components/ui', `${name}.tsx`)),
    );
    expect(
      returned,
      `P4 deleted these as zero-importer dead code (toast = the competing Radix toast system; ` +
        `Sonner is the app's toast system). Re-adding one needs a real importer and a reason:\n` +
        returned.join(', '),
    ).toEqual([]);
  });
});

// ── 4. DigbyLoader styles are global ─────────────────────────────────────────
describe('P4.4 — DigbyLoader no longer injects a per-instance <style> tag', () => {
  it('the component has no <style> tag; globals.css owns the float keyframes', () => {
    expect(read('components/ui/custom/DigbyLoader.tsx')).not.toContain('<style>');
    const globals = read('app/globals.css');
    expect(globals).toContain('@keyframes digby-loader-float');
    expect(globals).toContain('.digby-loader');
  });
});
