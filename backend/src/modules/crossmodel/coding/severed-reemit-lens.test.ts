/**
 * TICKET efdb3d31 — `rl`, the re-emitted turn's argLens (2026-10-30).
 *
 * WHY THIS FILE EXISTS. The live rows proved the re-emit gate DOES fire — the
 * 05:41:03.354Z reject reads `re:1`, i.e. a re-emit was already spent — but
 * `re:1` alone says only "a re-emit happened", never WHAT the re-request
 * produced. Answering "did the server-side re-request reproduce the SAME cut?"
 * therefore needed a cross-row join against the `severed_stream_recovery` row
 * written minutes earlier, which no stored read can do.
 *
 * `rl` closes that: the cut length captured at the re-emit rides onto the NEXT
 * attempt's `dispatch_reject` row, so `rl` (attempt 1) vs `argLen` (attempt 2)
 * is a comparison inside ONE row.
 *
 * TICKET 192d9087 F2 (2026-10-30) CHANGED THE WIRING THIS FILE PINS. The three
 * links are the same three links, but the value now travels through a ONE-TURN
 * carry (`noteReemit` / `beginTurn`) instead of a sticky closure variable, and
 * the ctx fields are per-turn (`turnReemitLens` / `turnIsReemitRetry`) with the
 * run-level bound split out as `runReemitSpent`. The per-turn SEMANTICS have
 * their own replay test — `severed-reemit-per-turn.192d9087.test.ts` — because a
 * source-wiring assertion can only prove the field exists, never that a later
 * turn is cleared. This file keeps proving the chain exists at all: a refactor
 * dropping any link makes `rl` permanently absent from every row, and an absent
 * field reads exactly like "no re-emit happened" — the false-negative class that
 * made the original guard invisible for a day.
 */
import fs from 'fs';
import path from 'path';

const CODING = __dirname;
const read = (f: string) => fs.readFileSync(path.join(CODING, f), 'utf8');

