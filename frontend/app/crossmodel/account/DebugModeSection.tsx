'use client';

/**
 * Admin → Settings → "Debug mode" (owner 2026-10-16: "a mode on the admin account that is debug mode that shows
 * everything how it is today and if we turn off debug mode in settings it will show like a user sees chats and
 * sessions"). Per-admin — it changes only what THIS admin sees. ON (the default) is today's full view; OFF is the
 * minimal view every user gets (lib/view-mode.ts). Flipping reloads the page so every transcript is re-read in the
 * new mode (the server filters what it sends).
 */

import { useState } from 'react';
import { toast } from 'sonner';
import { Bug, Loader2 } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { setDebugMode, useViewMode } from '@/lib/view-mode';

export const DEBUG_MODE_FACTS: readonly string[] = [
  'On: everything, as today — tool calls and output, reasoning toggles, harness notes, machine wake-ups, models, tokens and cost.',
  'Off: exactly what users see — answers, one-line activity rows ("Terminal · Ran 3 commands"), "Message from …" lines between sessions, task cards without steps or spend.',
  'Only changes your own view. Users always get the minimal view; the server never sends them the hidden detail.',
];

export function DebugModeSection() {
  const { debugMode, loaded } = useViewMode();
  const [saving, setSaving] = useState(false);
  const on = debugMode !== false;

  const flip = async (next: boolean) => {
    setSaving(true);
    try {
      await setDebugMode(next); // reloads the page
    } catch {
      toast.error('Could not change Debug mode');
      setSaving(false);
    }
  };

  return (
    <div className="rounded-lg border bg-card p-5 space-y-4" data-testid="debug-mode-section">
      <div className="flex items-center gap-2">
        <Bug className="size-4 text-muted-foreground" />
        <h3 className="text-sm font-semibold">Debug mode</h3>
      </div>
      <p className="text-xs text-muted-foreground">
        Turn this off to see chats and sessions exactly as a user does.
      </p>
      <div className="flex items-start justify-between gap-4 rounded-md bg-muted/40 px-3 py-3">
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">Show everything</span>
            {!loaded ? <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
              : on ? <Badge variant="success" className="text-[10px]">ON</Badge>
              : <Badge variant="warning" className="text-[10px]">OFF — user view</Badge>}
          </div>
        </div>
        <Switch aria-label="Debug mode" checked={on} disabled={saving || !loaded} onCheckedChange={(v) => void flip(v)} />
      </div>
      <ul className="list-disc pl-4 space-y-0.5">
        {DEBUG_MODE_FACTS.map((f) => <li key={f} className="text-xs text-muted-foreground">{f}</li>)}
      </ul>
    </div>
  );
}
