/**
 * owner-turn-history.ts — FS context map 2026-10-22, gaps #1 and #3 (owner:
 * "it still feels the fleet supervisor doesnt fully have the context and
 * memory of everything").
 *
 * The replay is a synthetic Fleet Supervisor transcript at the measured rate:
 * 157 rows a day (7 owner messages, 18 machine wakes whose stored prompt is
 * ~15k chars of baked preamble + state snapshot, 46 agent relays, 86
 * assistant rows — a reply per turn + 15 harness status cards / briefings),
 * two days of it. The loader reads the newest 80 rows for the history and the
 * last 48 h of heads for the thread; the tests feed the same slices.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
const mockQueryRaw: jest.Mock = jest.fn();
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: { supervisorState: { findUnique: jest.fn(), upsert: jest.fn() }, crossModelChat: { findUnique: jest.fn() }, $queryRawUnsafe: (...a: any[]) => mockQueryRaw(...a) },
}));
jest.mock('./loop-metrics.service', () => ({ __esModule: true, recordLoopMetric: jest.fn() }));

import {
  OWNER_HISTORY_CHAR_BUDGET, OWNER_HISTORY_FETCH_ROWS, OWNER_ROW_MAX_CHARS, OWNER_THREAD_HEADING, OWNER_THREAD_MAX_CHARS,
  OWNER_THREAD_WINDOW_MS, OWNER_TURN_ELIDED_WAKE, OWNER_TURN_NO_REPLY, OWNER_TURN_NOTICE_MAX_CHARS, OWNER_TURN_NOTICE_PREFIX, OWNER_TURN_RELAY_MAX_CHARS,
  OWNER_TURN_READ_BOUND_MS, OWNER_TURN_READ_CEILING_MS,
  classifyOwnerTurnUserRow, isHarnessAssistantRow, ownerHistoryV2Disabled, ownerLedgerDiffDisabled, ownerThreadEntriesFromRows,
  ownerTurnReadFailOpen, pendingConfirmationNoteFrom, renderOwnerThreadBlock, selectOwnerTurnHistory, startOwnerTurnRead, type OwnerTurnRow,
} from './owner-turn-history';
import { OWNER_TURN_CONTEXT_TIMEOUT_MS } from './owner-turn-history.loader';
import { formatStateForWake, WAKE_BLOCK_CAP, type SupervisorStateDoc } from './supervisor-state.service';
import { REDACTED_NOTE } from './secret-scan';
import { loadOwnerTurnRows } from './owner-turn-history.loader';

const NOW = new Date('2026-10-22T18:00:00.000Z');
const H = 3_600_000;
const SLOTS_PER_DAY = 71; // 7 owner + 18 wake + 46 relay turns
/** The chat engine's finalize stamp (fleet/supervisor-reply-row hasFinalizeStamp) — every model-written row carries it; harness rows never do. */
const STAMP = { engine: 'agent' } as const;
const SLOT_MS = (24 * H) / SLOTS_PER_DAY;
/** Owner messages, hours ago within each day (the older day is +24 h). */
const OWNER_HOURS = [0.5, 3, 6, 9, 13, 17, 21];
const BAKED = (n: number, at: Date) =>
  `[MACHINE-TRIGGERED RUN — no user is on this turn. Current time: ${at.toISOString()} — this is the ONLY trustworthy clock]\n`
  + `[SUPERVISOR STATE — your durable memory across wakes] snapshot ${n} PROJECT STATUS: - Digby: all green as of then\n${'s'.repeat(15000)}\n[FLEET EVENT] wake ${n}`;
const ownerText = (day: number, h: number) =>
  day === 0 && h === 6
    ? `OWNER MARK_D0_H6 long brief: ${'please read all of this carefully. '.repeat(160)}`
    : `OWNER MARK_D${day}_H${h}: keep the bench lane on the new box and ping me when the eval finishes — do not restart the old cluster.`;

function syntheticTranscript(): OwnerTurnRow[] {
  const rows: OwnerTurnRow[] = [];
  let wakeN = 0;
  let relayN = 0;
  for (let day = 1; day >= 0; day -= 1) {
    const ownerSlots = new Map(OWNER_HOURS.map((h) => [Math.round(h / (SLOT_MS / H) - 0.5), h]));
    let other = 0;
    let harnessLeft = 15;
    for (let s = SLOTS_PER_DAY - 1; s >= 0; s -= 1) {
      const t = NOW.getTime() - day * 24 * H - (s + 0.5) * SLOT_MS;
      const at = (dm: number) => new Date(t + dm * 60_000);
      const h = ownerSlots.get(s);
      if (h !== undefined) {
        const id = `own-d${day}-h${h}`;
        rows.push({ id, role: 'user', content: ownerText(day, h), origin: null, createdAt: at(0) });
        rows.push({ id: `${id}-r`, role: 'assistant', content: `REPLY to MARK_D${day}_H${h}: done — ${'r'.repeat(5000)}`, origin: null, meta: STAMP, createdAt: at(1) });
        continue;
      }
      const isWake = Math.floor(((other + 1) * 18) / 64) > Math.floor((other * 18) / 64);
      other += 1;
      if (isWake) {
        wakeN += 1;
        const origin = wakeN % 2 ? 'schedule' : 'hook';
        rows.push({ id: `wake-${wakeN}`, role: 'user', content: BAKED(wakeN, at(0)), origin, machineMessage: `[FLEET EVENT] lane L${wakeN} run_completed`, createdAt: at(0) });
        rows.push({ id: `wake-${wakeN}-r`, role: 'assistant', content: `NOTE ${wakeN}: ${'n'.repeat(2500)}`, origin, meta: STAMP, createdAt: at(1) });
        if (harnessLeft > 0) {
          harnessLeft -= 1;
          rows.push(wakeN % 2
            ? { id: `card-${wakeN}`, role: 'assistant', content: 'PROJECT STATUS CARD — stale snapshot', origin: 'project_status', kind: 'project_status', createdAt: at(2) }
            : { id: `brief-${wakeN}`, role: 'assistant', content: 'OWNER BRIEFING — stale snapshot', origin: null, kind: 'owner_briefing', createdAt: at(2) });
        }
      } else {
        relayN += 1;
        rows.push({ id: `relay-${relayN}`, role: 'user', content: `[AGENT-SENT MESSAGE — from chat "Lane ${relayN}" (abcd${String(relayN).padStart(4, '0')}), another Digby agent, NOT the owner.] RELAY_${relayN} ${'a'.repeat(2000)}`, origin: 'agent', createdAt: at(0) });
        rows.push({ id: `relay-${relayN}-r`, role: 'assistant', content: `ack relay ${relayN} ${'k'.repeat(800)}`, origin: 'agent', meta: STAMP, createdAt: at(1) });
      }
    }
  }
  return rows.sort((a, b) => new Date(a.createdAt as Date).getTime() - new Date(b.createdAt as Date).getTime());
}

