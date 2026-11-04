'use client';

/**
 * MarkdownCodeBlock — the chat code-fence renderer used by MarkdownContent.
 *
 * Matches the frontier chat UIs (ChatGPT / Claude / Gemini): a slim header bar
 * with the language label + a copy button, syntax-highlighted body, and a
 * subtle single-surface frame (no double borders / heavy shadow).
 *
 * Highlighting uses shiki in DUAL-THEME mode (github-light / github-dark) via
 * CSS variables, so the same rendered HTML follows the app's light/dark class
 * with no re-highlight. The `.shiki` variable-swap rules live in globals.css.
 * Before shiki hydrates we show plain monospace so streaming code never blanks.
 *
 * Highlight HTML cache (2026-08-31 session-open perf): reopening a chat
 * re-highlighted EVERY fence through shiki's async pipeline — the visible last
 * thing to settle. Results are cached by content (verified, not just hash-
 * keyed, so a collision can never swap in foreign code) and a revisit renders
 * highlighted code on the first paint. Bounded LRU.
 */

import { cn } from '@/lib/utils';
import { Check, Copy } from 'lucide-react';
import { memo, useEffect, useState } from 'react';
import { codeToHtml } from 'shiki';

const SHIKI_CACHE_MAX = 100;
const shikiHtmlCache = new Map<string, { code: string; html: string }>();

function shikiCacheKey(lang: string, code: string): string {
  // djb2 — cheap; collisions are caught by the stored-code verify in the get.
  let h = 5381;
  for (let i = 0; i < code.length; i++) h = ((h << 5) + h + code.charCodeAt(i)) | 0;
  return `${lang}:${code.length}:${h}`;
}

function shikiCacheGet(lang: string, code: string): string | null {
  const key = shikiCacheKey(lang, code);
  const hit = shikiHtmlCache.get(key);
  if (!hit || hit.code !== code) return null;
  shikiHtmlCache.delete(key); // re-insert at the tail = most-recently-used
  shikiHtmlCache.set(key, hit);
  return hit.html;
}

function shikiCacheSet(lang: string, code: string, html: string): void {
  const key = shikiCacheKey(lang, code);
  shikiHtmlCache.delete(key);
  shikiHtmlCache.set(key, { code, html });
  while (shikiHtmlCache.size > SHIKI_CACHE_MAX) {
    const oldest = shikiHtmlCache.keys().next().value;
    if (oldest === undefined) break;
    shikiHtmlCache.delete(oldest);
  }
}

// Friendly labels for the header; falls back to the raw token upper-cased.
const LANG_LABELS: Record<string, string> = {
  ts: 'TypeScript', tsx: 'TSX', js: 'JavaScript', jsx: 'JSX', py: 'Python',
  python: 'Python', rb: 'Ruby', go: 'Go', rs: 'Rust', java: 'Java', kt: 'Kotlin',
  c: 'C', cpp: 'C++', cs: 'C#', php: 'PHP', swift: 'Swift', sh: 'Shell', bash: 'Shell',
  zsh: 'Shell', json: 'JSON', yaml: 'YAML', yml: 'YAML', toml: 'TOML', md: 'Markdown',
  html: 'HTML', css: 'CSS', scss: 'SCSS', sql: 'SQL', graphql: 'GraphQL', diff: 'Diff',
  dockerfile: 'Dockerfile', text: 'Text', plaintext: 'Text',
};

// shiki bundles a large grammar set; unknown langs fall back to plaintext so a
// stray fence (```mermaid, ```env) never throws mid-stream.
const KNOWN_LANGS = new Set(Object.keys(LANG_LABELS).concat([
  'tsx', 'jsx', 'xml', 'ini', 'makefile', 'perl', 'lua', 'r', 'scala', 'objc',
  'proto', 'hcl', 'vue', 'svelte', 'astro', 'prisma', 'nginx',
]));

function labelFor(lang: string): string {
  return LANG_LABELS[lang] || lang.toUpperCase();
}

export const MarkdownCodeBlock = memo(function MarkdownCodeBlock({
  code,
  language,
}: {
  code: string;
  language: string;
}) {
  const lang = (language || 'text').toLowerCase();
  const shikiLang = KNOWN_LANGS.has(lang) ? lang : 'text';
  // Seed from the highlight cache — a remount (chat switch) renders highlighted
  // code on the FIRST paint instead of flashing the plain <pre> for a beat.
  const [html, setHtml] = useState<string | null>(() => shikiCacheGet(shikiLang, code));
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const cached = shikiCacheGet(shikiLang, code);
    if (cached) { setHtml(cached); return; }
    let cancelled = false;
    (async () => {
      try {
        const out = await codeToHtml(code, {
          lang: shikiLang,
          themes: { light: 'github-light', dark: 'github-dark' },
          defaultColor: false,
        });
        shikiCacheSet(shikiLang, code, out);
        if (!cancelled) setHtml(out);
      } catch {
        if (!cancelled) setHtml(null);
      }
    })();
    return () => { cancelled = true; };
  }, [code, shikiLang]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard blocked — no-op */ }
  };

  return (
    <div className="not-prose my-4 overflow-hidden rounded-xl border border-line bg-bg-2 font-sans">
      <div className="flex items-center justify-between border-b border-line px-3.5 py-1.5">
        <span className="font-mono text-[11.5px] text-ink-3 select-none">
          {labelFor(lang)}
        </span>
        <button
          type="button"
          onClick={copy}
          aria-label="Copy code"
          className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11.5px] text-ink-3 transition-colors hover:bg-hover hover:text-ink"
        >
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      {html ? (
        <div
          className={cn(
            'shiki-body overflow-x-auto text-[13px] leading-relaxed',
            '[&>pre]:!bg-transparent [&>pre]:px-4 [&>pre]:py-3.5 [&>pre]:min-w-full',
          )}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <div className="overflow-x-auto px-4 py-3.5 text-[13px] leading-relaxed">
          <pre className="min-w-full"><code className="font-mono">{code}</code></pre>
        </div>
      )}
    </div>
  );
});

export default MarkdownCodeBlock;
