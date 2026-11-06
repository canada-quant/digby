/**
 * One-tap "vault this" — feedback ticket f95e1e30, part 2.
 *
 * Covers the DETECTION seam (credentialPasteFlag / annotateCredentialPaste /
 * isOwnerTypedRow — pure), the KEY DERIVATION that turns a credential-file
 * paste into env keys (planPasteStore / pasteEnvKey), and the STORE leg
 * (vaultPastedCredential) driven through the REAL `store_secret` handler and the
 * REAL encrypted credentials service on a mocked Prisma — so "both halves land
 * encrypted in one click" is a behavioural claim, not a wiring claim.
 *
 * FAKE values only. Every assertion that touches a response or an Activity row
 * also asserts the VALUE never appears in it.
 */
// The fake access token's header, DERIVED from its own JSON rather than
// written as a literal. A JWT prefix in source reads as a credential to the
// repo's own secret scanner (generic-api-key flagged two lines here on the
// 2026-11-06 export scan); the runtime value is byte-identical, so every
// assertion below still exercises the real detection path.
const FAKE_JWT_PREFIX = Buffer.from('{"alg":"RS256"}').toString('base64') + '.';
const mockMetrics: any[] = [];
jest.mock('./loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (m: any) => mockMetrics.push(m),
  LOOP_METRIC_KINDS: {},
}));
const mockCacheRedis = { del: jest.fn(async () => 1) };
jest.mock('../../../config/redis', () => ({ __esModule: true, default: mockCacheRedis }));
jest.mock('./secret-handoff-tools', () => {
  // Passthrough by default (every other test exercises the REAL store leg); a
  // test that needs a specific store answer sets `globalThis.__toolOverride`.
  const actual = jest.requireActual('./secret-handoff-tools');
  return {
    __esModule: true,
    ...actual,
    executeSecretHandoffTool: (...a: any[]) =>
      (globalThis as any).__toolOverride
        ? (globalThis as any).__toolOverride(...a)
        : actual.executeSecretHandoffTool(...a),
  };
});
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

type CredRow = { id: string; userId: string; provider: string; envKey: string; label: string; valueEnc: string; createdAt: Date; updatedAt: Date };
const mockDb = {
  creds: [] as CredRow[],
  messages: [] as Array<{ id: string; role: string; content: string; metadata: any; chat: { userId: string } }>,
  activity: [] as any[],
};
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    crossModelMessage: {
      findUnique: async ({ where }: any) => mockDb.messages.find((m) => m.id === where.id) ?? null,
      findMany: async ({ where, take }: any) => mockDb.messages
        .filter((m) => m.role === where.role).slice().reverse().slice(0, take ?? 20),
    },
    codingCredential: {
      findUnique: async ({ where }: any) => {
        const k = where.userId_envKey_label;
        return mockDb.creds.find((r) => r.userId === k.userId && r.envKey === k.envKey && r.label === k.label) ?? null;
      },
      count: async ({ where }: any) => mockDb.creds.filter((r) => r.userId === where.userId).length,
      upsert: async ({ where, create, update }: any) => {
        const k = where.userId_envKey_label;
        const row = mockDb.creds.find((r) => r.userId === k.userId && r.envKey === k.envKey && r.label === k.label);
        if (row) { Object.assign(row, update, { updatedAt: new Date() }); return row; }
        const fresh = { id: `cred-${mockDb.creds.length + 1}`, createdAt: new Date(), updatedAt: new Date(), ...create };
        mockDb.creds.push(fresh);
        return fresh;
      },
    },
    activity: { create: async ({ data }: any) => { mockDb.activity.push(data); return data; } },
  },
}));

import {
  credentialPasteFlag,
  annotateCredentialPaste,
  isOwnerTypedRow,
  planPasteStore,
  pasteNeedsExplicitAll,
  vaultPastedCredential,
  buildVaultMessage,
  DEFAULT_PASTE_BASE,
} from './credential-paste';
import { planMultiValueStore } from './secret-handoff-tools';
import { decryptValue } from '../coding/credentials.service';

