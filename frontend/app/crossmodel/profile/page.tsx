'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { authApi } from '@/lib/auth';
import { isDefinitiveAuthFailure } from '@/lib/api-client';
import { memoryApi, profileApi } from '@/lib/api/crossmodel';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { rewriteFileSchemeLinks } from '@/components/ui/custom/prompt/file-link-card';
import { cn } from '@/lib/utils';
import { enterKeySubmits, isTouchPrimary } from '@/lib/composer-enter';
import AppRail, { useRailOpen } from '@/components/ui/custom/app-rail';
import { PageBackButton } from '@/components/ui/page-back-button';
import Image from 'next/image';
import {
  Send,
  Loader2,
  User2,
  RefreshCw,
  X,
  Sparkles,
  PanelLeftOpen,
  CheckCircle2,
} from 'lucide-react';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

// ─── Profile Keys (tracked for completion %) ─────────────────────────────────
const PROFILE_KEYS = [
  'name',
  'life_stage',
  'occupation',
  'location',
  'use_case',
  'tech_level',
  'interests',
  'response_style',
  'persona',
];

// Keys to hide from the generic fact list (internal use only)
const HIDDEN_FACT_KEYS = new Set(['persona', 'persona_label', '__contextState']);

// Human-readable labels for fact keys
const FACT_LABELS: Record<string, string> = {
  name: 'Name',
  life_stage: 'Life Stage',
  occupation: 'Occupation',
  location: 'Location',
  use_case: 'Use Case',
  tech_level: 'Tech Level',
  interests: 'Interests',
  response_style: 'Response Style',
  goals: 'Goals',
  communication_style: 'Comm Style',
};

// Missing fact descriptions for continuation greeting
const MISSING_LABELS: Record<string, string> = {
  use_case: 'what you use Digby for',
  tech_level: 'your tech comfort level',
  interests: 'your interests & passions',
  response_style: 'how you like answers formatted',
  life_stage: 'your current life stage',
  location: 'where you\'re based',
  occupation: 'what you do for work',
  name: 'your name',
  goals: 'your goals',
  communication_style: 'how you like to communicate',
};

// ─── Build a warm static greeting for returning users (no API call) ─────────
function buildReturnGreeting(facts: Record<string, string>, completionPct: number): string {
  const name = facts.name;
  const missing = PROFILE_KEYS.filter(k => !facts[k] && k !== 'persona');

  if (completionPct >= 90) {
    return `Welcome back${name ? `, ${name}` : ''}! 👋 Your profile is looking really solid — ${completionPct}% complete. Digby knows you well at this point.\n\nAnything you'd like to update or refine? New job, new city, new interests? Or just want to chat about how I respond to you?`;
  }

  if (missing.length > 0) {
    const gap = MISSING_LABELS[missing[0]] || missing[0];
    const gap2 = missing[1] ? ` and ${MISSING_LABELS[missing[1]] || missing[1]}` : '';
    return `Hey${name ? ` ${name}` : ''}! 👋 Good to see you — your profile is ${completionPct}% done. We could still add ${gap}${gap2} to help me tailor responses better.\n\nWant to continue where we left off, or is there something specific you'd like to update?`;
  }

  return `Hey${name ? ` ${name}` : ''}! 👋 Your profile is all set. What would you like to update today?`;
}

