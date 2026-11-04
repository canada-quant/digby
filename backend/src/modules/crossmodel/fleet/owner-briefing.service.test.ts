/**
 * Owner briefings (owner 2026-09-04) — generator unit tests with mocked
 * Prisma/Redis/utility-llm. Pins the gates the design demands: the Redis NX
 * lock (one briefing per ~90min window), the skip-on-garbage regex (8-hex id
 * or table pipe never posts), the persisted metadata contract
 * ({ kind: 'owner_briefing', sourceNoteId }), and fail-open everywhere.
 *
 * Review 2026-09-13 issue 4 follow-up — DETERMINISTIC FIRST, GROUNDED SECOND:
 * a note with parseable per-project sections posts renderBriefingFromNote's
 * output and NEVER calls the LLM; only a free-form note reaches utilityChat,
 * and its output passes groundBriefingInNote (ungrounded `<Project>:` lines
 * and invented "Needs you:" lines are dropped; all-dropped falls back to the
 * rendering, else skips). Each posted briefing logs ONE info with
 * { path, droppedUngrounded, droppedNeedsYou }.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {
  crossModelMessage: { create: jest.fn(async ({ data }: any) => ({ id: 'brief-row-1', ...data })) },
  // Supervisor OFF switch (owner 2026-09-26): null = no row = ON.
  systemSetting: { findUnique: jest.fn(async () => null) },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

// In-memory Redis with REAL SET NX semantics — the lock contract under test.
const redisStore = new Map<string, string>();
const mockRedisSet = jest.fn(async (k: string, v: string, opts?: { NX?: boolean }) => {
  if (opts?.NX && redisStore.has(k)) return null;
  redisStore.set(k, v);
  return 'OK';
});
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: { set: (...a: any[]) => (mockRedisSet as any)(...a), get: jest.fn(async (k: string) => redisStore.get(k) ?? null) },
}));

// utility-llm is DYNAMICALLY imported inside generateOwnerBriefing — mock the
// module boundary (jest.mock covers dynamic imports too).
// Review 2026-09-13 issue 4: the mock speaks the owner's spec (per-project
// progress lines), not the retired "Your fleet…" voice. Both labels are
// grounded in ARGS' note (CanLaw / Tenstorrent appear in its prose).
const GOOD_BRIEFING = 'CanLaw: the benchmark pack finished → drafting the summary next → tomorrow evening\nTenstorrent: speed check passed → next comparison queued → no ETA yet';
const mockUtilityChat = jest.fn(async (..._a: any[]): Promise<string> => GOOD_BRIEFING);
jest.mock('../../../utils/utility-llm', () => ({
  __esModule: true,
  utilityChat: (...a: any[]) => mockUtilityChat(...a),
}));

// Post-25c5a7c3 generateOwnerBriefing also dynamically imports the fleet
// liveness snapshot — null here keeps these tests on the ungrounded path.
jest.mock('../platform/supervisor-state.service', () => ({
  __esModule: true,
  getFleetLivenessSnapshot: jest.fn(async () => null),
}));

import {
  generateOwnerBriefing,
  briefingLooksMachine,
  briefingLooksVague,
  renderBriefingFromNote,
  renderingIsSubstantive,
  parseNoteProjectNames,
  noteHasNeedsYouMarker,
  groundBriefingInNote,
  scrubMachineArtifacts,
  briefingLockKey,
  BRIEFING_LOCK_TTL_MS,
  OWNER_BRIEFING_KIND,
  OWNER_BRIEFING_SPEC,
  NOTHING_NEW_LINE,
} from './owner-briefing.service';
import logger from '../../../utils/logger';

// A FREE-FORM note (no parseable per-project sections — the headline is a
// whole-line bold header, the one table row has no progress cell) → the LLM
// path. Its prose names CanLaw + Tenstorrent so GOOD_BRIEFING is grounded.
const ARGS = {
  chatId: 'sup-chat-1',
  userId: 'u-owner',
  noteContent: '**Fleet wake — 2 lanes green**\n\nCanLaw and Tenstorrent both checked in; nothing else moved.\n\n| Lane | Status |\n|---|---|\n| CanLaw | ✅ |',
  sourceNoteId: 'wake-note-9',
};

const postedContent = () => mockPrisma.crossModelMessage.create.mock.calls[0][0].data.content as string;
const warnedWith = (...needles: string[]) =>
  (logger.warn as jest.Mock).mock.calls.some((c) => needles.every((n) => String(c[0]).includes(n)));

beforeEach(() => {
  jest.clearAllMocks();
  redisStore.clear();
  mockPrisma.crossModelMessage.create.mockImplementation(async ({ data }: any) => ({ id: 'brief-row-1', ...data }));
  mockUtilityChat.mockResolvedValue(GOOD_BRIEFING);
});

describe('generateOwnerBriefing — happy path (free-form note → LLM path)', () => {
  it('claims the NX lock, rewrites via utilityChat, and persists a NORMAL assistant row with the briefing metadata', async () => {
    const ok = await generateOwnerBriefing(ARGS);
    expect(ok).toBe(true);

    // Lock: the design key + 90-minute TTL, NX.
    expect(mockRedisSet).toHaveBeenCalledWith(
      briefingLockKey('sup-chat-1'), '1', { NX: true, PX: BRIEFING_LOCK_TTL_MS },
    );
    expect(briefingLockKey('sup-chat-1')).toBe('fleet:briefing:sup-chat-1');
    expect(BRIEFING_LOCK_TTL_MS).toBe(90 * 60 * 1000);

    // The rewrite prompt got the DELIVERED note and the hard rules — in the
    // owner's 2026-09-13 voice (review issue 4), not the retired fleet voice.
    const [messages, opts] = mockUtilityChat.mock.calls[0];
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toContain(OWNER_BRIEFING_SPEC);
    expect(messages[0].content).toContain('<Project>: <what moved> → <what is next> → <ETA, or "no ETA yet">');
    expect(messages[0].content).toContain('"Needs you: <the decision and the options>" ONLY when');
    expect(messages[0].content).toContain('Skip any project with nothing new');
    expect(messages[0].content).toContain(NOTHING_NEW_LINE);
    expect(messages[0].content).toContain('Never open with "Your fleet", "Your assistants" or "The fleet"');
    expect(messages[0].content).not.toContain('2-4 short plain-English sentences');
    expect(messages[0].content).not.toContain('Write in second person');
    expect(messages[0].content).toContain('Use ONLY facts stated in the note');
    expect(messages[1].content).toContain('Fleet wake — 2 lanes green');
    // Never leak DeepSeek reasoning into the owner's chat; budget fits per-project lines.
    expect(opts.contentOnly).toBe(true);
    expect(opts.maxTokens).toBe(900);

    // Persisted as a normal assistant message with the classifier-exemption kind.
    expect(mockPrisma.crossModelMessage.create).toHaveBeenCalledTimes(1);
    const row = mockPrisma.crossModelMessage.create.mock.calls[0][0].data;
    expect(row.chatId).toBe('sup-chat-1');
    expect(row.role).toBe('assistant');
    expect(row.content).toBe(GOOD_BRIEFING);
    expect(row.metadata).toEqual({ kind: OWNER_BRIEFING_KIND, sourceNoteId: 'wake-note-9' });

    // ONE countable info per posted briefing, path + grounding counters as meta.
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('path=llm'),
      { path: 'llm', droppedUngrounded: 0, droppedNeedsYou: false },
    );
  });

  it('omits sourceNoteId from metadata when the caller has none', async () => {
    await generateOwnerBriefing({ ...ARGS, sourceNoteId: undefined });
    expect(mockPrisma.crossModelMessage.create.mock.calls[0][0].data.metadata).toEqual({ kind: OWNER_BRIEFING_KIND });
  });
});

describe('generateOwnerBriefing — lock discipline (hook-wake storm cap)', () => {
  it('a held lock yields silently: no utility call, no persist, false', async () => {
    redisStore.set(briefingLockKey('sup-chat-1'), '1');
    const ok = await generateOwnerBriefing(ARGS);
    expect(ok).toBe(false);
    expect(mockUtilityChat).not.toHaveBeenCalled();
    expect(mockPrisma.crossModelMessage.create).not.toHaveBeenCalled();
  });

  it('two back-to-back calls (a wake storm) yield exactly ONE briefing', async () => {
    const [a, b] = await Promise.all([generateOwnerBriefing(ARGS), generateOwnerBriefing(ARGS)]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(mockPrisma.crossModelMessage.create).toHaveBeenCalledTimes(1);
  });

  it('a skipped/failed generation KEEPS the lock (waits out the window, never storms retries)', async () => {
    mockUtilityChat.mockResolvedValueOnce(''); // empty output → skip
    expect(await generateOwnerBriefing(ARGS)).toBe(false);
    expect(redisStore.has(briefingLockKey('sup-chat-1'))).toBe(true);
    // The immediate retry is still locked out.
    expect(await generateOwnerBriefing(ARGS)).toBe(false);
    expect(mockUtilityChat).toHaveBeenCalledTimes(1);
  });
});

describe('generateOwnerBriefing — skip-on-garbage (defensive output gate)', () => {
  it('output still carrying an 8-hex id is skipped (log, no post)', async () => {
    mockUtilityChat.mockResolvedValueOnce('CanLaw: fixed ticket ba65163d → nothing further → no ETA yet');
    expect(await generateOwnerBriefing(ARGS)).toBe(false);
    expect(mockPrisma.crossModelMessage.create).not.toHaveBeenCalled();
    expect(warnedWith('machine-shaped')).toBe(true);
  });

  it('output still carrying a table pipe is skipped', async () => {
    mockUtilityChat.mockResolvedValueOnce('Everything is fine.\n| Lane | Status |');
    expect(await generateOwnerBriefing(ARGS)).toBe(false);
    expect(mockPrisma.crossModelMessage.create).not.toHaveBeenCalled();
  });

  it('empty utility output is skipped', async () => {
    mockUtilityChat.mockResolvedValueOnce('   ');
    expect(await generateOwnerBriefing(ARGS)).toBe(false);
    expect(mockPrisma.crossModelMessage.create).not.toHaveBeenCalled();
  });
});

describe('generateOwnerBriefing — gates + fail-open', () => {
  it('an empty delivered note never even locks', async () => {
    expect(await generateOwnerBriefing({ ...ARGS, noteContent: '  \n ' })).toBe(false);
    expect(mockRedisSet).not.toHaveBeenCalled();
    expect(mockUtilityChat).not.toHaveBeenCalled();
  });

  it('a utilityChat explosion only logs — never throws', async () => {
    mockUtilityChat.mockRejectedValueOnce(new Error('provider down'));
    await expect(generateOwnerBriefing(ARGS)).resolves.toBe(false);
    expect(mockPrisma.crossModelMessage.create).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('a persist explosion only logs — never throws', async () => {
    mockPrisma.crossModelMessage.create.mockRejectedValueOnce(new Error('db down'));
    await expect(generateOwnerBriefing(ARGS)).resolves.toBe(false);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('a Redis explosion is treated as a failed claim (no generation)', async () => {
    mockRedisSet.mockRejectedValueOnce(new Error('redis down'));
    expect(await generateOwnerBriefing(ARGS)).toBe(false);
    expect(mockUtilityChat).not.toHaveBeenCalled();
  });
});

// ── Fixtures for the deterministic / grounding contracts ─────────────────────

/** The doctrine shape (bold lines + table + Needs-you section) → DETERMINISTIC path. */
const DOCTRINE_NOTE = [
  '**Fleet sweep — 2:04 PM PDT: dflash2 speed run passed its speed check, IDEaS proposal pack needs your pick**',
  '',
  '| Project | Progress toward its goal | ETA |',
  '|---|---|---|',
  '| dflash2 speed run | Speed check passed — 4 of 8 comparisons done | tomorrow evening |',
  '| spark-cluster | Benchmark wait finished, results being written up | no ETA yet |',
  '',
  '## What moved',
  '- **[CanLaw](/crossmodel?chatId=0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0)** — Benchmark pack: 12 of 20 cases graded (msg 7fc2d4e7) → grading the rest → about 2 more days',
  '- **IDEaS proposal pack** — Draft 2 complete → waiting on your pick of the two framings → no ETA yet',
  '',
  '## Needs you',
  '- Pick framing A (cost) or B (speed) for the IDEaS proposal pack',
  '',
  'Receipts: msg 7fc2d4e7, sched 3f87efe1, ticket ed04c9b2 at 15:40Z',
].join('\n');