const ALL = syntheticTranscript();
const DAY0 = ALL.filter((r) => new Date(r.createdAt as Date).getTime() > NOW.getTime() - 24 * H);
const HISTORY_ROWS = ALL.slice(-OWNER_HISTORY_FETCH_ROWS); // what the loader's history read returns
const THREAD_ROWS = ALL.filter((r) => new Date(r.createdAt as Date).getTime() >= NOW.getTime() - OWNER_THREAD_WINDOW_MS);
const chars = (h: Array<{ content: string }>) => h.reduce((n, m) => n + m.content.length, 0);

afterEach(() => {
  delete process.env.SUPERVISOR_OWNER_HISTORY_V2_DISABLED;
  delete process.env.SUPERVISOR_OWNER_LEDGER_DIFF_DISABLED;
});

describe('the synthetic day matches the measured shape', () => {
  it('157 rows a day: 7 owner, 18 wakes, 46 relays, 86 assistant rows', () => {
    expect(DAY0).toHaveLength(157);
    const users = DAY0.filter((r) => r.role === 'user');
    expect(users.filter((r) => classifyOwnerTurnUserRow(r) === 'owner')).toHaveLength(7);
    expect(users.filter((r) => classifyOwnerTurnUserRow(r) === 'machine')).toHaveLength(18);
    expect(users.filter((r) => classifyOwnerTurnUserRow(r) === 'agent')).toHaveLength(46);
    expect(DAY0.filter((r) => r.role === 'assistant')).toHaveLength(86);
    // The owner rows the tests chase sit ~3 h and ~30 h back.
    const at = (id: string) => (NOW.getTime() - new Date(ALL.find((r) => r.id === id)!.createdAt as Date).getTime()) / H;
    expect(at('own-d0-h3')).toBeGreaterThan(2.5);
    expect(at('own-d0-h3')).toBeLessThan(3.5);
    expect(at('own-d1-h6')).toBeGreaterThan(29.5);
    expect(at('own-d1-h6')).toBeLessThan(30.5);
  });
});

describe('selectOwnerTurnHistory (gap #1) — the owner turn history, by origin', () => {
  const sel = selectOwnerTurnHistory(HISTORY_ROWS);
  const texts = sel.history.map((m) => m.content);

  it('the legacy 8-row slice has lost the 3 h-old owner message; the v2 history carries it with its reply', () => {
    expect(ALL.slice(-8).some((r) => r.content.includes('MARK_D0_H3'))).toBe(false);
    const i = sel.history.findIndex((m) => m.role === 'user' && m.content.includes('MARK_D0_H3'));
    expect(i).toBeGreaterThanOrEqual(0);
    expect(sel.history[i + 1]).toMatchObject({ role: 'assistant' });
    expect(sel.history[i + 1].content.startsWith('REPLY to MARK_D0_H3')).toBe(true);
    // Every owner message inside the window is kept, in order.
    const ownerIdx = ['MARK_D0_H9', 'MARK_D0_H6', 'MARK_D0_H3', 'MARK_D0_H0.5'].map((m) => texts.findIndex((t) => t.includes(m)));
    expect(ownerIdx.every((x) => x >= 0)).toBe(true);
    expect([...ownerIdx].sort((a, b) => a - b)).toEqual(ownerIdx);
    expect(sel.ownerRowIds).toEqual(expect.arrayContaining(['own-d0-h3', 'own-d0-h0.5']));
  });

  it('baked wake prompts are elided to the stub (naming the trigger); harness snapshot rows are dropped', () => {
    expect(texts.some((t) => t.includes('no user is on this turn'))).toBe(false);
    expect(texts.some((t) => t.includes('[SUPERVISOR STATE'))).toBe(false);
    expect(texts.some((t) => t.includes('PROJECT STATUS CARD') || t.includes('OWNER BRIEFING'))).toBe(false);
    const stubs = sel.history.filter((m) => m.role === 'user' && m.content.startsWith(OWNER_TURN_ELIDED_WAKE.slice(0, -1)));
    expect(stubs.length).toBeGreaterThanOrEqual(1);
    expect(stubs.length).toBeLessThanOrEqual(2);
    expect(stubs[0].content).toContain('its trigger was: [FLEET EVENT] lane L');
    expect(sel.stats.harnessRowsDropped).toBeGreaterThan(0);
  });

  it('at most the newest 2 agent relays, each side clipped to 1,500 chars', () => {
    const relays = sel.history.filter((m) => m.role === 'user' && m.content.startsWith('[AGENT-SENT MESSAGE'));
    expect(relays.length).toBe(2);
    for (const r of relays) expect(r.content.length).toBeLessThanOrEqual(OWNER_TURN_RELAY_MAX_CHARS + 12);
    const newestRelay = HISTORY_ROWS.filter((r) => r.origin === 'agent' && r.role === 'user').pop()!;
    expect(relays[relays.length - 1].content.startsWith(newestRelay.content.slice(0, 60))).toBe(true);
  });

  it('owner rows clip at 4,000 chars and the whole history holds the char bound (the legacy slice did not)', () => {
    const long = texts.find((t) => t.includes('MARK_D0_H6'))!;
    expect(long.length).toBeLessThanOrEqual(OWNER_ROW_MAX_CHARS + 12);
    expect(long.endsWith('…[clipped]')).toBe(true);
    expect(chars(sel.history)).toBeLessThanOrEqual(OWNER_HISTORY_CHAR_BUDGET);
    expect(sel.stats.chars).toBe(chars(sel.history));
    // A tight budget still holds: relays and notes go first, the newest owner turn survives.
    const tight = selectOwnerTurnHistory(HISTORY_ROWS, { charBudget: 9000 });
    expect(chars(tight.history)).toBeLessThanOrEqual(9000);
    expect(tight.history.some((m) => m.content.includes('MARK_D0_H0.5'))).toBe(true);
    expect(tight.history.some((m) => m.content.startsWith('[AGENT-SENT MESSAGE'))).toBe(false);
    // Pathological: one owner turn larger than the whole budget is clipped to it.
    const huge = selectOwnerTurnHistory([{ id: 'x', role: 'user', content: 'z'.repeat(60000), origin: null }], { charBudget: 5000 });
    expect(chars(huge.history)).toBeLessThanOrEqual(5000);
  });

  it('carries the legacy pending-confirmation note onto the last assistant row (a "confirm" reply still completes)', () => {
    const note = "[System note — action awaiting the user's confirmation: Tool: set_chat_autonomy. confirmationId: \"c-1\".]";
    expect(pendingConfirmationNoteFrom([{ role: 'user', content: 'x' }, { role: 'assistant', content: `answer\n\n${note}` }])).toBe(note);
    expect(pendingConfirmationNoteFrom([{ role: 'assistant', content: 'plain' }])).toBe('');
    const withNote = selectOwnerTurnHistory(HISTORY_ROWS, { pendingNote: note });
    const lastAssistant = [...withNote.history].reverse().find((m) => m.role === 'assistant')!;
    expect(lastAssistant.content.endsWith(note)).toBe(true);
    expect(chars(withNote.history)).toBeLessThanOrEqual(OWNER_HISTORY_CHAR_BUDGET + 2);
  });

  it('classifies owner / relay / machine rows by origin first, then by text', () => {
    expect(classifyOwnerTurnUserRow({ content: 'ship it', origin: null })).toBe('owner');
    expect(classifyOwnerTurnUserRow({ content: 'ship it', origin: 'user' })).toBe('owner');
    expect(classifyOwnerTurnUserRow({ content: 'ship it', origin: 'agent' })).toBe('agent');
    expect(classifyOwnerTurnUserRow({ content: 'ship it', origin: 'hook' })).toBe('machine');
    expect(classifyOwnerTurnUserRow({ content: '[3 agent messages arrived while this chat was busy …]', origin: null })).toBe('agent');
    expect(classifyOwnerTurnUserRow({ content: '[MACHINE-TRIGGERED RUN — no user is on this turn.]', origin: null })).toBe('machine');
    expect(isHarnessAssistantRow({ role: 'assistant', origin: 'report-up-ack', kind: null })).toBe(true);
    expect(isHarnessAssistantRow({ role: 'assistant', origin: null, kind: null })).toBe(false);
  });
});

