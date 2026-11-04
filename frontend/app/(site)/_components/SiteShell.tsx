import { SiteFooter, SiteHeader } from './SiteChrome';
import { AskBar } from './ContentBlocks';

/**
 * One public-site page frame: sticky header (+ menu, + reading progress on
 * guides) → main → footer → the sticky ask bar. Rendered by each page rather
 * than the layout so the chrome can follow the page's language (the French
 * page reads in French) and its ask-bar placeholder. The (site) layout owns
 * only the scroll root.
 */
export function SiteShell({ path, lang, askPlaceholder, progress, footerCta, children }: {
  path: string;
  lang?: string;
  askPlaceholder?: string;
  progress?: boolean;
  /** Show the footer's md+ CTA card — only on pages without their own closing CTA. */
  footerCta?: boolean;
  children: React.ReactNode;
}) {
  return (
    <>
      <SiteHeader path={path} lang={lang} progress={progress} />
      <main id="main" tabIndex={-1} lang={lang} className="flex-1 outline-none">{children}</main>
      <SiteFooter lang={lang} cta={footerCta} />
      <AskBar placeholder={askPlaceholder} lang={lang} />
    </>
  );
}
