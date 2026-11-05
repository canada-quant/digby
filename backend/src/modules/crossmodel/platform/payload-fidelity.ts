/**
 * Mutation-payload FIDELITY receipts (ticket d1120ffc, filed 2026-11-02 by the
 * Fleet Supervisor after a project-supervisor lane lost a goal brief twice).
 *
 * THE REPORTED SHAPE. A `goal_create` / `goal_update` carrying a full brief
 * landed a row whose `description` was EMPTY and whose `priority` was unset,
 * while the tool returned an ordinary success. The caller could not tell
 * "sent and truncated" from "not sent", so the only surviving record of the
 * brief was the child todos — and the workaround (re-issue with a reshaped
 * payload) was silent. The ticket's ask is exactly this receipt:
 *
 *   "Return the received-vs-expected payload digest in the tool result so a
 *    caller can see truncation instead of silently writing a stub."
 *
 * WHAT WAS ALREADY TRUE (checked before building, so this file does NOT
 * re-implement it): the ARGUMENT seam is already atomic-or-failed —
 * `coding/tool-arguments.ts parseToolArguments` rejects a payload that stops
 * mid-structure and `toolArgumentRejection` executes NOTHING with fabricated
 * args (the 2026-08-30 hazard). A severed argument therefore cannot half-apply.
 * `ProjectGoal.description` is `@db.Text` (unbounded) and `goals.service`
 * writes it verbatim, and `progressNote` already has its own loud CLIP notice
 * (`progress-note.ts`, ticket f3e56567). What was missing is the READER-SIDE
 * proof: nothing on the goal write path ever compared what was SENT with what
 * was STORED, so a stub row and a complete row looked identical in the result.
 *
 * WHAT THIS ADDS. For every supplied free-text payload field, a compact
 * `[payload ECHO]` line on SUCCESS (code-point length + sha256/8 of what the
 * row actually holds) and a LOUD `[payload FIDELITY FAILURE]` line when the
 * stored value differs from the sent one. Both are counts + digests only — a
 * payload is user prose and may hold a credential, so nothing here ever echoes
 * it back (the same rule `progress-note.ts` states for its clip notice).
 *
 * A retry can now be checked the same way a caller checks a hash: re-send, read
 * the echoed sha8, compare. Two consecutive writes of the same >2,000-char
 * description therefore land byte-identical and SAY so (the ticket's own
 * acceptance criterion).
 *
 * `normalizeTextArg` closes the adjacent stub-corruption hole this ticket's
 * "atomic-or-failed" ask covers on the INPUT side: the handlers used
 * `String(args.description)`, so `description: null` stored the literal text
 * "null" and `description: {…}` stored "[object Object]" — a stub written by us,
 * not by the transport. A non-string, non-null description is now a typed
 * refusal BEFORE anything is written (nothing partial lands), and `null` is the
 * explicit clear it was always meant to be.
 *
 * Pure leaf — only `crypto` (a node builtin, no side effects), so it is safe for
 * platform-tools' static import graph, which must never reach config/env.
 */

import { createHash } from 'crypto';

/** One supplied field, compared sent-vs-stored. */
export interface FieldFidelity {
  /** The tool argument's name (as the caller wrote it). */
  field: string;
  /** Code points the caller sent (surrogate-pair safe — the progress-note lesson). */
  sentChars: number;
  /** Code points the row actually holds. */
  storedChars: number;
  /** sha256/8 of the sent text. */
  sentSha8: string;
  /** sha256/8 of the stored text. */
  storedSha8: string;
  /** true iff the row holds EXACTLY what was sent. */
  ok: boolean;
}

/** sha256/8 — 8 hex chars is plenty to tell two prose payloads apart in a log. */
export function sha8(value: string): string {
  return createHash('sha256').update(String(value), 'utf8').digest('hex').slice(0, 8);
}

/** Code-point length (never a UTF-16 unit count — the f3e56567 follow-up lesson). */
function codePoints(value: string): number {
  return Array.from(value).length;
}

/** The stored side of a comparison: a non-string, non-null stored value reads as ''. */
function storedText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  return String(value);
}

/**
 * Compare one supplied payload field with what the row holds. `undefined` sent
 * ⇒ null (the field was not part of this call — nothing to prove).
 *
 * `trim` mirrors a service that stores the TRIMMED form (goals.service trims
 * `title`): comparing the raw arg against a trimmed row would report a
 * FALSE failure on a trailing newline — a shape models emit constantly — so the
 * comparison is made in the unit the writer uses. Fields stored verbatim
 * (description) pass trim:false and are compared byte-for-byte. Pure.
 */
