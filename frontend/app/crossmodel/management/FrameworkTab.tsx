'use client';

/**
 * Management → Framework tab (ticket 9471d338).
 *
 * The Digby Framework project (the platform's own repo-backed project) left
 * the user-facing sidebar — this tab is its only home. It surfaces the SAME
 * live surface the project pages render (sessions/lanes, goal board via the
 * hourly digest, workspace status, backlog pointer) but hardened: it is a
 * VIEW — no rename/move/delete/share affordances (the API refuses them
 * anyway), and the "open in chat" links deep-link to /crossmodel?chatId=…
 * for every chat, so the owner keeps full access. Loading / empty / error
 * states throughout; nothing here moves or deletes data.
 *
 * `FrameworkSurface` is the presentational core (statically testable, the
 * repo's node-environment vitest idiom); `FrameworkTab` is the fetching
 * container.
 *
 * The Goals & board panel renders in THREE sections — Active delivery ·
 * Paused · Monitoring — not one flat list (owner ticket 2026-11-04): a
 * parked program and a standing monitor probe are not delivery rows, and
 * printing their raw DB status ("blocked" / "active") misreads both. See
 * `boardSectionOf` / `boardStatusLabel` for the classification rules.
 */

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { toast } from 'sonner';
import { Bot, CircleDot, ExternalLink, FileCode2, GitBranch, RefreshCw, Target } from 'lucide-react';
import { projectsApi, type Project, type ProjectSessionRow } from '@/lib/api/crossmodel';
import { fleetApi, type FleetDigest, type FleetGoalEta } from '@/lib/api/fleet';
import { fleetApi as platformFleetApi, type FleetGoal } from '@/lib/api/platform';

/**
 * ONE goal row on the Framework tab's board, whichever source produced it.
 *
 * Deliberately NOT `FleetDigestGoalProgress`: the goals fallback (below) reads
 * the platform goals API, which carries no completion history, so `eta` is
 * absent there and the board must not invent a pace projection it cannot know.
 * `eta` stays optional so the digest source can still supply the real one.
 */
export interface FrameworkBoardGoal {
  goalId: string;
  title: string;
  status: string;
  todosDone: number;
  todosTotal: number;
  /** Blocked todos under this goal (gates the amber styling). */
  blockedCount: number;
  /** Project-Pulse pace/ETA — the digest source only (ticket 2162c692). */
  eta?: FleetGoalEta;
}

/**
 * Where the board's rows came from — and, when it is 'unavailable', the honest
 * admission that we read NOTHING (ticket 2162c692).
 *
 * 'digest'      the hourly project-digest row's Project Pulse;
 * 'goals'       a direct goals read (no digest row was read for this project);
 * 'unavailable' neither source answered → the tab must say so, never render
 *               "No active or blocked goals" over data it never loaded.
 */
export type FrameworkBoardSource = 'digest' | 'goals' | 'unavailable';

/** The two server-filtered goal lists the fallback read asks for. */
export interface FrameworkGoalsRead {
  active: FleetGoal[];
  blocked: FleetGoal[];
}

/** The framework project as the sessions/workspace endpoints see it. */
export interface FrameworkSnapshot {
  project: Project | null;
  sessions: ProjectSessionRow[];
  goals: FrameworkBoardGoal[];
  /** Provenance of `goals` — drives the empty/unavailable branches. */
  boardSource: FrameworkBoardSource;
  workspace: Awaited<ReturnType<typeof projectsApi.getWorkspace>>;
  digestGeneratedAt: string | null;
}

/** Map the digest's Project Pulse rows onto the board row type. */
export function boardGoalsFromDigest(rows: FleetDigestGoals | undefined): FrameworkBoardGoal[] {
  return (rows ?? []).map((g) => ({
    goalId: g.goalId,
    title: g.title,
    status: g.status,
    todosDone: g.todosDone,
    todosTotal: g.todosTotal,
    blockedCount: g.blockedCount,
    eta: g.eta,
  }));
}

/** Digest rows as the API declares them (kept structural so a deploy-skewed
 *  backend that omits `goalProgress` still types cleanly). */
type FleetDigestGoals = NonNullable<FleetDigest['goalProgress']>;

