/**
 * Signup Terms/AUP acceptance pin (Phase 2 Cloud, todo ea95fa0b item 5).
 *
 * The gap this closes: the backend has recorded and enforced terms acceptance
 * since the leg-1 merge (terms.service.ts, `acceptedTerms` on registerSchema),
 * but the SIGNUP FORM never asked. The acceptance the service stored was
 * therefore never collected from a real user — a policy surface with no surface.
 *
 * What is pinned here (source pins, the marketing-pins idiom — the login page is
 * a client component and this suite does not mount it):
 *  - the checkbox exists, is driven by state, and starts UNTICKED (a pre-ticked
 *    box would make the stored acceptance ours, not the user's);
 *  - submit is refused in the handler when the box is unticked, not merely
 *    disabled in the DOM (a disabled button is a UI hint, not a gate);
 *  - `acceptedTerms: true` is sent only after that guard;
 *  - the control is labelled by a real <label htmlFor> (a11y), not a bare div;
 *  - the linked /terms deep link resolves to a heading that actually exists —
 *    the page is pinned too, because a link to a missing anchor is a dead link
 *    on the one screen every new account must pass through.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const readSrc = (rel: string) => readFileSync(join(__dirname, rel), 'utf8');

const PAGE = readSrc('./page.tsx');
// The public marketing routes live in the (site) route GROUP — its parenthesised
// name is not part of the URL, so /terms is served from app/(site)/terms/page.tsx.
const TERMS = readSrc('../(site)/terms/page.tsx');
const AUTH = readSrc('../../lib/auth.ts');

describe('signup terms acceptance [login/page.tsx]', () => {
  it('holds the acceptance in state, initialised to FALSE', () => {
    expect(PAGE).toMatch(/const \[acceptedTerms, setAcceptedTerms\] = useState\(false\)/);
  });

  it('renders a Checkbox wired to that state and a real label', () => {
    expect(PAGE).toContain('id="signup-terms"');
    expect(PAGE).toMatch(/checked=\{acceptedTerms\}/);
    expect(PAGE).toMatch(/onCheckedChange=\{\(v\) => setAcceptedTerms\(v === true\)\}/);
    // A bare <div> would leave the box unlabelled for screen readers.
    expect(PAGE).toMatch(/<label[\s\S]{0,120}htmlFor="signup-terms"/);
  });

  it('refuses submit in the HANDLER when unticked (not just a disabled button)', () => {
    const guard = PAGE.indexOf('if (!acceptedTerms)');
    const send = PAGE.indexOf('acceptedTerms: true');
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(send).toBeGreaterThan(guard);
    // The refusal must return early, so no registration can be attempted.
    expect(PAGE.slice(guard, guard + 400)).toMatch(/return;/);
  });

  it('sends acceptedTerms: true to the API', () => {
    expect(PAGE).toContain('acceptedTerms: true');
    expect(AUTH).toContain('acceptedTerms?: boolean;');
  });
});

describe('the linked Terms deep link resolves [terms/page.tsx]', () => {
  it('has the #acceptable-use anchor the signup form links to', () => {
    expect(PAGE).toContain('/terms#acceptable-use');
    expect(TERMS).toContain('id="acceptable-use"');
  });

  it('still has the section the anchor names', () => {
    expect(TERMS).toMatch(/id="acceptable-use"[\s\S]{0,120}Acceptable Use/);
  });
});