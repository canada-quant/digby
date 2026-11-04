/**
 * Fleet / ops tools — agent capability gap audit, tranche 4b
 * (P2 #27, #29, #30, #31, #32; 2026-09-24):
 *
 *   list_instances       {}                              READ, ADMIN at execution (Digby Edge instances — the ids send_to_instance needs)
 *   ack_digest_item      {key, snoozeHours?}             MUTATING, non-consequential (own account's digest inbox)
 *   unack_digest_item    {key}                           MUTATING, non-consequential
 *   get_session_diff     {chatId}                        READ, owner or project member (git status + diff --stat; cross-box via Redis)
 *   resolve_id           {id, family?}                   READ, own-account rows only
 *   get_chat_webhook     {chatId}                        READ, owner (status only — never the token)
 *   revoke_chat_webhook  {chatId}                        MUTATING, non-consequential (owner)
 *   create_chat_webhook  {chatId?, label?, rotate?, envKey?}  CONSEQUENTIAL + NEVER-AUTONOMOUS (owner). Delivery (ticket
 *   2eef354e): with envKey the minted bearer is stored SERVER-SIDE in the encrypted coding
 *   credentials (the store_secret destination — AES-256-GCM at rest, injected into every
 *   coding session shell as $ENVKEY, scrubbed from shell output) so an agent-driven setup
 *   finishes end-to-end and the owner never locates or pastes a token; without envKey the
 *   token is handed to the OWNER'S BROWSER through the confirmation card's result
 *   (ctx.ownerBrowser) only. The model path only ever sees tokenPrefix — a no-envKey
 *   non-owner-browser confirm (the old mint-and-lose dead-end) now refuses BEFORE minting.
 *                                                        (capability gap #32 close-out, 2026-09-25;
 *                                                         delegated delivery, ticket 2eef354e)
 *   test_model_role      {role, candidate?, fallback?}   READ, ADMIN at execution (WI-M 2026-09-25) — the POST /admin/model-roles/test
 *                                                        twin: ONE live probe of a seat with its real call shape (testModelRole,
 *                                                        ROLE_TEST_TIMEOUT_MS per leg, TEST_MODEL_ROLE_CAP_MS overall); returns
 *                                                        {ok, role, model, latencyMs, error?, callShape}. Never re-seats anything —
 *                                                        "is seat X alive before I re-seat it" is the use; a receipt tool (evidence-tools).
 *
 * Also in this tranche, elsewhere: get_fleet_telemetry views overview / pulse /
 * log / digests (fleet-telemetry.ts; supervisor-seat readable), infra_action
 * kind dev_container_restart (infra-actions.service.ts). create_chat_webhook
 * originally shipped as owner-browser-only (the token would otherwise land in a
 * model-readable transcript); since ticket 2eef354e the delegated envKey path
 * delivers it through the encrypted vault instead — still never model-readable.
 */

export const FLEET_OPS_TOOL_NAMES = ['list_instances', 'ack_digest_item', 'unack_digest_item', 'get_session_diff', 'resolve_id', 'get_chat_webhook', 'revoke_chat_webhook', 'create_chat_webhook', 'test_model_role',
  // Rollout self-governance (2026-09-27): the decision gate's own status read + the Fleet Supervisor's mode flip.
  //   get_decision_gate_status  {}                                READ, never gated — registry (tier, what act does, label) + modes +
  //                                                               readiness + the rollout automaton's ledger + recent auto-demotes
  //   set_decision_gate_mode    {purpose, mode, ownerQuestionId?} MUTATING, ADMIN owner + (supervisor chat | user-present turn); the SAME
  //                                                               admission as PUT /admin/model-roles/decision-modes (caps, READY stamp,
  //                                                               primary pin); a widening act flip outside tier 1 from a machine turn
  //                                                               files ONE owner question and returns staged — the owner's GO answer
  //                                                               (passed back as ownerQuestionId) executes it. Audited; a receipt tool.
  'get_decision_gate_status', 'set_decision_gate_mode'] as const;
/** test_model_role overall wall-clock cap (the service's per-leg timeout is ROLE_TEST_TIMEOUT_MS = 20 s for built-ins and
 *  up to 55 s for custom endpoints since 2026-10-07 — roleTestTimeoutMs). The image seat's probe budget is 180 s since
 *  ticket 61d33af9 (2026-10-10, imageProbeTimeoutMs) — the cap sits above the slowest seat probe (image 180 s + grace)
 *  so the tool answers the probe's own typed timeout instead of its own wall-clock cut. */
export const TEST_MODEL_ROLE_CAP_MS = 190_000;
export type FleetOpsToolName = (typeof FLEET_OPS_TOOL_NAMES)[number];
export const isFleetOpsTool = (name: string): name is FleetOpsToolName => (FLEET_OPS_TOOL_NAMES as readonly string[]).includes(name);

export const ID_FAMILIES = ['chat', 'schedule', 'goal', 'todo', 'hook', 'ticket', 'owner_question', 'instance', 'directive', 'dispatch'] as const;
export type IdFamily = (typeof ID_FAMILIES)[number];
const ID_PREFIX_MIN = 8;
/**
 * audit 2026-10-06 T5-4 (spark F8): resolve_id could not see SUPERVISOR-STATE
 * ids — a project supervisor resolved its OWN (done) directive 2602af09 to
 * "nothing" and wrote "was a stale note label" into its durable notes, while a
 * todo id that exists nowhere rode the same notes into every wake. The
 * `directive` family reads every supervisor state doc of this account (live +
 * archived directives), `dispatch` its dispatch ledger, and an id found in NO
 * family but written in a supervisor's notes comes back as a `mentions` row
 * flagged unverified. Kill switch RESOLVE_ID_SUPERVISOR_STATE_DISABLED=1
 * restores the eight-family resolver (schema read at module load).
 */
export const SUPERVISOR_STATE_ID_FAMILIES: ReadonlySet<string> = new Set(['directive', 'dispatch']);
export function resolveIdSupervisorStateDisabled(): boolean {
  return process.env.RESOLVE_ID_SUPERVISOR_STATE_DISABLED === '1';
}
function activeIdFamilies(): IdFamily[] {
  return resolveIdSupervisorStateDisabled() ? ID_FAMILIES.filter((f) => !SUPERVISOR_STATE_ID_FAMILIES.has(f)) : [...ID_FAMILIES];
}
type SupervisorDocRow = { chatId: string; doc: { directives: any[]; archived: any[]; dispatches: any[]; notes: string; archivedColdCount?: number } };
/** Every supervisor state doc of this account, parsed (one read per resolve_id call). Never throws. */
async function loadSupervisorDocs(userId: string): Promise<SupervisorDocRow[]> {
  try {
    const prisma = await db();
    const rows: any[] = await prisma.supervisorState.findMany({ where: { userId }, select: { chatId: true, state: true }, take: 200 });
    const { parseSupervisorStateDoc } = await import('./supervisor-state.service');
    return rows.map((r) => ({ chatId: String(r.chatId), doc: parseSupervisorStateDoc(r.state) as any }));
  } catch {
    return [];
  }
}