/** A Needs-you-ONLY note: renders to a single "Needs you:" line — NOT
 *  substantive, so the LLM runs and the rendering is that path's fallback. */
const NEEDS_ONLY_NOTE = [
  'Sweep finished — nothing changed on any project; one decision is waiting.',
  '',
  '## Needs you',
  '- Pick framing A (cost) or B (speed) for the IDEaS proposal pack',
].join('\n');

/** REPLAY of the 2026-09-13 20:37Z incident source: an incoherent collapsed
 *  note with no per-project sections, naming "Kimi K3 supervisor + GLM-5" only
 *  as the owner's model-config asks, and NO open owner decision. */
const COLLAPSED_NOTE = [
  'Fleet sweep 20:37Z. CanLaw data-point verification still pending; dflash2 speed run evidence check finished, merge-safe review next.',
  'Owner model-config asks noted: Kimi K3 supervisor + GLM-5 upgrade — nothing actionable this sweep, no card open.',
].join('\n');

/** The briefing the 4B utility model actually produced from that note — two
 *  fabricated project lines (model names) and an invented owner ask. The
 *  fourth label is GLM-6 here (absent from the note) so the ungrounded drop is
 *  observable; "GLM-5" itself would be substring-grounded by the aside. */
const FABRICATED_BRIEFING = [
  'CanLaw: Data-point verification still pending → final merge-safe evidence review → no ETA yet',
  'dflash2 speed run: Evidence verification initiated → merge-safe check complete → later today',
  'Kimi K3: Verification request received → evidence review in progress → no ETA yet',
  'GLM-6: Verification task assigned → evidence validation underway → no ETA yet',
  'Needs you: Approve evidence verification for CanLaw or dflash2 speed run — choose one to proceed with next.',
].join('\n');

