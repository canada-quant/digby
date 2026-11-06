'use client';

/**
 * Client UI error reporter (ticket d4e643a5, 2026-11-06) — renders NOTHING and
 * installs the two global listeners once per mount.
 *
 * Mounted from app/layout.tsx beside VisitorAnalytics / MetaPixel, i.e. on every
 * page. The behaviour lives in lib/client-error-reporter.ts (pure, unit-tested);
 * this component is only the React lifecycle: install on mount, tear down on
 * unmount, and report a boundary crash through the same path.
 *
 * Kill switch: NEXT_PUBLIC_CLIENT_ERROR_REPORT_DISABLED=1 (BUILD arg) — the
 * component installs nothing and sends nothing (lib/client-error-reporter.ts
 * clientErrorReportDisabled, read at call time so the check is testable).
 */
import { useEffect } from 'react';
import { installClientErrorReporter, reportClientError, clientBuildSha } from '@/lib/client-error-reporter';
import { isChunkLoadError } from '@/lib/chunk-reload';

export function ClientErrorReporter() {
  useEffect(() => {
    const uninstall = installClientErrorReporter();
    return uninstall;
  }, []);
  return null;
}

/**
 * Report a caught React error (the app-root boundary's hook). Called from a
 * boundary's useEffect so a render crash — the one class the global `error`
 * listener can miss, because React swallows it into its own boundary — still
 * reaches app_error_logs. Never throws.
 */
export function reportBoundaryError(error: unknown, opts?: { suppressChunkLoad?: boolean }): void {
  try {
    // Chunk-load errors are DESIGNED, self-healing deploy skew (review MAJOR 4):
    // they recur every blue-green deploy across several hours, so reporting them
    // would make the sweep file a ticket for a non-defect every deploy and spend
    // the daily filing budget real client faults need. The boundary still
    // reloads the user out of it.
    if (opts?.suppressChunkLoad && isChunkLoadError(error)) return;
    const e = error as { message?: unknown; stack?: unknown; name?: unknown; digest?: unknown };
    const name = typeof e?.name === 'string' ? e.name : 'Error';
    const message = typeof e?.message === 'string' ? e.message : String(error ?? 'Unknown error');
    reportClientError({
      message: `${name}: ${message}`,
      stack: typeof e?.stack === 'string' ? e.stack : undefined,
      source: 'error-boundary',
      url: typeof window !== 'undefined' ? window.location?.href : undefined,
      route: typeof window !== 'undefined' ? window.location?.pathname : undefined,
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
      buildSha: clientBuildSha(),
    });
  } catch { /* reporting an error must never raise one */ }
}

export default ClientErrorReporter;