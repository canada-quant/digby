/**
 * 2026-10-22 (owner's Fleet Supervisor chat, 21:13Z + 21:46Z) — the owner-turn unread-state line
 * (unread-state-note.ts): where the harness puts it, that it never lands inside a code fence or a follow-up
 * chip, that a model copy never doubles it, and that the history redactor strips it from model context
 * whatever the switch says. The chat-lane wiring (the re-run, when the line applies) is pinned in
 * chat-agent.service.test.ts; the grounding gate in action-verifier.production-state.2026-09-27.test.ts.
 */
import { redactGuardChrome } from '../guard-chrome-redact';
import { parseFollowUps, stripAnswerMarkup } from '../langgraph/pipeline-utils';
import { NO_ACTION_TOOL_NOTE, stripNoActionToolNote, insertNoActionToolNote } from './no-action-note';
import {
  UNREAD_STATE_NOTE, OWNER_STATE_READ_RETRY_DISABLED_ENV, ownerStateReadRetryDisabled, stripUnreadStateNote, hasUnreadStateNote,
  insertUnreadStateNote, unreadStateNoteText, unreadStateNotice, withUnreadStateNoteParts, LIVE_STATE_READ_TOOLS, unreadStateClaimProse,
} from './unread-state-note';

const ANSWER = 'GLM-5.3 is deployed on nodes 1-4 and the memory fix is live on spark-2.';

afterEach(() => { delete process.env[OWNER_STATE_READ_RETRY_DISABLED_ENV]; });

describe('unreadStateNoteText — placement', () => {
  it('appends ONE line after the last paragraph and keeps every sentence', () => {
    expect(unreadStateNoteText(ANSWER)).toBe(`${ANSWER}\n\n${UNREAD_STATE_NOTE}`);
  });

  it('goes in FRONT of a [FOLLOWUPS] block — the chips stay chips and the line stays prose', () => {
    const text = `${ANSWER}\n\n[FOLLOWUPS]\n- Read the spark-2 lane now?\n- Show the deploy receipts?\n[/FOLLOWUPS]`;
    const out = unreadStateNoteText(text)!;
    expect(out).toBe(`${ANSWER}\n\n${UNREAD_STATE_NOTE}\n\n[FOLLOWUPS]\n- Read the spark-2 lane now?\n- Show the deploy receipts?\n[/FOLLOWUPS]`);
    const parsed = parseFollowUps(out);
    expect(parsed.followUps).toHaveLength(2);
    expect(parsed.followUps.join('\n')).not.toContain('Harness check');
    expect(parsed.cleanText.endsWith(UNREAD_STATE_NOTE)).toBe(true);
  });

  it('an UNTERMINATED [FOLLOWUPS] block (parsed to the end) never swallows the line', () => {
    const out = unreadStateNoteText(`${ANSWER}\n\n[FOLLOWUPS]\n- Read the spark-2 lane now?`)!;
    const chips = parseFollowUps(out).followUps;
    expect(chips).toHaveLength(1);
    expect(chips[0]).not.toContain('Harness check');
    expect(hasUnreadStateNote(stripAnswerMarkup(out))).toBe(true);
  });

  it('never inside a code fence: a text ending in an open fence gets no line', () => {
    expect(unreadStateNoteText(`${ANSWER}\n\n\`\`\`\nnvidia-smi`)).toBeNull();
  });

  it('a placement the chip parser would swallow (the only [FOLLOWUPS] sits inside a closed fence) gets no line', () => {
    expect(unreadStateNoteText(`${ANSWER}\n\n\`\`\`\n[FOLLOWUPS]\n\`\`\`\nmore prose`)).toBeNull();
  });

  it('an empty answer gets no line', () => {
    expect(unreadStateNoteText('')).toBeNull();
    expect(unreadStateNoteText('   ')).toBeNull();
  });

  it('a model copy is dropped first — the line is never doubled', () => {
    const out = unreadStateNoteText(`${ANSWER}\n\n${UNREAD_STATE_NOTE}`)!;
    expect(out.split(UNREAD_STATE_NOTE).length - 1).toBe(1);
    expect(insertUnreadStateNote(out)).toBe(out);
  });

  it('sits beside the FSN1021 no-action line (both harness lines, both standalone)', () => {
    const withNoAction = insertNoActionToolNote(ANSWER);
    const out = unreadStateNoteText(withNoAction)!;
    expect(out).toBe(`${ANSWER}\n\n${NO_ACTION_TOOL_NOTE}\n\n${UNREAD_STATE_NOTE}`);
    expect(stripNoActionToolNote(out)).toBe(`${ANSWER}\n\n${UNREAD_STATE_NOTE}`);
    expect(stripUnreadStateNote(out)).toBe(withNoAction);
  });
});

