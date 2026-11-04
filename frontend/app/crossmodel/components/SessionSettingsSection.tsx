'use client';

/**
 * SessionSettingsSection — the workspace panel's "Settings" tab (owner
 * directive 2026-09-09: "shouldn't it be just the sidebar icon and then the
 * settings that show in the other icon should show in a tab within the
 * sidebar?"). Everything the floating ⋯ menu offered for a mounted session now
 * lives HERE, as a scrollable settings pane inside the right panel:
 *
 *   · Chat          — New chat · Attach a workspace (plain chats) · Autonomy…
 *   · Patience      — kids only: the "Kids mode" note (plain flavor). The level radios are gone
 *                     (roster 2026-10-06 B-3: Digby picks depth and models per message).
 *   · Workspace     — branch/model/status · Push branch · Open pull request ·
 *                     Agent mode (workspace-backed sessions only)
 *
 * The ⋯ pill itself disappears whenever this tab is mounted (FloatingChrome
 * hides it when a panel-capable session is open), so the top-right chrome is
 * ONE control — the panel toggle. The ⋯ menu still serves the surfaces that
 * have no panel: the home screen and guest sessions.
 *
 * Presentation is a plain vertical form (buttons + radio-style rows built on
 * the app's button styles) — no dropdown primitives, so it reads as a settings
 * page, not a menu pasted into a column.
 */

