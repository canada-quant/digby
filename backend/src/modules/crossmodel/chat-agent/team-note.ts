/**
 * TEAM NOTE — dynamic roster phase 4 (roster 2026-10-06 D-3; docs/DYNAMIC_ROSTER_PLAN_2026-10-03.md §5: "a one-line
 * 'team' note under each answer (e.g. 'Quick · qwen3.8-flash + web')").
 *
 * Which models worked on THIS answer, as data for the depth pill: persisted on the answer row as metadata.depth.team
 * (and so on the 'complete' event's `depth`, which carries metadata.depth verbatim). DATA ONLY — no web surface renders
 * it yet (frontend DepthPill has no team hook; a later UI change reads `line`). Members are what RAN: the lead after
 * any fallback, the Double Checker the plan spawned, the council colleagues that reported, and a successful call_in.
 *
 *   { line: 'Checked · glm-5.3 + deepseek-v4.1-flash + web', lane: 'checked', web: true,
 *     members: [{ role: 'lead', model: 'glm-5.3' }, { role: 'checker', model: 'cql-litellm:…', via: 'plan' }] }
 *
 * Model names in `line` are SHORT ids (the gateway route / hosting-vendor prefix dropped) — this is UI data, not a
 * status line (status-voice.ts keeps model names out of the live stream). Kill switch TEAM_NOTE_DISABLED=1 (no field).
 * Pure leaf.
 */

import type { Lane } from '../platform/turn-plan';

export interface TeamMember {
  role: 'lead' | 'checker' | 'colleague';
  model: string;
  via?: 'plan' | 'council' | 'call_in';
}

export interface TeamNote {
  line: string;
  lane: Lane;
  web: boolean;
  members: TeamMember[];
}

export function teamNoteDisabled(env: Record<string, string | undefined> = process.env): boolean {
  const s = String(env.TEAM_NOTE_DISABLED ?? '').trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'on';
}

const LANE_LABEL: Record<Lane, string> = { quick: 'Quick', standard: 'Standard', checked: 'Checked', research: 'Research' };

/** Model lines a hosting / routing prefix may sit in front of (kept only when what follows names one of them). */
const MODEL_LINE_RE = /^(glm|kimi|deepseek|qwen|qwq|mimo|minimax|m\d+(?:\.\d+)?-flash|claude|gpt|o[134]\b|grok|gemini|gemma|llama|mistral|mixtral|codestral|command|laya|jev|kev)/i;

/**
 * A short display id for a spec: the model id without the endpoint label, the gateway route prefix
 * ("api-optimize-", "api-", "spark-", "tt-", "agx-") or a hosting vendor in front of a known model line
 * ("alibaba-qwen3.8-flash" → "qwen3.8-flash", but "deepseek-v4-pro" stays). Pure.
 */
export function shortModelName(spec: string): string {
  const s = String(spec ?? '').trim();
  const i = s.indexOf(':');
  let id = i >= 0 ? s.slice(i + 1) : s;
  id = id.replace(/^(?:api-)?optimize-/i, '').replace(/^(?:api|spark|tt|agx)-/i, '');
  const m = id.match(/^([a-z0-9]+)-(.+)$/i);
  if (m && !MODEL_LINE_RE.test(id) && MODEL_LINE_RE.test(m[2])) id = m[2];
  return id || s;
}

export interface TeamNoteInput {
  lane: Lane;
  lead: string | null;
  checker?: { model: string; via: 'plan' | 'call_in' } | null;
  colleagues?: Array<{ model: string; via: 'council' | 'call_in' }>;
  web: boolean;
}

/** The note for one answer, or null without a lead. Pure. */
export function teamNoteFor(i: TeamNoteInput): TeamNote | null {
  if (!i.lead) return null;
  const members: TeamMember[] = [{ role: 'lead', model: i.lead }];
  if (i.checker?.model) members.push({ role: 'checker', model: i.checker.model, via: i.checker.via });
  const seen = new Set<string>();
  for (const c of i.colleagues ?? []) {
    if (!c?.model || seen.has(`${c.via}:${c.model}`)) continue;
    seen.add(`${c.via}:${c.model}`);
    members.push({ role: 'colleague', model: c.model, via: c.via });
  }
  const parts = members.map((m) => `${shortModelName(m.model)}${m.via === 'call_in' ? ' (called in)' : ''}`);
  const line = `${LANE_LABEL[i.lane] ?? 'Standard'} · ${parts.join(' + ')}${i.web ? ' + web' : ''}`;
  return { line: line.slice(0, 200), lane: i.lane, web: i.web, members };
}
