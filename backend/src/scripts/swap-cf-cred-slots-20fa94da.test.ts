/**
 * scripts/framework-audit/swap-cf-cred-slots-20fa94da.js — the ticket-20fa94da
 * WRITE one-shot that swaps the two CLOUDFLARE slot rows' opaque valueEnc
 * blobs when the stored values carry the EXACT swapped shape (32-hex account
 * id under the API-TOKEN slot, cfk_/cfut_/cfat_ token under the ACCOUNT-ID
 * slot). On a MOCKED Prisma client + FAKE ciphertexts: dry run by default
 * (verdict list, no writes), --apply swaps both rows inside ONE interactive
 * transaction that re-reads both rows and rolls back on ANY miss (adversarial
 * review F2: a concurrent re-save is a clean skippedChanged, never a partial
 * swap that loses the working token blob), pairing is namespace-aware on the
 * derived injected name (review F3: base+label pairs and suffix-in-envKey
 * pairs each stay in their own namespace; an ambiguous slot is reported as
 * unexamined and skipped, never guessed), a correctly-mapped pair is
 * already-correct and untouched, and NO output ever contains a value or a
 * valueEnc blob.
 */
import path from 'path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const script: any = require(path.resolve(__dirname, '..', '..', '..', 'scripts', 'framework-audit', 'swap-cf-cred-slots-20fa94da.js'));

// FAKE fixtures — structurally valid shapes only, never real credentials.
const FAKE_ACCOUNT_ID = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6'; // 32 hex
const FAKE_CFAT = 'cfat_' + 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdE'; // 53 chars
const FAKE_CFUT = 'cfut_' + 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCd';
const FAKE_LEGACY_40 = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCd'; // unknown shape to the classifier
const enc = (v: string) => `ENC(${v})`; // stand-in ciphertext; opaque to the script

type Row = { id: string; userId: string; provider: string; envKey: string; label: string; valueEnc: string; updatedAt: Date };

function makePrisma(rows: Row[], opts: { moveOnWrite?: boolean; moveDuringApply?: boolean } = {}) {
  const writes: any[] = [];
  const prisma: any = {
    codingCredential: {
      findMany: jest.fn(async ({ where }: any) =>
        rows.filter((r) => (where?.envKey?.startsWith ? r.envKey.startsWith(where.envKey.startsWith) : true)).map((r) => {
          const snap = { ...r };
          if (opts.moveOnWrite) r.valueEnc = `${r.valueEnc}-MOVED`; // the live row moves AFTER our scan snapshot
          return snap;
        })),
      findUnique: jest.fn(async ({ where }: any) => {
        const row = rows.find((r) => r.id === where.id);
        return row ? { valueEnc: row.valueEnc } : null;
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const row = rows.find((r) => r.id === where.id);
        if (!row || row.valueEnc !== where.valueEnc) return { count: 0 }; // the real guarded-updateMany semantics
        if (opts.moveDuringApply && where.id === 'tok') {
          // A concurrent owner re-save COMMITS between our tx re-read and this
          // update: fresh IV, same plaintext → a NEW blob. It is the OWNER's
          // committed write — our rollback must never undo it.
          row.valueEnc = `ENC2(${FAKE_ACCOUNT_ID})`;
          return { count: 0 }; // our guarded update matches nothing
        }
        writes.push({ id: where.id, from: row.valueEnc, to: data.valueEnc });
        row.valueEnc = data.valueEnc;
        return { count: 1 };
      }),
    },
    // Interactive transaction (review F2): the callback receives a tx client and
    // a THROWN error means rollback — but rollback only undoes the writes THIS
    // transaction issued; a concurrent writer's committed write (moveDuringApply)
    // is not ours and survives, exactly like Postgres.
    $transaction: jest.fn(async (fn: any) => {
      const writesBefore = writes.length;
      try {
        return await fn(prisma);
      } catch (err) {
        writes.slice(writesBefore).forEach((w) => {
          const r = rows.find((x) => x.id === w.id);
          if (r && r.valueEnc === w.to) r.valueEnc = w.from; // our write → revert
        });
        writes.length = writesBefore;
        throw err;
      }
    }),
    $disconnect: jest.fn(async () => {}),
  };
  return { prisma, writes };
}

