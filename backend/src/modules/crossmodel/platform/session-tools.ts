/**
 * Session / chat SETTINGS tools + the spend read (agent capability gap audit,
 * tranche 2 — the owner-named P1 items, 2026-09-24):
 *
 *   set_session_model           {chatId, model}            — MUTATING, owner-scoped, next run
 *   set_chat_mode               {chatId?, mode?, leadModel?} — MUTATING, owner/editor, plain chats
 *                                                            (leadModel = the chat's own Digby-seat
 *                                                            pick, WI-O #4c; null clears)
 *   set_session_permission_mode {chatId, permissionMode}   — MUTATING, owner-scoped; machine
 *                                                            widening to 'auto' only for own
 *                                                            children / supervisor seats
 *   get_spend                   {scope, chatId?, projectId?, runId?, goalId?, hours?} — READ, owner-scoped
 *                                                            (scope 'goal' — GOAL-PRIORITY-SPEND 2026-10-20)
 *
 * None is consequential (reversible, owner-scoped account/session settings —
 * the same class as rename_chat / update_project). Every executor delegates to
 * the SAME validators the REST/UI twins use (resolveOneCodingPick,
 * PERMISSION_MODES, crossModelService.updateChat via platform.setChatMode).
 * Import-light: heavy modules ride dynamic imports (platform-tools.ts imports
 * this statically).
 */

export const SESSION_TOOL_NAMES = ['set_session_model', 'set_chat_mode', 'set_session_permission_mode', 'get_spend'] as const;
export type SessionToolName = (typeof SESSION_TOOL_NAMES)[number];
export const isSessionTool = (name: string): name is SessionToolName => (SESSION_TOOL_NAMES as readonly string[]).includes(name);

const PERMISSION_MODES = new Set(['auto', 'plan', 'ask']);
export const SPEND_MAX_HOURS = 168;

