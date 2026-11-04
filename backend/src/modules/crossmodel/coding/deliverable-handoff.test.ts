/**
 * Deliverable hand-off (cohesive chat wave, branch C — 2026-09-27).
 *
 * Hermetic: every side effect rides the injected HandoffDeps (a fake worktree
 * listing + byte reader, fake receipts, fake chat/file/message stores). Covers
 * the pure selectors (shapes, exclusions, caps, git-unchanged exclusion), the
 * named replay (the DGX deck: deck/cql-dgx-b300-deck.pdf + .pptx + slides.html),
 * the two-uploads-one-message-one-event contract, idempotence, size caps,
 * top-level sessions, the LINEAGE gate (a continuation / schedule firing on a
 * human-asked child posts; a supervisor-parented lane is skipped), the
 * modified-tracked-text-is-a-change rule, the per-run total budget, the
 * one-file-at-a-time copy + deadline stop, the hook note, the kill switch and
 * the safe wrapper.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  selectDeliverables,
  isDeliverablePath,
  prsFromReceipts,
  buildResultMessage,
  summaryHead,
  deliverableMime,
  deliverableMaxBytes,
  deliverableMaxFiles,
  describeHandoff,
  walkWorktree,
  runDeliverableHandoff,
  runDeliverableHandoffSafe,
  handoffHookNote,
  isSupervisorClassChat,
  DELIVERABLE_HANDOFF_ALL_ORIGINS_ENV,
  DELIVERABLE_HANDOFF_ORIGIN_GATE_ENV,
  DELIVERABLE_HANDOFF_SUPERVISOR_PARENTS_ENV,
  DELIVERABLE_MAX_BYTES_ENV,
  DELIVERABLE_MAX_FILES_ENV,
  DELIVERABLE_MAX_TOTAL_BYTES_ENV,
  DELIVERABLE_MAX_BYTES_CEILING,
  DELIVERABLE_MAX_FILES_DEFAULT,
  DELIVERABLE_MAX_TOTAL_BYTES_DEFAULT,
  HANDOFF_MESSAGE_KIND,
  HANDOFF_MESSAGE_ORIGIN,
  deliverableMaxTotalBytes,
  type HandoffChat,
  type HandoffDeps,
  type HandoffInput,
  type HandoffRecord,
  type WorktreeFileEntry,
} from './deliverable-handoff';
import type { ToolReceipt } from './run-receipts';

const T0 = Date.parse('2026-09-27T20:00:00.000Z');
const NOW = new Date(T0 + 10 * 60_000);
const SESSION = 'sess-9dfade89-aaaa-bbbb-cccc-000000000001';
const PARENT = 'chat-parent-0000-bbbb-cccc-000000000002';
const RUN = 'run-0000-1111-2222-333333333333';
const USER = 'user-1';

const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(1200, 0x41)]);
const PPTX = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(2000, 0x42)]);
const HTML = Buffer.from('<!doctype html><html><body><h1>DGX B300</h1></body></html>');

/** The DGX deck case — the owner's replay (branch digby/session-9dfade89, no remote). */
const DGX_LISTING: WorktreeFileEntry[] = [
  { rel: 'deck/cql-dgx-b300-deck.pdf', bytes: PDF.length, mtimeMs: T0 + 60_000 },
  { rel: 'deck/cql-dgx-b300-deck.pptx', bytes: PPTX.length, mtimeMs: T0 + 61_000 },
  { rel: 'deck/slides.html', bytes: HTML.length, mtimeMs: T0 + 62_000 },
  // repo plumbing touched by the same run — never a deliverable
  { rel: 'package.json', bytes: 400, mtimeMs: T0 + 63_000 },
  { rel: 'README.md', bytes: 900, mtimeMs: T0 + 63_000 },
  { rel: 'src/index.ts', bytes: 300, mtimeMs: T0 + 64_000 },
  // pre-run files (checkout time) — not this run's
  { rel: 'docs/old-report.pdf', bytes: 5000, mtimeMs: T0 - 3_600_000 },
];
const DGX_BYTES: Record<string, Buffer> = {
  'deck/cql-dgx-b300-deck.pdf': PDF,
  'deck/cql-dgx-b300-deck.pptx': PPTX,
  'deck/slides.html': HTML,
};

const prReceipt = (n: number, url: string, ok = true): ToolReceipt => ({
  id: `r-${n}`, chatId: SESSION, runId: RUN, tool: 'open_pull_request', ok, ids: ok ? { prNumber: n, url } : {},
  inputHash: null, outputHash: null, createdAt: new Date(T0 + 70_000),
});

interface FakeWorld {
  deps: HandoffDeps;
  chats: Map<string, HandoffChat>;
  persisted: Array<{ chatId: string; userId: string; uploadId: string; filename: string; mimeType: string; bytes: number }>;
  /** One entry per persistFiles CALL (the copy is one file at a time). */
  persistCalls: number[];
  messages: Array<{ id: string; chatId: string; content: string; metadata: Record<string, unknown> }>;
  events: Array<{ chatId: string; payload: any }>;
  cards: Array<{ chatId: string; payload: any }>;
  claims: Set<string>;
  records: Map<string, HandoffRecord>;
  metrics: any[];
  canvasCopies: Array<{ chatId: string; title: string }>;
}

function world(opts: {
  listing?: WorktreeFileEntry[];
  bytes?: Record<string, Buffer>;
  receipts?: ToolReceipt[];
  parent?: boolean;
  parentUser?: string;
  /** The parent is a Fleet ('fleet') or Project ('project') Supervisor chat. */
  parentSupervisor?: 'fleet' | 'project';
  completedRuns?: number;
  canvases?: Array<{ id: string; title: string; type: string; language: string | null; content: string }>;
  trackedUnchanged?: Set<string> | null;
  preexisting?: Set<string>;
} = {}): FakeWorld {
  const chats = new Map<string, HandoffChat>();
  chats.set(SESSION, { id: SESSION, userId: USER, parentChatId: opts.parent === false ? null : PARENT, title: 'DGX B300 deck' });
  if (opts.parent !== false) {
    chats.set(PARENT, {
      id: PARENT, userId: opts.parentUser ?? USER, parentChatId: null, title: opts.parentSupervisor ? 'Digby Supervisor' : 'Paul',
      isSupervisor: opts.parentSupervisor === 'fleet', isProjectSupervisor: opts.parentSupervisor === 'project',
    });
  }
  const w: FakeWorld = {
    chats, persisted: [], persistCalls: [], messages: [], events: [], cards: [], claims: new Set(), records: new Map(), metrics: [], canvasCopies: [],
    deps: {
      findChat: async (id) => chats.get(id) ?? null,
      countCompletedRuns: async () => opts.completedRuns ?? 1,
      getRunReceipts: async () => opts.receipts ?? [],
      listWorktree: async () => opts.listing ?? DGX_LISTING,
      gitClasses: async () => (opts.trackedUnchanged === undefined && opts.preexisting === undefined)
        ? null
        : { unchanged: opts.trackedUnchanged ?? new Set(), preexisting: opts.preexisting ?? new Set() },
      readFile: async (_root, rel) => (opts.bytes ?? DGX_BYTES)[rel] ?? null,
      listCanvases: async () => opts.canvases ?? [],
      copyCanvas: async (chatId, _u, c) => { w.canvasCopies.push({ chatId, title: c.title }); return { id: `copy-${c.id}` }; },
      persistFiles: async (chatId, userId, loaded) => {
        w.persistCalls.push(loaded.length);
        for (const l of loaded) {
          if (w.persisted.some((p) => p.chatId === chatId && p.uploadId === l.id)) continue; // (uploadId, chatId) unique
          w.persisted.push({ chatId, userId, uploadId: l.id, filename: l.attachment.filename, mimeType: l.attachment.mimeType ?? '', bytes: Buffer.from(l.attachment.base64 ?? '', 'base64').length });
        }
      },
      findChatFiles: async (chatId, ids) => w.persisted.filter((p) => p.chatId === chatId && ids.includes(p.uploadId)).map((p, i) => ({ id: `file-${p.uploadId.slice(3, 9)}`, uploadId: p.uploadId, sizeBytes: p.bytes + 0 * i })),
      appendMessage: async (chatId, content, metadata) => { const id = `msg-${w.messages.length + 1}`; w.messages.push({ id, chatId, content, metadata }); return { id }; },
      claim: async (sessionId, runId) => { const k = `${sessionId}/${runId}`; if (w.claims.has(k)) return false; w.claims.add(k); return true; },
      releaseClaim: async (sessionId, runId) => { w.claims.delete(`${sessionId}/${runId}`); },
      saveRecord: async (sessionId, record) => { w.records.set(sessionId, record); },
      emitTask: (chatId, payload) => { w.events.push({ chatId, payload }); },
      persistTaskCard: async (chatId, payload) => { w.cards.push({ chatId, payload }); return null; },
      recordMetric: (m) => { w.metrics.push(m); },
    },
  };
  return w;
}

