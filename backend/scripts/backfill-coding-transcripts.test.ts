/**
 * P5-A transcript backfill — unit tests over a tiny in-memory fake of the two
 * tables. The fake implements the same semantics the script's SQL relies on:
 * keyset pagination on (createdAt, id), ON CONFLICT (id) DO NOTHING (a Map on
 * id), and a per-chat md5 signature (computed with the same row ordering).
 */

import { createHash } from 'crypto';
import {
  backfillTranscripts, verifyTranscripts, main, parseArgs,
  LegacyCodingMessageRow, BackfillDb, VerifyMismatch,
} from './backfill-coding-transcripts';

interface MirrorRow {
  id: string; chatId: string; role: string; content: string; parts: unknown; createdAt: Date;
}

class FakeDb implements BackfillDb {
  legacy: LegacyCodingMessageRow[];
  mirrored = new Map<string, MirrorRow>();
  insertParams: unknown[][] = [];

  constructor(seed: LegacyCodingMessageRow[] = []) {
    this.legacy = seed.slice();
  }

  async $executeRawUnsafe(sql: string, ...values: unknown[]): Promise<number> {
    if (!sql.includes('INSERT INTO "crossmodel_messages"')) throw new Error(`unexpected execute SQL: ${sql}`);
    this.insertParams.push(values);
    const [id, chatId, role, content, partsJson, createdAt] = values as [string, string, string, string, string | null, Date];
    if (this.mirrored.has(id)) return 0; // ON CONFLICT ("id") DO NOTHING
    this.mirrored.set(id, { id, chatId, role, content, parts: partsJson == null ? null : JSON.parse(partsJson), createdAt });
    return 1;
  }

  async $queryRawUnsafe(sql: string, ...values: unknown[]): Promise<any> {
    if (sql.includes('m."id" IS NULL')) {
      // MISSING_SQL — the gate: legacy ids in this chat with no mirror row IN THE
      // SAME chat. A row mirrored into a DIFFERENT chat does not count as present
      // (the join is on id AND chatId); without that term a message could vanish
      // from a chat while the gate stayed green.
      const chatId = values[0] as string;
      const missing = this.legacy
        .filter(r => r.sessionId === chatId && this.mirrored.get(r.id)?.chatId !== chatId)
        .length;
      return [{ missing }];
    }
    if (sql.includes('md5(')) {
      const legacySide = sql.includes('FROM "coding_messages"');
      const chatId = values[0] as string;
      const rows = legacySide
        ? this.legacy.filter(r => r.sessionId === chatId)
        : [...this.mirrored.values()].filter(r => r.chatId === chatId);
      const sorted = rows.slice().sort((a, b) => +new Date(a.createdAt) - +new Date(b.createdAt) || a.id.localeCompare(b.id));
      const sig = sorted
        .map(r => `${r.id}|${+new Date(r.createdAt) / 1000}|${r.parts == null ? -1 : JSON.stringify(r.parts).length}`)
        .join('\n');
      return [{ n: rows.length, digest: createHash('md5').update(sig).digest('hex') }];
    }
    if (sql.includes('GROUP BY "sessionId"')) {
      return [...new Set(this.legacy.map(r => r.sessionId))].sort().map(sessionId => ({ sessionId }));
    }
    if (sql.includes('FROM "coding_messages"') && sql.includes('LIMIT')) {
      const [cCreated, cId, limit] = values as [Date, string, number];
      const cursor = +new Date(cCreated);
      return this.legacy
        .filter(r => { const t = +new Date(r.createdAt); return t > cursor || (t === cursor && r.id > cId); })
        .sort((a, b) => +new Date(a.createdAt) - +new Date(b.createdAt) || a.id.localeCompare(b.id))
        .slice(0, limit);
    }
    throw new Error(`unexpected query SQL: ${sql}`);
  }

  async $disconnect(): Promise<void> {}
}

let seq = 0;
const row = (sessionId: string, parts: unknown = null, id?: string): LegacyCodingMessageRow => {
  seq += 1;
  return {
    id: id ?? `m${seq}`,
    sessionId,
    role: seq % 2 ? 'user' : 'assistant',
    content: `message ${seq}`,
    parts,
    createdAt: new Date(1_720_000_000_000 + seq * 1000),
  };
};

beforeEach(() => { seq = 0; });

