/**
 * Delegation-upgrade bundle (audit #10+) — unit tests for the pure helpers in
 * delegation.ts: worker model tiering, the structured result envelope
 * (tolerant parse + summary/blocked semantics), and the completed-delegations
 * resume note (splice position pinned against the REAL trimToPreModel).
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../config/database', () => ({ __esModule: true, default: {} }));

import {
  resolveWorkerModel, WORKER_ROLE_SEATS,
  parseWorkerEnvelope,
  buildWorkerSummary,
  renderCompletedDelegationsNote,
  spliceCompletedDelegationsNote,
  COMPLETED_DELEGATIONS_MARKER,
  WORKER_ENVELOPE_INSTRUCTION,
} from './delegation';
import { HELPER_MODEL } from './coding-model';
import { ROLES } from './roles';
import { trimToPreModel } from './run-state';

const ORCH = 'kimi-k3';

describe('resolveWorkerModel (worker model tiering, audit #10; editor re-tiered 2026-09-08)', () => {
  test('the verifier (the only helperTier role) defaults to the helper model; the editor + reasoning roles to the orchestrator model', () => {
    expect(ROLES.verifier.helperTier).toBe(true);
    expect(ROLES.editor.helperTier).toBeUndefined(); // owner 2026-09-08: writers never default to the helper tier
    expect(resolveWorkerModel('verifier', undefined, ORCH)).toBe(HELPER_MODEL);
    expect(resolveWorkerModel('editor', undefined, ORCH)).toBe(ORCH);
    for (const r of ['planner', 'architect', 'explorer', 'web_researcher', 'cross_checker', 'coder', 'editor', 'reviewer'] as const) {
      expect(resolveWorkerModel(r, undefined, ORCH)).toBe(ORCH);
    }
  });

  test('a per-role SEAT model (roadmap item 4) sits between an explicit request and the tier rule; the seat map names the second-opinion / planning / reading roles only', () => {
    expect(resolveWorkerModel('reviewer', undefined, ORCH, HELPER_MODEL, 'deepseek-flash')).toBe('deepseek-flash');
    expect(resolveWorkerModel('reviewer', 'premium', ORCH, HELPER_MODEL, 'deepseek-flash')).toBe(ORCH);   // explicit wins
    expect(resolveWorkerModel('reviewer', 'helper', ORCH, HELPER_MODEL, 'deepseek-flash')).toBe(HELPER_MODEL);
    expect(resolveWorkerModel('reviewer', 'my-ollama:qwen3:32b', ORCH, HELPER_MODEL, 'deepseek-flash')).toBe('my-ollama:qwen3:32b');
    expect(resolveWorkerModel('reviewer', undefined, ORCH, HELPER_MODEL, '')).toBe(ORCH);                 // no seat opinion → rule
    expect(resolveWorkerModel('verifier', undefined, ORCH, HELPER_MODEL, undefined)).toBe(HELPER_MODEL);
    expect(WORKER_ROLE_SEATS).toEqual({
      reviewer: 'coding_reviewer', cross_checker: 'coding_reviewer',
      planner: 'coding_architect', architect: 'coding_architect',
      explorer: 'coding_explorer', web_researcher: 'coding_explorer',
    });
    for (const r of ['coder', 'editor', 'verifier'] as const) expect(WORKER_ROLE_SEATS[r]).toBeUndefined();
  });

  test("explicit tier override wins in both directions: 'premium' escalates a helper role, 'helper' downgrades a premium role", () => {
    expect(resolveWorkerModel('verifier', 'premium', ORCH)).toBe(ORCH);
    expect(resolveWorkerModel('editor', 'premium', ORCH)).toBe(ORCH);
    expect(resolveWorkerModel('editor', 'helper', ORCH)).toBe(HELPER_MODEL); // the explicit downgrade still works
    expect(resolveWorkerModel('coder', 'helper', ORCH)).toBe(HELPER_MODEL);
    expect(resolveWorkerModel('web_researcher', 'helper', ORCH)).toBe(HELPER_MODEL);
  });

  test('a concrete model id from a programmatic caller passes through unchanged', () => {
    expect(resolveWorkerModel('web_researcher', 'deepseek-v4-flash', ORCH)).toBe('deepseek-v4-flash');
  });

  test("the coding_helper role override replaces the helper SEAT everywhere ('helper' tier + helperTier defaults), never 'premium'/passthrough", () => {
    const CUSTOM = 'my-ollama:qwen3:32b'; // Digby Edge model-roles override
    expect(resolveWorkerModel('verifier', undefined, ORCH, CUSTOM)).toBe(CUSTOM);
    expect(resolveWorkerModel('editor', undefined, ORCH, CUSTOM)).toBe(ORCH);    // editor ignores the helper seat by default…
    expect(resolveWorkerModel('editor', 'helper', ORCH, CUSTOM)).toBe(CUSTOM);   // …but an explicit downgrade lands on it
    expect(resolveWorkerModel('coder', 'helper', ORCH, CUSTOM)).toBe(CUSTOM);
    expect(resolveWorkerModel('coder', undefined, ORCH, CUSTOM)).toBe(ORCH);
    expect(resolveWorkerModel('verifier', 'premium', ORCH, CUSTOM)).toBe(ORCH);
    expect(resolveWorkerModel('web_researcher', 'deepseek-v4-flash', ORCH, CUSTOM)).toBe('deepseek-v4-flash');
  });
});

describe('parseWorkerEnvelope (tolerant footer parse)', () => {
  test('fenced JSON footer after prose is parsed and stripped from the prose', () => {
    const text = 'Ran the chain. tsc + tests pass.\n\n```json\n{"status":"done","artifacts":["backend/src/a.ts"]}\n```';
    const p = parseWorkerEnvelope(text);
    expect(p).not.toBeNull();
    expect(p!.envelope).toEqual({ status: 'done', artifacts: ['backend/src/a.ts'] });
    expect(p!.prose).toBe('Ran the chain. tsc + tests pass.');
  });

  test('the LAST valid envelope wins over earlier code fences that are not envelopes', () => {
    const text = 'Here is the fix:\n```ts\nconst x = { status: 1 };\n```\nDone.\n```json\n{"status":"partial"}\n```';
    const p = parseWorkerEnvelope(text);
    expect(p!.envelope.status).toBe('partial');
    expect(p!.prose).toContain('const x = { status: 1 };'); // non-envelope fence kept in prose
  });

  test('bare (unfenced) JSON object in the tail is still found', () => {
    const text = 'Could not reach the API — auth wall.\n{"status":"blocked","blockedReason":"auth required"}';
    const p = parseWorkerEnvelope(text);
    expect(p!.envelope).toEqual({ status: 'blocked', blockedReason: 'auth required' });
    expect(p!.prose).toBe('Could not reach the API — auth wall.');
  });

  test('no envelope → null (prose fallback); invalid status → null; junk fields coerced away', () => {
    expect(parseWorkerEnvelope('plain prose, no JSON at all')).toBeNull();
    expect(parseWorkerEnvelope('x\n```json\n{"status":"finished"}\n```')).toBeNull();
    const p = parseWorkerEnvelope('x\n```json\n{"status":"done","blockedReason":42,"artifacts":["a",7,""]}\n```');
    expect(p!.envelope).toEqual({ status: 'done', artifacts: ['a'] });
  });
});

describe('buildWorkerSummary (envelope drives status; prose keeps legacy behavior)', () => {
  const FALLBACK = '[WORKER FAILED]';

  test('envelope parsed: summary = prose + harness [WORKER STATUS] line, footer stripped', () => {
    const ws = buildWorkerSummary('Did the thing.\n```json\n{"status":"done","artifacts":["x.ts"]}\n```', FALLBACK);
    expect(ws.status).toBe('done');
    expect(ws.blocked).toBe(false);
    expect(ws.summary).toContain('Did the thing.');
    expect(ws.summary).toContain('[WORKER STATUS: done | artifacts: x.ts]');
    expect(ws.summary).not.toContain('```');
  });

  test('envelope-after-prose with blocked PAST the 200-char window is now correctly blocked (the old regex missed it)', () => {
    const longProse = 'Investigated the failing suite in detail. '.repeat(20); // > 800 chars of clean prose
    const text = `${longProse}\nIn the end I was blocked by a missing credential.\n\`\`\`json\n{"status":"blocked","blockedReason":"missing credential"}\n\`\`\``;
    // Pin the premise: the legacy heuristic (head of summary only) would MISS this.
    expect(/\bblocked\b|could not|unable to|failed to/i.test(text.slice(0, 200))).toBe(false);
    const ws = buildWorkerSummary(text, FALLBACK);
    expect(ws.status).toBe('blocked');
    expect(ws.blocked).toBe(true);
    expect(ws.summary).toContain('[WORKER STATUS: blocked — missing credential]');
  });

  test('envelope says done — a scary word in the prose head does NOT mark the todo blocked', () => {
    const ws = buildWorkerSummary('Earlier I could not repro, then fixed it. All green.\n```json\n{"status":"done"}\n```', FALLBACK);
    expect(ws.blocked).toBe(false);
    expect(ws.status).toBe('done');
  });

  test('missing envelope falls back to current behavior: raw text sliced, blocked sniffed from the first 200 chars', () => {
    const ws = buildWorkerSummary('I was unable to complete the migration; details follow.', FALLBACK);
    expect(ws.status).toBe('unknown');
    expect(ws.envelope).toBeNull();
    expect(ws.blocked).toBe(true);
    expect(ws.summary).toBe('I was unable to complete the migration; details follow.');
    // ...and the word past the head does NOT trip it (legacy semantics preserved)
    const late = `${'All good so far. '.repeat(20)}but I was blocked at the end.`;
    expect(buildWorkerSummary(late, FALLBACK).blocked).toBe(false);
  });

  test('empty final text uses the fallback message (worker-failed note)', () => {
    const ws = buildWorkerSummary('', FALLBACK);
    expect(ws.summary).toBe(FALLBACK);
    expect(ws.status).toBe('unknown');
  });

  test('envelope-only reply still yields a readable summary', () => {
    const ws = buildWorkerSummary('```json\n{"status":"partial"}\n```', FALLBACK);
    expect(ws.status).toBe('partial');
    expect(ws.summary).toContain('(worker returned only a status envelope)');
  });

  test('the instruction workers receive documents the exact contract', () => {
    expect(WORKER_ENVELOPE_INSTRUCTION).toContain('"status"');
    expect(WORKER_ENVELOPE_INSTRUCTION).toContain('blockedReason');
    expect(WORKER_ENVELOPE_INSTRUCTION).toContain('artifacts');
  });
});

describe('completed-delegations resume note (splice position vs trimToPreModel)', () => {
  const done = [{ title: 'Verify pass', role: 'verifier', status: 'done', summary: 'All   green\nacross the chain.' }];

  test('note is spliced BEFORE the in-flight assistant tool_calls turn and survives trimToPreModel; the turn itself is rewound', () => {
    const messages = [
      { role: 'system', content: 'doctrine' },
      { role: 'user', content: 'do the task' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'a1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'a1', content: 'earlier completed turn result' },
      { role: 'assistant', content: 'now delegating', tool_calls: [{ id: 'b1', type: 'function', function: { name: 'delegate', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'b1', content: 'worker summary' },
    ];
    const snap = spliceCompletedDelegationsNote(messages, done);
    expect(messages).toHaveLength(6); // input untouched (pure copy)
    expect(snap).toHaveLength(7);
    expect(snap[4].role).toBe('user');
    expect(snap[4].content).toContain(COMPLETED_DELEGATIONS_MARKER);
    expect(snap[4].content).toContain('Verify pass (verifier) → done: All green across the chain.'); // whitespace collapsed

    const trimmed = trimToPreModel(snap);
    // The in-flight turn (assistant + its tool result) is rewound; the note survives as the tail.
    expect(trimmed[trimmed.length - 1].content).toContain(COMPLETED_DELEGATIONS_MARKER);
    expect(trimmed.some(m => m.tool_call_id === 'b1')).toBe(false);
    // Earlier completed turns are untouched.
    expect(trimmed.some(m => m.tool_call_id === 'a1')).toBe(true);
  });

  test('no completed delegations → snapshot unchanged (copy)', () => {
    const messages = [{ role: 'system', content: 's' }, { role: 'assistant', content: '', tool_calls: [{ id: 'x' }] }];
    const snap = spliceCompletedDelegationsNote(messages, []);
    expect(snap).toEqual(messages);
    expect(snap).not.toBe(messages);
  });

  test('note render caps entries and summary length', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ title: `w${i}`, role: 'explorer', status: 'done', summary: 'x'.repeat(500) }));
    const note = renderCompletedDelegationsNote(many);
    expect(note).not.toContain('- w7 '); // only the last 12 kept (w8..w19)
    expect(note).toContain('- w8 ');
    expect(note).toContain('- w19 ');
    const bullets = note.split('\n').filter(l => l.startsWith('- '));
    expect(bullets).toHaveLength(12);
    expect(bullets.every(l => l.length <= 260)).toBe(true); // 200-char summary cap + label
  });
});
