/**
 * Tolerant JSON parsing of model answers (moved out of memory-audit.ts 2026-10-20 so pure leaves —
 * memory/state-ops.ts — can use it without pulling in the telemetry sink; memory-audit re-exports
 * both, so every existing import keeps working). No imports.
 */
/**
 * Parse a model's JSON answer tolerantly: strips ```json fences and takes the
 * outermost {...} (a reasoning preamble or a labelled fence used to fail the
 * whole extraction). Returns null when nothing parses — callers record a
 * `parse_error` outcome instead of silently keeping the fallback. The 2026-09-22
 * coding-project dream had failed every night for two nights this way: a 600-token
 * budget truncated the pretty-printed JSON, JSON.parse threw, `{}` came back and
 * the "returned empty — keeping existing memory" warning was the only trace.
 */
export function parseModelJson<T = any>(text: unknown): T | null {
  const raw = String(text ?? '').replace(/```json\n?|\n?```/g, '').trim();
  if (!raw) return null;
  try { return JSON.parse(raw) as T; } catch { /* fall through */ }
  const a = raw.indexOf('{'); const b = raw.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(raw.slice(a, b + 1)) as T; } catch { /* fall through */ } }
  return null;
}

/**
 * Salvage a TRUNCATED flat JSON object (output-budget cut — the memory-extraction
 * parse_error class of firing 91 and f171): a model re-emitting a whole profile/state
 * object gets cut mid-field when the object no longer fits the output budget, and
 * parseModelJson returns null because no closing brace exists. The salvage keeps every
 * COMPLETE top-level field (cut at the last depth-1 comma, outside any string) and
 * closes the object; the caller merges the salvaged fields over the existing state, so
 * the one truncated field keeps its existing value — bounded loss, never a partial
 * string and never a wiped field. Returns null when the text is balanced (parseModelJson
 * territory), when the cut lands inside the FIRST field (nothing complete to keep), or
 * when the repaired text still does not parse.
 */
export function salvageTruncatedJson<T = any>(text: unknown): T | null {
  const raw = String(text ?? '').replace(/```json\n?|\n?```/g, '').trim();
  const start = raw.indexOf('{');
  if (start < 0) return null;
  const s = raw.slice(start);
  let depth = 0;
  let inStr = false;
  let esc = false;
  let lastCut = -1;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') depth--;
    else if (c === ',' && depth === 1) lastCut = i;
  }
  if (!inStr && depth <= 0) return null; // balanced — parseModelJson handles (or already did)
  if (lastCut < 0) return null; // cut inside the first field — nothing complete to keep
  try { return JSON.parse(s.slice(0, lastCut) + '}') as T; } catch { return null; }
}
