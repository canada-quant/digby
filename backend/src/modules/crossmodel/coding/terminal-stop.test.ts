/**
 * terminal-stop.test.ts — extraction + notice rendering for the machine-lane
 * terminal-stop contract (feedback 065caccb).
 *
 * Pins the two halves of the pure leaf:
 *  (a) extractTicketRefs — finds ticket refs in a firing prompt (full uuids
 *      anywhere; keyword-gated 8-hex prefixes) WITHOUT matching commit shas,
 *      bare hex, or shifted 9-hex runs;
 *  (b) buildTerminalStopNotice — the deterministic [TERMINAL-STOP] block, with
 *      bracket/newline sanitisation and the listed-count cap.
 */
import {
  extractTicketRefs,
  buildTerminalStopNotice,
  TERMINAL_STOP_PREFIX,
  MAX_TICKET_REFS,
  MAX_LISTED,
} from './terminal-stop';

describe('extractTicketRefs', () => {
  it('pulls a bare full UUID, keyword-free', () => {
    const refs = extractTicketRefs('see 065caccb-a3c5-4c45-849e-c9a14f594df5 for context');
    expect(refs).toEqual(['065caccb-a3c5-4c45-849e-c9a14f594df5']);
  });

  it('pulls keyword-gated 8-hex prefixes (ticket / ticket batch / batch / feedback)', () => {
    expect(extractTicketRefs('ticket 6fac1460 closed earlier')).toEqual(['6fac1460']);
    expect(extractTicketRefs('ticket batch 6fac1460 closed done')).toEqual(['6fac1460']);
    expect(extractTicketRefs('batch 6fac1460 closed')).toEqual(['6fac1460']);
    expect(extractTicketRefs('feedback 7503189b is done')).toEqual(['7503189b']);
    expect(extractTicketRefs('closed ticket 7503189b until stand-down')).toEqual(['7503189b']);
  });

  it('handles the 065caccb evidence shapes verbatim', () => {
    const refs = extractTicketRefs(
      'probe gate → check artifacts → re-chain → stop quietly. Ticket batch 6fac1460 was closed done earlier; do not touch it.',
    );
    expect(refs).toEqual(['6fac1460']);
  });

  it('a full uuid is kept whole (uuid scan); a keyword-gated PARTIAL uuid normalises to its leading 8', () => {
    // The full uuid resolves EXACTLY; the partial resolves via the ≥8-prefix path —
    // both land on the same ticket row, where the caller dedupes by id.
    expect(extractTicketRefs('ticket 065caccb-a3c5-4c45-849e-c9a14f594df5 done')).toEqual(['065caccb-a3c5-4c45-849e-c9a14f594df5']);
    expect(extractTicketRefs('ticket 6fac1460-a3c5 done')).toEqual(['6fac1460']);
  });

  it('does NOT match a bare 8-hex with no ticket-ish keyword (schedule/commit ids stay silent)', () => {
    expect(extractTicketRefs('schedule ebf9ffdc fires at :30')).toEqual([]);
    expect(extractTicketRefs('watch deadbeef on the board')).toEqual([]);
  });

  it('does NOT match commit/sha keyword contexts — a deploy-watch prompt names shas, never tickets', () => {
    expect(extractTicketRefs('commit 1a2b3c4d merged; sha 9f8e7d6c deployed')).toEqual([]);
    expect(extractTicketRefs('deploy run 12345678 green')).toEqual([]);
  });

  it('does not yield a SHIFTED 8-char prefix from a 9-hex run', () => {
    // '225b878f4' is 9 hex chars: matching at the keyword would capture
    // '225b878f' + fail the lookahead; it must NOT slide to '25b878f4'.
    expect(extractTicketRefs('ticket 225b878f4 referenced')).toEqual([]);
  });

  it('dedupes repeated refs and caps at MAX_TICKET_REFS', () => {
    const repeated = extractTicketRefs('ticket 6fac1460 and again ticket 6fac1460 and TICKET 6FAC1460');
    expect(repeated).toEqual(['6fac1460']);
    const many = Array.from({ length: MAX_TICKET_REFS + 4 }, (_, i) => `ticket ${String(i).padStart(8, 'a')}`).join(' ');
    expect(extractTicketRefs(many)).toHaveLength(MAX_TICKET_REFS);
  });

  it('returns [] for non-string/empty input and never throws', () => {
    expect(extractTicketRefs('')).toEqual([]);
    expect(extractTicketRefs(undefined as any)).toEqual([]);
    expect(extractTicketRefs(null as any)).toEqual([]);
  });
});

describe('buildTerminalStopNotice', () => {
  const now = new Date('2026-09-15T20:45:00.000Z');

  it('renders the id prefix, title, last-update ISO and close note per ticket', () => {
    const out = buildTerminalStopNotice(
      [{
        id: '6fac1460-1111-2222-3333-444455556666',
        title: 'probe.sh custom.js verbatim ship',
        updatedAt: new Date('2026-09-15T18:50:00.000Z'),
        adminNote: 'closed with evidence: PR #803, deploy 987654',
      }],
      now,
    );
    expect(out.startsWith(TERMINAL_STOP_PREFIX)).toBe(true);
    expect(out).toContain('fire time 2026-09-15T20:45:00.000Z');
    expect(out).toContain('6fac1460');
    expect(out).toContain("'probe.sh custom.js verbatim ship'");
    expect(out).toContain('last update 2026-09-15T18:50:00.000Z');
    expect(out).toContain("close note: 'closed with evidence: PR #803, deploy 987654'");
    expect(out).toContain('TERMINAL');
    expect(out).toContain('still OPEN');
  });

  it('sanitises ] quotes and newlines out of titles/notes (the block stays ONE bracketed line)', () => {
    const out = buildTerminalStopNotice(
      [{
        id: '7503189b-aaaa-bbbb-cccc-dddddddddddd',
        title: 'evil ] title\n"quoted"',
        updatedAt: null,
        adminNote: 'note with ] bracket\nand newline',
      }],
      now,
    );
    // One line, one closing bracket (the header's own).
    expect(out).not.toContain('\n');
    expect(out.indexOf(']')).toBe(out.lastIndexOf(']'));
    expect(out).toContain('last update unknown');
  });

  it('caps the listed tickets and counts the overflow', () => {
    const closed = Array.from({ length: MAX_LISTED + 2 }, (_, i) => ({
      id: `deadbeef-${String(i).padStart(4, '0')}-0000-0000-00000000000${i}`,
      title: `t${i}`,
      updatedAt: null,
      adminNote: null,
    }));
    const out = buildTerminalStopNotice(closed, now);
    expect(out).toContain(`+2 more`);
  });
});