const row = (over: Partial<Row>): Row => ({
  id: over.id || 'r1', userId: 'user-0001', provider: 'cloudflare', envKey: 'CLOUDFLARE_API_TOKEN', label: '', valueEnc: '', updatedAt: new Date(), ...over,
});

const swappedPair = (): Row[] => [
  row({ id: 'tok', envKey: 'CLOUDFLARE_API_TOKEN', label: 'CQL', valueEnc: enc(FAKE_ACCOUNT_ID) }),
  row({ id: 'acc', envKey: 'CLOUDFLARE_ACCOUNT_ID', label: 'CQL', valueEnc: enc(FAKE_CFAT) }),
];

beforeEach(() => { jest.spyOn(console, 'log').mockImplementation(() => {}); });
afterEach(() => { (console.log as any).mockRestore(); });

describe('swap-cf-cred-slots-20fa94da.js — offline script behavior', () => {
  it('DRY RUN (default): reports the swapped pair as SWAPPED, writes nothing, prints no value or blob', async () => {
    const { prisma, writes } = makePrisma(swappedPair());
    const out = await script.run({ prisma, argv: [], decrypt: (v: string) => v.slice(4, -1) });
    expect(out.wouldSwap).toBe(1);
    expect(out.swapped).toBe(0);
    expect(writes).toHaveLength(0);
    expect(out.candidates[0]).toMatchObject({ verdict: 'SWAPPED', namespace: 'CQL', userId: 'user-000' }); // userId truncated to 8 chars
    expect(JSON.stringify(out)).not.toContain(FAKE_ACCOUNT_ID);
    expect(JSON.stringify(out)).not.toContain(FAKE_CFAT);
    expect(JSON.stringify(out)).not.toContain('ENC(');
  });

  it('APPLY: swaps the two blobs atomically — both rows end with each other\'s blob', async () => {
    const rows = swappedPair();
    const { prisma, writes } = makePrisma(rows);
    const out = await script.run({ prisma, argv: ['--apply'], decrypt: (v: string) => v.slice(4, -1) });
    expect(out.swapped).toBe(1);
    expect(writes.map((w) => w.id).sort()).toEqual(['acc', 'tok']);
    expect(rows.find((r) => r.id === 'tok')!.valueEnc).toBe(enc(FAKE_CFAT));
    expect(rows.find((r) => r.id === 'acc')!.valueEnc).toBe(enc(FAKE_ACCOUNT_ID));
  });

  it('review F2 — a row that moved between the SCAN and the APPLY is a clean skippedChanged, NOTHING written (no partial swap)', async () => {
    const rows = swappedPair();
    const { prisma, writes } = makePrisma(rows, { moveOnWrite: true });
    const out = await script.run({ prisma, argv: ['--apply'], decrypt: (v: string) => v.slice(4, -1) });
    expect(out.skippedChanged).toBe(1);
    expect(out.swapped).toBe(0);
    expect(writes).toHaveLength(0); // the tx re-read saw the moved blob and returned before any write
    expect(rows.find((r) => r.id === 'tok')!.valueEnc).not.toBe(enc(FAKE_CFAT)); // the swap never landed
  });

  it('review F2 — a row that moves between the TX RE-READ and the UPDATE rolls the whole transaction back (both blobs intact)', async () => {
    const rows = swappedPair();
    const { prisma } = makePrisma(rows, { moveDuringApply: true });
    const out = await script.run({ prisma, argv: ['--apply'], decrypt: (v: string) => v.slice(4, -1) });
    expect(out.swapped).toBe(0);
    expect(out.skippedChanged).toBe(1);
    // tok: the concurrent owner's fresh committed blob SURVIVES our rollback (never destroyed — review F2's core invariant).
    expect(rows.find((r) => r.id === 'tok')!.valueEnc).toBe(`ENC2(${FAKE_ACCOUNT_ID})`);
    // acc: OUR partner write was rolled back — no foreign blob, the original stays.
    expect(rows.find((r) => r.id === 'acc')!.valueEnc).toBe(enc(FAKE_CFAT));
  });

  it('the fixed pair reports already-correct on a re-run (happy-path idempotence)', async () => {
    const fixed = [
      row({ id: 'tok', envKey: 'CLOUDFLARE_API_TOKEN', label: 'CQL', valueEnc: enc(FAKE_CFAT) }),
      row({ id: 'acc', envKey: 'CLOUDFLARE_ACCOUNT_ID', label: 'CQL', valueEnc: enc(FAKE_ACCOUNT_ID) }),
    ];
    const { prisma, writes } = makePrisma(fixed);
    const out = await script.run({ prisma, argv: ['--apply'], decrypt: (v: string) => v.slice(4, -1) });
    expect(out.swapped).toBe(0);
    expect(out.alreadyCorrect).toBe(1);
    expect(writes).toHaveLength(0);
  });

  it('a correctly-mapped pair with an unknown-shape id value is already-correct, never touched', async () => {
    const rows = [
      row({ id: 'tok', envKey: 'CLOUDFLARE_API_TOKEN', label: 'CQL', valueEnc: enc(FAKE_CFAT) }),
      row({ id: 'acc', envKey: 'CLOUDFLARE_ACCOUNT_ID', label: 'CQL', valueEnc: enc(FAKE_LEGACY_40) }),
    ];
    const { prisma, writes } = makePrisma(rows);
    const out = await script.run({ prisma, argv: ['--apply'], decrypt: (v: string) => v.slice(4, -1) });
    expect(out.alreadyCorrect).toBe(1);
    expect(writes).toHaveLength(0);
  });

  it('a pair whose token slot holds an unknown shape is skippedWrongShape (surgical: no guess)', async () => {
    const rows = [
      row({ id: 'tok', envKey: 'CLOUDFLARE_API_TOKEN', label: 'CQL', valueEnc: enc(FAKE_LEGACY_40) }),
      row({ id: 'acc', envKey: 'CLOUDFLARE_ACCOUNT_ID', label: 'CQL', valueEnc: enc(FAKE_ACCOUNT_ID) }),
    ];
    const { prisma } = makePrisma(rows);
    const out = await script.run({ prisma, argv: ['--apply'], decrypt: (v: string) => v.slice(4, -1) });
    expect(out.skippedWrongShape).toBe(1);
    expect(out.swapped).toBe(0);
  });

  it('an incomplete pair (one slot missing) is skippedIncomplete', async () => {
    const rows = [row({ id: 'tok', envKey: 'CLOUDFLARE_API_TOKEN', label: 'CQL', valueEnc: enc(FAKE_ACCOUNT_ID) })];
    const { prisma } = makePrisma(rows);
    const out = await script.run({ prisma, argv: ['--apply'], decrypt: (v: string) => v.slice(4, -1) });
    expect(out.skippedIncomplete).toBe(1);
  });

  it('review F3a — a swapped SUFFIX-IN-ENVKEY row is found even when a correct base pair coexists (the F3a repro)', async () => {
    const rows = [
      row({ id: 'tok-base', envKey: 'CLOUDFLARE_API_TOKEN', label: '', valueEnc: enc(FAKE_CFAT) }),   // base pair: correct
      row({ id: 'acc-base', envKey: 'CLOUDFLARE_ACCOUNT_ID', label: '', valueEnc: enc(FAKE_ACCOUNT_ID) }),
      row({ id: 'tok-cql', envKey: 'CLOUDFLARE_API_TOKEN_CQL', label: '', valueEnc: enc(FAKE_ACCOUNT_ID) }), // CQL ns: swapped
      row({ id: 'acc-cql', envKey: 'CLOUDFLARE_ACCOUNT_ID_CQL', label: '', valueEnc: enc(FAKE_CFAT) }),
    ];
    const { prisma, writes } = makePrisma(rows);
    const out = await script.run({ prisma, argv: ['--apply'], decrypt: (v: string) => v.slice(4, -1) });
    expect(out.swapped).toBe(1);
    expect(out.alreadyCorrect).toBe(1);
    expect(writes.map((w) => w.id).sort()).toEqual(['acc-cql', 'tok-cql']); // ONLY the CQL namespace swapped
  });

  it('review F3b — a base-namespace token row NEVER pairs with a CQL-namespace id row (no cross-namespace swap)', async () => {
    const rows = [
      row({ id: 'tok', envKey: 'CLOUDFLARE_API_TOKEN', label: '', valueEnc: enc(FAKE_ACCOUNT_ID) }),
      row({ id: 'acc-cql', envKey: 'CLOUDFLARE_ACCOUNT_ID_CQL', label: '', valueEnc: enc(FAKE_CFAT) }),
    ];
    const { prisma, writes } = makePrisma(rows);
    const out = await script.run({ prisma, argv: ['--apply'], decrypt: (v: string) => v.slice(4, -1) });
    expect(out.swapped).toBe(0);
    expect(writes).toHaveLength(0);
    expect(out.skippedIncomplete).toBe(2); // two namespaces, each missing its counterpart slot
  });

  it('review F3 — an AMBIGUOUS slot (two token rows in one namespace) is reported unexamined and skipped, never guessed', async () => {
    // Derived-name collision: CLOUDFLARE_API_TOKEN+label X_Y and CLOUDFLARE_API_TOKEN_X+label Y BOTH
    // derive to CLOUDFLARE_API_TOKEN_X_Y — one namespace, two token rows.
    const rows = [
      row({ id: 'tok-1', envKey: 'CLOUDFLARE_API_TOKEN', label: 'X_Y', valueEnc: enc(FAKE_ACCOUNT_ID) }),
      row({ id: 'tok-2', envKey: 'CLOUDFLARE_API_TOKEN_X', label: 'Y', valueEnc: enc(FAKE_ACCOUNT_ID) }), // same derived namespace
      row({ id: 'acc', envKey: 'CLOUDFLARE_ACCOUNT_ID', label: 'X_Y', valueEnc: enc(FAKE_CFAT) }),
    ];
    const { prisma, writes } = makePrisma(rows);
    const out = await script.run({ prisma, argv: ['--apply'], decrypt: (v: string) => v.slice(4, -1) });
    expect(out.swapped).toBe(0);
    expect(writes).toHaveLength(0);
    expect(out.unexamined).toHaveLength(1);
    expect(out.unexamined[0].verdict).toBe('ambiguous-slot');
    expect(out.unexamined[0].rowIds).toEqual(['tok-1', 'tok-2', 'acc']);
  });

  it('mixed base+label and suffix-in-envKey forms pair within their own namespace', async () => {
    // envKey CLOUDFLARE_API_TOKEN + label CQL  ≡  derived CLOUDFLARE_API_TOKEN_CQL — pairs with the suffix-in-envKey id row.
    const rows = [
      row({ id: 'tok-lbl', envKey: 'CLOUDFLARE_API_TOKEN', label: 'CQL', valueEnc: enc(FAKE_ACCOUNT_ID) }),
      row({ id: 'acc-sfx', envKey: 'CLOUDFLARE_ACCOUNT_ID_CQL', label: '', valueEnc: enc(FAKE_CFAT) }),
    ];
    const { prisma, writes } = makePrisma(rows);
    const out = await script.run({ prisma, argv: ['--apply'], decrypt: (v: string) => v.slice(4, -1) });
    expect(out.swapped).toBe(1);
    expect(writes.map((w) => w.id).sort()).toEqual(['acc-sfx', 'tok-lbl']);
  });

  it('unrelated CLOUDFLARE_* keys are ignored entirely', async () => {
    const rows = [row({ id: 'z', envKey: 'CLOUDFLARE_ZONE_ID', label: '', valueEnc: enc(FAKE_ACCOUNT_ID) })];
    const { prisma } = makePrisma(rows);
    const out = await script.run({ prisma, argv: ['--apply'], decrypt: (v: string) => v.slice(4, -1) });
    expect(out.scannedPairs).toBe(0);
    expect(out.candidates).toHaveLength(0);
  });

  it('--user narrows the scan by exact id or prefix; other users are invisible to it', async () => {
    const rows = [
      ...swappedPair().map((r) => ({ ...r, userId: 'user-A' })),
      ...swappedPair().map((r) => ({ ...r, id: r.id + '-b', userId: 'user-B' })),
    ];
    const { prisma, writes } = makePrisma(rows);
    const out = await script.run({ prisma, argv: ['--apply', '--user=user-A'], decrypt: (v: string) => v.slice(4, -1) });
    expect(out.swapped).toBe(1);
    expect(writes.every((w) => ['tok', 'acc'].includes(w.id))).toBe(true);
  });

  it('parseArgs: dry-run default; --apply; --dry-run override; --user both forms; single-dash / unknown / empty-value args all refuse', () => {
    expect(script.parseArgs([])).toEqual({ apply: false, user: null });
    expect(script.parseArgs(['--apply'])).toEqual({ apply: true, user: null });
    expect(script.parseArgs(['--apply', '--dry-run'])).toEqual({ apply: false, user: null });
    expect(script.parseArgs(['--user=abc'])).toEqual({ apply: false, user: 'abc' });
    expect(script.parseArgs(['--user', 'abc'])).toEqual({ apply: false, user: 'abc' }); // space form works
    expect(script.parseArgs(['abc'])).toEqual({ apply: false, user: 'abc' });
    expect(() => script.parseArgs(['--bogus'])).toThrow();            // unknown long arg
    expect(() => script.parseArgs(['-apply'])).toThrow(/--apply/);    // single-dash typo names the fix
    expect(() => script.parseArgs(['--user'])).toThrow();             // missing value
    expect(() => script.parseArgs(['--user='])).toThrow();            // empty value
  });

  it('shapeOf classifies the token families + the account id + unknown', () => {
    expect(script.shapeOf(FAKE_ACCOUNT_ID)).toBe('account-id(32hex)');
    expect(script.shapeOf(FAKE_CFAT)).toBe('cf-token(cfk_/cfut_/cfat_)');
    expect(script.shapeOf(FAKE_CFUT)).toBe('cf-token(cfk_/cfut_/cfat_)');
    expect(script.shapeOf(FAKE_LEGACY_40)).toBe('unknown');
    expect(script.shapeOf('')).toBe('unknown');
  });

  it('slotOf: derived-name namespaces — base, label, and suffix-in-envKey forms', () => {
    expect(script.slotOf('CLOUDFLARE_API_TOKEN', '')).toEqual({ slot: 'token', tail: '' });
    expect(script.slotOf('CLOUDFLARE_API_TOKEN', 'CQL')).toEqual({ slot: 'token', tail: 'CQL' });
    expect(script.slotOf('CLOUDFLARE_API_TOKEN_CQL', '')).toEqual({ slot: 'token', tail: 'CQL' }); // same namespace as label form
    expect(script.slotOf('CLOUDFLARE_ACCOUNT_ID_CQL', '')).toEqual({ slot: 'account-id', tail: 'CQL' });
    expect(script.slotOf('CLOUDFLARE_API_TOKENIZED', '')).toEqual({ slot: null, tail: '' }); // boundary: not a slot
    expect(script.slotOf('CLOUDFLARE_ZONE_ID', '')).toEqual({ slot: null, tail: '' });
    expect(script.slotOf('CLOUDFLARE_API_TOKEN_CQL', 'WORK')).toEqual({ slot: 'token', tail: 'CQL_WORK' }); // both suffixes stack
  });
});
