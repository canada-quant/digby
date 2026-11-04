'use client';

/**
 * MarkdownContent — the fully-styled chat markdown renderer (headings, lists,
 * bordered tables with horizontal scroll, code blocks, blockquotes, links).
 *
 * Extracted 2026-07-13 from app/crossmodel/page.tsx so ALL chat surfaces render
 * markdown identically. The Digby Code transcript previously used Tailwind
 * `prose` classes — but @tailwindcss/typography wasn't loaded, so tables and
 * headings rendered completely unstyled (cramped text, borderless tables).
 * Size knobs (textSizeCls/h1Cls/…) let each surface pick its density.
 */

import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '@/lib/utils';
import { ListChecks } from 'lucide-react';
import { normalizeMarkdownForRender } from '@/lib/markdown-normalize';
import { isInternalAppLink, linkifySessionRefs } from '@/lib/session-links';
import { chatIdFromDeepLink, linkifyEntityRefs, parseEntityRefHref } from '@/lib/entity-refs';
import { ChatOpenContext } from '@/lib/chat-open-context';
import { rehypeActionsTaken } from '@/lib/rehype-actions-taken';
import { EntityRefChip } from './entity-ref-chip';
import { linkifyWorktreePaths, parseWorktreeLinkHref } from '@/lib/worktree-links';
import { WorktreeOpenContext } from '@/lib/worktree-open-context';
import { memo, useContext, useMemo, useState } from 'react';
import { WorktreeFileLink } from './worktree-file-link';
import { MarkdownCodeBlock } from './markdown-code-block';
import { markdownTableComponents } from './markdown-table';
import { AudioFilePlayer, AuthedFileImage, FileLinkCard, authedImageTarget, isInlineImageUrl, parseFileLinkHref, rewriteFileSchemeLinks } from './file-link-card';
import { ImageLightbox } from './image-lightbox';
import { rehypeStreamWords } from '@/lib/rehype-stream-words';
import { StreamingWordsContext, streamWordFadeEnabled } from '@/lib/stream-words-context';

/**
 * Plain-URL markdown images with click-to-expand (ticket c6e8edda): the img
 * keeps its exact pre-existing classes; a click opens the ImageLightbox with
 * the raw src. MODULE-LEVEL so MarkdownContent's memoized components map
 * keeps a referentially stable renderer entry (an inline closure per render
 * would remount the whole markdown DOM — the streaming-flicker source the
 * useMemo guards against). Chat-file byte routes stay on AuthedFileImage
 * (authed fetch + B1 mime gate — it now self-expands).
 */
function ExpandableImage({ src, alt }: { src?: string; alt?: string }) {
  const [expanded, setExpanded] = useState(false);
  const expandLabel = alt?.trim() ? `Expand image: ${alt.trim()}` : 'Expand image';
  return (
    <>
      <button
        type="button"
        onClick={() => setExpanded(true)}
        title={expandLabel}
        aria-label={expandLabel}
        className="cursor-zoom-in"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt={alt || ''} loading="lazy" className="max-w-full h-auto rounded-lg my-3" />
      </button>
      {expanded && typeof src === 'string' && src && (
        <ImageLightbox src={src} alt={alt} onClose={() => setExpanded(false)} />
      )}
    </>
  );
}

// Flatten react-markdown's code children (string | string[] | nodes) to raw text.
function nodeText(children: any): string {
  if (children == null) return '';
  if (typeof children === 'string') return children;
  if (Array.isArray(children)) return children.map(nodeText).join('');
  if (typeof children === 'object' && 'props' in children) return nodeText(children.props?.children);
  return String(children);
}

// remarkPlugins must be referentially stable too — a new array per render
// makes react-markdown re-run the whole plugin pipeline.
const REMARK_PLUGINS = [remarkGfm];
// Digby Frontier: the streaming answer wraps each word for the fade-in.
const REHYPE_STREAM_WORDS = [rehypeActionsTaken, rehypeStreamWords];
// "ACTIONS TAKEN" + its list → one card (lib/rehype-actions-taken.ts; owner 2026-10-08).
const REHYPE_BASE = [rehypeActionsTaken];

