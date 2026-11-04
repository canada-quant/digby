/**
 * TOOL-DESCRIPTION DIET LINT (build 2026-10-08 A2-3; audit 2026-10-08 architecture.md A1 step 3).
 *
 * Tool schemas were ~85 % of a guest prompt and ~75 % of a supervisor's static
 * prefix; the 212 descriptions alone were ~25.7k o200k tokens, 30 of them over
 * 1,000 chars, carrying ~45 ticket / audit / date references the prompt-hygiene
 * lint never saw (it reads single string literals; most long descriptions are
 * concatenated or templated). This lint reads the RENDERED schemas — exactly what
 * a run sends — and:
 *   (1) fails a top-level description longer than its budget: 800 chars, or its
 *       row in tool-description-budget.json (the post-diet length of a tool that
 *       still needs more). It fails only on NEW or LONGER text — shrinking is
 *       always fine. To pass: move the "why" (incident, ticket, date) into a code
 *       comment next to the schema; raise a row only with a justification in
 *       the PR;
 *   (2) fails a parameter description longer than 400 chars (or its `params` row);
 *   (3) fails provenance in ANY rendered description (top-level or parameter):
 *       ticket / feedback ids, dated rules, "(owner 20…" markers, project names,
 *       env-toggle instructions — the prompt-hygiene rules (model ids excepted:
 *       some arguments enumerate the built-ins they accept), with the shared
 *       prompt-hygiene.allow.json allowlist.
 * Unknown rows fail (a renamed / deleted tool must drop its row); a row whose
 * tool is now under the default budget only warns (delete it at leisure).
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../config/database', () => ({ __esModule: true, default: {} }));
jest.mock('../../../config/env', () => ({
  __esModule: true,
  env: { NODE_ENV: 'test', JWT_SECRET: 'x'.repeat(32), JWT_REFRESH_SECRET: 'y'.repeat(32) },
}));
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: { get: jest.fn(), set: jest.fn(), del: jest.fn() },
  redisSubscriber: { subscribe: jest.fn(), on: jest.fn() },
}));

import * as fs from 'fs';
import * as path from 'path';
import { runToolSchemasForProbe } from './agent';
import { lintPromptText, formatFindings, type AllowlistEntry, type HygieneFinding } from '../platform/prompt-hygiene';

interface Budget { maxChars: number; maxParamChars: number; tools: Record<string, number>; params: Record<string, number> }
const BUDGET = JSON.parse(fs.readFileSync(path.join(__dirname, 'tool-description-budget.json'), 'utf8')) as Budget;
const ALLOW = (JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'platform', 'prompt-hygiene.allow.json'), 'utf8')) as { entries: AllowlistEntry[] }).entries;
const PROJECTS = (JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'platform', 'prompt-hygiene.projects.json'), 'utf8')) as { names: string[] }).names;

/** Every schema any profile offers (coding + chat, supervisor tools on), by name. */
function allSchemas(): Map<string, any> {
  const out = new Map<string, any>();
  for (const o of [{ kind: 'coding' as const, supervisorTools: true, allowSubagents: true }, { kind: 'chat' as const, supervisorTools: true, allowSubagents: true }]) {
    for (const t of runToolSchemasForProbe(o)) out.set(t.function.name, t);
  }
  return out;
}

/** Every parameter description of a schema, keyed "<tool>.<path>". */
function paramDescriptions(name: string, params: any): Array<{ key: string; text: string }> {
  const out: Array<{ key: string; text: string }> = [];
  const walk = (node: any, p: string) => {
    if (!node || typeof node !== 'object') return;
    if (p && typeof node.description === 'string') out.push({ key: `${name}.${p}`, text: node.description });
    for (const [k, v] of Object.entries(node)) {
      if (k === 'description' || !v || typeof v !== 'object') continue;
      walk(v, k === 'properties' || k === 'items' ? p : (p ? `${p}.${k}` : k));
    }
  };
  walk(params, '');
  return out;
}

const SCHEMAS = allSchemas();

describe('tool-description diet (rendered schemas)', () => {
  it('the budget file is well-formed', () => {
    expect(BUDGET.maxChars).toBe(800);
    expect(BUDGET.maxParamChars).toBe(400);
    expect(SCHEMAS.size).toBeGreaterThan(200);
  });

  it('(1) no top-level description is longer than its budget — move the why into a code comment', () => {
    const over: string[] = [];
    for (const [name, t] of SCHEMAS) {
      const len = String(t.function.description ?? '').length;
      const cap = BUDGET.tools[name] ?? BUDGET.maxChars;
      if (len > cap) over.push(`${name}: ${len} chars > budget ${cap}${BUDGET.tools[name] ? ' (its row in tool-description-budget.json)' : ''}`);
    }
    expect(over).toEqual([]);
  });

  it('(2) no parameter description is longer than its budget', () => {
    const over: string[] = [];
    for (const [name, t] of SCHEMAS) {
      for (const p of paramDescriptions(name, t.function.parameters)) {
        const cap = BUDGET.params[p.key] ?? BUDGET.maxParamChars;
        if (p.text.length > cap) over.push(`${p.key}: ${p.text.length} chars > budget ${cap}`);
      }
    }
    expect(over).toEqual([]);
  });

  it('(3) no rendered description carries provenance (ticket ids, dates, owner-quote markers, project names, env toggles)', () => {
    const findings: HygieneFinding[] = [];
    for (const [name, t] of SCHEMAS) {
      const texts = [{ key: name, text: String(t.function.description ?? '') }, ...paramDescriptions(name, t.function.parameters)];
      for (const x of texts) findings.push(...lintPromptText({ source: `tool ${x.key}`, text: x.text, projectNames: PROJECTS, allow: ALLOW }).filter((f) => f.rule !== 'model_id'));
    }
    if (findings.length) throw new Error(`rendered tool descriptions: ${findings.length} provenance finding(s)\n${formatFindings(findings)}`);
  });

  it('every budget row names a tool / parameter that exists (a row under the default only warns)', () => {
    const unknown = Object.keys(BUDGET.tools).filter((n) => !SCHEMAS.has(n));
    const params = new Set<string>();
    for (const [name, t] of SCHEMAS) for (const p of paramDescriptions(name, t.function.parameters)) params.add(p.key);
    const unknownParams = Object.keys(BUDGET.params).filter((k) => !params.has(k));
    expect({ unknown, unknownParams }).toEqual({ unknown: [], unknownParams: [] });
    const slack = Object.entries(BUDGET.tools).filter(([n]) => String(SCHEMAS.get(n)?.function.description ?? '').length <= BUDGET.maxChars).map(([n]) => n);
    // eslint-disable-next-line no-console
    if (slack.length) console.warn(`[tool-description-budget] rows no longer needed (now ≤ ${BUDGET.maxChars} chars): ${slack.join(', ')}`);
  });
});
