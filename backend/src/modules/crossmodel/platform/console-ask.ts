/**
 * SPEC-LESS CONSOLE-ASK DETECTION (leaf, pure — no prisma/env imports).
 *
 * Backlog CA-1 (`docs/FRAMEWORK_BACKLOG.md`; ticket 1b1c41bc residual). PR #1593
 * made `flag_owner_question` take a structured `consoleAction` spec — fail-closed
 * validation, service-composed card body, `CONSOLE_ACTION_QUESTION_MAX` — and
 * STEERS agents to it (tool-schema REQUIRED-SHAPE line + doctrine rule
 * `asks.console-action-inline`). What it cannot see: an agent filing a console
 * ask as PLAIN FREE TEXT — a card whose question names a console surface and
 * tells the owner to DO something there, with no spec. That renders as an
 * ordinary short card: the 12:26:54Z oq_ea52c6ae shape that started the ticket.
 *
 * This is DETECTION, never a gate. A false positive that refused a legitimate
 * non-console ask would be worse than the sloppy card, so the intake only
 * records a loop metric (`console_ask_specless`) and the backlog says enforce
 * later, behind the kill switch, off a measured baseline (the 6f8b52b7 /
 * PR #1548 ladder).
 *
 * Deliberately a LEAF module: owner-questions.ts statically pulls
 * config/database → config/env (process.exit without env), so a sweep or a test
 * that only wants the classifier must not drag that graph in — the
 * owner-card-gaps.ts / credential-gate.ts pattern.
 */

/**
 * The console/UI surfaces an ask can send the owner to. Deliberately a CURATED
 * allow-list rather than "any capitalized noun": the detector's contract is
 * "names a console the owner operates", and a generic noun match would fire on
 * every ordinary decision card. Each entry is matched case-insensitively on a
 * word boundary, so `GCP` does not match "gcpath" and `console` alone stays
 * generic (it needs a qualifier — see CONSOLE_QUALIFIER_RE).
 */
export const CONSOLE_SURFACES: ReadonlyArray<{ id: string; re: RegExp }> = [
  { id: 'tailscale', re: /\btailscale\b/i },
  { id: 'gcp', re: /\b(?:gcp|google cloud|cloud console|gcloud)\b/i },
  { id: 'aws', re: /\b(?:aws|amazon web services)\b/i },
  { id: 'cloudflare', re: /\bcloudflare\b/i },
  { id: 'vercel', re: /\bvercel\b/i },
  { id: 'github', re: /\bgithub (?:settings|console)\b/i },
  { id: 'stripe', re: /\bstripe (?:dashboard|console)\b/i },
  { id: 'firebase', re: /\bfirebase\b/i },
  { id: 'play-console', re: /\bplay console\b/i },
  { id: 'app-store-connect', re: /\bapp store connect\b/i },
  { id: 'expo', re: /\bexpo (?:dashboard|console)\b/i },
  { id: 'namecheap', re: /\bnamecheap\b/i },
  { id: 'godaddy', re: /\bgo\s?daddy\b/i },
  { id: 'instagram', re: /\binstagram\b/i },
  { id: 'x-twitter', re: /\b(?:x|twitter) (?:developer|api) (?:portal|console|dashboard)\b/i },
  { id: 'slack-admin', re: /\bslack admin\b/i },
  { id: 'zoom-admin', re: /\bzoom (?:admin|dashboard)\b/i },
  { id: 'asana-admin', re: /\basana admin\b/i },
  { id: 'google-workspace-admin', re: /\b(?:google )?workspace admin\b/i },
  { id: 'azure', re: /\bazure\b/i },
  // A BARE "console" is only a surface when a qualifier makes it an operator
  // surface the owner clicks in — "admin console", "the console", "DNS console".
  { id: 'console-generic', re: /\b(?:admin|operator|dns|web|cloud|provider|registrar|billing)\s+console\b/i },
  // "the console" only counts when it is NOT a dev/build console — "the console
  // output", "console log", "console window" are build artifacts, not surfaces
  // the owner clicks in.
  { id: 'console-the', re: /\bthe console\b(?!\s*(?:output|log|logs|window|error|errors|panel of the build))/i },
  // Ticket-shaped surfaces that are consoles in all but name.
  { id: 'developer-portal', re: /\b(?:developer|api) (?:portal|dashboard)\b/i },
  { id: 'domain-registrar', re: /\b(?:domain )?registrar\b/i },
];