describe('backfillTranscripts', () => {
  it('copies every legacy row into crossmodel_messages with the explicit column mapping', async () => {
    const db = new FakeDb([
      row('chat-a', [{ type: 'text', text: 'hi' }], 'm-a1'),
      row('chat-a', null, 'm-a2'),
      row('chat-b', [{ type: 'tool_call', name: 'read_file' }], 'm-b1'),
    ]);
    const r = await backfillTranscripts(db);
    expect(r).toEqual({ scanned: 3, inserted: 3, skipped: 0 });

    const m1 = db.mirrored.get('m-a1')!;
    expect(m1).toEqual({
      id: 'm-a1',                 // id reused across tables
      chatId: 'chat-a',           // sessionId → chatId
      role: 'user',
      content: 'message 1',
      parts: [{ type: 'text', text: 'hi' }], // jsonb 1:1
      createdAt: new Date(1_720_000_000_000 + 1000), // preserved
    });
    // Insert params are the explicit column values; parts travels as a JSON
    // string ($5::jsonb), NULL parts → NULL.
    expect(db.insertParams[0]).toEqual(['m-a1', 'chat-a', 'user', 'message 1', JSON.stringify([{ type: 'text', text: 'hi' }]), new Date(1_720_000_000_000 + 1000)]);
    expect(db.insertParams[1][4]).toBeNull();
    expect(db.mirrored.get('m-a2')!.parts).toBeNull();
  });

  it('is idempotent — a second run inserts 0 and skips everything', async () => {
    const db = new FakeDb([row('chat-a'), row('chat-a'), row('chat-b')]);
    const first = await backfillTranscripts(db);
    const second = await backfillTranscripts(db);
    expect(first.inserted).toBe(3);
    expect(second).toEqual({ scanned: 3, inserted: 0, skipped: 3 });
    expect(db.mirrored.size).toBe(3);
  });

  it('paginates by keyset — small batches still copy every row exactly once', async () => {
    const rows = Array.from({ length: 5 }, () => row('chat-a'));
    const db = new FakeDb(rows);
    const r = await backfillTranscripts(db, { batch: 2 });
    expect(r).toEqual({ scanned: 5, inserted: 5, skipped: 0 });
    expect([...db.mirrored.keys()].sort()).toEqual(rows.map(x => x.id).sort());
  });

  it('logs progress per 1000 scanned rows', async () => {
    const db = new FakeDb(Array.from({ length: 2500 }, () => row('chat-a')));
    const progress: number[] = [];
    await backfillTranscripts(db, { batch: 500, onProgress: scanned => progress.push(scanned) });
    expect(progress).toEqual([1000, 2000]);
  });
});

