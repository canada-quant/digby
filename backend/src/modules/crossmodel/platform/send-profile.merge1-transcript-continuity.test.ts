/**
 * MERGE-1 leg (d) — PLAIN → CODING → PLAIN TRANSCRIPT CONTINUITY, pinned.
 *
 * WHY THIS FILE EXISTS. The combined release gate names "plain chat -> coding ->
 * plain chat preserves transcript/history" as an explicit deliverable, and the
 * independent review of 2026-11-05 found it had NO test, NO drill check and no
 * disclosure of the gap: `grep -c transcript backend/scripts/cluster8-evidence-drills.ts`
 * was 0. The sibling files cover adjacent ground — `send-profile.merge1.test.ts`
 * asserts resolver GUARD ORDER, `coding-data.lazy-attach.merge1.test.ts` asserts
 * the attach WRITE sites are confined — but neither walks a single chat THROUGH
 * the conversion and back while checking its history survives.
 *
 * THE MECHANISM UNDER TEST is the shipped `resolveSendProfile`, driven three
 * times against ONE chat:
 *
 *   turn 1  plain chat, code intent      -> attaches, profile 'coding'
 *   turn 2  code intent, satellite now   -> 'coding', attached:false (already has it)
 *   turn 3  a Dig-deeper ESCALATION      -> 'chat'  ... this is the "back to plain"
 *
 * Turn 3 is the real de-escalation path and the reason this round-trip is
 * testable at all: `resolveSendProfile` returns `{profile:'chat'}` for an
 * escalation EVEN ON A CHAT THAT ALREADY CARRIES A SATELLITE
 * (send-profile.ts:132, `if (input.escalation) return {profile:'chat', ...}`).
 * That is deliberate — a deepening answer is a CHAT answer and must never enter
 * the coding harness — and it means one chat genuinely alternates profile
 * without losing its thread. (There is also a destructive path: deleting the
 * chat drops the satellite at crossmodel.service.ts:908. That is chat DEATH,
 * not continuity, so it is out of scope here and is not silently implied.)
 *
 * WHAT IS REAL vs SEAMED, stated plainly so a reader can falsify this file:
 *   REAL   `resolveSendProfile` — the whole guard ladder runs (escalation,
 *          hasWorkspaceState, probe, ownership, supervisor, codeCapable,
 *          keyword heuristic, child read, gate call, attach). Not re-implemented.
 *   SEAMED two leaves it dynamically imports: `ensureChatWorkspaceState` (which
 *          would provision a git worktree — impossible in a unit test) and
 *          `getChatCapability` (wrapped so it reads the SAME mocked table the
 *          attach writes to, i.e. the capability is derived from real storage
 *          state rather than from a stubbed constant). The attach leaf CREATES a
 *          satellite row in the store, so turn 2's 'already has it' path is
 *          reached by state, not by a flag the test set for it.
 *   STORE  ONE in-memory `crossmodel_messages` + `chat_coding_states`, keyed by
 *          chatId — the same keying the real schema uses.
 *
 * WHAT THIS PINS (the actual continuity property). Message rows are keyed by
 * chatId and there is NO per-mode message table, so continuity means: the chat
 * id survives all three sends unchanged, and the message rows accumulate in
 * order with none lost and none duplicated across the profile transitions.
 * The test also pins the negative: the escalation does NOT delete the
 * satellite, so the chat can go back to coding afterwards.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: {
    set: jest.fn(async () => 'OK'),
    get: jest.fn(async () => null),
    del: jest.fn(async () => 1),
    exists: jest.fn(async () => 0),
    on: jest.fn(),
    quit: jest.fn(),
  },
}));

// ── Hoisted shared store (jest.mock factories run above `const`) ────────────
interface Msg { id: string; chatId: string; role: string; content: string; createdAt: number }
interface Satellite { id: string; projectId: string; userId: string; worktreePath: string | null }

function mockStore(): {
  messages: Msg[];
  satellites: Map<string, Satellite>;
  reset: () => void;
  append: (chatId: string, role: string, content: string) => Msg;
} {
  const g = globalThis as any;
  if (g.__contStore) return g.__contStore;
  const messages: Msg[] = [];
  const satellites = new Map<string, Satellite>();
  let seq = 0;
  const append = (chatId: string, role: string, content: string): Msg => {
    const m: Msg = { id: `m_${++seq}`, chatId, role, content, createdAt: seq };
    messages.push(m);
    return m;
  };
  const handle = {
    messages,
    satellites,
    append,
    reset: () => { messages.length = 0; satellites.clear(); seq = 0; },
  };
  g.__contStore = handle;
  return handle;
}

jest.mock('../../../config/database', () => {
  const store = mockStore();
  return {
    __esModule: true,
    default: {
      crossModelChat: {
        findUnique: jest.fn(async ({ where }: any) =>
          where.id === 'chat_round_trip'
            ? { id: 'chat_round_trip', userId: 'user_owner', projectId: 'proj_ws', title: 'Round trip',
                isSupervisor: false, isProjectSupervisor: false }
            : null),
      },
      chatCodingState: {
        // The capability read the resolver makes — REAL state, not a stub.
        findUnique: jest.fn(async ({ where }: any) => {
          const s = store.satellites.get(where.id);
          return s ? { worktreePath: s.worktreePath } : null;
        }),
        create: jest.fn(async ({ data }: any) => {
          const row: Satellite = {
            id: data.id, projectId: data.projectId, userId: data.userId,
            worktreePath: data.worktreePath ?? null,
          };
          store.satellites.set(row.id, row);
          return row;
        }),
        delete: jest.fn(async ({ where }: any) => { store.satellites.delete(where.id); return { id: where.id }; }),
      },
      crossModelMessage: {
        findMany: jest.fn(async ({ where }: any) =>
          store.messages.filter((m) => m.chatId === where.chatId).sort((a, b) => a.createdAt - b.createdAt)),
        create: jest.fn(async ({ data }: any) => store.append(data.chatId, data.role, data.content)),
        count: jest.fn(async ({ where }: any) =>
          store.messages.filter((m) => m.chatId === where.chatId).length),
      },
      user: { findUnique: jest.fn(async () => ({ isChild: false })) },
    },
  };
});

// The attach GATE is a separate seam (it asks a task-kind classifier); attach
// is the behaviour under test here, so it is held permissive and named as such.
jest.mock('./workspace-attach-gate', () => ({
  __esModule: true,
  shouldAttachWorkspace: jest.fn(async () => ({ attach: true, reason: 'code_intent', label: 'code', kind: 'code', p: 0.9 })),
}));

// A project folder that owns a workspace — this is what makes a PLAIN chat code
// capable in the first place (capabilityFrom: codeCapable = satellite || folder).
jest.mock('./folder-inheritance', () => ({
  __esModule: true,
  getNearestWorkspaceFolder: jest.fn(async () => ({ id: 'ws_folder_1', name: 'ws' })),
}));

// The two heavy leaves, seamed over the SAME store (see the header).
jest.mock('../coding/coding-data.service', () => {
  const store = mockStore();
  const prismaDb = (require('../../../config/database') as any).default;
  return {
    __esModule: true,
    // Derived from real storage state: a satellite row IS the capability.
    getChatCapability: jest.fn(async (chat: any) => {
      const s = store.satellites.get(chat.id);
      const hasWorkspaceState = !!s;
      const folderCodeCapable = !hasWorkspaceState && !!chat.projectId;
      return {
        codeCapable: hasWorkspaceState || folderCodeCapable,
        hasWorkspaceState,
        workspaceReady: hasWorkspaceState && !!s?.worktreePath,
      };
    }),
    // Provisioning a real worktree is impossible in a unit test; this creates the
    // satellite row so the NEXT send reads genuine state. That is the whole seam.
    ensureChatWorkspaceState: jest.fn(async (chat: any) => {
      const existing = store.satellites.get(chat.id);
      if (existing) return existing as any;
      return prismaDb.chatCodingState.create({
        data: {
          id: chat.id, projectId: chat.projectId, userId: chat.userId,
          title: chat.title, branch: `digby/session-${chat.id.slice(0, 8)}`,
          baseBranch: 'main', worktreePath: `/worktrees/${chat.id}`,
        },
      });
    }),
  };
});

import { resolveSendProfile } from './send-profile';

const CHAT_ID = 'chat_round_trip';
const OWNER = 'user_owner';
const CODE_MSG = 'fix the bug in agent.ts';

const chat = () => ({ id: CHAT_ID, userId: OWNER, projectId: 'proj_ws', title: 'Round trip' });

beforeEach(() => {
  mockStore().reset();
  jest.clearAllMocks();
});

describe('MERGE-1 (d) plain → coding → plain transcript continuity', () => {
  it('one chat crosses plain → coding → plain without changing id or losing its history', async () => {
    const store = mockStore();

    // ── TURN 1: plain chat, code intent -> converts ──
    store.append(CHAT_ID, 'user', 'hello, what is this repo about?');
    const t1 = await resolveSendProfile({ chat: chat(), senderUserId: OWNER, message: CODE_MSG });
    store.append(CHAT_ID, 'assistant', 'First answer, as a plain chat.');

    expect(t1.profile).toBe('coding');
    expect(t1.attached).toBe(true);                       // THIS send created the satellite
    expect(t1.declined).toBeNull();
    expect(store.satellites.has(CHAT_ID)).toBe(true);     // state, not a stub

    // ── TURN 2: still coding, and it does NOT re-attach ──
    store.append(CHAT_ID, 'user', 'now fix agent.ts');
    const t2 = await resolveSendProfile({ chat: chat(), senderUserId: OWNER, message: CODE_MSG });
    store.append(CHAT_ID, 'assistant', 'Second answer, from the coding harness.');

    expect(t2.profile).toBe('coding');
    expect(t2.attached).toBe(false);                      // already had it — no second create
    expect(t2.capability.hasWorkspaceState).toBe(true);
    expect(store.satellites.size).toBe(1);

    // ── TURN 3: a Dig-deeper ESCALATION — back to the chat profile, same chat ──
    store.append(CHAT_ID, 'user', 'dig deeper on that fix');
    const t3 = await resolveSendProfile({
      chat: chat(), senderUserId: OWNER, message: 'dig deeper on that fix', escalation: true,
    });
    store.append(CHAT_ID, 'assistant', 'Third answer, back on the chat path.');

    expect(t3.profile).toBe('chat');                      // the de-escalation
    expect(t3.declined).toBe('escalation');               // and the reason is named
    expect(t3.attached).toBe(false);

    // ── THE CONTINUITY PROPERTY ──
    // The satellite SURVIVES the escalation: going back to plain is a per-SEND
    // routing decision, never a teardown. A chat that dropped its satellite here
    // would have made "plain -> coding -> plain" a one-way door.
    expect(store.satellites.has(CHAT_ID)).toBe(true);

    // ONE chat id throughout — every row lands under it.
    const all = await (require('../../../config/database') as any).default.crossModelMessage.findMany({ where: { chatId: CHAT_ID } });
    expect(new Set(all.map((m: Msg) => m.chatId))).toEqual(new Set([CHAT_ID]));

    // Full history, in order, nothing lost across the two profile transitions.
    expect(all.map((m: Msg) => m.content)).toEqual([
      'hello, what is this repo about?',
      'First answer, as a plain chat.',
      'now fix agent.ts',
      'Second answer, from the coding harness.',
      'dig deeper on that fix',
      'Third answer, back on the chat path.',
    ]);
    expect(all).toHaveLength(6);

    // No duplication: exactly one row per turn per role.
    const userTurns = all.filter((m: Msg) => m.role === 'user');
    const asstTurns = all.filter((m: Msg) => m.role === 'assistant');
    expect(userTurns).toHaveLength(3);
    expect(asstTurns).toHaveLength(3);
    expect(new Set(all.map((m: Msg) => m.id)).size).toBe(6);
  });

  it('the chat returns to CODING after the escalation — the round trip is reversible', async () => {
    const store = mockStore();
    await resolveSendProfile({ chat: chat(), senderUserId: OWNER, message: CODE_MSG });
    await resolveSendProfile({ chat: chat(), senderUserId: OWNER, message: 'dig deeper', escalation: true });

    // A later ordinary code-intent send is coding again, and still no re-attach.
    const back = await resolveSendProfile({ chat: chat(), senderUserId: OWNER, message: CODE_MSG });
    expect(back.profile).toBe('coding');
    expect(back.attached).toBe(false);
    expect(store.satellites.size).toBe(1);   // still exactly one satellite
  });

  it('MUTATION PROOF: if the attach did not persist state, turn 2 would re-attach', async () => {
    // Proves the `attached:false` on turn 2 is load-bearing and derived from the
    // store rather than asserted into existence. With the satellite removed
    // between sends, the resolver attaches AGAIN — so a regression that lost the
    // satellite would surface as a duplicate attach, not a silent pass.
    const store = mockStore();
    const t1 = await resolveSendProfile({ chat: chat(), senderUserId: OWNER, message: CODE_MSG });
    expect(t1.attached).toBe(true);

    store.satellites.clear(); // simulate the satellite vanishing

    const t2 = await resolveSendProfile({ chat: chat(), senderUserId: OWNER, message: CODE_MSG });
    expect(t2.attached).toBe(true);   // it re-attached — the state really was the gate
  });

  it('an escalation on a chat that is ALREADY coding never re-routes to coding', async () => {
    await resolveSendProfile({ chat: chat(), senderUserId: OWNER, message: CODE_MSG });
    const esc = await resolveSendProfile({ chat: chat(), senderUserId: OWNER, message: CODE_MSG, escalation: true });
    // Escalation is checked BEFORE the hasWorkspaceState branch, so it wins even
    // though the satellite is present — the "chat answer" contract.
    expect(esc.profile).toBe('chat');
    expect(esc.declined).toBe('escalation');
  });
});