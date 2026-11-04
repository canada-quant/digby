/**
 * Characterization pin — log-signal family lane 0dc83e5c, 2026-10-20 (tickets
 * e194233a + 4e2ac114): the two warn fingerprints the hourly log-signal-sweep
 * filed are TWO DESIGNED observability classes (not defects), and this suite
 * pins each one's designed behavior so a future refactor cannot silently
 * change the warn shapes/levels the sweep fingerprints, or the bounds that
 * keep the classes bounded. Cites BOTH member prefixes so one replayTestPath
 * serves both tickets' closes (the 99e4a4eb family-lane precedent).
 *
 * MEMBER 1 — e194233a "chat-agent: machine-wake note struck pre-delivery —
 * rejecting back for ONE bounded re-orchestration (<n> phantom claim(s))".
 *   Emitting site: chat-agent.service.ts runRejectBackAndSecondPass (the
 *   ticket-b216475a pre-delivery guard). Every warn row is ONE machine wake
 *   whose draft carried phantom claims (1-5), struck pre-delivery and bounced
 *   for EXACTLY ONE bounded re-orchestration; the retry is then re-guarded
 *   with consequences ON. This is the fabrication-guard WORKING: the 24h
 *   probe (2026-10-20, box A) read 22 'clean' / 3 'still_dirty' retries
 *   (88% self-correction) and the warns spread across 14 distinct hours and
 *   10+ distinct chats — distinct wakes, NOT a retry storm, NOT lost
 *   suppression state. Warn LEVEL is the observability contract: the sweep
 *   reads warn+error only, so a designed strike must stay warn to stay
 *   visible.
 *
 * MEMBER 2 — 4e2ac114 "ticket-dispatch: lane <id> (ticket <id> closed)
 * unarchivable for <n> min — slot released (bf656696)".
 *   Emitting site: ticket-dispatch.service.ts closed-lane archive loop (the
 *   bf656696 backstop). The 24h window: 4 lanes fired ONE 30-min warn each
 *   and archived on the next drain (designed); lane d7ead5f8 (ticket
 *   8d7d07b0) burned 13 warns over 210 min because its post-close
 *   verification run 3b428f32 (created 22:30:45Z, completed 01:47:38Z
 *   2026-10-20) kept the chat LIVE for 3h17m — archiveChat 409-refuses
 *   while a run is active (platform.service) and run-reaper rule (a) only
 *   heals sessions with NO claimable run row. The backstop did its whole
 *   job: it released the slot at 30 min (the queue was never starved),
 *   posted ONE attention_needed notice, and the archive landed at
 *   02:08:38.874Z — 21 min after the run completed — clearing the episode.
 *   A closed ticket's lane must never starve the queue, and by design it
 *   warns while it waits out a legitimately-live post-close run.
 *
 * Adjudication (lane 0dc83e5c, 2026-10-20): no deterministic framework
 * defect in either class — the recurrence IS the designed containment
 * working. The pins below assert the exact warn strings, the warn LEVEL,
 * the ONE-bounded retry contract, the 30-min release bound and the
 * once-per-episode notice, so the classes remain visible to the sweep but
 * are never mistaken for plumbing failures again.
 */
import fs from 'fs';
import path from 'path';

const read = (rel: string) => fs.readFileSync(path.join(__dirname, rel), 'utf8');

