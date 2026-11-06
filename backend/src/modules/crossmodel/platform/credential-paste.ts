/**
 * One-tap "vault this" for an owner's credential paste (feedback ticket
 * f95e1e30, part 2).
 *
 * THE GAP. An owner pastes a key — or a whole `credentials.json` (an
 * `access_token` + `refresh_token` pair) — into a chat and asks the fleet to
 * keep it. Today the ONLY path from that paste to the encrypted coding-credentials
 * vault is the agent calling `store_secret`. If the run never notices, the
 * credential sits in the transcript unvaulted and the owner has no button of his
 * own. The specimen chat (41bd202a, 05:29Z) is exactly this: the paste landed,
 * the run spent its turn budget, and the value stayed in the transcript.
 *
 * THE AFFORDANCE. A transcript action button on the OWNER's own message row that
 * vaults every credential-shaped value in that row in one click. The value is
 * lifted SERVER-SIDE from the persisted message row (the same bytes
 * `store_secret` lifts), never accepted from the client, never returned. Two
 * doors, one store: this file adds the second door only.
 *
 * ── DETECTION: derived at READ time, not stamped at persist time ───────────
 * The ticket brief proposed stamping `metadata.credentialPaste` when the owner's
 * message is persisted (option (a)). This implementation keeps the FLAG shape
 * and moves WHEN it is computed — the transcript DTO computes it per read
 * (`annotateCredentialPaste`) instead of a persist-time write. Why:
 *
 *   1. EIGHT scatter points vs THREE. A role:'user' row is persisted from the
 *      plain-chat SSE send (chat-agent.service.ts:3109-3117), its queued-drain
 *      twin (message-queue.service.ts:308-333), the coding run executor
 *      (run-executor.ts:843-880 via appendCodingMessage), the coding steer +
 *      parked-answer paths (coding-stream.controller.ts:860-925), the legacy
 *      history writer (context.service.ts:322-335), the anon→named migration
 *      (context.service.ts:754-765), an agent-relay ack (chat-agent.service.ts:1169)
 *      and the action-guard inject (chat-agent.service.ts:8551). Persist-time
 *      detection has to be threaded through all of them, or it silently
 *      no-ops on whichever one the owner happens to use. The read seams are
 *      three: getChatById's two branches (crossmodel.service.ts:721, :774) and
 *      the coding transcript map (coding.controller.ts:323).
 *   2. A persist-time stamp only ever helps FUTURE pastes. The owner's problem
 *      is the paste already in his transcript ("if I send you a key in the chat
 *      you need ability to store it permanently"). Read-time detection makes
 *      the button appear on rows that ALREADY EXIST — the reload-days-later
 *      requirement the brief asks for, without waiting for history to age in.
 *   3. Scanner improvements reach history for free. A row stamped by a scanner
 *      that did not yet know a provider shape stays unstamped forever; a
 *      read-time derivation picks up the new pattern on the next load (the same
 *      reproducibility property secret-scan's own `scannerStamp` exists for).
 *   4. MEASURED COST (this container, 2026-11-06): one `findSecretSpans` is
 *      0.024 ms on a 148-char credential paste, 0.12 ms on 1.6 KB of prose and
 *      5.7 ms on 96 KB. A typical 50-row transcript page costs 3.6 ms total;
 *      a heavy page of 4 KB rows costs 11.3 ms. Pages with no credential-shaped
 *      text still pay the scan (that is the 3.6 ms), so the derivation is
 *      bounded to USER rows of a chat the caller OWNS and skips machine-authored
 *      rows entirely.
 *
 * Client-side paste sniffing (option (b)) was rejected: it is lost on reload,
 * cannot cover a paste made from a phone or another tab, and would put the
 * decision "is this a credential" in a surface the server never validates.
 *
 * ── WHAT THE FLAG MAY CARRY ────────────────────────────────────────────────
 * Count + pattern NAMES only. Never a value, never a length, never a prefix —
 * the pattern name is what the scanner already implies by matching, so the flag
 * narrows nothing an attacker could not derive from the row itself, while the
 * row's content stays exactly as the owner typed it (the owner's own transcript
 * renders his paste verbatim by design; read-side redaction gates agent tool
 * output, not the owner's view — secret-scan.ts:1147 redactChatReadSecrets).
 *
 * ── THE STORE LEG ──────────────────────────────────────────────────────────
 * `executeSecretHandoffTool` (secret-handoff-tools.ts) is used as a BLACK BOX:
 * its `store_secret` handler already owns the whole sanctioned lift — owner-row
 * validation, named-assignment and scanner extraction, infra-managed-key guard,
 * slot-mismatch refusal, PEM validation, encryption via upsertCredential, the
 * `coding_credential.store` audit row and the loop metric. This module never
 * re-implements any of that. It supplies what the tool's model caller normally
 * supplies (an envKey and a `which` pick), reads the tool's JSON answer, and
 * reports every key stored plus every value NOT stored — no silent partial
 * vault.
 *
 * ORDER, so this file works BEFORE and AFTER the multi-value PR (#2609, which
 * teaches the tool to vault a whole credential-file paste in one call):
 *   1. ONE call with no `which`. On #2609 the tool plans and stores every
 *      labelled slot itself and names them; today it answers `ambiguous` and
 *      stores nothing. Either way the result is read, not assumed.
 *   2. For anything still missing, one call per span with `which: n` under a
 *      key derived from that span's own label. `planPasteStore` below is that
 *      derivation — the same label→slot reading #2609 uses, kept on this side
 *      of the boundary so no new export is needed from a file another lane is
 *      rewriting.
 */
