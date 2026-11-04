/**
 * Ticket 161d39e9 replay suite — the [PARENT SESSION CONTEXT] digest leaf.
 *
 * The incident (session 11449a0a, 2026-09-24): a machine-spawned coding
 * session's first prompt opens with the parent's run-OUTCOME digest lines,
 * and every title surface seeded from the raw message titled the session
 * after the parent's last verdict ("post-sweep acceptance criteria verified")
 * instead of the child's TASK. These tests pin the leaf's two strippers:
 * the STRICT position-0 parse (pending-confirmations' moot check, byte-moved
 * from its local ba41858d copy) and the LENIENT locate-anywhere cut (title
 * seeds — reviewer round: firing/agent-send headers can precede the digest,
 * and buildParentContextBlock's 1500-char cap can cut the block mid-line).
 */
import {
  PARENT_CONTEXT_BLOCK_HEADER,
  stripParentContextBlock,
  stripParentContextDigest,
} from './parent-context-block';

const TASK = 'Mac citator harvest 371 + rescore + docs/splash/UI refresh';
const HEADER = PARENT_CONTEXT_BLOCK_HEADER;
const digest = (body: string) => [HEADER, ...body.split('\n')].join('\n');

const INCIDENT_BODY = [
  '- 2026-09-24: Mac citator harvest sweep → post-sweep acceptance criteria verified across 371 cases',
  '  Decisions: keep the splash refresh; rescore pinned',
  '  Failures: none',
].join('\n');

describe('parent-context-block (161d39e9)', () => {
  describe('stripParentContextBlock — strict position-0 (moot-check parity)', () => {
    it('returns the prompt after a well-formed digest', () => {
      expect(stripParentContextBlock(`${digest(INCIDENT_BODY)}\n\n${TASK}`)).toBe(TASK);
    });
    it('null when the digest does not open the text (position-0 contract)', () => {
      expect(stripParentContextBlock(`lead\n${digest(INCIDENT_BODY)}\n\n${TASK}`)).toBeNull();
    });
    it('null when there is no blank separator (D-F1 strictness — never a wrong moot)', () => {
      expect(stripParentContextBlock(`${digest(INCIDENT_BODY)}\n${TASK}`)).toBeNull();
    });
    it('zero-entry degenerate (header + blank + prompt) still strips — PRE-EXISTING ba41858d acceptance, preserved verbatim (buildParentContextBlock never emits it: !entries.length → \'\')', () => {
      // Byte-parity pin: the moved copy must behave EXACTLY like the original
      // pending-confirmations parser, including its degenerate acceptance of a
      // header-only block — not "improve" it into a behavior change.
      expect(stripParentContextBlock(`${HEADER}\n\n${TASK}`)).toBe(TASK);
    });
    it('parses a cap-truncated digest: the "…"-cut tail closes the grammar (reviewer N1)', () => {
      // buildParentContextBlock's PARENT_CONTEXT_BLOCK_CAP trim slices the
      // oversized block mid-line — the last entry reads 'd criteria verified…'.
      const cut = `${digest('- 2026-09-24: sweep → post-sweep acceptance criteria verifie')}d criteria verified across 371 cases…`;
      expect(stripParentContextBlock(`${cut}\n\n${TASK}`)).toBe(TASK);
    });
  });

  describe('stripParentContextDigest — lenient (title seeds)', () => {
    it('digest at position 0 → the task', () => {
      expect(stripParentContextDigest(`${digest(INCIDENT_BODY)}\n\n${TASK}`)).toBe(TASK);
    });
    it('firing header BEFORE the digest → the task (position-0 strict would miss)', () => {
      const withChrome = `[MACHINE-TRIGGERED RUN — a scheduled firing of this chat]\n\n${digest(INCIDENT_BODY)}\n\n${TASK}`;
      expect(stripParentContextDigest(withChrome)).toBe(`[MACHINE-TRIGGERED RUN — a scheduled firing of this chat]\n\n${TASK}`);
    });
    it('agent-send header BEFORE the digest → chrome kept, digest cut', () => {
      const withChrome = `[AGENT-SENT MESSAGE — from chat "Sup" (12345678)]\n\n${digest(INCIDENT_BODY)}\n\n${TASK}`;
      expect(stripParentContextDigest(withChrome)).toBe(`[AGENT-SENT MESSAGE — from chat "Sup" (12345678)]\n\n${TASK}`);
    });
    it('cap-truncated digest (mid-line "…" tail) → the task (reviewer N1 residual closed)', () => {
      const cut = `${digest('- 2026-09-24: sweep → post-sweep acceptance criteria verifie')}d criteria verified across 371 cases…`;
      expect(stripParentContextDigest(`${cut}\n\n${TASK}`)).toBe(TASK);
    });
    it('non-string input → unchanged', () => {
      expect(stripParentContextDigest(undefined as any)).toBe('');
    });
    it('no digest at all → unchanged (plain task text is never mangled)', () => {
      const plain = `Do the harvest for ${TASK} and report`;
      expect(stripParentContextDigest(plain)).toBe(plain);
    });
    it('header literal MENTIONED inline (not its own line) → unchanged', () => {
      const plain = `Review the ${HEADER} handling in this repo`;
      expect(stripParentContextDigest(plain)).toBe(plain);
    });
    it('digest without a closing blank separator → unchanged (grammar governs)', () => {
      const malformed = `${digest(INCIDENT_BODY)}\n${TASK}`;
      expect(stripParentContextDigest(malformed)).toBe(malformed);
    });
    it('two blank lines after the digest → task (the extra blank survives; callers trim)', () => {
      expect(stripParentContextDigest(`${digest(INCIDENT_BODY)}\n\n\n${TASK}`)).toBe(`\n${TASK}`);
    });
  });
});