export default function ProfilePage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [facts, setFacts] = useState<Record<string, string>>({});
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [currentStream, setCurrentStream] = useState('');
  const [profileComplete, setProfileComplete] = useState(false);
  const [consolidating, setConsolidating] = useState(false);

  // Mode: 'idle' = not started, 'setup' = new user interview, 'continuation' = returning user
  const [profileMode, setProfileMode] = useState<'idle' | 'setup' | 'continuation'>('idle');

  // Mobile sidebar state
  // Facts rail: shared AppRail shell (Phase 1) — open on desktop (static
  // column, matching the old always-visible md:translate-x-0 behavior),
  // closed on phones until the header toggle opens the drawer. SSR-safe.
  const [sidebarOpen, setSidebarOpen] = useRailOpen();

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<ChatMessage[]>([]);

  // Keep ref in sync with state
  useEffect(() => { messagesRef.current = messages; }, [messages]);

  // Auto-grow textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 120)}px`;
    }
  }, [input]);

  // Scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, currentStream]);

  // Load user auth + existing facts — detect returning vs new user
  useEffect(() => {
    authApi.getCurrentUser()
      .then(() => memoryApi.getMemory())
      .then((loadedFacts) => {
        setFacts(loadedFacts);

        // Detect returning user: has name + at least 2 other key profile facts
        const visibleKeys = PROFILE_KEYS.filter(k => k !== 'persona');
        const filledCount = visibleKeys.filter(k => loadedFacts[k]).length;
        const hasName = !!loadedFacts['name'];

        if (hasName && filledCount >= 3) {
          // Returning user — auto-start continuation mode with static greeting
          const completionPct = Math.min(100, Math.round(
            (PROFILE_KEYS.filter(k => loadedFacts[k]).length / PROFILE_KEYS.length) * 100
          ));
          const greeting = buildReturnGreeting(loadedFacts, completionPct);
          setMessages([{ role: 'assistant', content: greeting }]);
          setProfileMode('continuation');
        }
        // else: new/incomplete user — stay in 'idle', show setup screen
      })
      .catch((err) => {
        // 05303f58: bounce only on a definitive 401 (refresh already failed) —
        // a network blip/5xx (here possibly from the memory load) keeps the
        // token and falls through to the setup screen instead of /login.
        if (isDefinitiveAuthFailure(err)) router.push('/login?redirect=/profile');
        else console.warn('getCurrentUser/memory load failed (non-auth) — staying put', err);
      })
      .finally(() => setLoading(false));
  }, []);  // eslint-disable-line react-hooks/exhaustive-deps

  // ── Core SSE send function ────────────────────────────────────────────────
  const sendMessage = useCallback(async (messageToSend?: string) => {
    const msg = (messageToSend ?? input).trim();
    if (!msg || isStreaming) return;
    if (!messageToSend) setInput('');

    const userMsg: ChatMessage = { role: 'user', content: msg };
    setMessages(prev => [...prev, userMsg]);
    setIsStreaming(true);
    setCurrentStream('');

    const priorHistory = messagesRef.current.map(m => ({
      role: m.role,
      content: m.content,
    }));

    const token = typeof window !== 'undefined' ? localStorage.getItem('accessToken') : null;
    const apiBase = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000/api';

    // Determine current mode — if still idle when user types, default to setup
    const currentMode = profileMode === 'continuation' ? 'continuation' : 'setup';

    const params = new URLSearchParams({
      message: msg,
      mode: currentMode,
    });
    if (priorHistory.length > 0) {
      // Note: URLSearchParams.set() auto-encodes, so don't pre-encode with encodeURIComponent
      params.set('history', JSON.stringify(priorHistory));
    }
    if (token) params.set('token', token);

    const eventSource = new EventSource(`${apiBase}/crossmodel/profile/stream?${params}`);
    let streamedText = '';

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        if (data.type === 'chunk') {
          streamedText += data.data.content;
          const displayText = streamedText
            .replace(/\[MEMORY:[^\]]+\]/g, '')
            .replace(/\[PROFILE_COMPLETE\]/g, '')
            .trim();
          setCurrentStream(displayText);

        } else if (data.type === 'complete') {
          const cleanMsg = data.data.message || '';
          setMessages(prev => [...prev, { role: 'assistant', content: cleanMsg }]);
          setCurrentStream('');
          setIsStreaming(false);

          if (data.data.factsExtracted && Object.keys(data.data.factsExtracted).length > 0) {
            setFacts(prev => ({ ...prev, ...data.data.factsExtracted }));
          }

          if (data.data.profileComplete) {
            setProfileComplete(true);
            toast.success('Profile complete! 🎉 Digby knows you well now.');
          }

          eventSource.close();
        }
      } catch { /* ignore parse errors */ }
    };

    eventSource.onerror = () => {
      toast.error('Connection error. Please try again.');
      setIsStreaming(false);
      setCurrentStream('');
      eventSource.close();
    };
  }, [input, isStreaming, profileMode]);

  // ── Start interview (new users) ────────────────────────────────────────────
  const startInterview = useCallback(() => {
    setProfileMode('setup');
    sendMessage("Hi! I'd like to set up my profile.");
  }, [sendMessage]);

  // ── Restart as new user ────────────────────────────────────────────────────
  const startFreshInterview = useCallback(() => {
    setMessages([]);
    setProfileMode('setup');
    // Small delay to let state settle before sending
    setTimeout(() => {
      sendMessage("Hi! I'd like to set up my profile from scratch.");
    }, 50);
  }, [sendMessage]);

  // ── Consolidate profile ───────────────────────────────────────────────────
  const handleConsolidate = async () => {
    setConsolidating(true);
    try {
      const result = await profileApi.consolidate();
      setFacts(result.facts);
      toast.success(result.message || `Profile refreshed`);
    } catch {
      toast.error('Failed to refresh profile');
    } finally {
      setConsolidating(false);
    }
  };

  // ── Delete fact ───────────────────────────────────────────────────────────
  const handleDeleteFact = async (key: string) => {
    try {
      await memoryApi.deleteFact(key);
      setFacts(prev => { const n = { ...prev }; delete n[key]; return n; });
    } catch {
      toast.error('Failed to delete fact');
    }
  };

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const factEntries = Object.entries(facts).filter(([key]) => !HIDDEN_FACT_KEYS.has(key) && !key.startsWith('__'));
  const knownKeyCount = PROFILE_KEYS.filter(k => facts[k]).length;
  const completionPct = Math.min(100, Math.round((knownKeyCount / PROFILE_KEYS.length) * 100));
  const isActive = profileMode !== 'idle'; // whether chat is started

  return (
    <div className="flex flex-col h-screen bg-background">
      {/* ── Header ── */}
      <header className="border-b bg-card/80 backdrop-blur-sm sticky top-0 z-(--z-rail)" style={{ paddingTop: 'env(safe-area-inset-top, 0px)' }}>
        <div className="px-4 py-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <PageBackButton onClick={() => router.push('/')} label="Back to chats" />
            <div className="size-8 rounded-xl overflow-hidden shadow-md flex-shrink-0">
              <Image src="/digbyhat.png" alt="Digby" width={32} height={32} className="w-full h-full object-cover" />
            </div>
            <div>
              <h1 className="text-base font-bold tracking-tight leading-none">
                AI Profile
              </h1>
              <p className="text-[10px] text-muted-foreground leading-none mt-0.5">
                {profileMode === 'continuation' ? 'Update your profile' : 'Tell Digby about yourself'}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {/* Mobile: sidebar toggle with fact count badge */}
            <Button
              variant="outline"
              size="icon"
              className="size-8 relative md:hidden"
              onClick={() => setSidebarOpen(s => !s)}
              title="View profile facts"
            >
              <PanelLeftOpen className="size-4" />
              {factEntries.length > 0 && (
                <span className="absolute -top-1 -right-1 size-4 rounded-full bg-send text-send-ink text-[9px] flex items-center justify-center font-bold leading-none">
                  {factEntries.length}
                </span>
              )}
            </Button>

            {/* Desktop: completion % badge */}
            {factEntries.length > 0 && (
              <Badge variant="outline" className="text-xs gap-1.5 hidden md:flex">
                {completionPct >= 100
                  ? <CheckCircle2 className="size-3 text-success-accent" />
                  : <div className="size-1.5 rounded-full bg-ink-2" />}
                {completionPct}% complete
              </Badge>
            )}

            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1.5 text-xs"
              onClick={handleConsolidate}
              disabled={consolidating}
              title="Digby reviews your facts + recent chats to improve your profile"
            >
              {consolidating
                ? <Loader2 className="size-3.5 animate-spin" />
                : <RefreshCw className="size-3.5" />}
              <span className="hidden sm:inline">Refresh</span>
            </Button>
          </div>
        </div>
      </header>

      {/* ── Body ── */}
      <div className="flex flex-1 overflow-hidden relative">

        {/* ── Left: Profile facts panel — shared AppRail shell (Phase 1):
            mobile drawer with dialog semantics + backdrop, md+ static column.
            Content below is unchanged. ── */}
        <AppRail
          open={sidebarOpen}
          onClose={() => setSidebarOpen(false)}
          label="Profile facts"
          className="bg-card"
        >
          {/* Sidebar header */}
          <div className="p-4 border-b flex-shrink-0">
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-sm font-semibold flex items-center gap-1.5">
                <User2 className="size-3.5 text-ink" />
                Your Profile
              </h2>
              <div className="flex items-center gap-2">
                {completionPct > 0 && (
                  <span className="text-xs text-muted-foreground font-mono">{completionPct}%</span>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-6 md:hidden"
                  onClick={() => setSidebarOpen(false)}
                >
                  <X className="size-3.5" />
                </Button>
              </div>
            </div>
            {/* Progress bar */}
            <div className="w-full bg-muted rounded-full h-1.5">
              <div
                className="bg-ink h-1.5 rounded-full transition-all duration-700"
                style={{ width: `${completionPct}%` }}
              />
            </div>
          </div>

          <ScrollArea className="flex-1 min-h-0">
            <div className="p-3 space-y-1.5">
              {factEntries.length === 0 ? (
                <div className="text-center py-10 px-3">
                  <div className="size-8 mx-auto mb-3 opacity-30 rounded-lg overflow-hidden">
                    <Image src="/digbyhat.png" alt="Digby" width={32} height={32} className="w-full h-full object-cover" />
                  </div>
                  <p className="text-xs text-muted-foreground">No profile facts yet</p>
                  <p className="text-xs text-muted-foreground/60 mt-1">
                    Chat with Digby → profile builds automatically
                  </p>
                </div>
              ) : (
                factEntries.map(([key, value]) => (
                  <div
                    key={key}
                    className="group rounded-lg border bg-card/60 px-3 py-2 hover:bg-muted/30 transition-colors"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <p className="text-[12px] font-medium text-ink-3">
                          {FACT_LABELS[key] || key.replace(/_/g, ' ')}
                        </p>
                        <p className="text-xs mt-0.5 leading-snug break-words">
                          {typeof value === 'object' && value !== null
                            ? JSON.stringify(value)
                            : String(value ?? '')}
                        </p>
                      </div>
                      <button
                        onClick={() => handleDeleteFact(key)}
                        className="opacity-60 md:opacity-0 md:group-hover:opacity-100 p-0.5 rounded hover:text-destructive text-muted-foreground transition-all flex-shrink-0 mt-0.5"
                        title="Remove fact"
                      >
                        <X className="size-3" />
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>

            {/* Re-interview option for returning users */}
            {profileMode === 'continuation' && factEntries.length > 0 && (
              <div className="px-3 pb-3">
                <button
                  onClick={startFreshInterview}
                  className="w-full text-xs text-muted-foreground/60 hover:text-muted-foreground py-1.5 rounded border border-dashed hover:border-muted-foreground/30 transition-colors"
                >
                  Start fresh interview →
                </button>
              </div>
            )}
          </ScrollArea>

          {/* Profile complete banner */}
          {profileComplete && (
            <div className="p-3 border-t bg-gradient-to-r from-hover to-hover flex-shrink-0">
              <div className="flex items-center gap-2 text-xs font-medium text-warn-ink">
                <Sparkles className="size-3.5" />
                Profile complete!
              </div>
              <p className="text-[10px] text-muted-foreground mt-0.5">
                Your AI memory is fully set up.
              </p>
            </div>
          )}
        </AppRail>

        {/* ── Right: Digby chat ── */}
        <div className="flex flex-col flex-1 overflow-hidden min-w-0">
          {/* Messages */}
          <ScrollArea className="flex-1 min-h-0">
            <div className="max-w-2xl mx-auto px-4 py-6 space-y-4">

              {/* ── Welcome state — new user (idle, no messages) ── */}
              {profileMode === 'idle' && messages.length === 0 && (
                <div className="flex flex-col items-center justify-center py-12 sm:py-16 text-center px-2">
                  <div className="size-16 rounded-2xl overflow-hidden shadow-lg mb-5">
                    <Image src="/digbyhat.png" alt="Digby" width={64} height={64} className="w-full h-full object-cover" />
                  </div>
                  <h2 className="text-xl font-bold mb-2">Meet Digby, your AI companion</h2>
                  <p className="text-muted-foreground text-sm max-w-sm mb-3">
                    Digby will ask you a few questions to understand who you are — your background, expertise, and goals — so every AI response on Digby feels made specifically for you.
                  </p>
                  <p className="text-muted-foreground/60 text-xs max-w-xs mb-8">
                    The more Digby knows about you, the better every answer gets.
                  </p>

                  <Button
                    onClick={startInterview}
                    className="bg-send text-send-ink hover:opacity-90 border-0 gap-2"
                    disabled={isStreaming}
                  >
                    <Sparkles className="size-4" />
                    Start Profile Interview
                  </Button>
                </div>
              )}

              {/* ── Chat messages ── */}
              {messages.map((msg, i) => (
                <div key={i} className={cn('flex gap-2', msg.role === 'user' ? 'justify-end' : 'justify-start')}>
                  {msg.role === 'assistant' && (
                    <div className="size-7 rounded-full overflow-hidden flex-shrink-0 mt-0.5 shadow-sm">
                      <Image src="/digbyhat.png" alt="Digby" width={28} height={28} className="w-full h-full object-cover" />
                    </div>
                  )}
                  <div className={cn(
                    'max-w-[82%] rounded-2xl px-4 py-2.5 text-sm',
                    msg.role === 'user'
                      ? 'rounded-br-sm bg-primary text-primary-foreground'
                      : 'rounded-bl-sm bg-muted/70 text-foreground'
                  )}>
                    {msg.role === 'assistant' ? (
                      <div className="prose prose-sm dark:prose-invert max-w-none leading-relaxed">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{rewriteFileSchemeLinks(msg.content)}</ReactMarkdown>
                      </div>
                    ) : (
                      <p className="whitespace-pre-wrap leading-relaxed">{msg.content}</p>
                    )}
                  </div>
                </div>
              ))}

              {/* Streaming message */}
              {isStreaming && (
                <div className="flex gap-2 justify-start">
                  <div className="size-7 rounded-full overflow-hidden flex-shrink-0 mt-0.5 shadow-sm">
                    <Image src="/digbyhat.png" alt="Digby" width={28} height={28} className="w-full h-full object-cover" />
                  </div>
                  <div className="max-w-[82%] rounded-2xl rounded-bl-sm bg-muted/70 px-4 py-2.5 text-sm">
                    {currentStream ? (
                      <div className="prose prose-sm dark:prose-invert max-w-none leading-relaxed">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{rewriteFileSchemeLinks(currentStream)}</ReactMarkdown>
                      </div>
                    ) : (
                      <div className="flex items-center gap-1 py-0.5">
                        {[0, 1, 2].map((i) => (
                          <div
                            key={i}
                            className="size-1.5 rounded-full bg-muted-foreground/40 animate-bounce"
                            style={{ animationDelay: `${i * 0.15}s` }}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Profile complete CTA — mobile only */}
              {profileComplete && messages.length > 0 && (
                <div className="flex justify-center py-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-2 text-xs h-8 md:hidden"
                    onClick={() => setSidebarOpen(true)}
                  >
                    <User2 className="size-3.5 text-ink" />
                    View your profile facts
                  </Button>
                </div>
              )}

              <div ref={messagesEndRef} />
            </div>
          </ScrollArea>

          {/* Input area — shown for continuation (always) or after setup starts */}
          {isActive && (
            <div className="border-t bg-card/80 backdrop-blur-sm p-4 flex-shrink-0">
              <div className="max-w-2xl mx-auto flex gap-2 items-end">
                <Textarea
                  ref={textareaRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder={profileMode === 'continuation'
                    ? "Update anything, or just chat…"
                    : "Type your answer… (Shift+Enter for new line)"}
                  disabled={isStreaming}
                  rows={1}
                  className="flex-1 min-h-[44px] max-h-[120px] py-2.5 px-3 resize-none overflow-y-hidden leading-snug"
                  onKeyDown={(e) => {
                    // Device-aware Enter (ticket 67fc53a7): desktop sends on
                    // plain Enter (Shift+Enter newline); touch-primary gets
                    // the iMessage behavior (Enter = newline).
                    if (enterKeySubmits(e, undefined, isTouchPrimary())) {
                      e.preventDefault();
                      sendMessage();
                    }
                  }}
                />
                <Button
                  type="button"
                  disabled={!input.trim() || isStreaming}
                  onClick={() => sendMessage()}
                  className="h-11 px-4 bg-send text-send-ink hover:opacity-90 border-0 flex-shrink-0"
                >
                  {isStreaming
                    ? <Loader2 className="size-4 animate-spin" />
                    : <Send className="size-4" />
                  }
                </Button>
              </div>
              <p className="text-[10px] text-muted-foreground text-center mt-2 opacity-60">
                {profileMode === 'continuation'
                  ? 'Digby automatically saves any updates you share'
                  : 'Digby automatically saves your answers as profile facts'}
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