/**
 * The DO half — an imperative telling the owner to perform an action IN that
 * surface. "Should I use Tailscale?" names a surface but asks a DECISION, not a
 * console action; "paste this into Tailscale" is the console-ask shape.
 */
export const CONSOLE_DO_VERBS: ReadonlyArray<{ id: string; re: RegExp }> = [
  { id: 'paste', re: /\b(?:paste|copy|paste-ready)\b/i },
  { id: 'create', re: /\b(?:create|add|make|set up|setup|provision|register|enable|disable|install|invite|issue|generate|upload|rotate)\b/i },
  { id: 'save', re: /\b(?:save|apply|commit|submit|deploy)\b/i },
  { id: 'confirm', re: /\b(?:confirm|approve|authorize|authorise|verify|validate|accept)\b/i },
  { id: 'click', re: /\b(?:click|open|go to|navigate|head to|select|toggle|tick|check)\b/i },
  { id: 'configure', re: /\b(?:configure|set|update|change|edit|modify|grant|revoke|allow|whitelist|allowlist)\b/i },
];

/** A question that OPENS with one of these is proposing a decision, not sending the
 *  owner into a console — the owner-worded "Should I…" / "Do you want…" shape. The
 *  do-verb requirement alone does not separate those ("should I enable Tailscale?"
 *  carries `enable`), so the leading interrogative vetoes the detection. */
const DECISION_OPENER_RE = /^\s*(?:should|shall|do you|would you|d'?you|could you|can you|are you|is it|will you|any preference|which|whether|do i|shall i|may i|mind if)\b/i;

export interface ConsoleAskDetection {
  /** True when the text names a console surface AND tells the owner to act there. */
  detected: boolean;
  /** The surfaces named (ids from CONSOLE_SURFACES), deduped, in match order. */
  surfaces: string[];
  /** The action verbs found (ids from CONSOLE_DO_VERBS). */
  verbs: string[];
  /** First ~120 chars of the matched sentence — the evidence a human/telemetry reads. */
  excerpt: string;
}

/** Pure. `text` should be the already-redacted question (+ context), never raw input. */
export function detectSpeclessConsoleAsk(text: string): ConsoleAskDetection {
  const t = String(text ?? '');
  const empty: ConsoleAskDetection = { detected: false, surfaces: [], verbs: [], excerpt: '' };
  if (!t.trim()) return empty;
  const surfaces = CONSOLE_SURFACES.filter((s) => s.re.test(t)).map((s) => s.id);
  if (!surfaces.length) return empty;
  // The veto applies to the OPENING sentence only: a card that opens "Should I…"
  // and later says "…then paste the key" is still a decision card.
  if (DECISION_OPENER_RE.test(t)) return { ...empty, surfaces };
  const verbs = CONSOLE_DO_VERBS.filter((v) => v.re.test(t)).map((v) => v.id);
  if (!verbs.length) return { ...empty, surfaces };
  const at = t.search(CONSOLE_SURFACES.find((s) => s.re.test(t))!.re);
  const start = Math.max(0, t.lastIndexOf('. ', at) + 2);
  const stopRaw = t.indexOf('. ', at);
  const stop = stopRaw === -1 ? Math.min(t.length, at + 160) : stopRaw + 1;
  return { detected: true, surfaces, verbs, excerpt: t.slice(start, stop).trim().slice(0, 200) };
}

/** Kill switch, read at the call site so this module stays env-free. */
export const OWNER_CONSOLE_ASK_DETECT_DISABLED_ENV = 'OWNER_CONSOLE_ASK_DETECT_DISABLED';