export const FLEET_OPS_TOOL_SCHEMA = [
  { type: 'function' as const, function: { name: 'list_instances', description: "ADMIN ONLY. List the paired Digby Edge instances of this account: id (what send_to_instance needs), name, status, online (live presence), lastSeenAt. Revoked rows are excluded. Read-only.", parameters: { type: 'object', properties: {} } } },
  { type: 'function' as const, function: { name: 'ack_digest_item', description: "Acknowledge one attention item on the owner's fleet digest (the key from get_fleet_telemetry view 'digests' → attentionItems[].key) so it leaves the inbox; snoozeHours (1–720) hides it only until then. Own account; reversible with unack_digest_item; not consequential.", parameters: { type: 'object', properties: { key: { type: 'string' }, snoozeHours: { type: 'number' } }, required: ['key'] } } },
  { type: 'function' as const, function: { name: 'unack_digest_item', description: "Un-acknowledge a digest attention item (it returns to the owner's inbox). Own account; not consequential.", parameters: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] } } },
  { type: 'function' as const, function: { name: 'get_session_diff', description: "Read another coding session's uncommitted changes: branch, `git status --porcelain` and `git diff --stat` of its worktree (the UI's Changes view) — served from the box that hosts the worktree over Redis when this box does not. Use it to verify a lane's work before it pushes, alongside read_session_file. Owner or project member. source 'unavailable' means the host did not answer — retry, do not conclude the tree is clean." + (process.env.SESSION_DIFF_ERROR_STATE_DISABLED === '1' ? '' : " ok:false source 'error' means the git read failed — the state is unknown. head / ahead (commits not pushed to origin) say what is committed vs pushed."), parameters: { type: 'object', properties: { chatId: { type: 'string' } }, required: ['chatId'] } } },
  { type: 'function' as const, function: { name: 'resolve_id', description: resolveIdSupervisorStateDisabled()
    ? "Resolve an 8+-char id PREFIX or a possibly mistyped id to the real id, across families — chat, schedule, goal, todo, hook, ticket, owner_question, instance (family omitted = try them all). Own-account rows only. Returns exact matches per family, or candidates when ambiguous. Use it BEFORE calling a tool with an id you copied from a transcript; never invent an id."
    : "Resolve an 8+-char id PREFIX or a possibly mistyped id to the real id, across families — chat, schedule, goal, todo, hook, ticket, owner_question, instance, directive and dispatch (the supervisor state docs: live + archived directives, the dispatch ledger) (family omitted = try them all). Own-account rows only. Returns exact matches per family, or candidates when ambiguous; an id found in no family but written in a supervisor's notes comes back under `mentions` as UNVERIFIED. Use it BEFORE calling a tool with an id you copied from a transcript; never invent an id.", parameters: { type: 'object', properties: { id: { type: 'string' }, family: { type: 'string', enum: activeIdFamilies() } }, required: ['id'] } } },
  { type: 'function' as const, function: { name: 'get_chat_webhook', description: "Read a chat's inbound webhook STATUS (exists, isActive, label, tokenPrefix, webhookUrl, lastUsedAt) — never the bearer token. The owner mints/rotates the token in the chat's webhook settings (the token is shown once there); this tool tells you whether CI or a monitor can already wake the chat. Owner-only; read-only.", parameters: { type: 'object', properties: { chatId: { type: 'string' } }, required: ['chatId'] } } },
  // Ticket 2eef354e (2026-10-20): envKey = delegated delivery — the minted
  // token goes to the encrypted coding credentials (store_secret's
  // destination) instead of a browser-only one-time show, so an agent-staged
  // setup finishes end-to-end. The why lives HERE, not in the description
  // (the tool-description diet + prompt hygiene).
  { type: 'function' as const, function: { name: 'create_chat_webhook', description: "Mint (or rotate:true re-mint) a chat's inbound webhook so CI or a monitor can wake it (POST <webhookUrl> with the bearer). NEVER autonomous — every call stages a confirmation the user accepts in a new message. Delivery: pass envKey (UPPER_SNAKE) and the token is stored server-side in the encrypted coding credentials, so every coding session shell has it as $ENVKEY and an agent-run setup finishes with ONE owner card, no paste; omit envKey and it is shown ONCE in the owner's browser when they confirm the card in the app. Never reaches you or the transcript (tokenPrefix only). GOOGLE DRIVE change notifications: use subscribe_drive_watch instead (first-class, no token). chatId omitted = this chat; label ≤120 chars; an existing webhook needs rotate:true (409 → 'exists'). Owner-only.", parameters: { type: 'object', properties: { chatId: { type: 'string' }, label: { type: 'string' }, rotate: { type: 'boolean' }, envKey: { type: 'string', description: 'UPPER_SNAKE env var name to store the minted token under (the store_secret destination — encrypted coding credentials, injected into every coding session shell as $ENVKEY). Omit only when the owner will confirm the card in the app and copy the token themselves.' }, confirmationId: { type: 'string', description: 'Pass back the confirmationId from the staged card once the user confirmed.' } } } } },
  { type: 'function' as const, function: { name: 'revoke_chat_webhook', description: "Revoke a chat's inbound webhook (the bearer token stops working; external callers get 401). Owner-only; not consequential (re-minting is the owner's UI action).", parameters: { type: 'object', properties: { chatId: { type: 'string' } }, required: ['chatId'] } } },
  { type: 'function' as const, function: { name: 'get_decision_gate_status', description: "Read the decision gate's live state — the ONE source of truth on which harness judgments run on Jev and which do not: every purpose with its label, what it decides, what ACT removes, its rollout tier (1 = flips to act automatically on a measured READY stamp, 2 = reported ready to the owner as one question, 3 = never auto), its effective mode (off | shadow | act) and where that came from (store / env / a code cap), readiness (READY / NOT READY, stale, the first missing bar), the rollout automaton's switch + recent actions (flips, parks, owner asks, refusals) + store/code inconsistencies, and the auto-demotes of the last 7 days. Read this BEFORE diagnosing a parked, skipped or late machine turn: a purpose in act explains it (rule gate.outcome). Read-only, never gated.", parameters: { type: 'object', properties: { purpose: { type: 'string', description: 'Optional: one purpose id to return in full (default: every purpose, compact).' } } } } },
  { type: 'function' as const, function: { name: 'set_decision_gate_mode', description: "FLEET SUPERVISOR / ADMIN. Set ONE decision-gate purpose's fleet-wide mode (off | shadow | act | '' to clear to env) — the admin panel's PUT as a tool, with the SAME admission: a code act-cap, a missing / stale / NOT READY stamp or a primary-backend mismatch refuses act (ok:false, reason 'refused', the exact bar named). Tier rule: act on a TIER-1 purpose executes; act on a tier-2 / tier-3 purpose from a machine turn FILES ONE owner question and answers ok:false {staged:true, ownerQuestionId} — pass ownerQuestionId back once the owner answered 'flip' and the flip executes; a user-present turn executes directly (the owner is directing). shadow / off always execute. Audited; the {ids:{purpose, mode}} envelope is the receipt. Never call it to 'fix' a parked or skipped wake — that is the gate working.", parameters: { type: 'object', properties: { purpose: { type: 'string', description: 'A purpose id from get_decision_gate_status.' }, mode: { type: 'string', enum: ['off', 'shadow', 'act', ''], description: "off | shadow | act | '' (clear the stored mode)." }, ownerQuestionId: { type: 'string', description: "The oq_ id of the owner question a previous staged call returned, once the owner answered it." } }, required: ['purpose', 'mode'] } } },
  { type: 'function' as const, function: { name: 'test_model_role', description: "ADMIN ONLY. Live-probe ONE model seat with its real call shape (the admin page's Test button / POST /admin/model-roles/test): a streamed chat completion to first token for agent seats, /embeddings or /rerank for those seats, a tiny WAV for asr, etc. role = a seat key (get_model_roles lists them; e.g. double_checker, supervisor, coding_default, utility, decision). A decision BACKEND (jev / deepseek-flash) probes as {role:'decision', candidate:'jev'}. candidate = a built-in id or '<label>:<modelId>' registry spec to try INSTEAD of the seat's current model (nothing is saved); fallback:true probes the seat's custom fallback slot. Returns {ok, role, model, latencyMs, error?, callShape}. Read-only — confirm a seat is alive (or a replacement) BEFORE set_model_role_fallback or set_session_model; never to re-seat. Up to 60 s (image seat 3 min).", parameters: { type: 'object', properties: { role: { type: 'string', description: "Seat key (get_model_roles lists them). The admin panel's 'Decision gate' seat's key is 'decision'; its backends (jev, deepseek-flash) are candidate values, not seats." }, candidate: { type: 'string', description: "Optional model to probe in place of the seat's current model (not saved)." }, fallback: { type: 'boolean', description: "true = probe the seat's custom FALLBACK slot instead of its primary." } }, required: ['role'] } } },
];

