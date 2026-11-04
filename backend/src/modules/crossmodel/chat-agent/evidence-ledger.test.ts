/**
 * evidence-ledger.test.ts — unit pins for the authorship-side EVIDENCE LIST
 * (feedback a84cc306). Pure leaf: no mocks, no import graph.
 *
 * Includes the ticket 0e2fcb6f replay pin: the fabricated msg ids the two
 * 2026-09-15 supervisor notes cited (76a0349a, 021383a1) were returned by NO
 * tool — with the ledger maintained in-context they could never have been
 * copied from it, and rule 6 routes the author to "(id not captured)".
 */

import { createEvidenceLedger, EVIDENCE_LEDGER_PREFIX, LEDGER_MAX_LISTED_PER_FAMILY } from './evidence-ledger';

describe('createEvidenceLedger — render gating', () => {
  it('renders null until a harvest-tool result arrives', () => {
    const ledger = createEvidenceLedger();
    expect(ledger.render()).toBeNull();
  });

  it('non-harvest tools never feed the ledger — run_command shas, search_memory content, check_ci', () => {
    const ledger = createEvidenceLedger();
    ledger.ingest('run_command', 'commit 76a0349a1f2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e\n"id": "deadbeefcafe"');
    ledger.ingest('search_memory', 'the supervisor cited msg 021383a1 in chat daee2916 earlier');
    ledger.ingest('check_ci', '{"sha":"a84cc30603a94aa0b93fc2cd54a60585","state":"success"}');
    ledger.ingest('github_list_prs', '[{"id": 12345678, "number": 804}]');
    expect(ledger.render()).toBeNull();
    expect(ledger.size()).toBe(0);
  });

  it('ingest never throws on garbage input', () => {
    const ledger = createEvidenceLedger();
    expect(() => {
      ledger.ingest(undefined, undefined);
      ledger.ingest(null, null);
      ledger.ingest(42, { not: 'a string' });
      ledger.ingest('list_chats', '');
    }).not.toThrow();
    expect(ledger.render()).toBeNull();
  });
});

