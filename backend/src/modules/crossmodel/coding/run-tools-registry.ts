/**
 * Run-tool schema REGISTRY (2026-09-27) — a pure leaf that lets the admin role
 * tester (model-endpoints/model-roles.service probeChatCompletion) send the
 * seat's REAL tool list without importing coding/agent.ts: that module's load
 * graph reaches config/env, which process.exit(1)s under an unconfigured test
 * environment, so a dynamic import from the admin path is not safe. agent.ts
 * registers its assembler here at module load (every server process loads it
 * at boot through the chat routes); a process that never loaded agent.ts (a
 * unit test) sees null and the probe sends no tools — the pre-2026-09-27 shape.
 */

export interface RunToolSchemaOpts {
  kind: 'chat' | 'coding';
  supervisorTools?: boolean;
  allowSubagents?: boolean;
}

let source: ((opts: RunToolSchemaOpts) => any[]) | null = null;

export function registerRunToolSchemas(fn: (opts: RunToolSchemaOpts) => any[]): void {
  source = fn;
}

/** The registered assembler's schemas, or null when nothing registered yet. Never throws. */
export function runToolSchemasIfLoaded(opts: RunToolSchemaOpts): any[] | null {
  if (!source) return null;
  try {
    return source(opts);
  } catch {
    return null;
  }
}

/** Test seam. */
export function __resetRunToolSchemasForTests(): void {
  source = null;
}
