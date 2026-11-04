/**
 * Tests for the role tool policies — the safety-relevant invariant is that
 * read-only roles cannot mutate the worktree and no worker can publish/delegate.
 */

import { ROLES, ROLE_TOOLS, toolsForRole, isCodingRole, orchestratorRoleGuidance, CodingRole } from './roles';
import { INTEGRATION_TOOL_NAMES } from './integration-tool-schema';
jest.mock('../../../utils/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn() }));

const schema = (name: string) => ({ type: 'function' as const, function: { name } });
const ALL = [
  'read_file', 'view_image', 'list_dir', 'glob', 'grep', 'ast_search', 'git_status', 'git_diff', 'git_show',
  'write_file', 'edit_file', 'ast_rewrite', 'git_commit', 'git_push', 'open_pull_request',
  'run_command', 'update_plan', 'verify',
  'start_background_process', 'read_process_output', 'list_processes', 'stop_process',
  'search_engine', 'scrape_as_markdown', 'scrape_batch', 'browser_task', 'web_pipe', 'youtube_pipe',
  'search_memory', 'search_code_semantic', 'delegate', 'file_feedback', 'list_feedback', 'update_feedback',
  ...INTEGRATION_TOOL_NAMES,
].map(schema);

function names(role: CodingRole): string[] {
  return toolsForRole(role, ALL).map(t => t.function.name);
}

describe('role tool policies', () => {
  const readOnly: CodingRole[] = ['planner', 'architect', 'explorer', 'web_researcher', 'verifier', 'reviewer'];
  const writers: CodingRole[] = ['coder', 'editor'];

  test('read-only roles cannot mutate the worktree', () => {
    for (const r of readOnly) {
      const t = names(r);
      expect(t).not.toContain('write_file');
      expect(t).not.toContain('edit_file');
      expect(t).not.toContain('ast_rewrite'); // the structural codemod writes like edit_file (roadmap item 3)
      expect(t).not.toContain('git_commit');
      expect(t).toContain('ast_search'); // structural search is a read every worker gets
    }
  });

  test('read-only roles can read blobs from any ref via git_show (ticket 460806c6)', () => {
    // The researcher/explorer private-repo-PR gap: read_file is worktree-jailed
    // and raw.githubusercontent.com 404s without auth — git_show reads the blob
    // from the local object store instead. Must resolve to a REAL schema entry
    // (names() maps through toolsForRole, so a missing registration fails here).
    // Writers (coder/editor) get it via the same READ group (review NB2).
    for (const r of [...readOnly, ...writers]) expect(names(r)).toContain('git_show');
  });

  test('every role that reads files can LOOK at an image (view_image is in READ, 2026-10-01)', () => {
    // The TB 2.1 chess-best-move lane rebuilt vision from pixels; a reviewer /
    // verifier / explorer checking an image-dependent task needs the same eye.
    for (const r of [...readOnly, ...writers]) expect(names(r)).toContain('view_image');
    expect(names('cross_checker')).not.toContain('view_image'); // no worktree, no READ group
  });

  test('writer roles can edit but never publish', () => {
    for (const r of writers) {
      const t = names(r);
      expect(t).toContain('edit_file');
      expect(t).not.toContain('git_push');
      expect(t).not.toContain('open_pull_request');
    }
  });

  test('no worker may publish, delegate, or (except planner) edit the plan', () => {
    for (const r of Object.keys(ROLES) as CodingRole[]) {
      const t = names(r);
      expect(t).not.toContain('git_push');
      expect(t).not.toContain('open_pull_request');
      expect(t).not.toContain('delegate');
      if (r !== 'planner') expect(t).not.toContain('update_plan');
    }
    expect(names('planner')).toContain('update_plan');
  });

  test('role-appropriate capabilities', () => {
    expect(names('web_researcher')).toContain('search_engine');
    expect(names('explorer')).not.toContain('search_engine');
    expect(names('coder')).toContain('start_background_process');
    expect(names('verifier')).toContain('verify');
    expect(names('verifier')).not.toContain('write_file');
  });

  test('explorer/architect get the minimal web READ subset, not the full WEB group (ticket debbef04)', () => {
    for (const r of ['explorer', 'architect'] as CodingRole[]) {
      const t = names(r);
      // external repos/docs must be reachable (raw.githubusercontent.com, api.github.com)
      expect(t).toContain('scrape_as_markdown');
      expect(t).toContain('web_pipe');
      // ...but exploration reads KNOWN targets — SERP search / browsing / video stay with research roles
      expect(t).not.toContain('search_engine');
      expect(t).not.toContain('browser_task');
      expect(t).not.toContain('youtube_pipe');
    }
    // roles that had no web access keep none
    for (const r of ['verifier', 'editor'] as CodingRole[]) {
      expect(names(r)).not.toContain('scrape_as_markdown');
      expect(names(r)).not.toContain('web_pipe');
    }
  });

  test('connector tools (chat parity) reach context-needing roles, but stay read-only', () => {
    for (const r of ['web_researcher', 'explorer', 'architect', 'coder', 'reviewer', 'planner'] as CodingRole[]) {
      expect(names(r)).toContain('github_search_code');
      expect(names(r)).toContain('slack_search');
    }
    // Integration tools are read-only — they never let a role mutate the worktree.
    expect(names('reviewer')).not.toContain('write_file');
  });

  test('every role may file feedback (agent feedback loop), but never triage it', () => {
    for (const r of Object.keys(ROLES) as CodingRole[]) {
      const t = names(r);
      expect(t).toContain('file_feedback');        // low-risk: dedup'd + rate-capped in the service
      expect(t).not.toContain('list_feedback');    // admin triage stays orchestrator-only
      expect(t).not.toContain('update_feedback');
    }
  });

  test('isCodingRole + guidance lists every role', () => {
    expect(isCodingRole('coder')).toBe(true);
    expect(isCodingRole('nope')).toBe(false);
    const g = orchestratorRoleGuidance();
    for (const r of Object.keys(ROLES)) expect(g).toContain(r);
  });

  test('guidance steers the orchestrator toward delegation + search_memory for context discipline', () => {
    const g = orchestratorRoleGuidance();
    expect(g).toMatch(/search_memory/);
    expect(g).toMatch(/explorer/);
    expect(g.toLowerCase()).toMatch(/context/);
  });

  test('every role declares a positive step budget', () => {
    for (const r of Object.keys(ROLES) as CodingRole[]) {
      expect(ROLES[r].maxSteps).toBeGreaterThan(0);
      expect(ROLE_TOOLS[r].length).toBeGreaterThan(0);
    }
  });

  // ── Retrieval grants + doctrine (owner 2026-09-04: "doesn't read memory or
  //    embeds very often") — every role can reach memory, and the roles that
  //    read code before acting are TOLD when to use it. ──
  test('EVERY role carries both retrieval tools (editor/verifier included — they trip over exactly what learnings.md records)', () => {
    for (const r of Object.keys(ROLES) as CodingRole[]) {
      expect(names(r)).toEqual(expect.arrayContaining(['search_memory', 'search_code_semantic']));
    }
  });

  test('role prompts carry retrieval doctrine, not just the tool grant', () => {
    // The grant alone was invisible: 7 of 9 prompts never mentioned either tool
    // and the model had to discover them in a 30+-tool schema.
    for (const r of ['planner', 'architect', 'explorer', 'coder', 'reviewer', 'verifier', 'editor', 'web_researcher'] as CodingRole[]) {
      expect(ROLES[r].prompt).toMatch(/search_memory/);
    }
    for (const r of ['planner', 'architect', 'explorer', 'coder'] as CodingRole[]) {
      expect(ROLES[r].prompt).toMatch(/search_code_semantic/);
    }
  });

  test('orchestrator guidance names the semantic code index for locating code', () => {
    expect(orchestratorRoleGuidance()).toMatch(/search_code_semantic/);
  });
});

describe('helper-tier model routing (One-Digby: fast models for mechanical roles)', () => {
  const { ROLES, ROLE_TOOLS } = require('./roles');
  const { HELPER_MODEL, normalizeCodingModel, resolveProvider } = require('./coding-model');

  it('web_researcher is THE research role: read-only, web_pipe + web + retrieve (ingestor merged 2026-07-15)', () => {
    expect((ROLES as any).ingestor).toBeUndefined();
    expect(ROLES.web_researcher.writes).toBe(false);
    expect(ROLE_TOOLS.web_researcher).toEqual(expect.arrayContaining(['web_pipe', 'scrape_as_markdown', 'search_memory']));
    expect(ROLE_TOOLS.web_researcher).not.toEqual(expect.arrayContaining(['write_file']));
    expect(ROLE_TOOLS.cross_checker).toEqual(expect.arrayContaining(['web_pipe']));
  });

  it('the verifier is the ONLY helper-tier role (audit #10; editor moved to the coding model 2026-09-08)', () => {
    // verifier: run the chain, quote output — no design work; its failure mode
    // is a weak report the orchestrator/reviewer catch. Escalatable per
    // delegation via delegate({model:'premium'}).
    expect(ROLES.verifier.helperTier).toBe(true);
  });

  it('reasoning roles AND every writer role are NOT helper-tier', () => {
    // web_researcher re-examined for audit #10 and deliberately kept PREMIUM:
    // its prompt demands mechanism REASONING (web_pipe vs targeted scrape,
    // git_show/connector fallback chains) — not mechanical fetch. The editor
    // joined this list 2026-09-08 (owner ask): the only writer that was
    // helper-tier, whose failure mode is silent wrong/absent edits — and on
    // Edge the helper seat can be a tiny or tool-call-incapable custom model.
    // The orchestrator downgrades a trivial pass with delegate({model:'helper'}).
    for (const r of ['cross_checker', 'web_researcher', 'coder', 'editor', 'reviewer', 'planner', 'architect', 'explorer']) {
      expect(ROLES[r].helperTier).toBeUndefined();
    }
    // Invariant: no role that writes to the worktree defaults to the helper tier.
    for (const r of Object.keys(ROLES)) {
      if (ROLES[r].writes) expect(ROLES[r].helperTier).toBeUndefined();
    }
  });

  it('the helper model resolves to a real provider with NO reasoning extras', () => {
    expect(normalizeCodingModel(HELPER_MODEL)).toBe(HELPER_MODEL);
    const p = resolveProvider(HELPER_MODEL);
    expect(p.model).toBe('qwen3.6-27b'); // helper tier moved to Qwen 2026-07-15 (owner: validated on L1)
    expect(p.extra.thinking).toBeUndefined();
    expect(p.extra.reasoning_effort).toBeUndefined();
  });
});