// ── Deterministic first (review 2026-09-13 issue 4 follow-up) ─────────────────

describe('generateOwnerBriefing — deterministic first (LLM never runs on a doctrine-shaped note)', () => {
  const NOTE_ARGS = { ...ARGS, noteContent: DOCTRINE_NOTE };

  it('a note with a project table + bold lines posts renderBriefingFromNote verbatim and does NOT call utilityChat', async () => {
    expect(await generateOwnerBriefing(NOTE_ARGS)).toBe(true);
    expect(mockUtilityChat).not.toHaveBeenCalled();
    expect(postedContent()).toBe(renderBriefingFromNote(DOCTRINE_NOTE));
    expect(postedContent()).toContain('dflash2 speed run: Speed check passed');
    expect(postedContent()).toContain('CanLaw: Benchmark pack: 12 of 20 cases graded');
    expect(postedContent()).toContain('Needs you: Pick framing A (cost) or B (speed)');
    expect(mockPrisma.crossModelMessage.create.mock.calls[0][0].data.metadata).toEqual({ kind: OWNER_BRIEFING_KIND, sourceNoteId: 'wake-note-9' });
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('path=deterministic'),
      { path: 'deterministic', droppedUngrounded: 0, droppedNeedsYou: false },
    );
  });

  it("the doctrine's stand-alone no-op line renders the nothing-new line deterministically — not posted with no head line (owner 2026-10-21), posted under BRIEFING_HEAD_DEDUPE_DISABLED=1", async () => {
    const noOp = { ...ARGS, noteContent: 'SWEEP: no-op — nothing moved on any project since last sweep (msg 7fc2d4e7)' };
    expect(await generateOwnerBriefing(noOp)).toBe(false);
    expect(mockUtilityChat).not.toHaveBeenCalled();
    expect(mockPrisma.crossModelMessage.create).not.toHaveBeenCalled();
    process.env.BRIEFING_HEAD_DEDUPE_DISABLED = '1';
    try {
      redisStore.clear();
      expect(await generateOwnerBriefing(noOp)).toBe(true);
      expect(postedContent()).toBe(NOTHING_NEW_LINE);
    } finally { delete process.env.BRIEFING_HEAD_DEDUPE_DISABLED; }
  });

  it('a Needs-you-ONLY rendering is not substantive — the LLM still runs (the rendering is its fallback)', async () => {
    mockUtilityChat.mockResolvedValueOnce('IDEaS proposal pack: nothing new → waiting on your pick → no ETA yet\nNeeds you: Pick framing A (cost) or B (speed)');
    expect(await generateOwnerBriefing({ ...ARGS, noteContent: NEEDS_ONLY_NOTE })).toBe(true);
    expect(mockUtilityChat).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('path=llm'), expect.objectContaining({ path: 'llm' }));
  });

  it('the deterministic rendering still passes the shared machine gate (ids scrubbed, no pipes)', async () => {
    expect(await generateOwnerBriefing(NOTE_ARGS)).toBe(true);
    expect(briefingLooksMachine(postedContent())).toBe(false);
    expect(postedContent()).not.toMatch(/7fc2d4e7|3f87efe1|ed04c9b2|15:40Z|\|/);
  });
});

describe('renderingIsSubstantive', () => {
  it('true for a project line or the nothing-new line; false for Needs-you-only or null', () => {
    expect(renderingIsSubstantive('CanLaw: graded 12 of 20 → rest tomorrow')).toBe(true);
    expect(renderingIsSubstantive(NOTHING_NEW_LINE)).toBe(true);
    expect(renderingIsSubstantive('CanLaw: graded\nNeeds you: approve')).toBe(true);
    expect(renderingIsSubstantive('Needs you: approve the second GPU block')).toBe(false);
    expect(renderingIsSubstantive(null)).toBe(false);
    expect(renderingIsSubstantive(renderBriefingFromNote(NEEDS_ONLY_NOTE))).toBe(false);
    expect(renderingIsSubstantive(renderBriefingFromNote(DOCTRINE_NOTE))).toBe(true);
    expect(renderingIsSubstantive(renderBriefingFromNote(ARGS.noteContent))).toBe(false);
  });
});

// ── Grounding gate on the LLM path ────────────────────────────────────────────

