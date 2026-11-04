'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { authApi } from '@/lib/auth';
import { isDefinitiveAuthFailure } from '@/lib/api-client';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';
import { Inbox, Gauge, MessageSquare, ScrollText, CalendarClock, Bot } from 'lucide-react';
import { PageBackButton } from '@/components/ui/page-back-button';
import { ScrollableTabBar } from '@/components/ui/scrollable-tab-bar';
import { InboxTab } from './InboxTab';
import { DashboardTab } from './DashboardTab';
import { SupervisorChatTab } from './SupervisorChatTab';
import { LogsTab } from './LogsTab';
import { SchedulesTab } from './SchedulesTab';
import { FrameworkTab } from './FrameworkTab';

type Tab = 'inbox' | 'dashboard' | 'framework' | 'supervisor' | 'logs' | 'schedules';

interface TabDef {
  id: Tab;
  label: string;
  icon: React.ElementType;
}

const TABS: TabDef[] = [
  // Inbox FIRST — it is the owner-attention surface (ticket 7705fec2).
  { id: 'inbox',      label: 'Inbox',           icon: Inbox         },
  { id: 'dashboard',  label: 'Dashboard',       icon: Gauge         },
  // Framework surface (ticket 9471d338): the platform's own project, de-fanged
  // from the sidebar into a hardened, scaffolded tab of its own.
  { id: 'framework',  label: 'Framework',       icon: Bot           },
  { id: 'supervisor', label: 'Supervisor Chat', icon: MessageSquare },
  { id: 'logs',       label: 'Logs',            icon: ScrollText    },
  { id: 'schedules',  label: 'Schedules',       icon: CalendarClock },
];

export default function ManagementPage() {
  const router = useRouter();
  const [authed, setAuthed] = useState(false);
  const [loading, setLoading] = useState(true);
  // Dashboard Fleet-summary click-through: the wake note's message id the
  // Supervisor Chat tab should expand + scroll to (Issue 7).
  const [focusMessageId, setFocusMessageId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>(() => {
    // Support ?tab=inbox / ?tab=supervisor / ?tab=logs / ?tab=schedules deep
    // links (same pattern as Account — validated against the Tab union, any
    // unknown value falls back to the dashboard).
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      const tab = params.get('tab');
      if (tab === 'inbox' || tab === 'supervisor' || tab === 'logs' || tab === 'schedules' || tab === 'framework') return tab;
    }
    return 'dashboard';
  });

  useEffect(() => {
    authApi.getCurrentUser()
      .then((u) => {
        // Digby Kids: fleet management is adult-only (the backend rejects child
        // accounts with 403) — bounce them back to chat like Account does.
        if ((u as any)?.isChild) { router.replace('/'); return; }
        setAuthed(true); setLoading(false);
      })
      .catch((err) => {
        // 05303f58: bounce only on a definitive 401 (refresh already failed) —
        // a network blip/5xx keeps the token and the loading state stays.
        if (isDefinitiveAuthFailure(err)) router.push('/login');
        else console.warn('getCurrentUser failed (non-auth) — staying put', err);
      });
  }, [router]);

  if (loading || !authed) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Spinner className="size-6 text-brand-accent" />
      </div>
    );
  }

  return (
    // fixed inset-0 + app-viewport vars (the chat-shell idiom, ticket b0edd255):
    // an in-flow h-dvh root gets pushed down by any top-of-body banner (e.g. a
    // persisting GPT anchor ad) and, with body scroll disabled app-wide, its
    // bottom banner-height strip is clipped unreachable — "management tab
    // doesnt display full height". Fixed positioning anchors to the viewport
    // and ignores in-flow insertions; --app-height/--app-top (set by
    // AppViewportVars for every /crossmodel route) pin it to the VISIBLE area.
    <div className="fixed inset-0 flex flex-col bg-background overflow-hidden" style={{ height: 'var(--app-height, 100dvh)', top: 'var(--app-top, 0px)' }}>
      {/* Header — fixed at top, never scrolls */}
      <div className="shrink-0 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 z-10" style={{ paddingTop: 'env(safe-area-inset-top, 0px)' }}>
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center gap-3">
          <PageBackButton onClick={() => router.push('/')} label="Back to chats" />
          <h1 className="text-base font-semibold">Management</h1>
        </div>

        <div className="max-w-7xl mx-auto px-4">
          <ScrollableTabBar
            ariaLabel="Management sections"
            value={activeTab}
            onChange={setActiveTab}
            tabs={TABS}
          />
        </div>
      </div>

      {/* Content — the ordinary tabs stack and PAGE-scroll here. The supervisor
          tab is HEIGHT-CONSTRAINED instead (overflow-hidden + h-full): its thread
          div then owns the scroll (internal overflow engages), which is what makes
          auto-scroll-to-newest and the pinned-scroll discipline work at all — a
          page-scrolled thread left the window at the top on load and pushed the
          composer below the fold (owner report: "doesn't automatically scroll to
          most recent message"). */}
      <div id="main" tabIndex={-1} className={cn(
        'flex-1 overscroll-y-contain outline-none',
        activeTab === 'supervisor' ? 'overflow-hidden' : 'overflow-y-auto',
      )}>
        <div className={cn(
          // Data-dense fleet overview — use the width (ticket f9ab1be1: the old
          // max-w-3xl rendered as a thin column with huge gutters on desktop).
          'mx-auto w-full max-w-7xl px-4 flex flex-col',
          // The supervisor tab locks to the viewport height so the thread owns the scroll.
          activeTab === 'supervisor' ? 'h-full py-4' : 'min-h-full py-6',
        )}>
          {activeTab === 'inbox'      && <InboxTab />}
          {activeTab === 'dashboard'  && <DashboardTab onGoSupervisor={() => setActiveTab('supervisor')}
            onOpenWake={(mid) => { setFocusMessageId(mid); setActiveTab('supervisor'); }} />}
          {activeTab === 'supervisor' && <SupervisorChatTab onGoLogs={() => setActiveTab('logs')} focusMessageId={focusMessageId ?? undefined} />}
          {activeTab === 'logs'       && <LogsTab />}
          {activeTab === 'schedules'  && <SchedulesTab />}
          {activeTab === 'framework'  && <FrameworkTab />}
        </div>
      </div>
    </div>
  );
}
