import Link from 'next/link';
import Image from 'next/image';
import { CHAT_HREF, resolveRelated, splitLead, type ComparisonTableData, type ContentLink, type ContentSection, type Faq } from '@/lib/site/content';
import { chatPrefillHref, PREFILL_PARAM } from '@/lib/chat-prefill';
import { siteStrings, two } from '@/lib/site/strings';
import { SiteLink } from './SiteChrome';
import PlatformCta from './PlatformCta';
import { isInstallerHref, isSelfHostedBuild } from '@/lib/site/instance';

/**
 * Building blocks for landing pages + guides (2026-10-16 redesign — mobile
 * first, with an editorial two-column layout from lg). Server components;
 * disclosures are native <details>. Tokens only (bg-send / text-send-ink invert
 * correctly in dark mode).
 */

/**
 * The "inverse" slab (one per page + the closing CTA): ink on paper in light
 * mode; in dark mode a raised dark panel with a hairline instead of a large
 * light-grey slab (2026-10-16 site review).
 */
const INV = {
  slab: 'bg-send text-send-ink dark:bg-raised dark:text-ink dark:ring-1 dark:ring-inset dark:ring-line-2',
  strong: 'text-send-ink dark:text-ink',
  muted: 'text-send-ink/70 dark:text-ink-2',
  soft: 'text-send-ink/80 dark:text-ink-2',
  faint: 'text-send-ink/60 dark:text-ink-3',
  rule: 'border-send-ink/15 dark:border-line',
  chip: 'border-send-ink/20 text-send-ink dark:border-line-2 dark:text-ink',
  button: 'bg-background text-ink dark:bg-send dark:text-send-ink',
};

/** Page measure: 20px gutter on phones, wide two-column canvas from lg. */
export const MEASURE = 'mx-auto w-full max-w-3xl px-5 md:px-8 lg:max-w-6xl';
/** The lg two-column grid every block shares: label / heading left, body right. */
const SPLIT = 'lg:grid lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-16';

const PRIMARY_BTN = 'flex h-[54px] items-center justify-between rounded-[14px] bg-send px-5 text-[15.5px] font-medium text-send-ink transition-opacity hover:opacity-90 md:h-12 md:justify-center md:gap-3 md:rounded-full md:px-6';

export function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.09em] text-ink">
      <span aria-hidden="true" className="size-[7px] rotate-45 bg-ink" />
      {children}
    </p>
  );
}

export function Hero({ eyebrow, h1, lede, lang, cta, secondary, platformCta }: {
  eyebrow: string; h1: string; lede: string; lang?: string; cta?: string; secondary?: ContentLink | null;
  /** The download page: the primary button becomes the visitor's installer. */
  platformCta?: boolean;
}) {
  const t = siteStrings(lang);
  const second = secondary === undefined ? { href: '/features', label: t.seeFeatures } : secondary;
  return (
    <section className="dg-rise pt-7 pb-9 md:pt-12 md:pb-14 lg:pt-16 lg:pb-20">
      <Eyebrow>{eyebrow}</Eyebrow>
      <h1 className="mt-4 max-w-4xl font-serif text-[38px] font-normal leading-[1.0] tracking-[-0.02em] text-balance text-ink md:text-[54px] lg:text-[66px]">{h1}</h1>
      <p className="mt-5 max-w-2xl text-[17px] leading-[1.55] text-ink-2 md:text-[19px]">{lede}</p>
      <div className="mt-7 flex flex-col gap-2.5 md:mt-9 md:flex-row md:items-center md:gap-3">
        {platformCta ? (
          <PlatformCta fallbackHref={CHAT_HREF} fallbackLabel={cta ?? t.startChattingFree} className={PRIMARY_BTN} installers={!isSelfHostedBuild()} />
        ) : (
          <Link href={CHAT_HREF} className={PRIMARY_BTN}>
            {cta ?? t.startChattingFree}
            <span aria-hidden="true">→</span>
          </Link>
        )}
        {second && (
          <SiteLink href={second.href} className="flex h-[54px] items-center justify-center rounded-[14px] border border-line-2 px-5 text-[15.5px] text-ink transition-colors hover:bg-hover md:h-12 md:rounded-full md:px-6">
            {second.label}
          </SiteLink>
        )}
      </div>
    </section>
  );
}

