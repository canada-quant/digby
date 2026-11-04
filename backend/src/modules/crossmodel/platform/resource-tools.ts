/**
 * Watched-resource + training-artifact platform tools (remediation P7 S1b) —
 * the tool half of platform/resources.service.ts:
 *
 *   register_watched_resource — declare an EXTERNAL resource this lane is
 *     responsible for (GPU reservation, training box, paid sandbox). NOT gated
 *     beyond sign-in: registering is the honest act the watchdog needs.
 *   observe_resource — stamp lastObservedAt now. MACHINE calls (no user-turn
 *     anchor) require ≥1 OK tool receipt THIS RUN: "observed" must mean a tool
 *     actually executed this run, not a narrated check (P4 evidence doctrine).
 *   register_artifact — record a durable training output (checkpoint/dataset/
 *     eval/model) by uri.
 *   verify_durable — stamp durableVerifiedAt. MACHINE calls require BOTH ≥1 OK
 *     receipt this run AND an `evidence` string naming the uri (the quoted
 *     ls/HEAD/stat output line) — receipts store only hashes, so the citation
 *     carries the human-checkable text while the receipt proves a tool ran.
 *   release_watched_resource (ticket a0a199f8) — retire the registration: the
 *     box is torn down, the reservation ended, or the row is a stale duplicate.
 *     NOT gated beyond sign-in (owner-scoped, re-registerable bookkeeping) —
 *     an unattended cleanup lane MUST be able to release stale rows, or the
 *     ghost-alarm class this fixes would be unfixable from machine runs.
 *     Its not_found envelope reuses the 251e9329 rich-refusal idiom (it names
 *     what IS registered) via resources.service.noWatchedResourceMessage.
 *
 * IMPORT DISCIPLINE (the account-tools contract): statically import ONLY the
 * ToolContext type — everything heavy (resources.service → prisma/redis,
 * run-receipts) loads lazily inside the executor, so platform-tools' static
 * graph stays jest-light.
 */

import type { ToolContext } from '../coding/tools';

// ── Names ─────────────────────────────────────────────────────────────────────

const RESOURCE_TOOL_NAMES = [
  'register_watched_resource', 'observe_resource', 'register_artifact', 'verify_durable', 'release_watched_resource',
] as const;

const RESOURCE_TOOL_SET = new Set<string>(RESOURCE_TOOL_NAMES);

/** True if the tool is one of the resource tools (dispatched to executeResourceTool). */
export function isResourceTool(name: string): boolean {
  return RESOURCE_TOOL_SET.has(name);
}

// ── Schemas ───────────────────────────────────────────────────────────────────