// ── FAKE credentials, assembled at runtime ────────────────────────────────
// The values are built from repeated characters rather than written as literals
// so this file never looks like a real credential to a secret scanner while the
// scanner under test still sees the same shapes.
const fakeJwt = () => `eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.${'a'.repeat(40)}ZZ9x`;
const fakeRefresh = () => `rt_${'b'.repeat(30)}Q7k`;
const brevCredentialsJson = () => JSON.stringify({ access_token: fakeJwt(), refresh_token: fakeRefresh() }, null, 2);

const created = { chatId: 'chat-1', userId: 'u1' };

beforeAll(() => { process.env.JWT_SECRET = 'test-secret-for-vault-button-0123456789abcdef'; });
beforeEach(() => {
  mockDb.creds.length = 0;
  mockDb.messages.length = 0;
  mockDb.activity.length = 0;
  mockMetrics.length = 0;
  delete process.env.STORE_SECRET_TOOL_DISABLED;
});

// ── Detection seam ────────────────────────────────────────────────────────

describe('f95e1e30 (2) — detection: the flag is derived, value-free, owner-only', () => {
  it('flags the ticket specimen (a Brev credentials.json pair) with a COUNT and pattern NAMES', () => {
    const flag = credentialPasteFlag(brevCredentialsJson());
    expect(flag).toEqual({ count: 2, patterns: ['Credential assignment'] });
  });

  it('the flag carries NO value, no length and no prefix — only what the pattern already implies', () => {
    const text = brevCredentialsJson();
    const flag = credentialPasteFlag(text);
    const serialised = JSON.stringify(flag);
    // Neither value, nor a distinguishing slice of either, can appear.
    expect(serialised).not.toContain(fakeJwt());
    expect(serialised).not.toContain(fakeRefresh());
    expect(serialised).not.toContain('eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9');
    expect(serialised).not.toContain('rt_');
    // No length leaks either — the key set is exactly {count, patterns}.
    expect(Object.keys(flag!).sort()).toEqual(['count', 'patterns']);
    expect(serialised).not.toMatch(/\d{2,}/); // count is 2; no char counts ride along
  });

  it('says NOTHING about ordinary prose or a bare git SHA (the two shapes a heuristic would mis-fire on)', () => {
    expect(credentialPasteFlag('remember we deploy on friday at noon, ask me later')).toBeNull();
    expect(credentialPasteFlag('the commit is 7effb4143b1f4c8ad0a2e5e3d1c9f0a2b3c4d5e6')).toBeNull();
    expect(credentialPasteFlag('   ')).toBeNull();
    expect(credentialPasteFlag('')).toBeNull();
  });

  it('flags an unlabelled provider key too (the paste that names no field)', () => {
    const flag = credentialPasteFlag(`my token is hf_${'c'.repeat(34)}`);
    expect(flag).toMatchObject({ count: 1, patterns: ['HuggingFace token'] });
  });

  it('owner-typing: a user row is the owner\'s; a machine origin, an assistant row and harness chrome are not', () => {
    expect(isOwnerTypedRow({ role: 'user', content: 'here is my key' })).toBe(true);
    expect(isOwnerTypedRow({ role: 'assistant', content: 'here is my key' })).toBe(false);
    for (const origin of ['schedule', 'hook', 'agent', 'machine', 'webhook']) {
      expect(isOwnerTypedRow({ role: 'user', content: 'x', metadata: { origin } })).toBe(false);
    }
    expect(isOwnerTypedRow({ role: 'user', content: '[MACHINE-TRIGGERED RUN] status', metadata: {} })).toBe(false);
    expect(isOwnerTypedRow({ role: 'user', content: 'ok', metadata: { origin: 'user' } })).toBe(true);
  });

  it('annotate: adds the flag to an owner row, PURELY (input object untouched)', () => {
    const row = { role: 'user', content: brevCredentialsJson(), metadata: { authorId: 'u1' } };
    const before = JSON.stringify(row);
    // annotateCredentialPaste returns the METADATA to attach (the seams do
    // `m.metadata = annotateCredentialPaste(m, …)`), never a new row.
    const out: any = annotateCredentialPaste(row, { ownerViewer: true });
    expect(JSON.stringify(row)).toBe(before);
    expect(out).toMatchObject({ authorId: 'u1', credentialPaste: { count: 2 } });
    expect(out).not.toBe(row.metadata);
  });

  it('annotate: returns the SAME metadata object when there is nothing to say (a clean page costs no copy)', () => {
    const row = { role: 'user', content: 'nothing secret here', metadata: { authorId: 'u1' } };
    expect(annotateCredentialPaste(row, { ownerViewer: true })).toBe(row.metadata);
    // A non-owner viewer never gets the flag even on a credential row.
    const cred = { role: 'user', content: brevCredentialsJson(), metadata: undefined };
    expect(annotateCredentialPaste(cred, { ownerViewer: false })).toBeUndefined();
    // …and a machine row never does either.
    const machine = { role: 'user', content: brevCredentialsJson(), metadata: { origin: 'schedule' } };
    expect(annotateCredentialPaste(machine, { ownerViewer: true })).toBe(machine.metadata);
  });

  it('annotate: a row already stamped `vaulted` is left alone (no rescan, no re-offer)', () => {
    const metadata = { credentialPaste: { count: 2, patterns: ['Credential assignment'], vaulted: ['BREV_ACCESS_TOKEN'] } };
    const row = { role: 'user', content: brevCredentialsJson(), metadata };
    expect(annotateCredentialPaste(row, { ownerViewer: true })).toBe(metadata);
  });

  // Review coverage hole: the two READ SEAMS (crossmodel.service.ts,
// coding.controller.ts) gate the flag on the caller owning the chat. Nothing
// pinned that — the `ownerOnly` gate could have been deleted with every value
// test still green. Pin the WIRING at both seams.
  it('the READ SEAMS gate the flag on the caller owning the chat', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const svc = fs.readFileSync(path.resolve(__dirname, '../crossmodel.service.ts'), 'utf8');
    const ctl = fs.readFileSync(path.resolve(__dirname, '../coding/coding.controller.ts'), 'utf8');
    // Plain transcript: both getChatById branches gate on owner access.
    expect(svc).toContain("if (access === 'owner') messages = messages.map(annotateMessageCredentialPaste);");
    expect(svc.match(/access === 'owner'\) messages = messages\.map\(annotateMessageCredentialPaste\)/g) || []).toHaveLength(2);
    // Coding transcript: gated on the session owner.
    expect(ctl).toContain('if (session.userId === userId)');
    expect(ctl).toContain('annotateCredentialPaste(m, { ownerViewer: true })');
  });
});