describe('generateOwnerBriefing — grounding gate (LLM path only)', () => {
  it('REPLAYS the 2026-09-13 20:37Z briefing: the label absent from the note is dropped, the invented Needs-you is dropped, grounded lines post', async () => {
    mockUtilityChat.mockResolvedValueOnce(FABRICATED_BRIEFING);
    expect(await generateOwnerBriefing({ ...ARGS, noteContent: COLLAPSED_NOTE })).toBe(true);
    const posted = postedContent();
    const lines = posted.split('\n');
    expect(lines).toEqual([
      'CanLaw: Data-point verification still pending → final merge-safe evidence review → no ETA yet',
      'dflash2 speed run: Evidence verification initiated → merge-safe check complete → later today',
      // Accepted limit: "Kimi K3" IS a substring of the note (the model-config
      // aside), so substring grounding keeps it — the deterministic-first path
      // is the real fix for doctrine notes; this gate bounds the free-form fallback.
      'Kimi K3: Verification request received → evidence review in progress → no ETA yet',
    ]);
    expect(posted).not.toContain('GLM-6');
    expect(posted).not.toMatch(/Needs you/i);
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('path=llm'),
      { path: 'llm', droppedUngrounded: 1, droppedNeedsYou: true },
    );
    expect(warnedWith('dropped 1 ungrounded', 'invented Needs-you')).toBe(true);
  });

  it('an invented "Needs you:" line is dropped when the note carries no needs-you marker (the owner is never asked for nothing)', async () => {
    mockUtilityChat.mockResolvedValueOnce(`${GOOD_BRIEFING}\nNeeds you: Approve the second GPU block or not`);
    expect(await generateOwnerBriefing(ARGS)).toBe(true);
    expect(postedContent()).toBe(GOOD_BRIEFING);
    expect(logger.info).toHaveBeenCalledWith(expect.any(String), { path: 'llm', droppedUngrounded: 0, droppedNeedsYou: true });
  });

  it('a "Needs you:" line SURVIVES when the note itself carries a needs-you marker', async () => {
    const llm = 'IDEaS proposal pack: Draft 2 complete → waiting on your pick → no ETA yet\nNeeds you: Pick framing A (cost) or B (speed)';
    mockUtilityChat.mockResolvedValueOnce(llm);
    expect(await generateOwnerBriefing({ ...ARGS, noteContent: NEEDS_ONLY_NOTE })).toBe(true);
    expect(postedContent()).toBe(llm);
    expect(logger.info).toHaveBeenCalledWith(expect.any(String), { path: 'llm', droppedUngrounded: 0, droppedNeedsYou: false });
  });

  it('every project line dropped → falls back to the deterministic rendering of the note (posted, warn names the count)', async () => {
    mockUtilityChat.mockResolvedValueOnce('GLM-6: verification underway → evidence validation → no ETA yet\nAlpha Centauri: warming up → first light → next week');
    expect(await generateOwnerBriefing({ ...ARGS, noteContent: NEEDS_ONLY_NOTE })).toBe(true);
    expect(postedContent()).toBe('Needs you: Pick framing A (cost) or B (speed) for the IDEaS proposal pack');
    expect(warnedWith('2 of 2 LLM project line(s) ungrounded', 'replaced with the deterministic rendering')).toBe(true);
    expect(logger.info).toHaveBeenCalledWith(expect.any(String), { path: 'llm', droppedUngrounded: 2, droppedNeedsYou: false });
  });

  it('every project line dropped and nothing renderable → SKIPPED (no post; lock holds; warn names the ungrounded count)', async () => {
    mockUtilityChat.mockResolvedValueOnce('GLM-6: verification underway → evidence validation → no ETA yet\nAlpha Centauri: warming up → first light → next week\nNeeds you: pick a telescope');
    expect(await generateOwnerBriefing({ ...ARGS, noteContent: 'WAKE — checked the schedules, nothing moved anywhere this pass.' })).toBe(false);
    expect(mockPrisma.crossModelMessage.create).not.toHaveBeenCalled();
    expect(redisStore.has(briefingLockKey('sup-chat-1'))).toBe(true);
    expect(warnedWith('2 of 2 LLM project line(s) ungrounded', '(+ an invented Needs-you line)', 'skipped rather than posting fabricated progress')).toBe(true);
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('a fully grounded per-project output posts verbatim — the gate never rewrites a good briefing', async () => {
    expect(await generateOwnerBriefing(ARGS)).toBe(true);
    expect(postedContent()).toBe(GOOD_BRIEFING);
    expect(warnedWith('ungrounded')).toBe(false);
  });
});

describe('groundBriefingInNote (the pure gate)', () => {
  it('drops ungrounded project lines, keeps grounded ones, and counts both', () => {
    const g = groundBriefingInNote(FABRICATED_BRIEFING, COLLAPSED_NOTE);
    expect(g.projectLines).toBe(4);
    expect(g.droppedUngrounded).toBe(1);
    expect(g.droppedNeedsYou).toBe(true);
    expect(g.text!.split('\n')).toHaveLength(3);
    expect(g.text).not.toContain('GLM-6');
  });

  it('grounds a label case-insensitively, through bold marks and bullets, and via a parsed table project name', () => {
    expect(groundBriefingInNote('**canlaw**: graded 12 of 20 → rest tomorrow', 'CanLaw graded twelve cases.').text).toBe('**canlaw**: graded 12 of 20 → rest tomorrow');
    expect(groundBriefingInNote('- CanLaw: graded → rest → tomorrow', 'CanLaw graded twelve cases.').text).toBe('- CanLaw: graded → rest → tomorrow');
    const tableNote = '| Project | Progress | ETA |\n|---|---|---|\n| [Backup-HX300](/crossmodel?chatId=abc) | copied 3 of 5 volumes | tonight |';
    expect(parseNoteProjectNames(tableNote)).toEqual(['Backup-HX300']);
    expect(groundBriefingInNote('Backup-HX300: copied 3 of 5 → 2 more → tonight', tableNote).droppedUngrounded).toBe(0);
  });

  it('non-project prose passes through untouched (nothing-new line, sentences, time-like colons)', () => {
    for (const prose of [NOTHING_NEW_LINE, 'One scheduled loop finished its run and stopped.', 'Meeting at 12:30 finished early', 'Sweep at 2:04 PM found nothing']) {
      const g = groundBriefingInNote(prose, 'WAKE — nothing moved.');
      expect(g.text).toBe(prose);
      expect(g.projectLines).toBe(0);
      expect(g.droppedUngrounded).toBe(0);
    }
  });

  it('returns text null when every project line is dropped, or when nothing survives at all', () => {
    const allDropped = groundBriefingInNote('GLM-6: x → y → z\nNothing new on any project since the last update.', 'WAKE — nothing moved.');
    expect(allDropped.text).toBeNull();
    expect(allDropped.projectLines).toBe(1);
    expect(allDropped.droppedUngrounded).toBe(1);
    const onlyInvented = groundBriefingInNote('Needs you: approve the GPU block', 'WAKE — nothing moved.');
    expect(onlyInvented.text).toBeNull();
    expect(onlyInvented.projectLines).toBe(0);
    expect(onlyInvented.droppedNeedsYou).toBe(true);
  });

  it('keeps a Needs-you line only when the note carries a marker (any doctrine shape)', () => {
    const llm = 'CanLaw: graded → rest → tomorrow\nNeeds you: approve the second GPU block';
    expect(groundBriefingInNote(llm, 'CanLaw graded.\n**Needs you** — approve the second GPU block').text).toBe(llm);
    expect(groundBriefingInNote(llm, 'CanLaw graded.\n## Needs you\n- approve the second GPU block').text).toBe(llm);
    expect(groundBriefingInNote(llm, 'CanLaw graded.\nNeeds you: approve the second GPU block').text).toBe(llm);
    const dropped = groundBriefingInNote(llm, 'CanLaw graded. The owner needs you-know-what eventually.');
    expect(dropped.text).toBe('CanLaw: graded → rest → tomorrow');
    expect(dropped.droppedNeedsYou).toBe(true);
  });
});

describe('parseNoteProjectNames + noteHasNeedsYouMarker', () => {
  it('returns the scrubbed project names in note order (bold lines + table rows), nothing for a free-form note', () => {
    expect(parseNoteProjectNames(DOCTRINE_NOTE)).toEqual(['dflash2 speed run', 'spark-cluster', 'CanLaw', 'IDEaS proposal pack']);
    expect(parseNoteProjectNames(ARGS.noteContent)).toEqual([]);
    expect(parseNoteProjectNames(COLLAPSED_NOTE)).toEqual([]);
  });

  it('detects the line-anchored needs-you shapes and ignores a mid-sentence mention', () => {
    expect(noteHasNeedsYouMarker(DOCTRINE_NOTE)).toBe(true);           // '## Needs you' section
    expect(noteHasNeedsYouMarker('**Needs you** — approve')).toBe(true); // bold inline
    expect(noteHasNeedsYouMarker('Needs you: pick A or B')).toBe(true);  // plain inline
    expect(noteHasNeedsYouMarker('- needs you: pick A or B')).toBe(true); // bulleted, any case
    expect(noteHasNeedsYouMarker(COLLAPSED_NOTE)).toBe(false);
    expect(noteHasNeedsYouMarker('the owner needs you to know nothing moved')).toBe(false);
  });
});

// ── Review 2026-09-13 issue 4: the vague fleet voice never reaches the owner ─

describe('briefingLooksVague (review 2026-09-13 issue 4)', () => {
  it('flags the three openers the owner complained about, regardless of case or leading quotes', () => {
    expect(briefingLooksVague('Your fleet is running smoothly and nothing needs you.')).toBe(true);
    expect(briefingLooksVague('Your assistants are checking in on three projects.')).toBe(true);
    expect(briefingLooksVague('  "The fleet is idle between runs."')).toBe(true);
    expect(briefingLooksVague('your FLEET checked in.')).toBe(true);
  });

  it('does not flag per-project progress lines or a mid-text fleet mention', () => {
    expect(briefingLooksVague('CanLaw: 12 of 20 cases graded → grading the rest → about 2 more days')).toBe(false);
    expect(briefingLooksVague('One loop finished. The fleet is idle between runs.')).toBe(false);
    expect(briefingLooksVague(NOTHING_NEW_LINE)).toBe(false);
  });
});

describe('renderBriefingFromNote (the deterministic renderer)', () => {
  it('renders one plain line per project from the bold lines + table rows, bold winning over table, plus a Needs-you line', () => {
    const out = renderBriefingFromNote(DOCTRINE_NOTE)!;
    expect(out).not.toBeNull();
    const lines = out.split('\n');
    // Table rows first (they appear first in the note), then the bold projects.
    expect(lines[0]).toBe('dflash2 speed run: Speed check passed — 4 of 8 comparisons done → tomorrow evening');
    expect(lines[1]).toBe('spark-cluster: Benchmark wait finished, results being written up → no ETA yet');
    expect(lines[2]).toBe('CanLaw: Benchmark pack: 12 of 20 cases graded → grading the rest → about 2 more days');
    expect(lines[3]).toBe('IDEaS proposal pack: Draft 2 complete → waiting on your pick of the two framings → no ETA yet');
    expect(lines[4]).toBe('Needs you: Pick framing A (cost) or B (speed) for the IDEaS proposal pack');
    expect(lines).toHaveLength(5);
    // The headline, the Receipts line and every id / Z-time / link URL are gone.
    expect(out).not.toMatch(/Fleet sweep|Receipts|7fc2d4e7|3f87efe1|ed04c9b2|15:40Z|chatId|\*\*|\|/);
    expect(briefingLooksMachine(out)).toBe(false);
    expect(briefingLooksVague(out)).toBe(false);
  });

  it('a bold line for a project already in the table REPLACES the table row in place', () => {
    const note = [
      '| Project | Progress | ETA |', '|---|---|---|', '| CanLaw | 10 of 20 graded | no ETA yet |', '| Alpha | shipped | done |',
      '**CanLaw** — 12 of 20 graded → grading the rest → about 2 more days',
    ].join('\n');
    const lines = renderBriefingFromNote(note)!.split('\n');
    expect(lines).toEqual([
      'CanLaw: 12 of 20 graded → grading the rest → about 2 more days',
      'Alpha: shipped → done',
    ]);
  });

  it('a **Needs you** — inline bold line is a decision line, never a project', () => {
    const out = renderBriefingFromNote('**CanLaw** — graded 12 of 20 → rest tomorrow\n**Needs you** — approve the second GPU block or not')!;
    expect(out).toBe('CanLaw: graded 12 of 20 → rest tomorrow\nNeeds you: approve the second GPU block or not');
  });

  it("the doctrine's stand-alone no-op line renders as the single nothing-new line", () => {
    expect(renderBriefingFromNote('SWEEP: no-op — nothing moved on any project since last sweep')).toBe(NOTHING_NEW_LINE);
    expect(renderBriefingFromNote('WAKE: no-op; chain still gated, no action.')).toBe(NOTHING_NEW_LINE);
  });

  it('returns null when the note holds nothing renderable (caller skips rather than posting the vague sentence)', () => {
    expect(renderBriefingFromNote('WAKE — schedule sc-1 auto-disabled (cadence stop). The cadence-stop loop has ended.')).toBeNull();
    expect(renderBriefingFromNote('| Project | Progress | ETA |\n|---|---|---|')).toBeNull(); // header + separator only
    expect(renderBriefingFromNote('**Fleet sweep — 2:04 PM: all quiet**')).toBeNull(); // headline only — not a project
    expect(renderBriefingFromNote(ARGS.noteContent)).toBeNull(); // the free-form fixture stays on the LLM path
    expect(renderBriefingFromNote(COLLAPSED_NOTE)).toBeNull();
  });

  it('never renders the vague fleet-voice openers as project names (structurally un-vague)', () => {
    expect(renderBriefingFromNote('**Your fleet** — is running smoothly → nothing next → no ETA')).toBeNull();
    expect(renderBriefingFromNote('| Project | Progress | ETA |\n|---|---|---|\n| The fleet | idle between runs | — |')).toBeNull();
  });

  it('caps at 8 project lines and truncates over-long lines', () => {
    const note = Array.from({ length: 12 }, (_, i) => `**Project ${String.fromCharCode(65 + i)}** — ${'moved a lot '.repeat(30)}→ next → no ETA yet`).join('\n');
    const lines = renderBriefingFromNote(note)!.split('\n');
    expect(lines).toHaveLength(8);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(240);
    expect(lines[0].endsWith('…')).toBe(true);
  });
});

describe('scrubMachineArtifacts', () => {
  it('strips owner-nav links to their label, receipt ids, Z-times and emphasis', () => {
    expect(scrubMachineArtifacts('[Backup-HX300](/crossmodel?chatId=abc) finished (msg 7fc2d4e7) at 15:40Z, **done**'))
      .toBe('Backup-HX300 finished, done');
    expect(scrubMachineArtifacts('ticket ed04c9b2 closed; sha 85f8d318aac649ba landed')).toBe('closed; landed');
    expect(scrubMachineArtifacts('deadbeef prose survives')).toBe('deadbeef prose survives'); // no digit — a word, not an id
  });

  it('leaves no hollow separators where ids were removed (fleet-supervisor assessment 2026-09-15 — the 18:18Z briefing)', () => {
    // The observed shape (ids already gone): a run of separators after the opener.
    expect(scrubMachineArtifacts('six worker deaths in ~1.5h ( / / + three self-recovered)'))
      .toBe('six worker deaths in ~1.5h (three self-recovered)');
    // Ids between separators inside a labelled list collapse to one gap (audit 2026-10-08 W1-6: under
    // BRIEFING_SCRUB_HOLES_DISABLED=1 — the default now counts a labelled list, see the W1-6 cases below).
    process.env.BRIEFING_SCRUB_HOLES_DISABLED = '1';
    try {
      expect(scrubMachineArtifacts('six worker deaths in ~1.5h (lanes 3e1cae6f / 619a1241 / 28de72e5 + three self-recovered)'))
        .toBe('six worker deaths in ~1.5h (lanes + three self-recovered)');
      // Trailing separators before the closer go too.
      expect(scrubMachineArtifacts('folded into the healthy lane (its 1a2b3c4d + 5e6f7a8b notes, msgs 9c0d1e2f / 3a4b5c6d)'))
        .toBe('folded into the healthy lane (its + notes, msgs)');
    } finally { delete process.env.BRIEFING_SCRUB_HOLES_DISABLED; }
    // Real separators between surviving words are untouched.
    expect(scrubMachineArtifacts('routes: 21/21 live, tt-flashnext up / 27B gone')).toBe('routes: 21/21 live, tt-flashnext up / 27B gone');
  });

  // audit 2026-10-08 W1-6 (supervisors F9) — REPLAY of the window's briefing holes (Schooltime / Fleet
  // notes as written → the briefing line). Pre-fix outputs are quoted in each comment.
  it('W1-6: id lists become counts, prepositions and tildes go with their id / Zulu time, no hollow quote lead', () => {
    // pre-fix: "Board: goals 12/13 + 4/5 active · todos + blocked/external + pending · 0 open owner questions"
    expect(scrubMachineArtifacts('Board: goals a8c755c8 12/13 + f543f095 4/5 active · todos a62eb6ce + bf3514e9 blocked/external + 511ae1b6 pending · 0 open owner questions'))
      .toBe('Board: goals 12/13 + 4/5 active · 2 todos blocked/external + 1 pending · 0 open owner questions');
    // pre-fix: "… confirmed on the new build as of."
    expect(scrubMachineArtifacts('all serving processes are confirmed on the new build as of 19:44Z.')).toBe('all serving processes are confirmed on the new build.');
    // pre-fix: "first real-audio verdict lands at the ~ check (~10:55 AM PDT)"
    expect(scrubMachineArtifacts('first real-audio verdict lands at the ~17:55Z check (~10:55 AM PDT)')).toBe('first real-audio verdict lands at the check (~10:55 AM PDT)');
    // pre-fix: "fires 3:20 PM PDT ( tonight, future)"
    expect(scrubMachineArtifacts('fires 3:20 PM PDT (22:20Z tonight, future)')).toBe('fires 3:20 PM PDT (tonight, future)');
    // pre-fix: "Verdict on: all 6 claims CONFIRMED"
    expect(scrubMachineArtifacts('Verdict on 7cabb0cc: all 6 claims CONFIRMED')).toBe('Verdict: all 6 claims CONFIRMED');
    // pre-fix: 'New live lane: " · In-chat · Tests + verify chain"'
    expect(scrubMachineArtifacts('New live lane: "0037460b · In-chat · Tests + verify chain"')).toBe('New live lane: "In-chat · Tests + verify chain"');
  });
  it('W1-6: id lists in parentheses count too; an id run without a label keeps the older collapse', () => {
    expect(scrubMachineArtifacts('six worker deaths in ~1.5h (lanes 3e1cae6f / 619a1241 / 28de72e5 + three self-recovered)'))
      .toBe('six worker deaths in ~1.5h (3 lanes + three self-recovered)');
    expect(scrubMachineArtifacts('folded into the healthy lane (its 1a2b3c4d + 5e6f7a8b notes, msgs 9c0d1e2f / 3a4b5c6d)'))
      .toBe('folded into the healthy lane (its + notes, 2 messages)');
  });
  it('W1-6: kill switch BRIEFING_SCRUB_HOLES_DISABLED=1 restores the previous output', () => {
    process.env.BRIEFING_SCRUB_HOLES_DISABLED = '1';
    try {
      expect(scrubMachineArtifacts('Board: todos a62eb6ce + bf3514e9 blocked/external + 511ae1b6 pending')).toBe('Board: todos + blocked/external + pending');
      expect(scrubMachineArtifacts('confirmed on the new build as of 19:44Z.')).toBe('confirmed on the new build as of.');
    } finally { delete process.env.BRIEFING_SCRUB_HOLES_DISABLED; }
  });
});

describe('generateOwnerBriefing — vague-voice gate (LLM path; review 2026-09-13 issue 4)', () => {
  const NEEDS_ARGS = { ...ARGS, noteContent: NEEDS_ONLY_NOTE };

  it('a "Your fleet…" output is REPLACED by the deterministic rendering of the note and posted', async () => {
    mockUtilityChat.mockResolvedValueOnce('Your fleet is running smoothly across three projects. Your assistants are making progress. Nothing needs you right now.');
    expect(await generateOwnerBriefing(NEEDS_ARGS)).toBe(true);
    const posted = postedContent();
    expect(posted).not.toMatch(/^Your fleet/);
    expect(posted).toBe('Needs you: Pick framing A (cost) or B (speed) for the IDEaS proposal pack');
    expect(warnedWith('vague fleet voice', 'replaced')).toBe(true);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('path=llm'), { path: 'llm', droppedUngrounded: 0, droppedNeedsYou: false });
  });

  it('"The fleet…" and "Your assistants…" openers trigger the same replacement', async () => {
    for (const vague of ['The fleet is idle between runs; nothing to report.', 'Your assistants checked in on every project.']) {
      jest.clearAllMocks();
      redisStore.clear();
      mockUtilityChat.mockResolvedValueOnce(vague);
      expect(await generateOwnerBriefing(NEEDS_ARGS)).toBe(true);
      expect(postedContent()).not.toBe(vague);
    }
  });

  it('a vague output over a note with nothing renderable is SKIPPED (no post; the lock holds the window)', async () => {
    mockUtilityChat.mockResolvedValueOnce('Your fleet is running smoothly. Nothing needs you.');
    expect(await generateOwnerBriefing(ARGS)).toBe(false); // ARGS note = headline + prose + a 1-row table with no progress cell
    expect(mockPrisma.crossModelMessage.create).not.toHaveBeenCalled();
    expect(redisStore.has(briefingLockKey('sup-chat-1'))).toBe(true);
    expect(warnedWith('no per-project sections to render')).toBe(true);
  });
});

