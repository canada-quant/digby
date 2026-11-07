# `coding/` — Digby Code backend

Agentic coding for Digby AI (rendered inline in the main chat page via CodeSessionView; the legacy /crossmodel/code page was retired in the Session UI Convergence C3 work). An orchestrator-worker
multi-agent that builds/fixes code in an isolated per-session git worktree +
Docker container and streams its work over SSE.

**Full docs:** [`docs/DIGBY_CODE.md`](../../../../../docs/DIGBY_CODE.md)

## Where to start

| I want to… | Look at |
|---|---|
| Understand the run loop | `agent.ts` (`agentLoop`) |
| Add/adjust an agent tool | `tools.ts` (`CODING_TOOL_SCHEMA` + `executeCodingTool`) |
| Add/adjust a worker role | `roles.ts` (`ROLES`, `ROLE_TOOLS`) |
| Change how runs stream / reattach | `coding-stream.controller.ts` + `live-runs.ts` |
| Change REST endpoints | `coding.controller.ts` + `coding.routes.ts` |
| Goals / todos | `plan.service.ts` |
| Verify loop / PR gate | `verify.service.ts` + `verify-state.ts` |
| Background processes | `process.service.ts` |
| Memory (3 tiers) | `coding-memory.service.ts` |
| Retrieval (`search_memory`) | `coding-retrieval.service.ts` |
| Context compaction | `compaction.ts` |
| Worktrees / containers | `workspace.service.ts` / `container.service.ts` |
| Project scaffolding | `scaffolding.service.ts` |

## Invariants (don't break these)

- **Tool policy per role** (`roles.ts`): read-only roles never mutate the worktree;
  `git_push`/`open_pull_request`/`delegate` are orchestrator-only; workers are depth-1.
  A role-scoped worker's paired-device access is **camera-only** (ticket 8fe9429c):
  its `browser_task` COMPUTER handoff and any `computer_task` session can screenshot
  and read the screen but never click/type/press keys/quit apps — enforced at the
  computer-loop dispatch gate (`computerInputMode: 'observe'` on the worker's
  `ToolCache`), so an observation sub-agent can't kill a running transfer again.
- **Safety** (`tools.ts` `checkPermission` + the system prompt): stay in the worktree
  (`resolveInside`), no `rm -rf`/force-push/history-rewrite, never exfiltrate secrets.
- **Reserve the run slot synchronously** (`startLiveRun` before any await) to avoid a
  double-start race.
- **Best-effort side-channels**: memory/retrieval/scaffolding failures are swallowed —
  a session must always reach `ready` and a run must never crash on them.
- **Everything degrades**: container off → in-process bash; embeddings off → keyword
  retrieval; no verify chain → no PR gate (don't gate what can't run).

## Tests

`npx jest src/modules/crossmodel/coding` (from `backend/`).