export const RESOURCE_TOOL_SCHEMA = [
  {
    type: 'function' as const,
    function: {
      name: 'register_watched_resource',
      description:
        'Register an EXTERNAL resource this lane is responsible for watching — a GPU reservation, a training box, a paid sandbox, anything that costs money or expires while unattended. ' +
        'The platform watchdog then alarms the owner (Telegram + supervisor note, deduped 6h) when the resource goes unobserved past maxUnobservedMinutes or its reservation ends within 24h. ' +
        'Registration counts as the first observation. Call observe_resource on every real check thereafter. ' +
        'Doctrine: NEVER release/tear down a watched resource until its training artifacts verify durable (verify_durable receipts exist).',
      parameters: {
        type: 'object',
        properties: {
          label: { type: 'string', description: 'What the resource IS, unambiguous in an alarm (e.g. "brev 8xH100 reservation acme-run-3"). ≤200 chars.' },
          usdPerHour: { type: 'number', description: 'Optional burn rate — alarms then carry "burning ~$N/h".' },
          reservationEndsAt: { type: 'string', description: 'Optional ISO timestamp the reservation/lease ends — the watchdog warns within 24h of it.' },
          maxUnobservedMinutes: { type: 'number', description: 'How stale an observation may get before the owner is alarmed (5..10080; default 240 = 4h). Set it to your real check cadence with slack.' },
          notes: { type: 'string', description: 'Optional operational notes (how to check it, how to tear it down). ≤2000 chars.' },
          projectId: { type: 'string', description: 'Optional project id to file it under — an id from list_projects rows, NOT the project name or slug. Omit entirely to use the current project when known.' },
        },
        required: ['label'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'observe_resource',
      description:
        'Stamp a watched resource as OBSERVED now (resets its unobserved clock). Call it right after you actually checked the resource this run (status command, dashboard scrape, queue poll). ' +
        'In a machine-triggered run this REQUIRES at least one OK tool receipt this run — an observation must be backed by a real execution, not narrated. ' +
        'Pass the resource id (or its unique label). If the id is refused as unknown (e.g. the registry changed since your instructions were written), the refusal lists the resources that ARE registered — re-observe the right one, or register it with register_watched_resource; the full registry is in get_account_overview → watchedResources.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The watched resource id (full or unique ≥8-char prefix), or its exact label.' },
          note: { type: 'string', description: 'Optional replacement notes (e.g. current job state). ≤2000 chars.' },
        },
        required: ['id'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'register_artifact',
      description:
        'Record a durable TRAINING ARTIFACT (checkpoint | dataset | eval | model | other) by uri — the outputs a watched resource exists to produce. ' +
        'Register artifacts as they land, then verify_durable once each is confirmed to exist somewhere that survives the resource being released.',
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['checkpoint', 'dataset', 'eval', 'model', 'other'] },
          label: { type: 'string', description: 'Human name (e.g. "epoch-3 checkpoint"). ≤200 chars.' },
          uri: { type: 'string', description: 'Where it durably lives: s3://…, hf://…, an absolute path on persistent storage, a URL. ≤1000 chars.' },
          sha: { type: 'string', description: 'Optional content hash.' },
          bytes: { type: 'number', description: 'Optional size in bytes.' },
          projectId: { type: 'string', description: 'Optional project to file it under.' },
        },
        required: ['kind', 'label', 'uri'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'verify_durable',
      description:
        'Stamp a registered training artifact as DURABLE-VERIFIED — you confirmed it exists at its uri OUTSIDE the ephemeral resource (ls/stat/HEAD/aws s3 ls output). ' +
        'In a machine-triggered run this REQUIRES evidence: the quoted tool-output line naming the uri (≥8 chars), AND at least one OK tool receipt this run. ' +
        'Release/teardown of a watched resource is refused by doctrine until its artifacts carry this stamp.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The artifact id (full or unique ≥8-char prefix), or its exact uri.' },
          evidence: { type: 'string', description: 'The tool-output line proving the artifact exists at its uri (e.g. the `aws s3 ls` / `ls -la` / HTTP 200 HEAD line). REQUIRED in machine-triggered runs; must name the uri (or its basename). For a COMPOUND uri ("primary (+ secondary)") naming any one component (or its filename) counts.' },
        },
        required: ['id'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'release_watched_resource',
      // build 2026-10-08 A2-3 (tool diet): past-reservation alarm suppression is ticket a0a199f8.
      description:
        'RELEASE (unregister) a watched resource — the reservation ended, the box was torn down, or the row is a stale duplicate. Deletes the registration so the watchdog never alarms about it again. ' +
        'Owner-scoped, not gated beyond sign-in: any of the owner\'s lanes (or the fleet supervisor) may retire a stale row unattended. ' +
        'If the resource PRODUCED training artifacts, confirm each verifies durable (verify_durable) BEFORE releasing — release never touches artifact rows. ' +
        'Alarms past reservationEndsAt are already suppressed; release silences the rest. Registrations: get_account_overview → watchedResources.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The watched resource id (full or unique ≥8-char prefix), or its exact label.' },
          reason: { type: 'string', description: 'Optional one-liner for the backend log (e.g. "reservation ended", "duplicate of b18d1c00"). ≤300 chars.' },
        },
        required: ['id'],
      },
    },
  },
];

// ── Executor ──────────────────────────────────────────────────────────────────

function j(obj: unknown): string {
  return JSON.stringify(obj, null, 1);
}

function refuse(tool: string, reason: string, message: string, extra: Record<string, unknown> = {}): string {
  return j({ ok: false, tool, reason, message, ...extra });
}

function isAnonymous(ctx: ToolContext): boolean {
  return !ctx.userId || ctx.userId === 'anonymous';
}