import { useEffect, useReducer, useRef, useState } from 'react';
import { Check, GitBranch, Github, Ghost, Loader2, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { crossModelApi } from '@/lib/api/crossmodel';
import { ghostRowReducer, GHOST_ROW_INITIAL } from '@/lib/ghost-composer';
import type { PermissionMode } from '@/lib/api/coding';
import { displayModelId } from '@/lib/model-alias';
import { useMinimalView } from '@/lib/view-mode';
import { Switch } from '@/components/ui/switch';
import type { CodingChrome } from './FloatingChrome';

const AGENT_MODE_LABEL: Record<PermissionMode, string> = { auto: 'Auto', plan: 'Plan', ask: 'Ask' };
const AGENT_MODE_HINT: Record<PermissionMode, string> = {
  auto: 'Fully autonomous — workspace edits, commands, and platform actions. Deletes still ask.',
  plan: 'Proposes a plan and waits for your go-ahead before acting.',
  ask: 'Asks before every consequential action.',
};

export interface SessionSettingsProps {
  isLoggedIn: boolean;
  isKid?: boolean;
  /** The PLAIN flavor (workspace chats carry Agent mode): a kid sees the "Kids mode" note here. */
  showPatience?: boolean;
  /** The ONE power gesture on a satellite-less plain chat (User Space P3 §6.3). */
  onAttachWorkspace?: () => void;
  /** Per-chat Autonomy grant editor (ticket ba733210). */
  onOpenAutonomy?: () => void;
  /** Workspace chrome pushed up by the mounted session (null = no satellite). */
  coding?: CodingChrome | null;
  /** Standing-instructions editor (capability gap audit T3b, 2026-09-24): the
   *  chat whose per-chat systemPrompt this pane edits (owner-only; omit to hide). */
  instructionsChatId?: string | null;
  /** Ghost mode (2026-10-22): the owner's own PLAIN chat the switch edits.
   *  Omit for coding sessions, supervisor/coding-flavored surfaces and kids —
   *  ghost is a plain-chat control (supervisor/coding chats never offer it). */
  ghostChatId?: string | null;
  /** The host's view of that chat's posture (the sidebar row) — the switch
   *  follows it when the composer's ghost toggle flips the same chat
   *  (2026-10-22). Undefined = unknown; the row self-loads as before. */
  ghostMode?: boolean;
  /** Fired after a successful ghost-mode save so the host can patch its
   *  sidebar row (the header badge reads it). `saved` is the PUT's answer (the
   *  chat row) — its updatedAt orders the host's hold against a stale list row. */
  onGhostChanged?: (chatId: string, ghostMode: boolean, saved?: unknown) => void;
}

const INSTRUCTIONS_MAX = 20000;
/** Ghost mode — the honest one-liner (lib/ghost-mode.ts owns the exact copy;
 *  it names guarantees the backend really implements — keep them in sync). */
const GHOST_HINT = "Ghost mode routes this chat through the admin's private endpoint and keeps it out of memory and learning. Your transcript stays in your account.";

/**
 * Ghost mode (2026-10-22) — the per-chat switch for the owner's own PLAIN
 * chat. Self-loads chat.ghostMode via getChat (the sidebar row carries it
 * too, but the panel may mount before the list refreshes) and saves with
 * updateChat — the backend applies the routing server-side, so nothing rides
 * the send. Kids never see it (adult surfaces); coding sessions don't take it
 * (the caller omits the chat id there).
 */
function GhostModeRow({ chatId, hint, onChanged }: { chatId: string; hint?: boolean; onChanged?: (ghostMode: boolean, saved?: unknown) => void }) {
  // lib/ghost-composer.ts ghostRowReducer: a hint or this row's own save
  // SETTLES the value, so the mount-time read can never reset a newer flip;
  // no hint (the composer toggle's kill switch) is the self-loading row as
  // before — 'Loading…' and disabled until the read answers.
  const [row, dispatch] = useReducer(ghostRowReducer, GHOST_ROW_INITIAL);
  const { value } = row;
  const [saving, setSaving] = useState(false);
  const chatIdRef = useRef(chatId);
  useEffect(() => {
    let alive = true;
    chatIdRef.current = chatId;
    dispatch({ type: 'open' });
    crossModelApi.getChat(chatId, { messageLimit: 1 })
      .then((full: any) => {
        if (alive) dispatch({ type: 'loaded', ghostMode: !!full?.ghostMode, supervisor: !!(full?.isSupervisor || full?.isProjectSupervisor) });
      })
      .catch(() => { if (alive) dispatch({ type: 'load_failed' }); }) // an older backend has no field — off
      .finally(() => { /* the row's own state carries the loading look */ });
    return () => { alive = false; };
  }, [chatId]);
  // The composer's ghost toggle (2026-10-22) flips the same chat and patches
  // the host's row — follow it so the two controls never disagree. Keyed on
  // chatId too: declared after the self-load, so a new chat's 'open' never
  // wipes the hint the host already holds for it.
  useEffect(() => {
    dispatch({ type: 'hint', hint });
  }, [chatId, hint]);
  const toggle = async (next: boolean) => {
    if (saving || value === null) return;
    const savingFor = chatId;
    setSaving(true);
    try {
      const saved: unknown = await crossModelApi.updateChat(savingFor, { ghostMode: next });
      // A save that lands after the panel moved to another chat must not
      // paint that chat's switch (the host's row patch still goes out).
      if (chatIdRef.current === savingFor) dispatch({ type: 'saved', ghostMode: next });
      onChanged?.(next, saved);
      toast.success(next ? 'Ghost mode on for this chat' : 'Ghost mode off');
    } catch (err: any) {
      toast.error(err?.response?.data?.error || err?.message || 'Could not change ghost mode');
    } finally {
      setSaving(false);
    }
  };
  // A supervisor chat (the row's own read — a minimal sidebar row may lack
  // the flag) cannot run in ghost mode: the save would 400, so no switch.
  if (row.supervisor) return null;
  return (
    <Group title="Ghost mode" hint={GHOST_HINT}>
      <div className="flex items-center justify-between gap-2 px-2 py-1">
        <span className="text-xs text-muted-foreground inline-flex items-start gap-1.5" data-testid="ghost-mode-row-status">
          <Ghost className="size-3.5 shrink-0 mt-px text-muted-foreground" />
          <span>
            {value === null ? 'Loading…' : value ? 'On — this chat runs on the admin’s private endpoint and stays out of memory and learning.' : 'Off'}
          </span>
        </span>
        <Switch
          aria-label="Ghost mode"
          checked={value === true}
          disabled={saving || value === null}
          onCheckedChange={(v) => void toggle(v)}
          data-testid="ghost-mode-switch"
        />
      </div>
    </Group>
  );
}

/** Standing instructions — the per-chat systemPrompt agents can also set via
 *  set_chat_instructions. Loads on mount, saves on demand (PUT /chats/:id). */
function StandingInstructions({ chatId }: { chatId: string }) {
  const [value, setValue] = useState('');
  const [saved, setSaved] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    crossModelApi.getChat(chatId, { messageLimit: 1 })
      .then((full: any) => { if (!alive) return; const v = typeof full?.systemPrompt === 'string' ? full.systemPrompt : ''; setValue(v); setSaved(v); })
      .catch(() => { /* no editor state — the textarea stays empty */ })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [chatId]);
  const dirty = value.trim() !== saved.trim();
  const save = async () => {
    setSaving(true);
    try {
      await crossModelApi.updateChat(chatId, { systemPrompt: value.trim() ? value.trim() : null });
      setSaved(value.trim());
      toast.success(value.trim() ? 'Standing instructions saved' : 'Standing instructions cleared');
    } catch (err: any) {
      toast.error(err?.response?.data?.error || err?.message || 'Could not save the instructions');
    } finally { setSaving(false); }
  };
  return (
    <Group
      title="Standing instructions"
      hint="Applied to every future turn of this chat, after the project instructions. Agents can set these too (set_chat_instructions) — what you see here is what they wrote."
    >
      <textarea
        id={`standing-instructions-${chatId}`}
        value={value}
        onChange={(e) => setValue(e.target.value.slice(0, INSTRUCTIONS_MAX))}
        disabled={loading || saving}
        placeholder={loading ? 'Loading…' : 'e.g. Always answer in French. Keep replies under 200 words.'}
        rows={4}
        className="w-full resize-y rounded-md border border-border bg-background px-2 py-1.5 text-xs leading-snug text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
      />
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-muted-foreground/80">{value.length.toLocaleString()} / {INSTRUCTIONS_MAX.toLocaleString()}</span>
        <button
          type="button"
          onClick={save}
          disabled={!dirty || loading || saving}
          className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-foreground hover:bg-muted disabled:opacity-50 disabled:hover:bg-transparent transition-colors"
        >
          {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
          {saved.trim() && !value.trim() ? 'Clear' : 'Save'}
        </button>
      </div>
    </Group>
  );
}

function Group({ title, children, hint }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="px-3 py-3 border-b border-border last:border-b-0">
      <h3 className="text-[12px] font-medium text-ink-3 mb-2">{title}</h3>
      <div className="space-y-1">{children}</div>
      {hint && <p className="mt-2 text-[11px] leading-snug text-muted-foreground/80">{hint}</p>}
    </section>
  );
}