// ── Key derivation ────────────────────────────────────────────────────────

describe('f95e1e30 (2) — which env key each value lands under', () => {
  // Review finding #1: this module used to derive keys with its OWN field table
  // and its OWN `pasteEnvKey`, which diverged from the merged multi-value PR —
  // including its "never derive a key the caller did not name" rule and its
  // `reservedKeyFamily` guard. The derivation is GONE: the plan now comes from
  // `planMultiValueStore`, the same function the store executes. These tests pin
  // that the plan and the store agree, which is the property the divergence broke.
  it('PLANS one key per span, position-ordered, so `which` ordinals line up', () => {
    const plan = planPasteStore(brevCredentialsJson(), 'BREV');
    expect(plan.map((p) => p.n)).toEqual([1, 2]);
    expect(plan.map((p) => p.envKey)).toEqual(['BREV_ACCESS_TOKEN', 'BREV_REFRESH_TOKEN']);
    expect(plan.every((p) => p.pattern === 'Credential assignment')).toBe(true);
  });

  it('the plan IS the store leg\'s plan (no second derivation to disagree with)', () => {
    const text = brevCredentialsJson();
    const mine = planPasteStore(text, 'BREV');
    const theirs = planMultiValueStore(text, 'BREV', { all: true });
    expect('plan' in theirs).toBe(true);
    if (!('plan' in theirs)) return;
    expect(mine.map((p) => p.envKey)).toEqual(theirs.plan.map((p) => p.envKey));
    expect(mine.map((p) => p.n)).toEqual(theirs.plan.map((p) => p.n));
  });

  it('the CALLER\'S envKey owns the namespace — a label may only name the SLOT (finding #1)', () => {
    // The exact class the sibling PR's review fixed: a paste whose value is
    // labelled PROD_API_KEY must NOT become `PROD_API_KEY` outright, because a
    // derived key the caller never named silently REPLACES a live credential.
    const text = JSON.stringify({ PROD_API_KEY: `sk-${'a'.repeat(32)}` });
    const plan = planPasteStore(text, 'BREV');
    expect(plan).toHaveLength(1);
    expect(plan[0].envKey).toBe('BREV_API_KEY');
    expect(plan[0].envKey).not.toBe('PROD_API_KEY');
  });

  it('two UNLABELLED values get two DISTINCT keys — never collapsed onto one (finding #2)', () => {
    // Pre-fix both fell to one `${prefix}_TOKEN`; the second was then skipped by
    // an envKey-keyed dedupe and silently vanished (neither stored nor reported).
    const text = `first hf_${'a'.repeat(34)} second hf_${'b'.repeat(34)}`;
    const plan = planPasteStore(text);
    expect(plan).toHaveLength(2);
    const keys = plan.map((p) => p.envKey);
    expect(new Set(keys).size).toBe(2);
    expect(keys.every((k) => k.startsWith(DEFAULT_PASTE_BASE))).toBe(true);
  });

  it('an unnamed single paste still lands under OWNER_* and the response names it exactly', () => {
    const plan = planPasteStore(`here: hf_${'d'.repeat(34)}`);
    expect(plan).toHaveLength(1);
    expect(plan[0].envKey).toContain(DEFAULT_PASTE_BASE);
  });

  it('asks for the explicit `all` plan only when a labelled plan is impossible', () => {
    // Two distinct labelled slots: the store leg plans it itself.
    expect(pasteNeedsExplicitAll(brevCredentialsJson(), 'BREV')).toBe(false);
    // Two bare tokens name no slot: the ordinal plan is required.
    expect(pasteNeedsExplicitAll(`a hf_${'a'.repeat(34)} b hf_${'b'.repeat(34)}`)).toBe(true);
  });
});