function Bullets({ items, inverse, article }: { items: string[]; inverse: boolean; article?: boolean }) {
  const size = article ? 'text-[16.5px] md:text-[17px]' : 'text-[15.5px]';
  return (
    <ol className="mt-1">
      {items.map((b, j) => {
        const { lead, rest } = splitLead(b);
        return (
          <li key={b.slice(0, 48)} className={`flex gap-3 border-b py-3.5 last:border-b-0 ${inverse ? INV.rule : 'border-line'}`}>
            <span className={`w-[22px] shrink-0 pt-[3px] font-mono text-[11px] tracking-[0.06em] ${inverse ? INV.faint : 'text-ink-3'}`}>{two(j + 1)}</span>
            <div className="min-w-0">
              {lead && <p className={`${size} font-semibold leading-[1.45] ${inverse ? INV.strong : 'text-ink'}`}>{lead}</p>}
              <p className={`${size} leading-[1.6] ${inverse ? INV.soft : 'text-ink-2'}`}>{rest}</p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function SectionLinks({ links: allLinks, inverse }: { links: ContentLink[]; inverse: boolean }) {
  // A self-host serves production installers that would sign into digby.ai — drop their links.
  const links = isSelfHostedBuild() ? allLinks.filter((l) => !isInstallerHref(l.href)) : allLinks;
  if (links.length === 0) return null;
  if (inverse) {
    return (
      <div className="mt-6 flex flex-col gap-2 md:flex-row md:flex-wrap">
        {links.map((l) => (
          <SiteLink key={l.href} href={l.href} className={`flex h-[50px] items-center justify-between gap-4 rounded-xl px-4 text-[15px] font-medium transition-opacity hover:opacity-90 md:min-w-64 ${INV.button}`}>
            {l.label}<span aria-hidden="true">→</span>
          </SiteLink>
        ))}
      </div>
    );
  }
  return (
    <div className="mt-5">
      {links.map((l) => (
        <SiteLink key={l.href} href={l.href} className="group flex min-h-12 items-center justify-between gap-4 border-b border-ink py-3 text-[15px] text-ink">
          {l.label}<span aria-hidden="true" className="transition-transform group-hover:translate-x-0.5">→</span>
        </SiteLink>
      ))}
    </div>
  );
}

/**
 * A self-host build serves no native apps and is not digby.ai: drop the
 * macOS / Windows "native app" bullets and name this Digby instead of the
 * production host (the installer links are filtered in SectionLinks).
 */
function selfHostBullets(items: string[]): string[] {
  if (!isSelfHostedBuild()) return items;
  return items
    .filter((b) => !/^(macOS|Windows) — native app/.test(b))
    .map((b) => b.replace(/open digby\.ai in/g, 'open this Digby in'));
}

function SectionBody({ s, inverse, article }: { s: ContentSection; inverse: boolean; article?: boolean }) {
  // Guides read at 17–18px (2026-10-16 site review); landing pages stay 16–16.5px.
  const para = article ? 'mb-4 text-[17px] leading-[1.7] md:text-[18px]' : 'mb-3 text-[16px] leading-[1.6] md:text-[16.5px]';
  return (
    <>
      {s.paragraphs?.map((p) => (
        <p key={p.slice(0, 48)} className={`${para} last:mb-0 ${inverse ? INV.muted : 'text-ink-2'}`}>{p}</p>
      ))}
      {s.chips && (
        <ul className="mt-4 mb-1 flex flex-wrap gap-2">
          {s.chips.map((c) => (
            <li key={c} className={`inline-flex h-[38px] items-center rounded-full border px-3.5 text-[14px] ${inverse ? INV.chip : 'border-line bg-raised text-ink'}`}>{c}</li>
          ))}
        </ul>
      )}
      {s.bullets && <Bullets items={selfHostBullets(s.bullets)} inverse={inverse} article={article} />}
      {s.table && <ComparisonTable table={s.table} />}
      {s.code && (
        <pre className="mt-5 overflow-x-auto rounded-xl bg-background px-4 py-3.5 font-mono text-[14px] text-ink">
          {s.code.split('\n').map((line, i, all) => (
            <span key={i}><span className="text-ink-3 select-none">$ </span>{line}{i < all.length - 1 ? '\n' : ''}</span>
          ))}
        </pre>
      )}
      {s.links?.length ? <SectionLinks links={s.links} inverse={inverse} /> : null}
      {s.sources?.length ? (
        <p className={`mt-4 text-[12.5px] leading-relaxed ${inverse ? INV.faint : 'text-ink-3'}`}>
          <span className="font-mono uppercase tracking-[0.06em]">Sources</span>{' '}
          {s.sources.map((src, i) => (
            <span key={src.href}>
              {i > 0 && <span aria-hidden="true"> · </span>}
              <a href={src.href} rel="noopener" target="_blank" className="underline decoration-line-2 underline-offset-2 hover:text-ink">{src.label}</a>
            </span>
          ))}
        </p>
      ) : null}
    </>
  );
}

/**
 * The /digby-vs-* comparison table: a real <table> (search engines read it as
 * one); on phones it scrolls sideways inside its card with the row labels
 * pinned, so no column is ever squeezed below a readable width.
 */
function ComparisonTable({ table }: { table: ComparisonTableData }) {
  return (
    <figure className="mt-2">
      <div className="-mx-5 overflow-x-auto px-5 md:mx-0 md:px-0 [scrollbar-width:thin]">
        <table style={{ minWidth: 150 + table.columns.length * 190 }} className="w-full border-separate border-spacing-0 text-left text-[14.5px] leading-snug">
          <thead>
            <tr>
              <th scope="col" className="sticky left-0 bg-background py-3 pr-4 font-mono text-[11px] font-normal uppercase tracking-[0.06em] text-ink-3"><span className="sr-only">Feature</span></th>
              {table.columns.map((c, i) => (
                <th key={c} scope="col" className={`border-b-2 px-3 py-3 align-bottom text-[15px] font-semibold ${i === 0 ? 'border-ink text-ink' : 'border-line-2 text-ink-2'}`}>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((r) => (
              <tr key={r.label}>
                <th scope="row" className="sticky left-0 w-[150px] border-b border-line bg-background py-3 pr-4 align-top text-[13px] font-medium text-ink-3">{r.label}</th>
                {r.cells.map((c, i) => (
                  <td key={i} className={`border-b border-line px-3 py-3 align-top ${i === 0 ? 'bg-raised font-medium text-ink' : 'text-ink-2'}`}>{c}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {table.note && <figcaption className="mt-3 text-[12.5px] text-ink-3">{table.note}</figcaption>}
    </figure>
  );
}

/**
 * Numbered sections. `layout="split"` (landing pages) puts the number + heading
 * in a sticky left column from lg; `layout="article"` keeps one reading column.
 */
export function Sections({ sections, layout = 'split' }: { sections: ContentSection[]; layout?: 'split' | 'article' }) {
  const split = layout === 'split';
  return (
    <div>
      {sections.map((s, i) => {
        const inverse = s.tone === 'inverse';
        const head = (
          <div className={split && !s.table ? 'lg:sticky lg:top-28 lg:self-start' : ''}>
            <p className={`font-mono text-[11px] tracking-[0.06em] ${inverse ? INV.faint : 'text-ink-3'}`}>{two(i + 1)}</p>
            <h2 className={`mt-2 font-serif font-normal tracking-[-0.01em] ${inverse ? `text-[28px] leading-[1.05] md:text-[36px] ${INV.strong}` : 'text-[27px] leading-[1.05] text-ink md:text-[34px]'}`}>{s.heading}</h2>
          </div>
        );
        if (inverse) {
          return (
            <section key={s.heading} className={`-mx-5 my-2 px-5 py-11 md:mx-0 md:my-6 md:rounded-3xl md:px-10 md:py-12 ${INV.slab} ${split ? SPLIT : ''}`}>
              {head}
              <div className="mt-4 lg:mt-0"><SectionBody s={s} inverse article={!split} /></div>
            </section>
          );
        }
        return (
          // A comparison table needs the full measure: its heading sits above it.
          <section key={s.heading} className={`border-t border-line py-9 md:py-14 ${split && !s.table ? SPLIT : ''}`}>
            {head}
            <div className={s.table ? 'mt-5' : 'mt-4 lg:mt-0'}><SectionBody s={s} inverse={false} article={!split} /></div>
          </section>
        );
      })}
    </div>
  );
}

export function FaqList({ faqs, title, layout = 'split' }: { faqs: Faq[]; title?: string | null; layout?: 'split' | 'article' }) {
  return (
    <section className={`border-t border-line pt-9 pb-2 md:pt-14 ${layout === 'split' ? SPLIT : ''} ${title === null ? 'border-t-0 pt-0 md:pt-0' : ''}`}>
      {title !== null ? (
        <h2 className="mb-2 font-serif text-[27px] font-normal leading-[1.05] tracking-[-0.01em] text-ink md:text-[34px] lg:sticky lg:top-28 lg:self-start">{title}</h2>
      ) : layout === 'split' ? <div aria-hidden="true" /> : null}
      <div>
        {faqs.map((f) => (
          <details key={f.q} className="group border-b border-line">
            <summary className="flex min-h-[60px] cursor-pointer list-none items-center justify-between gap-4 py-3 text-[16px] font-medium leading-snug text-ink [&::-webkit-details-marker]:hidden">
              {f.q}
              <span aria-hidden="true" className="flex size-7 shrink-0 items-center justify-center rounded-full border border-line-2 text-[16px] leading-none transition-transform duration-200 group-open:rotate-45 group-open:border-send group-open:bg-send group-open:text-send-ink">+</span>
            </summary>
            <p className={`dg-fade pr-10 pb-5 leading-[1.65] text-ink-2 ${layout === 'article' ? 'text-[16.5px] md:text-[17px]' : 'text-[15.5px]'}`}>{f.a}</p>
          </details>
        ))}
      </div>
    </section>
  );
}

/** "Try asking Digby": two suggested prompts that open the chat prefilled (/?q=…, never auto-sent). */
export function PromptCard({ prompts, lang, layout = 'split' }: { prompts: string[]; lang?: string; layout?: 'split' | 'article' }) {
  // Guides sit in one reading column: the label stacks above the prompts there
  // instead of squeezing them into a 7fr cell (2026-10-16 site review).
  const split = layout === 'split';
  const t = siteStrings(lang);
  const fr = lang?.toLowerCase().startsWith('fr');
  const quote = (p: string) => (fr ? `« ${p} »` : `“${p}”`);
  return (
    <section className={`mt-10 rounded-[20px] border border-line bg-raised p-5 md:mt-14 md:p-7 ${split ? `${SPLIT} lg:items-center` : ''}`}>
      <div className="flex items-center gap-2.5">
        <Image src="/digbyhat.png" alt="" width={26} height={26} />
        <h2 className="text-[15px] font-medium text-ink lg:text-[17px]">{t.tryAsking}</h2>
      </div>
      <ul className={`mt-4 grid gap-2 md:grid-cols-2 ${split ? 'lg:mt-0' : ''}`}>
        {prompts.map((p) => (
          <li key={p}>
            <Link href={chatPrefillHref(p, CHAT_HREF)} className="flex min-h-12 items-center justify-between gap-3 rounded-xl bg-surface px-4 py-3 text-[15px] leading-snug text-ink transition-colors hover:bg-hover md:h-full">
              {quote(p)}
              <span aria-hidden="true" className="shrink-0 text-ink-2">↑</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** "Keep reading": a swipeable row on phones, a 2- then 4-column grid on wider screens. */
export function RelatedLinks({ slugs, lang, layout = 'split' }: { slugs: string[]; lang?: string; layout?: 'split' | 'article' }) {
  const t = siteStrings(lang);
  const items = slugs.map(resolveRelated).filter((x): x is NonNullable<typeof x> => !!x);
  if (!items.length) return null;
  return (
    <section className="pt-10 md:pt-16">
      <div className="flex items-baseline justify-between">
        <h2 className="font-serif text-[24px] font-normal leading-none tracking-[-0.01em] text-ink md:text-[30px]">{t.keepReading}</h2>
        <span aria-hidden="true" className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-3 md:hidden">{t.swipe}</span>
      </div>
      <ul className={`-mx-5 mt-4 flex snap-x snap-mandatory scroll-px-5 gap-2.5 overflow-x-auto px-5 pb-1 [scrollbar-width:none] md:mx-0 md:mt-6 md:grid md:grid-cols-2 md:gap-3 md:overflow-visible md:px-0 ${layout === 'split' ? 'lg:grid-cols-4' : ''} [&::-webkit-scrollbar]:hidden`}>
        {items.map((r) => (
          <li key={r.href} className="w-[250px] shrink-0 snap-start md:w-auto">
            <Link href={r.href} className="flex h-full flex-col rounded-2xl bg-surface p-[18px] transition-colors hover:bg-hover">
              <span className="font-mono text-[10.5px] uppercase tracking-[0.08em] text-ink-3">{r.kind}</span>
              <span className="mt-2 font-serif text-[21px] leading-[1.05] text-ink">{r.label}</span>
              <span className="mt-2 line-clamp-4 text-[14px] leading-[1.5] text-ink-2">{r.description}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The closing "go back and chat" block every page ends with. */
export function ChatCta({ lang, layout = 'split' }: { lang?: string; layout?: 'split' | 'article' }) {
  const t = siteStrings(lang);
  // In the narrow guide column the title and button stack (the side-by-side row
  // wrapped "Try Digby now." onto two lines there).
  const row = layout === 'split' ? 'md:flex md:items-end md:justify-between md:gap-10' : '';
  return (
    <section className={`mt-10 rounded-[22px] px-[22px] pt-[30px] pb-6 md:mt-16 md:rounded-3xl md:p-10 lg:p-12 ${row} ${INV.slab}`}>
      <div>
        <h2 className="font-serif text-[34px] font-normal leading-none tracking-[-0.01em] md:text-[44px] lg:text-[52px]">{t.ctaTitle}</h2>
        <p className={`mt-3 text-[15.5px] leading-snug md:text-[16.5px] ${INV.muted}`}>{t.ctaSub}</p>
      </div>
      <Link href={CHAT_HREF} className={`mt-6 flex h-[52px] shrink-0 items-center justify-between rounded-[14px] px-5 text-[15.5px] font-medium transition-opacity hover:opacity-90 md:w-64 ${layout === 'split' ? 'md:mt-0' : 'md:mt-8'} ${INV.button}`}>
        {t.startChatting}<span aria-hidden="true">→</span>
      </Link>
    </section>
  );
}

/**
 * The sticky ask bar on every site page: a plain GET form to the chat, so it
 * works without JS. The chat reads `?q=` and fills its composer WITHOUT
 * sending (lib/chat-prefill.ts). 16px input text stops iOS zooming in.
 */
export function AskBar({ placeholder, lang }: { placeholder?: string; lang?: string }) {
  const t = siteStrings(lang);
  return (
    <div
      className="pointer-events-none sticky bottom-0 z-(--z-raised) bg-linear-to-b from-transparent to-background to-30% px-3 pt-3.5 md:px-6"
      style={{ paddingBottom: 'calc(12px + env(safe-area-inset-bottom, 0px))' }}
    >
      <form action={CHAT_HREF} method="get" role="search" className="pointer-events-auto mx-auto flex h-[54px] max-w-2xl items-center gap-2 rounded-full border border-line bg-raised pr-1.5 pl-5 shadow-soft">
        <input
          name={PREFILL_PARAM}
          type="text"
          enterKeyHint="send"
          autoComplete="off"
          aria-label={t.askLabel}
          placeholder={placeholder ?? t.askDefault}
          className="min-w-0 flex-1 bg-transparent text-[16px] text-ink outline-none placeholder:text-ink-3"
        />
        <button type="submit" aria-label={t.send} className="flex size-[42px] shrink-0 items-center justify-center rounded-full bg-send text-[18px] text-send-ink transition-opacity hover:opacity-90">
          ↑
        </button>
      </form>
    </div>
  );
}