describe('createEvidenceLedger — family harvest (precision-first maps)', () => {
  it('get_chat_messages: bare "id" fields are msg ids; full uuids normalize to first-8 lowercase', () => {
    const ledger = createEvidenceLedger();
    ledger.ingest('get_chat_messages', JSON.stringify({
      messages: [
        { id: 'B07E8280-aaaa-bbbb-cccc-ddddeeeeffff', role: 'assistant', content: 'note' },
        { id: 'c96e7213-0000-1111-2222-333344445555', role: 'user', content: 'wake' },
      ],
      hasMore: false,
      nextBefore: 'zz-not-an-id',
    }));
    const note = ledger.render()!;
    expect(note).toContain('msg b07e8280, c96e7213');
    expect(note).not.toContain('B07E8280');
    expect(note).not.toContain('zz-not-an-id');
  });

  it('list_chats: bare "id" is a chat id, lastMessageId is a msg id, parentChatId a chat id — projectId is NEVER harvested', () => {
    const ledger = createEvidenceLedger();
    ledger.ingest('list_chats', JSON.stringify({
      chats: [{
        id: 'b92ef13f-c3f8-487e-8267-767e56543150',
        title: 'Nightly lane',
        projectId: 'e5734bd2-7c44-4895-8204-84e456918f18',
        parentChatId: 'daee2916-fa75-4159-94a1-3d767abfd192',
        lastMessageId: '76aa11bb-2222-3333-4444-555566667777',
        running: true,
      }],
      pagination: { page: 1 },
    }));
    const note = ledger.render()!;
    expect(note).toContain('chat b92ef13f, daee2916');
    expect(note).toContain('msg 76aa11bb');
    expect(note).not.toContain('e5734bd2'); // projectId is not a citation family
  });

  it('schedule tools: bare id + named scheduleId land under sched', () => {
    const ledger = createEvidenceLedger();
    ledger.ingest('list_schedules', JSON.stringify({ schedules: [{ id: 'e02e3b15-9999-8888-7777-666655554444', prompt: 'watch' }] }));
    ledger.ingest('schedule_message', JSON.stringify({ id: '104d0f81-aaaa-aaaa-aaaa-aaaaaaaaaaaa', scheduleId: 'e02e3b15-9999-8888-7777-666655554444' }));
    const note = ledger.render()!;
    expect(note).toContain('sched 104d0f81, e02e3b15'); // e02e3b15 re-observed via scheduleId → freshest, listed last
  });

  it('feedback tools: bare id lands under ticket; a ticket context chatId lands under chat; dispatchedTo is NOT harvested', () => {
    const ledger = createEvidenceLedger();
    ledger.ingest('get_feedback', JSON.stringify({
      ticket: {
        id: 'a84cc306-03a9-4aa0-b93f-c2cd54a60585',
        status: 'in_progress',
        context: { chatId: 'c0e22e36-1c74-4295-8049-9b48335c6c37', dispatchedTo: '419fb21d-93f8-414e-9ed8-9bbc9a45d010' },
        userId: '83e4fbf9-e18c-42f1-9bf7-7a99caf9d9c4',
      },
    }));
    const note = ledger.render()!;
    expect(note).toContain('ticket a84cc306');
    expect(note).toContain('chat c0e22e36');
    expect(note).not.toContain('419fb21d'); // dispatchedTo is not a named harvest field
    expect(note).not.toContain('83e4fbf9'); // userId is not a citation family
  });

  it('todo_list: bare id is a todo id; named goalId lands under goal', () => {
    const ledger = createEvidenceLedger();
    ledger.ingest('todo_list', JSON.stringify({
      todos: [{ id: '078bbac3-1111-2222-3333-444455556666', goalId: '4dc6b1d1-7777-6666-5555-444433332222', title: 'step' }],
      count: 1,
    }));
    const note = ledger.render()!;
    expect(note).toContain('todo 078bbac3');
    expect(note).toContain('goal 4dc6b1d1');
  });

  it('todo_get PRECISION GUARD (reviewer N1, feedback a84cc306): the nested goal brief\'s bare id is NOT mislabeled under todo — the named goalId owns it (named-before-bare order)', () => {
    const ledger = createEvidenceLedger();
    // getTodo's todoView shape (goals.service.ts): top-level todo id + named
    // goalId, a nested goal brief carrying a BARE "id" that is the SAME goal
    // id, and dependency briefs whose bare ids really are todos.
    ledger.ingest('todo_get', JSON.stringify({
      id: '078bbac3-1111-2222-3333-444455556666',
      goalId: '4dc6b1d1-7777-6666-5555-444433332222',
      title: 'step',
      status: 'in_progress',
      goal: { id: '4dc6b1d1-7777-6666-5555-444433332222', title: 'parent', status: 'active', projectId: 'e5734bd2-7c44-4895-8204-84e456918f18' },
      dependsOn: [{ id: 'ed5ad2d8-1111-2222-3333-444455556666', title: 'dep', status: 'done' }],
      dependents: [{ id: '9f59d2a3-2222-3333-4444-555566667777', title: 'child', status: 'pending' }],
    }));
    const note = ledger.render()!;
    expect(note).toContain('todo 078bbac3, ed5ad2d8, 9f59d2a3'); // todo + dependency briefs — recall kept
    expect(note).toContain('goal 4dc6b1d1');
    expect(note).not.toMatch(/todo [^·]*4dc6b1d1/); // the goal id NEVER renders under todo
  });

  it('todo_get PRECISION GUARD, bare-before-named order: a goal brief serialized BEFORE the named goalId is purged from todo on the named sighting', () => {
    const ledger = createEvidenceLedger();
    ledger.ingest('todo_get', JSON.stringify({
      id: '078bbac3-1111-2222-3333-444455556666',
      goal: { id: '4dc6b1d1-7777-6666-5555-444433332222', title: 'parent', status: 'active' },
      goalId: '4dc6b1d1-7777-6666-5555-444433332222',
      title: 'step',
    }));
    const note = ledger.render()!;
    expect(note).toContain('todo 078bbac3');
    expect(note).toContain('goal 4dc6b1d1');
    expect(note).not.toMatch(/todo [^·]*4dc6b1d1/);
  });

  it('goal_list PRECISION GUARD: bare ids are NOT harvested (goal rows inline todos + dependency arrays — a mislabeled family teaches a phantom strike); named goalId/todoId still harvest', () => {
    const ledger = createEvidenceLedger();
    ledger.ingest('goal_list', JSON.stringify({
      goals: [{
        id: 'a2e54c5c-aaaa-bbbb-cccc-ddddeeeeffff',
        title: 'spark goal',
        todos: [{ id: 'ed5ad2d8-1111-2222-3333-444455556666', title: 'inline todo', status: 'blocked' }],
        dependsOnGoalIds: ['8ec1f4cd-9999-8888-7777-666655554444'],
      }],
      count: 1,
    }));
    ledger.ingest('todo_update', JSON.stringify({ id: 'ed5ad2d8-1111-2222-3333-444455556666', goalId: 'a2e54c5c-aaaa-bbbb-cccc-ddddeeeeffff', status: 'done' }));
    const note = ledger.render()!;
    // The named goalId from todo_update harvested — but NOT via goal_list's ambiguous bare ids.
    expect(note).toContain('goal a2e54c5c');
    expect(note).not.toContain('8ec1f4cd'); // dependency array entries: no family-safe anchor
    // The inline todo id appears ONLY under todo (via todo_update's bare id), never mislabeled as a goal.
    expect(note).toContain('todo ed5ad2d8');
    expect(note).not.toMatch(/goal [^·]*ed5ad2d8/);
  });

  it('owner-question tools: oq_ values and questionId fields land under oq', () => {
    const ledger = createEvidenceLedger();
    ledger.ingest('list_owner_questions', JSON.stringify({ questions: [{ id: 'oq_9a0e5a3a-bbbb-cccc-dddd-eeeeffff0000', status: 'open' }] }));
    ledger.ingest('flag_owner_question', JSON.stringify({ questionId: 'oq_f16cc02a-1111-2222-3333-444455556666' }));
    const note = ledger.render()!;
    expect(note).toContain('oq oq_9a0e5a3a, oq_f16cc02a');
  });

  it('prose confirmations: "Created chat/goal/todo <id>" harvest into their families', () => {
    const ledger = createEvidenceLedger();
    ledger.ingest('create_chat', 'Created chat f5c2c1f4-898f-467f-8aee-0ddd22f723d8 "CanLaw Supervisor" (mode thinking).');
    ledger.ingest('goal_create', 'Created goal 48c93a9e-1111-2222-3333-444455556666 "R3" (status: active). Decompose it with todo_create(goalId:"48c93a9e-1111-2222-3333-444455556666", ...).');
    const note = ledger.render()!;
    expect(note).toContain('chat f5c2c1f4');
    expect(note).toContain('goal 48c93a9e');
  });
});