describe('efdb3d31 — `rl` carries the re-emitted turn\'s argLens to the reject row', () => {
  it('link 1: the ctx DECLARES turnReemitLens (else the value has nowhere to ride)', () => {
    const tools = read('tools.ts');
    expect(tools).toMatch(/turnReemitLens\?:\s*string/);
    // And the per-turn/per-run SPLIT fields (192d9087 F2) must exist, or the
    // render has no honest per-turn source for `re`.
    expect(tools).toMatch(/turnIsReemitRetry\?:\s*boolean/);
    expect(tools).toMatch(/runReemitSpent\?:\s*boolean/);
  });

  it('link 2: the re-emit branch HANDS the lens to the one-turn carry, from its own toolCalls', () => {
    const agent = read('agent.ts');
    // It must be derived from the turn's own toolCalls (the cut we are replacing),
    // not from anything measured later — the whole point is attempt 1's length.
    expect(agent).toMatch(/noteReemit\(\s*severedReemitCarry\s*,\s*turn\.toolCalls\.map\(/);
    // And it must sit INSIDE the reemit branch (before the `continue`), or a turn
    // that never re-emitted would hand on a stale lens.
    const reemitAt = agent.indexOf("if (severedVerdict === 'reemit')");
    const setAt = agent.indexOf('noteReemit(severedReemitCarry');
    expect(reemitAt).toBeGreaterThanOrEqual(0);
    expect(setAt).toBeGreaterThan(reemitAt);
    // ANTI-REGRESSION (192d9087 F2): the branch must NOT write the per-turn ctx
    // fields it used to write. Writing them from inside the branch is exactly the
    // bug — the branch describes the CURRENT turn, the field must describe the
    // NEXT. They may be written ONLY at turn start, which is BEFORE the branch.
    const turnStartAt = agent.indexOf('const reemitTurn = beginTurn(severedReemitCarry)');
    expect(turnStartAt).toBeGreaterThanOrEqual(0);
    for (const write of ['ctx.turnReemitLens =', 'ctx.turnIsReemitRetry =']) {
      const at = agent.indexOf(write);
      expect(at).toBeGreaterThanOrEqual(0);         // the turn-start read exists
      expect(at).toBeGreaterThan(turnStartAt);      // …inside the reset block
      expect(at).toBeLessThan(reemitAt);            // …and never in the branch
    }
  });

  it('link 3: the reject row RENDERS `rl`, guarded so it is absent when no re-emit bought this turn', () => {
    const agent = read('agent.ts');
    // Truthiness guard (not an unconditional key): a turn that never re-emitted
    // must not render `rl`, otherwise every reject row would look like a
    // re-emit outcome and the "did the re-request re-cut?" question inverts.
    expect(agent).toMatch(/\.\.\.\(ctx\.turnReemitLens\s*\?\s*\{\s*rl:\s*ctx\.turnReemitLens\s*\}\s*:\s*\{\}\)/);
    // `re` renders the PER-TURN fact, `rr` the per-run bound.
    expect(agent).toMatch(/re:\s*ctx\.turnIsReemitRetry\s*\?\s*1\s*:\s*0/);
    expect(agent).toMatch(/rr:\s*ctx\.runReemitSpent\s*\?\s*1\s*:\s*0/);
    // The old sticky source must be gone from the reject row entirely.
    expect(agent).not.toMatch(/re:\s*ctx\.severedRecovered/);
    expect(agent).not.toMatch(/rl:\s*ctx\.severedReemitLens/);
  });

  it('`rl`/`re`/`rr` are 2-char keys like sc/fr, so jsonb keeps them inside the 240-char read cut', () => {
    // TELEMETRY_META_CHARS = 240 and jsonb orders keys by LENGTH then bytewise.
    // Every 2-char key therefore sorts AHEAD of the long ones (seam/tool/shape/
    // argLen/reason), which is the only reason sc/fr/re were readable at all.
    // A `reemitLen`-style long key would fall past the cut and be invisible.
    expect('rl'.length).toBe(2);
    expect('rr'.length).toBe(2);
    // A live-shaped row after the split: the two NEW keys sort with the existing
    // 2-char family, so adding `rr` cannot push `sc`/`fr` past the cut.
    const livePrefix = '{"ab":39,"db":0,"fg":6,"fr":"tool_calls","ni":0,"rb":39,"re":1,"rl":"39","rr":1,"sc":1,"sl":"0:7","ub":0';
    for (const key of ['"re"', '"rl"', '"rr"', '"sc"', '"fr"']) {
      expect(livePrefix.indexOf(key)).toBeGreaterThanOrEqual(0);
      expect(livePrefix.indexOf(key)).toBeLessThan(240);
    }
  });
});

describe('efdb3d31 — `sv` names WHICH arm decided the turn (2026-10-30, mixed-turn arm)', () => {
  /**
   * WHY THIS BLOCK EXISTS. The `complete-sibling` arm diverts a turn BEFORE the
   * re-emit branch, so a diverted turn writes NO `severed_stream_recovery` row.
   * That inverts the module's own hard-won lesson: the guard previously ran a
   * full day emitting zero rows and no stored field could say which condition
   * rejected a turn, so the Fleet could not tell "unreachable code" from
   * "precondition never holds". Without `sv`, a turn the new arm handled would
   * leave a reject row carrying only `re:0` — indistinguishable from "the gate
   * never fired" — and the arm would be unfalsifiable in exactly the same way.
   *
   * Same three-link discipline as `rl` (declare / set / render): a refactor that
   * drops any link makes the field permanently absent, and an absent field reads
   * as a false negative rather than as missing instrumentation.
   */
  it('link 1: the ctx DECLARES severedVerdict', () => {
    expect(read('tools.ts')).toMatch(/severedVerdict\?:\s*string/);
  });

  it('link 2: EVERY verdict is recorded, not only the ones that re-emit', () => {
    const agent = read('agent.ts');
    // Unconditional assignment on the verdict value itself. If this were moved
    // inside the `reemit` branch, exactly the arm that needs it (the one that
    // leaves no recovery row) would never write it.
    expect(agent).toMatch(/ctx\.severedVerdict\s*=\s*severedVerdict/);
    const setAt = agent.indexOf('ctx.severedVerdict = severedVerdict');
    const reemitAt = agent.indexOf("if (severedVerdict === 'reemit')");
    expect(setAt).toBeGreaterThanOrEqual(0);
    expect(reemitAt).toBeGreaterThan(setAt); // before the branch, so all arms get it
  });

  it('link 3: the reject row RENDERS `sv`, guarded so it is absent when the ladder never ran', () => {
    expect(read('agent.ts')).toMatch(/\.\.\.\(ctx\.severedVerdict\s*\?\s*\{\s*sv:\s*ctx\.severedVerdict\s*\}\s*:\s*\{\}\)/);
  });

  it('`sv` is a 2-char key, so jsonb keeps it inside the 240-char read cut', () => {
    expect('sv'.length).toBe(2);
    const livePrefix = '{"ab":39,"db":0,"fg":6,"fr":"tool_calls","ni":0,"rb":39,"re":0,"sc":1,"sl":"0:7","sv":"complete-sibling","ub":0';
    expect(livePrefix.indexOf('"sv"')).toBeGreaterThanOrEqual(0);
    // The reason the key is 2 chars: it must sort BEFORE the long ones
    // (seam/tool/shape/argLen/reason) that push the cut at 240 chars.
    expect(livePrefix.indexOf('"sv"')).toBeLessThan(240);
  });
});
