/**
 * Resource platform tools (remediation P7 S1b) — registration pins + the
 * machine-evidence gates:
 *   observe_resource  — machine calls need ≥1 OK receipt THIS run;
 *   verify_durable    — machine calls ALSO need evidence naming the uri.
 * Behavior of the service half lives in resources.service.test.ts.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// resources.service boundary — the executors under test only orchestrate.
const mockRegisterWatchedResource = jest.fn(async (_u: string, input: any) => ({
  id: 'wr-1', projectId: input.projectId ?? null, label: input.label, usdPerHour: input.usdPerHour ?? null,
  reservationEndsAt: null, maxUnobservedMinutes: input.maxUnobservedMinutes ?? 240,
  lastObservedAt: new Date().toISOString(), notes: null, createdAt: new Date().toISOString(),
}));
const mockObserveResource = jest.fn(async (_u: string, ref: string) => ({
  id: ref, projectId: null, label: 'gpu box', usdPerHour: null, reservationEndsAt: null,
  maxUnobservedMinutes: 240, lastObservedAt: new Date().toISOString(), notes: null, createdAt: new Date().toISOString(),
}));
const mockRegisterArtifact = jest.fn(async (_u: string, input: any) => ({
  id: 'ta-1', projectId: input.projectId ?? null, kind: input.kind, label: input.label, uri: input.uri,
  sha: null, bytes: null, durableVerifiedAt: null, runId: input.runId ?? null, createdAt: new Date().toISOString(),
}));
const mockResolveArtifact = jest.fn(async (..._a: any[]): Promise<any> => ({ id: 'ta-1', uri: 's3://bucket/run-3/ckpt-epoch3.pt' }));
const mockVerifyArtifactDurable = jest.fn(async (_u: string, id: string) => ({
  id, projectId: null, kind: 'checkpoint', label: 'ckpt', uri: 's3://bucket/run-3/ckpt-epoch3.pt',
  sha: null, bytes: null, durableVerifiedAt: new Date().toISOString(), runId: null, createdAt: new Date().toISOString(),
}));
const mockReleaseWatchedResource = jest.fn(async (...a: any[]): Promise<any> => (a[1] === 'nope' ? null : {
  id: a[1], projectId: null, label: 'gpu box', usdPerHour: null, reservationEndsAt: null,
  maxUnobservedMinutes: 240, lastObservedAt: new Date().toISOString(), notes: null, createdAt: new Date().toISOString(),
}));
const mockNoWatchedResourceMessage = jest.fn(async (...a: any[]): Promise<string> =>
  `No watched resource "${a[1]}" — register_watched_resource first, or release one that exists: b18d1c00 "gpu box" (full list: get_account_overview → watchedResources).`);
jest.mock('./resources.service', () => ({
  __esModule: true,
  registerWatchedResource: (...a: any[]) => mockRegisterWatchedResource(...(a as [any, any])),
  observeResource: (...a: any[]) => mockObserveResource(...(a as [any, any])),
  registerArtifact: (...a: any[]) => mockRegisterArtifact(...(a as [any, any])),
  resolveArtifact: (...a: any[]) => mockResolveArtifact(...a),
  verifyArtifactDurable: (...a: any[]) => mockVerifyArtifactDurable(...(a as [any, any])),
  releaseWatchedResource: (...a: any[]) => mockReleaseWatchedResource(...a),
  noWatchedResourceMessage: (...a: any[]) => mockNoWatchedResourceMessage(...a),
}));

const mockGetRunReceipts = jest.fn(async (..._a: any[]): Promise<any[]> => []);
jest.mock('../coding/run-receipts.service', () => ({
  __esModule: true,
  getRunReceipts: (...a: any[]) => mockGetRunReceipts(...a),
}));

const mockAgentRunFindFirst = jest.fn(async (..._a: any[]): Promise<any> => null);
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: { agentRun: { findFirst: (...a: any[]) => mockAgentRunFindFirst(...a) } },
}));

import { RESOURCE_TOOL_SCHEMA, isResourceTool, executeResourceTool, evidenceNamesUri } from './resource-tools';
import { PLATFORM_MUTATING_TOOLS, PLATFORM_READ_TOOLS } from './platform-tool-names';

const NAMES = ['register_watched_resource', 'observe_resource', 'register_artifact', 'verify_durable', 'release_watched_resource'];

function makeCtx(overrides: Record<string, any> = {}): any {
  return {
    worktree: '/wt', sessionId: 'sess-1', userId: 'u1', projectId: 'chat', permissionMode: 'auto',
    emit: () => {}, userTurnAt: new Date(), runId: 'run-1',
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetRunReceipts.mockResolvedValue([]);
  mockAgentRunFindFirst.mockResolvedValue(null);
  mockResolveArtifact.mockResolvedValue({ id: 'ta-1', uri: 's3://bucket/run-3/ckpt-epoch3.pt' });
});

describe('registration pins', () => {
  it('the 5 tools are in the schema, isResourceTool, and PLATFORM_MUTATING_TOOLS (never read-gated)', () => {
    expect(RESOURCE_TOOL_SCHEMA.map((t) => t.function.name).sort()).toEqual([...NAMES].sort());
    for (const n of NAMES) {
      expect(isResourceTool(n)).toBe(true);
      expect((PLATFORM_MUTATING_TOOLS as readonly string[]).includes(n)).toBe(true);
      expect((PLATFORM_READ_TOOLS as readonly string[]).includes(n)).toBe(false);
    }
    expect(isResourceTool('remember_fact')).toBe(false);
  });
});

describe('anonymous refusal', () => {
  it('every tool refuses the anonymous sentinel', async () => {
    for (const n of NAMES) {
      const res = JSON.parse(await executeResourceTool(makeCtx({ userId: 'anonymous' }), n, {}));
      expect(res).toMatchObject({ ok: false, reason: 'anonymous' });
    }
  });
});

describe('register_watched_resource / register_artifact', () => {
  it('registers with the ctx project when real, args.projectId override wins', async () => {
    await executeResourceTool(makeCtx({ projectId: 'p1' }), 'register_watched_resource', { label: 'gpu box' });
    expect(mockRegisterWatchedResource).toHaveBeenCalledWith('u1', expect.objectContaining({ label: 'gpu box', projectId: 'p1' }));
    await executeResourceTool(makeCtx({ projectId: 'chat' }), 'register_watched_resource', { label: 'x', projectId: 'p2' });
    expect(mockRegisterWatchedResource).toHaveBeenLastCalledWith('u1', expect.objectContaining({ projectId: 'p2' }));
    // 'chat' sentinel without an override → null (no fake project ref).
    await executeResourceTool(makeCtx({ projectId: 'chat' }), 'register_watched_resource', { label: 'y' });
    expect(mockRegisterWatchedResource).toHaveBeenLastCalledWith('u1', expect.objectContaining({ projectId: null }));
  });

  it('register_artifact stamps the coding run id and nudges toward verify_durable', async () => {
    const raw = await executeResourceTool(makeCtx({ runId: 'run-9' }), 'register_artifact', { kind: 'checkpoint', label: 'e3', uri: 's3://b/e3' });
    expect(mockRegisterArtifact).toHaveBeenCalledWith('u1', expect.objectContaining({ runId: 'run-9' }));
    expect(JSON.parse(raw).message).toContain('verify_durable');
  });

  it('service validation errors return an honest ok:false envelope (never a throw)', async () => {
    mockRegisterArtifact.mockRejectedValue(new Error('kind must be one of: checkpoint | dataset | eval | model | other'));
    const res = JSON.parse(await executeResourceTool(makeCtx(), 'register_artifact', { kind: 'weights', label: 'x', uri: 'u' }));
    expect(res).toMatchObject({ ok: false, reason: 'error' });
    expect(res.message).toContain('kind must be one of');
  });
});

describe('observe_resource — the machine receipt gate', () => {
  it('user-turn calls stamp freely', async () => {
    const res = JSON.parse(await executeResourceTool(makeCtx(), 'observe_resource', { id: 'wr-1' }));
    expect(res.ok).toBe(true);
    expect(mockObserveResource).toHaveBeenCalled();
    expect(mockGetRunReceipts).not.toHaveBeenCalled();
  });

  it('machine calls with NO ok receipt this run are refused (no_receipt)', async () => {
    // Wild instance (ticket 1c1a6699, 2026-09-23, prod Fleet Supervisor lane
    // c0e22e36): THREE observe_resource emissions in one run, each with zero
    // prior OK receipts — this gate refused all three with the instructive
    // no_receipt envelope, and the failure-side breaker tripped at 17:25:02Z
    // (shape 'failure', intended 'update_supervisor_state'). Containment
    // worked: nothing was falsely observed. MODEL-SIDE — the lane narrated
    // observing without ever running a real check first.
    mockGetRunReceipts.mockResolvedValue([{ tool: 'run_command', ok: false, ids: {} }]);
    const res = JSON.parse(await executeResourceTool(makeCtx({ userTurnAt: undefined }), 'observe_resource', { id: 'wr-1' }));
    expect(res).toMatchObject({ ok: false, reason: 'no_receipt' });
    expect(mockObserveResource).not.toHaveBeenCalled();
  });

  it('machine calls WITH an ok receipt stamp', async () => {
    mockGetRunReceipts.mockResolvedValue([{ tool: 'run_command', ok: true, ids: {} }]);
    const res = JSON.parse(await executeResourceTool(makeCtx({ userTurnAt: undefined }), 'observe_resource', { id: 'wr-1' }));
    expect(res.ok).toBe(true);
  });

  it('chat-surface machine calls (no ctx.runId) resolve the live run via agent_runs', async () => {
    mockAgentRunFindFirst.mockResolvedValue({ id: 'run-live' });
    mockGetRunReceipts.mockResolvedValue([{ tool: 'search_engine', ok: true, ids: {} }]);
    const res = JSON.parse(await executeResourceTool(makeCtx({ userTurnAt: undefined, runId: undefined }), 'observe_resource', { id: 'wr-1' }));
    expect(res.ok).toBe(true);
    expect(mockGetRunReceipts).toHaveBeenCalledWith('run-live');
  });
});

describe('ticket 119df67e — chat-surface machine runs see THIS run\'s in-process receipts', () => {
  // REPLAY of the wild instance (mishap 119df67e, 2026-10-08 18:48Z, prod
  // Schooltime Supervisor lane 41bd202a · sweep): a chat-surface machine run
  // (no userTurnAt, no ctx.runId — and chat runs create NO agent_runs row,
  // verified live: chat 41bd202a and fleet-supervisor chat c0e22e36 both have
  // runs:[] with every persisted receipt runId:null keyed by chatId) ran REAL
  // checks then called observe_resource — ok list_chats 18:48:24Z, ok
  // get_chat_status 18:48:38Z, the trip at 18:48:54Z — and the gate refused
  // all THREE with no_receipt because its read path is runId-keyed and
  // structurally blind on that surface. THE DEFECT: receipt attribution, not
  // the model. The fix threads the agent loop's in-process receipt collector
  // onto ctx (agent.ts ctx build) and currentRunReceipts() consults it FIRST.
  it('DETECTOR-RECALL REPLAY — the prior true positives STILL fire: machine run, genuinely ZERO ok receipts (empty collector, no agent_runs row) is refused', async () => {
    // The 1c1a6699 convicting class, replayed through the NEW first source:
    // collector present but EMPTY + no runId + no agent_runs row → refuse.
    const res = JSON.parse(await executeResourceTool(
      makeCtx({ userTurnAt: undefined, runId: undefined, receipts: [] }),
      'observe_resource', { id: 'wr-1' },
    ));
    expect(res).toMatchObject({ ok: false, reason: 'no_receipt' });
    expect(mockObserveResource).not.toHaveBeenCalled();
  });

  it('DETECTOR-RECALL REPLAY — collector with ONLY failed receipts (no ok) is refused', async () => {
    const res = JSON.parse(await executeResourceTool(
      makeCtx({ userTurnAt: undefined, runId: undefined, receipts: [{ tool: 'run_command', ok: false, ids: {} }] }),
      'observe_resource', { id: 'wr-1' },
    ));
    expect(res).toMatchObject({ ok: false, reason: 'no_receipt' });
    expect(mockObserveResource).not.toHaveBeenCalled();
  });

  it('DETECTOR-RECALL REPLAY — the original 1c1a6699 pin (DB path only, no ctx.receipts) still refuses', async () => {
    mockGetRunReceipts.mockResolvedValue([{ tool: 'run_command', ok: false, ids: {} }]);
    const res = JSON.parse(await executeResourceTool(
      makeCtx({ userTurnAt: undefined, runId: undefined }), 'observe_resource', { id: 'wr-1' },
    ));
    expect(res).toMatchObject({ ok: false, reason: 'no_receipt' });
  });

  it('replay: chat-surface machine run WITH ok receipts in the in-process collector stamps (the 119df67e failure mode now passes)', async () => {
    // The exact failing shape: no runId, no agent_runs row, but the run's
    // collector holds the ok receipts of the checks it really ran.
    mockAgentRunFindFirst.mockResolvedValue(null); // chat surface — no agent_runs row
    const res = JSON.parse(await executeResourceTool(
      makeCtx({
        userTurnAt: undefined, runId: undefined,
        receipts: [
          { tool: 'get_chat_messages', ok: true, ids: {} },   // the 18:26:45Z recorder-lane read
          { tool: 'list_chats', ok: true, ids: {} },          // the 18:48:24Z check
          { tool: 'get_chat_status', ok: true, ids: {} },     // the 18:48:38Z check
        ],
      }),
      'observe_resource', { id: 'wr-1', note: 'SSH_OK 18:25Z' },
    ));
    expect(res.ok).toBe(true);
    expect(mockObserveResource).toHaveBeenCalledWith('u1', 'wr-1', 'SSH_OK 18:25Z');
    // No DB fallback needed — the collector answered.
    expect(mockGetRunReceipts).not.toHaveBeenCalled();
  });

  it('replay: the same gap for verify_durable — ok collector receipt satisfies the no_receipt half (evidence still required)', async () => {
    // verify_durable keeps BOTH gates: the evidence text must still name the uri.
    const withoutEvidence = JSON.parse(await executeResourceTool(
      makeCtx({ userTurnAt: undefined, runId: undefined, receipts: [{ tool: 'run_command', ok: true, ids: {} }] }),
      'verify_durable', { id: 'ta-1', evidence: 'I checked and it is definitely there' },
    ));
    expect(withoutEvidence).toMatchObject({ ok: false, reason: 'evidence_required' });

    const withEvidence = JSON.parse(await executeResourceTool(
      makeCtx({ userTurnAt: undefined, runId: undefined, receipts: [{ tool: 'run_command', ok: true, ids: {} }] }),
      'verify_durable', { id: 'ta-1', evidence: `aws s3 ls → s3://bucket/run-3/ckpt-epoch3.pt 1.2 GiB` },
    ));
    expect(withEvidence.ok).toBe(true);
  });
});

describe('verify_durable — the machine evidence gate', () => {
  const URI = 's3://bucket/run-3/ckpt-epoch3.pt';

  it('evidenceNamesUri: full uri or a ≥4-char basename', () => {
    expect(evidenceNamesUri(`2026-09-09 12:00 1.2G ${URI}`, URI)).toBe(true);
    expect(evidenceNamesUri('-rw-r--r-- 1 u u 1.2G ckpt-epoch3.pt', URI)).toBe(true);
    expect(evidenceNamesUri('200 OK', URI)).toBe(false);
    expect(evidenceNamesUri('', URI)).toBe(false);
  });

  it('evidenceNamesUri: ticket 748c9903 — compound/annotated uris are decomposed, not matched as one blob (DETECTOR-RECALL REPLAY)', () => {
    // The exact shape from the ticket: a registered uri naming several
    // durable locations "primary (+ secondary)". Under the old matcher its
    // basename parsed to ")" (1 char < 4) — no truthful ls/stat line could
    // ever match, so the artifact was un-stampable by construction.
    const COMPOUND = 'amd-2:/home/ubuntu/deckpose-backups/optcg_20261019.dump (+ amd-1:/mnt/expansion/deckpose/backups/)';

    // The three real evidence shapes the failing lane quoted (truthful stat /
    // ls -la lines naming the primary component) — all MUST now verify.
    expect(evidenceNamesUri('amd-2 stat line observed this run (18:39Z): "amd-2:/home/ubuntu/deckpose-backups/optcg_20261019.dump 2441518 bytes"', COMPOUND)).toBe(true);
    expect(evidenceNamesUri('amd-2 ls -la line observed this run 18:39Z: "-rwxr-xr-x 1 ubuntu ubuntu 2441518 Oct 19 11:39 optcg_20261019.dump" in /home/ubuntu/deckpose-backups/', COMPOUND)).toBe(true);
    expect(evidenceNamesUri('stat on amd-2 via tailscale ssh (18:39Z this run): "2441518 bytes /home/ubuntu/deckpose-backups/optcg_20261019.dump"', COMPOUND)).toBe(true);
    // Evidence naming the SECONDARY component also verifies (it is part of
    // the registered uri) — isolated: this line names ONLY the secondary.
    expect(evidenceNamesUri('ls /mnt/expansion/deckpose/backups/ total 0', COMPOUND)).toBe(true);
    // ...but a DIFFERENT secondary directory does not.
    expect(evidenceNamesUri('ls /mnt/expansion/other/backups/ total 4', COMPOUND)).toBe(false);
    // ...and a bare generic word ("backups") inside a larger name never counts.
    expect(evidenceNamesUri('deckpose-backups 2441518', COMPOUND)).toBe(false);
    // Short/generic annotation components ("(+ok)") are NOT evidence:
    // "bytes ok" must not verify an artifact whose uri carries "(+ok)".
    expect(evidenceNamesUri('bytes ok', 's3://bucket/x.pt (+ok)')).toBe(false);
    expect(evidenceNamesUri('noted, all good', 's3://bucket/model.pt (+note)')).toBe(false);
    // Whole-compound quote still verifies.
    expect(evidenceNamesUri(`copied: ${COMPOUND}`, COMPOUND)).toBe(true);

    // DETECTOR-RECALL REPLAY — the guard's PRIOR true positives must STILL
    // fire: vague attestations and unrelated paths refuse.
    expect(evidenceNamesUri('I checked and it is definitely there', COMPOUND)).toBe(false);
    expect(evidenceNamesUri('200 OK', COMPOUND)).toBe(false);
    expect(evidenceNamesUri('', COMPOUND)).toBe(false);
    expect(evidenceNamesUri('aws s3 ls → s3://other-bucket/unrelated.pth 1.2 GiB', COMPOUND)).toBe(false);
    expect(evidenceNamesUri('/home/ubuntu/some-other-file.txt 12 bytes', COMPOUND)).toBe(false);
    // A DIFFERENT artifact's uri in the same primary box does not count:
    // the sibling's own basename is not a component of THIS uri.
    expect(evidenceNamesUri('amd-2:/home/ubuntu/deckpose-backups/optcg_20261018.dump 2441518 bytes', COMPOUND)).toBe(false);
    // Token-boundary tightening pinned: a basename glued into a LARGER name
    // is a different file — refuses now (passed pre-fix; reviewer-verified).
    expect(evidenceNamesUri('backup-ckpt-epoch3.pt 1.2G', URI)).toBe(false);
    expect(evidenceNamesUri('ckpt-epoch3.pt_2441518', URI)).toBe(false);
    // Dot-adjacent quotes still pass (sentence period, .bak copies).
    expect(evidenceNamesUri('uploaded ckpt-epoch3.pt. total 1.2G', URI)).toBe(true);
    // A NON-compound uri containing parens is not corrupted by the split.
    expect(evidenceNamesUri('stat s3://bucket/checkpoint(1) 1.2G', 's3://bucket/checkpoint(1)')).toBe(true);
  });

  it('verify_durable machine gate: compound-uri artifact with truthful component evidence NOW stamps (ticket 748c9903)', async () => {
    mockGetRunReceipts.mockResolvedValue([{ tool: 'run_command', ok: true, ids: {} }]);
    mockResolveArtifact.mockResolvedValue({ id: 'ta-2', label: 'nightly pg dump', uri: 'amd-2:/home/ubuntu/deckpose-backups/optcg_20261019.dump (+ amd-1:/mnt/expansion/deckpose/backups/)' });
    const res = JSON.parse(await executeResourceTool(
      makeCtx({ userTurnAt: undefined }), 'verify_durable',
      { id: 'ta-2', evidence: 'amd-2 stat line observed this run: "amd-2:/home/ubuntu/deckpose-backups/optcg_20261019.dump 2441518 bytes"' },
    ));
    expect(res.ok).toBe(true);
    expect(mockVerifyArtifactDurable).toHaveBeenCalledWith('u1', 'ta-2');
    // And the vague attestation still refuses on the same compound uri.
    mockVerifyArtifactDurable.mockClear();
    const refused = JSON.parse(await executeResourceTool(
      makeCtx({ userTurnAt: undefined }), 'verify_durable',
      { id: 'ta-2', evidence: 'I checked and it is definitely there' },
    ));
    expect(refused).toMatchObject({ ok: false, reason: 'evidence_required' });
    expect(mockVerifyArtifactDurable).not.toHaveBeenCalled();
  });

  it('machine calls without evidence naming the REAL uri are refused', async () => {
    mockGetRunReceipts.mockResolvedValue([{ tool: 'run_command', ok: true, ids: {} }]);
    const res = JSON.parse(await executeResourceTool(
      makeCtx({ userTurnAt: undefined }), 'verify_durable', { id: 'ta-1', evidence: 'I checked and it is definitely there' },
    ));
    expect(res).toMatchObject({ ok: false, reason: 'evidence_required' });
    expect(mockVerifyArtifactDurable).not.toHaveBeenCalled();
  });

  it('machine calls with uri-naming evidence but NO receipt are refused (no_receipt)', async () => {
    const res = JSON.parse(await executeResourceTool(
      makeCtx({ userTurnAt: undefined }), 'verify_durable', { id: 'ta-1', evidence: `aws s3 ls → ${URI} 1.2 GiB` },
    ));
    expect(res).toMatchObject({ ok: false, reason: 'no_receipt' });
  });

  it('machine calls with BOTH stamp durable', async () => {
    mockGetRunReceipts.mockResolvedValue([{ tool: 'run_command', ok: true, ids: {} }]);
    const res = JSON.parse(await executeResourceTool(
      makeCtx({ userTurnAt: undefined }), 'verify_durable', { id: 'ta-1', evidence: `aws s3 ls → ${URI} 1.2 GiB` },
    ));
    expect(res.ok).toBe(true);
    expect(mockVerifyArtifactDurable).toHaveBeenCalledWith('u1', 'ta-1');
  });

  it('user-turn calls verify without the gates; unknown artifacts refuse honestly', async () => {
    const ok = JSON.parse(await executeResourceTool(makeCtx(), 'verify_durable', { id: 'ta-1' }));
    expect(ok.ok).toBe(true);
    mockResolveArtifact.mockResolvedValue(null);
    const res = JSON.parse(await executeResourceTool(makeCtx(), 'verify_durable', { id: 'nope' }));
    expect(res).toMatchObject({ ok: false, reason: 'not_found' });
  });
});

describe('release_watched_resource (ticket a0a199f8)', () => {
  it('MACHINE calls release UNGATED (no receipt gate) — unattended cleanup lanes must reach it', async () => {
    // No ok receipts this run on purpose: observe_resource would refuse here.
    const res = JSON.parse(await executeResourceTool(
      makeCtx({ userTurnAt: undefined }), 'release_watched_resource', { id: 'b18d1c00-dead-beef', reason: 'reservation ended' },
    ));
    expect(res).toMatchObject({ ok: true, tool: 'release_watched_resource' });
    expect(mockReleaseWatchedResource).toHaveBeenCalledWith('u1', 'b18d1c00-dead-beef', 'reservation ended');
    expect(res.message).toContain('never alarm');
    expect(mockGetRunReceipts).not.toHaveBeenCalled(); // genuinely ungated
  });

  it('unknown ref ⇒ ok:false not_found via the 251e9329 rich refusal (names what IS registered)', async () => {
    const res = JSON.parse(await executeResourceTool(makeCtx(), 'release_watched_resource', { id: 'nope' }));
    expect(res).toMatchObject({ ok: false, reason: 'not_found' });
    expect(mockNoWatchedResourceMessage).toHaveBeenCalledWith('u1', 'nope', 'release');
    expect(res.message).toContain('get_account_overview');
  });
});