const input = (over: Partial<HandoffInput> = {}): HandoffInput => ({
  runId: RUN, sessionId: SESSION, userId: USER, worktreeRoot: '/work/' + SESSION, baseBranch: 'main',
  runStartedAt: new Date(T0), finalText: 'Built the DGX B300 deck: 12 slides, exported to PDF and PPTX under deck/. The HTML preview is deck/slides.html.',
  sessionTitle: 'DGX B300 deck', triggerKind: 'machine', now: NOW, ...over,
});

beforeEach(() => {
  for (const k of [
    DELIVERABLE_HANDOFF_ALL_ORIGINS_ENV, DELIVERABLE_HANDOFF_ORIGIN_GATE_ENV,
    DELIVERABLE_HANDOFF_SUPERVISOR_PARENTS_ENV,
    DELIVERABLE_MAX_BYTES_ENV, DELIVERABLE_MAX_FILES_ENV, DELIVERABLE_MAX_TOTAL_BYTES_ENV,
  ]) delete process.env[k];
});

describe('deliverable shapes (pure)', () => {
  it('accepts the deliverable extensions outside excluded / dot / scaffold territory', () => {
    for (const p of ['deck/a.pdf', 'out-of-band/report.docx', 'x.xlsx', 'data/rows.csv', 'img/a.png', 'img/b.JPG', 'img/c.jpeg', 'img/d.svg', 'site/index.html', 'notes/summary.md', 'bundle.zip', 'export/result.json']) {
      expect(isDeliverablePath(p)).toBe(true);
    }
  });
  it('refuses build dirs, dot-dirs, dotfiles, scaffold names and non-deliverable extensions', () => {
    for (const p of ['node_modules/x/a.pdf', 'dist/a.html', 'build/b.png', '.digby/rules/00-current-state.md', '.github/pull_request_template.md',
      '.hidden.md', 'package.json', 'tsconfig.build.json', 'README.md', 'CLAUDE.md', 'src/index.ts', 'a.exe', '', 'a/../b.pdf', 'C:\\x.pdf']) {
      expect(isDeliverablePath(p)).toBe(false);
    }
  });
  it('selectDeliverables: mtime ≥ run start (minus slack), shape rules, per-file cap, newest kept under the file cap, path order', () => {
    const sel = selectDeliverables(DGX_LISTING, { runStartedMs: T0, maxFiles: 12, maxBytes: 25 * 1024 * 1024 });
    expect(sel.files.map((f) => f.rel)).toEqual(['deck/cql-dgx-b300-deck.pdf', 'deck/cql-dgx-b300-deck.pptx', 'deck/slides.html']);
    expect(sel).toMatchObject({ skippedTooLarge: 0, truncated: 0, candidates: 3 });
    // slack: a write 3 s before the claim still counts; 10 s before does not
    const s2 = selectDeliverables([{ rel: 'a.pdf', bytes: 1, mtimeMs: T0 - 3000 }, { rel: 'b.pdf', bytes: 1, mtimeMs: T0 - 10_000 }], { runStartedMs: T0, maxFiles: 5, maxBytes: 100 });
    expect(s2.files.map((f) => f.rel)).toEqual(['a.pdf']);
  });
  it('selectDeliverables: size cap counts skipped files; file cap keeps the NEWEST and counts the rest', () => {
    const big = selectDeliverables([{ rel: 'a.pdf', bytes: 101, mtimeMs: T0 + 1 }, { rel: 'b.pdf', bytes: 99, mtimeMs: T0 + 1 }], { runStartedMs: T0, maxFiles: 5, maxBytes: 100 });
    expect(big.files.map((f) => f.rel)).toEqual(['b.pdf']);
    expect(big.skippedTooLarge).toBe(1);
    const many = Array.from({ length: 15 }, (_, i) => ({ rel: `f/${String(i).padStart(2, '0')}.png`, bytes: 10, mtimeMs: T0 + i * 1000 }));
    const cap = selectDeliverables(many, { runStartedMs: T0, maxFiles: 12, maxBytes: 100 });
    expect(cap.files).toHaveLength(12);
    expect(cap.truncated).toBe(3);
    expect(cap.files.map((f) => f.rel)).toEqual(many.slice(3).map((f) => f.rel)); // the 12 newest, in path order
  });
  it('selectDeliverables: git-tracked-and-unchanged paths are excluded even with a fresh mtime (a rebase-touched file is not a deliverable)', () => {
    const listing = [{ rel: 'docs/report.md', bytes: 10, mtimeMs: T0 + 1 }, { rel: 'deck/new.pdf', bytes: 10, mtimeMs: T0 + 1 }];
    const sel = selectDeliverables(listing, { runStartedMs: T0, maxFiles: 5, maxBytes: 100, excludePaths: new Set(['docs/report.md']) });
    expect(sel.files.map((f) => f.rel)).toEqual(['deck/new.pdf']);
  });
  it('selectDeliverables: a MODIFIED pre-existing repo-text shape (md json html csv svg) is a change, not a deliverable; a NEW one and a pre-existing binary still ship', () => {
    const listing = [
      { rel: 'docs/results.md', bytes: 10, mtimeMs: T0 + 1 },      // existed on base, modified → change
      { rel: 'site/index.html', bytes: 10, mtimeMs: T0 + 1 },      // existed on base, modified → change
      { rel: 'data/export.json', bytes: 10, mtimeMs: T0 + 1 },     // existed on base, modified → change
      { rel: 'reports/new-report.md', bytes: 10, mtimeMs: T0 + 1 }, // new → deliverable
      { rel: 'deck/old-deck.pdf', bytes: 10, mtimeMs: T0 + 1 },    // existed on base, regenerated → still a deliverable (binary)
    ];
    const preexistingPaths = new Set(['docs/results.md', 'site/index.html', 'data/export.json', 'deck/old-deck.pdf']);
    const sel = selectDeliverables(listing, { runStartedMs: T0, maxFiles: 12, maxBytes: 100, preexistingPaths });
    expect(sel.files.map((f) => f.rel)).toEqual(['deck/old-deck.pdf', 'reports/new-report.md']);
    expect(sel.treatedAsChange).toBe(3);
  });
  it('selectDeliverables: the per-RUN total budget keeps the NEWEST files that fit and counts the rest (on top of the per-file cap)', () => {
    const listing = [
      { rel: 'a.pdf', bytes: 40, mtimeMs: T0 + 1000 },
      { rel: 'b.pdf', bytes: 40, mtimeMs: T0 + 2000 },
      { rel: 'c.pdf', bytes: 40, mtimeMs: T0 + 3000 }, // newest
      { rel: 'd.pdf', bytes: 500, mtimeMs: T0 + 4000 }, // over the per-file cap — never in the budget math
    ];
    const sel = selectDeliverables(listing, { runStartedMs: T0, maxFiles: 12, maxBytes: 100, maxTotalBytes: 90 });
    expect(sel.files.map((f) => f.rel)).toEqual(['b.pdf', 'c.pdf']);
    expect(sel).toMatchObject({ skippedOverBudget: 1, skippedTooLarge: 1, truncated: 0, candidates: 3 });
    expect(deliverableMaxTotalBytes()).toBe(DELIVERABLE_MAX_TOTAL_BYTES_DEFAULT);
    process.env[DELIVERABLE_MAX_TOTAL_BYTES_ENV] = '50';
    expect(deliverableMaxTotalBytes()).toBe(50);
    expect(selectDeliverables(listing, { runStartedMs: T0, maxFiles: 12, maxBytes: 100 }).files.map((f) => f.rel)).toEqual(['c.pdf']);
  });
  it('isSupervisorClassChat: fleet or project supervisor flags', () => {
    expect(isSupervisorClassChat({ isSupervisor: true })).toBe(true);
    expect(isSupervisorClassChat({ isProjectSupervisor: true })).toBe(true);
    expect(isSupervisorClassChat({})).toBe(false);
    expect(isSupervisorClassChat(null)).toBe(false);
  });
  it('handoffHookNote: names the message, the chat and the artifacts when a hand-off posted; empty otherwise', () => {
    const posted = {
      posted: true, targetChatId: PARENT, parentChatId: PARENT, resultMessageId: 'msg-9', worktreeLocal: true,
      artifacts: [{ name: 'deck/a.pdf', bytes: 1, url: 'u', kind: 'file' as const }, { name: 'PR #12', bytes: 0, url: 'p', kind: 'pr' as const }],
      files: 1, prs: 1, canvases: 0, bytes: 1, skippedTooLarge: 0, truncated: 0, skippedOverBudget: 0, treatedAsChange: 0, deduped: 0, pruned: 0,
    };
    const note = handoffHookNote(posted);
    expect(note).toContain('[DELIVERABLES ALREADY POSTED on chat ' + PARENT + ' (message msg-9): deck/a.pdf, PR #12.');
    expect(note).toContain('do not re-post, re-stage or re-narrate');
    expect(note).toContain("never send the user to the session's Files tab");
    expect(handoffHookNote({ ...posted, posted: false })).toBe('');
    expect(handoffHookNote(null)).toBe('');
  });
  it('caps read the env (positive ints) and the byte cap never exceeds the ChatFile ceiling', () => {
    expect(deliverableMaxFiles()).toBe(DELIVERABLE_MAX_FILES_DEFAULT);
    process.env[DELIVERABLE_MAX_FILES_ENV] = '3';
    expect(deliverableMaxFiles()).toBe(3);
    process.env[DELIVERABLE_MAX_FILES_ENV] = 'nope';
    expect(deliverableMaxFiles()).toBe(DELIVERABLE_MAX_FILES_DEFAULT);
    process.env[DELIVERABLE_MAX_BYTES_ENV] = String(100 * 1024 * 1024);
    expect(deliverableMaxBytes()).toBe(DELIVERABLE_MAX_BYTES_CEILING);
    process.env[DELIVERABLE_MAX_BYTES_ENV] = '1024';
    expect(deliverableMaxBytes()).toBe(1024);
  });
  it('prsFromReceipts: ok open_pull_request receipts only, deduped by number', () => {
    const prs = prsFromReceipts([prReceipt(12, 'https://github.com/o/r/pull/12'), prReceipt(12, 'https://github.com/o/r/pull/12'), prReceipt(13, 'x', false),
      { ...prReceipt(1, 'u'), tool: 'git_push' }]);
    expect(prs).toEqual([{ prNumber: 12, url: 'https://github.com/o/r/pull/12' }]);
  });
  it('deliverableMime: magic bytes for binaries (zip magic keeps the office type), extension otherwise', () => {
    expect(deliverableMime('deck/a.pdf', PDF)).toBe('application/pdf');
    expect(deliverableMime('deck/a.pptx', PPTX)).toBe('application/vnd.openxmlformats-officedocument.presentationml.presentation');
    expect(deliverableMime('deck/slides.html', HTML)).toBe('text/html');
    expect(deliverableMime('x.unknown', null)).toBe('application/octet-stream');
  });
  it('summaryHead cuts on a sentence and marks the cut', () => {
    expect(summaryHead('short')).toBe('short');
    const long = `${'First sentence here. '.repeat(20)}Tail`;
    const head = summaryHead(long, 120);
    expect(head.length).toBeLessThanOrEqual(122);
    expect(head.endsWith('. …')).toBe(true);
    expect(summaryHead('')).toBe('');
  });
  it('buildResultMessage: title, summary, one link line per file / PR, canvas note, caps note, from-session footer on the parent only', () => {
    const msg = buildResultMessage({
      sessionTitle: 'DGX B300 deck', sessionId: SESSION, runId: RUN, summary: 'Done.', targetIsParent: true, skippedTooLarge: 1, truncated: 2,
      artifacts: [
        { name: 'deck/a.pdf', bytes: 1536, url: '/api/crossmodel/files/f1/download', kind: 'file' },
        { name: 'PR #12', bytes: 0, url: 'https://github.com/o/r/pull/12', kind: 'pr' },
        { name: 'Outline', bytes: 40, url: 'canvas:c1', kind: 'canvas' },
      ],
    });
    expect(msg).toContain('**Result: DGX B300 deck**');
    expect(msg).toContain('Done.');
    expect(msg).toContain('- [deck/a.pdf](/api/crossmodel/files/f1/download) (1.5 KB)');
    expect(msg).toContain('- [PR #12](https://github.com/o/r/pull/12)');
    expect(msg).toContain('- Canvas "Outline"');
    expect(msg).toContain('1 file over the size cap');
    expect(msg).toContain('2 more changed files');
    expect(msg).toContain(`_From session ${SESSION.slice(0, 8)} · run ${RUN.slice(0, 8)}_`);
    const self = buildResultMessage({ sessionTitle: 'X', sessionId: SESSION, runId: RUN, summary: '', targetIsParent: false, artifacts: [] });
    expect(self).not.toContain('From session');
    expect(self).toContain('produced no files');
  });
  it('describeHandoff names counts, destination and up to four file names', () => {
    const rec: HandoffRecord = {
      runId: RUN, sessionId: SESSION, targetChatId: PARENT, parentChatId: PARENT, postedAt: NOW.toISOString(), resultMessageId: 'm',
      artifacts: Array.from({ length: 6 }, (_, i) => ({ name: `f${i}.pdf`, bytes: 1, url: 'u', kind: 'file' as const })),
      files: 6, prs: 0, canvases: 1, bytes: 6, skippedTooLarge: 0, truncated: 0,
    };
    expect(describeHandoff(rec)).toBe('Delivered 6 files and 1 canvas to the parent chat: f0.pdf, f1.pdf, f2.pdf, f3.pdf, … (+2)');
    expect(describeHandoff({ ...rec, parentChatId: null, files: 0, canvases: 0, artifacts: [] })).toBe('Delivered the result to this chat');
  });
});