import { findSecretSpans } from './secret-scan';
import { DENIED_ENV_KEYS } from '../coding/credentials.service';
import {
  executeSecretHandoffTool,
  storeSecretDisabled,
  SECRET_HANDOFF_TOOL_NAMES,
  handoffSpans,
  planMultiValueStore,
  reservedKeyFamily,
} from './secret-handoff-tools';

// ── The flag ────────────────────────────────────────────────────────────────

/** What a transcript reader learns about a row: how many credential-shaped
 *  values it holds, which scanner patterns matched (names only — never a value
 *  or a length), and — once this door has stored them — the env keys. */
export interface CredentialPasteFlag {
  count: number;
  patterns: string[];
  /** Set by the vault route after a store: the env keys now held. */
  vaulted?: string[];
  /** Env keys the vault TRIED and could not store (a partial vault). Its
   *  presence keeps the button LIVE so the owner can retry the remainder —
   *  review finding #4: a half-vaulted row must not become a dead end where the
   *  only remaining path is an agent. Empty/absent means "nothing pending". */
  notStored?: string[];
}

/** metadata.origin values that mark a MACHINE-authored row (mirrors
 *  secret-handoff-tools MACHINE_ROW_ORIGINS — a row a machine wrote is never
 *  the owner's paste, so it never gets a button). */
const MACHINE_ROW_ORIGINS = new Set(['schedule', 'hook', 'agent', 'machine', 'webhook']);
/** Machine chrome riding inside a user row's content (queue-time firing
 *  headers, harness notices) — same predicate the store leg applies. */