describe('[OWNER THREAD — last 48 h] (gap #1)', () => {
  const entries = ownerThreadEntriesFromRows(THREAD_ROWS, NOW);
  const sel = selectOwnerTurnHistory(HISTORY_ROWS);
  const block = renderOwnerThreadBlock(entries, NOW, { inHistoryIds: sel.ownerRowIds });

  it('every owner message of the last 48 h, each paired with the reply that followed (harness rows skipped)', () => {
    expect(entries).toHaveLength(14);
    expect(entries.every((e) => e.reply?.startsWith('REPLY to'))).toBe(true);
    expect(entries[0].text).toContain('MARK_D1_H21');
    expect(entries[entries.length - 1].text).toContain('MARK_D0_H0.5');
  });

  it('the 30 h-old owner message reaches the owner turn through the thread (the history window no longer holds it)', () => {
    expect(HISTORY_ROWS.some((r) => r.content.includes('MARK_D1_H6'))).toBe(false);
    expect(block.startsWith(OWNER_THREAD_HEADING)).toBe(true);
    expect(block).toContain('MARK_D1_H6');
    expect(block).toContain('MARK_D0_H3');
    expect(block.indexOf('MARK_D1_H6')).toBeLessThan(block.indexOf('MARK_D0_H0.5')); // newest last
    expect(block.length).toBeLessThanOrEqual(OWNER_THREAD_MAX_CHARS);
    // Owner rows the history already carries verbatim shrink first.
    expect(block).toContain('(verbatim in your history)');
  });

  it('over a hard budget the oldest entries are dropped and counted; an empty window renders nothing', () => {
    const small = renderOwnerThreadBlock(entries, NOW, { maxChars: 1500 });
    expect(small.length).toBeLessThanOrEqual(1500);
    expect(small).toMatch(/\(\d+ older owner message\(s\) in the last 48 h not shown/);
    expect(small).toContain('MARK_D0_H0.5');
    expect(renderOwnerThreadBlock([], NOW)).toBe('');
    // Outside the 48 h window ⇒ no entry.
    expect(ownerThreadEntriesFromRows(ALL, new Date(NOW.getTime() + 47 * H))).toHaveLength(7 - OWNER_HOURS.filter((h) => h + 47 > 48).length);
  });

  it('a preempting owner message pairs with ITS reply, not the interrupted wake\'s partial note', () => {
    const t0 = Date.parse('2026-10-22T10:00:00Z');
    const rows: OwnerTurnRow[] = [
      { id: 'w', role: 'user', content: BAKED(1, new Date(t0)), origin: 'hook', createdAt: new Date(t0) },
      { id: 'o', role: 'user', content: 'stop the sweep and answer me', origin: null, createdAt: new Date(t0 + 60_000) },
      { id: 'wp', role: 'assistant', content: '(Stopped.)', origin: 'hook', meta: { ...STAMP, preempted: true }, createdAt: new Date(t0 + 61_000) },
      { id: 'card', role: 'assistant', content: 'STATUS CARD', origin: 'project_status', kind: 'project_status', createdAt: new Date(t0 + 62_000) },
      { id: 'or', role: 'assistant', content: 'Here is the answer.', origin: null, meta: STAMP, createdAt: new Date(t0 + 120_000) },
    ];
    expect(ownerThreadEntriesFromRows(rows, NOW)).toEqual([{ id: 'o', at: new Date(t0 + 60_000).toISOString(), text: 'stop the sweep and answer me', reply: 'Here is the answer.' }]);
  });
});

describe('kill switches (1 / true / on)', () => {
  it('both read off by default and on for 1 / true / on', () => {
    expect(ownerHistoryV2Disabled()).toBe(false);
    expect(ownerLedgerDiffDisabled()).toBe(false);
    for (const v of ['1', 'true', 'on']) {
      process.env.SUPERVISOR_OWNER_HISTORY_V2_DISABLED = v;
      process.env.SUPERVISOR_OWNER_LEDGER_DIFF_DISABLED = v;
      expect(ownerHistoryV2Disabled()).toBe(true);
      expect(ownerLedgerDiffDisabled()).toBe(true);
    }
  });
});

describe('formatStateForWake projectStatusAges (gap #3) — PROJECT STATUS lines carry their age', () => {
  const doc: SupervisorStateDoc = {
    directives: [], archived: [], dispatches: [], refutations: [], notes: '', inflightPreemptAt: '',
    projects: [
      { name: 'Digby', status: 'deploy green', at: new Date(NOW.getTime() - 5 * H).toISOString() },
      { name: 'Bench', status: 'eval running', at: 'not-a-date' },
    ],
  };

  it('owner turns: "[written 5h ago — snapshot, not live]" before the status; unknown age said so', () => {
    const block = formatStateForWake(doc, NOW, { projectStatusAges: true });
    expect(block).toContain('- Digby [written 5h ago — snapshot, not live]: deploy green');
    expect(block).toContain('- Bench [age unknown — snapshot, not live]: eval running');
  });

  it('default (machine wakes, switch on) renders the lines byte-for-byte as before', () => {
    const block = formatStateForWake(doc, NOW);
    expect(block).toContain('- Digby: deploy green');
    expect(block).not.toContain('snapshot, not live');
  });
});

// ── Review fixes 2026-10-23 (items 1, 3, 4, 5) ─────────────────────────────

describe('review item 1 — a credential the owner pasted never rides the owner-turn context', () => {
  const KEY = 'sk-proj-Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4zAB7CD0EF3GH6';
  const PW = 'Tr0ub4dor&3x';
  const KEY30 = 'sk-Q7rT9vX2bN4mK6pL8sD0fG3hJ5wE1yU2iO4aZ6cV8';
  const at = (hAgo: number, dm = 0) => new Date(NOW.getTime() - hAgo * H + dm * 60_000);
  const rows30: OwnerTurnRow[] = [
    { id: 'k30', role: 'user', content: `MARK_K30 use this for the gateway: MOONSHOT_API_KEY=${KEY30}`, origin: null, createdAt: at(30) },
    { id: 'k30-r', role: 'assistant', content: `Noted MOONSHOT_API_KEY=${KEY30} for the gateway.`, origin: null, meta: STAMP, createdAt: at(30, 1) },
  ];
  const rows3: OwnerTurnRow[] = [
    { id: 'k3', role: 'user', content: `MARK_K3 here is the OpenAI key ${KEY} for the bench\nand the db password: ${PW}`, origin: null, createdAt: at(3) },
    { id: 'k3-r', role: 'assistant', content: `Got it — I will hand ${KEY} to the lane.`, origin: null, meta: STAMP, createdAt: at(3, 1) },
  ];
  const raw = [KEY, PW, KEY30, KEY.slice(8, 20)];

  it('3 h old (history) — the owner row and the reply that echoed it carry the redaction note, never the value', () => {
    const sel = selectOwnerTurnHistory(rows3);
    const text = JSON.stringify(sel.history);
    expect(text).toContain('MARK_K3');
    for (const v of raw) expect(text).not.toContain(v);
    expect(sel.history[0].content).toContain(REDACTED_NOTE);
    expect(sel.history[1].content).toContain(REDACTED_NOTE);
  });

  it('30 h old (thread) and 3 h old — the [OWNER THREAD] entries and block never carry the value', () => {
    const entries = ownerThreadEntriesFromRows([...rows30, ...rows3], NOW);
    expect(entries.map((e) => e.id)).toEqual(['k30', 'k3']);
    const block = renderOwnerThreadBlock(entries, NOW);
    expect(block).toContain('MARK_K30');
    expect(block).toContain('MARK_K3');
    for (const v of raw) {
      expect(JSON.stringify(entries)).not.toContain(v);
      expect(block).not.toContain(v);
    }
    expect(block).toContain('[REDACTED');
  });

  it('a key that straddles the 4,000-char clip is redacted whole (redaction runs before the clip, never on a fragment)', () => {
    const content = `${'word '.repeat((OWNER_ROW_MAX_CHARS - 20) / 5)}${KEY} tail`;
    const sel = selectOwnerTurnHistory([{ id: 'x', role: 'user', content, origin: null, createdAt: at(1) }]);
    expect(sel.history[0].content).not.toContain(KEY.slice(0, 20));
    expect(sel.history[0].content.length).toBeLessThanOrEqual(OWNER_ROW_MAX_CHARS + 12);
  });
});

describe('review item 3 — each owner row pairs only with a genuine supervisor reply to it', () => {
  const t0 = Date.parse('2026-10-22T10:00:00Z');
  const at = (s: number) => new Date(t0 + s * 1000);
  const NOTICE = '⚠️ **Fleet hook delivery failed permanently** — 2 event(s) (run_completed) died after 8 delivery attempts.';

  it('an origin-less harness notice is never the owner\'s reply (thread) and never rides the owner\'s exchange (history — round 3: its own line after it)', () => {
    const rows: OwnerTurnRow[] = [
      { id: 'o1', role: 'user', content: 'MARK_O1 where is the bench?', origin: null, createdAt: at(0) },
      { id: 'n1', role: 'assistant', content: NOTICE, origin: null, createdAt: at(5) },
      { id: 'w1', role: 'user', content: BAKED(1, at(60)), origin: 'hook', machineMessage: '[FLEET EVENT] lane L1 run_completed', createdAt: at(60) },
      { id: 'w1-r', role: 'assistant', content: 'NOTE 1: bench lane finished', origin: 'hook', meta: STAMP, createdAt: at(61) },
    ];
    expect(ownerThreadEntriesFromRows(rows, NOW)).toEqual([{ id: 'o1', at: at(0).toISOString(), text: 'MARK_O1 where is the bench?', reply: null }]);
    const sel = selectOwnerTurnHistory(rows);
    expect(sel.history.map((m) => m.role)).toEqual(['user', 'assistant', 'assistant', 'user', 'assistant']);
    expect(sel.history[0].content).toContain('MARK_O1');
    expect(sel.history[1].content).toBe(OWNER_TURN_NO_REPLY);
    // Round-3 review: the notice is no longer lost — one harness-labelled line, after the owner's exchange.
    expect(sel.history[2].content.startsWith(OWNER_TURN_NOTICE_PREFIX)).toBe(true);
    expect(sel.history[2].content).toContain('Fleet hook delivery failed permanently');
    expect(sel.history[3].content).toContain('its trigger was: [FLEET EVENT] lane L1');
    expect(sel.history[4].content).toBe('NOTE 1: bench lane finished');
    // The genuine reply that follows the notice still pairs.
    const withReply: OwnerTurnRow[] = [...rows.slice(0, 2), { id: 'o1-r', role: 'assistant', content: 'The bench is on the new box.', origin: null, meta: STAMP, createdAt: at(30) }, ...rows.slice(2)];
    expect(ownerThreadEntriesFromRows(withReply, NOW)[0].reply).toBe('The bench is on the new box.');
    expect(selectOwnerTurnHistory(withReply).history[1].content).toBe('The bench is on the new box.');
  });

  it('a provider-error envelope or a bare no-op close is not a reply either', () => {
    const rows: OwnerTurnRow[] = [
      { id: 'o1', role: 'user', content: 'status?', origin: null, createdAt: at(0) },
      { id: 'e1', role: 'assistant', content: "Sorry — I couldn't get an answer out this time.", origin: null, meta: { ...STAMP, providerError: { status: 429, kind: 'rate_limit' } }, createdAt: at(5) },
      { id: 'o2', role: 'user', content: 'and now?', origin: null, createdAt: at(60) },
      { id: 'e2', role: 'assistant', content: 'WAKE: no-op — nothing moved.', origin: null, meta: STAMP, createdAt: at(65) },
    ];
    expect(ownerThreadEntriesFromRows(rows, NOW).map((e) => e.reply)).toEqual([null, null]);
  });

  it('a preempted wake\'s partial note is its own machine turn (stubbed prompt), never part of the owner\'s exchange', () => {
    const rows: OwnerTurnRow[] = [
      { id: 'w', role: 'user', content: BAKED(1, at(0)), origin: 'hook', machineMessage: '[FLEET EVENT] lane L7 run_failed', createdAt: at(0) },
      { id: 'o', role: 'user', content: 'MARK_PRE stop the sweep and answer me', origin: null, createdAt: at(60) },
      { id: 'wp', role: 'assistant', content: 'PARTIAL: checking lane L7…', origin: 'hook', meta: { ...STAMP, preempted: true }, createdAt: at(61) },
      { id: 'or', role: 'assistant', content: 'Here is the answer.', origin: null, meta: STAMP, createdAt: at(120) },
    ];
    const h = selectOwnerTurnHistory(rows).history;
    expect(h.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(h[0].content).toContain('its trigger was: [FLEET EVENT] lane L7 run_failed');
    expect(h[1].content).toContain('PARTIAL: checking lane L7');
    expect(h[1].content).toContain('preempted');
    expect(h[2].content).toBe('MARK_PRE stop the sweep and answer me');
    expect(h[3].content).toBe('Here is the answer.');
    expect(ownerThreadEntriesFromRows(rows, NOW)[0].reply).toBe('Here is the answer.');
  });

  it('a dropped harness ack still closes its relay turn — the next wake / relay never merges into it', () => {
    const ack = (id: string, s: number): OwnerTurnRow => ({ id, role: 'assistant', content: 'Status noted — no turn needed.', origin: 'report-up-ack', kind: 'report_up_ack', createdAt: at(s) });
    const relay = (id: string, s: number, tag: string): OwnerTurnRow => ({ id, role: 'user', content: `[AGENT-SENT MESSAGE — from chat "Lane" (abcd0001), another Digby agent, NOT the owner.] ${tag}`, origin: 'agent', createdAt: at(s) });
    const wakeThenNote: OwnerTurnRow[] = [
      relay('r1', 0, 'RELAY_ACKED'), ack('k1', 1),
      { id: 'w', role: 'user', content: BAKED(2, at(300)), origin: 'schedule', machineMessage: 'SWEEP firing 9', createdAt: at(300) },
      { id: 'w-r', role: 'assistant', content: 'NOTE: swept, nothing moved', origin: 'schedule', meta: STAMP, createdAt: at(301) },
    ];
    const h1 = selectOwnerTurnHistory(wakeThenNote).history;
    expect(h1).toHaveLength(2);
    expect(h1[0].content).toContain('its trigger was: SWEEP firing 9');
    expect(h1[1].content).toBe('NOTE: swept, nothing moved');
    const relayThenRelay: OwnerTurnRow[] = [
      relay('r1', 0, 'RELAY_ACKED'), ack('k1', 1),
      relay('r2', 300, 'RELAY_ANSWERED'),
      { id: 'r2-r', role: 'assistant', content: 'REPLY_2', origin: 'agent', meta: STAMP, createdAt: at(301) },
    ];
    const h2 = selectOwnerTurnHistory(relayThenRelay).history;
    expect(h2.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(h2[0].content).toContain('RELAY_ANSWERED');
    expect(h2[0].content).not.toContain('RELAY_ACKED');
    expect(h2[1].content).toBe('REPLY_2');
  });

  it('two owner rows before one reply stay one exchange (the reply pairs with the later row; the earlier is marked)', () => {
    const rows: OwnerTurnRow[] = [
      { id: 'a', role: 'user', content: 'first part', origin: null, createdAt: at(0) },
      { id: 'b', role: 'user', content: 'second part', origin: null, createdAt: at(10) },
      { id: 'ab-r', role: 'assistant', content: 'Both done.', origin: null, meta: STAMP, createdAt: at(30) },
    ];
    const h = selectOwnerTurnHistory(rows).history;
    expect(h).toEqual([{ role: 'user', content: 'first part\n\nsecond part' }, { role: 'assistant', content: 'Both done.' }]);
    const e = ownerThreadEntriesFromRows(rows, NOW);
    expect(e.map((x) => x.reply)).toEqual([null, 'Both done.']);
    expect(renderOwnerThreadBlock(e, NOW)).toContain('answered with the next message');
  });
});

describe('review item 4 — PROJECT STATUS age stamps never cost the state block its content', () => {
  const doc = (notes: string): SupervisorStateDoc => ({
    directives: [], archived: [], refutations: [], inflightPreemptAt: '', notes,
    dispatches: Array.from({ length: 6 }, (_, i) => ({ at: `2026-10-22T1${i}:00:00.000Z`, kind: 'session', id: `sess-${i}`, note: `dispatched lane ${i}` })) as any,
    projects: ['Digby', 'Bench', 'CanLaw', 'Spark'].map((name, i) => ({ name, status: `status of ${name}`, at: new Date(NOW.getTime() - (i + 1) * H).toISOString() })),
  });
  const stamps = /\s\[written \d+[a-z]* ago — snapshot, not live\]/g;

  it('a block that fits the cap without stamps keeps every NOTES char and every dispatch with them', () => {
    const base = formatStateForWake(doc('x'), NOW).length;
    const notes = `NOTES_HEAD ${'n'.repeat(WAKE_BLOCK_CAP - base - 12)}`;
    const plain = formatStateForWake(doc(notes), NOW);
    expect(plain.length).toBeLessThanOrEqual(WAKE_BLOCK_CAP);
    expect(plain).not.toContain('…[truncated]');
    const aged = formatStateForWake(doc(notes), NOW, { projectStatusAges: true });
    expect(aged).toContain('- Digby [written 1h ago — snapshot, not live]: status of Digby');
    expect(aged).not.toContain('…[truncated]');
    expect(aged.replace(stamps, '')).toBe(plain);
  });

  it('over the cap, the trim lands exactly where it would without the stamps', () => {
    const notes = `NOTES_HEAD ${'n'.repeat(WAKE_BLOCK_CAP)}`;
    const plain = formatStateForWake(doc(notes), NOW);
    const aged = formatStateForWake(doc(notes), NOW, { projectStatusAges: true });
    expect(aged.replace(stamps, '')).toBe(plain);
  });
});

describe('review item 5 — the [OWNER THREAD] shrink ladder is linear', () => {
  // The pre-fix renderer, verbatim (quadratic: size() re-rendered every line on every probe) — the reference output.
  function referenceRender(entries: ReadonlyArray<{ id?: string; at: string; text: string; reply: string | null }>, now: Date, opts: { maxChars?: number; inHistoryIds?: ReadonlyArray<string> } = {}): string {
    if (!entries.length) return '';
    const maxChars = opts.maxChars ?? OWNER_THREAD_MAX_CHARS;
    const inHistory = new Set(opts.inHistoryIds ?? []);
    const clipLine = (v: unknown, n: number): string => { const s = String(v ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, Math.max(0, n - 1))}…` : s; };
    const ageOf = (ms: number): string => { const mins = Math.max(0, Math.round(ms / 60_000)); if (mins < 60) return `${mins}m`; const hours = Math.floor(mins / 60); return hours < 48 ? `${hours}h` : `${Math.floor(hours / 24)}d`; };
    const header = `${OWNER_THREAD_HEADING}: every message the owner typed in this chat, oldest first (newest last), each with the head of the reply that followed. Harness-built from the transcript — the owner's own words. Your transcript history keeps owner turns, your latest notes and the newest agent relays (wake prompts elided); get_chat_messages reads any row in full.]`;
    type Shape = { owner: number; reply: number; mark: boolean };
    const shapes: Shape[] = entries.map(() => ({ owner: 600, reply: 300, mark: false }));
    const line = (e: any, sh: Shape): string => {
      const t = Date.parse(e.at);
      const stamp = Number.isFinite(t) ? `${e.at.slice(5, 10)} ${e.at.slice(11, 16)}Z (${ageOf(now.getTime() - t)} ago)` : '?';
      const reply = sh.reply <= 0 ? '' : `\n  ↳ you: ${e.reply ? `"${clipLine(e.reply, sh.reply)}"` : '(no reply recorded)'}`;
      return `- ${stamp} OWNER: "${clipLine(e.text, sh.owner)}"${sh.mark ? ' (verbatim in your history)' : ''}${reply}`;
    };
    const size = (from: number): number => header.length + entries.slice(from).reduce((n, e, k) => n + 1 + line(e, shapes[from + k]).length, 0);
    const isOld = (i: number): boolean => !inHistory.has(String(entries[i].id ?? '')) && i < entries.length - 1;
    const steps: Array<(i: number) => void> = [
      (i) => { if (inHistory.has(String(entries[i].id ?? ''))) shapes[i] = { owner: 160, reply: 0, mark: true }; },
      (i) => { if (isOld(i)) shapes[i].reply = Math.min(shapes[i].reply, 120); },
      (i) => { if (isOld(i)) shapes[i].owner = Math.min(shapes[i].owner, 300); },
      (i) => { if (isOld(i)) shapes[i].reply = 0; },
    ];
    for (const step of steps) {
      if (size(0) <= maxChars) break;
      for (let i = 0; i < entries.length && size(0) > maxChars; i += 1) step(i);
    }
    let from = 0;
    const omitted = (n: number): string => `(${n} older owner message(s) in the last 48 h not shown — get_chat_messages reads them.)`;
    while (from < entries.length - 1 && size(from) + (from ? omitted(from).length + 1 : 0) > maxChars) from += 1;
    const lines = entries.slice(from).map((e, k) => line(e, shapes[from + k]));
    let block = [header, ...(from ? [omitted(from)] : []), ...lines].join('\n');
    if (block.length > maxChars) block = `${block.slice(0, maxChars - 1)}…`;
    return block;
  }
  const mk = (n: number, ownerLen: number, replyLen: number) => Array.from({ length: n }, (_, i) => ({
    id: `e${i}`, at: new Date(NOW.getTime() - (n - i) * 7 * 60_000).toISOString(),
    text: `owner message ${i} ${'x'.repeat((ownerLen * (i % 7 + 1)) % 900)}`, reply: i % 5 === 3 ? null : `reply ${i} ${'y'.repeat((replyLen * (i % 3 + 1)) % 500)}`,
  }));

  it('renders byte-for-byte what the pre-fix ladder rendered, across sizes, budgets and history marks', () => {
    for (const n of [1, 2, 5, 14, 40, 60]) {
      for (const maxChars of [600, 1500, 3000, OWNER_THREAD_MAX_CHARS, 20000]) {
        const entries = mk(n, 230, 170);
        for (const marks of [[], entries.filter((_, i) => i % 4 === 0).map((e) => e.id), entries.slice(-3).map((e) => e.id)]) {
          expect(renderOwnerThreadBlock(entries, NOW, { maxChars, inHistoryIds: marks })).toBe(referenceRender(entries, NOW, { maxChars, inHistoryIds: marks }));
        }
      }
    }
  });

  it('1,500 entries render in well under a second (the pre-fix ladder took ~19 s on the event loop)', () => {
    const entries = mk(1500, 700, 400);
    const t0 = Date.now();
    const block = renderOwnerThreadBlock(entries, NOW, { inHistoryIds: entries.slice(-20).map((e) => e.id) });
    expect(Date.now() - t0).toBeLessThan(500);
    expect(block.length).toBeLessThanOrEqual(OWNER_THREAD_MAX_CHARS);
    expect(block).toContain('owner message 1499');
  });
});

describe('owner-turn-history.loader — the metadata projection, the cut head, the bound', () => {
  afterEach(() => mockQueryRaw.mockReset());

  it('carries the whitelisted meta, asks for no whole metadata, and drops the partial token a LEFT()-cut thread head ends on', async () => {
    const head = `${'word '.repeat(238)}sk-proj-Ab3dE`; // 1,190 + 13 = 1,203 chars ⇒ treat as cut at the 1,200-char head
    mockQueryRaw
      .mockResolvedValueOnce([{ id: 'r', role: 'assistant', content: 'reply', origin: null, kind: null, meta: { engine: 'agent', preempted: null }, createdAt: NOW }])
      .mockResolvedValueOnce([{ id: 'o', role: 'user', content: head.slice(0, 1200), origin: null, kind: null, meta: '{"engine":null}', createdAt: NOW }]);
    const out = await loadOwnerTurnRows('chat-1', { now: NOW });
    expect(out!.history[0].meta).toEqual({ engine: 'agent', preempted: null });
    expect(out!.thread[0].meta).toEqual({ engine: null });
    expect(out!.thread[0].content.endsWith('word ')).toBe(true);
    expect(out!.thread[0].content).not.toContain('sk-proj');
    const sql = mockQueryRaw.mock.calls.map((c: any[]) => String(c[0]));
    for (const q of sql) {
      expect(q).toContain('jsonb_build_object(');
      expect(q).not.toMatch(/SELECT[^]*\bmetadata\s*,/);
    }
  });

  it('a read that never answers resolves null at its bound (fail-open, never a throw)', async () => {
    mockQueryRaw.mockImplementation(() => new Promise(() => {}));
    const t0 = Date.now();
    await expect(loadOwnerTurnRows('chat-1', { now: NOW, timeoutMs: 50 })).resolves.toBeNull();
    expect(Date.now() - t0).toBeLessThan(1000);
    mockQueryRaw.mockRejectedValue(new Error('db down'));
    await expect(loadOwnerTurnRows('chat-1', { now: NOW })).resolves.toBeNull();
  });
});

describe('re-review — the owner-turn read bound is max(1.5 s, the moment the turn asks), and a fail-open is recorded', () => {
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const after = <T,>(ms: number, v: T) => new Promise<T>((r) => setTimeout(() => r(v), ms));
  const MS = 100;

  it('the finding: a read slower than the bound but done before the turn asks is KEPT (the fixed timer dropped it)', async () => {
    // The context build (here: the 250 ms sleep) outlasts the bound; the read lands at 150 ms.
    const read = startOwnerTurnRead(after(150, 'rows'), MS);
    await sleep(250);
    const t0 = Date.now();
    await expect(read.value()).resolves.toBe('rows');
    expect(Date.now() - t0).toBeLessThan(40); // no wait — it was already there
    expect(read.outcome).toBe('ok');
    expect(read.askedAtMs!).toBeGreaterThanOrEqual(240);
    expect(read.waitedMs!).toBeGreaterThanOrEqual(140);
    expect(read.waitedMs!).toBeLessThan(240);
    expect(ownerTurnReadFailOpen('rows', read, { nullIsFailure: true })).toBeNull();
  });

  it('asked BEFORE the bound: waits only until start + bound, then gives up (timeout)', async () => {
    const read = startOwnerTurnRead(after(600, 'late'), MS);
    await sleep(40);
    const t0 = Date.now();
    await expect(read.value()).resolves.toBeNull();
    const waited = Date.now() - t0;
    expect(waited).toBeGreaterThanOrEqual(40);
    expect(waited).toBeLessThan(MS + 40);
    expect(read.outcome).toBe('timeout');
    expect(ownerTurnReadFailOpen('ledger', read, { nullIsFailure: false })).toMatchObject({
      which: 'ledger', failedOpen: true, timedOut: true, reason: 'timeout', boundMs: OWNER_TURN_READ_BOUND_MS,
    });
  });

  it('asked AFTER the bound with the read still pending: dropped at once — waiting would delay the run', async () => {
    const read = startOwnerTurnRead(after(600, 'late'), MS);
    await sleep(200);
    const t0 = Date.now();
    await expect(read.value()).resolves.toBeNull();
    expect(Date.now() - t0).toBeLessThan(40);
    expect(read.outcome).toBe('timeout');
    expect(read.askedAtMs!).toBeGreaterThanOrEqual(190);
    expect(read.waitedMs!).toBeGreaterThanOrEqual(read.askedAtMs!);
  });

  it('a read that settled just before the late ask is never misreported as a timeout', async () => {
    const read = startOwnerTurnRead(Promise.resolve('now'), 0);
    await expect(read.value()).resolves.toBe('now');
    expect(read.outcome).toBe('ok');
  });

  it('a rejection is an error (null, never a throw, never unhandled), memoised; a null answer is a failure only where null is not normal', async () => {
    const read = startOwnerTurnRead(Promise.reject(new Error('db down')), MS);
    await sleep(5);
    await expect(read.value()).resolves.toBeNull();
    await expect(read.value()).resolves.toBeNull();
    expect(read.outcome).toBe('error');
    expect(ownerTurnReadFailOpen('rows', read, { nullIsFailure: true })).toMatchObject({ reason: 'error', timedOut: false });
    // Never asked ⇒ nothing to record (and an unasked rejection is still observed — no unhandled rejection).
    const unasked = startOwnerTurnRead(Promise.reject(new Error('x')), MS);
    await sleep(5);
    expect(ownerTurnReadFailOpen('rows', unasked, { nullIsFailure: true })).toBeNull();
    const nul = startOwnerTurnRead(Promise.resolve(null), MS);
    await expect(nul.value()).resolves.toBeNull();
    expect(ownerTurnReadFailOpen('rows', nul, { nullIsFailure: true })).toMatchObject({ reason: 'null', timedOut: false });
    expect(ownerTurnReadFailOpen('ledger', nul, { nullIsFailure: false })).toBeNull();
    // An EMPTY answer is an answer (no rows yet, a diff with nothing in it) — never a fail-open.
    const empty = startOwnerTurnRead(Promise.resolve({ block: '' }), MS);
    await expect(empty.value()).resolves.toEqual({ block: '' });
    expect(ownerTurnReadFailOpen('ledger', empty, { nullIsFailure: true })).toBeNull();
  });

  it('the reads\' own deadlines are a ceiling past the context build, never the 1.5 s bound', () => {
    expect(OWNER_TURN_READ_CEILING_MS).toBeGreaterThanOrEqual(10_000);
    expect(OWNER_TURN_CONTEXT_TIMEOUT_MS).toBe(OWNER_TURN_READ_CEILING_MS);
  });
});

describe('round-3 review (H items 2 + 3) — a preempted follow-through stays in its owner exchange; harness notices ride as lines', () => {
  const t0 = Date.parse('2026-10-22T10:00:00Z');
  const at = (s: number) => new Date(t0 + s * 1000);
  const SPLIT_META = { ...STAMP, ownerAnswerFirst: { mode: 'act', split: true, armed: true, taskId: 'tk1' }, task: { status: 'running' } };

  it('item 2: a preempted origin-less continuation_result joins the newest OWNER turn (labelled partial), after the owner line it answers — never an earlier wake', () => {
    const rows: OwnerTurnRow[] = [
      { id: 'w0', role: 'user', content: BAKED(1, at(0)), origin: 'hook', machineMessage: '[FLEET EVENT] lane L3 run_completed', createdAt: at(0) },
      { id: 'w0-r', role: 'assistant', content: 'NOTE W0: lane L3 done', origin: 'hook', meta: STAMP, createdAt: at(30) },
      { id: 'o1', role: 'user', content: 'MARK_O1 where is the bench?', origin: null, createdAt: at(60) },
      { id: 'o1-split', role: 'assistant', content: 'SPLIT_O1: checking — more in a moment.', origin: null, meta: SPLIT_META, createdAt: at(90) },
      { id: 'o1-cont', role: 'assistant', content: 'FOLLOW_O1 partial: bench lane L3 is', origin: null, kind: 'continuation_result', meta: { ...STAMP, preempted: true }, createdAt: at(120) },
      { id: 'o2', role: 'user', content: 'MARK_O2 never mind, restart it', origin: null, createdAt: at(121) },
      { id: 'o2-r', role: 'assistant', content: 'REPLY_O2: restarted.', origin: null, meta: STAMP, createdAt: at(150) },
    ];
    const h = selectOwnerTurnHistory(rows).history;
    expect(h.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'assistant', 'user', 'assistant']);
    expect(h[1].content).toBe('NOTE W0: lane L3 done');
    expect(h[2].content).toBe('MARK_O1 where is the bench?');
    expect(h[3].content).toBe('SPLIT_O1: checking — more in a moment.');
    expect(h[4].content).toContain('FOLLOW_O1 partial');
    expect(h[4].content).toContain("preempted by the owner's next message");
    expect(h[4].content).not.toContain('this wake was preempted');
    expect(h[5].content).toBe('MARK_O2 never mind, restart it');
    expect(h[6].content).toBe('REPLY_O2: restarted.');
    // The thread never counts the split (still running) or the preempted round as O1's reply.
    expect(ownerThreadEntriesFromRows(rows, NOW).map((e) => e.reply)).toEqual([null, 'REPLY_O2: restarted.']);
    // A preempted wake partial with a machine origin is still its own machine turn.
    const wake = selectOwnerTurnHistory([
      ...rows.slice(0, 1),
      { id: 'w0-p', role: 'assistant', content: 'PARTIAL W0', origin: 'hook', meta: { ...STAMP, preempted: true }, createdAt: at(61) },
    ]).history;
    expect(wake[1].content).toContain('this wake was preempted');
  });

  const NOTICE = (n: number) => `⚠️ **Fleet hook delivery failed permanently** — ${n} event(s) (run_completed) from "Lane ${n}" died after 8 delivery attempts (last reason: busy).\nThose events are LOST — check the source chat.`;

  it('item 3: origin-less harness notices (no finalize stamp) — the newest 3 ride as ONE line each, in position, never as the owner\'s reply', () => {
    const rows: OwnerTurnRow[] = [
      { id: 'n1', role: 'assistant', content: NOTICE(1), origin: null, createdAt: at(0) },
      { id: 'o1', role: 'user', content: 'MARK_O1 status?', origin: null, createdAt: at(60) },
      { id: 'n2', role: 'assistant', content: `${NOTICE(2)} ${'detail '.repeat(100)}`, origin: null, createdAt: at(61) },
      { id: 'n3', role: 'assistant', content: `🛑 **Schedule sch-9 stopped** — it hit its run cap and was disabled automatically; it will NOT fire or resume again.`, origin: null, createdAt: at(62) },
      { id: 'card', role: 'assistant', content: 'PROJECT STATUS CARD — stale snapshot', origin: 'project_status', kind: 'project_status', createdAt: at(63) },
      { id: 'w1', role: 'user', content: BAKED(1, at(120)), origin: 'schedule', machineMessage: 'SWEEP firing 4', createdAt: at(120) },
      { id: 'w1-r', role: 'assistant', content: 'NOTE W1: swept', origin: 'schedule', meta: STAMP, createdAt: at(121) },
      { id: 'n4', role: 'assistant', content: `The background continuation of this task failed before it could finish — send a message and I will pick it up from here. sk-proj-Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4zAB7CD0EF3GH6`, origin: null, kind: 'continuation_result', meta: { failed: true }, createdAt: at(122) },
    ];
    const sel = selectOwnerTurnHistory(rows);
    const h = sel.history;
    expect(h.map((m) => m.role)).toEqual(['user', 'assistant', 'assistant', 'assistant', 'user', 'assistant', 'assistant']);
    expect(h[0].content).toBe('MARK_O1 status?');
    expect(h[1].content).toBe(OWNER_TURN_NO_REPLY);
    const notices = h.filter((m) => m.content.startsWith(OWNER_TURN_NOTICE_PREFIX));
    expect(notices).toHaveLength(3);
    expect(h.some((m) => m.content.includes('"Lane 1"'))).toBe(false); // only the newest 3
    expect(h[2].content).toContain('"Lane 2"');
    expect(h[3].content).toContain('Schedule sch-9 stopped');
    expect(h[6].content).toContain('background continuation of this task failed');
    for (const n of notices) {
      expect(n.content).not.toContain('\n');
      expect(n.content).toContain('not written by you');
      expect(n.content.length).toBeLessThanOrEqual(110 + OWNER_TURN_NOTICE_MAX_CHARS);
    }
    expect(h[2].content.endsWith('…')).toBe(true); // the long one is clipped to one bounded line
    expect(h[6].content).not.toContain('sk-proj');
    expect(h.some((m) => m.content.includes('PROJECT STATUS CARD'))).toBe(false);
    expect(sel.stats).toMatchObject({ noticesKept: 3, harnessRowsDropped: 2, turns: 2 });
    expect(ownerThreadEntriesFromRows(rows, NOW)).toEqual([{ id: 'o1', at: at(60).toISOString(), text: 'MARK_O1 status?', reply: null }]);
  });

  it('item 3: a notice between an owner line and its reply never splits the exchange; notices: 0 keeps none', () => {
    const rows: OwnerTurnRow[] = [
      { id: 'o1', role: 'user', content: 'MARK_O1 deploy?', origin: null, createdAt: at(0) },
      { id: 'n1', role: 'assistant', content: NOTICE(5), origin: null, createdAt: at(5) },
      { id: 'o1-r', role: 'assistant', content: 'REPLY_O1: deployed.', origin: null, meta: STAMP, createdAt: at(30) },
    ];
    const h = selectOwnerTurnHistory(rows).history;
    expect(h.map((m) => m.role)).toEqual(['user', 'assistant', 'assistant']);
    expect(h[0].content).toBe('MARK_O1 deploy?');
    expect(h[1].content).toBe('REPLY_O1: deployed.');
    expect(h[2].content.startsWith(`${OWNER_TURN_NOTICE_PREFIX} 2026-10-22 10:00Z — posted by the harness`)).toBe(true);
    expect(ownerThreadEntriesFromRows(rows, NOW)[0].reply).toBe('REPLY_O1: deployed.');
    expect(selectOwnerTurnHistory(rows, { notices: 0 }).history).toHaveLength(2);
  });
});
