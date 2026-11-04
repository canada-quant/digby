import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
  EditCheckpoints, renderCheckpointIndex, renderRewindResult,
  EDIT_CHECKPOINT_MAX_FILE_BYTES, EDIT_CHECKPOINT_MAX_RECORDS,
} from './edit-checkpoints';

let wt: string; let store: string;
beforeEach(async () => {
  wt = await fs.mkdtemp(path.join(os.tmpdir(), 'ckpt-wt-'));
  store = await fs.mkdtemp(path.join(os.tmpdir(), 'ckpt-store-'));
});
afterEach(async () => {
  await fs.rm(wt, { recursive: true, force: true });
  await fs.rm(store, { recursive: true, force: true });
});

const abs = (rel: string) => path.join(wt, rel);
const write = (rel: string, content: string) => fs.mkdir(path.dirname(abs(rel)), { recursive: true }).then(() => fs.writeFile(abs(rel), content, 'utf8'));
const read = (rel: string) => fs.readFile(abs(rel), 'utf8');

describe('EditCheckpoints', () => {
  it('records prior content (or absence) per step; rewinding restores newest-first so the earliest snapshot wins, removes created files, drops consumed records', async () => {
    const ck = new EditCheckpoints({ sessionId: 's1', runId: 'r1', baseDir: store });
    await write('a.ts', 'v0');
    ck.setStep(1); await ck.beforeWrite('./a.ts', abs('a.ts')); await write('a.ts', 'v1');
    ck.setStep(2); await ck.beforeWrite('b.ts', abs('b.ts')); await write('b.ts', 'new');
    ck.setStep(3); await ck.beforeWrite('a.ts', abs('a.ts'), 'v1'); await write('a.ts', 'v3');
    ck.setStep(3); await ck.beforeWrite('a.ts', abs('a.ts')); await write('a.ts', 'v3b');
    expect(ck.list()).toEqual([{ step: 1, files: ['a.ts'] }, { step: 2, files: ['b.ts'] }, { step: 3, files: ['a.ts'] }]);
    expect(ck.recordCount).toBe(4);

    const r = await ck.rewindTo(2);
    expect(r).toMatchObject({ step: 2, restored: ['a.ts'], deleted: ['b.ts'], skipped: [], nothing: false });
    expect(await read('a.ts')).toBe('v1'); // the step-3 snapshots unwind to the content before step 3
    await expect(fs.stat(abs('b.ts'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(ck.list()).toEqual([{ step: 1, files: ['a.ts'] }]);

    const r1 = await ck.rewindTo(0);
    expect(r1.restored).toEqual(['a.ts']);
    expect(await read('a.ts')).toBe('v0');
    expect(ck.list()).toEqual([]);
    expect((await ck.rewindTo(0)).nothing).toBe(true);
    await ck.dispose();
  });

  it('a file over the size bound is indexed but not restorable (skipped); an unreadable-for-another-reason file records nothing; the record cap stops recording', async () => {
    const ck = new EditCheckpoints({ sessionId: 's1', runId: 'r1', baseDir: store });
    ck.setStep(1);
    await ck.beforeWrite('big.bin', abs('big.bin'), 'x'.repeat(EDIT_CHECKPOINT_MAX_FILE_BYTES + 1));
    await write('big.bin', 'replaced');
    const r = await ck.rewindTo(1);
    expect(r.skipped).toEqual(['big.bin']);
    expect(await read('big.bin')).toBe('replaced');
    // A directory path fails readFile with EISDIR → no record (we do not pretend it was absent).
    await fs.mkdir(abs('dir'));
    await ck.beforeWrite('dir', abs('dir'));
    expect(ck.recordCount).toBe(0);
    // Cap: recording stops, the index says so.
    for (let i = 0; i < EDIT_CHECKPOINT_MAX_RECORDS + 5; i += 1) await ck.beforeWrite(`f${i}.ts`, abs(`f${i}.ts`), `c${i}`);
    expect(ck.recordCount).toBe(EDIT_CHECKPOINT_MAX_RECORDS);
    expect(ck.isFull).toBe(true);
    expect(renderCheckpointIndex(ck.list(), 1, ck.isFull)).toMatch(/recording stopped at 400 snapshots/);
    await ck.dispose();
  });

  it('renders the index and the receipt in plain words', () => {
    expect(renderCheckpointIndex([], 4, false)).toMatch(/No checkpoints yet in this run \(current step 4\)/);
    const idx = renderCheckpointIndex([{ step: 2, files: Array.from({ length: 10 }, (_, i) => `f${i}.ts`) }], 5, false);
    expect(idx).toMatch(/step 2: f0.ts, .*f7.ts \(\+2 more\)/);
    expect(renderRewindResult({ step: 3, restored: ['a.ts'], deleted: ['b.ts'], skipped: [], nothing: false })).toMatch(/Rewound to before step 3\. Restored: a.ts\. Removed \(created by this run\): b.ts\. Only your own file edits were undone/);
    expect(renderRewindResult({ step: 9, restored: [], deleted: [], skipped: [], nothing: true })).toMatch(/Nothing to rewind/);
  });
});