/** Real project id from ctx when present ('chat' is the chat-surface sentinel). */
function contextProjectId(ctx: ToolContext, args: any): string | null {
  const explicit = String(args?.projectId ?? '').trim();
  if (explicit) return explicit;
  const own = String((ctx as any).projectId ?? '').trim();
  return own && own !== 'chat' ? own : null;
}

/**
 * The receipts this RUN has produced. TWO sources, in order (ticket
 * 119df67e): (1) the agent loop's in-process receipt collector threaded onto
 * ctx — the SAME array the receipt seam pushes every consequential execution
 * into, so it is authoritative for THIS run on EVERY surface; (2) the DB,
 * keyed on runId (ctx.runId, else the session's live 'running' agent_runs
 * row). Chat-surface runs (supervisor sweeps, hook wakes — the surface ticket
 * 119df67e tripped on) persist receipts keyed by chatId — since ticket
 * e225aad8 under the turn's telemetry id (chat-<uuid>), still NOT an
 * agent_runs id — and create NO agent_runs row, so source (2) alone sees
 * NOTHING for them — the gate then refused real observations that HAD
 * followed real checks (an ok list_chats 30s before, an ok get_chat_status
 * 16s before). [] on any failure — the caller's gate then refuses honestly
 * rather than passing on uncertainty.
 */
async function currentRunReceipts(ctx: ToolContext): Promise<Array<{ tool: string; ok: boolean; ids?: Record<string, unknown> | null }>> {
  // (1) In-process collector first: one array per top-level run, shared with
  // workers via the delegate input spread. An ok receipt there IS this run's
  // real execution — no DB round trip needed.
  const collected = Array.isArray((ctx as any).receipts) ? (ctx as any).receipts : [];
  if (collected.some((r: any) => r?.ok)) return collected;

  // (2) DB path (coding runs with an agent_runs row; bare/test contexts).
  try {
    const { getRunReceipts } = await import('../coding/run-receipts.service');
    let runId: string | null = (ctx as any).runId ?? null;
    if (!runId) {
      const prisma = (await import('../../../config/database')).default;
      const row = await prisma.agentRun.findFirst({
        where: { sessionId: ctx.sessionId, status: 'running' },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      }).catch(() => null);
      runId = row?.id ?? null;
    }
    if (!runId) return [];
    return await getRunReceipts(runId);
  } catch {
    return [];
  }
}

/** Does the evidence text actually NAME the uri (full, or a ≥4-char basename)? Pure. */
/** Token-identity chars: a basename embedded in a LARGER name (hyphen/underscore/digit-joined) is a different file, not this one. */
const NAME_TOKEN_CHARS = /[A-Za-z0-9_-]/;

/**
 * True when `token` appears in `haystack` as its own name token — not glued
 * inside a larger name ("backups" ⊂ "deckpose-backups" does NOT count;
 * "... 1.2G ckpt-epoch3.pt" and "path/optcg_20261019.dump" DO). '.' is
 * deliberately NOT a boundary char on either side: "ckpt-epoch3.pt."
 * (sentence period) still counts, matching the pre-fix substring behavior
 * for dot-adjacent quotes.
 */
function includesAsNameToken(haystack: string, token: string): boolean {
  let idx = haystack.indexOf(token);
  while (idx !== -1) {
    const before = idx > 0 ? haystack[idx - 1] : null;
    const after = idx + token.length < haystack.length ? haystack[idx + token.length] : null;
    const okBefore = before === null || !NAME_TOKEN_CHARS.test(before);
    const okAfter = after === null || !NAME_TOKEN_CHARS.test(after);
    if (okBefore && okAfter) return true;
    idx = haystack.indexOf(token, idx + 1);
  }
  return false;
}

/** Minimum length for a WHOLE-component substring match — a short/generic
 *  annotation component ("(+ok)", "(+id)") is not evidence by itself
 *  (reviewer probe: "bytes ok" must not verify 's3://bucket/x.pt (+ok)'). */
const MIN_COMPONENT_LEN = 8;

