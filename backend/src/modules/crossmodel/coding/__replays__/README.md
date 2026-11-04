# Replay-harness convention (documented 2026-09-09, remediation P0)

This directory documents a TESTING CONVENTION that already exists informally in
this module — it does not (yet) hold fixture files. The convention:

**A production mishap becomes a permanent regression test by replaying the
REAL failing rows (redacted) against the REAL guard/loop code, with only the
process boundaries mocked.**

## The pattern (canonical example: `../run-evidence-guard.680dd00a.test.ts`)

1. **Name the file after the incident id** — the feedback-ticket / bug id the
   mishap was tracked under (`run-evidence-guard.680dd00a.test.ts`,
   `run-evidence-guard.b646f6b8.test.ts`, `agent-derail-break.test.ts`'s
   e882204f cases). The header narrates the mishap: what fired, which runs,
   what the guard did, and what the fix was.
2. **Build fixtures from REDACTED real rows** — the actual final text /
   transcript parts / receipts / journal rows from the incident's runs, with
   user content, ids, and secrets trimmed or replaced. Fixtures live as
   `const` blocks inside the test file (small) or in this directory (large).
3. **Run the REAL module** — `jest.requireActual` semantics: the guard/loop
   under test executes for real; ONLY process boundaries are stubbed (logger,
   prisma, the GitHub token manager, provider HTTP). Never mock the function
   whose behavior the incident concerned.
4. **Pin BOTH directions**:
   - the incident shape IS caught (the guard is the working control — a
     regression that stops catching it fails CI), and
   - the honest twin of the same text (same claim + real receipt/evidence) is
     CLEAN — proving the fix isn't overreach.
5. **Pin the rendered wording** where downstream consumers (integrity tickets,
   journal verdicts) quote it verbatim.

## When to add one

Any time a fleet incident produces a postmortem with concrete failing rows:
copy the rows in redacted, write the four-direction pins above, and name the
suite after the incident id so `git log --grep <id>` finds code + test + record
together.
