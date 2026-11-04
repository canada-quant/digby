/**
 * PR BASE DRIFT — the pre-flight behind open_pull_request that catches a PR
 * which would silently REVERT work the base branch has already merged
 * (ticket 9d4ef436, defect family pr-diff-base-drift).
 *
 * The incident: two Schooltime PRs inside four hours (#258 "state: correct the
 * diverged=3 clause", −357 lines across 6 files; #261, the same branch name
 * reused) opened green-looking, merge-ready PRs whose computed diff deleted
 * another lane's already-merged work. Both were closed unmerged; nothing in the
 * open_pull_request result flagged either one.
 *
 * ── THREE MECHANISMS WERE IMPLEMENTED AND REFUTED BEFORE THIS ONE. Every
 *    refutation is reproducible in seconds against real git. Do NOT "simplify"
 *    back to any of them. ──
 *
 * (1) "the PR diff is much bigger than the head commit" (the ticket's own
 *     sketch). Every legitimately multi-commit PR has a small head commit and a
 *     large PR diff, so it refuses ordinary work.
 *
 * (2) "the PR deletes lines from a file the base also changed" (file overlap).
 *     Fires on routine co-editing of a hot file — base edits one region, the
 *     lane another. Measured on live branches it refused 10 of 17 honest ones
 *     whose merge was CLEAN.
 *
 * (3) "the branch's blob for a path equals an OLDER blob on the base's history"
 *     (branch/blob identity). Still wrong, because it asks the wrong question:
 *     it judges the BRANCH's tree, not the MERGE's result. A lane that deletes
 *     a line the base just added legitimately restores the file to an older
 *     snapshot — and the branch blob then matches an old base blob — while the
 *     merge keeps base's work intact. Verified live: branch blob 4c60b9074a is
 *     an old main lockfile blob (rule fires) yet the merged tree's lockfile is
 *     b214bb220f, byte-identical to main's tip, and the merge is CLEAN.
 *
 * ── THE SOUND SIGNAL: the MERGED TREE, compared to base ──
 *
 * The claim the refusal makes is "merging this silently reverts base's work".
 * So compute the merge and ask exactly that:
 *
 *   mergedBlob  = the blob for path P in `git merge-tree --write-tree base head`
 *   reverting  ⇔ mergedBlob ≠ baseBlob  AND  mergedBlob ∈ base's own history
 *
 * i.e. after the merge, the file is byte-identical to a snapshot base has
 * already moved past. When base's work survives the merge, mergedBlob EQUALS
 * baseBlob and nothing fires — which is what kills every false-positive class
 * above. When the merge has conflicts git blocks it anyway; we treat that as
 * "not reverting" and leave it to git.
 *
 * DIRECTION OF RISK — every uncertainty (an unreadable blob, a conflicted
 * merge, a path base never tracked, a history lookup that failed) resolves to
 * "not reverting". A false positive REFUSES honest PRs fleet-wide, so this
 * guard may MISS a revert; it must never invent one.
 */

/** One candidate file from the PR's computed diff. */
export interface DriftCandidate {
  path: string;
  /** Lines the PR deletes — the caller probes the biggest first. */
  deletions?: number;
}

/** What the merged-tree probe found for one candidate path. */
export interface BlobProbe {
  /** P's blob in the MERGED tree (null when the path is absent / the merge conflicted). */
  mergedBlob: string | null;
  /** P's blob at the base tip (null when base does not track the path). */
  baseBlob: string | null;
  /** Blob ids P has had ON THE BASE's history (may be capped). */
  historyBlobs: string[];
}

export interface BaseDriftVerdict {
  reverting: boolean;
  /** Paths whose MERGED blob is an older base snapshot — the revert set. */
  revertingFiles: string[];
  /** True when a candidate could not be probed (lookup failed / merge conflicted). */
  incomplete: boolean;
  probedFiles: number;
}

/**
 * Harness STATE paths (`.digby/**`). Excluded from the probe: the state card is
 * legitimately rewritten every firing, and a branch behind on that one file is
 * the normal case rather than an incident.
 */
export const STATE_PATH_RE = /^\.digby\//;

/**
 * Decide whether merging HEAD would leave any path sitting on a snapshot the
 * base has already moved past.
 *
 * @param candidates the PR-diff files the caller chose to probe
 * @param probes     one probe result per candidate path (null = unprobed)
 */
export function detectBaseDrift(
  candidates: DriftCandidate[] | null | undefined,
  probes: Map<string, BlobProbe | null> | null | undefined,
): BaseDriftVerdict {
  const rows = (Array.isArray(candidates) ? candidates : []).filter(
    (c): c is DriftCandidate => !!c && typeof c.path === 'string' && c.path.length > 0,
  );
  const revertingFiles: string[] = [];
  let incomplete = false;
  let probed = 0;
  for (const c of rows) {
    const p = probes instanceof Map ? probes.get(c.path) : null;
    if (!p) { incomplete = true; continue; }
    probed += 1;
    const { mergedBlob, baseBlob, historyBlobs } = p;
    // Nothing to judge: the merge removed the path, base never tracked it, or
    // the merge conflicted (git owns that outcome).
    if (!mergedBlob || !baseBlob) continue;
    // Base's work SURVIVES the merge — the single most important case, and the
    // one every earlier mechanism got wrong.
    if (mergedBlob === baseBlob) continue;
    // The revert: after merging, the file is an older base snapshot.
    if (Array.isArray(historyBlobs) && historyBlobs.includes(mergedBlob)) revertingFiles.push(c.path);
  }
  return { reverting: revertingFiles.length > 0, revertingFiles: revertingFiles.sort(), incomplete, probedFiles: probed };
}

