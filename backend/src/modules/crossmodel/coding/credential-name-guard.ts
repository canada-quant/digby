/**
 * Credential-name near-miss guard (ticket aa6b6da2, 2026-10-18).
 *
 * Incident: a coding lane probing its injected AWS credentials read
 * AWS_ACCESS_KEY_ID_DIGIBOPERATOR / _DIGIBYOPERATOR (two different misspellings
 * of the stored label DIGBYOPERATOR) across ~70 shell invocations, concluded
 * the platform's credential injection was "flaky/empty", parked an
 * owner-visible workstream blocked-external and filed a platform bug. The
 * injection had never failed — a misspelled env-var name reads as empty
 * ("" via ${VAR:-} / os.environ.get) and is byte-indistinguishable from a
 * credential that was never injected. The platform is the only party that
 * knows the real injected names, so it is the one that can disambiguate —
 * at the point of failure, in the command's own result.
 *
 * Pure functions only; never sees or prints credential VALUES.
 */

/** Env-var-shaped token in command text (UPPER_SNAKE, ≥8 chars). */
const TOKEN_RE = /\b[A-Z][A-Z0-9_]{7,63}\b/g;

/** Bounded edit distance (early-exit at max+1). */
export function editDistanceWithin(a: string, b: string, max: number): boolean {
  if (Math.abs(a.length - b.length) > max) return false;
  // Two-row DP; returns true iff levenshtein(a,b) <= max.
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return false; // no cell in this row can recover
    prev = cur;
  }
  return prev[b.length] <= max;
}

export interface CredentialNearMiss {
  /** The name the command actually referenced (does not exist in the shell env). */
  used: string;
  /** The injected credential name(s) it is within 2 edits of. */
  suggestions: string[];
}

/** House kill-switch parser (workspace-path-guard idiom — reviewer F6: raw
 *  truthiness would disable the guard on '0'/'false' strings). */
export function credentialNameGuardDisabled(): boolean {
  const v = String(process.env.CREDENTIAL_NAME_GUARD_DISABLED ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

/**
 * Find UPPER_SNAKE tokens in `command` that are NOT an injected credential
 * name but are within 2 edits of one (or of a credential-name PREFIX — e.g.
 * the bare AWS_ACCESS_KEY_ID against AWS_ACCESS_KEY_ID_DIGBYOPERATOR, the
 * other shape seen in the incident: exporting the UNSUFFIXED var from a
 * suffixed credential silently exports empty).
 *
 * Names only — `credentialNames` is the injected env-var name set; values
 * never enter this module. Bounded: first 400 tokens, names ≤ 64 chars.
 */
export function credentialNearMisses(
  command: string,
  credentialNames: readonly string[],
): CredentialNearMiss[] {
  if (!credentialNames.length || !command) return [];
  const exact = new Set(credentialNames);
  const names = credentialNames.filter((n) => n.length >= 12 && n.length <= 64);
  if (!names.length) return [];
  const out: CredentialNearMiss[] = [];
  const seen = new Set<string>();
  let checked = 0;
  for (const m of String(command).matchAll(TOKEN_RE)) {
    const tok = m[0];
    if (exact.has(tok) || seen.has(tok)) continue;
    seen.add(tok);
    if (++checked > 400) break;
    const suggestions: string[] = [];
    for (const n of names) {
      if (editDistanceWithin(tok, n, 2)) {
        suggestions.push(n);
      } else if (n.startsWith(`${tok}_`)) {
        // Prefix arm (the unsuffixed base name, e.g. AWS_ACCESS_KEY_ID against
        // AWS_ACCESS_KEY_ID_DIGBYOPERATOR). Reviewer F3: this shape is also the
        // DOCUMENTED-CORRECT remediation (`export AWS_ACCESS_KEY_ID="$AWS_…_DIGBYOPERATOR"`
        // — the learnings bullet before run-on-box.sh) — referencing BOTH the
        // base and the suffixed name in one command is deliberate wiring, not a
        // miss. Suppress the prefix suggestion when the command also references
        // the suffixed name it wires FROM.
        if (!String(command).includes(n)) suggestions.push(n);
      } else if (tok.length >= 12 && tok.startsWith(`${n}_`)) {
        suggestions.push(n);
      }
    }
    if (suggestions.length) out.push({ used: tok, suggestions: [...new Set(suggestions)].sort() });
  }
  return out;
}

/** The run_command notice for a near-miss set (leading \n\n; caller appends to the result). */
export function credentialNearMissNotice(misses: CredentialNearMiss[]): string {
  if (!misses.length) return '';
  const lines = misses
    .slice(0, 6)
    .map((m) => `  - "${m.used}" is not one of this session's injected credential names — did you mean ${m.suggestions.map((s) => `"${s}"`).join(' or ')}?`);
  return `\n\n[credential name notice] A misspelled env-var name reads as EMPTY and is indistinguishable from a missing credential — this platform injected the credential, but the name below does not match it. Check the spelling before concluding the injection failed:\n${lines.join('\n')}\n  (Values are never echoed. Probe a name with the EXACT spelling: e.g. printf 'len=%s' "\${#NAME}" — 0 means that exact name is not set.)`;
}