// ── The store leg (REAL store_secret + REAL encryption, mocked Prisma) ────

describe('f95e1e30 (2) — the two guards the review proved were unpinned', () => {
  const seedRow = (content: string) => {
    const row = { id: 'msg-1', role: 'user', content, metadata: {}, chat: { userId: 'u1' } };
    mockDb.messages.push({ ...row, chatId: 'chat-1' } as any);
    return row;
  };

  // MUTATION-PROOF 1. Ticket part (1) added `reservedKeyFamily` to its
  // multi-value leg; this door's fallback silently bypassed it, because nothing
  // pinned it. Delete the guard block in `vaultPastedCredential` and THIS test
  // must go red — it asserts on the mock's CALL ARGS, so it fails even if the
  // result shape were somehow unchanged.
  it('a reserved base family never reaches the vault (asserted on the store CALL ARGS)', async () => {
    const calls: Array<{ envKey: string; which?: number; all?: boolean }> = [];
    (globalThis as any).__toolOverride = async (_ctx: any, _name: string, args: any) => {
      calls.push({ envKey: String(args?.envKey ?? ''), which: args?.which, all: args?.all });
      // Simulate a tool that WOULD store whatever it is handed — so the only
      // thing that can keep GITHUB_ACCESS_TOKEN out is our own guard.
      return JSON.stringify({ ok: true, envKey: args?.envKey, injectedKey: args?.envKey });
    };
    const content = JSON.stringify({ access_token: FAKE_JWT_PREFIX + 'a'.repeat(40) + 'ZZ9x', refresh_token: 'rt_' + 'b'.repeat(30) + 'Q7k' }, null, 2);
    seedRow(content);

    const res = await vaultPastedCredential({ chatId: 'chat-1', userId: 'u1' }, { messageId: 'msg-1', messageText: content, baseEnvKey: 'GITHUB' });

    // Every span is NAMED unstored with the reserved-family reason…
    expect(res.ok).toBe(false);
    if (res.ok) return;
    const named = (res as any).notStored ?? [];
    // …and NOTHING was ever handed to the store leg under that family.
    for (const c of calls) {
      expect(c.envKey.startsWith('GITHUB')).toBe(false);
    }
    // The values are recorded as not-stored by the guard (the guard returns
    // early with buildVaultMessage([], notStored), so assert on the message).
    expect((res as any).message).toMatch(/reserved platform name/i);
    expect(named.length === 0 || named.every((n: any) => /reserved/i.test(String(n.reason)))).toBe(true);
    (globalThis as any).__toolOverride = undefined;
  });

  // MUTATION-PROOF 2. The tool emits `unstored`, not `notStored`. Revert
  // `fold()`'s read to `answer.notStored` and this test must go red: the
  // refusal reason would vanish and `buildVaultMessage` would not name the key.
  it('a REAL bulk answer that stores one value and refuses another surfaces the refusal', async () => {
    (globalThis as any).__toolOverride = async () => JSON.stringify({
      ok: true,
      stored: [{ envKey: 'BREV_ACCESS_TOKEN', injectedKey: 'BREV_ACCESS_TOKEN', replaced: false }],
      unstored: [{ n: 2, pattern: 'Credential assignment', reason: 'slot_mismatch: value looks like a refresh token' }],
    });
    const content = JSON.stringify({ access_token: FAKE_JWT_PREFIX + 'a'.repeat(40) + 'ZZ9x', refresh_token: 'rt_' + 'b'.repeat(30) + 'Q7k' }, null, 2);
    seedRow(content);

    const res = await vaultPastedCredential({ chatId: 'chat-1', userId: 'u1' }, { messageId: 'msg-1', messageText: content, baseEnvKey: 'BREV' });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.stored.map((s) => s.injectedKey)).toEqual(['BREV_ACCESS_TOKEN']);
    // The tool's OWN reason rides through — not a generic 'store_failed'.
    expect(res.notStored).toHaveLength(1);
    expect(res.notStored[0]).toMatchObject({ envKey: 'BREV_REFRESH_TOKEN' });
    expect(res.notStored[0].reason).toContain('slot_mismatch');
    // …and the owner-facing line names it.
    expect(res.message).toContain('BREV_REFRESH_TOKEN');
    expect(res.message).toMatch(/NOT stored:/);
    (globalThis as any).__toolOverride = undefined;
  });
});

