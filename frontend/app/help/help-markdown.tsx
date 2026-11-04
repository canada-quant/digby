'use client';

/**
 * HelpMarkdown — the /help doc renderer. Uses the SAME markdown stack as the
 * chat transcript (react-markdown + remark-gfm, plus the shared
 * MarkdownCodeBlock for fenced code) with a components map whose classes mirror
 * MarkdownContent (components/ui/custom/prompt/markdown-content.tsx) so docs
 * look identical to chat prose. Deliberately a separate component rather than
 * reusing MarkdownContent: chat-only behaviors (chat-file download cards,
 * session-UUID linkification, image lightbox) would mangle doc content — e.g.
 * example UUIDs in API docs must NOT become /crossmodel?chatId= links.
 *
 * Doc-link rewriting: relative same-repo .md links (./X.md, ../docs/X.md,
 * docs/X.md) resolve against the doc's repo path (manifest `source`) and become
 * /help/<slug> when the target is in the synced allowlist; unresolvable repo
 * links render as plain text instead of a broken navigation; external/absolute
 * links are untouched (new tab). Anchor fragments are preserved and headings
 * render with GitHub-style ids, so ./X.md#section deep links work.
 */

import Link from 'next/link';
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { memo, useMemo } from 'react';
import { MarkdownCodeBlock } from '@/components/ui/custom/prompt/markdown-code-block';
import { markdownTableComponents } from '@/components/ui/custom/prompt/markdown-table';
import { rewriteDocHref, slugifyHeading } from '@/lib/help-links';

// Flatten react-markdown children (string | string[] | nodes) to raw text.
function nodeText(children: any): string {
  if (children == null) return '';
  if (typeof children === 'string') return children;
  if (Array.isArray(children)) return children.map(nodeText).join('');
  if (typeof children === 'object' && 'props' in children) return nodeText(children.props?.children);
  return String(children);
}

const REMARK_PLUGINS = [remarkGfm];

const LINK_CLS = 'font-medium text-primary underline underline-offset-4 hover:opacity-80 transition-opacity break-all';

export const HelpMarkdown = memo(function HelpMarkdown({
  content,
  currentSource,
  docs,
}: {
  content: string;
  /** Repo-relative source path of THIS doc (e.g. "docs/SELF_HOST.md"). */
  currentSource: string;
  /** slug ↔ source pairs for every synced doc (the allowlist). */
  docs: { slug: string; source: string }[];
}) {
  const slugBySource = useMemo(() => new Map(docs.map((d) => [d.source, d.slug])), [docs]);

  const urlTransform = useMemo(
    () => (url: string) => rewriteDocHref(url, currentSource, slugBySource) ?? defaultUrlTransform(url),
    [currentSource, slugBySource],
  );

  // Stable components map (see MarkdownContent: a fresh map per render remounts
  // the whole markdown DOM).
  const components = useMemo<Components>(() => ({
    p: ({ children }) => (
      <p className="leading-7 mb-3 last:mb-0 [overflow-wrap:anywhere]">{children}</p>
    ),

    // Headings get GitHub-style ids so #anchor links (in-doc and cross-doc)
    // land; scroll-mt clears the sticky page header.
    h1: ({ children }) => (
      <h1 id={slugifyHeading(nodeText(children))} className="scroll-mt-20 text-2xl font-bold tracking-tight mt-6 mb-3 first:mt-0 text-foreground [overflow-wrap:anywhere]">
        {children}
      </h1>
    ),
    h2: ({ children }) => (
      <h2 id={slugifyHeading(nodeText(children))} className="scroll-mt-20 text-xl font-semibold tracking-tight mt-6 mb-2 first:mt-0 text-foreground [overflow-wrap:anywhere]">
        {children}
      </h2>
    ),
    h3: ({ children }) => (
      <h3 id={slugifyHeading(nodeText(children))} className="scroll-mt-20 text-lg font-semibold tracking-tight mt-4 mb-2 first:mt-0 text-foreground [overflow-wrap:anywhere]">
        {children}
      </h3>
    ),
    h4: ({ children }) => (
      <h4 id={slugifyHeading(nodeText(children))} className="scroll-mt-20 text-base font-semibold tracking-tight mt-3 mb-1 text-foreground [overflow-wrap:anywhere]">
        {children}
      </h4>
    ),

    ul: ({ children }) => (
      <ul className="my-3 pl-6 list-disc space-y-1.5 marker:text-muted-foreground">{children}</ul>
    ),
    ol: ({ children }) => (
      <ol className="my-3 pl-7 list-decimal space-y-1.5 marker:tabular-nums">{children}</ol>
    ),
    li: ({ children }) => (
      <li className="leading-7 pl-1 [overflow-wrap:anywhere]">{children}</li>
    ),

    // Tables — the shared MarkdownTable slice (same pattern as chat).
    ...markdownTableComponents({ thClassName: 'text-sm', tdClassName: 'text-sm' }),

    // Code — inline chips vs. fenced blocks via the shared chat code block.
    code: ({ className, children }: any) => {
      const match = /language-(\w+)/.exec(className || '');
      const isBlock = !!match || /\n/.test(nodeText(children));
      if (!isBlock) {
        return (
          <code className="relative rounded bg-muted px-[0.35rem] py-[0.15rem] font-mono text-[0.85em] text-foreground break-all [overflow-wrap:anywhere]">
            {children}
          </code>
        );
      }
      return (
        <MarkdownCodeBlock
          language={match?.[1] || 'text'}
          code={nodeText(children).replace(/\n$/, '')}
        />
      );
    },
    pre: ({ children }: any) => <>{children}</>,

    blockquote: ({ children }) => (
      <blockquote className="my-3 border-l-4 border-primary/50 pl-4 italic text-muted-foreground bg-muted/20 py-2 pr-2 rounded-r-md [overflow-wrap:anywhere]">
        {children}
      </blockquote>
    ),
    hr: () => <hr className="my-4 border-0 border-t border-border/40" />,

    strong: ({ children }) => (
      <strong className="font-semibold text-foreground">{children}</strong>
    ),
    em: ({ children }) => <em className="italic">{children}</em>,

    a: ({ href, children }: any) => {
      if (typeof href === 'string') {
        // Allowlisted repo doc — urlTransform already rewrote it; navigate
        // in-app (Next Link, no new tab).
        if (href.startsWith('/help/')) {
          return <Link href={href} className={LINK_CLS}>{children}</Link>;
        }
        // In-doc anchor.
        if (href.startsWith('#')) {
          return <a href={href} className={LINK_CLS}>{children}</a>;
        }
        // Repo doc link NOT in the allowlist — plain text instead of a
        // guaranteed-broken relative navigation.
        if (/\.md($|#)/i.test(href) && !/^[a-z][a-z0-9+.-]*:/i.test(href)) {
          return <span className="text-muted-foreground">{children}</span>;
        }
      }
      return (
        <a href={href} target="_blank" rel="noopener noreferrer" className={LINK_CLS}>
          {children}
        </a>
      );
    },

    // The synced docs carry no images today; keep a sane plain renderer.
    img: ({ src, alt }: any) => (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={typeof src === 'string' ? src : undefined} alt={alt || ''} loading="lazy" className="max-w-full h-auto rounded-lg my-3" />
    ),
  }), []);

  return (
    <ReactMarkdown remarkPlugins={REMARK_PLUGINS} urlTransform={urlTransform} components={components}>
      {content}
    </ReactMarkdown>
  );
});

export default HelpMarkdown;
