'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { authApi } from '@/lib/auth';
import { isDefinitiveAuthFailure } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';
import { User2, Brain, Palette } from 'lucide-react';
import { PageBackButton } from '@/components/ui/page-back-button';
import { ScrollableTabBar } from '@/components/ui/scrollable-tab-bar';
import { usePreferences, TEXT_SIZE_MAP, type ChatTextSize, type SidebarDefault } from '@/lib/preferences';
import { MemoryTab } from './MemoryTab';
import { ProfileTab } from './ProfileTab';
import { FeedbackTab } from './FeedbackTab';
import { IntegrationsTab } from './IntegrationsTab';
import { AdminTab } from './AdminTab';
import { KidsTab } from './KidsTab';
import { CodingTab } from './CodingTab';
import { AgentTokensTab } from './AgentTokensTab';
import { MessageSquarePlus, Plug, Shield, Baby, Code2, KeyRound } from 'lucide-react';

type Tab = 'profile' | 'memory' | 'appearance' | 'coding' | 'developer' | 'feedback' | 'integrations' | 'admin' | 'kids';

interface TabDef {
  id: Tab;
  label: string;
  icon: React.ElementType;
}

const TABS: TabDef[] = [
  { id: 'profile',      label: 'Profile',       icon: User2             },
  { id: 'memory',       label: 'Memory',        icon: Brain             },
  { id: 'appearance',   label: 'Appearance',    icon: Palette           },
  // The Advanced tab (the retired depth-picker's last home, one read-only line
  // since roster 2026-10-06 B-3) was REMOVED 2026-10-27 — ticket c99b404a:
  // there was nothing to set in it ("Digby picks depth and models per
  // message" — Dig deeper under an answer is the only depth control).
  { id: 'coding',       label: 'Coding',        icon: Code2             },
  { id: 'developer',    label: 'Developer',     icon: KeyRound          },
  { id: 'feedback',     label: 'Feedback',      icon: MessageSquarePlus },
  { id: 'integrations', label: 'Integrations',  icon: Plug              },
  // (The Feeds tab was retired with the topic-feeds subsystem, ticket
  //  43c24152, 2026-10-20 — a topic digest is a schedule on a real chat.)
  { id: 'kids',         label: 'Kids',          icon: Baby              },
];

const TEXT_SIZE_OPTIONS: { value: ChatTextSize; label: string; desc: string }[] = [
  { value: 'small',  label: 'Small',  desc: 'Compact, more text on screen' },
  { value: 'medium', label: 'Medium', desc: 'Default size'                  },
  { value: 'large',  label: 'Large',  desc: 'Easier to read'                },
];

