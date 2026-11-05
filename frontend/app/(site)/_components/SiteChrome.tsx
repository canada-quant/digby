import Link from 'next/link';
import Image from 'next/image';
import { CHAT_HREF, CONTACT_EMAIL, HEADER_NAV, MENU_PRIMARY, MENU_PRODUCTS, footerColumns } from '@/lib/site/content';
import { brandingFromEnv } from '@/lib/branding';
import { siteStrings, two } from '@/lib/site/strings';
import SiteMenu from './SiteMenu';
import ReadingProgress from './ReadingProgress';

/**
 * Public-site chrome (SEO plan 2026-10-14; mobile-first redesign 2026-10-16):
 * sticky header, full-screen mobile menu, footer. Every page links to every
 * other public page through the menu + footer, and every "Start chatting"
 * (logo, header pill, menu, footer, closing CTA, ask bar) returns to the chat
 * at the root domain. Server components; the only client islands are the menu
 * enhancer (Esc / close-on-navigate / scroll lock) and the article progress bar
 * — every link is in the server-rendered HTML.
 */

/** next/link for in-app pages; a plain <a> for downloads (/Digby.dmg — never RSC-prefetch a file) and mailto. */
export function SiteLink({ href, className, children, ...rest }: { href: string; className?: string; children: React.ReactNode } & Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, 'href' | 'className' | 'children'>) {
  if (/^mailto:|^https?:|\.[a-z0-9]{2,5}$/i.test(href)) {
    return <a href={href} className={className} {...rest}>{children}</a>;
  }
  return <Link href={href} className={className} {...rest}>{children}</Link>;
}

const isCurrent = (href: string, path?: string) => !!path && (path === href || (href !== '/' && path.startsWith(`${href}/`)));

// Shared branding core (todo d2d32b57). These are SERVER components in a
// statically rendered segment, so the operator's values are resolved once at
// build time — an operator sets DIGBY_BRAND_* before `docker compose up
// --build` (docs/SELF_HOST.md § Branding).
const branding = brandingFromEnv();

function Wordmark() {
  return (
    <Link href={CHAT_HREF} className="flex min-h-11 items-center gap-2 text-ink" aria-label={`${branding.name} — start chatting`}>
      <Image src={branding.assets.logoCompact} alt="" width={28} height={28} priority />
      <span className="font-serif text-[23px] leading-none tracking-[-0.01em]">{branding.name}</span>
    </Link>
  );
}

export function SiteHeader({ path, lang, progress }: { path?: string; lang?: string; progress?: boolean }) {
  const t = siteStrings(lang);
  return (
    <header className="sticky top-0 z-20 border-b border-line bg-background" style={{ paddingTop: 'env(safe-area-inset-top, 0px)' }}>
      <div className="mx-auto flex h-16 max-w-6xl items-center gap-3 px-5 md:h-[68px] md:px-8">
        <Wordmark />
        <nav aria-label="Main" className="ml-6 hidden items-center gap-0.5 md:flex">
          {HEADER_NAV.map((l) => {
            const cur = isCurrent(l.href, path);
            return (
              <Link
                key={l.href}
                href={l.href}
                aria-current={cur ? 'page' : undefined}
                className={`rounded-full px-3 py-2 text-[14px] transition-colors hover:bg-hover hover:text-ink ${cur ? 'text-ink' : 'text-ink-2'}`}
              >
                {t.menuLabels[l.href] ?? l.label}
              </Link>
            );
          })}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <Link href="/login" className="hidden h-10 items-center rounded-full px-3.5 text-[14px] text-ink-2 transition-colors hover:bg-hover hover:text-ink md:inline-flex">
            {t.signIn}
          </Link>
          <Link href={CHAT_HREF} className="inline-flex h-10 items-center rounded-full bg-send px-4 text-[14px] font-medium text-send-ink transition-opacity hover:opacity-90">
            {t.startChatting}
          </Link>
          <SiteMenu label={t.openMenu}>
            <MenuPanel path={path} lang={lang} />
          </SiteMenu>
        </div>
      </div>
      {progress && <ReadingProgress />}
    </header>
  );
}

