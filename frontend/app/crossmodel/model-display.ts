/**
 * Model personas — user-facing display names (owner ticket 7bdbe40c:
 * "We dont want to display names of models just call them AI or agents …
 * more fun yet explanatory descriptions"). ONE map for every surface:
 * transcript model chips, modelUsed badges, council cards, the coding-model
 * picker. Raw vendor ids stay in code/API payloads; only display changes.
 *
 * displayModelName() accepts anything the backend can send — provider keys
 * ('kimi'), Fireworks ids ('accounts/fireworks/models/deepseek-v4-pro'),
 * legacy direct ids ('deepseek-chat'), already-cleaned names ('DeepSeek V4
 * Flash'), and backend-sent labels ('Gemini (thinking)') — and returns the
 * persona. Unknown ids fall back to 'AI Agent' so a new vendor id can never
 * leak a raw model name into the UI.
 */

export interface ModelPersona {
  /** Fun, explanatory display name. */
  name: string;
  /** One-line role description (pickers, tooltips). */
  blurb: string;
}

/**
 * Seat labels (owner 2026-09-15: "remove the names … cross-checker, logician
 * and professor and just change them to Double Checker & Triple Checker").
 * The ONE vocabulary the admin Model-roles page, the chat status stream and
 * the More-info cards share. Any model can occupy any seat, so a card's label
 * comes from the SEAT the backend says produced it (`modelLabels` on the
 * complete event / persisted metadata, keyed by seat card key) — the
 * vendor-keyed personas below are only the fallback for legacy transcripts
 * that carry vendor card keys, and mirror the DEFAULT lineup.
 */
export const SEAT_LABELS = {
  digby: 'Digby',
  double_checker: 'Double Checker',
  triple_checker: 'Triple Checker',
  helper: 'The Helper',
  fleet_supervisor: 'Fleet Supervisor',
  project_supervisor: 'Project Supervisor',
} as const;
const SEAT_LABEL_LIST: string[] = Object.values(SEAT_LABELS);
const SEAT_LABEL_SET = new Set<string>(SEAT_LABEL_LIST.map(s => s.toLowerCase()));

export const MODEL_PERSONAS: Record<string, ModelPersona> = {
  kimi:     { name: SEAT_LABELS.digby,          blurb: 'The lead — plans, uses every tool, and writes the final answer.' },
  glm:      { name: SEAT_LABELS.triple_checker, blurb: 'Third opinion — the second colleague on the Level 3 research council.' },
  deepseek: { name: SEAT_LABELS.double_checker, blurb: 'Second opinion — answers independently at Level 2 and sits on the Level 3 council.' },
  openai:   { name: 'The Veteran',   blurb: 'Consultant agent — broad frontier experience.' },
  grok:     { name: 'The Maverick',  blurb: 'Consultant agent — independent, contrarian takes.' },
  gemini:   { name: 'The Scholar',   blurb: 'Consultant agent — wide knowledge, strong multimodal skills.' },
  'qwen-vl': { name: 'The Scout',    blurb: 'Vision agent — reads images and screenshots.' },
  llama:    { name: SEAT_LABELS.helper, blurb: 'Utility agent — quick background tasks.' },
  'gpt-oss': { name: SEAT_LABELS.helper, blurb: 'Utility agent — quick background tasks.' },
};

export const FALLBACK_PERSONA_NAME = 'AI Agent';

/** True for a seat label the backend sent (case-insensitive) — passed through verbatim. */
export function isSeatLabel(raw: string | null | undefined): boolean {
  return !!raw && SEAT_LABEL_SET.has(raw.trim().toLowerCase());
}

// Normalization: strip provider path + decoration, then match by keyword.
function normalizeModelId(raw: string): string {
  let s = raw.trim().toLowerCase();
  s = s.replace(/^accounts\/[^/]+\/models\//, ''); // fireworks path
  s = s.replace(/\s*\((thinking|preview|beta)\)\s*$/i, ''); // backend label decoration
  return s;
}

const KEYWORD_PERSONA: Array<[RegExp, keyof typeof MODEL_PERSONAS]> = [
  [/kimi/, 'kimi'],
  [/glm/, 'glm'],
  [/deepseek/, 'deepseek'],
  [/qwen3?-?vl|qwen.*vl/, 'qwen-vl'],
  [/gpt-oss/, 'gpt-oss'],
  [/llama/, 'llama'],
  [/chatgpt|openai|^gpt(-|$)|gpt-5/, 'openai'],
  [/grok/, 'grok'],
  [/gemini/, 'gemini'],
];

/**
 * Resolve any model identifier/label to its persona display name.
 * Never returns a raw vendor id: unknown values yield FALLBACK_PERSONA_NAME.
 */
export function displayModelName(raw: string | null | undefined): string {
  if (!raw) return FALLBACK_PERSONA_NAME;
  // Seat CARD KEYS ('digby', 'double_checker', 'triple_checker') and seat
  // labels from the backend render as the canonical seat label — a seat is
  // not a vendor, so no keyword pass may re-derive a vendor persona for them.
  const lower = raw.trim().toLowerCase();
  if (Object.hasOwn(SEAT_LABELS, lower)) return SEAT_LABELS[lower as keyof typeof SEAT_LABELS];
  const canonicalSeat = SEAT_LABEL_LIST.find(l => l.toLowerCase() === lower);
  if (canonicalSeat) return canonicalSeat;
  const direct = MODEL_PERSONAS[raw.trim().toLowerCase()];
  if (direct) return direct.name;
  // Idempotence (review N1): an already-persona string maps to itself, so
  // fallback chains (`modelLabels[m] || MODEL_LABELS[m]`) never degrade a
  // persona to 'AI Agent'.
  for (const p of Object.values(MODEL_PERSONAS)) {
    if (p.name.toLowerCase() === raw.trim().toLowerCase()) return p.name;
  }
  const norm = normalizeModelId(raw);
  if (MODEL_PERSONAS[norm]) return MODEL_PERSONAS[norm].name;
  for (const [re, key] of KEYWORD_PERSONA) {
    if (re.test(norm)) return MODEL_PERSONAS[key].name;
  }
  return FALLBACK_PERSONA_NAME;
}

/** Persona blurb for a model id (pickers/tooltips); '' when unknown. */
export function displayModelBlurb(raw: string | null | undefined): string {
  if (!raw) return '';
  const norm = normalizeModelId(raw);
  const key = (Object.keys(MODEL_PERSONAS) as Array<keyof typeof MODEL_PERSONAS>)
    .find((k) => k === raw.trim().toLowerCase() || k === norm)
    ?? KEYWORD_PERSONA.find(([re]) => re.test(norm))?.[1];
  return key ? MODEL_PERSONAS[key].blurb : '';
}