export const SESSION_TOOL_SCHEMA = [
  {
    type: 'function' as const,
    function: {
      name: 'set_session_model',
      description: "Switch the coding model (agent) a CODING SESSION runs on — the same picker as the session's side panel. Takes effect on the session's NEXT run (a run in flight keeps its model). The pick must be a built-in coding model id or an enabled, [coding]-flagged \"<label>:<modelId>\" endpoint model; invalid picks are refused with the reason. An explicit session pick is honored over the project's default coding model (like a spawn-time model param) until you change it again. Owner of the session only. Use it to route a lane around a dead or throttled provider, or to put a stronger model on a hard task. To change the DEFAULT for every session in a project, update_project {codingModel} instead.",
      parameters: {
        type: 'object',
        properties: {
          chatId: { type: 'string', description: 'The coding session (chat id, or a unique ≥8-char prefix of one of your chats).' },
          model: { type: 'string', description: 'Built-in id (e.g. glm-5.3, deepseek-flash, kimi-k3) or "<label>:<modelId>" for a registered endpoint model.' },
        },
        required: ['chatId', 'model'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'set_chat_mode',
      description: "Set a PLAIN chat's stored patience level — it governs API / machine sends that carry no mode (signed-in web sends get a per-message depth): 'single_thinking' (one model, fastest), 'thinking' (a second model cross-checks), 'deep_research' (agentic council; auth + daily quota) or 'auto' (routed per message). chatId omitted = THIS chat; persists until changed; owner or editor. Also sets the chat's own LEAD MODEL (leadModel — answers as Digby in THIS chat instead of the instance seat): a built-in id (kimi-k3, glm-5.3, deepseek-flash, qwen3.6-27b) or an enabled \"<label>:<modelId>\" model; null clears it. Plain chats only — supervisor chats keep their seat; coding sessions use set_session_model / set_session_permission_mode. Give mode, leadModel, or both.",
      parameters: {
        type: 'object',
        properties: {
          chatId: { type: 'string', description: 'Target chat (default: this chat).' },
          mode: { type: 'string', enum: ['single_thinking', 'thinking', 'deep_research', 'auto'] },
          leadModel: { type: ['string', 'null'], description: "This chat's lead model: a built-in id or \"<label>:<modelId>\"; null (or '') clears the override." },
        },
        required: [],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'set_session_permission_mode',
      description: "Set a CODING SESSION's Agent mode — how its runs gate tools: 'auto' (full autonomy, the fleet default), 'plan' (read/plan only, writes refused), 'ask' (every mutating tool asks). Applies from the session's next tool call. Owner only. Narrowing (auto → plan/ask) is always allowed. WIDENING to 'auto' from a machine-triggered run is allowed only for your OWN first-degree child sessions or when you are a supervisor seat — otherwise it is refused (a run must not widen another lane's authority unattended); a user-anchored run may widen any owned session.",
      parameters: {
        type: 'object',
        properties: {
          chatId: { type: 'string' },
          permissionMode: { type: 'string', enum: ['auto', 'plan', 'ask'] },
          reason: { type: 'string', description: 'One line for the audit trail.' },
        },
        required: ['chatId', 'permissionMode'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_spend',
      description: "Read model spend (USD, estimated from list prices at run finalize) over a trailing window: scope 'chat' (one chat's runs + the spend cap governing its machine firings — the user-set PROJECT spendCapUsdPerDay or null, as cap {spendCapUsdPerDay, spendCapSource}), 'project' (every chat in a project you can access + its user-set daily cap — the ONLY cost cap in the framework, null = none), 'goal' (runs attributed to one goal — lanes chartered to it), 'account' (all your chats), or 'run' (one agent run). Returns {usd, runs, byModel: {tokensIn, tokensOut}, windowHours, cap?, estimated:true}. Read-only, never gated. Use it before fanning out work, on a budget question, or to attribute cost to a lane or goal — never guess a figure you did not read here.",
      parameters: {
        type: 'object',
        properties: {
          scope: { type: 'string', enum: ['chat', 'project', 'goal', 'account', 'run'] },
          chatId: { type: 'string', description: "scope 'chat': the chat (default: this chat)." },
          projectId: { type: 'string', description: "scope 'project': the project id." },
          goalId: { type: 'string', description: "scope 'goal': the goal id (full or ≥8-char prefix)." },
          runId: { type: 'string', description: "scope 'run': the agent run id." },
          hours: { type: 'number', description: 'Trailing window in hours (default 24, max 168).' },
        },
        required: ['scope'],
      },
    },
  },
];

type Ctx = { sessionId: string; userId: string; userTurnAt?: Date | null; machineTriggered?: boolean };

const out = (o: Record<string, unknown>): string => JSON.stringify(o, null, 1);
const short = (s: string) => String(s || '').slice(0, 8);
async function db(): Promise<any> { return (await import('../../../config/database')).default; }

async function ownedChatId(platform: any, userId: string, raw: string): Promise<string | null> {
  const id = typeof platform?.resolveOwnedChatIdPrefix === 'function' ? await platform.resolveOwnedChatIdPrefix(userId, raw).catch(() => raw) : raw;
  if (!id) return null;
  const prisma = await db();
  const chat = await prisma.crossModelChat.findUnique({ where: { id }, select: { id: true, userId: true } }).catch(() => null);
  return chat && chat.userId === userId ? chat.id : null;
}

export async function executeSessionTool(ctx: Ctx, name: SessionToolName, args: any, deps: { platform: any }): Promise<string> {
  const { platform } = deps;
  const userId = ctx.userId;
  switch (name) {
    case 'set_session_model': {
      const raw = String(args?.chatId || '').trim();
      const model = String(args?.model || '').trim();
      if (!raw || !model) return out({ ok: false, tool: name, reason: 'invalid', message: 'chatId and model are required.' });
      const chatId = await ownedChatId(platform, userId, raw);
      if (!chatId) return out({ ok: false, tool: name, reason: 'not_found', message: 'No chat of yours matches that id.' });
      const data = await import('../coding/coding-data.service');
      const session = await data.getSessionForUser(chatId, userId, 'owner').catch(() => null);
      if (!session) return out({ ok: false, tool: name, reason: 'not_coding', message: `Chat ${short(chatId)} is not a coding session (no workspace) — set_session_model applies to coding sessions only.` });
      const resolved = await data.resolveOneCodingPick(model, userId).catch(() => null);
      if (!resolved) return out({ ok: false, tool: name, reason: 'invalid_model', message: `"${model}" is not a built-in coding model or an enabled, [coding]-flagged "<label>:<modelId>" endpoint model. Nothing changed.` });
      const before = (session as any).model ?? null;
      await data.updateSessionState(chatId, { model: resolved, modelSource: 'explicit' } as any);
      const running = (session as any).status === 'running';
      return out({ ok: true, tool: name, ids: { chatId }, model: resolved, previousModel: before, modelSource: 'explicit', appliesTo: running ? 'next run (a run is in flight and keeps its model)' : 'next run', message: `Session ${short(chatId)} will run on ${resolved}${before && before !== resolved ? ` (was ${before})` : ''} from its next run; the project default no longer overrides it.` });
    }

    case 'set_chat_mode': {
      const modeGiven = args?.mode !== undefined && args?.mode !== null && String(args.mode).trim() !== '';
      const mode = modeGiven ? String(args.mode).trim() : '';
      if (modeGiven && !['single_thinking', 'thinking', 'deep_research', 'auto'].includes(mode)) return out({ ok: false, tool: name, reason: 'invalid', message: 'mode must be single_thinking | thinking | deep_research | auto.' });
      // WI-O #4c: leadModel — null / '' clears; a string is validated against the
      // Digby seat's pick set inside updateChat (refused with the offered list).
      const leadGiven = args !== null && typeof args === 'object' && Object.hasOwn(args, 'leadModel');
      const leadModel: string | null = leadGiven ? (args.leadModel === null || args.leadModel === undefined ? null : String(args.leadModel).trim() || null) : null;
      if (!modeGiven && !leadGiven) return out({ ok: false, tool: name, reason: 'invalid', message: 'Give mode (single_thinking | thinking | deep_research | auto), leadModel (a model id, or null to clear), or both.' });
      // Seats govern sessions (2026-09-28): a lead-model pick is a HUMAN decision — a machine turn
      // (schedule / hook / agent / webhook, or no user anchor at all) may not stamp one. Clearing
      // (null / '') is allowed from any turn: it hands the chat back to the admin seat.
      if (leadGiven && leadModel && !(ctx.userTurnAt && ctx.machineTriggered !== true)) {
        return out({ ok: false, tool: name, reason: 'no_user_turn', message: 'A chat\'s lead model can be set only on a live user turn — a scheduled / automatic run may not point a chat away from the admin\'s Digby seat (Account → Admin → Endpoints → Model roles governs it). Pass leadModel: null to clear an override, or suggest the change and let the user ask.' });
      }
      const raw = String(args?.chatId || '').trim() || ctx.sessionId;
      const chatId = raw === ctx.sessionId ? raw : (typeof platform?.resolveOwnedChatIdPrefix === 'function' ? await platform.resolveOwnedChatIdPrefix(userId, raw).catch(() => raw) : raw);
      try {
        const r = await platform.setChatMode({ userId, chatId, ...(modeGiven ? { mode } : {}), ...(leadGiven ? { leadModel } : {}) });
        const modeLine = modeGiven ? `now runs at ${r?.mode ?? mode}${mode === 'auto' ? ' (stored as thinking; the router picks per message)' : ''} for every later message` : '';
        const leadLine = leadGiven
          ? (leadModel ? `answers as Digby on ${r?.leadModel ?? leadModel} from its next message (this chat only; the instance seat is unchanged)` : 'is back on the instance\'s Digby seat (lead override cleared)')
          : '';
        return out({
          ok: true, tool: name, ids: { chatId: r?.id ?? chatId },
          mode: r?.mode ?? (modeGiven ? mode : undefined),
          ...(leadGiven ? { leadModel: r?.leadModel ?? leadModel } : {}),
          message: `Chat ${short(r?.id ?? chatId)} ${[modeLine, leadLine].filter(Boolean).join(' and ')}.`,
        });
      } catch (err: any) {
        const status = Number(err?.statusCode ?? 0);
        return out({ ok: false, tool: name, ids: { chatId }, reason: status === 404 ? 'not_found' : status === 403 ? 'forbidden' : 'refused', message: String(err?.message || err) });
      }
    }

    case 'set_session_permission_mode': {
      const raw = String(args?.chatId || '').trim();
      const mode = String(args?.permissionMode || '').trim();
      if (!raw || !PERMISSION_MODES.has(mode)) return out({ ok: false, tool: name, reason: 'invalid', message: 'chatId and permissionMode (auto | plan | ask) are required.' });
      const chatId = await ownedChatId(platform, userId, raw);
      if (!chatId) return out({ ok: false, tool: name, reason: 'not_found', message: 'No chat of yours matches that id.' });
      const data = await import('../coding/coding-data.service');
      const session = await data.getSessionForUser(chatId, userId, 'owner').catch(() => null);
      if (!session) return out({ ok: false, tool: name, reason: 'not_coding', message: `Chat ${short(chatId)} is not a coding session — permission modes apply to coding sessions only.` });
      const before = String((session as any).permissionMode ?? 'auto');
      if (before === mode) return out({ ok: true, tool: name, ids: { chatId }, permissionMode: mode, changed: false, message: `Session ${short(chatId)} is already in ${mode} mode.` });
      const widening = mode === 'auto' && before !== 'auto';
      if (widening && !ctx.userTurnAt) {
        // Machine run widening another lane's authority: only its own
        // first-degree child, or a supervisor seat (mirrors selfGrantSubsetVerdict).
        const prisma = await db();
        const row = await prisma.crossModelChat.findUnique({ where: { id: chatId }, select: { parentChatId: true } }).catch(() => null);
        const ownChild = !!row && row.parentChatId === ctx.sessionId;
        let supervisor = false;
        if (!ownChild) {
          try { const m = await import('./supervisor-state.service'); supervisor = await m.isSupervisorChat(ctx.sessionId); } catch { supervisor = false; }
        }
        if (!ownChild && !supervisor) {
          return out({ ok: false, tool: name, ids: { chatId }, reason: 'widening_refused', message: `Refused: a machine-triggered run may widen a session to 'auto' only for its OWN first-degree child sessions or from a supervisor seat (${short(chatId)} is neither yours to widen nor are you a supervisor). Narrowing is always allowed; a user-anchored turn may widen any owned session.` });
        }
      }
      await data.updateSessionState(chatId, { permissionMode: mode });
      return out({ ok: true, tool: name, ids: { chatId }, permissionMode: mode, previous: before, changed: true, message: `Session ${short(chatId)}: ${before} → ${mode}${widening ? ' (widened)' : ''}; applies from its next tool call.` });
    }

    case 'get_spend': {
      const scope = String(args?.scope || '').trim();
      if (!['chat', 'project', 'goal', 'account', 'run'].includes(scope)) return out({ ok: false, tool: name, reason: 'invalid', message: "scope must be chat | project | goal | account | run." });
      const hoursRaw = Number(args?.hours);
      const hours = Number.isFinite(hoursRaw) && hoursRaw > 0 ? Math.min(SPEND_MAX_HOURS, Math.floor(hoursRaw)) : 24;
      const prisma = await db();
      const since = new Date(Date.now() - hours * 3600_000);
      let where = '';
      const params: any[] = [since];
      const ids: Record<string, string | null> = {};
      let cap: Record<string, unknown> | undefined;
      if (scope === 'chat') {
        const chatId = await ownedChatId(platform, userId, String(args?.chatId || '').trim() || ctx.sessionId);
        if (!chatId) return out({ ok: false, tool: name, reason: 'not_found', message: 'No chat of yours matches that id.' });
        where = `lm."sessionId" = $2`; params.push(chatId); ids.chatId = chatId;
        // Ticket 1769c8d1 (2026-09-27): the governing spend cap rides the
        // chat-scope read — the ONE resolver the sweeper enforces. Owner
        // directive 2026-09-27: the only cap that exists is the user-set
        // PROJECT spendCapUsdPerDay (no chat row, env default or fleet
        // budget). Shape: { spendCapUsdPerDay, spendCapSource: 'project' | null }.
        // Fail-open: an unreadable cap renders no cap field, never errors.
        try {
          const { getLaneSpendCap } = await import('../coding/spend-cap.service');
          const lane = await getLaneSpendCap(chatId);
          cap = { spendCapUsdPerDay: lane.spendCapUsdPerDay, spendCapSource: lane.spendCapSource };
        } catch { cap = undefined; }
      } else if (scope === 'project') {
        const projectId = String(args?.projectId || '').trim();
        if (!projectId) return out({ ok: false, tool: name, reason: 'invalid', message: 'projectId is required for scope project.' });
        let project: any;
        try { project = await platform.getProject({ userId, projectId }); } catch (err: any) { return out({ ok: false, tool: name, reason: 'not_found', message: String(err?.message || err) }); }
        where = `lm."sessionId" IN (SELECT c.id FROM crossmodel_chats c WHERE c."projectId" = $2)`; params.push(project.id); ids.projectId = project.id;
        // Owner directive 2026-09-27: the project's user-set cap is the ONLY
        // cost cap — the former fleetDailyBudgetUsd (env
        // DIGBY_PROJECT_SUPERVISOR_DAILY_BUDGET_USD) was deleted with its breaker.
        cap = { spendCapUsdPerDay: project.spendCapUsdPerDay ?? null };
      } else if (scope === 'goal') {
        // GOAL-PRIORITY-SPEND (2026-10-20): run_spend rows stamped meta.goalId = this goal, plus UNSTAMPED rows (any
        // producer) of the project's chats chartered to it today, newer than their last charter goal rebind — the
        // same predicate the [BOARD] "7d $" reads (goal-spend.ts goalSpendPredicate).
        const { goalSpendAttributionDisabled } = await import('./goal-priority');
        if (goalSpendAttributionDisabled()) return out({ ok: false, tool: name, reason: 'disabled', message: "Per-goal spend attribution is switched off on this instance (GOAL_SPEND_ATTRIBUTION_DISABLED=1) — read scope 'project' or 'chat' instead." });
        const rawGoal = String(args?.goalId || '').trim();
        if (!rawGoal) return out({ ok: false, tool: name, reason: 'invalid', message: 'goalId is required for scope goal.' });
        let goal: any;
        try { goal = await (await import('./goals.service')).getGoal({ userId, goalId: rawGoal }); } catch (err: any) { return out({ ok: false, tool: name, reason: 'not_found', message: String(err?.message || err) }); }
        const { goalSpendPredicate } = await import('./goal-spend');
        where = goalSpendPredicate(2, 3); params.push([goal.id], goal.projectId ? [String(goal.projectId)] : []); ids.goalId = goal.id; ids.projectId = goal.projectId ?? null;
      } else if (scope === 'account') {
        where = `lm."sessionId" IN (SELECT c.id FROM crossmodel_chats c WHERE c."userId" = $2)`; params.push(userId);
      } else {
        const runId = String(args?.runId || '').trim();
        if (!runId) return out({ ok: false, tool: name, reason: 'invalid', message: 'runId is required for scope run.' });
        const run = await prisma.agentRun.findUnique({ where: { id: runId }, select: { id: true, sessionId: true } }).catch(() => null);
        const owner = run ? await prisma.crossModelChat.findUnique({ where: { id: run.sessionId }, select: { userId: true } }).catch(() => null) : null;
        if (!run || !owner || owner.userId !== userId) return out({ ok: false, tool: name, reason: 'not_found', message: 'No run of yours matches that id.' });
        where = `lm."runId" = $2`; params.push(run.id); ids.runId = run.id; ids.chatId = run.sessionId;
      }
      // Attribution (WI-J, 2026-09-25): a run_spend row lists every model the
      // run metered (meta.models). `multi_model_runs` counts rows that metered
      // ≥2 models — on an L2 chat that is the Double Checker riding the lead's
      // accumulator; 0 on a window of L2 turns means the checker's usage was
      // NOT metered into run_spend (the under-reporting WI-D closes), so
      // `attribution.doubleChecker:false` is an honest "not in these figures".
      const spend = await prisma.$queryRawUnsafe(`SELECT COALESCE(SUM(lm.value),0)::float AS usd, COUNT(*)::int AS runs, COUNT(*) FILTER (WHERE (CASE WHEN jsonb_typeof(lm.meta->'models') = 'array' THEN jsonb_array_length(lm.meta->'models') ELSE 0 END) >= 2)::int AS multi_model_runs FROM loop_metrics lm WHERE lm.kind = 'run_spend' AND lm."createdAt" >= $1 AND ${where}`, ...params);
      const tokens = await prisma.$queryRawUnsafe(`SELECT lm.meta->>'model' AS model, COALESCE(SUM(CASE WHEN lm.kind='run_tokens_in' THEN lm.value END),0)::float AS tokens_in, COALESCE(SUM(CASE WHEN lm.kind='run_tokens_out' THEN lm.value END),0)::float AS tokens_out FROM loop_metrics lm WHERE lm.kind IN ('run_tokens_in','run_tokens_out') AND lm."createdAt" >= $1 AND ${where} GROUP BY 1 ORDER BY 2 DESC LIMIT 20`, ...params);
      const byModel: Record<string, { tokensIn: number; tokensOut: number }> = {};
      for (const t of (tokens as any[])) if (t?.model) byModel[String(t.model)] = { tokensIn: Number(t.tokens_in) || 0, tokensOut: Number(t.tokens_out) || 0 };
      const usd = Number((spend as any[])?.[0]?.usd) || 0;
      const runs = Number((spend as any[])?.[0]?.runs) || 0;
      const multiModelRuns = Number((spend as any[])?.[0]?.multi_model_runs) || 0;
      const attribution: Record<string, unknown> = { lead: true, doubleChecker: multiModelRuns > 0, multiModelRuns };
      // GOAL-PRIORITY-SPEND: how many of the goal's rows came from the stamp vs the charter fallback.
      if (scope === 'goal') {
        const split = await prisma.$queryRawUnsafe(`SELECT COUNT(*) FILTER (WHERE lm.meta->>'goalId' IS NOT NULL)::int AS stamped FROM loop_metrics lm WHERE lm.kind = 'run_spend' AND lm."createdAt" >= $1 AND ${where}`, ...params).catch(() => [] as any[]);
        const stampedRuns = Number((split as any[])?.[0]?.stamped) || 0;
        attribution.stampedRuns = stampedRuns;
        attribution.charterFallbackRuns = Math.max(0, runs - stampedRuns);
        attribution.goalNote = 'stampedRuns: rows whose run named this goal (the todo the lane worked, else its charter). charterFallbackRuns: UNSTAMPED rows of any producer (pre-stamp history, decision-gate, chat turns) of this project\'s chats chartered to the goal today, newer than their last charter goal rebind. Lanes never chartered to the goal are not counted — runs: 0 means nothing attributed, not proven free.';
      }
      // scope 'chat' (WI-J): the five most recent finalized runs of the chat —
      // {runId, usd, models, at} — so a lane can attribute a figure to a turn.
      let recentRuns: Array<{ runId: string | null; usd: number; models: string[]; at: string }> | undefined;
      if (scope === 'chat') {
        const recent = await prisma.$queryRawUnsafe(`SELECT lm."runId" AS run_id, lm.value::float AS usd, lm.meta->'models' AS models, lm."createdAt" AS at FROM loop_metrics lm WHERE lm.kind = 'run_spend' AND lm."createdAt" >= $1 AND ${where} ORDER BY lm."createdAt" DESC LIMIT 5`, ...params).catch(() => [] as any[]);
        recentRuns = (Array.isArray(recent) ? recent : []).filter((r: any) => r && typeof r === 'object' && ('run_id' in r || 'at' in r)).map((r: any) => ({
          runId: r.run_id ?? null,
          usd: Math.round((Number(r.usd) || 0) * 10000) / 10000,
          models: Array.isArray(r.models) ? r.models.map(String) : [],
          at: r.at instanceof Date ? r.at.toISOString() : String(r.at ?? ''),
        }));
      }
      return out({ ok: true, tool: name, scope, ids, windowHours: hours, since: since.toISOString(), usd: Math.round(usd * 10000) / 10000, runs, byModel, attribution, ...(recentRuns ? { recentRuns } : {}), ...(cap ? { cap } : {}), estimated: true, note: 'USD is estimated from list prices at run finalize (loop_metrics run_spend); token counts per model from run_tokens_in/out. Since 2026-09-25 a chat turn is ONE run row covering every seat that ran (the Double Checker on Level 2, the council on Level 3, reconcile passes) — byModel splits them; earlier rows metered the lead only. attribution.doubleChecker is true only when a run in the window metered a second model into run_spend — false on Level 2 turns means the Double Checker\'s usage is NOT in these figures (pre-2026-09-25 rows), not that no checker ran.' });
    }
  }
}
