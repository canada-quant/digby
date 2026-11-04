/**
 * REPLAY — ticket 68a36304 (2026-09-13, mishap, priority 1).
 *
 * "Researcher-role delegate lacks file-write tool, but orchestrator tasks
 * require file output": in a coding session on canlegal-bench the orchestrator
 * delegated an annotation task to a web_researcher whose brief demanded
 * "WRITE it to the file tmp/annot/out_crit5_a.json using your file-writing
 * tool". The researcher role's toolset is read-only (no write_file / edit_file
 * / run_command; the role prompt says "Do NOT modify files"), so the analysis
 * came back in chat and the required persistence step was impossible — exactly
 * the failure mode the brief's output contract existed to avoid.
 *
 * The fix (this suite's subject): a dispatch gate — readOnlyFileWriteRefusal
 * (delegation.ts) — refuses a file-artifact brief aimed at a read-only role
 * BEFORE any worker runs and BEFORE the delegation budget is charged, with a
 * refusal that names both re-routes; the delegate schema + orchestrator
 * guidance tell the orchestrator up front; read-only role prompts now say
 * what to do if a file-writing demand still slips through.
 *
 * Pins BOTH directions per the __replays__ convention:
 *   - the incident shape IS refused (a regression that stops refusing fails CI),
 *   - the honest twins (ordinary read/report briefs) stay CLEAN,
 *   - writer roles are never gated,
 *   - the rendered refusal wording (a contract — it must keep naming the
 *     re-routes, the read-only escape hatch, and the zero-budget guarantee).
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../config/database', () => ({ __esModule: true, default: {} }));
jest.mock('../../../config/env', () => ({ __esModule: true, env: { NODE_ENV: 'test' } }));
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: { set: jest.fn(), get: jest.fn(), del: jest.fn(), publish: jest.fn() },
}));

// MCP integration modules (the coding-integrations import chain).
jest.mock('../github/github-mcp', () => ({
  searchCode: jest.fn(), listIssues: jest.fn(), getIssue: jest.fn(), listPullRequests: jest.fn(),
}));
jest.mock('../google/google-mcp', () => ({
  resolveGoogleAccount: jest.fn(), getGmailMessages: jest.fn(), getGmailMessage: jest.fn(),
  getGmailAttachment: jest.fn(), getCalendarEvents: jest.fn(), listDriveFiles: jest.fn(),
  getDocContent: jest.fn(), getSheetData: jest.fn(),
}));
jest.mock('../slack/slack-mcp', () => ({
  searchMessages: jest.fn(), listChannels: jest.fn(), getChannelHistory: jest.fn(),
}));
jest.mock('../asana/asana-mcp', () => ({
  searchTasks: jest.fn(), listMyTasks: jest.fn(), listProjects: jest.fn(),
}));
jest.mock('../x/x-mcp', () => ({
  search: jest.fn(), getUserProfile: jest.fn(), getTrends: jest.fn(),
}));
jest.mock('../xero/xero-mcp', () => ({
  getOrganisation: jest.fn(), getContacts: jest.fn(), getInvoices: jest.fn(),
}));
jest.mock('../plaid/plaid-mcp', () => ({
  getAccounts: jest.fn(), getBalances: jest.fn(), getTransactions: jest.fn(),
}));
jest.mock('../imessage/imessage.service', () => ({
  getPrimaryAgent: jest.fn(), isOnline: jest.fn(),
}));
jest.mock('../imessage/agent-link', () => ({ agentBroker: { dispatch: jest.fn() } }));

const mockRunModelTurn: jest.Mock = jest.fn();
jest.mock('./coding-model', () => {
  const actual = jest.requireActual('./coding-model');
  return {
    ...actual,
    seatUnservableReason: async () => null,
    runModelTurn: (...a: any[]) => mockRunModelTurn(...a),
  };
});

const _store = new Map<string, any>();
jest.mock('../memory/context-store', () => ({
  __esModule: true,
  storeGet: jest.fn(async (ns: string[], key: string) => _store.get(ns.join('/') + '::' + key) ?? null),
  storePut: jest.fn(async (ns: string[], key: string, value: any) => { _store.set(ns.join('/') + '::' + key, value); }),
}));
jest.mock('./run-journal.service', () => ({
  __esModule: true,
  getRecentJournalEntries: jest.fn(async () => []),
  formatJournalBlock: jest.fn(() => ''),
}));
jest.mock('./container.service', () => ({
  __esModule: true,
  ensureSessionContainer: jest.fn(async () => false),
  execInContainer: jest.fn(),
  isContainerMode: jest.fn(() => false),
}));
jest.mock('./session-credentials', () => ({
  __esModule: true,
  gatherSessionCredentialEnv: jest.fn(async () => ({})),
  credentialEnvNote: jest.fn(() => ''),
}));
jest.mock('./code-index.service', () => ({ __esModule: true, kickCodeIndexSync: jest.fn() }));
jest.mock('../github/token-manager', () => ({ __esModule: true, getValidToken: jest.fn(async () => null) }));
jest.mock('./datetime-context', () => ({
  __esModule: true,
  loadUserTimezone: jest.fn(async () => 'UTC'),
  buildCodingDateTimeBlock: jest.fn(() => ''),
  buildCodingClockNote: jest.fn(() => '[HARNESS CLOCK] test'),
  buildChatWakeClockNote: jest.fn(() => ""),
}));
jest.mock('./run-receipts.service', () => ({ __esModule: true, recordRunReceiptAsync: jest.fn() }));
jest.mock('./verify-state', () => ({ __esModule: true, recordVerify: jest.fn(async () => {}) }));
jest.mock('./coding-retrieval.service', () => ({ __esModule: true, storeFindings: jest.fn(async () => 0) }));
jest.mock('./plan.service', () => ({
  __esModule: true,
  getPlan: jest.fn(async () => null),
  applyPlan: jest.fn(async () => null),
  planToUpdate: jest.fn((p: any) => ({ goal: p.goal, steps: p.steps.map((s: any) => ({ ...s })) })),
  renderPlanReminder: jest.fn(() => '<plan>x</plan>'),
}));

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { runCodingAgent } from './agent';
import type { AgentRunInput } from './agent';
import type { AgentProfile } from './agent-profiles';
import { readOnlyFileWriteRefusal } from './delegation';
import { ROLES, orchestratorRoleGuidance, CodingRole } from './roles';

// Same no-workspace coding profile as agent-delegation.test.ts: delegation and
// the gate are profile-agnostic — only profile.kind==='coding' matters.
const CODING_TEST_PROFILE: AgentProfile = {
  kind: 'coding',
  maxSteps: 8,
  maxDelegations: 2, // LOW on purpose: proves a refused dispatch charges nothing
  contextCharBudget: 100_000,
  workspaceTools: false,
  planReminders: false,
  memorySource: 'coding',
};

// Chat lane (the cross-checker/researcher delegation path): the gate must NOT
// fire here — its advertised re-routes (delegate to coder/editor, write the
// file in the worktree) are unexecutable in chat mode, and chat delegation
// tasks embed the USER's question verbatim.
const CHAT_TEST_PROFILE: AgentProfile = {
  kind: 'chat',
  maxSteps: 8,
  maxDelegations: 2,
  contextCharBudget: 100_000,
  workspaceTools: false,
  planReminders: false,
  memorySource: 'chat',
};

let worktree: string;
const makeInput = (): AgentRunInput => ({
  worktree,
  sessionId: 'sess-68a36304',
  projectId: 'p1',
  userId: 'u1',
  permissionMode: 'auto',
  model: 'glm-5.2',
  projectName: 'test',
  branch: 'main',
  profile: CODING_TEST_PROFILE,
  doctrineOverride: 'You are a test orchestrator.',
  history: [],
  userMessage: 'do the thing',
  emit: jest.fn(),
});

const orchTurn = (toolCalls: any[]) => ({ content: '', reasoning: '', toolCalls, finishReason: 'tool_calls' });
const finalTurn = (content: string) => ({ content, reasoning: '', toolCalls: [], finishReason: 'stop' });
const delegateCall = (args: any) => ({ id: 'tc1', name: 'delegate', arguments: JSON.stringify(args) });
const parallelCall = (tasks: any[]) => ({ id: 'tc1', name: 'delegate_parallel', arguments: JSON.stringify({ tasks }) });

beforeAll(async () => {
  worktree = await fs.mkdtemp(path.join(os.tmpdir(), 'digby-68a36304-'));
});
afterAll(async () => { await fs.rm(worktree, { recursive: true, force: true }); });
beforeEach(() => { jest.clearAllMocks(); _store.clear(); });

// The incident's brief, verbatim (redacted — it names no user content).
const INCIDENT_BRIEF =
  'Annotate the 40 criteria-5 transcripts with pass/fail per rubric item. WRITE it to the file tmp/annot/out_crit5_a.json using your file-writing tool.';

describe('REPLAY 68a36304 — pure detector (readOnlyFileWriteRefusal)', () => {
  test('THE INCIDENT SHAPE is refused for the researcher role (the mishap cannot silently recur)', () => {
    const refusal = readOnlyFileWriteRefusal('web_researcher', INCIDENT_BRIEF);
    expect(refusal).not.toBeNull();
    expect(refusal).toContain('68a36304');
    expect(refusal).toContain('Researcher');
  });

  test('demand shapes across phrasings and read-only roles are refused', () => {
    const demands: Array<[string, CodingRole, string]> = [
      ['write the annotations to tmp/out.json', 'explorer', 'verb→path'],
      ['Save the results as a CSV file and report the path', 'web_researcher', 'verb→file'],
      ['please create an output file with the digest', 'architect', 'create file'],
      ['Persist the array to results/out.csv', 'planner', 'verb→path'],
      ['export the findings to docs/summary.md', 'web_researcher', 'verb→path'],
      ['Write the file now — it must exist on disk afterwards', 'explorer', 'verb+file adjacent'],
      ['edit this file to add the annotations', 'verifier', 'verb+file adjacent'],
      ['dump the parsed rows into a file', 'reviewer', 'verb→file'],
      ['STORE the matrix as out.json', 'cross_checker', 'verb→path'],
    ];
    for (const [brief, role] of demands) {
      const refusal = readOnlyFileWriteRefusal(role, brief);
      expect(refusal).not.toBeNull();
      expect(refusal).toContain('[DELEGATION REFUSED');
      expect(refusal).toContain(ROLES[role].label);
    }
  });

  test('the tool-name hint alone (the incident\'s "file-writing tool" phrase) refuses', () => {
    expect(readOnlyFileWriteRefusal('web_researcher', 'Produce the artifact with your file-writing tool.')).not.toBeNull();
    expect(readOnlyFileWriteRefusal('explorer', 'Use write_file to persist the digest.')).not.toBeNull();
  });

  test('HONEST TWINS: ordinary read/report briefs stay clean (no overreach)', () => {
    // The real corpus of briefs this fleet generates (roles.test.ts + agent-
    // delegation.test.ts shapes) plus common analysis-only phrasings.
    const clean: Array<[string, CodingRole]> = [
      ['run the verify chain', 'verifier'],
      ['map the repo', 'explorer'],
      ['verify it', 'verifier'],
      ['research the pricing pages of these 3 vendors and report URLs', 'web_researcher'],
      ['summarize the pages into a digest and report it back', 'web_researcher'],
      ['read package.json and report the dependency versions', 'explorer'],
      ['propose a design for the retry throttler', 'architect'],
      ['review the diff for correctness issues', 'reviewer'],
      ['create a summary of the file contents in your report', 'explorer'],   // "create a summary", not "create a file"
      ['report what the stored file contains', 'explorer'],                   // participle, no destination
      ['compare the two output files and report differences', 'verifier'],    // "output files" as a NOUN to read
      ['', 'web_researcher'],                                                 // empty brief: not this gate's problem
    ];
    for (const [brief, role] of clean) {
      expect(readOnlyFileWriteRefusal(role, brief)).toBeNull();
    }
  });

  test('ADVERSARIAL REVIEW ROUND 2 — participle/adjective narration stays clean (past-tense forms are not demands)', () => {
    // Reviewer probe corpus (tmp-review/fp.js): these are ANALYSIS briefs whose
    // past participles describe existing artifacts. Past tense/participle forms
    // (exported/stored/written/emitted/wrote/dumped/persisted/saved) are
    // excluded from the verb lists for exactly this reason.
    const clean: Array<[string, CodingRole]> = [
      ['Read the exported data and report which fields map to the output file', 'explorer'],
      ['Read the stored credentials and report any changes to the file since yesterday', 'explorer'],
      ['Verify the exported rows match what is written to the output file', 'verifier'],
      ['Summarize the emitted events and report which service wrote to the log file', 'web_researcher'],
      ['Report the stored rows as a file-by-file table', 'explorer'],
      ['find where the service wrote its config on disk', 'explorer'],
    ];
    for (const [brief, role] of clean) {
      expect(readOnlyFileWriteRefusal(role, brief)).toBeNull();
    }
  });

  test('ADVERSARIAL REVIEW ROUND 2 — NEGATED demands stay clean (a brief already instructing inline reporting must not be refused)', () => {
    const clean: Array<[string, CodingRole]> = [
      ['Annotate the transcripts and report in chat — do NOT save the output to a file', 'web_researcher'],
      ['Map the module and write NOTHING to any file; report inline only', 'explorer'],
      ['Review the diff. Do not create a file. Report findings in your final message.', 'reviewer'],
      ['Summarize the corpus without writing a file to disk', 'explorer'],
      ['Report findings in chat rather than saving a CSV', 'verifier'],
    ];
    for (const [brief, role] of clean) {
      expect(readOnlyFileWriteRefusal(role, brief)).toBeNull();
    }
  });

  test('ADVERSARIAL REVIEW ROUND 2 — briefs ABOUT the write tools (analysis targets) stay clean', () => {
    // A bare tool-id mention is something to READ about, not a capability
    // demand; only a governed use ("use write_file") or the incident's
    // possessive phrasing ("your file-writing tool") counts.
    const clean: Array<[string, CodingRole]> = [
      ['Explore how the write_file tool is implemented and which roles are file writers', 'explorer'],
      ['Inspect the codebase for the file writer module and report its API', 'explorer'],
      ['grep for write_file callers and report the call sites', 'explorer'],
    ];
    for (const [brief, role] of clean) {
      expect(readOnlyFileWriteRefusal(role, brief)).toBeNull();
    }
    // …while the governed forms still refuse.
    expect(readOnlyFileWriteRefusal('explorer', 'Use write_file to persist the digest')).not.toBeNull();
    expect(readOnlyFileWriteRefusal('web_researcher', 'Produce the artifact with your file-writing tool.')).not.toBeNull();
  });

  test('ADVERSARIAL REVIEW ROUND 2 — question/research forms stay clean ("way to persist config" asks ABOUT the action, it does not demand it)', () => {
    const clean: Array<[string, CodingRole]> = [
      ['research the idiomatic way to persist config to disk in Rust and report back', 'web_researcher'],
      ['find the best way to store the results as a CSV and explain the tradeoffs', 'architect'],
      ['how to write output to a file in Python — research the current idioms', 'web_researcher'],
      ['investigate approaches to export the digest to a text document', 'explorer'],
    ];
    for (const [brief, role] of clean) {
      expect(readOnlyFileWriteRefusal(role, brief)).toBeNull();
    }
    // …while a direct imperative still refuses ("way to" does not govern it).
    expect(readOnlyFileWriteRefusal('web_researcher', 'Persist the config to disk now and report the path')).not.toBeNull();
  });

  test('ADVERSARIAL REVIEW ROUND 2 — natural demand phrasings WITHOUT the word "file" are refused (under-detection fixed)', () => {
    // Reviewer probe corpus (tmp-review/fromsrc.js): the guidance's own second
    // example ("save the results as a CSV") plus sibling phrasings that name an
    // artifact noun with no "file" word and no extension. These are demands.
    const demands: Array<[string, CodingRole]> = [
      ['save the results as a CSV', 'web_researcher'],
      ['write the results to a CSV', 'web_researcher'],
      ['dump the parsed rows into a new document', 'explorer'],
      ['persist the findings to the results directory', 'architect'],
      ['save the annotations as a spreadsheet and report the path', 'web_researcher'],
      ['export the digest to a text document', 'web_researcher'],
      ['store the matrix as a new markdown doc', 'cross_checker'],
    ];
    for (const [brief, role] of demands) {
      expect(readOnlyFileWriteRefusal(role, brief)).not.toBeNull();
    }
  });

  test('writer roles are NEVER gated, even on explicit file-artifact briefs', () => {
    for (const role of ['coder', 'editor'] as CodingRole[]) {
      expect(readOnlyFileWriteRefusal(role, 'Write the annotations to tmp/out.json')).toBeNull();
      expect(readOnlyFileWriteRefusal(role, INCIDENT_BRIEF)).toBeNull();
    }
  });

  test('the refusal wording is a CONTRACT: mismatch + both re-routes + read-only escape hatch + zero-budget guarantee', () => {
    const refusal = readOnlyFileWriteRefusal('web_researcher', 'write the annotations to tmp/out.json')!;
    expect(refusal).toContain('NO file-writing tools');
    expect(refusal).toContain("delegate({role:'coder'}");
    expect(refusal).toContain('write the file yourself');
    expect(refusal).toContain('only something to READ');
    expect(refusal).toContain('no delegation budget');
    // It quotes the matched demand so the orchestrator can see WHY it fired.
    expect(refusal).toMatch(/Matched demand: "….*write the annotations to tmp\/out\.json.*…"/);
  });

  test('the matched-demand snippet keeps its window bounded even inside a huge brief', () => {
    const huge = 'x'.repeat(5000) + ' write the annotations to tmp/out.json ' + 'y'.repeat(5000);
    const refusal = readOnlyFileWriteRefusal('explorer', huge)!;
    const snippet = refusal.match(/Matched demand: "…([\s\S]*?)…"/)![1];
    expect(snippet.length).toBeLessThanOrEqual(200);
  });
});

describe('REPLAY 68a36304 — dispatch gate through the agent loop', () => {
  test('the incident dispatch is refused: NO worker model turn runs, the orchestrator sees the re-route in the tool result', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(orchTurn([delegateCall({ role: 'web_researcher', task: INCIDENT_BRIEF })]))
      .mockResolvedValueOnce(finalTurn('Understood — writing the file myself from a coder delegation.'));
    const input = makeInput();
    await runCodingAgent(input);

    // Exactly TWO model turns: orchestrator + orchestrator final. NO worker turn.
    expect(mockRunModelTurn).toHaveBeenCalledTimes(2);
    const toolMsg = (mockRunModelTurn.mock.calls[1][1] as any[]).find(m => m.role === 'tool');
    expect(toolMsg.content).toContain('[DELEGATION REFUSED — read-only role cannot produce a file artifact (ticket 68a36304)]');
    expect(toolMsg.content).toContain("delegate({role:'coder'}");
    expect(toolMsg.content).toContain('no delegation budget');
    // No subagent lifecycle events: the worker never started.
    const events = (input.emit as jest.Mock).mock.calls.map(c => c[0]);
    expect(events).not.toContain('subagent_start');
    expect(events).not.toContain('subagent_end');
  });

  test('a refused dispatch charges NO budget: the next legit delegation still runs within maxDelegations=2', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(orchTurn([delegateCall({ role: 'web_researcher', task: INCIDENT_BRIEF })]))   // refused, budget untouched
      .mockResolvedValueOnce(orchTurn([delegateCall({ role: 'coder', task: 'write tmp/annot/out_crit5_a.json from this array' })]))
      .mockResolvedValueOnce(finalTurn('wrote it\n```json\n{"status":"done","artifacts":["tmp/annot/out_crit5_a.json"]}\n```'))
      .mockResolvedValueOnce(finalTurn('done'));
    const input = makeInput();
    await runCodingAgent(input);

    // 4 turns: orch(refuse) → orch(coder) → WORKER → orch final. The worker ran.
    expect(mockRunModelTurn).toHaveBeenCalledTimes(4);
    expect(mockRunModelTurn.mock.calls[2][0].model).toBe('glm-5.3'); // coder worker = the coding model
    expect((input.emit as jest.Mock).mock.calls).toEqual(expect.arrayContaining([
      ['subagent_start', expect.objectContaining({ role: 'coder' })],
      ['subagent_end', expect.objectContaining({ role: 'coder', status: 'done' })],
    ]));
    // And the coder's tool message reached the orchestrator.
    const toolMsg = (mockRunModelTurn.mock.calls[3][1] as any[]).filter((m: any) => m.role === 'tool');
    expect(toolMsg.some((m: any) => String(m.content).includes('[WORKER STATUS: done'))).toBe(true);
  });

  test('delegate_parallel fans the SAME refusal: a file-artifact task inside a parallel batch is refused per-task, siblings still run', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(orchTurn([parallelCall([
        { role: 'web_researcher', task: 'research the vendor pricing pages and report URLs' },
        { role: 'explorer', task: 'map the auth module, then write the map to tmp/auth-map.md' },
      ])]))
      .mockResolvedValueOnce(finalTurn('researched\n```json\n{"status":"done"}\n```')) // web_researcher worker (one turn)
      .mockResolvedValueOnce(finalTurn('done')); // orchestrator final
    await runCodingAgent(makeInput());

    // THREE turns total: the explorer leg was refused (no worker turn for it).
    expect(mockRunModelTurn).toHaveBeenCalledTimes(3);
    const batchResult = (mockRunModelTurn.mock.calls[2][1] as any[]).find((m: any) => m.role === 'tool')!.content as string;
    // The explorer leg carries the refusal with its heading…
    expect(batchResult).toMatch(/### .*\(explorer\)[\s\S]*\[DELEGATION REFUSED — read-only role cannot produce a file artifact \(ticket 68a36304\)\]/);
    // …the web_researcher sibling ran and reported normally.
    expect(batchResult).toMatch(/### .*\(web_researcher\)[\s\S]*researched/);
  });

  test('the delegate schema + orchestrator guidance carry the authoring-time warning (so the mismatch is less likely to be authored at all)', async () => {
    mockRunModelTurn.mockResolvedValueOnce(finalTurn('done'));
    await runCodingAgent(makeInput());
    const tools = mockRunModelTurn.mock.calls[0][2] as any[];
    const delegate = tools.find(t => t.function?.name === 'delegate');
    expect(delegate.function.description).toContain('READ-ONLY ROLES');
    expect(delegate.function.description).toContain('refused at dispatch');
    const parallel = tools.find(t => t.function?.name === 'delegate_parallel');
    expect(parallel.function.description).toContain('read-only');

    // Every read-only role prompt tells the worker what to do if a file-write
    // demand slips past the gate (defense in depth).
    for (const r of ['planner', 'architect', 'explorer', 'web_researcher', 'cross_checker', 'verifier', 'reviewer'] as CodingRole[]) {
      expect(ROLES[r].prompt).toMatch(/NO file-writing tools/);
    }
    for (const r of ['coder', 'editor'] as CodingRole[]) {
      expect(ROLES[r].prompt).not.toMatch(/NO file-writing tools/); // writers keep their original prompts
    }
    expect(orchestratorRoleGuidance()).toMatch(/MATCH THE DELIVERABLE TO THE ROLE'S TOOLSET/);
  });

  test('CHAT LANE EXCLUSION: a chat-mode delegation (task = the user\'s own question) never fires the gate — its re-routes would be broken advice', async () => {
    // Chat delegation tasks embed the USER's question verbatim ("how do I
    // write my output to a file in Python?"). The gate's advertised re-routes
    // (delegate to coder/editor, write the file in the worktree) are
    // unexecutable in chat mode — firing would be a broken recovery path
    // (251e9329). The worker must run normally.
    mockRunModelTurn
      .mockResolvedValueOnce(orchTurn([delegateCall({ role: 'web_researcher', task: 'How do I write my output to a file in Python? Research the idiomatic way.' })]))
      .mockResolvedValueOnce(finalTurn('Use Path.write_text.\n```json\n{"status":"done"}\n```')) // researcher worker
      .mockResolvedValueOnce(finalTurn('done'));
    const input = { ...makeInput(), profile: CHAT_TEST_PROFILE };
    await runCodingAgent(input as AgentRunInput);

    expect(mockRunModelTurn).toHaveBeenCalledTimes(3); // the worker RAN
    const toolMsg = (mockRunModelTurn.mock.calls[2][1] as any[]).find((m: any) => m.role === 'tool');
    expect(String(toolMsg.content)).not.toContain('[DELEGATION REFUSED');
    expect((input.emit as jest.Mock).mock.calls).toEqual(expect.arrayContaining([
      ['subagent_end', expect.objectContaining({ role: 'web_researcher' })],
    ]));
  });

  test('KNOWN TRADE-OFF (documented, self-healing): a code-behavior research brief can trip the gate — the refusal names the re-phrase escape hatch', () => {
    // "find where the app writes its config to disk" is an analysis brief, but
    // the detector cannot grammatically distinguish it from a demand. The
    // refusal message MUST therefore always carry the read-only escape hatch
    // (quoted here) so the orchestrator re-phrases and re-dispatches — one
    // wasted round, no budget, versus the mishap's silent half-delivery.
    const refusal = readOnlyFileWriteRefusal('explorer', 'find where the app writes its config to disk')!;
    expect(refusal).toContain('If the file is only something to READ or analyze (not a deliverable), re-phrase the brief and re-dispatch');
  });
});
