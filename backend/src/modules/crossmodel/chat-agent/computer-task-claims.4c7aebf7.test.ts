/**
 * Related to ticket 4c7aebf7 part (c) — part (c) itself (quote the computer_task harness counters inline) is NOT built
 * here and stays open. (2026-10-21, chat e03452f4 — the 'cql-agx-orin64 Supervisor'): the 17:12:19Z machine
 * note said it drove the owner's Mac via computer_task — "applied the ACL edit … and clicked Save" — while the
 * owner, watching the Mac live, saw zero cursor movement (an owner-active machine run is camera-only: the
 * computer_task result's header said OBSERVE-ONLY). This file pins the deterministic, observe-only check
 * (chat-agent/computer-task-claims.ts): first-person past-tense on-screen INPUT claims vs the run's computer_task
 * results. Round 4: OBSERVE-ONLY by default (one counts-only loop_metrics row per verdict, nothing on the note);
 * the annotation is opt-in (COMPUTER_TASK_CLAIM_ANNOTATE_ENABLED=1). The seam (supervisor-class machine runs only,
 * never a block) is pinned in chat-agent.service.test.ts ('computer_task claim check').
 */
jest.mock('../../../config/database', () => ({ __esModule: true, default: { crossModelMessage: { findMany: jest.fn(async () => []) } } }));

import * as fs from 'fs';
import * as path from 'path';
import {
  findScreenInputClaims, classifyComputerTaskResult, summarizeComputerTaskCalls, checkComputerTaskClaims,
  renderComputerTaskClaimAnnotation, computerTaskClaimCheckDisabled, COMPUTER_TASK_CLAIM_SEAM, COMPUTER_TASK_CLAIM_STRIKE,
  SCREEN_INPUT_CLAIM_KIND, computerTaskClaimAnnotateEnabled, COMPUTER_TASK_CLAIM_METRIC, computerTaskClaimMetricMeta,
  computerTaskClaimRowWorthy, computerTaskCallsInputFree, MINE_MAX_CHARS, MINE_SENTENCE_MAX_CHARS,
  parseHarnessCounters, requiredCounters, missingCounterQuotes, runHarnessCounters, CORE_COUNTERS,
} from './computer-task-claims';
import { struckLaneOf, struckClaimLines, priorNoteFromRow, renderPriorNoteStruckBlock, detectStruckNoteRepeat, repeatStrikeOf, repeatTargetOf, PRIOR_NOTE_STRUCK_HEADER } from './struck-note-repeat';
import { UNVERIFIED_FOOTNOTE_HEADER, extractAnnotationClaims, planUnverifiedBriefing, UNVERIFIED_MARKER } from '../platform/unverified-claims';
import { redactGuardChrome } from '../guard-chrome-redact';
import { LOOP_METRIC_KINDS } from '../platform/loop-metric-kinds';

const LABEL = '[SUB-AGENT NARRATION — UNVERIFIED] The report below is the computer-use sub-agent\'s own account of what it did and saw, NOT a harness-verified observation.';
/** computer_task results exactly as tool-executor formatComputerTaskToolResult renders them. */
const OBSERVE_OWNER = `[Computer task result — steps: 6 · mac: online (agent 0.6.3) · OBSERVE-ONLY (owner active: HID idle 4 s — machine run was camera-only) · harness: refusedRepeats=0 noChangeStrikes=0 degenerateFrames=0 frame=1728x1117 displays=1]\n${LABEL}\nOpened the Tailscale admin console, applied the ACL edit and clicked Save.`;
const OBSERVE_CAMERA = `[Computer task result — steps: 3 · OBSERVE-ONLY (camera; no input was possible)]\n${LABEL}\nThe policy editor shows the saved JSON.`;
const BUSY = `[COMPUTER_TASK — BUSY]\nAnother computer-use session is driving this device.\nholder: lane x · chat 1234abcd · waited 60 s\n[Computer task result — steps: 0]\n${LABEL}\n`;
const UNAVAILABLE = `[COMPUTER_TASK — UNAVAILABLE]\nNo paired Mac is online.\n[Computer task result — steps: 0 · mac: offline]\n${LABEL}\n`;
const FULL = `[Computer task result — steps: 7 · mac: online (agent 0.6.3) · harness: refusedRepeats=0 noChangeStrikes=0 degenerateFrames=0 frame=1728x1117 displays=1 probe=1/1 input-proven]\n${LABEL}\nClicked Save; the policy saved.`;

const call = (result: string) => [
  { type: 'tool_call', name: 'computer_task', args: { task: 'apply the ACL edit in the Tailscale admin console' } },
  { type: 'tool_result', name: 'computer_task', result },
];

/** The 17:12:19Z note (the incident shape). */
const INCIDENT_NOTE = [
  '**cql-agx-orin64 — 17:25Z**',
  '',
  "Drove the owner's Mac via computer_task: opened the Tailscale admin console → Access controls, applied the ACL edit (tag:agx → port 22 for the orin64 node) and clicked Save — the policy file saved without errors.",
  '',
  'Verify probe: `tailscale ping cql-agx-orin64` from the gateway is still RED (timeout after 3 tries).',
].join('\n');

beforeEach(() => { delete process.env.COMPUTER_TASK_CLAIM_CHECK_DISABLED; delete process.env.COMPUTER_TASK_CLAIM_ANNOTATE_ENABLED; });
afterAll(() => { delete process.env.COMPUTER_TASK_CLAIM_CHECK_DISABLED; delete process.env.COMPUTER_TASK_CLAIM_ANNOTATE_ENABLED; });
/** Run `fn` with the opt-in annotation armed (COMPUTER_TASK_CLAIM_ANNOTATE_ENABLED=1). */
const withAnnotate = <T>(fn: () => T): T => {
  process.env.COMPUTER_TASK_CLAIM_ANNOTATE_ENABLED = '1';
  try { return fn(); } finally { delete process.env.COMPUTER_TASK_CLAIM_ANNOTATE_ENABLED; }
};

describe('computer_task result classes (the formatter\'s own banners and header)', () => {
  it('the literals this leaf keys on are the formatter\'s (source pin: tool-executor formatComputerTaskToolResult)', () => {
    const src = fs.readFileSync(path.join(__dirname, '../tool-executor.ts'), 'utf8');
    for (const lit of ['[COMPUTER_TASK — BUSY]', '[COMPUTER_TASK — UNAVAILABLE]', '[Computer task result — steps: ', ' · OBSERVE-ONLY (owner active: ', " · OBSERVE-ONLY (camera; no input was possible)", 'Computer use is only available for signed-in users', 'No task provided for computer use.']) {
      expect(src).toContain(lit);
    }
  });

  it('observe-only (owner-presence gate or camera-only), busy, unavailable, no steps, full control, unknown', () => {
    expect(classifyComputerTaskResult(OBSERVE_OWNER)).toBe('observe_only');
    expect(classifyComputerTaskResult(OBSERVE_CAMERA)).toBe('observe_only');
    expect(classifyComputerTaskResult(BUSY)).toBe('busy');
    expect(classifyComputerTaskResult(UNAVAILABLE)).toBe('unavailable');
    expect(classifyComputerTaskResult(`[Computer task result — steps: 0 · mac: online]\n${LABEL}\n`)).toBe('no_steps');
    expect(classifyComputerTaskResult('Computer use is only available for signed-in users (it drives THEIR paired Mac).')).toBe('unavailable');
    expect(classifyComputerTaskResult('No task provided for computer use.')).toBe('unavailable');
    expect(classifyComputerTaskResult(FULL)).toBe('full_control');
    expect(classifyComputerTaskResult('Tool computer_task failed: socket hang up')).toBe('unknown');
  });

  it('summarizeComputerTaskCalls pairs nameless results with the preceding call, counts a call with no result as unknown, and sees browser_task', () => {
    const s = summarizeComputerTaskCalls([
      { type: 'tool_call', name: 'computer_task' }, { type: 'tool_result', result: OBSERVE_OWNER },
      { type: 'tool_call', name: 'computer_task' }, { type: 'tool_result', name: 'computer_task', result: BUSY },
      { type: 'tool_call', name: 'computer_task' },
      { type: 'tool_call', name: 'get_chat_status' }, { type: 'tool_result', name: 'get_chat_status', result: 'idle' },
    ]);
    expect(s.counts).toMatchObject({ observe_only: 1, busy: 1, unknown: 1 });
    expect(s.total).toBe(3);
    expect(s.browserTask).toBe(false);
    expect(summarizeComputerTaskCalls([{ type: 'tool_call', name: 'browser_task' }]).browserTask).toBe(true);
  });
});