describe('verifyTranscripts', () => {
  it('passes when every chat mirrors exactly (counts + checksums match)', async () => {
    const db = new FakeDb([row('chat-a', [{ type: 'text', text: 'x' }]), row('chat-a'), row('chat-b')]);
    await backfillTranscripts(db);
    const r = await verifyTranscripts(db);
    expect(r.checked).toBe(2);
    expect(r.ok).toBe(2);
    expect(r.missingInMirror).toBe(0);
    expect(r.digestOnly).toBe(0);
    expect(r.totalMissingRows).toBe(0);
    expect(r.mismatches).toEqual([]);
    expect(r.totalLegacy).toBe(3);
    expect(r.totalMirrored).toBe(3);
  });

  it('flags a chat missing a mirrored row — THE GATE (missing-in-mirror)', async () => {
    const db = new FakeDb([row('chat-a'), row('chat-a'), row('chat-b')]);
    await backfillTranscripts(db);
    db.mirrored.delete([...db.mirrored.keys()][0]); // lose one chat-a mirror
    const r = await verifyTranscripts(db);
    expect(r.ok).toBe(1);
    expect(r.missingInMirror).toBe(1);
    expect(r.totalMissingRows).toBe(1);
    expect(r.mismatches[0].chatId).toBe('chat-a');
    expect(r.mismatches[0].cls).toBe('missing-in-mirror');
    expect(r.mismatches[0].missingIds).toBe(1);
    expect(r.mismatches[0].legacy.count).toBe(2);
    expect(r.mismatches[0].mirrored.count).toBe(1);
  });

  it('PASSES when the mirror holds MORE rows than legacy (one-session merge — the defect being fixed)', async () => {
    // The merged table legitimately carries chat-profile turns the legacy table never
    // saw, so `mirrored > legacy` is the CORRECT end state of the object model. The old
    // count-equality gate failed these forever (measured 2026-11-02: 125 of 1700 chats).
    const db = new FakeDb([row('chat-a'), row('chat-a')]);
    await backfillTranscripts(db);
    // Add two chat-profile rows that exist ONLY in the mirror.
    for (const n of ['chat-profile-1', 'chat-profile-2']) {
      db.mirrored.set(n, {
        id: n, chatId: 'chat-a', role: 'user', content: `chat turn ${n}`,
        parts: [{ type: 'text', text: 'from the chat profile' }],
        createdAt: new Date(1_720_000_900_000),
      });
    }
    const r = await verifyTranscripts(db);
    expect(r.missingInMirror).toBe(0);
    expect(r.totalMissingRows).toBe(0);
    expect(r.mismatches).toEqual([]);
    // Counts differ and the digest differs — both are DIAGNOSTIC, never a gate failure.
    expect(r.digestOnly).toBe(1);
    expect(r.digestOnlyChats[0].legacy.count).toBe(2);
    expect(r.digestOnlyChats[0].mirrored.count).toBe(4);
    expect(r.ok).toBe(0);
  });

  it('a shot where BOTH legacy rows are absent still fails on the message, not the count', async () => {
    const db = new FakeDb([row('chat-a'), row('chat-a')]);
    // no backfill at all — both legacy ids are missing
    const r = await verifyTranscripts(db);
    expect(r.missingInMirror).toBe(1);
    expect(r.totalMissingRows).toBe(2);
    expect(r.mismatches[0].missingIds).toBe(2);
  });

  it('a row mirrored into the WRONG chat counts as MISSING, not present', async () => {
    // Regression: the gate's join used to match on id alone, so a row that was
    // mirrored into a DIFFERENT chat counted as present and the gate went green
    // while this chat had silently lost the message.
    const db = new FakeDb([row('chat-a', null, 'm-a1')]);
    await backfillTranscripts(db);
    // Move the mirror row to a different chat — the id still exists, but not here.
    const m = db.mirrored.get('m-a1')!;
    db.mirrored.set('m-a1', { ...m, chatId: 'chat-other' });
    const r = await verifyTranscripts(db);
    expect(r.missingInMirror).toBe(1);
    expect(r.totalMissingRows).toBe(1); // the id exists in the mirror — but not for THIS chat
    expect(r.mismatches[0].missingIds).toBe(1);
  });

  it('reports digest drift as a DIAGNOSTIC class, never as a gate failure', async () => {
    const db = new FakeDb([row('chat-a', [{ type: 'text', text: 'x' }])]);
    await backfillTranscripts(db);
    const key = [...db.mirrored.keys()][0];
    // The checksum covers id|createdAt|length(parts::text) — tamper the parts.
    db.mirrored.set(key, { ...db.mirrored.get(key)!, parts: [{ type: 'text', text: 'tampered, longer' }] });
    const r = await verifyTranscripts(db);
    expect(r.digestOnly).toBe(1);
    expect(r.missingInMirror).toBe(0); // the message IS present — nothing was lost
    expect(r.mismatches).toEqual([]);
    expect(r.digestOnlyChats[0].legacy.count).toBe(r.digestOnlyChats[0].mirrored.count); // count equal…
    expect(r.digestOnlyChats[0].legacy.digest).not.toBe(r.digestOnlyChats[0].mirrored.digest); // …digest differs
  });
});

describe('main (CLI wiring)', () => {
  it('--verify exits 0 when the mirror is clean', async () => {
    const db = new FakeDb([row('chat-a')]);
    await backfillTranscripts(db);
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const code = await main(['--verify'], db as any);
    expect(code).toBe(0);
    expect(logSpy.mock.calls.flat().join('\n')).toContain('verification PASSED');
    logSpy.mockRestore();
  });

  it('--verify exits non-zero and prints the chat id + both digests on mismatch', async () => {
    const db = new FakeDb([row('chat-bad')]);
    // no backfill — mirror is empty
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
    const code = await main(['--verify'], db as any);
    expect(code).toBe(1);
    const err = errSpy.mock.calls.flat().join('\n');
    expect(err).toContain('chat-bad');
    expect(err).toMatch(/legacy.*count: 1/);
    expect(err).toMatch(/mirrored.*count: 0/);
    errSpy.mockRestore();
    (console.log as jest.Mock).mockRestore();
  });

  it('backfill mode prints the final summary and exits 0', async () => {
    const db = new FakeDb([row('chat-a'), row('chat-a')]);
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const code = await main(['--batch=1'], db as any);
    expect(code).toBe(0);
    expect(logSpy.mock.calls.flat().join('\n')).toContain('scanned=2 inserted=2 skipped=0');
    logSpy.mockRestore();
  });
});

describe('parseArgs', () => {
  it('defaults to backfill mode with batch=500', () => {
    expect(parseArgs([])).toEqual({ verify: false, batch: 500 });
  });
  it('parses --verify and --batch=N', () => {
    expect(parseArgs(['--verify'])).toEqual({ verify: true, batch: 500 });
    expect(parseArgs(['--batch=250'])).toEqual({ verify: false, batch: 250 });
  });
  it('rejects a non-numeric batch', () => {
    expect(() => parseArgs(['--batch=abc'])).toThrow(/Invalid --batch/);
  });
});