/** Does `e` name component `c`? The PRIMARY component keeps the historical
 *  rule (≥4-char basename as a token); SECONDARY components need something
 *  more specific — the whole component, a dot-bearing filename, or the last
 *  two path segments — because a bare directory word ("backups") is not
 *  unique evidence and would let sibling artifacts' output lines through. */
function componentNamesUri(e: string, c: string, primary: boolean): boolean {
  if (c.length >= MIN_COMPONENT_LEN && e.includes(c)) return true;
  const trimmed = c.replace(/[/?#]+$/, '');
  const base = trimmed.split(/[/\\]/).pop() ?? '';
  if (primary) return base.length >= 4 && includesAsNameToken(e, base);
  if (base.includes('.') && base.length >= 4 && includesAsNameToken(e, base)) return true;
  const tail2 = trimmed.split(/[/\\]/).slice(-2).join('/');
  return tail2.includes('/') && tail2.length >= MIN_COMPONENT_LEN && includesAsNameToken(e, tail2);
}

/**
 * Evidence must name the artifact's REAL uri — never a bare "it's there".
 * Ticket 748c9903: the registered uri may be a COMPOUND/ANNOTATED string
 * (a lane registers "amd-2:/path/file.dump (+ amd-1:/other/dir/)" — one
 * artifact, several durable locations, or a parenthetical note). The old
 * matcher took the LAST path segment of the whole string (")" here — 1 char
 * < 4), so NO truthful ls/stat line could ever match: the artifact became
 * un-stampable by construction and the lane burned a 3× evidence_required
 * streak re-quoting real stat output. Decompose instead: split the uri on
 * the " (+…)" annotation shape, then accept evidence naming the full string,
 * any whole component, or (per component, see componentNamesUri) a specific
 * name token of a component. Security properties: every accepted token IS
 * part of the registered uri (unrelated paths still refuse), basenames must
 * appear as their own token (a sibling file "deckpose-backups" no longer
 * rides on a directory word), and secondary components cannot be verified
 * by a bare generic directory name.
 */
export function evidenceNamesUri(evidence: string, uri: string): boolean {
  const e = String(evidence ?? '');
  const u = String(uri ?? '').trim();
  if (!e || !u) return false;
  if (e.includes(u)) return true;
  // Compound/annotated uris: "primary (+ secondary)" / "primary (+host note)".
  // Split on the " (+…)" annotation shape, keeping every component intact.
  const components = u
    .split(/\s*\(\+\s*|\s*\)\s*$/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const candidates = components.length > 0 ? components : [u];
  return candidates.some((c, i) => componentNamesUri(e, c, i === 0));
}

/**
 * Execute one resource tool. NEVER throws — every failure returns an honest
 * ok:false envelope the model can read (the account-tools contract).
 */
export async function executeResourceTool(ctx: ToolContext, name: string, args: any): Promise<string> {
  try {
    return await dispatch(ctx, name, args);
  } catch (err: any) {
    return refuse(name, 'error', String(err?.message ?? err).slice(0, 400));
  }
}

async function dispatch(ctx: ToolContext, name: string, args: any): Promise<string> {
  if (isAnonymous(ctx)) {
    return refuse(name, 'anonymous', `${name} needs a signed-in user — resources and artifacts are account records.`);
  }
  const userId = ctx.userId;
  const svc = await import('./resources.service');

  switch (name) {
    case 'register_watched_resource': {
      const r = await svc.registerWatchedResource(userId, {
        label: String(args?.label ?? ''),
        projectId: contextProjectId(ctx, args),
        ...(args?.usdPerHour !== undefined && args?.usdPerHour !== null ? { usdPerHour: Number(args.usdPerHour) } : {}),
        ...(args?.reservationEndsAt ? { reservationEndsAt: String(args.reservationEndsAt) } : {}),
        ...(args?.maxUnobservedMinutes !== undefined && args?.maxUnobservedMinutes !== null ? { maxUnobservedMinutes: Number(args.maxUnobservedMinutes) } : {}),
        ...(args?.notes !== undefined ? { notes: String(args.notes) } : {}),
      });
      return j({ ok: true, tool: name, resource: r, message: `Watching "${r.label}" — observe it at least every ${r.maxUnobservedMinutes} min (observe_resource ${r.id.slice(0, 8)}) or the owner is alarmed.` });
    }

    case 'observe_resource': {
      // Machine-call receipt gate (S1b): an unattended "I checked it" must be
      // backed by ≥1 OK tool receipt from THIS run — the same actor
      // discriminator every evidence gate uses (no ctx.userTurnAt ⇒ machine).
      if (!ctx.userTurnAt) {
        const receipts = await currentRunReceipts(ctx);
        if (!receipts.some((r) => r?.ok)) {
          return refuse(
            name, 'no_receipt',
            'Machine-triggered observations must follow a REAL check: run the status command / scrape / poll FIRST (so a tool receipt exists this run), then call observe_resource. No receipt this run = nothing was observed.',
          );
        }
      }
      const r = await svc.observeResource(userId, String(args?.id ?? ''), args?.note !== undefined ? String(args.note) : undefined);
      return j({ ok: true, tool: name, resource: r, message: `Observed "${r.label}" — unobserved clock reset.` });
    }

    case 'register_artifact': {
      const a = await svc.registerArtifact(userId, {
        kind: String(args?.kind ?? ''),
        label: String(args?.label ?? ''),
        uri: String(args?.uri ?? ''),
        projectId: contextProjectId(ctx, args),
        ...(args?.sha !== undefined ? { sha: String(args.sha) } : {}),
        ...(args?.bytes !== undefined && args?.bytes !== null ? { bytes: Number(args.bytes) } : {}),
        ...((ctx as any).runId ? { runId: (ctx as any).runId } : {}),
      });
      return j({ ok: true, tool: name, artifact: a, message: `Registered ${a.kind} "${a.label}" at ${a.uri}. Verify it durable (verify_durable ${a.id.slice(0, 8)}) before releasing the resource that produced it.` });
    }

    case 'verify_durable': {
      const ref = String(args?.id ?? '');
      const evidence = String(args?.evidence ?? '').trim();
      // Resolve FIRST so the machine gate can check the evidence against the
      // artifact's real uri (not whatever the caller typed).
      const row = await svc.resolveArtifact(userId, ref);
      if (!row) return refuse(name, 'not_found', `No training artifact "${ref}" — register_artifact first.`);
      if (!ctx.userTurnAt) {
        if (evidence.length < 8 || !evidenceNamesUri(evidence, row.uri)) {
          return refuse(
            name, 'evidence_required',
            `Machine-triggered durability stamps need evidence: quote the tool-output line that NAMES the uri (${String(row.uri).slice(0, 120)}) — an ls/stat/HEAD/s3-ls line observed THIS run. No matching output = the artifact stays unverified; report that honestly.`,
          );
        }
        const receipts = await currentRunReceipts(ctx);
        if (!receipts.some((r) => r?.ok)) {
          return refuse(
            name, 'no_receipt',
            'Machine-triggered durability stamps must follow a REAL check this run (a tool receipt must exist). Run the ls/HEAD/stat first, then call verify_durable with its output line as evidence.',
          );
        }
      }
      const a = await svc.verifyArtifactDurable(userId, row.id);
      return j({ ok: true, tool: name, artifact: a, message: `"${a.label}" verified durable at ${a.uri} (${a.durableVerifiedAt}).` });
    }

    case 'release_watched_resource': {
      // No machine-receipt gate (ticket a0a199f8): retiring a registration is
      // owner-scoped bookkeeping, and the cleanup lane that NEEDS this tool is
      // exactly the unattended one — gating it would re-create the ghost-alarm
      // class. Delete failures surface as ok:false via the outer catch.
      const ref = String(args?.id ?? '');
      const released = await svc.releaseWatchedResource(userId, ref, args?.reason !== undefined ? String(args.reason) : undefined);
      if (!released) {
        // 251e9329 contract: the refusal names what IS registered, so the lane
        // self-heals in ONE round instead of re-issuing blind calls.
        return refuse(name, 'not_found', await svc.noWatchedResourceMessage(userId, ref, 'release'));
      }
      return j({ ok: true, tool: name, resource: released, message: `Released "${released.label}" (${released.id}) — the watchdog will never alarm about it again.` });
    }

    default:
      return `Unknown resource tool: ${name}`;
  }
}
