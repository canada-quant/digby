/**
 * Owner-hold answer classifier (ticket fadc3563, 2026-10-04) — pure leaf, no
 * prisma, no model (the goal-done-suspect convention).
 *
 * The incident: the owner answered a GO/HOLD gate question with "Not yet —
 * hold the store wave"; the answer-consumption paths (the inline
 * answerOwnerQuestion fan-out AND the owner-gate sweeper backstop, ticket
 * 356d21bb) treated ANY answered question as an unblock — goal e1e96be5 +
 * todo 3bf505f8 flipped active/pending with a note reading the HOLD as a
 * go-ahead, and the store wave was falsely executable for ~2 minutes until
 * the project supervisor re-applied the block (2026-10-04 06:56:55Z).
 *
 * A hold/negative answer IS a decision — the opposite one. It must keep the
 * gate closed: goals.service unblockOwnerGatedItems (the ONE choke point every
 * answer path funnels through) classifies every answer with isHoldAnswer and
 * routes holds to the owner-HOLD arm (status stays 'blocked', blockKind
 * 'owner', the closed card unlinked, the reason quoting the owner's words)
 * instead of the unblock arm.
 *
 * SCOPE ADJUDICATION (deliberate): the ticket's "better" reading — clear ONLY
 * on affirmative answers — would break the platform's normal unblock class:
 * noun-phrase decisions ("ca-central-1") and typed-option labels ("Play ORG
 * account + allow free D&B lookup") carry no affirmative token yet ARE
 * go-aheads (that is 356d21bb's whole point). So the guard is
 * hold-DETECTION, not affirmative-requirement: a reply that LEADS with a
 * hold/negative token ("not yet", "hold", "no", "stop", "wait", "later",
 * "don't") or carries a hold imperative anywhere ("hold the …", "don't start
 * …", "leave it stopped", "wait until …") is a HOLD; everything else keeps
 * the classic release. Bare "no"/"nope" leads are holds UNLESS followed by a
 * benign or affirmative continuation ("no problem", "no, go ahead") — the
 * same precision the counter-question DECISIVE_LEAD_RE invests. Over-
 * conservative on mixed replies ("go ahead, but wait for Friday" → hold) by
 * design: the wake and the note carry the owner's full words, and a hold is
 * lifted by the owner's newer words, never silently.
 *
 * PRECEDENCE with the counter-question arm (CanLaw 2026-09-15): a reply that
 * is entirely question-form ("not yet — can we hold until Friday?") is the
 * owner ASKING, not stating — it takes the asked-back arm (agent gate, answer
 * the owner first). isHoldAnswer classifies STATEMENTS only; the choke point
 * checks counterQuestion FIRST, then hold.
 */

/**
 * A hold/negative OPENING token. Bare "no"/"nope" carve-outs: a benign
 * continuation ("no problem", "no rush") or a punctuation-then-affirmative
 * ("no, go ahead", "no — proceed") is not a hold. "no-go"/"no go" stays a
 * hold (bare "go" is deliberately NOT in the affirmative carve list).
 */
export const HOLD_LEAD_RE =
  /^\s*(?:not\s+(?:yet|now|for\s+now|ready)|(?:no|nope|nah)(?![\s,;—-]*(?:problem|worries|concerns?|rush|hurry|objections?|sweat|doubts?|issues?|need|go\s+ahead|go\s+for\s+it|proceed|ship\s+it|do\s+it|yes|yeah|sure|fine|ok|okay|good))|hold(?:\s+(?:on|off|up|it|this|that|everything))?|stop(?:\s+(?:it|everything))?|halt(?:\s+it)?|pause[d]?(?:\s+it)?|wait(?:ing)?|later|defer(?:red)?|postpone[d]?)\b/i;

/**
 * A hold imperative or phrase ANYWHERE in the reply. Word-bounded on both
 * sides; the verb lists after "don't/do not" are the start-class verbs so
 * "don't cancel it" (a scope note) is not misread while "don't start/ship/
 * deploy/proceed/go" (the hold class) is.
 */
export const HOLD_PHRASE_RE =
  /\b(?:not\s+yet|not\s+now|hold\s+(?:the|this|that|my|it|them|everything|off)|keep\s+(?:it|this|that|them|everything)\s+(?:held|blocked|stopped|paused|on\s+hold)|keep\s+holding|leave\s+(?:it|this|that|them)\s+(?:stopped|blocked|held|paused|as\s+is|as-is)|stays?\s+(?:held|blocked|stopped|paused)|don'?t\s+(?:start|begin|launch|ship|deploy|release|proceed|go|run|execute|resume|continue)|do\s+not\s+(?:start|begin|launch|ship|deploy|release|proceed|go|run|execute|resume|continue)|wait\s+(?:until|till|for)|too\s+early|not\s+ready|put\s+(?:it|this|that)\s+on\s+(?:hold|ice)|stand\s+down|hold\s+everything)\b/i;

/**
 * Does this owner answer state a HOLD or negative (not a go-ahead)?
 * Pure; empty/garbage input is never a hold. Typed-option answers arrive as
 * their LABEL ("Hold the store wave") and classify the same way.
 */
export function isHoldAnswer(answer: string): boolean {
  const raw = String(answer ?? '').trim();
  if (!raw) return false;
  return HOLD_LEAD_RE.test(raw) || HOLD_PHRASE_RE.test(raw);
}