describe('claim detection — narrow: first-person past-tense on-screen input', () => {
  it('THE INCIDENT sentence is one claim (implicit first person, the Mac / computer_task cue)', () => {
    const claims = findScreenInputClaims(INCIDENT_NOTE);
    expect(claims).toHaveLength(1);
    expect(claims[0].sentence).toContain("Drove the owner's Mac via computer_task");
    expect(claims[0].phrase.toLowerCase()).toContain('drove');
  });

  it.each([
    'I clicked Save in the Tailscale admin console.',
    'I typed the policy JSON into the editor and pressed Enter.',
    '- Clicked Save on the Access controls page.',
    '✅ Pasted the token into the text field on the Mac.',
    'Via computer_task I toggled the Remote Login checkbox in System Settings.',
    'We then pressed Cmd+S in the policy editor.',
  ])('claim: %s', (s) => {
    expect(findScreenInputClaims(s)).toHaveLength(1);
  });

  it.each([
    'I will click Save once the ACL propagates.',
    "Next: click Save in the Tailscale admin console, then re-run the probe.",
    'The lane clicked Save in the admin console.',
    'The owner typed the code on his Mac.',
    'Asked the owner to click Save on his Mac.',
    'computer_task reported: clicked Save (unverified narration).',
    'The sub-agent says "I clicked Save" — unverified.',
    'I never clicked Save on the Mac.',
    'I have not clicked Save on the Mac yet.',
    'If I clicked Save on the Mac the probe would turn green.',
    'I would have clicked Save on the Mac but the session was camera-only.',
    'Applied the patch in the maintenance window.',
    'Opened PR #412 and merged it.',
    'Camera-read the policy editor on the Mac (screenshot only, no input).',
    'Earlier I clicked Save on the Mac; this wake only read the screen.',
    'Last wake I typed the policy into the editor on the Mac.',
    '> I clicked Save on the Mac.',
    'spark lane reported: I clicked Save in the console.',
    'The owner says — I typed the code on my Mac.',
  ])('not a claim: %s', (s) => {
    expect(findScreenInputClaims(s)).toEqual([]);
  });

  it('a code fence is never mined', () => {
    expect(findScreenInputClaims('```\nI clicked Save on the Mac\n```')).toEqual([]);
  });
});

describe('the verdict (checkComputerTaskClaims)', () => {
  it('THE INCIDENT: input claims on an OBSERVE-ONLY (owner-presence gated) session ⇒ unbacked (no_input_possible)', () => {
    const v = checkComputerTaskClaims(INCIDENT_NOTE, call(OBSERVE_OWNER));
    expect(v).toMatchObject({ unbacked: true, reason: 'no_input_possible' });
    expect(v.calls).toMatchObject({ observe_only: 1 });
    expect(v.claims).toHaveLength(1);
  });

  it('busy / unavailable / no-steps sessions back nothing either', () => {
    expect(checkComputerTaskClaims(INCIDENT_NOTE, [...call(BUSY), ...call(UNAVAILABLE)])).toMatchObject({ unbacked: true, reason: 'no_input_possible' });
  });

  it('the re-post shape: the note says it drove the screen and the run made NO computer_task call ⇒ unbacked (no_computer_task_call)', () => {
    expect(checkComputerTaskClaims(INCIDENT_NOTE, [{ type: 'tool_call', name: 'get_chat_status' }, { type: 'tool_result', name: 'get_chat_status', result: 'ok' }]))
      .toMatchObject({ unbacked: true, reason: 'no_computer_task_call' });
  });

  // TICKET 4c7aebf7 PART (c) (2026-11-02): a full-control result no longer backs the claim on its own — the note must
  // QUOTE that result's harness counters inline. The incident note names the action and cites none of them.
  it('a FULL-CONTROL session backs the claims ONLY when the note quotes its harness counters inline (part (c))', () => {
    expect(checkComputerTaskClaims(INCIDENT_NOTE, call(FULL))).toMatchObject({ unbacked: true, reason: 'counters_not_quoted' });
    expect(checkComputerTaskClaims(INCIDENT_NOTE, [...call(OBSERVE_OWNER), ...call(FULL)])).toMatchObject({ unbacked: true, reason: 'counters_not_quoted' });
    const quoted = `${INCIDENT_NOTE}\n\nHarness: refusedRepeats=0 noChangeStrikes=0 degenerateFrames=0 displays=1 probe=1/1 input-proven.`;
    expect(checkComputerTaskClaims(quoted, call(FULL))).toMatchObject({ unbacked: false, reason: 'backed' });
    expect(checkComputerTaskClaims(quoted, [...call(OBSERVE_OWNER), ...call(FULL)])).toMatchObject({ unbacked: false, reason: 'backed' });
  });

  it('an unknown result (an error envelope) or any browser_task call is never judged (fail-open, narrow)', () => {
    expect(checkComputerTaskClaims(INCIDENT_NOTE, call('Tool computer_task failed: socket hang up'))).toMatchObject({ unbacked: false, reason: 'unknown_result' });
    expect(checkComputerTaskClaims(INCIDENT_NOTE, [{ type: 'tool_call', name: 'browser_task' }, { type: 'tool_result', name: 'browser_task', result: '[Browser agent result — driver: local]' }]))
      .toMatchObject({ unbacked: false, reason: 'browser_task_ran' });
  });

  it('a plan sentence / a note with no input claims is never annotated', () => {
    expect(checkComputerTaskClaims('Next: I will click Save in the Tailscale admin console once the owner is away from the Mac.', call(OBSERVE_OWNER)))
      .toMatchObject({ unbacked: false, reason: 'no_claims' });
  });

  it('a note the guard already replaced / redacted is not judged again; an annotated note is judged on its own words', () => {
    const replaced = "[ACTION VERIFIER — THIS RUN'S FINAL NOTE WAS REPLACED BEFORE DELIVERY]\nStruck.\n\n--- BEGIN STRUCK NOTE (quoted for audit — UNVERIFIED; struck claims are NOT DONE) ---\n> I clicked Save on the Mac.\n--- END STRUCK NOTE ---";
    expect(checkComputerTaskClaims(replaced, [])).toMatchObject({ unbacked: false, reason: 'struck_note' });
    const annotated = `${INCIDENT_NOTE}\n\n${UNVERIFIED_FOOTNOTE_HEADER}\nThis note was delivered as written. 1 clock reading(s) …\n- "17:25Z" — 13 min ahead — in: "x"\nTreat those lines as unverified …`;
    expect(checkComputerTaskClaims(annotated, call(OBSERVE_OWNER))).toMatchObject({ unbacked: true, claims: [expect.objectContaining({ phrase: expect.stringMatching(/drove/i) })] });
  });
});