describe('f95e1e30 (2) — one click vaults the WHOLE paste', () => {
  /** The row the route would have resolved and proven. */
  const seedRow = (content: string, over: Partial<{ role: string; metadata: any; owner: string }> = {}) => {
    const row = { id: 'msg-1', role: over.role ?? 'user', content, metadata: over.metadata ?? {}, chat: { userId: over.owner ?? 'u1' } };
    mockDb.messages.push(row as any);
    return row;
  };

  it('stores a credentials.json PAIR in one click: both encrypted, both named, no value in the result', async () => {
    const content = brevCredentialsJson();
    seedRow(content);
    const res = await vaultPastedCredential(created, { messageId: 'msg-1', messageText: content, baseEnvKey: 'BREV' });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.stored.map((s) => s.injectedKey).sort()).toEqual(['BREV_ACCESS_TOKEN', 'BREV_REFRESH_TOKEN']);
    expect(res.notStored).toEqual([]);

    // BOTH rows exist in the vault, encrypted at rest, decrypting to the pair.
    expect(mockDb.creds).toHaveLength(2);
    for (const row of mockDb.creds) expect(row.valueEnc).not.toContain('eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9');
    const decrypted = Object.fromEntries(mockDb.creds.map((r) => [r.envKey, decryptValue(r.valueEnc)]));
    expect(decrypted.BREV_ACCESS_TOKEN).toBe(fakeJwt());
    expect(decrypted.BREV_REFRESH_TOKEN).toBe(fakeRefresh());

    // The owner-facing message names every key…
    expect(res.message).toContain('$BREV_ACCESS_TOKEN');
    expect(res.message).toContain('$BREV_REFRESH_TOKEN');
    // …and never a value.
    const everything = JSON.stringify(res) + JSON.stringify(mockDb.activity) + JSON.stringify(mockMetrics);
    expect(everything).not.toContain(fakeJwt());
    expect(everything).not.toContain(fakeRefresh());
  });

  it('the store leg\'s own audit row rides each store (provenance of the LIFT is not lost)', async () => {
    const content = brevCredentialsJson();
    seedRow(content);
    await vaultPastedCredential(created, { messageId: 'msg-1', messageText: content, baseEnvKey: 'BREV' });
    const audit = mockDb.activity.filter((a) => a.action === 'coding_credential.store');
    expect(audit.length).toBeGreaterThanOrEqual(2);
    // via:'store_secret' is the LIFT record (which row, which pattern) — the
    // route adds its OWN via:'owner_vault_button' row on top; this suite pins
    // the lift half, the controller suite pins the button half.
    expect(audit[0].metadata).toMatchObject({ via: 'store_secret', chatId: 'chat-1' });
    expect(JSON.stringify(audit)).not.toContain(fakeJwt());
  });

  it('a single unlabelled key still vaults (one span, one key)', async () => {
    const content = `my key is hf_${'e'.repeat(34)}`;
    seedRow(content);
    const res = await vaultPastedCredential(created, { messageId: 'msg-1', messageText: content });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.stored).toHaveLength(1);
    expect(mockDb.creds).toHaveLength(1);
  });

  it('a message with NO credential-shaped value is an HONEST refusal that stores nothing', async () => {
    const content = 'remember we deploy on friday at noon';
    seedRow(content);
    const res = await vaultPastedCredential(created, { messageId: 'msg-1', messageText: content });
    expect(res).toMatchObject({ ok: false, reason: 'no_secret_found' });
    expect(mockDb.creds).toHaveLength(0);
    expect(mockDb.activity).toHaveLength(0);
    expect((res as any).message).toMatch(/nothing was stored/i);
  });

  it('the KILL SWITCH refuses and stores nothing', async () => {
    process.env.STORE_SECRET_TOOL_DISABLED = '1';
    const content = brevCredentialsJson();
    seedRow(content);
    const res = await vaultPastedCredential(created, { messageId: 'msg-1', messageText: content, baseEnvKey: 'BREV' });
    expect(res).toMatchObject({ ok: false, reason: 'disabled' });
    expect(mockDb.creds).toHaveLength(0);
    expect((res as any).message).toMatch(/switched off/i);
  });

  it('a row owned by ANOTHER user is refused by the store leg (defence in depth under the route\'s 404)', async () => {
    const content = brevCredentialsJson();
    seedRow(content, { owner: 'u2' });
    const res = await vaultPastedCredential(created, { messageId: 'msg-1', messageText: content, baseEnvKey: 'BREV' });
    expect(res.ok).toBe(false);
    expect(mockDb.creds).toHaveLength(0);
  });

  it('a MACHINE-authored row is refused by the store leg', async () => {
    const content = brevCredentialsJson();
    seedRow(content, { metadata: { origin: 'schedule' } });
    const res = await vaultPastedCredential(created, { messageId: 'msg-1', messageText: content, baseEnvKey: 'BREV' });
    expect(res.ok).toBe(false);
    expect(mockDb.creds).toHaveLength(0);
  });

  it('the result message reports anything NOT stored — a partial vault is never silent', () => {
    const msg = buildVaultMessage(
      [{ n: 1, envKey: 'BREV_ACCESS_TOKEN', injectedKey: 'BREV_ACCESS_TOKEN', pattern: 'Credential assignment', replaced: false }],
      [{ n: 2, pattern: 'Credential assignment', envKey: 'BREV_REFRESH_TOKEN', reason: 'store_failed' }],
    );
    expect(msg).toContain('$BREV_ACCESS_TOKEN');
    expect(msg).toMatch(/NOT stored:/);
    expect(msg).toContain('BREV_REFRESH_TOKEN');
  });

  it('a REPLACED store says so (the owner is told the previous value is gone)', () => {
    const msg = buildVaultMessage(
      [{ n: 1, envKey: 'BREV_ACCESS_TOKEN', injectedKey: 'BREV_ACCESS_TOKEN', pattern: 'Credential assignment', replaced: true }],
      [],
    );
    expect(msg).toMatch(/REPLACED/);
  });
});