/** Map a platform goal (+ its embedded todo summaries) onto a board row. */
export function boardGoalFromGoal(g: FleetGoal): FrameworkBoardGoal {
  const all = Array.isArray(g.todos) ? g.todos : [];
  // DROPPED work leaves the bar (review finding 1; same rule the digest sweep
  // applies at project-digest.service.ts — `status !== 'dropped'`): counting a
  // dropped todo as open would show a phantom open-todo + inflate the
  // aggregate `todosOpen`, and disagree with the digest for the same goal.
  const todos = all.filter((t) => (t.status as string) !== 'dropped');
  return {
    goalId: g.id,
    title: g.title,
    status: g.status,
    todosDone: todos.filter((t) => t.status === 'done').length,
    todosTotal: todos.length,
    blockedCount: todos.filter((t) => t.status === 'blocked').length,
  };
}

/**
 * Resolve the Goals & board panel (ticket 2162c692).
 *
 * THE BUG THIS CLOSES: the panel used to collapse the digest's goal list with
 * an empty-array default, so a MISSING digest row and a genuinely empty board
 * rendered the SAME empty-goals sentence. That row is not a transient miss:
 * the hourly sweep excludes hidden fleet artifacts from every bucket, and the
 * framework project (and every chat filed in it) is one by definition, so it
 * can never have a digest row.
 *
 * So: prefer the digest (it carries the real pace/ETA), fall back to a direct
 * goals read when no digest row was read, and answer 'unavailable' when
 * neither did — the caller renders that as its own state, never as "no goals".
 * PURE, so the three-way split is unit-testable without a DOM.
 */
export function resolveFrameworkBoard(input: {
  digest: FleetDigest | null;
  /** null = the fallback read did not happen or failed. */
  fallback: FrameworkGoalsRead | null;
}): { boardSource: FrameworkBoardSource; goals: FrameworkBoardGoal[]; digestGeneratedAt: string | null } {
  // `goalProgress` undefined (not []) means the row predates the Project Pulse
  // — no goal data was read, so it must NOT be treated as "zero goals".
  const digestGoals = input.digest?.goalProgress;
  if (digestGoals) {
    return {
      boardSource: 'digest',
      goals: boardGoalsFromDigest(digestGoals),
      digestGeneratedAt: input.digest?.generatedAt ?? null,
    };
  }
  if (input.fallback) {
    return {
      boardSource: 'goals',
      goals: [...input.fallback.active, ...input.fallback.blocked].map(boardGoalFromGoal),
      digestGeneratedAt: null,
    };
  }
  return { boardSource: 'unavailable', goals: [], digestGeneratedAt: null };
}

/**
 * Which of the board's three sections a goal belongs to (owner ticket,
 * 2026-11-04). The live ledger mixes three very different kinds of row into
 * ONE flat list, so the panel used to print a PAUSED research program as
 * "blocked" (its real DB status) and a standing MONITOR probe as "active" —
 * both truthful as raw rows, both misleading as a delivery board.
 *
 * 'active'     real delivery work — INCLUDING goals that carry blocked todos,
 *              which is normal delivery state, not a reason to demote them;
 * 'paused'     a program the owner explicitly parked (its row stays 'blocked'
 *              in the DB, but "blocked" reads as a fault — it is not one);
 * 'monitoring' a standing watch/probe, not delivery work (its row stays
 *              'active' in the DB, but it ships nothing).
 */
export type FrameworkBoardSection = 'active' | 'paused' | 'monitoring';

export interface FrameworkBoardGroup {
  key: FrameworkBoardSection;
  heading: string;
  goals: FrameworkBoardGoal[];
}

/** The section headings, in display order. */
const BOARD_SECTIONS: { key: FrameworkBoardSection; heading: string }[] = [
  { key: 'active', heading: 'Active delivery' },
  { key: 'paused', heading: 'Paused' },
  { key: 'monitoring', heading: 'Monitoring' },
];

/**
 * Classify a goal from the ONLY classification metadata the ledger carries
 * (there is no `kind` column): the explicit title prefixes the supervisor
 * stamps. Deliberately prefix-anchored (`PAUSED — …`, `MONITOR — …`) so a
 * title that merely MENTIONS the word ("unpaused delivery…") is not caught,
 * and case/hyphen tolerant because a prefix is typed by hand
 * (`PAUSED -`, `paused:`, `Monitor —` all mean the same thing).
 */
export function boardSectionOf(goal: Pick<FrameworkBoardGoal, 'title'>): FrameworkBoardSection {
  const title = goal.title ?? '';
  if (/^\s*PAUSED\b/i.test(title)) return 'paused';
  if (/^\s*MONITOR\b/i.test(title)) return 'monitoring';
  return 'active';
}

/**
 * Group the board's rows into the three sections, preserving the incoming
 * row order inside each one (the digest pre-sorts blocked-first) and dropping
 * a section that holds no rows — an empty "Paused · 0" heading is clutter.
 */