/** Parse `git log --raw --no-abbrev --format=` output into that path's blob ids. */
export function historyBlobsFromRaw(raw: string | null | undefined): string[] {
  const out: string[] = [];
  for (const line of String(raw ?? '').split('\n')) {
    // ":100644 100644 <oldSha> <newSha> M\tpath"; a create uses the null object.
    const m = line.match(/^:\d{6} \d{6} ([0-9a-f]{7,40}) ([0-9a-f]{7,40}) /);
    if (!m) continue;
    for (const sha of [m[1], m[2]]) if (!/^0+$/.test(sha)) out.push(sha);
  }
  return [...new Set(out)].sort();
}

/** A git runner: `(args, timeoutMs) => { stdout }` — injected so this leaf stays import-free. */
export type GitRunner = (args: string[], timeoutMs: number) => Promise<{ stdout: string }>;

/**
 * Probe ONE path: compute the merge of base and head, then read that path's
 * blob from the merged tree and compare it to the base tip + the base's history.
 * Purely local git. Returns null when anything is unresolvable (fail open).
 */
export async function probeBaseBlobs(
  run: GitRunner, baseRef: string, headRef: string, path: string,
): Promise<BlobProbe | null> {
  const revParse = async (ref: string): Promise<string | null> => {
    try {
      const { stdout } = await run(['rev-parse', '-q', '--verify', ref], 10_000);
      const sha = String(stdout ?? '').trim();
      return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
    } catch { return null; }
  };
  const baseBlob = await revParse(`${baseRef}:${path}`);
  if (!baseBlob) return null;            // base never tracked the path: nothing to revert
  // The merge itself. `--write-tree` exits non-zero on CONFLICT — git blocks
  // such a merge anyway, so a conflict is "not reverting" (fail open).
  let mergedTree = '';
  try {
    const { stdout } = await run(['merge-tree', '--write-tree', baseRef, headRef], 30_000);
    mergedTree = String(stdout ?? '').split('\n')[0].trim();
  } catch { return null; }
  if (!/^[0-9a-f]{40}$/.test(mergedTree)) return null;
  const mergedBlob = await revParse(`${mergedTree}:${path}`);
  if (!mergedBlob) return null;
  // Base's work survived: skip the (expensive) history read entirely.
  if (mergedBlob === baseBlob) return { mergedBlob, baseBlob, historyBlobs: [baseBlob] };
  let raw = '';
  try {
    // `--no-abbrev` is REQUIRED: git log --raw abbreviates object names by
    // default, and a 10-char id can never match rev-parse's 40-char one — the
    // probe would then silently read as "not reverting" forever.
    const { stdout } = await run(['log', '--raw', '--no-abbrev', '--no-renames', '--format=', baseRef, '--', path], 20_000);
    raw = String(stdout ?? '');
  } catch { return null; }
  return { mergedBlob, baseBlob, historyBlobs: historyBlobsFromRaw(raw) };
}

const filesList = (files: string[], cap = 4): string => {
  const head = files.slice(0, cap).join(', ');
  return files.length > cap ? `${head} (+${files.length - cap} more)` : head;
};

/** The one-line diagnosis both the refusal and the override notice carry. */
export function renderBaseDriftDiagnosis(v: BaseDriftVerdict, base: string): string {
  return `merging this branch would leave ${v.revertingFiles.length} file${v.revertingFiles.length === 1 ? '' : 's'} `
    + `(${filesList(v.revertingFiles)}) on a snapshot ${base} has already moved past — `
    + `the branch was built on a stale base and merging it would silently REVERT that merged work.`;
}

/** The pre-flight refusal. Names the drift, the base, the remedy and the override. */
export function renderBaseDriftRefusal(v: BaseDriftVerdict, base: string): string {
  return `PR REFUSED (base drift): ${renderBaseDriftDiagnosis(v, base)} `
    + `The branch is pushed; nothing was opened. `
    + `Remedy: rebase onto the current base (git fetch origin && git rebase origin/${base}), resolve any `
    + `conflicts, re-run verify, then open again. If the reversion is genuinely intended, re-call `
    + `open_pull_request with allowBaseDrift:true.`;
}

/** The override notice — the lane proceeded knowingly. */
export function renderBaseDriftNotice(v: BaseDriftVerdict, base: string): string {
  return `[BASE DRIFT OVERRIDE] allowBaseDrift:true — ${renderBaseDriftDiagnosis(v, base)} `
    + `The PR was opened anyway; confirm with merge_pull_request only if that reversion is intended.`;
}