describe('log-signal family 0dc83e5c — e194233a + 4e2ac114 designed-class pins', () => {
  // ── MEMBER 1: e194233a — the machine-wake reject-back warn ──────────
  describe('e194233a — chat-agent machine-wake pre-delivery reject-back (guard working)', () => {
    const svc = () => read('./chat-agent/chat-agent.service.ts');

    it('the reject-back warn keeps the exact fingerprinted shape and carries WHAT was struck, not just the count', () => {
      const src = svc();
      const warnAt = src.indexOf("machine-wake note struck pre-delivery");
      expect(warnAt).toBeGreaterThan(-1);
      const line = src.slice(warnAt, warnAt + 400);
      // the sweep's fingerprinted prefix, verbatim (fingerprintHash 581f8d30)
      expect(line).toContain('— rejecting back for ONE bounded re-orchestration (');
      expect(line).toContain('${guarded.phantoms.length} phantom claim(s))');
      // f57 (firing 57): the audit excerpt rides the warn — WHAT was struck
      expect(line).toContain('claims: claimAuditExcerpts(guarded.phantoms ?? [])');
      // firing-50: the source stamp rides the warn (attribution)
      expect(line).toContain("source: 'chat-agent'");
    });

    it('the warn is WARN level (the observability contract: the sweep reads warn+error only)', () => {
      const src = svc();
      const at = src.indexOf('machine-wake note struck pre-delivery');
      expect(at).toBeGreaterThan(-1);
      // the call STARTS with logger.warn — not info/debug (info lines are
      // invisible to the sweep and to the errors view)
      const callStart = src.lastIndexOf('logger.', at);
      expect(src.slice(callStart, callStart + 'logger.warn('.length)).toBe('logger.warn(');
    });

    it('the reject-back is bounded to ONE re-orchestration — no unbounded retry loop', () => {
      const src = svc();
      // the retry helper exists and is called from BOTH enforcement branches,
      // but nothing re-enters it (no second-order retry): pass 2 re-guards
      // with consequences ON and takes the normal struck path exactly once.
      const fnDef = src.indexOf('const runRejectBackAndSecondPass =');
      expect(fnDef).toBeGreaterThan(-1);
      // The helper's OWN closing brace (its 6-space indent): a statement inside it may end in '};' too (the
      // 2026-10-21 guard_cycle_repeat stamp `rejectBackCycle = { swapped: retrySwapped };`), so the first
      // '};' is not the end of the function.
      const fnBody = src.slice(fnDef, src.indexOf('\n      };', fnDef));
      expect(fnBody).toContain("consequenceScope: secondPassScope");
      // the retry budget is bounded: ONE pass-2 re-guard, no pass-3 seam
      expect(src).not.toMatch(/pass3|thirdPass/);
      // HARD count (review A2, PR #1816): the name followed by '(' appears
      // exactly THREE times — the two guard call sites (enforce +
      // citation-enforce) and the struck-note-repeat site (tickets 4c7aebf7 +
      // 9a976d83, 2026-10-21), which runs ONLY when neither guard site is armed
      // for this note (`!guardRejectBackArmed`) — so a run still re-orchestrates
      // at most once. The definition reads '…SecondPass = async (' so it does
      // not match. A second-order retry added as recursion inside the helper,
      // or a fourth call site, breaks this pin even when no 'pass3' identifier
      // exists.
      const occurrences = src.match(/runRejectBackAndSecondPass\(/g)?.length ?? 0;
      expect(occurrences).toBe(3);
      // the two guard call sites: enforce ('all') + citation-enforce ('citation-only')
      expect(src).toContain("await runRejectBackAndSecondPass('all')");
      expect(src).toContain("await runRejectBackAndSecondPass('citation-only')");
      // the repeat site, gated on no armed guard reject-back (one cycle per run)
      const repeatAt = src.indexOf("await runRejectBackAndSecondPass(actionVerifierEnforce ? 'all' : 'citation-only')");
      expect(repeatAt).toBeGreaterThan(-1);
      expect(src.slice(src.lastIndexOf('if (', repeatAt) - 200, repeatAt)).toContain('if (!guardRejectBackArmed) {');
      // and the helper's own body never calls itself (no recursion seam)
      expect(fnBody).not.toContain('runRejectBackAndSecondPass(');
    });

    it('the reject-back outcome telemetry rides guard_strike (citationRetry clean/still_dirty) — the class stays measurable', () => {
      const src = svc();
      // the audit-live-state citation_retry_outcomes_7d rollup reads these
      // exact meta keys — the health signal for this class
      expect(src).toContain("seam: 'machine_wake_reject_back'");
      expect(src).toContain("citationRetry: guarded.struck ? 'still_dirty' : 'clean'");
      expect(src).toContain('struckClaims: firstPassStruckClaims');
    });
  });

  // ── MEMBER 2: 4e2ac114 — the unarchivable-lane slot-release warn ────
  describe('4e2ac114 — ticket-dispatch lane unarchivable slot-release (backstop working)', () => {
    const svc = () => read('./feedback/ticket-dispatch.service.ts');

    it('the unarchivable warn keeps the exact fingerprinted shape (fingerprintHash 24c72280)', () => {
      const src = svc();
      const warnAt = src.indexOf('unarchivable for ');
      expect(warnAt).toBeGreaterThan(-1);
      const line = src.slice(warnAt - 120, warnAt + 260);
      expect(line).toContain('— slot released (bf656696)');
      expect(line).toContain('${Math.round(stuckMs / 60_000)} min');
      expect(line).toContain('lane ${lane.slice(0, 8)}');
      expect(line).toContain('(ticket ${t.id.slice(0, 8)} closed)');
      // attribution: the ticket-dispatch source stamp
      expect(line).toContain('{ source: SOURCE }');
    });

    it('the warn is WARN level and fires ONLY past the 30-min bound — never on every drain', () => {
      const src = svc();
      const at = src.indexOf('unarchivable for ');
      const callStart = src.lastIndexOf('logger.', at);
      expect(src.slice(callStart, callStart + 'logger.warn('.length)).toBe('logger.warn(');
      // the guard: warn (and slot release) only when stuckMs >= LANE_ARCHIVE_STUCK_MS
      const warnBlock = src.slice(at - 2200, at + 400);
      expect(warnBlock).toContain('if (stuckMs >= LANE_ARCHIVE_STUCK_MS)');
      // the bound is 30 minutes — the release backstop's design bound
      expect(src).toContain('export const LANE_ARCHIVE_STUCK_MS = 30 * 60_000;');
    });

    it('the stuck clock NEVER resets mid-episode and clears when the archive lands', () => {
      const src = svc();
      // NX claim: the first unarchived drain stamps the epoch; later drains
      // compute age from it (a live post-close run cannot reset the clock by
      // bumping activity — the d7ead5f8 episode aged 30→210 min monotonically)
      expect(src).toContain('await redisClient.set(key, String(now), { NX: true, EX: LANE_ARCHIVE_STUCK_TTL_SEC })');
      expect(src).toContain('redisClient.del(LANE_ARCHIVE_STUCK_KEY(sessionId))'); // cleared in archiveTicketLane
      // the pause-first fix (#1660): a lane's enabled schedules are retired
      // BEFORE the archive attempt, so the archive cannot deadlock on them
      expect(src).toContain('pauseSchedulesForLaneArchive(sessionId)');
    });

    it('a LIVE post-close run keeps its slot inside the window (the designed grace), then the backstop releases', () => {
      const src = svc();
      // the designed order: live + inside window → keep slot; past the window
      // → attempt archive, and only the stuck path warns. This is exactly the
      // d7ead5f8 shape: a 3h17m post-close verification run kept the lane
      // live; the slot was released at 30 min; the archive landed 21 min
      // after the run completed.
      const liveGrace = 'if (st?.chatExists && st.live && stuckMs < LANE_ARCHIVE_STUCK_MS)';
      expect(src).toContain(liveGrace);
      // 2026-10-21 lane-archive gaps (TICKET_LANE_ARCHIVE_GAPS_DISABLED): the
      // archive attempt now also carries the drain's per-pass counters and the
      // notice says whether the ticket awaits verification; the designed order
      // is unchanged — live grace FIRST, then the archive, then the notice.
      // (second review fixer 2026-10-21: an awaiting / out-of-window row's lane pauses REMEMBERED — retirePause;
      // third review 2026-10-22: every lane the gap-fixed drain archives does — closedLaneArchiveOpts;
      // fourth review 2026-10-22: except a lane still LIVE past the window, which keeps the plain bf656696 pause;
      // fifth review 2026-10-22: a lane the snapshot read archived is refused if it is live now — expectArchived.)
      const archiveAttempt = 'if (await archiveTicketLane(lane, archiveStats, { ...closedLaneArchiveOpts(gapsDisabled, newlyReached, !!(st?.chatExists && st.live)), ...(!gapsDisabled && st?.archived ? { expectArchived: true } : {}) }))';
      const notice = 'await noticeLaneArchiveStuck(lane, t.id, awaiting)';
      expect(src).toContain(archiveAttempt);
      expect(src).toContain(notice);
      expect(src.indexOf(liveGrace)).toBeLessThan(src.indexOf(archiveAttempt));
      expect(src.indexOf(archiveAttempt)).toBeLessThan(src.indexOf(notice));
    });

    it('the notice is once per episode (NX gate) — 13 warns on d7ead5f8 but ONE supervisor notice', () => {
      const src = svc();
      const noticeAt = src.indexOf('async function noticeLaneArchiveStuck');
      expect(noticeAt).toBeGreaterThan(-1);
      const body = src.slice(noticeAt, noticeAt + 1400);
      expect(body).toContain('redisClient.set(LANE_ARCHIVE_NOTICE_KEY(laneId), \'1\', { NX: true, EX: LANE_ARCHIVE_STUCK_TTL_SEC })');
      expect(body).toContain("if (claimed !== 'OK') return;"); // once per episode
      expect(body).toContain("'attention_needed'");
    });
  });
});

// ── Log-signal family lane f02ac12e — ticket f068e472 (2026-10-26) ─────────────
// The f068e472 fingerprint (2026-10-25 filing; 18 rows across 9 distinct
// hours, Oct 24) is the 4e2ac114 class above — the SAME emit site, the SAME
// backstop, the SAME designed contract:
//   ticket-dispatch: lane 6ed158ca (ticket 68a1c868 closed) unarchivable for
//   764 min — slot released (bf656696)
// Adjudication (lane f02ac12e, 2026-10-26): not a framework defect. The
// recurrence is the designed backstop: a closed ticket's lane must never
// starve the queue, so past LANE_ARCHIVE_STUCK_MS the slot is released and
// the supervisor gets ONE notice per episode while the archive keeps
// retrying. The episode from the rows: lane 6ed158ca (ticket 68a1c868,
// closed) aged 764 minutes because a legitimately-live post-close run kept
// its chat unarchivable (archiveChat 409-refuses while a run is active);
// the backstop released the slot at 30 min, and the class went quiet on its
// own (probe, 24h window at 00:13Z: ZERO rows — newest row 2026-10-24T23:48Z,
// >24h stale; the episode self-healed exactly as the d7ead5f8 precedent did).
// The 4e2ac114 pins above already hold the contract for this emit site; this
// block adds the f068e472-named assertions so one replayTestPath serves both
// tickets' closes (the 99e4a4eb family-lane precedent).
describe('f068e472 — the SAME unarchivable class, the self-healed 6ed158ca episode (backstop working, class gone quiet)', () => {
  const svc = () => read('./feedback/ticket-dispatch.service.ts');

  it('the f068e472 rows are the same emit line the 4e2ac114 pins hold — one warn per stuck drain, 30-min bound, slot released', () => {
    const src = svc();
    const warnAt = src.indexOf('unarchivable for ');
    expect(warnAt).toBeGreaterThan(-1);
    const line = src.slice(warnAt - 160, warnAt + 300);
    // The exact fingerprint prefix (fingerprintHash 86ad52a2) — verbatim.
    expect(line).toContain('lane ${lane.slice(0, 8)} (ticket ${t.id.slice(0, 8)} closed) unarchivable for ${Math.round(stuckMs / 60_000)} min — slot released (bf656696)');
    // The warn is WARN level — the observability contract (sweep reads warn+error).
    const callStart = src.lastIndexOf('logger.', warnAt);
    expect(src.slice(callStart, callStart + 'logger.warn('.length)).toBe('logger.warn(');
    // The bound: warn + release ONLY past 30 min, inside the same stuck block.
    expect(src).toContain('if (stuckMs >= LANE_ARCHIVE_STUCK_MS)');
    expect(src).toContain('export const LANE_ARCHIVE_STUCK_MS = 30 * 60_000;');
  });

  it('the stuck clock is NX-claimed per episode and never resets — the 764-min monotone age of the 6ed158ca rows proves it', () => {
    const src = svc();
    expect(src).toContain('await redisClient.set(key, String(now), { NX: true, EX: LANE_ARCHIVE_STUCK_TTL_SEC })');
    expect(src).toContain('redisClient.del(LANE_ARCHIVE_STUCK_KEY(sessionId))');
    // live grace first, then the archive attempt, then the notice — the
    // designed order that the 6ed158ca episode followed (a live post-close
    // run holds the lane, the slot still releases at 30 min).
    expect(src).toContain('if (st?.chatExists && st.live && stuckMs < LANE_ARCHIVE_STUCK_MS)');
  });

  it('the class is bounded: ONE supervisor notice per episode, one warn per drain — no retry storm, no flood', () => {
    const src = svc();
    const noticeAt = src.indexOf('async function noticeLaneArchiveStuck');
    expect(noticeAt).toBeGreaterThan(-1);
    const body = src.slice(noticeAt, noticeAt + 1400);
    expect(body).toContain("redisClient.set(LANE_ARCHIVE_NOTICE_KEY(laneId), '1', { NX: true, EX: LANE_ARCHIVE_STUCK_TTL_SEC })");
    expect(body).toContain("if (claimed !== 'OK') return;");
    expect(body).toContain("'attention_needed'");
  });
});