describe('briefingLooksMachine (the defensive regex)', () => {
  it('flags realistic hex ids (8 and longer runs, digit required)', () => {
    expect(briefingLooksMachine('ticket ba65163d closed')).toBe(true);
    expect(briefingLooksMachine('session 85f8d318aac649ba done')).toBe(true);
    expect(briefingLooksMachine('id 375c8618')).toBe(true);
  });

  it('flags any table pipe', () => {
    expect(briefingLooksMachine('| Lane | Status |')).toBe(true);
    expect(briefingLooksMachine('a|b')).toBe(true);
  });

  it('does NOT flag plain English (incl. all-letter hex-alphabet words and short numbers)', () => {
    expect(briefingLooksMachine('Your fleet checked 3 projects and nothing needs you.')).toBe(false);
    expect(briefingLooksMachine('a decaffad deadbeef of prose')).toBe(false); // no digit — prose, not an id
    expect(briefingLooksMachine('around 6pm everything finished')).toBe(false);
    expect(briefingLooksMachine('12345678 is not hex-shaped prose but IS an id-like run')).toBe(true);
  });
});

// ── Project-supervisor preflight 2026-09-14: how a PROJECT supervisor's
//    progress reaches the owner briefing — through the fleet note's per-project
//    sections (the fleet prompt folds report-ups), never a second stream. ─────
describe('project supervisor progress folds through the fleet note (preflight 2026-09-14)', () => {
  it('a fleet note that relays a project supervisor\'s report as a bold per-project line renders deterministically with the ids scrubbed', () => {
    const fleetNote = [
      '**Fleet sweep — 04:10Z**',
      '**Alpha** — bench goal: Alpha Supervisor reports shards 3/8 done (msg 1a2b3c4d5e6f) → shards 4-8 queued on 4 workers → about a day',
      '**CanLaw** — CPT run: epoch 2 finished → eval next → no ETA yet',
      'WAKE: no-op elsewhere.',
    ].join('\n');
    const rendered = renderBriefingFromNote(fleetNote)!;
    expect(rendered).toContain('Alpha: bench goal: Alpha Supervisor reports shards 3/8 done → shards 4-8 queued on 4 workers → about a day');
    expect(rendered).toContain('CanLaw: CPT run: epoch 2 finished → eval next → no ETA yet');
    expect(rendered).not.toMatch(/1a2b3c4d/);
    expect(briefingLooksMachine(rendered)).toBe(false);
  });
});