function ActionRow({ icon, label, onClick, disabled }: { icon: React.ReactNode; label: string; onClick?: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="w-full flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-foreground hover:bg-muted disabled:opacity-50 disabled:hover:bg-transparent transition-colors"
    >
      <span className="text-muted-foreground shrink-0 [&_svg]:size-4">{icon}</span>
      <span className="truncate">{label}</span>
    </button>
  );
}

function ChoiceRow({ label, hint, selected, onSelect }: { label: string; hint?: string; selected: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={cn(
        'w-full flex items-start gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors',
        selected ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
      )}
    >
      <span className={cn('mt-0.5 size-3.5 shrink-0 rounded-full border flex items-center justify-center', selected ? 'border-ink bg-ink text-background' : 'border-border')}>
        {selected && <Check className="size-2.5" />}
      </span>
      <span className="min-w-0">
        <span className="block truncate">{label}</span>
        {hint && <span className="block text-[11px] text-muted-foreground/80 leading-snug">{hint}</span>}
      </span>
    </button>
  );
}

export default function SessionSettingsSection(props: SessionSettingsProps) {
  // Minimal view (2026-10-16): no model id for a user.
  const minimal = useMinimalView();
  const {
    isLoggedIn, isKid, showPatience, onAttachWorkspace, onOpenAutonomy, coding, instructionsChatId, ghostChatId, ghostMode, onGhostChanged,
  } = props;
  const showAutonomy = isLoggedIn && !isKid && !!onOpenAutonomy;

  return (
    <div className="h-full min-h-0 overflow-y-auto bg-background" data-slot="session-settings">
      {/* New chat lives on the sidebar (+ the header while the rail is
          closed) — one home per action (owner 2026-10-06). */}
      {(onAttachWorkspace || showAutonomy) && (
        <Group title="Chat">
          {onAttachWorkspace && <ActionRow icon={<GitBranch />} label="Attach a workspace" onClick={onAttachWorkspace} />}
          {showAutonomy && <ActionRow icon={<ShieldCheck />} label="Autonomy…" onClick={onOpenAutonomy!} />}
        </Group>
      )}

      {isLoggedIn && !isKid && instructionsChatId && <StandingInstructions chatId={instructionsChatId} />}

      {/* Ghost mode (2026-10-22): the owner's own PLAIN chats only — the
          caller omits ghostChatId for coding sessions and kid accounts. */}
      {isLoggedIn && !isKid && ghostChatId && (
        <GhostModeRow chatId={ghostChatId} hint={ghostMode} onChanged={(v, saved) => onGhostChanged?.(ghostChatId, v, saved)} />
      )}

      {/* roster 2026-10-06 B-3: no Patience levels — Digby picks depth and models per message, and the
          answer's own "Dig deeper" chip is the per-question control. Kids keep their note. */}
      {showPatience && isKid && (
        <Group title="Patience">
          <p className="px-2 text-xs text-muted-foreground">🧒 Kids mode</p>
        </Group>
      )}

      {coding && (
        <>
          <Group title="Workspace">
            <div className="px-2 pb-1">
              <span className="flex items-center gap-1.5 min-w-0">
                <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="font-mono text-xs truncate">{coding.branch}</span>
              </span>
              {/* displayModelId: sessions stamped before a model cutover store
                  the LEGACY id (e.g. glm-5.2) — show the current one. */}
              <span className="block text-[11px] text-muted-foreground truncate mt-0.5">
                {!minimal && displayModelId(coding.model)}
                {coding.status === 'provisioning' && (minimal ? 'Setting up…' : ' · provisioning…')}
                {coding.status === 'error' && ` · error: ${coding.errorMessage || 'provisioning failed'}`}
              </span>
            </div>
            <ActionRow
              icon={coding.publishing === 'push' ? <Loader2 className="animate-spin" /> : <GitBranch />}
              label="Push branch"
              disabled={coding.publishing !== null}
              onClick={() => coding.actions.push()}
            />
            <ActionRow
              icon={coding.publishing === 'pr' ? <Loader2 className="animate-spin" /> : <Github />}
              label="Open pull request"
              disabled={coding.publishing !== null}
              onClick={() => coding.actions.openPr()}
            />
          </Group>
          <Group
            title="Agent mode"
            hint="Auto grants this chat’s Autonomy automatically while selected; leaving Auto revokes it. Plain chats use the Autonomy grant above instead."
          >
            <div role="radiogroup" aria-label="Agent mode">
              {(['auto', 'plan', 'ask'] as PermissionMode[]).map((m) => (
                <ChoiceRow
                  key={m}
                  label={AGENT_MODE_LABEL[m]}
                  hint={AGENT_MODE_HINT[m]}
                  selected={coding.permissionMode === m}
                  onSelect={() => coding.actions.setPermissionMode(m)}
                />
              ))}
            </div>
          </Group>
        </>
      )}
    </div>
  );
}
