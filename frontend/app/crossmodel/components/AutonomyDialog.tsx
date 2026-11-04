'use client';

/**
 * Per-chat AUTONOMY editor (ticket ba733210 — "autonomy grant undiscoverable").
 *
 * The backend has long had per-chat autonomy grants (PUT /crossmodel/platform/
 * chats/:id/autonomy — which consequential platform tools this chat may run
 * WITHOUT a confirmation card, plus its scheduled-firings/day cap), but since
 * the fleet mission-control page was removed NO surface showed or edited them:
 * users assumed the coding "Agent mode: Auto" implied it (it doesn't — that
 * gates in-workspace edits/commands only). Opened from the ⋯ chat menu
 * (FloatingChrome "Autonomy…" item). Owner-only server-side; a 403/404 on save
 * surfaces as a toast.
 *
 * Empty tool selection = REVOKE (mirrors the backend contract: an empty
 * allowedTools deletes the grant so the confirmation gate applies again).
 *
 * Agent-mode auto-grant (owner 2026-09-07): a CODING chat set to Auto gets this
 * grant materialized automatically (all tools, default cap, source
 * 'agent_mode_auto') and revoked when the mode leaves Auto. The dialog says so
 * honestly, and any save from here converts the grant to a MANUAL one that
 * mode flips no longer touch.
 */

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Loader2, ShieldCheck } from 'lucide-react';
import {
  fleetApi,
  FLEET_AUTONOMY_TOOLS,
  FLEET_MAX_SCHEDULE_CAP,
  type FleetAutonomyTool,
} from '@/lib/api/platform';

/** Backend DEFAULT_SCHEDULE_CAP — pre-filled when no grant exists yet. */
const DEFAULT_SCHEDULE_CAP = 48;

const TOOL_LABELS: Record<FleetAutonomyTool, string> = {
  send_chat_message: 'Send messages to other chats',
  start_coding_session: 'Start coding sessions',
  schedule_message: 'Create scheduled runs',
  cancel_schedule: 'Cancel scheduled runs',
  update_schedule: 'Update scheduled runs',
  dispatch_platform_task: 'Dispatch platform tasks',
  send_to_instance: 'Send messages to paired instances',
};

export default function AutonomyDialog({ chatId, chatTitle, onClose }: {
  chatId: string;
  chatTitle?: string;
  onClose: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [allowed, setAllowed] = useState<Set<FleetAutonomyTool>>(new Set());
  const [scheduleCap, setScheduleCap] = useState<number>(DEFAULT_SCHEDULE_CAP);
  /** Whether a grant currently exists server-side (drives the status line). */
  const [hasGrant, setHasGrant] = useState(false);
  /** True when the grant was materialized by Agent mode = Auto (source 'agent_mode_auto'). */
  const [autoGranted, setAutoGranted] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fleetApi.getAutonomy(chatId)
      .then((g) => {
        if (cancelled) return;
        setHasGrant(true);
        setAutoGranted(g.source === 'agent_mode_auto');
        setAllowed(new Set(g.allowedTools.filter((t): t is FleetAutonomyTool =>
          (FLEET_AUTONOMY_TOOLS as string[]).includes(t))));
        setScheduleCap(g.scheduleCap || DEFAULT_SCHEDULE_CAP);
      })
      .catch(() => {
        // 404 = no grant yet — the normal confirmation gate applies. Render an
        // empty editor (a network error degrades the same way; save still works).
        if (cancelled) return;
        setHasGrant(false);
        setAutoGranted(false);
        setAllowed(new Set());
        setScheduleCap(DEFAULT_SCHEDULE_CAP);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [chatId]);

  const toggle = (tool: FleetAutonomyTool) => {
    setAllowed((prev) => {
      const next = new Set(prev);
      if (next.has(tool)) next.delete(tool); else next.add(tool);
      return next;
    });
  };

  const save = async () => {
    setSaving(true);
    try {
      const tools = FLEET_AUTONOMY_TOOLS.filter((t) => allowed.has(t));
      const result = await fleetApi.putAutonomy(chatId, {
        allowedTools: tools,
        ...(tools.length > 0 ? { scheduleCap } : {}),
      });
      toast.success(result.granted
        ? `Autonomy granted: ${result.allowedTools.length} tool${result.allowedTools.length === 1 ? '' : 's'}`
        : 'Autonomy revoked — confirmations required again');
      onClose();
    } catch (e: any) {
      toast.error(e?.response?.data?.message || e?.response?.data?.error || 'Could not save the autonomy grant');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            <ShieldCheck className="size-4 text-ink-3" />
            Autonomy{chatTitle ? ` — ${chatTitle}` : ''}
          </DialogTitle>
          <DialogDescription className="text-xs">
            Checked tools run in this chat <strong>without a confirmation card</strong> —
            including scheduled and hook-triggered runs. On coding chats, setting
            Agent mode to <em>Auto</em> grants all of these automatically (and
            leaving Auto revokes that grant); edits made here are yours and
            survive mode changes.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center gap-2 py-4 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" /> Loading grant…
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-[11px] text-muted-foreground">
              {autoGranted
                ? 'Granted automatically — this chat’s Agent mode is Auto. Saving changes here converts it to a manual grant that Agent-mode changes won’t alter.'
                : hasGrant
                  ? 'This chat has an autonomy grant. Uncheck everything to revoke it.'
                  : 'No grant yet — every consequential action stages a confirmation card.'}
            </p>

            <div className="space-y-2">
              {FLEET_AUTONOMY_TOOLS.map((tool) => (
                <div key={tool} className="flex items-center gap-2">
                  <Checkbox
                    id={`autonomy-${tool}`}
                    checked={allowed.has(tool)}
                    onCheckedChange={() => toggle(tool)}
                  />
                  <Label htmlFor={`autonomy-${tool}`} className="text-xs font-normal cursor-pointer">
                    {TOOL_LABELS[tool]}
                    <span className="ml-1.5 font-mono text-[10px] text-muted-foreground">{tool}</span>
                  </Label>
                </div>
              ))}
            </div>

            <div className="space-y-1">
              <Label htmlFor="autonomy-cap" className="text-xs">
                Scheduled runs per day (cap)
              </Label>
              <Input
                id="autonomy-cap"
                type="number"
                min={1}
                max={FLEET_MAX_SCHEDULE_CAP}
                value={scheduleCap}
                onChange={(e) => setScheduleCap(Number(e.target.value) || DEFAULT_SCHEDULE_CAP)}
                disabled={allowed.size === 0}
                className="h-8 w-28 text-xs"
              />
              <p className="text-[10px] text-muted-foreground">
                Backstops runaway schedules/hooks (1–{FLEET_MAX_SCHEDULE_CAP}; default {DEFAULT_SCHEDULE_CAP}).
              </p>
            </div>

            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" className="h-8 text-xs" onClick={onClose} disabled={saving}>
                Cancel
              </Button>
              <Button size="sm" className="h-8 text-xs gap-1.5" onClick={save} disabled={saving}>
                {saving && <Loader2 className="size-3.5 animate-spin" />}
                {allowed.size === 0 && hasGrant ? 'Revoke grant' : 'Save'}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
