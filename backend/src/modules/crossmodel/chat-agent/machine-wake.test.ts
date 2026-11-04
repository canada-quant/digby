/**
 * machine-wake preamble — pure-function tests (leaf module, no mocks needed).
 * Pins the freshness contract that stops chat-tier machine runs from citing
 * stale transcript state (fleet-supervisor postmortem 2026-08-11).
 */
import { machineWakePreamble, machineFiringHeader, stripMachineFiringHeader } from './machine-wake';

describe('machineWakePreamble', () => {
  it('grounds the run clock with an ISO timestamp', () => {
    const p = machineWakePreamble(new Date('2026-08-11T05:30:00.000Z'));
    expect(p).toContain('2026-08-11T05:30:00.000Z');
    expect(p).toContain('MACHINE-TRIGGERED RUN');
    expect(p).toContain('ONLY trustworthy clock');
  });

  it('carries the freshness contract (fresh pulls, truncation caution, brief note)', () => {
    const p = machineWakePreamble();
    expect(p).toContain('FRESHNESS CONTRACT');
    expect(p).toContain('pull everything fresh via tools THIS run');
    expect(p).toContain('may be truncated');
    expect(p).toContain('plain-English');
  });

  it('carries the owner-quote grounding rule (feedback f548536b: fabricated owner green-light)', () => {
    const p = machineWakePreamble();
    // The 2026-08-13 watcher incident: a supervisor quoted an owner go-ahead
    // that existed in NO chat and invented lane state ("Spark arm is GO").
    // The preamble is the one text every machine-triggered run always reads.
    expect(p).toContain('NEVER quote the owner');
    expect(p).toContain('go-ahead');
    expect(p).toContain('exact words appear in a tool result');
    expect(p).toContain('UNVERIFIED');
  });

  it('carries the citation-type labeling rule (feedback c8fb9b9f: run id cited as msg)', () => {
    const p = machineWakePreamble();
    // The 2026-08-30 strike: the fleet supervisor cited GitHub deploy-run id
    // 33295839578 as `msg` in a wake note; the action verifier struck the whole
    // note as a phantom claim because no such transcript message id existed.
    // The underlying fact was true — only the id label was wrong. The preamble
    // must teach the type distinction to every machine-triggered run.
    // (Slim 2026-09-18: the c8fb9b9f incident REFERENCE moved out of the
    // per-wake prompt text into machine-wake.ts's comment header — archaeology
    // is documented, not billed per wake; the semantic pins below still guard
    // the teaching.)
    expect(p).toContain('true type');
    expect(p).toContain("'msg' is ONLY a transcript message id");
    expect(p).toContain("never 'msg'");
  });

  it('carries the unreadable-lane citation rule (feedback edcf4dda: phantom msg ids on prefix-addressed lanes)', () => {
    const p = machineWakePreamble();
    // The 2026-08-30 strikes: the fleet supervisor cited transcript msg ids for
    // lanes addressed by 8-char PREFIXES — get_chat_messages needs the exact id,
    // returned 'Chat not found', and the wake note invented plausible msg ids
    // (three strikes in 40 min: e6def38c / 422a43d7 / 7c1e3d9e). The preamble
    // must teach: resolve via list_chats or the 'Did you mean' hint, and if the
    // lane stays unreadable cite NO msg ids from it.
    // (slim 2026-09-18: edcf4dda reference moved to machine-wake.ts comments.)
    expect(p).toContain('EXACT id');
    expect(p).toContain('list_chats');
    expect(p).toContain('Did you mean');
    expect(p).toContain('Chat not found');
    expect(p).toContain('cite NO msg ids');
  });

  it('carries the evidence-list rule (feedback 5448a836: invented msg + schedule ids on a list_schedules observation)', () => {
    const p = machineWakePreamble();
    // The 2026-08-30 18:34Z strike — the 4th same-day phantom-citation strike:
    // the fleet supervisor observed a monitor's firing #2 via list_schedules
    // (real row 08ae015c, runs 2/32), had no msg id for the fact, and minted
    // [msg:fa6942ce] plus an invented schedule id 1fd6a55f. The owner's
    // announced escalation: the note may cite ONLY ids a tool result returned
    // THIS run, labeled by source family; a fact whose tool returned no id is
    // stated bare. The preamble must teach all of it to every machine run.
    expect(p).toContain('EVIDENCE LIST');
    expect(p).toContain('ACTUALLY returned this run');
    expect(p).toContain('copied VERBATIM');
    expect(p).toContain('[EVIDENCE LEDGER'); // feedback a84cc306: the harness-maintained list the rule points at
    expect(p).toContain("'sched' for a list_schedules id");
    expect(p).toContain('WITHOUT any id');
    // (slim 2026-09-18: 5448a836 reference moved to machine-wake.ts comments.)
  });

  it('carries the prefix-citation contract (2026-08-31: id-splice strikes — real 8-char prefixes, confabulated uuid suffixes)', () => {
    const p = machineWakePreamble();
    // The model demonstrably reproduces an id's first 8 chars verbatim but
    // confabulates a 36-char uuid's suffix (three strikes in one morning, all
    // with REAL prefixes). The contract now matches model fidelity: cite the
    // 8-char prefix only; full ids belong to tool INPUTS, never the note.
    expect(p).toContain('first 8 chars');
    expect(p).toContain('never a full 36-char uuid');
    expect(p).toContain('true 8-char prefix exonerates');
    // rule 5: list_chats' lastMessageId is a legitimate msg-id source (a lane's
    // latest message gets a REAL citable id — no more invention pressure).
    expect(p).toContain('lastMessageId');
  });

  it('carries the clock-discipline rule (feedback 2c15e65a: projected landing-time headlines struck as phantom clocks)', () => {
    const p = machineWakePreamble();
    // The 2026-08-31 strikes (two in 15 min): the fleet supervisor headlined a
    // wake note "9:58 PM PDT (04:58Z)" and claimed a "04:54:40Z" transcript
    // observation while the run's real clock was 04:40:07Z — the headline was
    // a projected landing time (wake clock + estimated run duration), and the
    // "observed" message did not exist in the cited lane. The preamble must
    // teach: a "now" timestamp comes only from a clock printed THIS run and is
    // never later than the latest one; future times only as labeled future
    // events; otherwise headline the wake line's time verbatim.
    expect(p).toContain('CLOCK DISCIPLINE');
    // (slim 2026-09-18: 2c15e65a / ad325229 references moved to comments.)
    expect(p).toContain('NEVER be later than the latest such clock');
    expect(p).toContain('landing time');
    expect(p).toContain('labeled as a future event');
    expect(p).toContain("headline the wake line's time verbatim");
    // ad325229 (2026-09-16): the per-turn [HARNESS CLOCK] note now rides
    // chat-lane machine wakes — rule 8 must name it as the canonical fresh
    // "now" source so the lane never estimates (the phantom "19:21Z" cause).
    expect(p).toContain('[HARNESS CLOCK]');
  });

  it('states the zero-tool gate HONESTLY — records tool-less answers, the evidence guard marks uncited claims (spark B30; gate flip 2026-09-11)', () => {
    const p = machineWakePreamble();
    // The old text claimed "rejected deterministically", then (B30) "DISCARDS
    // your first tool-less draft and grants one probe round". Since the
    // 2026-09-11 gate flip (owner: full steam) the zero-tool gate in
    // coding/agent.ts is OBSERVE-ONLY by default — it RECORDS a tool-less
    // answer (GUARD_STRIKE seam zero_tool_prefinal outcome 'observed') and
    // the evidence guard marks uncited claims UNVERIFIED; the discard/probe
    // round exists only behind ZERO_TOOL_GATE_ENFORCE=1. The preamble must
    // match the default code path, not overstate it.
    expect(p).not.toContain('rejected deterministically');
    expect(p).not.toContain('DISCARDS your first tool-less draft');
    expect(p).not.toContain('grants one probe round');
    expect(p).toContain('the harness records tool-less answers');
    expect(p).toContain('the evidence guard strikes uncited claims');
    expect(p).toContain('marked UNVERIFIED');
    // Only evidence-bearing calls count (coding/evidence-tools.ts) — say so.
    expect(p).toContain('plan/memory-search calls do not count as probes');
  });

  it('names the id-minting tools explicitly in rule 5 (ticket b216475a: passive "tickets filed" prose escaped the enumeration)', () => {
    const p = machineWakePreamble();
    // The 2026-09-13 incident: the Fleet Supervisor delivered "All 3
    // engineering-lane demands filed" + "Receipts: tickets 1322de9e / …" with
    // four FABRICATED ticket ids — the old enumeration ("dispatched, messaged,
    // scheduled, cancelled, or updated") never named filing, so the freshness
    // contract didn't reach it. Rule 5 now names the id-minting tools and
    // states the tool-agnostic receipt bar.
    expect(p).toContain('filed (file_feedback)');
    expect(p).toContain('triage_ticket / update_schedule / todo_update / goal_update'); // model-facing spelling (tool-scope.ts)
    expect(p).toContain('tool-agnostic');
    expect(p).toContain('an action with no returned id did not happen');
  });

  it('defaults to the current time and ends with a blank separator line', () => {
    const before = Date.now();
    const p = machineWakePreamble();
    const after = Date.now();
    const m = p.match(/Current time: (\S+) —/);
    expect(m).toBeTruthy();
    const t = new Date(m![1]).getTime();
    expect(t).toBeGreaterThanOrEqual(before - 1000);
    expect(t).toBeLessThanOrEqual(after + 1000);
    expect(p.endsWith('\n\n')).toBe(true);
  });
});