/** The full-screen overlay inside the menu <details> (mobile only). */
function MenuPanel({ path, lang }: { path?: string; lang?: string }) {
  const t = siteStrings(lang);
  return (
    <div
      className="dg-rise-fast fixed inset-0 z-40 flex flex-col bg-background"
      style={{ paddingTop: 'env(safe-area-inset-top, 0px)' }}
    >
      {/* Same geometry as the header row, so the summary (the ×) lands top-right. */}
      <div className="flex h-16 shrink-0 items-center px-5">
        <p className="font-mono text-[11px] uppercase tracking-[0.09em] text-ink-3">{t.menu}</p>
      </div>
      <nav aria-label="Menu" className="flex-1 overflow-y-auto px-5 pb-6">
        <ul>
          {MENU_PRIMARY.map((l, i) => {
            const cur = isCurrent(l.href, path);
            return (
              <li key={l.href}>
                <Link
                  href={l.href}
                  aria-current={cur ? 'page' : undefined}
                  className="flex min-h-[58px] items-center gap-3 border-b border-line text-ink"
                >
                  <span className="w-5 shrink-0 font-mono text-[11px] tracking-[0.06em] text-ink-3">{two(i + 1)}</span>
                  <span className="font-serif text-[28px] leading-none tracking-[-0.01em]">{t.menuLabels[l.href] ?? l.label}</span>
                  {cur && <span className="ml-auto font-mono text-[11px] uppercase tracking-[0.06em] text-ink">● {t.here}</span>}
                </Link>
              </li>
            );
          })}
        </ul>
        <p className="mt-7 mb-3 font-mono text-[11px] uppercase tracking-[0.09em] text-ink-3">{t.product}</p>
        <ul className="grid grid-cols-2 gap-2">
          {MENU_PRODUCTS.map((p) => {
            const cur = isCurrent(p.href, path);
            const [title, sub] = t.productLabels[p.href] ?? [p.label, p.sub];
            return (
              <li key={p.href}>
                <Link
                  href={p.href}
                  aria-current={cur ? 'page' : undefined}
                  className={`flex min-h-[58px] flex-col justify-center rounded-[14px] border bg-raised px-3.5 py-2.5 ${cur ? 'border-ink' : 'border-line'}`}
                >
                  <span className="text-[15px] font-medium leading-tight text-ink">{title}</span>
                  <span className="mt-0.5 text-[12px] leading-tight text-ink-3">{sub}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
      <div className="flex shrink-0 gap-2.5 border-t border-line px-4 pt-3.5" style={{ paddingBottom: 'calc(14px + env(safe-area-inset-bottom, 0px))' }}>
        <Link href="/login" className="flex h-[52px] flex-1 items-center justify-center rounded-[14px] border border-line-2 text-[15px] text-ink">
          {t.signIn}
        </Link>
        <Link href={CHAT_HREF} className="flex h-[52px] flex-[1.4] items-center justify-center rounded-[14px] bg-send text-[15px] font-medium text-send-ink">
          {t.startChatting} →
        </Link>
      </div>
    </div>
  );
}

export function SiteFooter({ lang, cta = false }: { lang?: string; cta?: boolean }) {
  const t = siteStrings(lang);
  const cols = footerColumns();
  const year = new Date().getFullYear();
  return (
    // Bottom padding keeps the sticky ask bar off the copyright line.
    <footer className="border-t border-ink bg-background pb-32 md:border-line md:bg-surface md:pb-28">
      <div className="mx-auto max-w-6xl px-5 md:px-8 md:pt-14">
        {/* Desktop CTA card, only on pages without their own closing CTA (legal
            pages) — never a second CTA under ChatCta, and never on mobile. */}
        {cta && <div className="mb-12 hidden items-center justify-between gap-6 rounded-3xl border border-line bg-raised p-7 shadow-soft md:flex">
          <div>
            <p className="font-serif text-[26px] leading-tight text-ink">{t.ctaTitle}</p>
            <p className="mt-1 text-[14.5px] text-ink-2">{t.ctaSub}</p>
          </div>
          <Link href={CHAT_HREF} className="inline-flex h-12 shrink-0 items-center gap-3 rounded-full bg-send px-6 text-[15px] font-medium text-send-ink transition-opacity hover:opacity-90">
            {t.startChatting} <span aria-hidden="true">→</span>
          </Link>
        </div>}

        {/* Mobile: one <details> row per column. */}
        <div className="md:hidden">
          {cols.map((c) => (
            <details key={c.title} className="group border-b border-line">
              <summary className="flex h-[52px] cursor-pointer list-none items-center justify-between font-mono text-[12px] uppercase tracking-[0.08em] text-ink [&::-webkit-details-marker]:hidden">
                {t.footerTitles[c.title] ?? c.title}
                <span aria-hidden="true" className="text-[16px] group-open:hidden">+</span>
                <span aria-hidden="true" className="hidden text-[16px] group-open:inline">−</span>
              </summary>
              <ul className="pb-3">
                {c.links.map((l) => (
                  <li key={l.href}>
                    <SiteLink href={l.href} className="flex h-10 items-center text-[15px] text-ink-2">{l.label}</SiteLink>
                  </li>
                ))}
              </ul>
            </details>
          ))}
        </div>

        {/* md+: the 4-column grid. */}
        <div className="hidden gap-8 md:grid md:grid-cols-3 lg:grid-cols-5">
          {cols.map((c) => (
            <div key={c.title}>
              <p className="mb-3 font-mono text-[11.5px] uppercase tracking-[0.08em] text-ink">{t.footerTitles[c.title] ?? c.title}</p>
              <ul className="space-y-2">
                {c.links.map((l) => (
                  <li key={l.href}>
                    <SiteLink href={l.href} className="text-[14px] text-ink-2 transition-colors hover:text-ink">{l.label}</SiteLink>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-8 flex items-end justify-between gap-4 md:mt-14 md:border-t md:border-line md:pt-8">
          <Link href={CHAT_HREF} className="font-serif text-[46px] leading-[0.8] tracking-[-0.02em] text-ink" aria-label={`${branding.name} — start chatting`}>
            {branding.name}
          </Link>
          <div className="text-right font-mono text-[12px] leading-relaxed text-ink-2">
            <p>© {year} {branding.name} · {t.builtIn} 🇨🇦</p>
            <a href={`mailto:${CONTACT_EMAIL}`} className="hover:text-ink">{CONTACT_EMAIL}</a>
          </div>
        </div>
      </div>
    </footer>
  );
}

/** Visible breadcrumb trail on md+ (its BreadcrumbList JSON-LD is rendered on every size). */
export function Breadcrumbs({ trail }: { trail: { href: string; label: string }[] }) {
  return (
    <nav aria-label="Breadcrumb" className="mb-2 hidden pt-8 text-[12.5px] text-ink-3 md:block">
      <ol className="flex flex-wrap items-center gap-1.5">
        <li><Link href={CHAT_HREF} className="hover:text-ink">{branding.name}</Link></li>
        {trail.map((t, i) => (
          <li key={t.href} className="flex items-center gap-1.5">
            <span aria-hidden="true">/</span>
            {i === trail.length - 1
              ? <span aria-current="page" className="text-ink-2">{t.label}</span>
              : <Link href={t.href} className="hover:text-ink">{t.label}</Link>}
          </li>
        ))}
      </ol>
    </nav>
  );
}

export function JsonLd({ data }: { data: unknown }) {
  // `<` escaped so a string can never close the script element.
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(data).replace(/</g, '\\u003c') }} />;
}
