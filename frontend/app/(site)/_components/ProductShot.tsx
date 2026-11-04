import { getImageProps } from 'next/image';
import type { ShotKey } from '@/lib/site/content';
import { SHOTS, SHOT_SIZE, shotSrc } from '@/lib/site/shots';

/**
 * A framed product screenshot (2026-10-16 site review). Art-directed with
 * <picture>: the phone capture below md, the desktop capture from md; one
 * picture per theme, the other hidden — a display:none lazy image never
 * downloads, so a visitor fetches exactly one file. Server component.
 */
export function ProductShot({ shot, className = '' }: { shot: ShotKey; className?: string }) {
  const s = SHOTS[shot];
  const sizes = '(min-width: 1024px) 1104px, (min-width: 768px) 92vw, 100vw';
  const picture = (scheme: 'light' | 'dark') => {
    const desktop = getImageProps({ alt: s.alt, sizes, quality: 80, src: shotSrc(shot, scheme, 'desktop'), ...SHOT_SIZE.desktop }).props;
    const { style: _style, ...mobile } = getImageProps({ alt: s.alt, sizes, quality: 80, src: shotSrc(shot, scheme, 'mobile'), ...SHOT_SIZE.mobile }).props;
    return (
      <picture key={scheme} className={scheme === 'dark' ? 'hidden dark:block' : 'block dark:hidden'}>
        <source media="(min-width: 768px)" srcSet={desktop.srcSet} sizes={desktop.sizes} width={SHOT_SIZE.desktop.width} height={SHOT_SIZE.desktop.height} />
        <img {...mobile} alt={s.alt} loading="lazy" decoding="async" className="block aspect-[39/48] h-auto w-full object-cover object-top md:aspect-auto" />
      </picture>
    );
  };
  return (
    <figure className={`dg-rise ${className}`}>
      <div className="overflow-hidden rounded-[18px] border border-line bg-background shadow-soft md:rounded-2xl">
        {picture('light')}
        {picture('dark')}
      </div>
      <figcaption className="mt-3 text-[13px] leading-snug text-ink-3">{s.caption}</figcaption>
    </figure>
  );
}