describe('machineFiringHeader — continuation framing (audit 2026-10-06 T4-6)', () => {
  it('a harness continuation names the run it continues and never claims a schedule firing; one bracketed line', () => {
    const h = machineFiringHeader('continuation', { continuationOf: 'abcdef12-3456-7890-abcd-ef1234567890' });
    expect(h.startsWith('[MACHINE-TRIGGERED RUN — a harness continuation of run abcdef12 on this chat')).toBe(true);
    expect(h).not.toContain('scheduled firing');
    expect(h).toContain('CLAIM BAR');
    const firstLine = h.split('\n')[0];
    expect(firstLine.indexOf(']')).toBe(firstLine.length - 1);
    expect(stripMachineFiringHeader(`${h}do the thing`)).toBe('do the thing');
    expect(machineFiringHeader('continuation')).toContain('a harness continuation of the previous run on this chat');
  });
});

describe('machineFiringHeader (fbe65673 — coding-run provenance marker)', () => {
  it('starts with the wake-envelope prefix so the UI classifier collapses it', () => {
    // Byte-aligned with machineWakePreamble + frontend/lib/machine-wake.ts
    // WAKE_PREFIX — schedule-fired coding runs must render as collapsed
    // machine-wake rows, not owner-lookalike bubbles.
    expect(machineFiringHeader('schedule').startsWith('[MACHINE-TRIGGERED RUN')).toBe(true);
    expect(machineFiringHeader('hook').startsWith('[MACHINE-TRIGGERED RUN')).toBe(true);
  });

  it('names a scheduled firing and carries the owner-governance rule', () => {
    const h = machineFiringHeader('schedule');
    expect(h).toContain('scheduled firing');
    expect(h).toContain('NOT a human-typed message');
    // The incident rule: an explicit owner instruction (e.g. "pause work")
    // governs over a stale queued firing.
    expect(h).toContain('GOVERNS');
    expect(h).toContain('pause work');
    expect(h.endsWith('\n\n')).toBe(true);
  });

  // Ticket f5ff8329 (replay): coding session 7fbd168c's schedule-fired runs
  // were repeatedly struck by the evidence guard (zero-evidence probe claims,
  // fabricated clock citations) because the firing message carried NO claim
  // discipline — the bar reached coding runs only via owner-authored prompts,
  // dispatch briefs (PR #569), and continuation notes. The bar must now ride
  // EVERY machine firing (schedule + hook) without breaking the two header
  // contracts: single bracketed line (strip regex / title seeds) and the
  // WAKE_PREFIX byte alignment (UI classifier).
  describe('claim bar rides every machine firing (f5ff8329)', () => {
    it.each(['schedule', 'hook'] as const)('carries the artifact-citation demand for %s firings', (origin) => {
      const h = machineFiringHeader(origin);
      expect(h).toContain('CLAIM BAR');
      expect(h).toContain('tool-result artifact observed THIS run');
      expect(h).toContain('no artifact = no claim');
      // Clock fabrication was the second strike class in f5ff8329.
      expect(h).toContain('never estimates');
    });

    it.each(['schedule', 'hook'] as const)('states the zero-tool gate honestly for %s firings (spark B30; gate flip 2026-09-11 — records, never discards by default)', (origin) => {
      const h = machineFiringHeader(origin);
      expect(h).not.toContain('rejected deterministically');
      expect(h).not.toContain('discarded with one probe round granted');
      expect(h).not.toContain('withheld as fabricated');
      expect(h).toContain('The harness records tool-less answers');
      expect(h).toContain('the evidence guard strikes uncited claims claim-by-claim');
      expect(h).toContain('uncited claims are marked UNVERIFIED');
    });

    // P4 (claims fence): the bar OFFERS the typed ```claims block the harness
    // verifies deterministically (claims-block.ts grammar) — and names the
    // exact type vocabulary + ref semantics so a compliant block parses.
    // Gate flip 2026-09-11 (flip 5): the fence is optional ("you MAY end it")
    // and an unmatched entry is marked UNVERIFIED, never "convicted as
    // fabricated" (112 convictions incl. the one real CanLaw report).
    it.each(['schedule', 'hook'] as const)('offers (never mandates) the typed claims fence for %s firings (P4 item 11; flip 5)', (origin) => {
      const h = machineFiringHeader(origin);
      expect(h).toContain('you MAY end it with a fenced claims block');
      expect(h).not.toContain('END it with a fenced claims block');
      expect(h).not.toContain('convicted as fabricated');
      expect(h).toContain('an entry with no matching receipt is marked UNVERIFIED');
      expect(h).toContain('push | pr | merge | deploy | commit | ticket_update | message_sent | dispatch | file_change | verify | schedule_armed | email_sent | state_update');
      expect(h).toContain('{"type":"...","ref":"..."}');
      expect(h).toContain('receipt-visible id');
    });

    it('stays ONE bracketed line — strip regex + title seeds keep working', () => {
      for (const origin of ['schedule', 'hook'] as const) {
        const h = machineFiringHeader(origin);
        // The strip regex (/^\[MACHINE-TRIGGERED RUN — [^\]\n]*\]\n\n/) dies on
        // any inner newline or ']' — pin both contracts. slice(0, -3) drops the
        // legal closing ']' + '\n\n'; everything before it must be clean.
        expect(h.endsWith('\n\n')).toBe(true);
        expect(h.slice(0, -2)).not.toContain('\n');
        expect(h.slice(0, -3)).not.toContain(']');
        expect(stripMachineFiringHeader(h + 'do the thing')).toBe('do the thing');
      }
    });
  });

  it('names a hook wake distinctly from a schedule firing', () => {
    const h = machineFiringHeader('hook');
    expect(h).toContain('event hook');
    expect(h).not.toContain('recurring/one-shot schedule');
    expect(h).toContain('NOT a human-typed message');
  });
});

describe('stripMachineFiringHeader (review finding 3 — title seeds must not inherit the chrome)', () => {
  it('removes a queue-time schedule header, leaving the goal verbatim', () => {
    const goal = 'DAILY CHAT AUDIT — run the battery';
    expect(stripMachineFiringHeader(machineFiringHeader('schedule') + goal)).toBe(goal);
  });

  it('removes the hook variant too', () => {
    expect(stripMachineFiringHeader(machineFiringHeader('hook') + 'wake up')).toBe('wake up');
  });

  it('leaves human-typed text untouched — including text that merely mentions the marker mid-string', () => {
    expect(stripMachineFiringHeader('pause work')).toBe('pause work');
    const mid = 'note: [MACHINE-TRIGGERED RUN — quoted by a human]\n\nmore';
    expect(stripMachineFiringHeader(mid)).toBe(mid);
  });

  it('leaves the multi-line plain-chat preamble untouched (never appears in the coding lane)', () => {
    const p = machineWakePreamble(new Date('2026-08-27T00:00:00.000Z')) + 'do the sweep';
    expect(stripMachineFiringHeader(p)).toBe(p);
  });
});