// ── Owner 2026-09-14 (screenshots): the fleet-wide nothing-new line was landing
//    in PROJECT supervisor chats. Project scope never posts it — the hourly
//    project status card owns "no change" — and a no-op never claims the lock.
describe('generateOwnerBriefing — project-supervisor scope never posts the fleet-wide nothing-new line', () => {
  const PROJECT_ARGS = { ...ARGS, chatId: 'proj-sup-1' };
  beforeEach(() => {
    mockPrisma.crossModelChat = {
      findUnique: jest.fn(async ({ where }: any) => ({ isProjectSupervisor: where.id === 'proj-sup-1' })),
    };
  });
  afterEach(() => { delete mockPrisma.crossModelChat; });

  it('a project no-op wake posts NOTHING and leaves the lock unclaimed (a real move minutes later still briefs)', async () => {
    expect(await generateOwnerBriefing({ ...PROJECT_ARGS, noteContent: 'WAKE: no-op — nothing moved on canlegal-bench since the last wake (msg 7fc2d4e7)' })).toBe(false);
    expect(mockPrisma.crossModelMessage.create).not.toHaveBeenCalled();
    expect(mockUtilityChat).not.toHaveBeenCalled();
    expect(redisStore.has(briefingLockKey('proj-sup-1'))).toBe(false);
    expect((logger.info as jest.Mock).mock.calls.some((c) => String(c[0]).includes('no-op wake — no briefing'))).toBe(true);
  });

  it('the same no-op note in the FLEET chat takes the fleet path: it claims the lock, and posts the nothing-new line only under a head line (owner 2026-10-21) or BRIEFING_HEAD_DEDUPE_DISABLED=1', async () => {
    const noOp = { ...ARGS, noteContent: 'WAKE: no-op — nothing moved on any project (msg 7fc2d4e7)' };
    expect(await generateOwnerBriefing(noOp)).toBe(false);
    expect(redisStore.has(briefingLockKey('sup-chat-1'))).toBe(true);
    process.env.BRIEFING_HEAD_DEDUPE_DISABLED = '1';
    try {
      redisStore.clear();
      expect(await generateOwnerBriefing(noOp)).toBe(true);
      expect(postedContent()).toBe(NOTHING_NEW_LINE);
    } finally { delete process.env.BRIEFING_HEAD_DEDUPE_DISABLED; }
  });

  it('a project note WITH movement still briefs (per-project line, deterministic path)', async () => {
    expect(await generateOwnerBriefing({ ...PROJECT_ARGS, noteContent: '**canlegal-bench** — gold rebuild: 3 of 8 shards done → shards 4-8 queued → about a day\nWAKE: actions taken.' })).toBe(true);
    expect(postedContent()).toContain('canlegal-bench: gold rebuild: 3 of 8 shards done');
    expect(mockUtilityChat).not.toHaveBeenCalled();
  });

  it('the LLM path answering with the fleet-wide line on a free-form project note is skipped, never posted', async () => {
    mockUtilityChat.mockResolvedValueOnce(NOTHING_NEW_LINE);
    expect(await generateOwnerBriefing(PROJECT_ARGS)).toBe(false);
    expect(mockPrisma.crossModelMessage.create).not.toHaveBeenCalled();
    expect(redisStore.has(briefingLockKey('proj-sup-1'))).toBe(true); // generation ran → lock holds the window
  });

  it('an unmocked / failing chat lookup means fleet scope (fail-open to the status quo)', async () => {
    mockPrisma.crossModelChat.findUnique.mockRejectedValueOnce(new Error('down'));
    // Fleet scope claims the lock on a no-op (project scope never does); with no head line nothing posts (owner 2026-10-21).
    expect(await generateOwnerBriefing({ ...PROJECT_ARGS, noteContent: 'SWEEP: no-op — nothing moved (msg 7fc2d4e7)' })).toBe(false);
    expect(redisStore.has(briefingLockKey('proj-sup-1'))).toBe(true);
    expect((logger.info as jest.Mock).mock.calls.some((c) => String(c[0]).includes('fleet supervisor chat proj-sup-1 — nothing new on any project'))).toBe(true);
  });
});