describe('the annotation (observe-only, one paragraph, a STRIKE for the next turn)', () => {
  const v = checkComputerTaskClaims(INCIDENT_NOTE, call(OBSERVE_OWNER));
  const annotation = renderComputerTaskClaimAnnotation(v);

  it('is ONE paragraph under the observe-only header naming the claims and why — guard-chrome-redact strips it', () => {
    expect(annotation.split('\n')[0]).toBe(UNVERIFIED_FOOTNOTE_HEADER);
    expect(annotation).not.toMatch(/\n\s*\n/);
    expect(annotation).toContain('delivered as written');
    expect(annotation).toMatch(/observe-only/);
    expect(annotation).toMatch(/^- \[screen input\] "/m);
    expect(redactGuardChrome(`${INCIDENT_NOTE}\n\n${annotation}`)).toBe(INCIDENT_NOTE);
    expect(annotation).not.toMatch(/could not verify \d+ action claim\(s\) in it/); // never mistaken for the non-strike footnote
  });

  it('OPT-IN ONLY (round 4): with COMPUTER_TASK_CLAIM_ANNOTATE_ENABLED=1 it is a strike for the next turn\'s [PRIOR NOTE STRUCK] block; by default a stored annotation is NOT a strike (no block)', () => {
    const stored = `${INCIDENT_NOTE}\n\n${annotation}`;
    withAnnotate(() => {
      expect(struckLaneOf(stored)).toBe('annotated');
      expect(struckClaimLines(stored).length).toBeGreaterThanOrEqual(1);
      const block = renderPriorNoteStruckBlock(priorNoteFromRow({ id: 'm1', content: stored, createdAt: new Date('2026-10-21T17:12:19Z') }));
      expect(block).toContain('> - [screen input] "');
    });
    expect(struckLaneOf(stored)).toBeNull();
    expect(struckClaimLines(stored)).toEqual([]);
    expect(renderPriorNoteStruckBlock(priorNoteFromRow({ id: 'm1', content: stored, createdAt: new Date('2026-10-21T17:12:19Z') }))).toBe('');
  });

  // Round 3 (both reviews): an unmeasured pattern check must never drive a reject-back, nor a "re-run every claim"
  // block that could duplicate a ticket / session a mis-mined line named.
  it('round 3: it is NOT a repeat strike — a re-post of a screen-claims-only note is never a repeat (it is annotated again by the claim check instead)', () => withAnnotate(() => {
    const stored = `${INCIDENT_NOTE}\n\n${annotation}`;
    const prior = priorNoteFromRow({ id: 'm1', content: stored, createdAt: new Date('2026-10-21T17:12:19Z') })!;
    expect(repeatStrikeOf(stored)).toBe(false);
    expect(prior).toMatchObject({ struck: 'annotated', repeatStrike: false });
    expect(repeatTargetOf(prior)).toBeNull();
    // round 4: the ineligible verdict still MEASURES whether the next note copied it (wouldRepeat) — never acted on
    expect(detectStruckNoteRepeat(INCIDENT_NOTE.replace('17:25Z', '17:31Z'), prior)).toMatchObject({ repeat: false, reason: 'prior_screen_claims_only', similarity: 1, wouldRepeat: true });
    // …while a clock strike beside it still makes the note a repeat strike (the incident row)
    const both = `${INCIDENT_NOTE}\n\n${UNVERIFIED_FOOTNOTE_HEADER}\nThis note was delivered as written. 1 clock reading(s) in it are written as observations but read LATER than this run's real clock (x):\n- "17:25Z" — 13 min ahead — in: "x"\nTreat those lines as unverified until a fresh tool result confirms them; nothing above was removed or changed.\n\n${annotation}`;
    expect(repeatStrikeOf(both)).toBe(true);
    expect(detectStruckNoteRepeat(INCIDENT_NOTE.replace('17:25Z', '17:31Z'), priorNoteFromRow({ id: 'm2', content: both, createdAt: new Date() })!).repeat).toBe(true);
  }));

  it('round 3: the block for a screen-claims-only note is worded for screen claims — observe with computer_task, never redo other work (opt-in)', () => withAnnotate(() => {
    const block = renderPriorNoteStruckBlock(priorNoteFromRow({ id: 'm1', content: `${INCIDENT_NOTE}\n\n${annotation}`, createdAt: new Date('2026-10-21T17:12:19Z') }));
    expect(block.startsWith(PRIOR_NOTE_STRUCK_HEADER)).toBe(true);
    expect(block).toMatch(/said it acted on the screen/);
    expect(block).toMatch(/run computer_task and quote its result header/);
    expect(block).toMatch(/do not redo other work \(tickets, sessions, messages\)/);
    expect(block).not.toMatch(/re-run each flagged claim/);
    expect(block).not.toContain('[ACTION VERIFIER');
    expect(block.length).toBeLessThan(1600);
  }));

  it('round 3: an owner briefing written from the note reads the claim lines back and marks them "(unverified)" (the annotation-claim shape)', () => {
    const stored = `${INCIDENT_NOTE}\n\n${annotation}`;
    const embedded = extractAnnotationClaims(stored);
    expect(embedded.text).toBe(INCIDENT_NOTE); // the paragraph is stripped
    expect(embedded.claims).toHaveLength(1);
    expect(embedded.claims[0]).toMatchObject({ kind: SCREEN_INPUT_CLAIM_KIND, source: 'annotation' });
    expect(embedded.claims[0].quote).toContain("Drove the owner's Mac via computer_task");
    const plan = planUnverifiedBriefing(embedded.text, embedded.claims);
    expect(plan.located).toBe(1);
    expect(plan.markedNote).toContain(UNVERIFIED_MARKER);
    expect(plan.droppedNote).not.toContain('clicked Save');
  });

  it('the no-call wording says no computer_task call ran', () => {
    const none = renderComputerTaskClaimAnnotation(checkComputerTaskClaims(INCIDENT_NOTE, []));
    expect(none).toMatch(/made no computer_task call/);
  });
});

// ── Round 3 (2026-10-21 — both reviews NOT_MERGE_SAFE: routine supervisor work read as screen input) ───────────
describe('round 3 — routine platform work is never a screen-input claim (verb tiers, clause-scoped cues)', () => {
  /** The run's real platform calls (no computer_task) — the reviewers' replay shape. */
  const platformParts = [
    { type: 'tool_call', name: 'file_feedback', args: {} }, { type: 'tool_result', name: 'file_feedback', result: 'filed ticket 1a2b3c4d' },
    { type: 'tool_call', name: 'start_coding_session', args: {} }, { type: 'tool_result', name: 'start_coding_session', result: 'session 9f8e7d6c started' },
  ];
  it.each([
    // reviewer 1 (12 of 14 flagged before)
    'Opened ticket 1a2b3c4d for the sidebar refresh bug.',
    'Launched session 9f8e7d6c to fix the Save button on the Account tab.',
    'Applied the dark-mode toggle fix via PR #1234.',
    "Opened PR #412 fixing the desktop app's link handling.",
    'Saved the directive: do not touch the console logger.',
    'Pressed Spark for an ETA on the bench run.',
    'Checked off todo 3 (the screen-share topology fix).',
    'Selected glm-5.3 for the editor seat after the owner asked.',
    'Entered HOLD on the AGX lane until the owner answers the screen recording question.',
    'Opened ticket 1a2b3c4d for the sidebar refresh bug and launched session 9f8e7d6c to fix the Save button on the Account tab.',
    'Edited the lane instructions for the console logging cleanup.',
    'Submitted the bench results for the Chrome extension lane.',
    // reviewer 2 (15 of 15 flagged before)
    'Opened PR #1450 with the premise fix (link in the thread).',
    'I opened ticket 61797fe8 for the console errors the lane reported.',
    'Pressed Spark lane for the H100 numbers before the next sweep.',
    'Launched a coding session to rebuild the DMG on the Mac mini.',
    'Saved the new premise; the Sessions tab now shows 3 running.',
    'Applied the owner directive and dispatched lane 28de72e5 — link below.',
    'Pressed CanLaw to post the eval numbers.',
    // more platform shapes
    'Toggled the AGX lane to HOLD after the owner asked.',
    'Toggled the QUICK_LANE_DISABLED kill switch back off.',
    'Pasted the PR link into the lane thread.',
    'Typed up the owner question about the Mac mini build and flagged it.',
    'Clicked through the lane receipts for the ETA.',
    'Scrolled back through the thread to find the owner\'s ask.',
  ])('not a claim (and never annotated): %s', (s) => {
    expect(findScreenInputClaims(s)).toEqual([]);
    expect(checkComputerTaskClaims(s, platformParts)).toMatchObject({ unbacked: false });
  });

  // Reviewer 2: the honest wording the fix itself asks for must never be annotated (it would loop the chat).
  it.each([
    'Clicked nothing on the Mac this turn.',
    'Typed nothing on the screen.',
    'I clicked nothing on the desktop.',
    'Pressed no keys on the Mac.',
    'Clicked Save — attempted, unverified (computer_task was observe-only).',
    'Clicked nothing on the Mac this turn — the saved policy JSON shows no tag:agx rule.',
    'Typed none of the policy into the editor this turn.',
    'Pressed Enter in the policy editor but could not confirm it registered (observe-only session).',
    'Clicked Save on the Mac — not verified yet.',
  ])('honest wording is not a claim: %s', (s) => {
    expect(findScreenInputClaims(s)).toEqual([]);
    expect(checkComputerTaskClaims(s, call(OBSERVE_OWNER))).toMatchObject({ unbacked: false, reason: 'no_claims' });
  });

  it.each([
    ['clicked a quoted label', 'Clicked "Apply" in the policy editor.'],
    ['pressed a key', 'Pressed Enter in the policy editor.'],
    ['pressed the Return key', 'I pressed the Return key.'],
    ['a device-only verb with the Mac', 'Applied the ACL edit on the Mac and clicked Save; verify probe still red, retrying after propagation.'],
    ['typed into the terminal', 'Typed `tailscale up --ssh` into the terminal.'],
    ['a coordinated click after a device-less first verb', 'Applied the ACL edit (tag:agx → port 22 for the orin64 node) and clicked Save — the policy file saved without errors.'],
    ['a coordinated key press', 'I opened the policy editor, then pressed Cmd+S.'],
  ])('still a claim — %s', (_label, s) => {
    expect(findScreenInputClaims(s)).toHaveLength(1);
  });

  it('a coordinated verb shares the first verb\'s subject only — never another speaker\'s, never a platform verb', () => {
    expect(findScreenInputClaims('Applied the ACL edit and clicked Save.')[0]).toMatchObject({ phrase: 'clicked Save', device: false });
    expect(findScreenInputClaims('Opened ticket 1a2b3c4d for the bug, the lane clicked Save in the console.')).toEqual([]);
    expect(findScreenInputClaims('Opened PR #4 and pressed Spark lane for the numbers.')).toEqual([]);
    expect(findScreenInputClaims('Clicked nothing on the Mac and typed nothing in the editor.')).toEqual([]);
  });

  it('a no-call verdict needs a claim that NAMES the device — "clicked Save in the console" with no computer_task call is never judged (no_device_claim)', () => {
    const s = 'I clicked Save in the Tailscale admin console.';
    expect(findScreenInputClaims(s)).toEqual([expect.objectContaining({ device: false })]);
    expect(checkComputerTaskClaims(s, platformParts)).toMatchObject({ unbacked: false, reason: 'no_device_claim' });
    expect(checkComputerTaskClaims(s, [])).toMatchObject({ unbacked: false, reason: 'no_device_claim' });
    // …but an observe-only computer_task call this run makes it judged (the run did drive at the screen)
    expect(checkComputerTaskClaims(s, call(OBSERVE_OWNER))).toMatchObject({ unbacked: true, reason: 'no_input_possible' });
    // the incident's re-post names the Mac / computer_task — judged with no call at all
    expect(findScreenInputClaims(INCIDENT_NOTE)[0].device).toBe(true);
    expect(checkComputerTaskClaims(INCIDENT_NOTE, platformParts)).toMatchObject({ unbacked: true, reason: 'no_computer_task_call' });
  });

  it('the no-call annotation lists only the device claims', () => {
    const note = `${INCIDENT_NOTE}\n\nI clicked Save in the Tailscale admin console.`;
    const v = checkComputerTaskClaims(note, []);
    expect(v).toMatchObject({ unbacked: true, reason: 'no_computer_task_call' });
    expect(v.claims).toHaveLength(1);
    expect(v.claims[0].device).toBe(true);
  });
});

describe('switch + telemetry names', () => {
  it('COMPUTER_TASK_CLAIM_CHECK_DISABLED=1 reads exactly "1"; seam / strike names', () => {
    expect(computerTaskClaimCheckDisabled()).toBe(false);
    process.env.COMPUTER_TASK_CLAIM_CHECK_DISABLED = '1';
    expect(computerTaskClaimCheckDisabled()).toBe(true);
    process.env.COMPUTER_TASK_CLAIM_CHECK_DISABLED = 'true';
    expect(computerTaskClaimCheckDisabled()).toBe(false);
    expect(COMPUTER_TASK_CLAIM_SEAM).toBe('machine_wake_computer_task_claim');
    expect(COMPUTER_TASK_CLAIM_STRIKE).toBe('computer_task_claim_unbacked');
  });

  it('the seam is skipped by the nightly adjudicator (observe-only telemetry, never a fabrication verdict) — source pin', () => {
    const src = fs.readFileSync(path.join(__dirname, '../fleet/strike-adjudication.service.ts'), 'utf8');
    const block = src.slice(src.indexOf('export const ADJUDICATION_SKIPPED_SEAMS'), src.indexOf(']);', src.indexOf('export const ADJUDICATION_SKIPPED_SEAMS')));
    expect(block).toContain(`'${COMPUTER_TASK_CLAIM_SEAM}'`);
    const fab = src.slice(src.indexOf('export const FABRICATION_CLASS_SEAMS'), src.indexOf(']);', src.indexOf('export const FABRICATION_CLASS_SEAMS')));
    expect(fab).not.toContain(COMPUTER_TASK_CLAIM_SEAM);
  });
});

// ── Round 4 (2026-10-21 — both round-3 reviews NOT_MERGE_SAFE: OBSERVE-ONLY by default + the two FP classes) ──────
describe('round 4 — a device word counts only as the object / place of a SCREEN-INPUT verb (the reviewers\' exact sentences)', () => {
  const observe = () => call(OBSERVE_OWNER);
  it.each([
    // round-3 review 1 (19 of 20 flagged unbacked / no_computer_task_call)
    'Opened ticket 4c7aebf7 on the computer_task claim gap.',
    'Edited the Mac mini build script in PR #1201.',
    'Selected the MacBook as the computer-use target.',
    'Entered HOLD on the Mac lane until the owner answers.',
    'Pressed the Mac mini lane for the DMG numbers.',
    'Typed up the computer_task postmortem in ticket 4c7aebf7.',
    'On the Mac mini lane, opened ticket 9f2a11bc for the notarization failure.',
    'Opened a session on the Mac agent crash.',
    // recaps of earlier screen work
    'Applied the ACL edit on the Mac at 16:40Z via computer_task (full control, input-proven); …',
    'Saved the policy on the Mac two hours ago',
    'Opened the Mac mini DMG build lane on Tuesday',
    // the service replay's lines
    'Opened ticket 4c7aebf7 on the computer_task claim gap …',
    'Edited the Mac mini build script in PR #1201; CI is green.',
    // round-3 review 2 (12 sentences, each unbacked:true / no_computer_task_call)
    'Applied the computer_task fix to main via PR #1301.',
    'Edited the computer_task doctrine in PR #1300.',
    'Opened a Screen Recording permission ticket (1a2b3c4d).',
    'Applied the blank-screen fix via PR #1234.',
    'Opened a Mac agent ticket 1a2b3c4d.',
    'Edited the Mac agent config via PR #77.',
    'Entered HOLD on the screen-capture lane.',
    'Checked off the computer_task todo on the board.',
    'Submitted the Mac DMG 0.1.11 build for notarization via the build lane.',
    'I applied the computer_task doctrine change from PR #1301.',
    'We saved the computer_task result header in the ticket.',
    'Opened ticket 1a2b3c4d with the screen read attached.',
    // its two service replays
    'Applied the computer_task claim-check fix to main via PR #1301; CI green …',
    'Opened a Screen Recording permission ticket (1a2b3c4d) …',
    'Opened ticket 1a2b3c4d with the screen read attached and saved the computer_task result header in it.',
    // more platform shapes on the same topics
    'Clicked through the computer_task receipts for the Mac lane.',
    'Pasted the Mac agent crash log into the ticket.',
    'Selected the Mac mini as the DMG build machine.',
    'Toggled the computer_task owner-presence gate kill switch off.',
    'Clicked the PR link for the Mac DMG build.',
    'Drove the Mac mini DMG build lane to green.',
  ])('not a claim — never judged, with no call or an observe-only call: %s', (s) => {
    expect(findScreenInputClaims(s)).toEqual([]);
    expect(checkComputerTaskClaims(s, [])).toMatchObject({ unbacked: false, reason: 'no_claims' });
    expect(checkComputerTaskClaims(s, observe())).toMatchObject({ unbacked: false, reason: 'no_claims' });
  });

  it('platform verbs are never claims on their own, even with the device as their place (round 4: "Applied the ACL edit (via computer_task)", "I opened the Tailscale admin console on the Mac")', () => {
    expect(findScreenInputClaims('Applied the ACL edit (via computer_task).')).toEqual([]);
    expect(findScreenInputClaims('I opened the Tailscale admin console on the Mac.')).toEqual([]);
    expect(findScreenInputClaims('Applied the ACL edit on the Mac.')).toEqual([]);
  });
});

describe('round 4 — acknowledgement / retraction lines (what the [PRIOR NOTE STRUCK] block asks for) are never claims', () => {
  it.each([
    // round-3 review 1, major 2 (each annotated as a NEW claim "this turn")
    'Correction: the 17:12Z note said I clicked Save on the Mac. That never happened.',
    'My previous note said I clicked Save on the Mac; that did not happen.',
    'Retraction — my 17:12Z note claimed I applied the ACL edit on the Mac; nothing was applied.',
    "Acknowledged: the 17:12Z note's claim that I clicked Save on the Mac is withdrawn.",
    'The integrity check flagged that I clicked Save on the Mac at 17:12Z — withdrawn …',
    // more of the same shapes
    'The earlier note claimed I clicked Save on the Mac; I did not.',
    'I clicked Save on the Mac. That never happened — the session was camera-only.',
    'Clicked Save on the Mac (per my previous note) — not done.',
    'I did not actually click Save on the Mac.',
    'The note said I typed the policy into the editor on the Mac, which is false.',
    '- [screen input] "Drove the owner\'s Mac via computer_task: opened the console and clicked Save"',
    'Per the PRIOR NOTE STRUCK block: I clicked Save on the Mac in that note; it is withdrawn.',
  ])('not a claim: %s', (s) => {
    expect(findScreenInputClaims(s)).toEqual([]);
    expect(checkComputerTaskClaims(s, [])).toMatchObject({ unbacked: false });
    expect(checkComputerTaskClaims(s, call(OBSERVE_OWNER))).toMatchObject({ unbacked: false, reason: 'no_claims' });
  });

  it('a retraction only withdraws its own sentence and the one before it — a later fresh claim still counts', () => {
    const note = 'Correction: the 17:12Z note said I clicked Save on the Mac. That never happened.\n\nThis turn I clicked Save on the Mac via computer_task.';
    expect(findScreenInputClaims(note)).toHaveLength(1);
    expect(findScreenInputClaims(note)[0].sentence).toContain('This turn I clicked Save');
  });

  it('plans, futures and other agents\' actions are never claims', () => {
    for (const s of [
      'Will click Save on the Mac once the owner is away.',
      'Plan: click Save on the Mac next wake via computer_task.',
      'The sub-agent clicked Save on the Mac (narration).',
      'computer_task\'s sub-agent says it pasted the token into the text field on the Mac.',
    ]) expect(findScreenInputClaims(s)).toEqual([]);
  });
});

describe('round 4 — what still counts (screen-input verbs on the device / a UI target)', () => {
  it.each([
    ['the incident sentence (drove the Mac — the device is the object)', INCIDENT_NOTE, true],
    ['clicked Save on the Mac', 'Clicked Save on the Mac and saw the dialog close.', true],
    ['pasted into a field on the Mac', 'Pasted the token into the text field on the Mac.', true],
    ['a coordinated click in a device scene', 'Applied the ACL edit on the Mac and clicked Save; verify probe still red.', true],
    ['the instrument phrase', 'Via computer_task I toggled the Remote Login checkbox in System Settings.', true],
    ['a click with no device', 'I clicked Save in the Tailscale admin console.', false],
    ['a select on a control', 'Selected the "Allow" radio button in the dialog.', false],
    ['a platform verb first never hides a later explicit input claim', 'I read the policy, then I clicked Save on the Mac.', true],
    ['an implicit platform verb, then an explicit input claim', 'Read the policy JSON; I then pasted it into the editor on the Mac.', true],
    ['a sentence-initial verb that merely looks like an acknowledgement label', 'Corrected the policy in the editor on the Mac and clicked Save.', true],
  ])('%s', (_label, s, device) => {
    const claims = findScreenInputClaims(s as string);
    expect(claims).toHaveLength(1);
    expect(claims[0].device).toBe(device);
  });

  it('a device word that only DESCRIBES the object never sets device (the no-call bar): "Clicked Save on the Mac mini settings page" is a click, not on the Mac', () => {
    const [c] = findScreenInputClaims('Clicked Save on the Mac mini settings page.');
    expect(c).toMatchObject({ device: false });
    expect(checkComputerTaskClaims('Clicked Save on the Mac mini settings page.', [])).toMatchObject({ unbacked: false, reason: 'no_device_claim' });
    // round 5: "the Mac mini LANE page" places the click on a platform artefact (a lane) — not screen input at all
    expect(findScreenInputClaims('Clicked Save on the Mac mini lane page.')).toEqual([]);
  });

  it('a host name or "MAC address" is never the device (case-sensitive Mac family)', () => {
    expect(findScreenInputClaims('Typed the command on home-pauls-mac-mini in the terminal.')).toEqual([expect.objectContaining({ device: false })]);
    expect(findScreenInputClaims('Pasted the MAC address into the text field.')).toEqual([expect.objectContaining({ device: false })]);
  });
});

describe('round 4 — OBSERVE-ONLY by default: the counts-only row, the opt-in reader, the replay-safety helper', () => {
  it('COMPUTER_TASK_CLAIM_ANNOTATE_ENABLED reads exactly "1" (default OFF)', () => {
    expect(computerTaskClaimAnnotateEnabled()).toBe(false);
    process.env.COMPUTER_TASK_CLAIM_ANNOTATE_ENABLED = 'true';
    expect(computerTaskClaimAnnotateEnabled()).toBe(false);
    process.env.COMPUTER_TASK_CLAIM_ANNOTATE_ENABLED = '1';
    expect(computerTaskClaimAnnotateEnabled()).toBe(true);
    expect(COMPUTER_TASK_CLAIM_METRIC).toBe('computer_task_claim');
    expect(COMPUTER_TASK_CLAIM_METRIC).toBe(LOOP_METRIC_KINDS.COMPUTER_TASK_CLAIM); // the registered kind
  });

  it('the row meta carries the reason class and counts — NEVER note text', () => {
    const v = checkComputerTaskClaims(INCIDENT_NOTE, call(OBSERVE_OWNER));
    const meta = computerTaskClaimMetricMeta(v, { annotated: false });
    expect(meta).toEqual({ unbacked: true, reason: 'no_input_possible', found: 1, claims: 1, deviceClaims: 1, totalCalls: 1, calls: { observe_only: 1 }, mode: 'observe', annotated: false });
    const flat = JSON.stringify(meta);
    for (const word of ['Drove', 'Mac', 'Save', 'Tailscale', 'clicked']) expect(flat).not.toContain(word);
    expect(withAnnotate(() => computerTaskClaimMetricMeta(v, { annotated: true }))).toMatchObject({ mode: 'annotate', annotated: true });
  });

  it('a row is worth writing unless the verdict is empty (no claim found AND no computer_task call)', () => {
    expect(computerTaskClaimRowWorthy(checkComputerTaskClaims('Filed ticket 1a2b3c4d.', []))).toBe(false);
    expect(computerTaskClaimRowWorthy(checkComputerTaskClaims('Filed ticket 1a2b3c4d.', call(OBSERVE_OWNER)))).toBe(true);
    expect(computerTaskClaimRowWorthy(checkComputerTaskClaims('I clicked Save in the Tailscale admin console.', []))).toBe(true); // no_device_claim
  });

  it('computerTaskCallsInputFree: camera-only / busy / unavailable / none ⇒ true; a full-control call or an unknown result ⇒ false', () => {
    expect(computerTaskCallsInputFree([])).toBe(true);
    expect(computerTaskCallsInputFree([...call(OBSERVE_OWNER), ...call(BUSY), ...call(UNAVAILABLE)])).toBe(true);
    expect(computerTaskCallsInputFree(call(FULL))).toBe(false);
    expect(computerTaskCallsInputFree(call('Tool computer_task failed: socket hang up'))).toBe(false);
    expect(computerTaskCallsInputFree([{ type: 'tool_call', name: 'computer_task' }])).toBe(false); // no result yet ⇒ unknown
  });
});

// ── Round 5 (2026-10-21 — both round-4 reviews NOT_MERGE_SAFE) ────────────────────────────────────────────────────
describe('round 5 — the miner is bounded (it runs synchronously on every supervisor machine note)', () => {
  // Round-4 review 1: the end-anchored reported-speech regexes ran over the whole sentence prefix for every explicit
  // "I <verb>" match — roughly cubic on a long single-sentence paragraph (19.2 KB took ~1 s on the finalize path).
  const ADVERSARIAL = 'the lane said I clicked Save on the Mac — and the worker reported I pressed Enter on the screen ';
  const now = (): number => Number(process.hrtime.bigint() / 1000n) / 1000;

  it('a 200 KB single-sentence note finishes in a few ms (bound 1 s) (the whole verdict, not just the miner)', () => {
    const note = ADVERSARIAL.repeat(Math.ceil((200 * 1024) / ADVERSARIAL.length));
    expect(note.length).toBeGreaterThanOrEqual(200 * 1024);
    const t0 = now();
    const v = checkComputerTaskClaims(note, call(OBSERVE_OWNER));
    const ms = now() - t0;
    expect(ms).toBeLessThan(1000); // ~2 ms measured; the bound catches the minutes-long regression without flaking under CI contention
    expect(v).toMatchObject({ unbacked: false, reason: 'no_claims' }); // one sentence over the cap: skipped, never mined
  });

  it('a 20 KB note of the longest sentences still mined (each just under the per-sentence cap) stays bounded too', () => {
    const sentence = `${ADVERSARIAL.repeat(Math.floor((MINE_SENTENCE_MAX_CHARS - 2) / ADVERSARIAL.length)).trim()}.`;
    expect(sentence.length).toBeLessThanOrEqual(MINE_SENTENCE_MAX_CHARS);
    const note = Array.from({ length: Math.ceil(MINE_MAX_CHARS / sentence.length) + 2 }, () => `The ${sentence}`).join(' ');
    const t0 = now();
    findScreenInputClaims(note);
    expect(now() - t0).toBeLessThan(1000); // a few ms measured at the 8 000 / 600 caps
  });

  it('the caps: only the first MINE_MAX_CHARS of the note are mined, and a sentence over MINE_SENTENCE_MAX_CHARS is skipped', () => {
    expect(MINE_MAX_CHARS).toBe(8_000);
    expect(MINE_SENTENCE_MAX_CHARS).toBe(600);
    const claim = 'Clicked Save on the Mac.';
    expect(findScreenInputClaims(`${claim}\n\n${'Filed ticket 1a2b3c4d. '.repeat(2000)}`)).toHaveLength(1); // the head is still mined
    expect(findScreenInputClaims(`${'Filed ticket 1a2b3c4d. '.repeat(1000)}\n\n${claim}`)).toEqual([]); // past the first 20 000 chars
    const long = `I clicked Save on the Mac and then ${'reviewed the lane receipts '.repeat(80)}finished.`;
    expect(long.length).toBeGreaterThan(MINE_SENTENCE_MAX_CHARS);
    expect(findScreenInputClaims(long)).toEqual([]);
    expect(findScreenInputClaims(`I clicked Save on the Mac and then ${'reviewed the lane receipts '.repeat(20)}finished.`)).toHaveLength(1);
  });
});

describe('round 5 — the cheap false-positive shapes from round-4 review 1 (shadow data that decides the opt-in)', () => {
  const observe = () => call(OBSERVE_CAMERA);

  it.each([
    // a device place on a PLATFORM verb no longer carries into a coordinated verb whose own object is not a UI target
    'Reviewed the camera read from the Mac and toggled the decision gate to shadow.',
    'Opened the policy editor on the Mac and pressed Spark lane for the numbers.',
    // a question-form acknowledgement (and a "No —" / "No," reply) is never a claim
    'Clicked Save on the Mac? No — the run was camera-only.',
    'Clicked Save on the Mac? No, the session was camera-only.',
    'Did I click Save on the Mac?',
    'I clicked Save on the Mac. No — that was the sub-agent\'s narration, not mine.',
    // an acknowledgement label ("Owning the miss:")
    'Owning the miss: I clicked Save on the Mac only in my head; the camera shows the old policy.',
    'My mistake — I clicked Save on the Mac in the previous plan, not this turn.',
    // a screen-input verb whose own place is a platform artefact (a PR, a lane, a deploy) is platform work
    'Clicked Merge on PR #1301 after CI went green.',
    'Pressed Enter on the deploy dispatch.',
    'Clicked the link in the lane message to open the run.',
    'Typed into the terminal of the coding lane: npm test.',
  ])('not a claim — never judged, with no call or a camera-only call: %s', (s) => {
    expect(findScreenInputClaims(s)).toEqual([]);
    expect(checkComputerTaskClaims(s, [])).toMatchObject({ unbacked: false, reason: 'no_claims' });
    expect(checkComputerTaskClaims(s, observe())).toMatchObject({ unbacked: false, reason: 'no_claims' });
  });

  it.each([
    // the coordinated verb's OWN target still counts — the platform verb's device place only marks it a device claim
    ['a coordinated click on a label in a Mac scene', 'Opened the policy editor on the Mac and clicked Save.', true],
    ['a coordinated toggle on a control in a Mac scene', 'Reviewed the camera read from the Mac and toggled the Remote Login checkbox.', true],
    ['the instrument still counts for every verb', 'Via computer_task, opened System Settings and toggled Remote Login.', true],
    // a platform place in a desktop app / on the device is still on the screen
    ['a PR clicked in a desktop app', 'Clicked Approve on PR #1301 in Safari.', false],
    ['a deploy place on the device', 'Pressed Enter on the deploy dialog on the Mac.', true],
    // the incident relay shape without the device word — still judged once a camera-only call ran (deliberately kept)
    ['the policy editor', 'I clicked Save on the policy editor at 16:40Z.', false],
    // KNOWN, kept: a UI control whose PR place sits after a purpose word — the purpose cut ("for …") that keeps
    // "Clicked Save in the policy editor for ticket 1a2b3c4d" a claim also hides this place
    ['a control whose platform place follows a purpose word (known remaining shape)', 'Toggled the checkbox for auto-merge on PR #1301.', false],
    ['a click whose purpose names a ticket', 'Clicked Save in the policy editor for ticket 1a2b3c4d.', false],
    ['typed into Terminal (the app) on a lane branch', 'Typed the command into Terminal on the lane branch.', false],
    // the "No —" reply rule reads a bare "No" only — never "No other changes." / "No-op otherwise."
    ['a claim followed by "No other changes."', 'Clicked Save on the Mac. No other changes this turn.', true],
    ['a claim followed by "No-op otherwise."', 'Clicked Save on the Mac. No-op otherwise.', true],
  ])('still a claim — %s', (_label, s, device) => {
    const claims = findScreenInputClaims(s as string);
    expect(claims).toHaveLength(1);
    expect(claims[0].device).toBe(device);
  });

  it('one camera-only call still judges a non-device claim (the relay shape the round-3 tests pin) — declined bar change, the meta splits device claims', () => {
    const v = checkComputerTaskClaims('I clicked Save on the policy editor at 16:40Z.', observe());
    expect(v).toMatchObject({ unbacked: true, reason: 'no_input_possible' });
    expect(computerTaskClaimMetricMeta(v, { annotated: false })).toMatchObject({ unbacked: true, claims: 1, deviceClaims: 0 });
  });
});

describe('round 5 — COMPUTER_TASK_CLAIM_CHECK_DISABLED=1 is the full off switch: a stored annotation is no strike even under the opt-in', () => {
  it('the opt-in alone makes a stored annotation a [PRIOR NOTE STRUCK] strike; with the check off it does not (as documented)', () => {
    const stored = `${INCIDENT_NOTE}\n\n${renderComputerTaskClaimAnnotation(checkComputerTaskClaims(INCIDENT_NOTE, call(OBSERVE_OWNER)))}`;
    const prior = () => priorNoteFromRow({ id: 'm1', content: stored, createdAt: new Date('2026-10-21T17:12:19Z') });
    withAnnotate(() => {
      expect(struckLaneOf(stored)).toBe('annotated');
      process.env.COMPUTER_TASK_CLAIM_CHECK_DISABLED = '1';
      try {
        expect(struckLaneOf(stored)).toBeNull();
        expect(struckClaimLines(stored)).toEqual([]);
        expect(renderPriorNoteStruckBlock(prior())).toBe('');
      } finally { delete process.env.COMPUTER_TASK_CLAIM_CHECK_DISABLED; }
      expect(renderPriorNoteStruckBlock(prior())).toContain('> - [screen input] "');
    });
  });
});

describe('ship review — a claim followed by a question to the owner is still a report', () => {
  for (const s of [
    "Drove the owner's Mac via computer_task: opened the Tailscale admin console, applied the ACL edit and clicked Save; should I re-run the probe now?",
    'Applied the ACL edit on the Mac via computer_task and clicked Save — want me to re-run the probe?',
    'Clicked Save in the Tailscale admin console on the Mac; does the policy show the tag?',
  ]) {
    it(`mined: ${s.slice(0, 60)}…`, () => {
      expect(checkComputerTaskClaims(s, [])).toMatchObject({ unbacked: true, reason: 'no_computer_task_call' });
    });
  }
  it('a plain question about input is still not a claim', () => {
    expect(checkComputerTaskClaims('Clicked Save on the Mac?', [])).toMatchObject({ unbacked: false });
  });
});

// ── TICKET 4c7aebf7 PART (c) — a computer_task ACTION claim must QUOTE the result's harness counters inline ──────
// THE DEFECT THIS PINS (2026-10-21, chat e03452f4): the 17:12:19Z note asserted a physical action on the owner's Mac
// ("opened the Tailscale admin console → Access controls, applied the ACL edit … and clicked Save — the policy file
// saved") while the owner watched zero cursor movement; the run's computer_task result carried harness FACTS about
// whether input landed (refusedRepeats / noChangeStrikes / degenerateFrames / displays / probe) and the note quoted
// NONE of them. Part (c)'s bar: an action claim is backed only when the note quotes those counters inline — the same
// evidence discipline the [SUB-AGENT NARRATION — unverified] rule already imposes on capture / permission claims.
// Before this change the 'backed' branch returned as soon as any full-control result existed, so a note relaying the
// sub-agent's narration under its own voice passed with no counter quoted at all.
describe('ticket 4c7aebf7 part (c) — the harness-counter QUOTE requirement', () => {
  /** A full-control result exactly as tool-executor renders it, WITH the probe segment. */
  const FULL_CT = `[Computer task result — steps: 7 · mac: online (agent 0.6.3) · harness: refusedRepeats=0 noChangeStrikes=0 degenerateFrames=0 frame=1728x1117 displays=1 probe=1/1 input-proven]\n${LABEL}\nClicked Save; the policy saved.`;
  /** A full-control result whose session ran NO probes — its bar is the core four only. */
  const FULL_NO_PROBE = `[Computer task result — steps: 7 · mac: online (agent 0.6.3) · harness: refusedRepeats=2 noChangeStrikes=0 degenerateFrames=1 frame=1728x1117 displays=unknown]\n${LABEL}\nClicked Save.`;
  /** A full-control result with NO harness line at all (a session that never stamped counters). */
  const FULL_NO_COUNTERS = `[Computer task result — steps: 4 · mac: online (agent 0.6.3)]\n${LABEL}\nClicked Save.`;

  it('parseHarnessCounters reads the formatter\'s own header segment (and null when there is none)', () => {
    expect(parseHarnessCounters(FULL_CT)).toEqual({ refusedRepeats: 0, noChangeStrikes: 0, degenerateFrames: 0, displays: 1, probesRun: 1, probesPassed: 1, inputProven: true });
    // displays=unknown / a FAILED probe / counters that are NOT zero are read as written, not normalised away
    expect(parseHarnessCounters(FULL_NO_PROBE)).toEqual({ refusedRepeats: 2, noChangeStrikes: 0, degenerateFrames: 1, displays: null, probesRun: null, probesPassed: null, inputProven: false });
    expect(parseHarnessCounters(FULL_NO_COUNTERS)).toBeNull();
    expect(parseHarnessCounters(OBSERVE_OWNER)).toMatchObject({ refusedRepeats: 0, displays: 1 }); // observe-only still CARRIES them
    expect(parseHarnessCounters('Tool computer_task failed: socket hang up')).toBeNull();
  });

  it('the quote bar is the counters THAT result carries — probe only when the session ran probes (source-pinned literals)', () => {
    const src = fs.readFileSync(path.join(__dirname, '../tool-executor.ts'), 'utf8');
    for (const lit of ['refusedRepeats=', 'noChangeStrikes=', 'degenerateFrames=', 'displays=', 'probe=', 'input-proven']) expect(src).toContain(lit);
    expect(CORE_COUNTERS).toEqual(['refusedRepeats', 'noChangeStrikes', 'degenerateFrames', 'displays']);
    expect(requiredCounters(parseHarnessCounters(FULL_CT)!)).toEqual([...CORE_COUNTERS, 'probe']);
    expect(requiredCounters(parseHarnessCounters(FULL_NO_PROBE)!)).toEqual([...CORE_COUNTERS]);
  });

  it('THE DEFECT REPLAY: a full-control result + an action claim quoting NO counters ⇒ counters_not_quoted (was "backed")', () => {
    const v = checkComputerTaskClaims(INCIDENT_NOTE, call(FULL_CT));
    expect(v).toMatchObject({ unbacked: true, reason: 'counters_not_quoted', found: 1 });
    expect(v.missingQuotes).toEqual([...CORE_COUNTERS, 'probe']);
    expect(renderComputerTaskClaimAnnotation(v)).toMatch(/does not quote inline \(refusedRepeats, noChangeStrikes, degenerateFrames, displays, probe\)/);
  });

  it('the SAME run passes once the note quotes every counter inline (the fix\'s own wording)', () => {
    const quoted = `${INCIDENT_NOTE}\n\nHarness facts: refusedRepeats=0 noChangeStrikes=0 degenerateFrames=0 displays=1 probe=1/1 input-proven.`;
    expect(checkComputerTaskClaims(quoted, call(FULL_CT))).toMatchObject({ unbacked: false, reason: 'backed', missingQuotes: [] });
  });

  it('a PARTIAL quote is still unbacked — the missing counters are named', () => {
    const partial = `${INCIDENT_NOTE}\n\nharness: refusedRepeats=0 noChangeStrikes=0`;
    const v = checkComputerTaskClaims(partial, call(FULL_CT));
    expect(v).toMatchObject({ unbacked: true, reason: 'counters_not_quoted' });
    expect(v.missingQuotes).toEqual(['degenerateFrames', 'displays', 'probe']);
  });

  it('the counter may be cited in prose or as `name: value` — the bar is the CITE, never the value', () => {
    for (const s of [
      'Harness: refusedRepeats=0, noChangeStrikes=0, degenerateFrames=0, displays=1, probe=1/1.',
      'harness counters refused repeats 0, no change strikes 0, degenerate frames 0, displays 1, probes run 1/1',
      'Harness: refused repeats: 0 · no-change strikes: 0 · degenerate frames: 0 · displays: unknown · probe: 1/1.',
    ]) {
      // The LAST shape quotes the counters but the third uses colons/spaces — all are quoted (displays=unknown allowed).
      expect(missingCounterQuotes(s, parseHarnessCounters(FULL_CT))).toEqual([]);
    }
    // A counter named with NO value is not a quote.
    expect(missingCounterQuotes('Harness facts were checked: refusedRepeats noChangeStrikes degenerateFrames displays probe.', parseHarnessCounters(FULL_CT)))
      .toEqual([...CORE_COUNTERS, 'probe']);
  });

  it('a result whose session ran no probes asks for the core four only — a probe quote is neither required nor harmful', () => {
    expect(checkComputerTaskClaims(INCIDENT_NOTE, call(FULL_NO_PROBE))).toMatchObject({ unbacked: true, reason: 'counters_not_quoted' });
    expect(checkComputerTaskClaims(INCIDENT_NOTE, call(FULL_NO_PROBE)).missingQuotes).toEqual([...CORE_COUNTERS]);
    // displays=unknown in the header must be quoted AS the header renders it
    const ok = `${INCIDENT_NOTE}\n\nHarness: refusedRepeats=2 noChangeStrikes=0 degenerateFrames=1 displays=unknown.`;
    expect(checkComputerTaskClaims(ok, call(FULL_NO_PROBE))).toMatchObject({ unbacked: false, reason: 'backed' });
  });

  it('a full-control result with NO harness line cannot be counter-quoted ⇒ counters_unavailable (the honest report says so)', () => {
    const v = checkComputerTaskClaims(INCIDENT_NOTE, call(FULL_NO_COUNTERS));
    expect(v).toMatchObject({ unbacked: true, reason: 'counters_unavailable', counters: null });
    expect(runHarnessCounters(call(FULL_NO_COUNTERS))).toBeNull();
    expect(renderComputerTaskClaimAnnotation(v)).toMatch(/no harness counters at all/);
    // …and a note that states the absence explicitly is quoting the fact, so it is backed.
    const honest = `${INCIDENT_NOTE}\n\nThe result carries no harness counters, so the input cannot be checked.`;
    expect(checkComputerTaskClaims(honest, call(FULL_NO_COUNTERS))).toMatchObject({ unbacked: false, reason: 'backed' });
  });

  it('the observation is unchanged where it already worked: observe-only / no call / unknown / browser_task are untouched', () => {
    expect(checkComputerTaskClaims(INCIDENT_NOTE, call(OBSERVE_OWNER))).toMatchObject({ unbacked: true, reason: 'no_input_possible' });
    expect(checkComputerTaskClaims(INCIDENT_NOTE, [])).toMatchObject({ unbacked: true, reason: 'no_computer_task_call' });
    expect(checkComputerTaskClaims(INCIDENT_NOTE, call('Tool computer_task failed: socket hang up'))).toMatchObject({ unbacked: false, reason: 'unknown_result' });
    expect(checkComputerTaskClaims(INCIDENT_NOTE, [{ type: 'tool_call', name: 'browser_task' }, { type: 'tool_result', name: 'browser_task', result: 'ok' }]))
      .toMatchObject({ unbacked: false, reason: 'browser_task_ran' });
  });

  it('the shadow row counts the gap (missingQuotes) and never carries note text', () => {
    const v = checkComputerTaskClaims(INCIDENT_NOTE, call(FULL_CT));
    const meta = computerTaskClaimMetricMeta(v, { annotated: false });
    expect(meta).toMatchObject({ unbacked: true, reason: 'counters_not_quoted', missingQuotes: 5, found: 1, totalCalls: 1, calls: { full_control: 1 } });
    expect(JSON.stringify(meta)).not.toMatch(/Drove|Tailscale|clicked|Save/);
    // not judged that way ⇒ no missingQuotes key at all (the shadow read stays clean for the older reasons)
    expect(computerTaskClaimMetricMeta(checkComputerTaskClaims(INCIDENT_NOTE, call(OBSERVE_OWNER)), { annotated: false })).not.toHaveProperty('missingQuotes');
  });

  it('an ALREADY-ANNOTATED note does not satisfy the bar with its own annotation text (the annotation is chrome)', () => {
    const first = checkComputerTaskClaims(INCIDENT_NOTE, call(FULL_CT));
    const annotated = `${INCIDENT_NOTE}\n\n${renderComputerTaskClaimAnnotation(first)}`;
    // The annotation names the counters it WANTS; it must never read as the note having quoted them.
    expect(annotated).toContain('refusedRepeats');
    expect(checkComputerTaskClaims(annotated, call(FULL_CT))).toMatchObject({ unbacked: true, reason: 'counters_not_quoted' });
  });
});