describe('stripUnreadStateNote / the history redactor', () => {
  it('removes a standalone line and normalises only the blank lines around it', () => {
    expect(stripUnreadStateNote(`${ANSWER}\n\n${UNREAD_STATE_NOTE}`)).toBe(ANSWER);
    expect(stripUnreadStateNote(`${ANSWER}\n\n${UNREAD_STATE_NOTE}\n\n[FOLLOWUPS]\n- x y z w v?\n[/FOLLOWUPS]`)).toBe(`${ANSWER}\n\n[FOLLOWUPS]\n- x y z w v?\n[/FOLLOWUPS]`);
  });

  it('a quotation, a blockquote or a fenced copy is the model\'s own words — kept; text without the line is the same string', () => {
    const quoted = `The footer reads "${UNREAD_STATE_NOTE}".`;
    expect(stripUnreadStateNote(quoted)).toBe(quoted);
    const block = `> ${UNREAD_STATE_NOTE}`;
    expect(stripUnreadStateNote(block)).toBe(block);
    const fenced = `\`\`\`\n${UNREAD_STATE_NOTE}\n\`\`\``;
    expect(stripUnreadStateNote(fenced)).toBe(fenced);
    expect(stripUnreadStateNote(ANSWER)).toBe(ANSWER);
  });

  it('redactGuardChrome strips the stored line from model history — NOT behind the kill switch (a rollback never feeds it back as the model\'s words)', () => {
    const row = `${ANSWER}\n\n${UNREAD_STATE_NOTE}`;
    expect(redactGuardChrome(row)).toBe(ANSWER);
    process.env[OWNER_STATE_READ_RETRY_DISABLED_ENV] = '1';
    expect(ownerStateReadRetryDisabled()).toBe(true);
    expect(redactGuardChrome(row)).toBe(ANSWER);
  });

  it('redactGuardChrome strips both harness lines on one row', () => {
    expect(redactGuardChrome(`${ANSWER}\n\n${NO_ACTION_TOOL_NOTE}\n\n${UNREAD_STATE_NOTE}`)).toBe(ANSWER);
  });
});

describe('withUnreadStateNoteParts — the parts render over content, so the line sits in the same spot', () => {
  it('replaces only the LAST text part when it is the delivered answer — earlier parts are kept', () => {
    const noted = unreadStateNoteText(ANSWER)!;
    const parts = [
      { type: 'text', text: 'Checking the plan first.' },
      { type: 'tool_call', name: 'update_plan', args: {} },
      { type: 'tool_result', name: 'update_plan', result: 'ok' },
      { type: 'text', text: ANSWER },
    ];
    const out = withUnreadStateNoteParts(parts, ANSWER, noted);
    expect(out).toHaveLength(4);
    expect(out[0]).toEqual({ type: 'text', text: 'Checking the plan first.' });
    expect(out[3]).toEqual({ type: 'text', text: noted });
  });

  it('collapses the text parts into ONE noted part when the last text part is not the delivered answer (content and parts never disagree)', () => {
    const noted = unreadStateNoteText(ANSWER)!;
    const parts = [{ type: 'text', text: 'an older draft' }, { type: 'tool_call', name: 'update_plan' }];
    expect(withUnreadStateNoteParts(parts, ANSWER, noted)).toEqual([{ type: 'tool_call', name: 'update_plan' }, { type: 'text', text: noted }]);
  });
});

describe('unreadStateNotice — the harness check on the ONE re-run', () => {
  it('quotes the unread sentences (≤ 3, deduped), names the live-state reads and the honest exit', () => {
    const notice = unreadStateNotice(['GLM-5.3 is deployed on nodes 1-4.', 'GLM-5.3 is deployed on nodes 1-4.', 'The "fix" is live.', 'a', 'b']);
    expect(notice.startsWith('[HARNESS CHECK — LIVE STATE NOT READ')).toBe(true);
    expect(notice).toContain('"GLM-5.3 is deployed on nodes 1-4."');
    expect(notice).toContain("\"The 'fix' is live.\"");
    expect(notice).not.toContain('"b"');
    for (const tool of LIVE_STATE_READ_TOOLS) expect(notice).toContain(tool);
    expect(notice).toContain('not read this turn');
  });
});

// 2026-10-22 review: the matcher judges the answer's PROSE — a follow-up chip is an offer to the owner, never a claim.
describe('unreadStateClaimProse — what the live-state matcher judges', () => {
  it('drops the [FOLLOWUPS] chips, a [CANVAS] block and BOTH harness lines; the prose itself is kept', () => {
    const text = `${ANSWER}\n\n${NO_ACTION_TOOL_NOTE}\n\n${UNREAD_STATE_NOTE}\n\n[CANVAS:type=document,title=State]\nPR 1888 is deployed on main head.\n[/CANVAS]\n\n[FOLLOWUPS]\n- Is GLM-5.3 still serving on spark-2?\n- Check that PR 1888 is deployed on main head\n[/FOLLOWUPS]`;
    const prose = unreadStateClaimProse(text);
    expect(prose).toContain(ANSWER);
    for (const gone of ['still serving on spark-2', 'PR 1888', UNREAD_STATE_NOTE, NO_ACTION_TOOL_NOTE, '[FOLLOWUPS]']) expect(prose).not.toContain(gone);
  });

  it('an unterminated chip block is chrome too; a text with no chrome is unchanged', () => {
    expect(unreadStateClaimProse(`${ANSWER}\n\n[FOLLOWUPS]\n- What's running in production?`).trim()).toBe(ANSWER);
    expect(unreadStateClaimProse(ANSWER).trim()).toBe(ANSWER);
    expect(unreadStateClaimProse(undefined as any)).toBe('');
  });
});