export const MarkdownContent = memo(function MarkdownContent({ children, compact = false, textSizeCls = 'leading-7', h1Cls = 'text-2xl', h2Cls = 'text-xl', h3Cls = 'text-lg', h4Cls = 'text-base', thCls = 'text-sm', tdCls = 'text-sm' }: { children: string; compact?: boolean; textSizeCls?: string; h1Cls?: string; h2Cls?: string; h3Cls?: string; h4Cls?: string; thCls?: string; tdCls?: string }) {
  // A fresh components map every render remounts the ENTIRE rendered markdown
  // DOM of every message on every SSE chunk (react-markdown treats each entry
  // as a new component type) — the single biggest streaming-flicker source.
  // memo above + this useMemo keep historical messages completely inert.
  const openChat = useContext(ChatOpenContext);
  const components = useMemo<Components>(() => ({
        // Paragraphs
        p: ({ children }) => (
          <p className={cn(textSizeCls, 'mb-3 last:mb-0 [overflow-wrap:anywhere]', compact && 'text-sm text-muted-foreground')}>
            {children}
          </p>
        ),

        // Headings (break-words: a long unbroken string in a heading must not
        // overflow the mobile bubble — feedback 36714dda)
        h1: ({ children }) => (
          <h1 className={cn("scroll-m-20 font-bold tracking-tight mt-6 mb-3 first:mt-0 text-foreground [overflow-wrap:anywhere]", h1Cls)}>
            {children}
          </h1>
        ),
        h2: ({ children }) => (
          <h2 className={cn("scroll-m-20 font-semibold tracking-tight mt-5 mb-2 first:mt-0 text-foreground [overflow-wrap:anywhere]", h2Cls)}>
            {children}
          </h2>
        ),
        h3: ({ children }) => (
          <h3 className={cn("scroll-m-20 font-semibold tracking-tight mt-4 mb-2 first:mt-0 text-foreground [overflow-wrap:anywhere]", h3Cls)}>
            {children}
          </h3>
        ),
        h4: ({ children }) => (
          <h4 className={cn("scroll-m-20 font-semibold tracking-tight mt-3 mb-1 text-foreground [overflow-wrap:anywhere]", h4Cls)}>
            {children}
          </h4>
        ),

        // Lists — indent with PADDING, not margin (owner report 2026-09-22:
        // "list numbers are cut off"). Outside markers render to the LEFT of the
        // list box; with `ml-5` the box started 20px in and the marker hung in
        // the parent's gutter, where the transcript's scroll container clipped
        // it — a bullet (~6px) survived, "1."/"10." (24-30px) lost its first
        // glyph. Padding keeps the marker inside the list's own box, so no
        // ancestor overflow can clip it; ol gets the extra 4px two-digit
        // markers need. Same fix in CanvasPanel's renderer.
        ul: ({ children, node }: any) => node?.properties?.dataActionsList ? (
          <ul className="divide-y divide-line">{children}</ul>
        ) : (
          <ul className="my-3 pl-6 list-disc space-y-1.5 marker:text-muted-foreground">
            {children}
          </ul>
        ),
        ol: ({ children, node }: any) => node?.properties?.dataActionsList ? (
          <ol className="divide-y divide-line">{children}</ol>
        ) : (
          <ol className="my-3 pl-7 list-decimal space-y-1.5 marker:tabular-nums">
            {children}
          </ol>
        ),
        li: ({ children, node }: any) => node?.properties?.dataActionItem ? (
          <li className={cn(textSizeCls, 'list-none px-3.5 py-2 leading-relaxed [overflow-wrap:anywhere] [&>p]:m-0')} data-action-item>
            {children}
          </li>
        ) : (
          <li className={cn(textSizeCls, 'pl-1 [overflow-wrap:anywhere]')}>
            {children}
          </li>
        ),

        // "ACTIONS TAKEN" card (lib/rehype-actions-taken.ts): one bordered block, a quiet header, one row per action.
        div: ({ children, node, ...rest }: any) => node?.properties?.dataActionsTaken ? (
          <div className="my-3 overflow-hidden rounded-xl border border-line bg-raised" data-actions-taken>
            <div className="flex items-center gap-1.5 border-b border-line px-3.5 py-2 text-[12px] font-medium text-ink-2">
              <ListChecks className="size-3.5 text-ink-3" aria-hidden />
              Actions taken
            </div>
            {children}
          </div>
        ) : <div {...rest}>{children}</div>,
        span: ({ children, node, ...rest }: any) => node?.properties?.dataActionTool ? (
          <span className="mr-2 inline-flex items-center rounded-md bg-active px-1.5 py-[1px] align-baseline font-mono text-[0.82em] text-ink" data-action-tool>
            {children}
          </span>
        ) : <span {...rest}>{children}</span>,

        // Tables — the shared MarkdownTable slice (plain HTML, NOT shadcn
        // <Table>: a double scroll container breaks iOS momentum scrolling).
        ...markdownTableComponents({ thClassName: thCls, tdClassName: tdCls }),

        // Code — inline chips vs. full fenced blocks. `pre` is a pass-through
        // (below) so fenced blocks render through MarkdownCodeBlock, not a
        // double-wrapped <pre>.
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

        // Block elements
        blockquote: ({ children }) => (
          <blockquote className="my-3 border-l-2 border-line-2 pl-4 italic text-ink-3 [overflow-wrap:anywhere]">
            {children}
          </blockquote>
        ),
        hr: () => <hr className="my-4 border-0 border-t border-border/40" />,

        // Inline
        strong: ({ children }) => (
          <strong className="font-semibold text-foreground">{children}</strong>
        ),
        em: ({ children }) => (
          <em className="italic">{children}</em>
        ),
        // File-route links (agent-generated docs + persisted chat uploads)
        // render as compact download cards, not bare links (ticket 57ef1b9f
        // PR3) — the chat-file byte routes are Bearer-only, so a plain
        // navigation would 401. Two inline promotions sit ABOVE the card/link
        // fallback (c6e8edda follow-up): a chat-file /INLINE route as a bare
        // link renders the image itself via AuthedFileImage (authed +
        // B1-mime-gated, self-expanding — a non-image blob still falls back
        // to the card), and a bare URL whose pathname ends in a known image
        // extension renders the ExpandableImage (synchronous extension check
        // ONLY — no HEAD sniffing; the streaming render must stay sync).
        // Unrecognized hrefs render exactly as before.
        a: ({ href, children }: any) => {
          // Worktree interlinks (owner 2026-09-17): `#worktree:<path>` opens
          // the file in the session's Files tab; plain text outside a session.
          // Answer references (2026-10-08): "session fbb5c9ca" etc. → a chip that opens what it names.
          const ref = parseEntityRefHref(href);
          if (ref) return <EntityRefChip kind={ref.kind} id={ref.id} />;
          const worktreePath = parseWorktreeLinkHref(href);
          if (worktreePath) return <WorktreeFileLink path={worktreePath}>{children}</WorktreeFileLink>;
          const target = parseFileLinkHref(href);
          // A chat-file INLINE route — or a generated image's inline route
          // (2026-09-24) — as a bare link renders the image itself.
          const inlineImage = target?.route === 'inline' ? authedImageTarget(target) : null;
          if (inlineImage && target?.kind === 'chat-file') {
            // Ticket 6c050917: an audio EXTENSION on the link text names a
            // clip the model delivered for LISTENING — route it to the inline
            // AudioFilePlayer instead of the image embed (which would 415
            // on audio bytes and fall back to a download card). The player's
            // own fetched-blob mime gate is the authority; the extension only
            // picks which component mounts.
            const text = nodeText(children).trim();
            const label = text && !text.includes('/api/crossmodel/') ? text : undefined;
            const srcLabel = typeof href === 'string' ? href : '';
            const isAudio = /\.(wav|mp3|m4a|aac|ogg|oga|opus|flac|webm)(?:[?#]|$)/i.test(srcLabel) || /\.(wav|mp3|m4a|aac|ogg|oga|opus|flac|webm)$/i.test(label || '');
            if (isAudio) {
              return <AudioFilePlayer target={{ kind: 'chat-file', id: target.id, route: 'inline' }} filename={label} />;
            }
          }
          if (inlineImage) {
            const text = nodeText(children).trim();
            // An empty or raw-URL link text carries no usable alt label.
            const alt = text && !text.includes('/api/crossmodel/') ? text : undefined;
            return <AuthedFileImage target={inlineImage} alt={alt} />;
          }
          if (target) {
            const text = nodeText(children).trim();
            // An empty or raw-URL link text carries no usable filename.
            const filename = text && !text.includes('/api/crossmodel/') ? text : 'Download file';
            return <FileLinkCard filename={filename} target={target} />;
          }
          // Internal deep links (feedback b8e1b0a3 — session interlinks, e.g.
          // /?chatId=<uuid>, legacy /crossmodel?chatId=<uuid>) navigate SAME-TAB
          // like the app's own router.push pattern; target=_blank would spawn a
          // duplicate app.
          if (isInternalAppLink(href)) {
            // Inside the chat view a session link switches chats in place (no app reload).
            const deepChatId = openChat ? chatIdFromDeepLink(href) : null;
            return (
              <a
                href={href}
                onClick={deepChatId ? (e) => { e.preventDefault(); openChat!(deepChatId); } : undefined}
                className="text-ink underline decoration-line-2 underline-offset-[3px] hover:decoration-ink-3 transition-colors break-all"
              >
                {children}
              </a>
            );
          }
          if (isInlineImageUrl(href)) {
            const text = nodeText(children).trim();
            // A bare-URL link text (the common case) is not alt text.
            const alt = text && text !== href ? text : undefined;
            return <ExpandableImage src={typeof href === 'string' ? href : undefined} alt={alt} />;
          }
          return (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-ink underline decoration-line-2 underline-offset-[3px] hover:decoration-ink-3 transition-colors break-all"
            >
              {children}
            </a>
          );
        },
        // Images must never force the bubble wider than the viewport (feedback
        // 36714dda — mobile overflow from large messages). A chat-file byte
        // route as the src embeds via an authed fetch (AuthedFileImage gates
        // on the FETCHED mime — html/svg never blob-render, review B1);
        // ordinary URLs keep the plain <img> path. Both expand on click
        // (ticket c6e8edda — AuthedFileImage self-expands; ExpandableImage
        // wraps the plain path).
        img: ({ src, alt }: any) => {
          // Any chat-file route, or a generated image's INLINE route
          // (2026-09-24 — defence in depth when a model embeds the
          // transcript part's url as markdown anyway), fetches with auth.
          const target = authedImageTarget(parseFileLinkHref(typeof src === 'string' ? src : undefined));
          if (target) {
            return <AuthedFileImage target={target} alt={alt} />;
          }
          return <ExpandableImage src={typeof src === 'string' ? src : undefined} alt={alt} />;
        },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [compact, textSizeCls, h1Cls, h2Cls, h3Cls, h4Cls, thCls, tdCls, openChat]);

  // Repair degraded model output (missing blank lines before headings/lists,
  // fully-collapsed single-line answers) before CommonMark sees it — models
  // progressively drop blank lines in long conversations (feedback fc841f58).
  // rewriteFileSchemeLinks runs FIRST (ticket 8db4c18e): a bare `file:<uuid>`
  // link destination (model deviation — the backend only ever returns the
  // /api download route) is rewritten to the canonical route here, because
  // react-markdown's defaultUrlTransform blanks the file: scheme and the
  // resulting href="" + target=_blank anchor reloaded the whole app. The
  // urlTransform security default stays untouched.
  // linkifySessionRefs (feedback b8e1b0a3) then turns bare chat/session UUIDs
  // into /crossmodel?chatId= deep links — render-time only, so notes stored
  // before it shipped heal here; code/link/HTML spans are protected by the
  // renderer's OWN parser (remark), so protection is parser-parity by
  // construction (review rounds R1–R10).
  // linkifyWorktreePaths (owner 2026-09-17) runs ONLY beneath a coding
  // session (WorktreeOpenContext set): bare repo paths in prose become
  // Files-tab links; plain chats never see the rewrite.
  // Memoized on the raw text so historical messages stay inert while streaming.
  const canOpenWorktree = useContext(WorktreeOpenContext) !== null;
  const streamingWords = useContext(StreamingWordsContext) && streamWordFadeEnabled();
  const normalized = useMemo(() => {
    // linkifyEntityRefs (2026-10-08): "session fbb5c9ca" / "goal …" / "todo …" / "receipt …" → clickable chips.
    const linked = linkifyEntityRefs(linkifySessionRefs(rewriteFileSchemeLinks(children)));
    return normalizeMarkdownForRender(canOpenWorktree ? linkifyWorktreePaths(linked) : linked);
  }, [children, canOpenWorktree]);

  return (
    <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={streamingWords ? REHYPE_STREAM_WORDS : REHYPE_BASE} components={components}>
      {normalized}
    </ReactMarkdown>
  );
});

export default MarkdownContent;