describe('createEvidenceLedger — dedupe, recency, caps, note shape', () => {
  it('dedupes re-observed ids (moved freshest), caps the listing per family with "+N more", and a re-observed id survives the cap', () => {
    const ledger = createEvidenceLedger();
    const mk = (n: number) => ({ messages: [{ id: `aaaa00${String(n).padStart(2, '0')}-aaaa-bbbb-cccc-ddddeeeeffff` }] });
    for (let i = 0; i < LEDGER_MAX_LISTED_PER_FAMILY + 3; i++) ledger.ingest('get_chat_messages', JSON.stringify(mk(i)));
    ledger.ingest('get_chat_messages', JSON.stringify(mk(0))); // re-observe the oldest → freshest
    const note = ledger.render()!;
    const msgSeg = note.split('·')[0];
    expect(msgSeg).toContain('(+3 more)'); // 11 distinct ids, LEDGER_MAX_LISTED_PER_FAMILY listed
    expect(msgSeg).toContain('aaaa0000'); // the re-observed id is freshest — survives the cap
    expect(msgSeg).not.toContain('aaaa0001'); // the stalest un-refreshed ids drop behind the cap
    expect(msgSeg).not.toContain('aaaa0002');
    expect(msgSeg).not.toContain('aaaa0003');
    expect(msgSeg).toContain('aaaa0004'); // …while the freshest 8 stay listed, in observation order
  });

  it('the note carries the rule-6 contract: EVIDENCE LIST naming, VERBATIM copy, (id not captured) fallback', () => {
    const ledger = createEvidenceLedger();
    ledger.ingest('list_schedules', JSON.stringify({ schedules: [{ id: 'e02e3b15-9999-8888-7777-666655554444' }] }));
    const note = ledger.render()!;
    expect(note.startsWith(EVIDENCE_LEDGER_PREFIX)).toBe(true);
    expect(note).toContain('EVIDENCE LIST');
    expect(note).toContain('VERBATIM');
    expect(note).toContain('(id not captured)');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// REPLAY PIN (feedback a84cc306): ticket 0e2fcb6f — 2026-09-15 ~20:47–20:54Z,
// TWO supervisor seats (crossmodel daee2916, CanLaw f5c2c1f4) cited msg ids
// 76a0349a and 021383a1 that NO tool result returned (existence-checked: the
// ids exist nowhere — invented, not observed). The pre-delivery guard stripped
// both; this ledger is the authorship-side half: with the harness-maintained
// list in context, the ONLY msg ids in the copy source are ones tools actually
// returned — the phantoms are absent and rule 6 routes the author to
// "(id not captured)".
// ─────────────────────────────────────────────────────────────────────────────
describe('ticket 0e2fcb6f replay (feedback a84cc306) — the ledger excludes the fabricated citations', () => {
  it('the 20:47Z sweep\'s REAL pulls render; the phantom msg ids 76a0349a / 021383a1 do NOT appear', () => {
    const ledger = createEvidenceLedger();
    // The sweep's real pulls — ids from the incident ticket's own record,
    // EXCEPT the sched id: ticket 0e2fcb6f's record cites no schedule id, so
    // e02e3b15-9999-… below is synthetic (reviewer 726f559a N2), standing in
    // for whatever list_schedules pull a real sweep makes.
    ledger.ingest('list_chats', JSON.stringify({
      chats: [
        { id: 'b92ef13f-c3f8-487e-8267-767e56543150', title: 'Nightly Self-Improvement Engineer', running: true, lastMessageId: null, projectId: 'e5734bd2-7c44-4895-8204-84e456918f18' },
        { id: '0b69e9b1-8ed6-4ed0-bf0c-108d06c1ff8c', title: 'terminal-stop lane', running: false, lastMessageId: null, projectId: 'e5734bd2-7c44-4895-8204-84e456918f18' },
      ],
    }));
    ledger.ingest('get_chat_messages', JSON.stringify({
      messages: [{ id: 'b07e8280-1c74-4295-8049-9b48335c6c37', role: 'assistant', content: '065caccb lane latest, unchanged since 20:35:24Z' }],
      hasMore: false,
    }));
    ledger.ingest('list_feedback', JSON.stringify({
      tickets: [
        { id: '065caccb-a3c5-4c45-849e-c9a14f594df5', status: 'in_progress' },
        { id: 'be217b59-0000-1111-2222-333344445555', status: 'in_progress' },
        { id: 'c5228a3d-0000-1111-2222-333344445555', status: 'in_progress' },
      ],
    }));
    ledger.ingest('list_schedules', JSON.stringify({ schedules: [{ id: 'e02e3b15-9999-8888-7777-666655554444', prompt: 'DMG watch' }] }));

    const note = ledger.render()!;
    // Every REAL id the incident note cited (and exonerated) is in the copy source…
    expect(note).toContain('msg b07e8280');
    expect(note).toContain('chat b92ef13f, 0b69e9b1');
    expect(note).toContain('ticket 065caccb, be217b59, c5228a3d');
    expect(note).toContain('sched e02e3b15');
    // …and the two FABRICATED msg citations are absent — no tool returned them,
    // so the ledger can never be their source. Rule 6 then sends the author to
    // "(id not captured)" instead of minting a shape-conformant 8-hex id.
    expect(note).not.toContain('76a0349a');
    expect(note).not.toContain('021383a1');
    expect(note).toContain('(id not captured)');
  });
});
