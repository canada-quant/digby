'use client';

/**
 * Branding for CLIENT components (todo d2d32b57).
 *
 * The root layout resolves the operator's branding on the SERVER (build time
 * for static routes) and passes the snapshot down here, so client surfaces
 * never read `process.env` themselves (a client bundle cannot see
 * `DIGBY_BRAND_*`, and `NEXT_PUBLIC_` would bake a second copy of every
 * value). Rendering a component with no provider (a unit test, a story, an
 * error boundary that mounted above the layout) yields DEFAULT_BRANDING —
 * the shipped Digby identity — never a blank.
 */
import { createContext, useContext, type ReactNode } from 'react';
import { DEFAULT_BRANDING, type Branding } from '@/lib/branding';

const BrandingContext = createContext<Branding>(DEFAULT_BRANDING);

export function BrandingProvider({ value, children }: { value: Branding; children: ReactNode }) {
  return <BrandingContext.Provider value={value}>{children}</BrandingContext.Provider>;
}

/** The active branding. Safe anywhere: defaults to the shipped Digby identity. */
export function useBranding(): Branding {
  return useContext(BrandingContext);
}