type Ctx = { sessionId: string; userId: string; userTurnAt?: Date | null; /** set ONLY by the REST confirm endpoint (the owner's browser executes the card) */ ownerBrowser?: boolean };
type Deps = { platform: any; isAdmin: (userId: string) => Promise<boolean> };
const out = (o: Record<string, unknown>): string => JSON.stringify(o, null, 1);
const short = (s: string) => String(s || '').slice(0, 8);
async function db(): Promise<any> { return (await import('../../../config/database')).default; }
async function audit(userId: string, action: string, metadata: Record<string, unknown>): Promise<void> {
  try { const prisma = await db(); await prisma.activity.create({ data: { userId, action, resource: 'platform', metadata } }); } catch { /* never fails the tool */ }
}

async function resolveOwnedChat(platform: any, ctx: Ctx, raw: string): Promise<{ id: string; userId: string } | null> {
  const prisma = await db();
  const id = raw === ctx.sessionId ? raw : (typeof platform?.resolveOwnedChatIdPrefix === 'function' ? await platform.resolveOwnedChatIdPrefix(ctx.userId, raw).catch(() => raw) : raw);
  const chat = await prisma.crossModelChat.findUnique({ where: { id }, select: { id: true, userId: true } }).catch(() => null);
  return chat && chat.userId === ctx.userId ? chat : null;
}

/** Per-family resolution: exact id → the row; ≥8-char prefix → own-account rows starting with it (max 5). */
async function resolveFamily(family: IdFamily, id: string, userId: string, supDocs?: () => Promise<SupervisorDocRow[]>): Promise<{ exact: any | null; candidates: any[] }> {
  const prisma = await db();
  const isPrefix = id.length >= ID_PREFIX_MIN && id.length < 36;
  const pick = (rows: any[]) => rows.map((r) => ({ id: r.id, label: r.title ?? r.name ?? r.label ?? r.prompt?.slice?.(0, 60) ?? r.question?.slice?.(0, 60) ?? null }));
  switch (family) {
    case 'chat': {
      const exact = await prisma.crossModelChat.findFirst({ where: { id, userId }, select: { id: true, title: true } }).catch(() => null);
      const cands = !exact && isPrefix ? await prisma.crossModelChat.findMany({ where: { userId, id: { startsWith: id } }, select: { id: true, title: true }, take: 5 }).catch(() => []) : [];
      return { exact: exact ? pick([exact])[0] : null, candidates: pick(cands) };
    }
    case 'schedule': {
      const exact = await prisma.codingSchedule.findFirst({ where: { id, userId }, select: { id: true, prompt: true } }).catch(() => null);
      const cands = !exact && isPrefix ? await prisma.codingSchedule.findMany({ where: { userId, id: { startsWith: id } }, select: { id: true, prompt: true }, take: 5 }).catch(() => []) : [];
      return { exact: exact ? pick([exact])[0] : null, candidates: pick(cands) };
    }
    case 'goal':
    case 'todo': {
      const model = family === 'goal' ? prisma.projectGoal : prisma.projectTodo;
      const { getProjectAccess } = await import('./platform.service');
      const rows: any[] = await model.findMany({ where: isPrefix ? { id: { startsWith: id } } : { id }, select: { id: true, title: true, projectId: true }, take: 6 }).catch(() => []);
      const visible: any[] = [];
      for (const r of rows) if (await getProjectAccess(r.projectId, userId).catch(() => null)) visible.push(r);
      const exact = visible.find((r) => r.id === id) ?? null;
      return { exact: exact ? pick([exact])[0] : null, candidates: exact ? [] : pick(visible.slice(0, 5)) };
    }
    case 'hook': {
      const exact = await prisma.eventHook.findFirst({ where: { id, userId }, select: { id: true, label: true } }).catch(() => null);
      const cands = !exact && isPrefix ? await prisma.eventHook.findMany({ where: { userId, id: { startsWith: id } }, select: { id: true, label: true }, take: 5 }).catch(() => []) : [];
      return { exact: exact ? pick([exact])[0] : null, candidates: pick(cands) };
    }
    case 'ticket': {
      const rows: any[] = await prisma.userFeatureRequest.findMany({ where: isPrefix ? { id: { startsWith: id } } : { id }, select: { id: true, title: true, userId: true }, take: 6 }).catch(() => []);
      const own = rows.filter((r) => !r.userId || r.userId === userId);
      const exact = own.find((r) => r.id === id) ?? null;
      return { exact: exact ? pick([exact])[0] : null, candidates: exact ? [] : pick(own.slice(0, 5)) };
    }
    case 'owner_question': {
      const probe = id.startsWith('oq_') ? id : `oq_${id}`;
      const exact = await prisma.ownerQuestion.findFirst({ where: { id: probe, userId }, select: { id: true, question: true } }).catch(() => null);
      const cands = !exact && probe.length >= ID_PREFIX_MIN + 3 ? await prisma.ownerQuestion.findMany({ where: { userId, id: { startsWith: probe } }, select: { id: true, question: true }, take: 5 }).catch(() => []) : [];
      return { exact: exact ? pick([exact])[0] : null, candidates: pick(cands) };
    }
    case 'instance': {
      const exact = await prisma.connectedInstance.findFirst({ where: { id, ownerUserId: userId }, select: { id: true, name: true } }).catch(() => null);
      const cands = !exact && isPrefix ? await prisma.connectedInstance.findMany({ where: { ownerUserId: userId, id: { startsWith: id } }, select: { id: true, name: true }, take: 5 }).catch(() => []) : [];
      return { exact: exact ? pick([exact])[0] : null, candidates: pick(cands) };
    }
    // audit 2026-10-06 T5-4: supervisor-state ids (live + archived directives, the dispatch ledger).
    case 'directive':
    case 'dispatch': {
      const docs = supDocs ? await supDocs() : await loadSupervisorDocs(userId);
      const want = id.toLowerCase();
      const rows: Array<{ id: string; label: string }> = [];
      for (const { chatId, doc } of docs) {
        if (family === 'directive') {
          const all = [...(doc.directives ?? []).map((d: any) => ({ d, archived: false })), ...(doc.archived ?? []).map((d: any) => ({ d, archived: true }))];
          for (const { d, archived } of all) {
            const did = String(d?.id ?? '').toLowerCase();
            if (!did || !(did === want || (isPrefix && did.startsWith(want)))) continue;
            rows.push({ id: String(d.id), label: `${d.status ?? 'open'}${archived ? ' (archived)' : ''} directive of supervisor chat ${short(chatId)}: ${String(d.text ?? '').slice(0, 60)}` });
          }
          // 2026-10-22: older CLOSED archived rows live in the cold archive (one store row per id), not the doc.
          if ((doc.archivedColdCount ?? 0) > 0) {
            const { findColdArchivedDirectivesAcross } = await import('./supervisor-state.service');
            for (const { directive: d } of await findColdArchivedDirectivesAcross([chatId], id.trim(), 6)) {
              if (rows.some((r) => r.id === d.id)) continue;
              const did = d.id.toLowerCase();
              if (!(did === want || (isPrefix && did.startsWith(want)))) continue;
              rows.push({ id: d.id, label: `${d.status} (archived) directive of supervisor chat ${short(chatId)}: ${d.text.slice(0, 60)}` });
            }
          }
        } else {
          for (const d of doc.dispatches ?? []) {
            const did = String(d?.id ?? '').toLowerCase();
            if (!did || !(did === want || (isPrefix && did.startsWith(want)))) continue;
            rows.push({ id: String(d.id), label: `${String(d.kind ?? 'dispatch')} recorded by supervisor chat ${short(chatId)} at ${String(d.at ?? '?')}${d.note ? `: ${String(d.note).slice(0, 50)}` : ''}` });
          }
        }
      }
      const exact = rows.find((r) => r.id.toLowerCase() === want) ?? null;
      return { exact, candidates: exact ? [] : rows.slice(0, 5) };
    }
  }
}