export default function AccountPage() {
  const router = useRouter();
  const [user, setUser] = useState<{ email: string; role: string; isChild?: boolean } | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>(() => {
    // Support ?tab=<id> deep links (OAuth callbacks land on integrations; the
    // rest are linkable from chat / docs). Every tab id is accepted — the
    // old allow-list silently dropped memory / appearance / coding
    // (settings audit 2026-09-21).
    if (typeof window !== 'undefined') {
      const tab = new URLSearchParams(window.location.search).get('tab');
      if (tab && (TABS.some((t) => t.id === tab) || tab === 'admin')) return tab as Tab;
    }
    return 'profile';
  });
  const [loading, setLoading] = useState(true);
  const { prefs, update } = usePreferences();

  const isAdmin = user?.role === 'ADMIN' || user?.email?.toLowerCase() === 'example-user@example.com';

  // Build tabs dynamically — include Admin tab right after Profile for admin users
  // (placed early so it's visible on mobile without horizontal scrolling)
  // Child accounts get a trimmed account page — no Kids management, no
  // integrations (all inert or off-limits for a child: the kid chat path
  // bypasses feeds/RAG/integrations entirely — the feeds tab itself was
  // retired 2026-10-20, ticket 43c24152).
  const baseTabs = user?.isChild
    ? TABS.filter((t) => !['kids', 'integrations', 'developer'].includes(t.id))
    : TABS;
  const visibleTabs: TabDef[] = isAdmin
    ? [baseTabs[0], { id: 'admin' as Tab, label: 'Admin', icon: Shield }, ...baseTabs.slice(1)]
    : baseTabs;

  useEffect(() => {
    authApi.getCurrentUser()
      .then((u) => {
        // Digby Kids: child accounts have no settings — bounce them back to chat.
        if ((u as any)?.isChild) { router.replace('/'); return; }
        setUser(u); setLoading(false);
      })
      .catch((err) => {
        // 05303f58: bounce only on a definitive 401 (refresh already failed) —
        // a network blip/5xx keeps the token and the loading state stays.
        if (isDefinitiveAuthFailure(err)) router.push('/login');
        else console.warn('getCurrentUser failed (non-auth) — staying put', err);
      });
  }, [router]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Spinner className="size-6 text-brand-accent" />
      </div>
    );
  }

  return (
    // fixed inset-0 + app-viewport vars — the chat-shell idiom (ticket
    // b0edd255): an in-flow h-dvh root is pushed down by any top-of-body
    // banner and its bottom strip is clipped (body scroll is disabled
    // app-wide); fixed + --app-height/--app-top pin the shell to the VISIBLE
    // viewport. Same vulnerable shape as the management route had.
    <div className="fixed inset-0 flex flex-col bg-background overflow-hidden" style={{ height: 'var(--app-height, 100dvh)', top: 'var(--app-top, 0px)' }}>
      {/* Header — fixed at top, never scrolls */}
      <div className="shrink-0 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 z-10" style={{ paddingTop: 'env(safe-area-inset-top, 0px)' }}>
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center gap-3">
          <PageBackButton onClick={() => router.push('/')} label="Back to chats" />
          <h1 className="text-base font-semibold">Account</h1>
        </div>

        <div className="max-w-5xl mx-auto px-4">
          <ScrollableTabBar
            ariaLabel="Account sections"
            value={activeTab}
            onChange={setActiveTab}
            tabs={visibleTabs}
          />
        </div>
      </div>

      {/* Content — scrollable area fills remaining viewport height */}
      <div id="main" tabIndex={-1} className="flex-1 overflow-y-auto overscroll-y-contain outline-none">
        {/* max-w-5xl (was 3xl): Settings read as a thin centered column on wide
            monitors (ticket f9ab1be1) — give the tabs room without going full-bleed. */}
        <div className="max-w-5xl mx-auto w-full px-4 py-8">
        {activeTab === 'profile'      && <ProfileTab isChild={!!user?.isChild} email={user?.email} />}
        {activeTab === 'memory'       && <MemoryTab />}
        {activeTab === 'coding'       && <CodingTab isAdmin={isAdmin} />}
        {activeTab === 'developer'    && <AgentTokensTab />}
        {activeTab === 'feedback'     && <FeedbackTab />}
        {activeTab === 'integrations' && <IntegrationsTab />}
        {activeTab === 'kids'         && <KidsTab />}
        {activeTab === 'admin' && isAdmin && <AdminTab />}
        {activeTab === 'appearance' && (() => {
          const sizes = TEXT_SIZE_MAP[prefs.chatTextSize];
          return (
          <div className="space-y-8">
            {/* Chat Text Size */}
            <div>
              <h2 className="text-sm font-semibold mb-1">Chat Text Size</h2>
              <p className="text-xs text-muted-foreground mb-4">Controls the font size of AI responses, your messages, headings, and chat titles.</p>
              <div className="flex flex-col gap-2">
                {TEXT_SIZE_OPTIONS.map(({ value, label, desc }) => (
                  <label
                    key={value}
                    className={cn(
                      'flex items-center gap-3 rounded-lg border px-4 py-3 cursor-pointer transition-colors',
                      prefs.chatTextSize === value
                        ? 'border-brand-accent bg-brand-soft'
                        : 'border-border hover:bg-muted/50'
                    )}
                  >
                    <input
                      type="radio"
                      name="chatTextSize"
                      value={value}
                      checked={prefs.chatTextSize === value}
                      onChange={() => update({ chatTextSize: value })}
                      className="accent-brand-accent"
                    />
                    <span className="flex flex-col">
                      <span className="text-sm font-medium">{label}</span>
                      <span className="text-xs text-muted-foreground">{desc}</span>
                    </span>
                  </label>
                ))}
              </div>

              {/* Live preview */}
              <div className="mt-6 rounded-lg border bg-muted/30 p-4 space-y-3">
                <p className="text-[12px] font-medium text-ink-3">Preview</p>
                {/* Simulated heading */}
                <p className={cn(sizes.h2, 'font-semibold text-foreground')}>Heading example</p>
                {/* Simulated AI response paragraph */}
                <p className={cn(sizes.p, 'text-foreground/90')}>
                  This is how AI responses will look with <strong className="font-semibold">bold text</strong> and regular paragraphs.
                </p>
                {/* Simulated list */}
                <ul className="pl-6 list-disc space-y-1 marker:text-muted-foreground">
                  <li className={cn(sizes.li, 'text-foreground/90')}>Bullet point item</li>
                  <li className={cn(sizes.li, 'text-foreground/90')}>Another list item</li>
                </ul>
                {/* Simulated user message */}
                <div className="flex justify-end">
                  <div className="rounded-2xl rounded-br-sm bg-primary text-primary-foreground px-4 py-2.5">
                    <p className={cn(sizes.userMsg, 'whitespace-pre-wrap')}>Your message looks like this</p>
                  </div>
                </div>
              </div>
            </div>

            {/* Sidebar Default */}
            <div>
              <h2 className="text-sm font-semibold mb-1">Sidebar Default</h2>
              <p className="text-xs text-muted-foreground mb-4">Whether the chat sidebar starts open or closed.</p>
              <div className="flex gap-2">
                {(['open', 'closed'] as SidebarDefault[]).map((val) => (
                  <Button
                    key={val}
                    variant={prefs.sidebarDefault === val ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => update({ sidebarDefault: val })}
                    className={prefs.sidebarDefault === val ? 'bg-brand hover:bg-brand-hover' : ''}
                  >
                    {val.charAt(0).toUpperCase() + val.slice(1)}
                  </Button>
                ))}
              </div>
            </div>

            {/* The Mac desktop-app download moved to Integrations → "Your Mac"
                (owner audit 2026-09-21: an app download is not an appearance
                setting; it belongs with the Mac agent it bundles). */}
          </div>
          );
        })()}
        </div>
      </div>
    </div>
  );
}