export function groupBoardGoals(goals: FrameworkBoardGoal[]): FrameworkBoardGroup[] {
  return BOARD_SECTIONS.map(({ key, heading }) => ({
    key,
    heading,
    goals: goals.filter((g) => boardSectionOf(g) === key),
  })).filter((group) => group.goals.length > 0);
}

/**
 * The status text a row may show. Paused / monitoring rows must NOT print the
 * raw DB status: 'blocked' on a program the owner parked himself reads as a
 * fault, and 'active' on a nightly probe reads as delivery work.
 */
export function boardStatusLabel(goal: FrameworkBoardGoal): string {
  const section = boardSectionOf(goal);
  if (section === 'paused') return 'paused';
  if (section === 'monitoring') return 'monitoring';
  return goal.status;
}

/** A row is amber when it is a DELIVERY goal that is blocked or carries
 *  blocked todos — never because a paused/monitoring row's raw status says
 *  'blocked' (there is nothing to act on). */
export function boardGoalNeedsAttention(goal: FrameworkBoardGoal): boolean {
  if (boardSectionOf(goal) !== 'active') return false;
  return goal.status === 'blocked' || goal.blockedCount > 0;
}

const BACKLOG = {
  repo: 'example-org/crossmodel',
  path: 'docs/FRAMEWORK_BACKLOG.md',
  url: 'https://github.com/example-org/crossmodel/blob/main/docs/FRAMEWORK_BACKLOG.md',
};

const DAY_MS = 24 * 60 * 60 * 1000;