export async function executeFleetOpsTool(ctx: Ctx, name: FleetOpsToolName, args: any, deps: Deps): Promise<string> {
  const { platform } = deps;
  const userId = ctx.userId;
  switch (name) {
    case 'list_instances': {
      if (!(await deps.isAdmin(userId))) return 'list_instances is restricted to admin users — paired Digby Edge instances are an admin surface.';
      const svc: any = await import('../instances/instances.service');
      const rows = await svc.listInstances(userId, { includeRevoked: false });
      const instances = (rows as any[]).map((r) => ({ id: r.id, name: r.name, status: r.status, online: !!r.online, lastSeenAt: r.lastSeenAt ?? null, protocolVersion: r.protocolVersion ?? null }));
      return out({ ok: true, tool: name, count: instances.length, instances, message: instances.length ? `${instances.length} paired instance(s); ${instances.filter((i) => i.online).length} online. send_to_instance takes the id.` : 'No paired Digby Edge instances on this account.' });
    }
    case 'ack_digest_item':
    case 'unack_digest_item': {
      const key = String(args?.key || '').trim();
      if (!key) return out({ ok: false, tool: name, reason: 'invalid', message: 'key is required (get_fleet_telemetry view digests → attentionItems[].key).' });
      const fleet: any = await import('../fleet/fleet.service');
      try {
        if (name === 'ack_digest_item') {
          const r = await fleet.ackDigestItem(userId, { key, ...(args?.snoozeHours !== undefined && args?.snoozeHours !== null ? { snoozeHours: Number(args.snoozeHours) } : {}) });
          await audit(userId, 'digest.ack', { key, snoozeUntil: r.snoozeUntil ?? null, chatId: ctx.sessionId });
          return out({ ok: true, tool: name, key, snoozeUntil: r.snoozeUntil ?? null, message: r.snoozeUntil ? `Snoozed "${key.slice(0, 80)}" until ${r.snoozeUntil}.` : `Acknowledged "${key.slice(0, 80)}".` });
        }
        await fleet.unackDigestItem(userId, key);
        await audit(userId, 'digest.unack', { key, chatId: ctx.sessionId });
        return out({ ok: true, tool: name, key, message: `"${key.slice(0, 80)}" is back in the owner's inbox.` });
      } catch (err: any) {
        return out({ ok: false, tool: name, key, reason: Number(err?.statusCode) === 400 ? 'invalid' : 'error', message: String(err?.message || err) });
      }
    }
    case 'get_session_diff': {
      const raw = String(args?.chatId || '').trim();
      if (!raw) return out({ ok: false, tool: name, reason: 'invalid', message: 'chatId is required.' });
      const chatId = raw === ctx.sessionId ? raw : (typeof platform?.resolveOwnedChatIdPrefix === 'function' ? await platform.resolveOwnedChatIdPrefix(userId, raw).catch(() => raw) : raw);
      const { sessionDiffForUser } = await import('../coding/session-diff');
      const d = await sessionDiffForUser(chatId, userId);
      if (!d) return out({ ok: false, tool: name, ids: { chatId }, reason: 'not_found', message: 'No coding session you can read matches that id, or its worktree is not provisioned yet.' });
      // audit 2026-10-06 T5-6 (litellm F3): a FAILED git read is an error
      // state — never "Worktree clean" — and the answer names HEAD + the
      // commits not yet on origin so "committed" / "pushed" are explicit.
      if (d.source === 'error') {
        return out({ ok: false, tool: name, ids: { chatId }, branch: d.branch, source: 'error', reason: 'git_error', changedFiles: null, error: d.error ?? null, message: `The git read of ${short(chatId)}'s worktree FAILED (${d.error ?? 'unknown error'}) — the tree state is UNKNOWN: do NOT read this as clean, committed or lost. Ask the lane for its own \`git status\` / \`git log -1\`, or read its git_commit / git_push receipts.` });
      }
      const changed = d.status.split('\n').filter((l) => l.trim()).length;
      const aheadNote = d.head === undefined ? ''
        : ` HEAD ${d.head ? String(d.head).slice(0, 8) : 'unreadable'}; ${d.upstream ? (d.ahead ? `${d.ahead} commit(s) NOT pushed to ${d.upstream}` : `in sync with ${d.upstream}`) + (d.behind ? `, ${d.behind} behind` : '') : 'branch not on origin (nothing pushed)'}.`;
      return out({ ok: true, tool: name, ids: { chatId }, branch: d.branch, source: d.source, changedFiles: d.source === 'unavailable' ? null : changed, status: d.status, diffStat: d.diffStat, ...(d.head !== undefined ? { head: d.head ?? null, upstream: d.upstream ?? null, ahead: d.ahead ?? null, behind: d.behind ?? null } : {}), message: (d.source === 'unavailable' ? `The box hosting ${short(chatId)}'s worktree did not answer — retry; do NOT read this as a clean tree.` : changed ? `${changed} changed path(s) on ${d.branch ?? 'the branch'} (uncommitted).` : `Worktree clean on ${d.branch ?? 'the branch'} (nothing uncommitted).`) + (d.source === 'unavailable' ? '' : aheadNote) });
    }
    case 'resolve_id': {
      const id = String(args?.id || '').trim();
      if (!id) return out({ ok: false, tool: name, reason: 'invalid', message: 'id is required.' });
      if (id.length < ID_PREFIX_MIN) return out({ ok: false, tool: name, reason: 'too_short', message: `Pass at least ${ID_PREFIX_MIN} characters of the id.` });
      const fam = String(args?.family || '').trim() as IdFamily;
      const famList = activeIdFamilies();
      const families: IdFamily[] = fam ? ((famList as readonly string[]).includes(fam) ? [fam] : []) : famList;
      if (!families.length) return out({ ok: false, tool: name, reason: 'invalid', message: `family must be one of ${famList.join(' | ')}.` });
      const matches: Array<{ family: string; id: string; label: string | null }> = [];
      const candidates: Array<{ family: string; id: string; label: string | null }> = [];
      // One supervisor-state read per call, shared by the directive / dispatch families and the notes scan (T5-4).
      let supDocsP: Promise<SupervisorDocRow[]> | null = null;
      const supDocs = (): Promise<SupervisorDocRow[]> => (supDocsP ??= loadSupervisorDocs(userId));
      for (const f of families) {
        const r = await resolveFamily(f, id, userId, supDocs).catch(() => ({ exact: null, candidates: [] as any[] }));
        if (r.exact) matches.push({ family: f, ...r.exact });
        for (const c of r.candidates) candidates.push({ family: f, ...c });
      }
      const single = matches.length === 0 && candidates.length === 1 ? candidates[0] : null;
      // audit 2026-10-06 T5-4: an id found in NO family but written in a
      // supervisor's notes is a label, not a record — say so (spark F8).
      const mentions: Array<{ where: string; chatId: string; excerpt: string }> = [];
      if (!fam && !matches.length && !candidates.length && !resolveIdSupervisorStateDisabled()) {
        const needle = id.toLowerCase();
        const short8 = needle.slice(0, ID_PREFIX_MIN);
        for (const { chatId, doc } of await supDocs()) {
          const notes = String(doc?.notes ?? '');
          const low = notes.toLowerCase();
          const at = low.indexOf(needle) >= 0 ? low.indexOf(needle) : low.indexOf(short8);
          if (at < 0) continue;
          mentions.push({ where: 'supervisor_notes', chatId, excerpt: notes.slice(Math.max(0, at - 60), at + 80).replace(/\s+/g, ' ').trim() });
          if (mentions.length >= 3) break;
        }
      }
      const message = matches.length === 1 ? `${id} is ${matches[0].family} ${matches[0].id}.`
        : single ? `${id} resolves to ${single.family} ${single.id} (unique prefix).`
        : matches.length > 1 ? `${id} matches ${matches.length} families exactly — pass family.`
        : candidates.length ? `${candidates.length} candidate(s) — pass a longer prefix or the full id.`
        : mentions.length ? `${id} names NO record in any family — it is only MENTIONED in supervisor notes (${mentions.map((m) => `chat ${short(m.chatId)}`).join(', ')}): an UNVERIFIED label, not a live id. Do not act on it as a real record; correct or drop the note.`
        : `Nothing of yours matches ${id} — do not guess; list_* the family and copy the id.`;
      return out({ ok: true, tool: name, query: id, matches, candidates, ...(mentions.length ? { mentions } : {}), resolved: matches.length === 1 ? matches[0] : single, message });
    }
    case 'create_chat_webhook': {
      const raw = String(args?.chatId || '').trim() || ctx.sessionId;
      const chat = await resolveOwnedChat(platform, ctx, raw);
      if (!chat) return out({ ok: false, tool: name, reason: 'not_found', message: 'No chat you own matches that id (webhooks are owner-only).' });
      const wh: any = await import('../webhook.service');
      const existing = await wh.getWebhook(chat.id);
      const rotate = args?.rotate === true;
      if (existing && !rotate) return out({ ok: false, tool: name, ids: { chatId: chat.id }, reason: 'exists', tokenPrefix: existing.tokenPrefix ?? null, message: `Chat ${short(chat.id)} already has a webhook (${existing.tokenPrefix ?? '?'}…) — pass rotate:true to mint a new token (the old one stops working).` });
      const label = typeof args?.label === 'string' && args.label.trim() ? args.label.trim().slice(0, 120) : null;
      // Delegated delivery (ticket 2eef354e): envKey names the ENCRYPTED coding
      // credentials slot the minted token is stored under — the store_secret
      // destination, owner-confirmed by the same card as the mint, so an
      // agent-run setup finishes without the owner ever handling the token.
      // Validated BEFORE minting (the gate also refuses a bad name at STAGE
      // time, so a card never confirms into an invalid vault slot).
      let envKey = String(args?.envKey ?? '').trim();
      if (/^[a-z][a-z0-9_]*$/i.test(envKey)) envKey = envKey.toUpperCase();
      let creds: any = null;
      if (envKey) {
        creds = await import('../coding/credentials.service');
        if (!creds.ENV_KEY_RE.test(envKey)) return out({ ok: false, tool: name, reason: 'invalid_env_key', message: 'envKey must be an UPPER_SNAKE env var name (letters, digits, underscores; 2-64 chars), e.g. CI_WAKE_TOKEN.' });
        if (creds.DENIED_ENV_KEYS.has(envKey)) return out({ ok: false, tool: name, reason: 'reserved_env_key', message: `"${envKey}" is reserved (a shell / platform variable) — pick another name, e.g. ${envKey}_WEBHOOK.` });
      }
      // The no-delivery dead-end guard (ticket 2eef354e): without envKey the
      // only lawful recipient is the owner's browser. A model re-call confirm
      // (the owner typed "confirmed" in chat) has no ownerBrowser — minting
      // there would produce a token NOBODY can ever see (shown once, hash-only
      // storage). Refuse BEFORE minting and name the fix: re-stage with envKey.
      if (!envKey && !ctx.ownerBrowser) {
        return out({ ok: false, tool: name, reason: 'undeliverable', ids: { chatId: chat.id }, message: `Refused: minting now would produce a token nobody can retrieve (it is shown once and only its hash is stored). Either re-stage with envKey (the token is stored encrypted and every coding session shell gets it as $ENVKEY) or have the owner confirm the card in the app. Nothing was minted.` });
      }
      const { record, plaintextToken } = await wh.createOrRotateWebhook({ chatId: chat.id, ...(label !== null ? { label } : {}) });
      const webhookUrl = `/api/crossmodel/webhooks/${chat.id}/fire`;
      if (envKey) {
        try {
          await creds.upsertCredential(ctx.userId, 'custom', envKey, plaintextToken);
        } catch (err: any) {
          // The mint happened but the vault write failed — that token would be
          // lost. The webhook row already carries its hash, so the honest state
          // is: prefix exists, token unrecoverable. Never echo the token.
          await audit(userId, 'webhook.vault_store_failed', { chatId: chat.id, via: 'tool', envKey, error: String(err?.message ?? err).slice(0, 200) });
          return out({ ok: false, tool: name, ids: { chatId: chat.id }, reason: 'vault_store_failed', tokenPrefix: record.tokenPrefix ?? null, message: `The webhook was minted but storing its token under ${envKey} failed: ${String(err?.message ?? err)}. That token is unrecoverable — re-stage this call with rotate:true (same envKey) once the issue is fixed; rotation kills the unrecoverable token.` });
        }
      }
      await audit(userId, existing ? 'webhook.rotate' : 'webhook.create', { chatId: chat.id, via: 'tool', fromChatId: ctx.sessionId, ownerBrowser: !!ctx.ownerBrowser, ...(envKey ? { envKey } : {}) });
      const base = { ok: true, tool: name, ids: { ...(envKey ? { envKey } : {}), chatId: chat.id }, rotated: !!existing, tokenPrefix: record.tokenPrefix ?? null, webhookUrl, label: record.label ?? null };
      // The bearer token is a secret: it goes ONLY to the owner's browser
      // (the REST confirm endpoint stamps ctx.ownerBrowser) or, with envKey,
      // straight into the encrypted vault — the model re-call path, run
      // transcripts and agent_events never carry it.
      if (envKey) {
        return out({ ...base, message: `Webhook ${existing ? 'rotated' : 'created'} for chat ${short(chat.id)} (${record.tokenPrefix ?? '?'}…). The bearer token is stored encrypted under $${envKey} — every coding session shell of this account has it from its next command. POST ${webhookUrl} with \`Authorization: Bearer $${envKey}\`. Never paste the value into a message; revoke with revoke_chat_webhook when done.` });
      }
      if (ctx.ownerBrowser) {
        return out({ ...base, secret: { label: `Webhook bearer token for chat ${short(chat.id)} — shown once, store it now`, value: plaintextToken }, message: `Webhook ${existing ? 'rotated' : 'created'} — the token is displayed once in your browser; POST ${webhookUrl} with it as the bearer.` });
      }
      // Unreachable in practice (the undeliverable guard above returns first) —
      // kept as a fail-safe: if the guard is ever relaxed, an owner-browser-less
      // no-envKey mint must still never claim a delivery that did not happen.
      return out({ ...base, message: `Webhook ${existing ? 'rotated' : 'created'} for chat ${short(chat.id)} (${record.tokenPrefix ?? '?'}…), but no delivery route ran (no envKey, not the owner's browser) — the token is unrecoverable. Re-stage with rotate:true and envKey, or confirm the card in the app.` });
    }
    case 'get_chat_webhook':
    case 'revoke_chat_webhook': {
      const raw = String(args?.chatId || '').trim() || ctx.sessionId;
      const chat = await resolveOwnedChat(platform, ctx, raw);
      if (!chat) return out({ ok: false, tool: name, reason: 'not_found', message: 'No chat you own matches that id (webhooks are owner-only).' });
      const wh: any = await import('../webhook.service');
      if (name === 'get_chat_webhook') {
        const row = await wh.getWebhook(chat.id);
        const webhookUrl = `/api/crossmodel/webhooks/${chat.id}/fire`;
        if (!row) return out({ ok: true, tool: name, ids: { chatId: chat.id }, exists: false, webhookUrl, message: `Chat ${short(chat.id)} has no inbound webhook — the owner mints one in the chat's webhook settings (the token shows once there).` });
        return out({ ok: true, tool: name, ids: { chatId: chat.id }, exists: true, isActive: !!row.isActive, label: row.label ?? null, tokenPrefix: row.tokenPrefix ?? null, webhookUrl, lastUsedAt: row.lastUsedAt ?? null, createdAt: row.createdAt ?? null, message: `Chat ${short(chat.id)} has an ${row.isActive ? 'active' : 'inactive'} webhook (${row.tokenPrefix ?? '?'}…) — POST ${webhookUrl} with the bearer token wakes it.` });
      }
      const revoked = await wh.revokeWebhook(chat.id);
      await audit(userId, 'webhook.revoke', { chatId: chat.id, via: 'tool', fromChatId: ctx.sessionId });
      return out({ ok: true, tool: name, ids: { chatId: chat.id }, revoked, message: revoked ? `Webhook on chat ${short(chat.id)} revoked — external callers now get 401.` : `Chat ${short(chat.id)} had no webhook.` });
    }
    case 'test_model_role': {
      if (!(await deps.isAdmin(userId))) return 'test_model_role is restricted to admin users — model seats are instance-wide settings, and a live probe spends provider credit.';
      const role = String(args?.role || '').trim();
      if (!role) return out({ ok: false, tool: name, reason: 'invalid', message: 'role is required (get_model_roles lists the seat keys).' });
      const candidate = typeof args?.candidate === 'string' && args.candidate.trim() ? args.candidate.trim() : undefined;
      const fallback = args?.fallback === true;
      const svc: any = await import('../model-endpoints/model-roles.service');
      // Ticket 7a078b4d (2026-09-28): the [INFRA ALERT — decision backend]
      // playbook told the Fleet Supervisor to "check with the Model roles Test
      // button" — a UI control — and its natural tool translation
      // {role:'decision_gate'} (the admin panel's own section label; the seat
      // KEY is 'decision') 400'd deterministically 3× and tripped the
      // tool-failure breaker. Two heals + no dead ends:
      //   (a) the seat-label synonym heals inside normalizeRoleKey
      //       (ROLE_SYNONYMS, model-roles.service);
      //   (b) a decision BACKEND spec as `role` ('jev' — the alert text names
      //       backends, never seats) means "probe that backend": the decision
      //       seat with the spec as the candidate — exactly what the Test
      //       button's Decision-gate probe does. Only this one uniquely-named
      //       spec heals; anything else stays a real refusal.
      let key = typeof svc.normalizeRoleKey === 'function' ? svc.normalizeRoleKey(role) : role;
      let probeCandidate = candidate;
      let probeFallback = fallback;
      if (!key && role === 'jev') {
        // "Probe the jev backend" — never a fallback-slot probe (the caller
        // named a backend spec as the role; the slot concept does not apply).
        key = 'decision'; probeCandidate = candidate ?? 'jev'; probeFallback = false;
      }
      const healed = !!key && key !== role;
      if (!key) {
        const seatKeys = Array.isArray(svc.MODEL_ROLES) ? svc.MODEL_ROLES.map((r: any) => r.key).filter((k: any) => typeof k === 'string') : [];
        const modelIds: string[] = svc.BUILT_IN_MODEL_IDS instanceof Set ? Array.from(svc.BUILT_IN_MODEL_IDS as Set<string>) : [];
        const modelHint = modelIds.includes(role) || role.includes(':')
          ? ` — "${role}" is a MODEL id/spec, not a seat: name the SEAT (a key above) and pass the model as candidate; a decision backend probes as {role:'decision', candidate:'${role}'}`
          : '';
        return out({
          ok: false, tool: name, reason: 'invalid', role,
          message: seatKeys.length
            ? `Unknown seat "${role}" — the seat keys are: ${seatKeys.join(', ')}.${modelHint}`
            : `Unknown seat "${role}" — the Decision gate seat's key is 'decision' (a backend spec like 'jev' probes as {role:'decision', candidate:'jev'}); get_model_roles lists every key.`,
        });
      }
      const t0 = Date.now();
      let timer: NodeJS.Timeout | undefined;
      try {
        const probe: Promise<any> = svc.testModelRole(key, probeCandidate, probeFallback ? { fallback: true } : undefined);
        const capped = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`test_model_role exceeded ${TEST_MODEL_ROLE_CAP_MS / 1000}s`)), TEST_MODEL_ROLE_CAP_MS); });
        const r = await Promise.race([probe, capped]);
        const latencyMs = Number.isFinite(Number(r?.latencyMs)) ? Number(r.latencyMs) : Date.now() - t0;
        const model = typeof r?.target === 'string' ? r.target : (probeCandidate ?? null);
        await audit(userId, 'model_role.test', { role: key, ...(healed ? { roleInput: role } : {}), candidate: probeCandidate ?? null, fallback: probeFallback, ok: !!r?.ok, latencyMs, chatId: ctx.sessionId });
        const base = { ok: !!r?.ok, tool: name, role: key, model, latencyMs, callShape: typeof r?.detail === 'string' && r.detail ? r.detail : "the seat's real call shape (see get_model_roles chains)", ...(healed ? { healedFrom: role } : {}), ...(probeFallback ? { slot: 'fallback' } : {}), ...(probeCandidate ? { candidate: probeCandidate } : {}) };
        if (r?.ok) return out({ ...base, message: `${healed ? `Healed "${role}" → seat "${key}". ` : ''}${key} answered in ${latencyMs} ms via ${model ?? 'its configured model'}.` });
        const error = typeof r?.error === 'string' && r.error ? r.error : 'probe failed';
        return out({ ...base, error, message: `${healed ? `Healed "${role}" → seat "${key}". ` : ''}${key} probe FAILED${model ? ` (${model})` : ''}: ${error}` });
      } catch (err: any) {
        const latencyMs = Date.now() - t0;
        const message = String(err?.message || err);
        await audit(userId, 'model_role.test', { role: key, ...(healed ? { roleInput: role } : {}), candidate: probeCandidate ?? null, fallback: probeFallback, ok: false, latencyMs, error: message.slice(0, 200), chatId: ctx.sessionId });
        return out({ ok: false, tool: name, role: key, model: probeCandidate ?? null, latencyMs, reason: Number(err?.statusCode) === 400 ? 'invalid' : 'error', ...(healed ? { healedFrom: role } : {}), error: message, message: `${healed ? `Healed "${role}" → seat "${key}". ` : ''}${key} probe could not run: ${message}` });
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    case 'get_decision_gate_status': {
      // Rollout self-governance (2026-09-27): the registry joined with the live
      // modes, the readiness stamp, the automaton's ledger and recent demotes.
      // Read-only; every read fails open to "unknown" rather than throwing.
      const [{ listDecisionRegistry }, modesMod, readinessMod, rolloutMod] = await Promise.all([
        import('./decision-gate-registry'), import('./decision-gate-modes'), import('./decision-gate-readiness'), import('./decision-gate-rollout'),
      ]);
      const only = typeof args?.purpose === 'string' && args.purpose.trim() ? args.purpose.trim() : null;
      const [modes, stamp, rollout] = await Promise.all([
        modesMod.getDecisionModeConfig().catch(() => null),
        readinessMod.readReadinessStamp().catch(() => null),
        rolloutMod.getRolloutView().catch(() => null),
      ]);
      const byPurpose = new Map((modes?.purposes ?? []).map((p: any) => [p.purpose, p]));
      const parked = new Set(Object.entries(rollout?.state.parked ?? {}).filter(([, p]: [string, any]) => Date.parse(p.until) > Date.now()).map(([k]) => k));
      const rows = listDecisionRegistry().filter(r => !only || r.purpose === only).map(r => {
        const m: any = byPurpose.get(r.purpose);
        const s: any = stamp?.[r.purpose];
        const base = {
          purpose: r.purpose, label: r.label, tier: r.tier,
          effective: m?.effective ?? 'unknown', source: m?.effectiveSource ?? 'unknown', storeMode: m?.storeMode ?? null,
          ready: s ? (s.ready ? 'READY' : 'NOT READY') : 'no stamp', stale: m?.readiness?.stale ?? null, readinessAt: s?.at ?? null, readinessBackend: s?.backend ?? null, labels: s?.metrics?.n ?? null,
          admitted: m?.admission?.admitted ?? null, admissionReason: m?.admission?.reason ? String(m.admission.reason).slice(0, 220) : null,
          parked: parked.has(r.purpose), actCap: r.actCap && r.actCap.active ? `since ${r.actCap.since}: ${r.actCap.why}` : null,
          // roster 2026-10-06 B-2: the purpose is no longer ASKED on human turns (machine turns still ask) — never a flip candidate for human traffic.
          ...(r.retiredOnHumanTurns?.active ? { humanTurns: `retired since ${r.retiredOnHumanTurns.since} (no ask on human turns; lift ${r.retiredOnHumanTurns.liftEnv}=1)` } : {}),
          ...(m?.primarySpec ? { primary: m.primarySpec } : {}),
        };
        return only ? { ...base, decides: r.decides, actDoes: r.actDoes, consumerSite: r.consumerSite, question: `${r.question} (${r.questionShape}, τ ${r.defaultThreshold})`, harnessLabel: r.harnessLabel, bars: r.bars, tierWhy: r.tierWhy, killSwitches: r.killSwitches, ownerLock: r.ownerLock, readinessReasons: s?.reasons ?? [] } : base;
      });
      if (only && !rows.length) return out({ ok: false, tool: name, reason: 'not_found', message: `Unknown purpose "${only}" — the registry has: ${listDecisionRegistry().map(r => r.purpose).join(', ')}.` });
      const act = rows.filter(r => r.effective === 'act').map(r => r.purpose);
      return out({
        ok: true, tool: name, count: rows.length, act, purposes: rows,
        rollout: rollout ? { enabled: rollout.switch.enabled, dryRun: rollout.switch.dryRun, jobDisabled: rollout.switch.jobDisabled, intervalMin: rollout.switch.intervalMin, lastRunAt: rollout.state.lastRunAt, lastSummary: rollout.state.lastSummary, recentActions: rollout.state.actions.slice(0, 12), parked: rollout.state.parked, ownerAsks: rollout.state.ownerAsks, inconsistencies: rollout.state.inconsistencies, tierRule: rollout.tierRule, recentAutoDemotes: rollout.recentDemotes } : null,
        gateDisabledHere: modes?.gateDisabled ?? null, storeIgnoredHere: modes ? false : null,
        message: `${act.length} purpose(s) in act (${act.join(', ') || 'none'}); auto-rollout ${rollout ? (rollout.switch.enabled ? (rollout.switch.dryRun ? 'ON (dry run)' : 'ON') : 'OFF') : 'unknown'}${rollout?.state.inconsistencies.length ? `; ${rollout.state.inconsistencies.length} store/code inconsistency(ies) — settle by hand` : ''}. A parked, skipped or late machine turn on an act purpose is the gate working (rule gate.outcome), not a lost wake.`,
      });
    }
    case 'set_decision_gate_mode': {
      if (!(await deps.isAdmin(userId))) return out({ ok: false, tool: name, reason: 'forbidden', message: 'set_decision_gate_mode is restricted to admin owners — decision-gate modes are instance-wide settings.' });
      const purpose = String(args?.purpose || '').trim();
      const modeRaw = String(args?.mode ?? '').trim().toLowerCase();
      const modesMod = await import('./decision-gate-modes');
      if (!modesMod.isStorablePurpose(purpose)) return out({ ok: false, tool: name, reason: 'invalid', message: `Unknown purpose "${purpose || '(empty)'}" — get_decision_gate_status lists the ids.` });
      const mode = modeRaw === '' ? null : modesMod.parseDecisionMode(modeRaw);
      if (modeRaw !== '' && !mode) return out({ ok: false, tool: name, reason: 'invalid', message: `Invalid mode "${modeRaw}" — use off, shadow, act, or '' to clear.` });
      let supervisorChat = false;
      try { supervisorChat = await (await import('./supervisor-state.service')).isSupervisorChat(ctx.sessionId); } catch { supervisorChat = false; }
      const userPresent = !!ctx.userTurnAt;
      if (!supervisorChat && !userPresent) return out({ ok: false, tool: name, reason: 'scope', ids: { purpose }, message: 'set_decision_gate_mode is scoped to the Fleet Supervisor chat (and to user-present turns). A lane never flips a gate purpose — a parked or skipped turn is the gate working, not a defect (rule gate.outcome).' });
      const { rolloutTierFor, DECISION_ROLE_REGISTRY } = await import('./decision-gate-registry');
      const tier = rolloutTierFor(purpose);
      // A WIDENING act flip outside tier 1 from a machine turn needs the owner: ONE owner question, then the GO answer executes.
      if (mode === 'act' && tier !== 1 && !userPresent) {
        const oqId = typeof args?.ownerQuestionId === 'string' ? args.ownerQuestionId.trim() : '';
        const prisma = await db();
        if (oqId) {
          const row = await prisma.ownerQuestion.findFirst({ where: { id: oqId, userId }, select: { status: true, answer: true, chosenOption: true, question: true } }).catch(() => null);
          const { ownerAnswerIsGo } = await import('./decision-gate-rollout');
          const mentions = typeof row?.question === 'string' && row.question.includes(purpose);
          if (!row || !mentions) return out({ ok: false, tool: name, reason: 'invalid', ids: { purpose }, message: `Owner question ${oqId || '(empty)'} does not exist for this owner or does not concern ${purpose}.` });
          if (row.status !== 'answered') return out({ ok: false, tool: name, reason: 'staged', staged: true, ownerQuestionId: oqId, ids: { purpose }, message: `Owner question ${oqId} is ${row.status} — nothing has changed. The flip executes only once the owner answers it with a GO.` });
          if (!ownerAnswerIsGo(row.answer, row.chosenOption)) return out({ ok: false, tool: name, reason: 'refused', ids: { purpose }, message: `The owner answered ${oqId} without a GO ("${String(row.answer ?? row.chosenOption ?? '').slice(0, 120)}") — ${purpose} stays ${modesMod.storedDecisionModeSync(purpose) ?? 'on its env mode'}.` });
        } else {
          const { flagOwnerQuestion } = await import('./owner-questions');
          const spec = DECISION_ROLE_REGISTRY[purpose];
          const r = await flagOwnerQuestion({
            chatId: ctx.sessionId, userId,
            question: `[Decision gate] Flip ${purpose} to act? It is tier ${tier ?? '?'} (${spec?.tierWhy ?? 'needs a human look'}). act = ${spec?.actDoes ?? 'see get_decision_gate_status'}.`,
            context: `Requested by the Fleet Supervisor via set_decision_gate_mode from chat ${ctx.sessionId}. The flip runs through the admin PUT's admission (caps, READY stamp, primary pin) once you answer 'flip'; a wrong act auto-demotes.`,
            options: [{ id: 'flip', label: 'Flip to act' }, { id: 'hold', label: 'Keep shadow' }],
            machineTriggered: true,
          });
          const qid = r.kind === 'created' || r.kind === 'deduped' ? r.question.id : null;
          await audit(userId, 'decision_gate.mode_staged', { purpose, mode, tier, ownerQuestionId: qid, chatId: ctx.sessionId, refused: r.kind === 'refused' ? r.refused : null });
          return out({ ok: false, tool: name, reason: 'staged', staged: true, ownerQuestionId: qid, ids: { purpose }, message: qid ? `Nothing has changed yet — ${purpose} is tier ${tier}, so the act flip needs the owner: owner question ${qid} filed. Re-call with ownerQuestionId once it is answered 'flip'.` : `Nothing has changed — ${purpose} is tier ${tier} and the owner question could not be filed (${r.kind === 'refused' ? r.refused : 'unknown'}).` });
        }
      }
      try {
        const primaryOpts: any = {};
        try { const b: any = await import('./decision-gate-backends'); if (typeof b.resolveEffectivePrimarySpec === 'function') primaryOpts.primarySpecFor = (p: string) => b.resolveEffectivePrimarySpec(p); } catch { /* no pin */ }
        const before = modesMod.storedDecisionModeSync(purpose);
        const cfg = await modesMod.updateDecisionModes({ [purpose]: mode ?? '' }, `tool:${userId}`, primaryOpts);
        const view = cfg.purposes.find(p => p.purpose === purpose);
        await audit(userId, 'decision_gate.mode_set', { purpose, mode, before, effective: view?.effective ?? null, tier, chatId: ctx.sessionId, supervisorChat, userPresent });
        try { const { recordLoopMetric } = await import('./loop-metrics.service'); recordLoopMetric({ kind: 'decision_gate_rollout', meta: { purpose, from: before ?? '(env)', to: mode ?? '(env)', reason: 'tool', by: userId, chatId: ctx.sessionId } }); } catch { /* telemetry never throws */ }
        return out({ ok: true, tool: name, ids: { purpose, mode: mode ?? '' }, before: before ?? '(env)', effective: view?.effective ?? null, source: view?.effectiveSource ?? null, message: `${purpose} set to ${mode ?? 'its env mode'} fleet-wide (every box within 30 s); effective now: ${view?.effective ?? '?'}${tier ? ` (tier ${tier})` : ''}.` });
      } catch (err: any) {
        const message = String(err?.message || err);
        await audit(userId, 'decision_gate.mode_refused', { purpose, mode, tier, chatId: ctx.sessionId, error: message.slice(0, 300) });
        return out({ ok: false, tool: name, reason: Number(err?.statusCode) === 409 ? 'refused' : Number(err?.statusCode) === 400 ? 'invalid' : 'error', ids: { purpose }, message: `NOT done — ${message}` });
      }
    }
    default:
      return out({ ok: false, tool: name, reason: 'unknown', message: `Unknown fleet-ops tool ${name}.` });
  }
}
