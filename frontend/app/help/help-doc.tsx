'use client';

/**
 * HelpDoc — /help/<slug>: renders one synced markdown doc. Chrome mirrors the
 * legal pages (sticky header, max-w-3xl prose column); the body goes through
 * HelpMarkdown (react-markdown + remark-gfm, repo-doc links rewritten to
 * /help/<slug>).
 */

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { LifeBuoy } from 'lucide-react';
import { PageBackButton } from '@/components/ui/page-back-button';
import { AuthGate } from './auth-gate';
import { HelpMarkdown } from './help-markdown';
import type { HelpDocMeta } from '@/lib/help-types';

export function HelpDoc({
  meta,
  content,
  docs,
}: {
  meta: HelpDocMeta;
  content: string;
  docs: { slug: string; source: string }[];
}) {
  const router = useRouter();
  return (
    <AuthGate redirectPath={`/help/${meta.slug}`}>
      {/* h-dvh + internal scroll: globals.css disables body scroll app-wide, so
          a min-h-screen root has no scroll container and everything below the
          fold is unreachable (same bug class as app/login/page.tsx). The root
          IS the scroll container so the sticky header sticks inside it. */}
      <div className="h-dvh overflow-y-auto bg-background flex flex-col">
        <div className="border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 sticky top-0 z-10" style={{ paddingTop: 'env(safe-area-inset-top, 0px)' }}>
          <div className="max-w-3xl mx-auto px-4 py-3 flex items-center gap-3 min-w-0">
            <PageBackButton onClick={() => router.push('/help')} label="Back to Help" />
            <LifeBuoy className="size-4 text-primary shrink-0" />
            <span className="text-base font-semibold truncate">{meta.title}</span>
            <span className="text-[11px] text-muted-foreground/70 ml-auto shrink-0 hidden sm:inline">{meta.category}</span>
          </div>
        </div>

        <div id="main" tabIndex={-1} className="max-w-3xl mx-auto w-full px-4 py-8 flex-1 outline-none">
          <HelpMarkdown content={content} currentSource={meta.source} docs={docs} />
          <div className="border-t pt-6 mt-10">
            <Link href="/help" className="text-sm text-primary underline underline-offset-4 hover:opacity-80">
              ← All Help topics
            </Link>
          </div>
        </div>
      </div>
    </AuthGate>
  );
}