describe('walkWorktree (real fs, bounded)', () => {
  it('lists deliverable-shaped regular files with size + mtime, skipping excluded / dot dirs and symlinks', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dh-walk-'));
    try {
      await fs.mkdir(path.join(root, 'deck'), { recursive: true });
      await fs.mkdir(path.join(root, 'node_modules/x'), { recursive: true });
      await fs.mkdir(path.join(root, '.digby'), { recursive: true });
      await fs.writeFile(path.join(root, 'deck/cql-dgx-b300-deck.pdf'), PDF);
      await fs.writeFile(path.join(root, 'deck/slides.html'), HTML);
      await fs.writeFile(path.join(root, 'node_modules/x/a.pdf'), PDF);
      await fs.writeFile(path.join(root, '.digby/state.md'), '# s');
      await fs.writeFile(path.join(root, 'README.md'), '# r');
      await fs.writeFile(path.join(root, 'index.ts'), 'x');
      await fs.symlink(path.join(root, 'deck/slides.html'), path.join(root, 'link.html'));
      const entries = await walkWorktree(root);
      expect(entries.map((e) => e.rel).sort()).toEqual(['deck/cql-dgx-b300-deck.pdf', 'deck/slides.html']);
      const pdf = entries.find((e) => e.rel.endsWith('.pdf'))!;
      expect(pdf.bytes).toBe(PDF.length);
      expect(pdf.mtimeMs).toBeGreaterThan(0);
      expect(await walkWorktree(path.join(root, 'missing'))).toEqual([]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe('runDeliverableHandoff — the DGX deck replay (named)', () => {
  it('child run ⇒ the three deck files land on the PARENT as chat uploads, ONE result message with three links + the PR, ONE task event (done, artifacts), a record + a metric', async () => {
    const w = world({ receipts: [prReceipt(12, 'https://github.com/o/r/pull/12')] });
    const r = await runDeliverableHandoff(input(), w.deps);
    expect(r.posted).toBe(true);
    expect(r).toMatchObject({ targetChatId: PARENT, parentChatId: PARENT, files: 3, prs: 1, canvases: 0, bytes: PDF.length + PPTX.length + HTML.length, worktreeLocal: true });

    // uploads on the PARENT only, one per deck file, real bytes + mime
    expect(w.persisted.map((p) => [p.chatId, p.filename, p.mimeType, p.bytes])).toEqual([
      [PARENT, 'cql-dgx-b300-deck.pdf', 'application/pdf', PDF.length],
      [PARENT, 'cql-dgx-b300-deck.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', PPTX.length],
      [PARENT, 'slides.html', 'text/html', HTML.length],
    ]);

    // ONE message on the parent with the summary head + one link per artifact
    expect(w.messages).toHaveLength(1);
    const [msg] = w.messages;
    expect(msg.chatId).toBe(PARENT);
    expect(msg.content).toContain('**Result: DGX B300 deck**');
    expect(msg.content).toContain('Built the DGX B300 deck: 12 slides');
    const links = msg.content.match(/\]\(\/api\/crossmodel\/files\/[^)]+\/download\)/g) ?? [];
    expect(links).toHaveLength(3);
    expect(msg.content).toContain('[deck/cql-dgx-b300-deck.pdf](/api/crossmodel/files/');
    expect(msg.content).toContain('[deck/cql-dgx-b300-deck.pptx](/api/crossmodel/files/');
    expect(msg.content).toContain('[deck/slides.html](/api/crossmodel/files/');
    expect(msg.content).toContain('- [PR #12](https://github.com/o/r/pull/12)');
    expect(msg.content).not.toContain('package.json');
    expect(msg.content).not.toContain('old-report');
    expect(msg.metadata).toMatchObject({ kind: HANDOFF_MESSAGE_KIND, origin: HANDOFF_MESSAGE_ORIGIN, harness: true, runId: RUN, childChatId: SESSION });
    // ONE persist call PER FILE — read → persist → release, never an accumulated batch
    expect(w.persistCalls).toEqual([1, 1, 1]);
    expect((msg.metadata.artifacts as any[]).map((a) => a.kind)).toEqual(['file', 'file', 'file', 'pr']);

    // ONE task event on the parent stream: the shared contract shape
    expect(w.events).toHaveLength(1);
    const { payload } = w.events[0];
    expect(w.events[0].chatId).toBe(PARENT);
    expect(payload).toMatchObject({
      taskId: `session:${SESSION}`, chatId: PARENT, childChatId: SESSION, kind: 'session', status: 'done', title: 'DGX B300 deck',
      steps: { done: 0, total: 0 }, receipts: { ok: 1, total: 1 }, spendUsd: 0, startedAt: new Date(T0).toISOString(), updatedAt: NOW.toISOString(),
      resultMessageId: 'msg-1',
    });
    expect(payload.artifacts).toHaveLength(4);
    expect(payload.artifacts[0]).toEqual({ name: 'deck/cql-dgx-b300-deck.pdf', bytes: PDF.length, url: expect.stringMatching(/^\/api\/crossmodel\/files\/.+\/download$/), kind: 'file' });
    expect(payload.artifacts[3]).toEqual({ name: 'PR #12', bytes: 0, url: 'https://github.com/o/r/pull/12', kind: 'pr' });
    expect(w.cards).toHaveLength(1);

    // record for the status card + telemetry
    const rec = w.records.get(SESSION)!;
    expect(rec).toMatchObject({ runId: RUN, targetChatId: PARENT, parentChatId: PARENT, files: 3, prs: 1, canvases: 0, resultMessageId: 'msg-1' });
    expect(w.metrics).toHaveLength(1);
    expect(w.metrics[0]).toMatchObject({ kind: 'deliverable_handoff', sessionId: SESSION, runId: RUN, value: 3,
      meta: { runId: RUN, parentChatId: PARENT, targetChatId: PARENT, files: 3, prs: 1, canvases: 0, bytes: PDF.length + PPTX.length + HTML.length, posted: true, trigger: 'machine' } });
  });

  it('IDEMPOTENT: a re-finalize of the same run posts nothing (claim held), a different run posts again', async () => {
    const w = world();
    const first = await runDeliverableHandoff(input(), w.deps);
    expect(first.posted).toBe(true);
    const again = await runDeliverableHandoff(input(), w.deps);
    expect(again).toMatchObject({ posted: false, skipped: 'already' });
    expect(w.messages).toHaveLength(1);
    expect(w.events).toHaveLength(1);
    expect(w.persisted).toHaveLength(3);
    const other = await runDeliverableHandoff(input({ runId: 'run-2222-1111-2222-333333333333' }), w.deps);
    expect(other.posted).toBe(true);
    expect(w.messages).toHaveLength(2);
  });

  it('a failure BEFORE the post releases the claim (a retry can post); the metric records posted:false', async () => {
    const w = world();
    const boom = jest.fn(async () => { throw new Error('pg down'); });
    const first = await runDeliverableHandoff(input(), { ...w.deps, persistFiles: boom });
    expect(first).toMatchObject({ posted: false, skipped: 'error' });
    expect(w.messages).toHaveLength(0);
    expect(w.metrics[0]).toMatchObject({ kind: 'deliverable_handoff', meta: { posted: false, error: 'pg down' } });
    const retry = await runDeliverableHandoff(input(), w.deps);
    expect(retry.posted).toBe(true);
  });

  it('SIZE CAPS: a file over DELIVERABLE_MAX_BYTES stays behind (named in the note); DELIVERABLE_MAX_FILES keeps the newest', async () => {
    process.env[DELIVERABLE_MAX_BYTES_ENV] = String(PPTX.length - 1);
    const w = world();
    const r = await runDeliverableHandoff(input(), w.deps);
    expect(r.files).toBe(2);
    expect(r.skippedTooLarge).toBe(1);
    expect(w.persisted.map((p) => p.filename)).toEqual(['cql-dgx-b300-deck.pdf', 'slides.html']);
    expect(w.messages[0].content).toContain('1 file over the size cap');
    expect(w.events[0].payload.note).toContain('1 over the size cap');

    delete process.env[DELIVERABLE_MAX_BYTES_ENV];
    process.env[DELIVERABLE_MAX_FILES_ENV] = '1';
    const w2 = world();
    const r2 = await runDeliverableHandoff(input(), w2.deps);
    expect(r2.files).toBe(1);
    expect(r2.truncated).toBe(2);
    expect(w2.persisted.map((p) => p.filename)).toEqual(['slides.html']); // the newest mtime
  });

  it('TOP-LEVEL session (no parent): the result message with links lands on the session chat itself; canvases are not copied', async () => {
    const w = world({ parent: false, canvases: [{ id: 'c1', title: 'Outline', type: 'document', language: null, content: 'abc' }] });
    const r = await runDeliverableHandoff(input(), w.deps);
    expect(r).toMatchObject({ posted: true, targetChatId: SESSION, parentChatId: null, files: 3, canvases: 1 });
    expect(w.persisted.every((p) => p.chatId === SESSION)).toBe(true);
    expect(w.messages[0].chatId).toBe(SESSION);
    expect(w.messages[0].content).not.toContain('From session');
    expect(w.canvasCopies).toEqual([]);
    expect(w.events[0].payload.childChatId).toBeUndefined();
    expect(w.events[0].payload.artifacts.find((a: any) => a.kind === 'canvas')).toEqual({ name: 'Outline', bytes: 3, url: 'canvas:c1', kind: 'canvas' });
  });

  it('child run with a canvas: the canvas is COPIED onto the parent and linked by its new id', async () => {
    const w = world({ listing: [], canvases: [{ id: 'c1', title: 'Outline', type: 'document', language: null, content: 'abc' }] });
    const r = await runDeliverableHandoff(input(), w.deps);
    expect(r).toMatchObject({ posted: true, files: 0, canvases: 1 });
    expect(w.canvasCopies).toEqual([{ chatId: PARENT, title: 'Outline' }]);
    expect(w.events[0].payload.artifacts).toEqual([{ name: 'Outline', bytes: 3, url: 'canvas:copy-c1', kind: 'canvas' }]);
  });

  it('a parent held by ANOTHER account never receives files — the session posts on itself', async () => {
    const w = world({ parentUser: 'someone-else' });
    const r = await runDeliverableHandoff(input(), w.deps);
    expect(r).toMatchObject({ posted: true, targetChatId: SESSION, parentChatId: null });
    expect(w.persisted.every((p) => p.chatId === SESSION)).toBe(true);
  });

  it('NO artifacts: a human-typed or first child run still posts the summary on the parent; a later steered run does not; a top-level session posts nothing', async () => {
    const first = world({ listing: [], completedRuns: 1 });
    expect((await runDeliverableHandoff(input(), first.deps)).posted).toBe(true);
    expect(first.messages[0].content).toContain('produced no files');
    expect(first.events[0].payload.artifacts).toEqual([]);

    const later = world({ listing: [], completedRuns: 4 });
    expect(await runDeliverableHandoff(input(), later.deps)).toMatchObject({ posted: false, skipped: 'nothing' });
    expect(later.messages).toHaveLength(0);

    const human = world({ listing: [], completedRuns: 4 });
    expect((await runDeliverableHandoff(input({ triggerKind: 'user' }), human.deps)).posted).toBe(true);

    const top = world({ listing: [], parent: false });
    expect(await runDeliverableHandoff(input(), top.deps)).toMatchObject({ posted: false, skipped: 'nothing' });
  });

  it('LINEAGE gate: a [HARNESS CONTINUATION] / schedule / hook firing on a HUMAN-parented child posts the deck (the run that finishes long work), whatever fired it', async () => {
    const w = world();
    const cont = await runDeliverableHandoff(input({ triggerKind: 'schedule', runId: 'run-cont-1111-2222-333333333333' }), w.deps);
    expect(cont).toMatchObject({ posted: true, targetChatId: PARENT, files: 3 });
    expect(w.messages).toHaveLength(1);
    expect(w.messages[0].content).toContain('[deck/cql-dgx-b300-deck.pdf](/api/crossmodel/files/');
    expect(w.metrics[0].meta.trigger).toBe('schedule');
    const hook = await runDeliverableHandoff(input({ triggerKind: 'hook', runId: 'run-hook-1111-2222-333333333333' }), w.deps);
    expect(hook.posted).toBe(true);
    // summary-only (no artifacts) on a later steered run still stays quiet — the first-run / human rule is unchanged
    const quiet = world({ listing: [], completedRuns: 4 });
    expect(await runDeliverableHandoff(input({ triggerKind: 'schedule' }), quiet.deps)).toMatchObject({ posted: false, skipped: 'nothing' });
  });

  it('ORIGIN gate (opt-in DELIVERABLE_HANDOFF_ORIGIN_GATE=1): the first cut — schedule / hook firings hand off only under DELIVERABLE_HANDOFF_ALL_ORIGINS=1', async () => {
    process.env[DELIVERABLE_HANDOFF_ORIGIN_GATE_ENV] = '1';
    const w = world();
    expect(await runDeliverableHandoff(input({ triggerKind: 'schedule' }), w.deps)).toMatchObject({ posted: false, skipped: 'origin' });
    expect(await runDeliverableHandoff(input({ triggerKind: 'hook' }), w.deps)).toMatchObject({ posted: false, skipped: 'origin' });
    expect(w.messages).toHaveLength(0);
    expect((await runDeliverableHandoff(input({ triggerKind: 'machine' }), w.deps)).posted).toBe(true);
    process.env[DELIVERABLE_HANDOFF_ALL_ORIGINS_ENV] = '1';
    expect((await runDeliverableHandoff(input({ triggerKind: 'schedule', runId: 'run-2222-1111-2222-333333333333' }), w.deps)).posted).toBe(true);
  });

  it('SUPERVISOR parent (Fleet or Project Supervisor spawned the lane): SKIPPED — no file copies, no ChatFile rows, no Result row on the supervisor chat; one skipped metric; opt-in DELIVERABLE_HANDOFF_SUPERVISOR_PARENTS=1 posts', async () => {
    for (const kind of ['fleet', 'project'] as const) {
      const w = world({ parentSupervisor: kind, receipts: [prReceipt(12, 'https://github.com/o/r/pull/12')] });
      const spy = jest.spyOn(w.deps, 'listWorktree');
      const r = await runDeliverableHandoff(input(), w.deps);
      expect(r).toMatchObject({ posted: false, skipped: 'supervisor_parent', parentChatId: PARENT, targetChatId: PARENT });
      expect(spy).not.toHaveBeenCalled(); // nothing read — the gate is before the collect
      expect(w.persisted).toHaveLength(0);
      expect(w.messages).toHaveLength(0);
      expect(w.events).toHaveLength(0);
      expect(w.claims.size).toBe(0);
      expect(w.metrics).toHaveLength(1);
      expect(w.metrics[0]).toMatchObject({ kind: 'deliverable_handoff', value: 0, meta: { posted: false, skipped: 'supervisor_parent', parentChatId: PARENT } });
    }
    process.env[DELIVERABLE_HANDOFF_SUPERVISOR_PARENTS_ENV] = '1';
    const w2 = world({ parentSupervisor: 'project' });
    expect((await runDeliverableHandoff(input(), w2.deps)).posted).toBe(true);
    expect(w2.messages[0].chatId).toBe(PARENT);
  });

  it('a MODIFIED pre-existing results log / docs file on a code lane ships as a change (never a file copy); a new report and the deck still ship', async () => {
    const listing = [
      { rel: 'docs/results.md', bytes: 10, mtimeMs: T0 + 1 },
      { rel: 'reports/new-report.md', bytes: 10, mtimeMs: T0 + 1 },
      { rel: 'deck/a.pdf', bytes: PDF.length, mtimeMs: T0 + 1 },
    ];
    const bytes = { 'docs/results.md': Buffer.from('# results'), 'reports/new-report.md': Buffer.from('# new'), 'deck/a.pdf': PDF };
    const w = world({ listing, bytes, preexisting: new Set(['docs/results.md', 'deck/a.pdf']) });
    const r = await runDeliverableHandoff(input(), w.deps);
    expect(r).toMatchObject({ posted: true, files: 2, treatedAsChange: 1 });
    expect(w.persisted.map((p) => p.filename)).toEqual(['a.pdf', 'new-report.md']);
    expect(w.messages[0].content).not.toContain('results.md');
    expect(w.metrics[0].meta.treatedAsChange).toBe(1);
  });

  it('per-RUN total budget: files beyond DELIVERABLE_MAX_TOTAL_BYTES stay behind (newest kept) and the note says so', async () => {
    process.env[DELIVERABLE_MAX_TOTAL_BYTES_ENV] = String(PPTX.length + HTML.length + 1); // the two newest fit; the pdf (oldest) does not
    const w = world();
    const r = await runDeliverableHandoff(input(), w.deps);
    expect(r).toMatchObject({ posted: true, files: 2, skippedOverBudget: 1 });
    expect(w.persisted.map((p) => p.filename)).toEqual(['cql-dgx-b300-deck.pptx', 'slides.html']);
    expect(w.messages[0].content).toContain("1 file over this run's total budget stayed in the session's Files tab");
    expect(w.events[0].payload.note).toContain('1 over the run budget');
  });

  it('DEADLINE: an aborted signal stops the per-file loop (no further reads / persists), releases the claim, posts nothing; a signal aborted up front reads nothing', async () => {
    const w = world();
    const controller = new AbortController();
    const reads: string[] = [];
    const deps: HandoffDeps = {
      ...w.deps,
      readFile: async (_root, rel) => {
        reads.push(rel);
        if (reads.length === 1) controller.abort(); // the deadline fires after the first file
        return DGX_BYTES[rel] ?? null;
      },
    };
    const r = await runDeliverableHandoff(input({ signal: controller.signal }), deps);
    expect(r).toMatchObject({ posted: false, skipped: 'timeout' });
    expect(reads).toEqual(['deck/cql-dgx-b300-deck.pdf']);
    expect(w.persistCalls).toEqual([1]); // the first file was persisted before the deadline; the loop stopped before the second
    expect(w.messages).toHaveLength(0);
    expect(w.claims.size).toBe(0); // released — a re-finalize can post
    expect(w.metrics[0]).toMatchObject({ meta: { posted: false, skipped: 'timeout' } });

    const w2 = world();
    const early = new AbortController();
    early.abort();
    const spy = jest.spyOn(w2.deps, 'listWorktree');
    expect(await runDeliverableHandoff(input({ signal: early.signal }), w2.deps)).toMatchObject({ posted: false, skipped: 'timeout' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('runDeliverableHandoffSafe hands the deadline to the work as an AbortSignal (the walk observes it)', async () => {
    const w = world();
    let seen: AbortSignal | undefined;
    const deps: HandoffDeps = {
      ...w.deps,
      listWorktree: (_root, signal) => new Promise<WorktreeFileEntry[]>((resolve) => {
        seen = signal;
        signal?.addEventListener('abort', () => resolve([]), { once: true });
      }),
    };
    expect(await runDeliverableHandoffSafe(input(), deps, 30)).toBeNull();
    expect(seen?.aborted).toBe(true);
    await new Promise((r) => setTimeout(r, 10));
    expect(w.messages).toHaveLength(0); // the stopped work never posts late
  });

  it('git-unchanged exclusion rides the selection: a tracked, unchanged README with a fresh mtime is not shipped', async () => {
    const listing = [{ rel: 'notes/report.md', bytes: 10, mtimeMs: T0 + 1 }, { rel: 'deck/a.pdf', bytes: PDF.length, mtimeMs: T0 + 1 }];
    const w = world({ listing, bytes: { 'notes/report.md': Buffer.from('# report'), 'deck/a.pdf': PDF }, trackedUnchanged: new Set(['notes/report.md']) });
    const r = await runDeliverableHandoff(input(), w.deps);
    expect(r.files).toBe(1);
    expect(w.persisted.map((p) => p.filename)).toEqual(['a.pdf']);
  });

  it('no worktree on this box (empty walk) ⇒ PRs / canvases still hand off; worktreeLocal:false in the metric', async () => {
    const w = world({ listing: [], receipts: [prReceipt(7, 'https://github.com/o/r/pull/7')] });
    const r = await runDeliverableHandoff(input({ worktreeRoot: null }), w.deps);
    expect(r).toMatchObject({ posted: true, files: 0, prs: 1, worktreeLocal: false });
    expect(w.metrics[0].meta.worktreeLocal).toBe(false);
  });

  it('runDeliverableHandoffSafe never throws and bounds the wait', async () => {
    const w = world();
    const hang = { ...w.deps, listWorktree: () => new Promise<WorktreeFileEntry[]>(() => {}) };
    expect(await runDeliverableHandoffSafe(input(), hang, 30)).toBeNull();
    const thrower = { ...w.deps, findChat: async () => { throw new Error('boom'); } };
    expect(await runDeliverableHandoffSafe(input(), thrower)).toMatchObject({ posted: false, skipped: 'no_chat' });
    const ok = await runDeliverableHandoffSafe(input(), w.deps);
    expect(ok?.posted).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Hand-off polish (2026-09-28, audit CT-1 / CT-3 / E17 / DOI-09)
// ═══════════════════════════════════════════════════════════════════════════
import {
  scrubSummary, contentSha1, deliverableContentUploadId, handoffChatTotalBytes, formatBytes,
  HANDOFF_CHAT_TOTAL_BYTES_ENV,
  HANDOFF_CHAT_TOTAL_BYTES_DEFAULT, HANDOFF_LEDGER_KEY,
  type HandoffLedger,
} from './deliverable-handoff';

/** The 12636e14 acceptance final (prod Result row 2026-09-28 06:46:32Z) — the row led with the container path. */
const ACCEPTANCE_FINAL = 'Done — deck built, verified, and left untracked as required.\n\n## Result\n\n**PDF (absolute path):** `/app/coding-workspaces/worktrees/12636e14-7d27-4827-aaf3-f9f8f8fd1036/digby-cohesive-deck.pdf` (3,775 bytes, built with reportlab; 3 pages verified with pdfinfo).\n\n### Slides\n1. Title\n2. Three pillars\n3. Close';

/**
 * A world whose file store is DURABLE across runs (the target chat's ChatFile
 * rows) with the optional ledger / prune deps wired — the lane-on-a-schedule
 * replay: the same four untracked JSON files re-written every hour.
 */
function ledgerWorld(opts: Parameters<typeof world>[0] = {}) {
  const w = world(opts);
  const ledgers = new Map<string, HandoffLedger>();
  const files: Array<{ id: string; chatId: string; uploadId: string; sizeBytes: number; createdAt: Date }> = [];
  const deleted: string[] = [];
  let seq = 0;
  const deps: HandoffDeps = {
    ...w.deps,
    persistFiles: async (chatId, userId, loaded) => {
      w.persistCalls.push(loaded.length);
      for (const l of loaded) {
        if (files.some((f) => f.chatId === chatId && f.uploadId === l.id)) continue;
        const bytes = Buffer.from(l.attachment.base64 ?? '', 'base64').length;
        files.push({ id: `file-${++seq}`, chatId, uploadId: l.id, sizeBytes: bytes, createdAt: new Date(T0 + seq * 1000) });
        w.persisted.push({ chatId, userId, uploadId: l.id, filename: l.attachment.filename, mimeType: l.attachment.mimeType ?? '', bytes });
      }
    },
    findChatFiles: async (chatId, ids) => files.filter((f) => f.chatId === chatId && ids.includes(f.uploadId)).map((f) => ({ id: f.id, uploadId: f.uploadId, sizeBytes: f.sizeBytes })),
    loadLedger: async (chatId) => ledgers.get(chatId) ?? null,
    saveLedger: async (chatId, ledger) => { ledgers.set(chatId, ledger); },
    listHandoffFiles: async (chatId) => files.filter((f) => f.chatId === chatId).map((f) => ({ id: f.id, uploadId: f.uploadId, sizeBytes: f.sizeBytes, createdAt: f.createdAt })),
    deleteChatFiles: async (chatId, ids) => {
      let n = 0;
      for (const id of ids) { const i = files.findIndex((f) => f.chatId === chatId && f.id === id); if (i >= 0) { files.splice(i, 1); deleted.push(id); n++; } }
      return n;
    },
  };
  return { ...w, deps, ledgers, files, deleted };
}

const JSON_A = Buffer.from(JSON.stringify({ scores: Array.from({ length: 40 }, (_, i) => i) }));
const JSON_B = Buffer.from(JSON.stringify({ scores: Array.from({ length: 40 }, (_, i) => i * 2) }));
const LANE_LISTING = (mtime: number): WorktreeFileEntry[] => [
  { rel: 'results/judged_scores.json', bytes: JSON_A.length, mtimeMs: mtime },
  { rel: 'results/publication_dates.json', bytes: JSON_A.length, mtimeMs: mtime },
];

describe('hand-off polish — content dedupe + the per-chat budget (audit CT-1: 11 identical copies, 185 MB in 11 h)', () => {
  beforeEach(() => {
    delete process.env[HANDOFF_CHAT_TOTAL_BYTES_ENV];
  });

  it('upload ids are CONTENT-keyed (dh_ prefix kept): same path + same bytes ⇒ the same id across runs; a byte change or another path ⇒ a new id', () => {
    const a = deliverableContentUploadId('out/x.json', contentSha1(JSON_A));
    expect(a).toMatch(/^dh_[0-9a-f]{32}$/);
    expect(deliverableContentUploadId('out/x.json', contentSha1(JSON_A))).toBe(a);
    expect(deliverableContentUploadId('out/x.json', contentSha1(JSON_B))).not.toBe(a);
    expect(deliverableContentUploadId('out/y.json', contentSha1(JSON_A))).not.toBe(a);
    expect(handoffChatTotalBytes()).toBe(HANDOFF_CHAT_TOTAL_BYTES_DEFAULT);
    process.env[HANDOFF_CHAT_TOTAL_BYTES_ENV] = '1000';
    expect(handoffChatTotalBytes()).toBe(1000);
  });

  it('a top-level lane re-writing IDENTICAL files on its next scheduled run: nothing is persisted again, NO result row (skipped:unchanged), the metric says deduped; the ledger keeps the FIRST hand-off as the record', async () => {
    const w = ledgerWorld({ parent: false, listing: LANE_LISTING(T0 + 60_000), bytes: { 'results/judged_scores.json': JSON_A, 'results/publication_dates.json': JSON_A } });
    const first = await runDeliverableHandoff(input({ triggerKind: 'schedule' }), w.deps);
    expect(first).toMatchObject({ posted: true, files: 2, deduped: 0, pruned: 0, targetChatId: SESSION });
    expect(w.files).toHaveLength(2);
    expect(w.ledgers.get(SESSION)!.files['results/judged_scores.json']).toMatchObject({ sha1: contentSha1(JSON_A), runId: RUN, sessionId: SESSION });
    // the next hour: same bytes, new mtime, new run
    const T1 = T0 + 3_600_000;
    const w2 = { ...w, deps: { ...w.deps, listWorktree: async () => LANE_LISTING(T1 + 60_000) } };
    const second = await runDeliverableHandoff(input({ runId: 'run-hour-2', runStartedAt: new Date(T1), now: new Date(T1 + 120_000), triggerKind: 'schedule' }), w2.deps);
    expect(second).toMatchObject({ posted: false, skipped: 'unchanged', deduped: 2, files: 0, targetChatId: SESSION });
    expect(w.files).toHaveLength(2); // not a byte more on the chat
    expect(w.persistCalls).toEqual([1, 1]); // only the first run's two copies
    expect(w.messages).toHaveLength(1); // ONE result row, not eleven
    expect(w.metrics.at(-1)).toMatchObject({ meta: { posted: false, skipped: 'unchanged', deduped: 2, runId: 'run-hour-2' } });
    expect(w.claims.has(`${SESSION}/run-hour-2`)).toBe(true); // the run is handled — never re-tried
    expect(w.ledgers.get(SESSION)!.files['results/judged_scores.json'].runId).toBe(RUN); // "unchanged since" = the first record
  });

  it('a CHANGED file on the next run is copied (new content id) and the unchanged one is LINKED: one new row, the Result row lists both with "unchanged since the last hand-off" on the linked one', async () => {
    const w = ledgerWorld({ parent: false, listing: LANE_LISTING(T0 + 60_000), bytes: { 'results/judged_scores.json': JSON_A, 'results/publication_dates.json': JSON_A } });
    await runDeliverableHandoff(input({ triggerKind: 'schedule' }), w.deps);
    const T1 = T0 + 3_600_000;
    const deps2: HandoffDeps = { ...w.deps, listWorktree: async () => LANE_LISTING(T1 + 60_000), readFile: async (_r, rel) => (rel === 'results/judged_scores.json' ? JSON_B : JSON_A) };
    const r = await runDeliverableHandoff(input({ runId: 'run-hour-2', runStartedAt: new Date(T1), now: new Date(T1 + 120_000), triggerKind: 'schedule' }), deps2);
    expect(r).toMatchObject({ posted: true, files: 2, deduped: 1, pruned: 0 });
    expect(w.files).toHaveLength(3);
    expect(r.artifacts.map((a) => a.name)).toEqual(['results/judged_scores.json', 'results/publication_dates.json']);
    const row = w.messages.at(-1)!;
    expect(row.content).toMatch(/- \[results\/publication_dates\.json\]\(\/api\/crossmodel\/files\/file-2\/download\) \([\d.]+ (?:B|KB)\) — unchanged since the last hand-off/);
    expect(row.content).toMatch(/- \[results\/judged_scores\.json\]\(\/api\/crossmodel\/files\/file-3\/download\) \([\d.]+ (?:B|KB)\)\n/);
    expect(row.content).not.toMatch(/judged_scores\.json\].*unchanged/);
    expect(w.ledgers.get(SESSION)!.files['results/judged_scores.json']).toMatchObject({ sha1: contentSha1(JSON_B), runId: 'run-hour-2' });
    expect(w.ledgers.get(SESSION)!.files['results/publication_dates.json'].runId).toBe(RUN);
    expect(w.metrics.at(-1)).toMatchObject({ meta: { posted: true, deduped: 1, pruned: 0, files: 2 } });
  });

  it('a PARENT target still gets its Result row when everything is unchanged (the completion is the news) — with the unchanged notes, nothing re-copied', async () => {
    const w = ledgerWorld({ listing: LANE_LISTING(T0 + 60_000), bytes: { 'results/judged_scores.json': JSON_A, 'results/publication_dates.json': JSON_A } });
    await runDeliverableHandoff(input({ triggerKind: 'user' }), w.deps);
    const T1 = T0 + 3_600_000;
    const r = await runDeliverableHandoff(input({ runId: 'run-2', runStartedAt: new Date(T1), now: new Date(T1 + 60_000), triggerKind: 'schedule' }), { ...w.deps, listWorktree: async () => LANE_LISTING(T1 + 60_000) });
    expect(r).toMatchObject({ posted: true, files: 2, deduped: 2, targetChatId: PARENT });
    expect(w.files).toHaveLength(2);
    expect(w.messages).toHaveLength(2);
    expect(w.messages[1].content.match(/unchanged since the last hand-off/g)).toHaveLength(2);
    expect(w.cards.at(-1)!.payload).toMatchObject({ status: 'done', artifacts: expect.arrayContaining([expect.objectContaining({ name: 'results/judged_scores.json' })]) });
  });

  it('PER-CHAT BUDGET: the OLDEST hand-off copies that are not this run\'s are pruned past HANDOFF_CHAT_TOTAL_BYTES, the row says how many, the ledger forgets them', async () => {
    const w = ledgerWorld({ parent: false, listing: LANE_LISTING(T0 + 60_000), bytes: { 'results/judged_scores.json': JSON_A, 'results/publication_dates.json': JSON_A } });
    process.env[HANDOFF_CHAT_TOTAL_BYTES_ENV] = String(JSON_A.length * 3); // room for three copies
    await runDeliverableHandoff(input({ triggerKind: 'schedule' }), w.deps); // copies 1, 2
    const hour = (n: number) => T0 + n * 3_600_000;
    const changed = (n: number): HandoffDeps => ({ ...w.deps, listWorktree: async () => LANE_LISTING(hour(n) + 60_000), readFile: async () => Buffer.from(JSON.stringify({ hour: n, pad: 'x'.repeat(JSON_A.length - 30) })) });
    const r2 = await runDeliverableHandoff(input({ runId: 'run-h2', runStartedAt: new Date(hour(2)), now: new Date(hour(2) + 60_000), triggerKind: 'schedule' }), changed(2)); // copies 3, 4 ⇒ over budget by one
    expect(r2).toMatchObject({ posted: true, files: 2, pruned: 1 });
    expect(w.deleted).toEqual(['file-1']); // the oldest copy that is not this run's
    expect(w.files.map((f) => f.id)).toEqual(['file-2', 'file-3', 'file-4']);
    expect(w.messages.at(-1)!.content).toContain('1 older hand-off copy was removed to stay under this chat\'s hand-off budget');
    expect(Object.values(w.ledgers.get(SESSION)!.files).map((e) => e.uploadId)).not.toContain(w.persisted[0].uploadId);
    expect(w.metrics.at(-1)).toMatchObject({ meta: { pruned: 1 } });
    // this run's own copies are never victims even when they alone exceed the budget
    process.env[HANDOFF_CHAT_TOTAL_BYTES_ENV] = '10';
    const r3 = await runDeliverableHandoff(input({ runId: 'run-h3', runStartedAt: new Date(hour(3)), now: new Date(hour(3) + 60_000), triggerKind: 'schedule' }), changed(3));
    expect(r3).toMatchObject({ posted: true, files: 2, pruned: 3 });
    expect(w.files.map((f) => f.id)).toEqual(['file-5', 'file-6']);
  });

  it('a target with no optional ledger / prune deps (the plain fake world) still dedupes through findChatFiles alone — no prune, no ledger', async () => {
    const w = world({ parent: false, listing: LANE_LISTING(T0 + 60_000), bytes: { 'results/judged_scores.json': JSON_A, 'results/publication_dates.json': JSON_A } });
    expect(await runDeliverableHandoff(input({ triggerKind: 'schedule' }), w.deps)).toMatchObject({ posted: true, files: 2, deduped: 0 });
    const T1 = T0 + 3_600_000;
    const again = await runDeliverableHandoff(input({ runId: 'run-2', runStartedAt: new Date(T1), now: new Date(T1 + 60_000), triggerKind: 'schedule' }), { ...w.deps, listWorktree: async () => LANE_LISTING(T1 + 60_000) });
    expect(again).toMatchObject({ posted: false, skipped: 'unchanged', deduped: 2 });
    expect(w.persisted).toHaveLength(2);
  });
});

describe('hand-off polish — the Result row leads with the artifacts, the summary is scrubbed (audit CT-3 / E17 / DOI-09)', () => {
  it('scrubSummary: the 12636e14 acceptance final loses its container path, the "(absolute path)" parenthetical and the headings, and collapses into ONE paragraph', () => {
    const s = scrubSummary(ACCEPTANCE_FINAL, { worktreeRoot: '/app/coding-workspaces/worktrees/12636e14-7d27-4827-aaf3-f9f8f8fd1036' });
    expect(s).not.toMatch(/\/app\/|worktrees|absolute path|##|\n/);
    expect(s).toContain('Done — deck built, verified, and left untracked as required.');
    expect(s).toContain('**PDF:** `digby-cohesive-deck.pdf` (3,775 bytes, built with reportlab; 3 pages verified with pdfinfo).');
    expect(s).toContain('1. Title 2. Three pillars 3. Close');
  });

  it('scrubSummary: container roots without a known worktree root, a bare root mention, punctuation after a path, and the empty / null inputs', () => {
    expect(scrubSummary('Wrote /opt/crossmodel/out/report.pdf, then /home/ubuntu/deck/final.pptx.')).toBe('Wrote report.pdf, then final.pptx.');
    expect(scrubSummary('All files are under /app/coding-workspaces/worktrees/abc now.', { worktreeRoot: '/app/coding-workspaces/worktrees/abc' })).toBe('All files are under the session workspace now.');
    expect(scrubSummary('Saved it (in the worktree) as `out/a.csv` (worktree path).')).toBe('Saved it as `out/a.csv`.');
    expect(scrubSummary('')).toBe('');
    expect(scrubSummary(null)).toBe('');
    expect(scrubSummary('---\n# Title\nplain text\n***')).toBe('plain text');
  });

  it('buildResultMessage: the Deliverables list comes FIRST, the summary after it', () => {
    const artifacts = [{ name: 'digby-cohesive-deck.pdf', bytes: 3775, url: '/api/crossmodel/files/f1/download', kind: 'file' as const }];
    const row = buildResultMessage({ sessionTitle: '3-slide 16:9 PDF deck', sessionId: SESSION, runId: RUN, summary: 'Done — deck built.', artifacts, targetIsParent: true });
    const lines = row.split('\n');
    expect(lines[0]).toBe('**Result: 3-slide 16:9 PDF deck**');
    expect(lines[2]).toBe('**Deliverables**');
    expect(lines[3]).toBe('- [digby-cohesive-deck.pdf](/api/crossmodel/files/f1/download) (3.7 KB)');
    expect(lines[5]).toBe('Done — deck built.');
    expect(row.indexOf('**Deliverables**')).toBeLessThan(row.indexOf('Done — deck built.'));
  });

  it('END TO END: the acceptance final on a plain parent — the row leads with the deck link, never the container path', async () => {
    const listing = [{ rel: 'digby-cohesive-deck.pdf', bytes: PDF.length, mtimeMs: T0 + 60_000 }];
    const w = world({ listing, bytes: { 'digby-cohesive-deck.pdf': PDF } });
    const r = await runDeliverableHandoff(input({ finalText: ACCEPTANCE_FINAL, worktreeRoot: '/app/coding-workspaces/worktrees/12636e14-7d27-4827-aaf3-f9f8f8fd1036', sessionTitle: '3-slide 16:9 PDF deck', triggerKind: 'user' }), w.deps);
    expect(r.posted).toBe(true);
    const content = w.messages[0].content;
    expect(content.split('\n').slice(0, 4)).toEqual(['**Result: 3-slide 16:9 PDF deck**', '', '**Deliverables**', `- [digby-cohesive-deck.pdf](${r.artifacts[0].url}) (${formatBytes(PDF.length)})`]);
    expect(content).not.toMatch(/\/app\/coding-workspaces|absolute path|## Result/);
    expect(content).toContain('Done — deck built, verified, and left untracked as required. **PDF:** `digby-cohesive-deck.pdf`');
  });

  it('the ledger key never collides with a run id or the latest record', () => {
    expect(HANDOFF_LEDGER_KEY).toBe('ledger');
    expect(HANDOFF_LEDGER_KEY).not.toBe('latest');
  });
});
