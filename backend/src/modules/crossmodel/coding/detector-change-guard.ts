/**
 * DETECTOR CHANGES need a recall replay (audit 2026-10-08 W5-3, goals.md F5).
 *
 * In ~44 h, ticket lanes merged + deployed five RELAXATIONS of the framework's
 * own detectors — three action-verifier exemption tiers (81b7f636, 81a87c68,
 * 5bffa38c), a hand-back detector evidence gate (a3a4613e) and a nightly-suite
 * FAIL→WARN downgrade (4ece357b) — each justified by one incident and reviewed
 * for merge SAFETY only. Nothing measured what each new tier lets through, so
 * the guards' recall can erode by ratchet: the lane rewarded for closing the
 * ticket grades the detector.
 *
 * The rule: a PR whose diff changes a framework detector's SOURCE (the files in
 * DETECTOR_SOURCES) is a DETECTOR CHANGE, and it must ship a RECALL REPLAY — a
 * test (any *.test.ts / *.spec.ts / test_*.py / *_test.py file, or the nightly
 * suite's own in-file self-test) whose ADDED lines carry the marker
 * `DETECTOR-RECALL REPLAY` and replay the detector's prior true positives,
 * asserting they still fire. Without one:
 *  - a TICKET LANE's self-merge is REFUSED (merge gate 'detector_recall'): the
 *    lane adds the replay, or stops with the ticket in_progress and an adminNote
 *    "needs owner review: detector relaxation" (the ticket-lane charter says
 *    so). DETECTOR_CHANGE_GUARD_OBSERVE_ONLY=1 makes it a note there too.
 *  - every other session gets an OBSERVE-ONLY note on the merge receipt.
 * Every detected change records one guard_strike row (seam 'detector_change').
 * Kill switch DETECTOR_CHANGE_GUARD_DISABLED=1 (no check, no note — as before).
 *
 * LEAF: pure helpers only — self-merge.service does the I/O.
 */

const flag = (env: NodeJS.ProcessEnv, name: string): boolean => /^(1|true|on|yes)$/i.test(String(env[name] ?? '').trim());

export function detectorChangeGuardDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return flag(env, 'DETECTOR_CHANGE_GUARD_DISABLED');
}
export function detectorChangeGuardObserveOnly(env: NodeJS.ProcessEnv = process.env): boolean {
  return flag(env, 'DETECTOR_CHANGE_GUARD_OBSERVE_ONLY');
}

/** The framework detectors whose source changes need a recall replay. */
export const DETECTOR_SOURCES: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: 'action-verifier', re: /(^|\/)platform\/action-verifier\.ts$/ },
  { name: 'evidence-guard', re: /(^|\/)coding\/run-evidence-guard\.ts$/ },
  { name: 'handback-detector', re: /(^|\/)chat-agent\/handback-detector\.ts$/ },
  { name: 'nightly-suite', re: /(^|\/)scripts\/e2e\/query-suite\.py$/ },
];

/** The marker a recall-replay test carries (case-insensitive; '-', '_' or ' ' between the words). */
export const DETECTOR_RECALL_MARKER = 'DETECTOR-RECALL REPLAY';
export const DETECTOR_RECALL_MARKER_RE = /DETECTOR[-_ ]RECALL[-_ ]REPLAY/i;

const TEST_FILE_RE = /(\.test\.[cm]?[jt]sx?|\.spec\.[cm]?[jt]sx?|(^|\/)test_[^/]+\.py|_test\.py)$/;

/** Files a unified diff touches, with their ADDED lines (the '+' side, '+++' headers excluded). Pure. */
export function diffAddedLines(diff: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let cur: string | null = null;
  for (const raw of String(diff ?? '').split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const g = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (g) { cur = g[2]; if (!out.has(cur)) out.set(cur, []); continue; }
    if (!cur) continue;
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) out.get(cur)!.push(line.slice(1));
  }
  return out;
}

export interface DetectorChangeVerdict {
  /** Detector names whose source the diff changes (empty = not a detector change). */
  detectors: string[];
  /** Files carrying the recall-replay marker on an added line. */
  replayFiles: string[];
  /** A detector change with no recall replay. */
  missingReplay: boolean;
}

/**
 * Assess a PR diff. A detector source file counts as changed when it appears in
 * the diff at all (added, modified or removed). The replay must be in a TEST
 * file — or in the nightly suite file itself (its self-test lives in-file) —
 * never in a detector's own source. Pure.
 */
export function assessDetectorChange(diff: string): DetectorChangeVerdict {
  const files = diffAddedLines(diff);
  const detectors: string[] = [];
  for (const path of files.keys()) {
    for (const d of DETECTOR_SOURCES) if (d.re.test(path) && !detectors.includes(d.name)) detectors.push(d.name);
  }
  const replayFiles: string[] = [];
  for (const [path, added] of files) {
    const replayCapable = TEST_FILE_RE.test(path) || /(^|\/)scripts\/e2e\/query-suite\.py$/.test(path);
    if (replayCapable && added.some((l) => DETECTOR_RECALL_MARKER_RE.test(l))) replayFiles.push(path);
  }
  return { detectors, replayFiles, missingReplay: detectors.length > 0 && replayFiles.length === 0 };
}

export const DETECTOR_RECALL_SUGGESTED_FIX =
  `this PR changes a framework detector, so it must ship a RECALL REPLAY: a test whose added lines carry the marker "${DETECTOR_RECALL_MARKER}" and replay the detector's PRIOR true positives (the convicting cases in its existing replay tests / labelled strike rows), asserting they STILL fire — push it to the PR branch and retry. If the change is meant to let a true positive through, do not merge: leave the ticket in_progress with adminNote "needs owner review: detector relaxation (<detector>)" and stop.`;

/** The receipt note for an observe-only detector change. Pure. */
export function renderDetectorChangeNote(v: DetectorChangeVerdict, enforced: boolean): string {
  if (!v.detectors.length) return '';
  return v.missingReplay
    ? `detector_recall: DETECTOR CHANGE (${v.detectors.join(', ')}) with NO recall replay (no test carries "${DETECTOR_RECALL_MARKER}")${enforced ? '' : ' — noted, not blocking (ticket lanes are refused)'}`
    : `detector_recall: DETECTOR CHANGE (${v.detectors.join(', ')}) — recall replay in ${v.replayFiles.slice(0, 3).join(', ')}`;
}
