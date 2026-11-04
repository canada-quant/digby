/**
 * af4ef7c7 — the breaker ADAPTER CLASS KEY: a ticket class identity derived
 * from STRUCTURED trip fields only, never from title text.
 *
 * WHY THIS FILE IS A LEAF WITH ZERO IMPORTS. Its consumer is
 * `coding/reflection.ts`, a hot path whose test suites mock prisma/redis by
 * hand. Importing `feedback.service.ts` there pulled that module's whole
 * dependency graph (and its eager env validation) into every `reflection.*`
 * test suite and broke 5 of them — measured, then fixed by keeping the pure
 * key derivation here and lazy-loading the DB-writing helper instead.
 *
 * WHY THE KEY EXISTS AT ALL. The adjudicated-class dedupe matches on the
 * normalized TITLE. The breaker auto-filer embeds a MUTABLE chat title in its
 * titles ('5× success-side wrong-tool loop: edit_file on "<chat title>" —
 * framework or model?'), so two sightings of ONE class almost never share a
 * normalized title and the equality arm matches nothing (59118fe0 vs
 * 2c98b460: cross-referenced in their own descriptions, never attached).
 *
 * WHY IT IS NOT DERIVED FROM THE TITLE. A title-derived key was implemented
 * and REFUTED (PR #2295): truncating a title to a prefix cuts before the
 * discriminator, and stripping 'quoted spans' eats real possessive
 * apostrophes — so genuinely distinct classes collapsed onto one key. A wrong
 * key MERGES unrelated classes and HIDES a recurrence, strictly worse than the
 * duplicate-row cost it was meant to fix. Nothing here reads the chat title.
 *
 * THE SAFETY RULE. The key is only produced where the class IS structurally
 * defined — the detector's own trip shape plus the tool pair it convicted on.
 * A plain 'failure' streak has no discriminator (a permanently-refused push
 * quarantined as terminal auth and a fatal 403 on the branch are DISTINCT
 * classes that may share a tool), so it yields null and keeps the legacy
 * per-instance filing. Enabling dedupe only where the class is defined is the
 * whole argument: a key that could collapse distinct classes is never built.
 */

/** context field carrying the structural class key on a breaker ticket row. */
export const BREAKER_CLASS_KEY_FIELD = 'breakerClassKey';

/**
 * Pure. Structural class identity of a breaker trip, or null when it has none.
 *
 * The chat title is NEVER an input (see the header). `intended` is only
 * meaningful for a success-side trip, where the called→intended PAIR is the
 * class; without it the pairing cannot be stated, so no key is produced.
 */
export function breakerClassKey(ev: {
  shape?: string | null;
  tool?: string | null;
  intended?: string | null;
}): string | null {
  const tool = String(ev.tool ?? '').trim();
  if (!tool) return null;
  const shape = String(ev.shape ?? 'failure');
  if (shape === 'success_intent') {
    const intended = String(ev.intended ?? '').trim();
    return intended ? `success_intent:${tool}->${intended}` : null;
  }
  if (shape === 'narration_repeat') return `narration_repeat:${tool}`;
  return null;
}