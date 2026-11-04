'use client';

/**
 * HelpIndex — /help landing: doc index grouped by category with a client-side
 * search box. The whole corpus (manifest + raw markdown, ~60KB) arrives in the
 * RSC payload, so search runs entirely locally — no external search deps.
 * Matching: every whitespace-separated term must appear in the doc's title,
 * headings, or content; results are ranked title > headings > content and can
 * deep-link to a matched heading (/help/<slug>#<id>).
 */

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { FileText, Hash, LifeBuoy, Search } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { PageBackButton } from '@/components/ui/page-back-button';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { AuthGate } from './auth-gate';
import type { HelpHeading, HelpIndexEntry } from '@/lib/help-types';

interface SearchResult {
  doc: HelpIndexEntry;
  score: number;
  matchedHeadings: HelpHeading[];
  snippet: string | null;
}

function searchDocs(docs: HelpIndexEntry[], query: string): SearchResult[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  const results: SearchResult[] = [];
  for (const doc of docs) {
    const titleLc = doc.title.toLowerCase();
    const contentLc = doc.content.toLowerCase();
    const headingHits = doc.headings.filter((h) =>
      terms.some((t) => h.text.toLowerCase().includes(t)),
    );
    const titleHits = terms.filter((t) => titleLc.includes(t)).length;
    const contentHits = terms.filter((t) => contentLc.includes(t)).length;
    const matched = terms.every(
      (t) =>
        titleLc.includes(t) ||
        contentLc.includes(t) ||
        doc.headings.some((h) => h.text.toLowerCase().includes(t)),
    );
    if (!matched) continue;
    let snippet: string | null = null;
    if (titleHits === 0 && contentHits > 0) {
      const line = doc.content
        .split('\n')
        .find((l) => !l.trimStart().startsWith('```') && l.toLowerCase().includes(terms[0]));
      if (line) {
        const clean = line.trim();
        snippet = clean.length > 160 ? `${clean.slice(0, 157)}…` : clean;
      }
    }
    results.push({
      doc,
      score: titleHits * 10 + headingHits.length * 3 + contentHits,
      matchedHeadings: headingHits.slice(0, 3),
      snippet,
    });
  }
  return results.sort((a, b) => b.score - a.score || a.doc.title.localeCompare(b.doc.title));
}

export function HelpIndex({ docs }: { docs: HelpIndexEntry[] }) {
  const router = useRouter();
  const [query, setQuery] = useState('');

  const categories = useMemo(() => {
    const map = new Map<string, HelpIndexEntry[]>();
    for (const doc of docs) {
      const list = map.get(doc.category) ?? [];
      list.push(doc);
      map.set(doc.category, list);
    }
    return [...map.entries()];
  }, [docs]);

  const results = useMemo(() => searchDocs(docs, query.trim()), [docs, query]);
  const searching = query.trim().length > 0;

  return (
    <AuthGate redirectPath="/help">
      {/* h-dvh + internal scroll: globals.css disables body scroll app-wide, so
          a min-h-screen root has no scroll container and everything below the
          fold is unreachable (same bug class as app/login/page.tsx). The root
          IS the scroll container so the sticky header sticks inside it. */}
      <div className="h-dvh overflow-y-auto bg-background flex flex-col">
        {/* Header — same chrome as the legal pages */}
        <div className="border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 sticky top-0 z-10" style={{ paddingTop: 'env(safe-area-inset-top, 0px)' }}>
          <div className="max-w-3xl mx-auto px-4 py-3 flex items-center gap-3">
            <PageBackButton onClick={() => router.push('/')} label="Back to chats" />
            <LifeBuoy className="size-4 text-primary shrink-0" />
            <h1 className="text-base font-semibold">Help &amp; Docs</h1>
          </div>
        </div>

        <div id="main" tabIndex={-1} className="max-w-3xl mx-auto w-full px-4 py-6 flex-1 outline-none">
          {/* Search */}
          <div className="relative mb-6">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search docs — try “pairing”, “iMessage”, “API token”…"
              className="pl-9"
              autoFocus
            />
          </div>

          {searching ? (
            results.length === 0 ? (
              <Empty className="py-12 border-none">
                <EmptyHeader>
                  <EmptyTitle>No matching docs</EmptyTitle>
                  <EmptyDescription>
                    Nothing in Help matches &ldquo;{query.trim()}&rdquo;. Try a shorter phrase.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <div className="space-y-2">
                {results.map(({ doc, matchedHeadings, snippet }) => (
                  <Link
                    key={doc.slug}
                    href={`/help/${doc.slug}`}
                    className="block rounded-lg border bg-card p-4 hover:bg-muted/50 transition-colors"
                  >
                    <div className="flex items-center gap-2">
                      <FileText className="size-4 text-muted-foreground shrink-0" />
                      <span className="font-medium text-sm">{doc.title}</span>
                      <span className="text-[11px] text-muted-foreground/70 ml-auto shrink-0">{doc.category}</span>
                    </div>
                    {snippet && (
                      <p className="text-xs text-muted-foreground mt-2 line-clamp-2 font-mono">{snippet}</p>
                    )}
                    {matchedHeadings.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 mt-2">
                        {matchedHeadings.map((h) => (
                          <span key={h.id} className="inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                            <Hash className="size-3" />
                            {h.text}
                          </span>
                        ))}
                      </div>
                    )}
                  </Link>
                ))}
              </div>
            )
          ) : (
            <div className="space-y-8">
              {categories.map(([category, categoryDocs]) => (
                <section key={category}>
                  <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-3">
                    {category}
                  </h2>
                  <div className="space-y-2">
                    {categoryDocs.map((doc) => (
                      <Link
                        key={doc.slug}
                        href={`/help/${doc.slug}`}
                        className="block rounded-lg border bg-card p-4 hover:bg-muted/50 transition-colors"
                      >
                        <div className="font-medium text-sm">{doc.title}</div>
                        <p className="text-sm text-muted-foreground mt-1">{doc.description}</p>
                      </Link>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}
        </div>
      </div>
    </AuthGate>
  );
}