export function fieldFidelity(field: string, sent: unknown, stored: unknown, opts?: { trim?: boolean }): FieldFidelity | null {
  if (sent === undefined) return null;
  const raw = sent === null ? '' : String(sent);
  const sentStr = opts?.trim ? raw.trim() : raw;
  const storedStr = storedText(stored);
  return {
    field,
    sentChars: codePoints(sentStr),
    storedChars: codePoints(storedStr),
    sentSha8: sha8(sentStr),
    storedSha8: sha8(storedStr),
    ok: sentStr === storedStr,
  };
}

/** Compare several fields at once, dropping the ones this call did not supply. Pure. */
export function payloadFidelity(pairs: Array<{ field: string; sent: unknown; stored: unknown; trim?: boolean }>): FieldFidelity[] {
  const out: FieldFidelity[] = [];
  for (const p of pairs) {
    const f = fieldFidelity(p.field, p.sent, p.stored, { trim: p.trim });
    if (f) out.push(f);
  }
  return out;
}

/** `title` reads better with its sentence name; every other field is named verbatim. */
function fieldLabel(field: string): string {
  return field === 'title' ? 'title' : field;
}

/**
 * The SUCCESS receipt: counts + digests per supplied field, so a caller can
 * prove the write landed byte-identically and compare a retry. null when the
 * call supplied no free-text payload (an id-only status flip needs no echo).
 * Pure.
 */
export function fidelityEcho(rows: FieldFidelity[]): string | null {
  const landed = rows.filter((r) => r.ok);
  if (!landed.length) return null;
  const parts = landed.map((r) => `${fieldLabel(r.field)} ${r.sentChars} chars, sha8 ${r.sentSha8}`);
  return `[payload ECHO] ${parts.join('; ')} — stored byte-identically (compare the sha8 on a retry).`;
}

/**
 * The FAILURE notice: a supplied payload field did NOT land. This is the arm the
 * ticket exists for — it must never be mistaken for success, and it must say
 * what to do in the SAME turn instead of letting the caller retry blind. Pure.
 */
export function fidelityFailure(rows: FieldFidelity[]): string | null {
  const lost = rows.filter((r) => !r.ok);
  if (!lost.length) return null;
  const parts = lost.map((r) => (
    `${fieldLabel(r.field)}: ${r.sentChars} chars sent (sha8 ${r.sentSha8}) but ${r.storedChars} stored `
    + `(sha8 ${r.storedSha8})${r.storedChars === 0 ? ' — the row is EMPTY, the value did not arrive' : ' — the stored value differs from what you sent'}`
  ));
  return `[payload FIDELITY FAILURE] ${parts.join('; ')}. The write itself succeeded, but this payload is NOT on the record — `
    + 'do not treat it as saved and do not re-narrate it as landed. Re-issue the call once and compare the echoed sha8 with the one above; '
    + 'if it differs again, carry the text in a bounded field instead (progressNote is stored up to 2,000 chars and reports its own clip) '
    + 'or in the charter todos, and say so plainly in your note.';
}

/**
 * The one line both arms are appended through, so the caller sees exactly one
 * fidelity verdict per call: the failure notice when anything did not land,
 * else the success echo. Pure.
 */
export function payloadFidelityNote(rows: FieldFidelity[]): string | null {
  return fidelityFailure(rows) ?? fidelityEcho(rows);
}

/** Result of normalizing a free-text tool argument before any write. */
export type TextArgNormalization =
  | { ok: true; value: string | undefined }
  | { ok: false; refusal: string };

/**
 * Normalize a free-text argument BEFORE the write, so a malformed shape can
 * never be stringified into a stub row (see the header: `null` → "null",
 * `{}` → "[object Object]"). `undefined` = the field was not supplied (the
 * handler forwards nothing, per the existing `!== undefined` predicates);
 * `null` = an explicit CLEAR (''); a string passes through verbatim; a number /
 * boolean is accepted as its text (a model legitimately sends a numeric id-ish
 * value into a text field); an object / array / function is REFUSED with a typed
 * error naming the field and the shape received — nothing is written. Pure.
 */
export function normalizeTextArg(field: string, value: unknown): TextArgNormalization {
  if (value === undefined) return { ok: true, value: undefined };
  if (value === null) return { ok: true, value: '' };
  if (typeof value === 'string') return { ok: true, value };
  if (typeof value === 'number' || typeof value === 'boolean') return { ok: true, value: String(value) };
  const shape = Array.isArray(value) ? 'an array' : typeof value;
  return {
    ok: false,
    refusal: `[tool call rejected] Nothing was written — ${field} arrived as ${shape}, not text. `
      + 'A non-string value would be stringified into a stub row ("[object Object]"), which is exactly the lossy write this guard exists to prevent. '
      + `Re-issue ${field} as a JSON STRING (newlines written as \\n), or pass null to clear it.`,
  };
}