export function sessionStatusBadge(s: ProjectSessionRow) {
  const map: Record<ProjectSessionRow['status'], { label: string; cls: string }> = {
    running: { label: 'Running', cls: 'bg-success-soft text-success border border-success-border' },
    scheduled: { label: 'Scheduled', cls: 'bg-sky-500/15 text-sky-700 dark:text-sky-300 border-sky-500/30' },
    idle: { label: 'Idle', cls: 'bg-muted text-muted-foreground border-border' },
    archived: { label: 'Archived', cls: 'bg-muted text-muted-foreground border-border' },
  };
  const v = map[s.status] ?? map.idle;
  return <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${v.cls}`}>{v.label}</span>;
}

interface SurfaceProps {
  snapshot: FrameworkSnapshot | null;
  loading: boolean;
  error: string | null;
  onOpenChat: (chatId: string) => void;
  onRetry: () => void;
  onSyncWorkspace: () => void;
}

export function FrameworkSurface({ snapshot, loading, error, onOpenChat, onRetry, onSyncWorkspace }: SurfaceProps) {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground" aria-busy="true">
        <Spinner className="mr-2" /> Loading framework surface…
      </div>
    );
  }

  if (error) {
    return (
      <Card>
        <CardContent className="py-10 text-center">
          <p className="text-sm text-destructive">{error}</p>
          <Button variant="outline" size="sm" className="mt-4" onClick={onRetry}>
            <RefreshCw className="mr-2 size-4" /> Retry
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (!snapshot?.project) {
    return (
      <Card>
        <CardContent className="py-10 text-center">
          <Bot className="mx-auto mb-3 size-8 text-muted-foreground" />
          <p className="text-sm font-medium">No framework project on this instance</p>
          <p className="mx-auto mt-1 max-w-md text-xs text-muted-foreground">
            The framework surface appears here once this instance runs with its own repo configured
            ({BACKLOG.repo}). User projects are unaffected.
          </p>
          <Button variant="outline" size="sm" className="mt-4" onClick={onRetry}>
            <RefreshCw className="mr-2 size-4" /> Retry
          </Button>
        </CardContent>
      </Card>
    );
  }

  const { project, sessions, goals, workspace } = snapshot;
  const activeSessions = sessions.filter((s) => s.status === 'running' || s.status === 'scheduled');
  const todosOpen = goals.reduce((acc, g) => acc + (g.todosTotal - g.todosDone), 0);
  const goalsBlocked = goals.filter((g) => g.status === 'blocked' || g.blockedCount > 0).length;
  const boardGroups = groupBoardGoals(goals);

  return (
    <div className="space-y-4" data-mac-agent-card="framework-tab">
      {/* Header — read-only surface: no rename/move/delete/share affordances
          (the API refuses them for this project). */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Bot className="size-4 text-brand" />
            {project.name}
            <Badge variant="outline" className="text-[11px] font-normal">Platform surface</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {project.description && <p className="text-sm text-muted-foreground">{project.description}</p>}
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            {workspace?.repoUrl && (
              <span className="inline-flex items-center gap-1">
                <GitBranch className="size-3.5" /> {workspace.repoUrl}
                {workspace.defaultBranch ? <span className="text-border">·</span> : null}
                {workspace.defaultBranch ? <code className="rounded bg-muted px-1">{workspace.defaultBranch}</code> : null}
              </span>
            )}
            {workspace && !workspace.provisioned && <span className="text-amber-600 dark:text-amber-400">workspace not provisioned</span>}
            <span className="inline-flex items-center gap-1">
              <FileCode2 className="size-3.5" />
              <a href={BACKLOG.url} target="_blank" rel="noreferrer" className="underline decoration-dotted underline-offset-2 hover:text-foreground">
                Backlog — {BACKLOG.path}
              </a>
              <ExternalLink className="size-3" />
            </span>
            {workspace?.provisioned && (
              <Button variant="outline" size="sm" className="h-7" onClick={onSyncWorkspace}>
                <RefreshCw className="mr-1.5 size-3.5" /> Sync knowledge
              </Button>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            Hardened: this project is pinned by its repo — it cannot be renamed, moved, deleted, archived, shared, or given members,
            and nothing can be filed into it. Everything below is read-only navigation into the live surface.
          </p>
        </CardContent>
      </Card>

      {/* Goal board — the hourly digest's Project Pulse when a digest row for
          this project was READ, else a direct goals read (ticket 2162c692):
          the hourly sweep excludes hidden fleet artifacts from every bucket,
          and this project is one by definition, so its digest row will never
          exist. A null digest must never be reported as "no goals". */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Target className="size-4" /> Goals &amp; board
            {snapshot.digestGeneratedAt && (
              <span className="text-xs font-normal text-muted-foreground">
                digest {new Date(snapshot.digestGeneratedAt).toLocaleString()}
              </span>
            )}
            {snapshot.boardSource === 'goals' && (
              <span className="text-xs font-normal text-muted-foreground">live goals</span>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {snapshot.boardSource === 'unavailable' ? (
            <div className="space-y-1" data-testid="board-unavailable">
              <p className="text-sm text-muted-foreground">Board data unavailable right now.</p>
              <p className="text-xs text-muted-foreground">
                Neither the project digest nor the goals list could be read — this is NOT an empty board.
              </p>
              <Button variant="outline" size="sm" className="mt-2" onClick={onRetry}>
                <RefreshCw className="mr-2 size-4" /> Retry
              </Button>
            </div>
          ) : goals.length === 0 ? (
            <p className="text-sm text-muted-foreground">No active or blocked goals on the board right now.</p>
          ) : (
            <>
              <div className="mb-3 flex flex-wrap gap-2 text-xs text-muted-foreground">
                <span className="inline-flex items-center gap-1"><CircleDot className="size-3.5" /> {goals.length} tracked</span>
                <span>· {todosOpen} open todos</span>
                {goalsBlocked > 0 && <span className="text-amber-600 dark:text-amber-400">· {goalsBlocked} blocked</span>}
              </div>
              {/* Three sections, not one flat list (owner ticket 2026-11-04):
                  a paused program and a standing monitor probe are not
                  delivery rows, and printing their raw DB status ("blocked" /
                  "active") misreads both. Sections with no rows are dropped. */}
              <div className="space-y-4" data-testid="board-sections">
                {boardGroups.map((group) => (
                  <section key={group.key} data-testid={`board-section-${group.key}`}>
                    <h4 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      {group.heading}
                      <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-normal normal-case tracking-normal">
                        {group.goals.length}
                      </span>
                    </h4>
                    <ul className="space-y-2">
                      {group.goals.map((g) => (
                        <li key={g.goalId} data-goal-id={g.goalId} className="rounded-md border p-2">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-sm font-medium">{g.title}</span>
                            <span className={`text-xs ${boardGoalNeedsAttention(g) ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'}`}>
                              {boardStatusLabel(g)}{g.blockedCount > 0 ? ` · ${g.blockedCount} blocked` : ''}
                            </span>
                          </div>
                          <div className="mt-1 text-xs text-muted-foreground">
                            {g.todosDone}/{g.todosTotal} todos done{g.eta?.etaDays != null ? ` · ETA ~${g.eta.etaDays}d` : ''}
                          </div>
                        </li>
                      ))}
                    </ul>
                  </section>
                ))}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Lanes / chats — the same sessions view the project page renders */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Chats &amp; lanes</CardTitle>
        </CardHeader>
        <CardContent>
          {sessions.length === 0 ? (
            <p className="text-sm text-muted-foreground">No chats filed in the framework project yet.</p>
          ) : (
            <ul className="divide-y">
              {sessions.map((s) => (
                <li key={s.chatId} className="flex items-center justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <div className="truncate text-sm">{s.title || '(untitled lane)'}</div>
                    <div className="text-xs text-muted-foreground">
                      {s.goalTitle ? `goal: ${s.goalTitle} · ` : ''}
                      {s.todoCounts.open > 0 ? `${s.todoCounts.open} open todos · ` : ''}
                      updated {new Date(s.updatedAt).toLocaleString()}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {sessionStatusBadge(s)}
                    <Button variant="ghost" size="sm" className="h-7" onClick={() => onOpenChat(s.chatId)}>
                      Open <ExternalLink className="ml-1 size-3" />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {activeSessions.length > 0 && (
            <p className="mt-2 text-xs text-muted-foreground">{activeSessions.length} lane(s) running or scheduled.</p>
          )}
        </CardContent>
      </Card>

      {/* Recency hint — the digest is an hourly artifact; an old row says so. */}
      {snapshot.digestGeneratedAt && Date.now() - new Date(snapshot.digestGeneratedAt).getTime() > 2 * DAY_MS && (
        <p className="text-xs text-muted-foreground">
          ⚠ Board data is stale (last digest {new Date(snapshot.digestGeneratedAt).toLocaleString()}) — the hourly sweep may be behind.
        </p>
      )}
    </div>
  );
}

export function FrameworkTab() {
  const router = useRouter();
  const [snap, setSnap] = useState<FrameworkSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // list() is the folder tree — the framework row rides isFrameworkProject
      // (stamped server-side from the repoUrl); sessions/workspace/digests are
      // the same reads the project pages and the Dashboard use.
      const tree = await projectsApi.list();
      const project = tree.owned.find((p) => p.isFrameworkProject) ?? null;
      if (!project) {
        setSnap({ project: null, sessions: [], goals: [], boardSource: 'unavailable', workspace: null, digestGeneratedAt: null });
        return;
      }
      const [sessionsRes, workspace, digests] = await Promise.all([
        projectsApi.sessions(project.id),
        projectsApi.getWorkspace(project.id).catch(() => null),
        fleetApi.getDigests().catch(() => null),
      ]);
      const digest = digests?.digests?.find((d) => d.projectId === project.id) ?? null;
      // Ticket 2162c692: the digest row for THIS project is structurally
      // absent (the hourly sweep excludes hidden fleet artifacts from every
      // bucket, and this project is one by definition). Read the goals
      // directly so the board reflects the real goals instead of an empty
      // array that renders the false "No active or blocked goals" sentence.
      //
      // Each leg settles ALONE (review finding 2): Promise.all would discard a
      // successful 'active' read whenever the 'blocked' leg 400s (an older
      // backend rejects the status param), turning a half-read board into the
      // 'unavailable' card. A leg that fails contributes [] — and 'unavailable'
      // is reserved for both legs failing, so a real goal is never hidden.
      const settled = digest?.goalProgress
        ? null
        : await Promise.all([
            platformFleetApi.listGoals(project.id, { status: 'active' }).catch(() => null),
            platformFleetApi.listGoals(project.id, { status: 'blocked' }).catch(() => null),
          ]).then(([active, blocked]) =>
            active === null && blocked === null ? null : { active: active ?? [], blocked: blocked ?? [] },
          );
      const board = resolveFrameworkBoard({ digest, fallback: settled });
      setSnap({
        project,
        sessions: sessionsRes?.sessions ?? [],
        goals: board.goals,
        boardSource: board.boardSource,
        workspace,
        digestGeneratedAt: board.digestGeneratedAt,
      });
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Failed to load the framework surface');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const openChat = useCallback((chatId: string) => {
    router.push(`/crossmodel?chatId=${encodeURIComponent(chatId)}`);
  }, [router]);

  const syncWorkspace = useCallback(async () => {
    if (!snap?.project) return;
    try {
      const r = await projectsApi.syncWorkspace(snap.project.id);
      toast.success(`Workspace synced — ${r.committed} committed, ${r.skipped} skipped`);
      void load();
    } catch (e: any) {
      toast.error(e?.response?.data?.error || 'Workspace sync failed');
    }
  }, [snap?.project, load]);

  return (
    <FrameworkSurface
      snapshot={snap}
      loading={loading}
      error={error}
      onOpenChat={openChat}
      onRetry={() => void load()}
      onSyncWorkspace={() => void syncWorkspace()}
    />
  );
}