// ── Supervisor OFF switch (owner 2026-09-26; platform/supervisor-switch.ts) ──
// A briefing posted while a tier is switched off (an in-flight run finishing,
// an owner turn) opens with the harness-composed status line — the owner
// reads WHY the fleet went quiet; the model never types it.
import { supervisorSwitchBriefingLine } from './owner-briefing.service';
import { invalidateSupervisorSwitchCache } from '../platform/supervisor-switch';

describe('supervisor OFF switch × owner briefing line', () => {
  beforeEach(() => {
    mockPrisma.systemSetting.findUnique.mockResolvedValue(null);
    invalidateSupervisorSwitchCache();
  });
  afterAll(() => { mockPrisma.systemSetting.findUnique.mockResolvedValue(null); invalidateSupervisorSwitchCache(); });

  it('both ON: no line, the briefing is unchanged', async () => {
    expect(await supervisorSwitchBriefingLine()).toBeNull();
    expect(await generateOwnerBriefing(ARGS)).toBe(true);
    expect(postedContent().startsWith('Fleet supervisor: OFF')).toBe(false);
  });

  it('fleet OFF: the posted briefing opens with "Fleet supervisor: OFF since … by … — wakes skipped: N"', async () => {
    mockPrisma.systemSetting.findUnique.mockImplementation(async ({ where }: any) =>
      where?.key === 'fleet_supervisor_enabled' ? { key: where.key, value: '0', updatedAt: new Date('2026-09-26T17:30:00Z') }
        : where?.key === 'fleet_supervisor_enabled_by' ? { key: where.key, value: 'paul@sunday.market', updatedAt: new Date() }
          : null);
    redisStore.set('supervisor_switch:skipped:fleet', '9');
    invalidateSupervisorSwitchCache();
    expect(await generateOwnerBriefing(ARGS)).toBe(true);
    const content = postedContent();
    expect(content.startsWith('Fleet supervisor: OFF since 2026-09-26 17:30Z by paul@sunday.market — wakes skipped: 9\n\n')).toBe(true);
    expect(content).toContain('CanLaw:');
  });
});