const MACHINE_CONTENT_PREFIX_RE = /^\s*\[(MACHINE-TRIGGERED RUN|HARNESS|SCHEDULED|HOOK)/i;

/** True when this row is the OWNER's own words — the only rows that may carry
 *  the flag (and, at the route, the only rows the vault will lift from). */
export function isOwnerTypedRow(row: { role?: string | null; content?: string | null; metadata?: unknown }): boolean {
  if (row.role !== 'user') return false;
  const meta = row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
    ? (row.metadata as Record<string, unknown>)
    : null;
  const origin = meta?.origin ?? meta?.triggerKind ?? null;
  if (typeof origin === 'string' && MACHINE_ROW_ORIGINS.has(origin)) return false;
  return !MACHINE_CONTENT_PREFIX_RE.test(String(row.content ?? ''));
}

/**
 * The credential-paste flag for one message body, or null. PURE.
 *
 * Null covers both "no credential-shaped value" and "not something to offer a
 * button for": a message whose only match is a bare marker (a private-key
 * HEADER with no block) is still flagged, because the vault's own refusal path
 * names that case honestly rather than the UI guessing.
 */
export function credentialPasteFlag(text: string): CredentialPasteFlag | null {
  const src = String(text ?? '');
  if (!src.trim()) return null;
  let spans: Array<{ name: string }>;
  try {
    spans = findSecretSpans(src);
  } catch {
    return null; // a scan failure never breaks a transcript read
  }
  if (!spans.length) return null;
  const patterns: string[] = [];
  for (const s of spans) if (s?.name && !patterns.includes(s.name)) patterns.push(s.name);
  return { count: spans.length, patterns };
}

/**
 * Merge the derived flag into a row's metadata for the transcript DTO. PURE and
 * additive: returns the ORIGINAL metadata object untouched when there is
 * nothing to say (no copy, no cost) so a clean page serialises byte-identically.
 *
 * `vaultedEnvKeys` comes from a previous store (metadata.credentialPaste.vaulted
 * persisted by the route) — a row already vaulted keeps its flag so the client
 * can say "stored as $X" instead of offering the button again.
 */
export function annotateCredentialPaste(
  row: { role?: string | null; content?: string | null; metadata?: unknown },
  opts: { ownerViewer: boolean },
): unknown {
  const meta = row.metadata;
  // A persisted vaulted stamp is authoritative and costs no scan: the route
  // already proved what this row holds.
  const persisted = meta && typeof meta === 'object' && !Array.isArray(meta)
    ? (meta as Record<string, unknown>).credentialPaste
    : null;
  const alreadyVaulted = persisted && typeof persisted === 'object'
    ? (persisted as CredentialPasteFlag).vaulted
    : null;
  if (Array.isArray(alreadyVaulted) && alreadyVaulted.length) {
    // A persisted vaulted stamp is authoritative and costs no scan — the route
    // already proved what this row holds. It flows through unchanged, which is
    // also what keeps a PARTIAL vault honest (review finding #4): the stamp
    // carries `notStored`, and the client renders a live retry control when it
    // is non-empty. A COMPLETE vault carries no `notStored`, so the same stamp
    // renders as a terminal "stored as $X" note with no control.
    return meta;
  }
  if (!opts.ownerViewer) return meta;
  if (!isOwnerTypedRow(row)) return meta;
  const flag = credentialPasteFlag(String(row.content ?? ''));
  if (!flag) return meta;
  return { ...(meta && typeof meta === 'object' && !Array.isArray(meta) ? meta : {}), credentialPaste: flag };
}

// ── Key derivation: the store leg's plan, NOT a second copy of it ───────────
//
// Ticket f95e1e30 review finding #1. This file used to derive env keys with its
// own field table and its own `pasteEnvKey`, which DIVERGED from the sibling
// multi-value PR's `multiVaultEnvKey`. The divergence was not cosmetic: the
// sibling's review recorded the rule that the CALLER'S envKey owns the
// NAMESPACE and a slot label may only name the SLOT ("Never derive a key the
// caller did not name" — a label already ending in `_<field>` must not become
// the key outright, or a `PROD_API_KEY: …` paste silently REPLACES a live
// credential under a name nobody chose). My copy did exactly that, and it also
// skipped `reservedKeyFamily`, so `?envKey=GITHUB` + an `access_token` field
// could mint `GITHUB_ACCESS_TOKEN` — the exact hole the sibling closed.
//
// The fix is to STOP deriving: `planMultiValueStore` / `handoffSpans` /
// `reservedKeyFamily` are exported by the store leg, so the plan and the store
// can no longer disagree. This module now reads the plan and calls the store;
// it never computes a key of its own.

/** The fallback namespace when the owner gives none. The response always names
 *  the exact keys this produces (`$OWNER_ACCESS_TOKEN`), so nothing is silent —
 *  but an owner who pastes Brev's file and expects `BREV_*` should read the
 *  result line, which says what actually landed. */
export const DEFAULT_PASTE_BASE = 'OWNER';

export interface PastePlanItem { n: number; pattern: string; envKey: string; field: string }

/**
 * The env keys this paste will land under — the SAME plan the store leg will
 * execute, read from it rather than re-derived. PURE (no DB).
 *
 * `all: true` asks the store leg for its "vault everything" plan: every value
 * gets a key, unnamed ones as `<PREFIX>_<n>`. That is what makes two unlabelled
 * values impossible to collapse onto one key (review finding #2) — the plan
 * refuses a plan with duplicate keys, and ordinals are distinct by definition.
 */
export function planPasteStore(text: string, base: string = DEFAULT_PASTE_BASE): PastePlanItem[] {
  const src = String(text ?? '');
  let spans: ReturnType<typeof handoffSpans>;
  try { spans = handoffSpans(src); } catch { return []; }
  if (!spans.length) return [];
  let planned: ReturnType<typeof planMultiValueStore>;
  try { planned = planMultiValueStore(src, base, { all: true, spans }); } catch { return []; }
  if (!('plan' in planned)) return [];
  return planned.plan.map((p) => ({ n: p.n, pattern: p.pattern, envKey: p.envKey, field: p.field }));
}

/**
 * Does this paste vault in ONE call without asking which value the owner meant?
 * True when every value names its own distinct slot — the store leg's own
 * automatic multi-value door. Otherwise the route asks the store leg for its
 * `all: true` plan, which keys every value explicitly.
 */
export function pasteNeedsExplicitAll(text: string, base: string = DEFAULT_PASTE_BASE): boolean {
  const src = String(text ?? '');
  let spans: ReturnType<typeof handoffSpans>;
  try { spans = handoffSpans(src); } catch { return true; }
  if (spans.length < 2) return false;
  try {
    return !('plan' in planMultiValueStore(src, base, { spans }));
  } catch { return true; }
}

// ── The store leg ───────────────────────────────────────────────────────────

export interface PasteVaultStored { n: number; envKey: string; injectedKey: string; pattern: string; replaced: boolean }
export interface PasteVaultNotStored { n: number; pattern: string; envKey: string; reason: string }
export type PasteVaultResult =
  | { ok: false; reason: 'disabled' | 'no_secret_found' | 'ambiguous' | 'store_failed'; message: string }
  | { ok: true; stored: PasteVaultStored[]; notStored: PasteVaultNotStored[]; message: string };

/** Read one `store_secret` JSON answer. Never throws: an unparsable answer is
 *  treated as a refusal so a malformed result can never read as "stored". */
function readStoreAnswer(raw: string): any {
  try { return JSON.parse(String(raw ?? '')); } catch { return { ok: false, reason: 'store_failed', message: 'unreadable store result' }; }
}

/** What one `store_secret` answer stored, as (envKey, injectedKey, pattern). */
function storedFrom(answer: any, fallbackN: number, fallbackKey: string): PasteVaultStored | null {
  if (!answer || answer.ok !== true) return null;
  const injectedKey = typeof answer.injectedKey === 'string' && answer.injectedKey
    ? answer.injectedKey
    : String(answer.envKey ?? fallbackKey);
  return {
    n: fallbackN,
    envKey: String(answer.envKey ?? fallbackKey),
    injectedKey,
    pattern: String(answer.pattern ?? ''),
    replaced: answer.replaced === true,
  };
}

/**
 * Vault EVERY credential-shaped value of one owner message (feedback ticket
 * f95e1e30 part 2). The caller has already resolved the row and proven the
 * caller OWNS the chat — this function neither re-reads auth nor accepts a
 * value: `messageText` must be the PERSISTED row's content, read server-side.
 *
 * Never returns a value: the response is env keys, patterns and refusals.
 *
 * ONE call normally does the whole paste, through the store leg's own
 * multi-value door. The env keys come from `planMultiValueStore` — the same
 * function the store executes — so the plan reported to the owner and the plan
 * that runs can never disagree (review finding #1), and two values can never
 * collapse onto one key (finding #2: the plan REFUSES duplicate keys, and the
 * explicit `all` plan keys unnamed values by ordinal, which is distinct by
 * construction).
 */
export async function vaultPastedCredential(
  ctx: { userId: string; chatId: string },
  args: { messageId: string; messageText: string; baseEnvKey?: string },
): Promise<PasteVaultResult> {
  if (storeSecretDisabled()) {
    return {
      ok: false,
      reason: 'disabled',
      message: 'The one-tap vault is switched off on this instance (STORE_SECRET_TOOL_DISABLED=1). The credential is unchanged in the transcript — add it under Account → Coding → Credentials, or ask a lane to run store_secret.',
    };
  }
  const base = String(args.baseEnvKey ?? '').trim().toUpperCase().replace(/[^A-Z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || DEFAULT_PASTE_BASE;
  const plan = planPasteStore(args.messageText, base);
  if (!plan.length) {
    return {
      ok: false,
      reason: 'no_secret_found',
      message: 'Nothing in that message matches a credential shape this instance knows, so there is nothing to vault and nothing was stored. If the value is real, tell a lane to store it (store_secret) or add it under Account → Coding → Credentials.',
    };
  }

  // A store leg the vault itself must accept: the message row is owner-typed
  // and owned by this user (both re-proven inside the tool from fromMessageId).
  const toolCtx = { sessionId: ctx.chatId, userId: ctx.userId, userTurnAt: new Date(), machineTriggered: false } as any;
  const call = (envKey: string, extra: Record<string, unknown> = {}) => executeSecretHandoffTool(
    toolCtx, SECRET_HANDOFF_TOOL_NAMES[0], { envKey, fromMessageId: args.messageId, ...extra },
  );

  const stored: PasteVaultStored[] = [];
  const notStored: PasteVaultNotStored[] = [];

  // Review finding #1 (the guard my copy skipped): a DERIVED name must clear the
  // same reserved-family check the store leg applies to its own derived names.
  // `DENIED_ENV_KEYS` lists bare `GITHUB_TOKEN`, so `?envKey=GITHUB` plus an
  // `access_token` field would otherwise mint `GITHUB_ACCESS_TOKEN` — a
  // third-party OAuth token landing in every lane's shell under a
  // platform-looking name. Refused HERE, before any store call, and reported so
  // the owner is told which value needs an explicit name.
  const vaultable = plan.filter((item) => {
    const reserved = reservedKeyFamily(item.envKey, DENIED_ENV_KEYS);
    if (!reserved) return true;
    notStored.push({
      n: item.n,
      pattern: item.pattern,
      envKey: item.envKey,
      reason: `${item.envKey} is a reserved platform name (family of ${reserved}) — pick another name under Account → Coding → Credentials`,
    });
    return false;
  });
  if (!vaultable.length) {
    return {
      ok: false,
      reason: 'store_failed',
      message: buildVaultMessage([], notStored),
    };
  }

  /** Fold one `store_secret` answer into stored/notStored, matching the answer's
   *  keys back to the plan so the ORDINAL the owner sees is the plan's. */
  const fold = (answer: any) => {
    if (!answer) return;
    if (answer.ok === true) {
      const rows = Array.isArray(answer.stored) && answer.stored.length
        ? answer.stored
        : [{ envKey: answer.envKey, injectedKey: answer.injectedKey, replaced: answer.replaced }];
      for (const s of rows) {
        const envKey = String(s?.envKey ?? '');
        if (!envKey || stored.some((x) => x.envKey === envKey)) continue;
        const planned = plan.find((p) => p.envKey === envKey);
        stored.push({
          n: planned?.n ?? stored.length + 1,
          envKey,
          injectedKey: String(s?.injectedKey ?? envKey),
          pattern: planned?.pattern ?? String(answer.pattern ?? ''),
          replaced: s?.replaced === true,
        });
      }
    }
    for (const u of (Array.isArray(answer.unstored) ? answer.unstored : [])) {
      const n = Number(u?.n) || 0;
      const planned = plan.find((p) => p.n === n);
      const envKey = planned?.envKey ?? '';
      if (envKey && (stored.some((x) => x.envKey === envKey) || notStored.some((x) => x.envKey === envKey))) continue;
      notStored.push({ n, pattern: String(u?.pattern ?? planned?.pattern ?? ''), envKey, reason: String(u?.reason ?? 'not stored') });
    }
  };

  // 1. ONE call for the whole paste.
  //    · a single value is stored under ITS OWN slot key (the plan's);
  //    · several values that each name a distinct slot take the store leg's
  //      automatic multi-value door;
  //    · several values that do NOT (two bare tokens, prose) take the explicit
  //      `all: true` door, which keys each by ordinal so none can be skipped.
  const multi = plan.length > 1;
  const explicitAll = multi && pasteNeedsExplicitAll(args.messageText, base);
  const first = readStoreAnswer(
    multi
      ? await call(base, explicitAll ? { all: true } : {})
      : await call(plan[0].envKey, { which: plan[0].n }),
  );
  fold(first);

  // 2. Every planned value the answer never accounted for is RETRIED on its own
  //    with an explicit envKey + which — the recovery the store leg's own
  //    refusal text names. Anything still unstored after that is NAMED below;
  //    nothing is ever silently dropped.
  for (const item of plan) {
    if (stored.some((s) => s.envKey === item.envKey)) continue;
    if (notStored.some((u) => u.n === item.n)) continue;
    const retry = readStoreAnswer(await call(item.envKey, { which: item.n }));
    fold(retry);
    if (!stored.some((s) => s.envKey === item.envKey) && !notStored.some((u) => u.n === item.n)) {
      notStored.push({ n: item.n, pattern: item.pattern, envKey: item.envKey, reason: String(retry?.reason ?? 'store_failed') });
    }
  }
  // Belt: a value the plan expected and the store never mentioned at all.
  for (const item of plan) {
    if (stored.some((s) => s.envKey === item.envKey)) continue;
    if (notStored.some((u) => u.n === item.n)) continue;
    notStored.push({ n: item.n, pattern: item.pattern, envKey: item.envKey, reason: 'store_failed' });
  }

  if (!stored.length) {
    const reason = (first?.reason === 'disabled' ? 'disabled' : first?.reason === 'no_secret_found' ? 'no_secret_found' : 'store_failed') as 'disabled' | 'no_secret_found' | 'store_failed';
    return {
      ok: false,
      reason,
      message: String(first?.message ?? 'The vault did not store any value from that message. Nothing was changed — the credential is still in the transcript, and you can add it under Account → Coding → Credentials.'),
    };
  }

  return { ok: true, stored, notStored, message: buildVaultMessage(stored, notStored) };
}

/** The owner-facing one-liner: every key stored, then every value NOT stored.
 *  Never names a value. Exported for the tests to pin the wording. */
export function buildVaultMessage(stored: PasteVaultStored[], notStored: PasteVaultNotStored[]): string {
  const names = stored.map((s) => `$${s.injectedKey}`);
  const replaced = stored.filter((s) => s.replaced).map((s) => `$${s.injectedKey}`);
  const head = stored.length === 1
    ? `Stored ${names[0]} in the encrypted coding-credentials vault — every coding session shell of this account has it from its next command.`
    : `Stored ${stored.length} credentials in the encrypted coding-credentials vault: ${names.join(', ')} — every coding session shell of this account has them from its next command.`;
  const tail = replaced.length
    ? ` ${replaced.join(', ')} REPLACED the previous value stored under that name.`
    : '';
  const warn = notStored.length
    ? ` NOT stored: ${notStored.map((n) => `${n.pattern || 'value'}${n.envKey ? ` (→ $${n.envKey})` : ''} — ${n.reason}`).join('; ')}.`
    : '';
  return `${head}${tail}${warn}`;
}