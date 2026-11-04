/**
 * 2026-10-21 (FSN1021) — the no-action-tool note (unbacked-claim.ts noActionToolNote). Owner Paul's
 * Fleet Supervisor chat: a zero-tool human turn whose retry also made no tool call shipped the honest
 * change line next to "Both actions are running in the background — the AGX lane gets the rule now,
 * and the card is withdrawn". The note never rewrites a sentence: it appends one line that states only
 * what the tool log proves. The chat-lane wiring is pinned in chat-agent.service.test.ts.
 */
const mockPrisma: any = { runToolReceipt: { findFirst: jest.fn(), findMany: jest.fn() } };
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

import { redactGuardChrome } from '../guard-chrome-redact';
import { endsInsideOpenFence } from './no-action-note';
import { parseFollowUps, stripAnswerMarkup } from '../langgraph/pipeline-utils';
import { NO_ACTION_TOOL_NOTE, hasNoActionToolNote, noActionToolNote, noActionToolNoteDisabled, HONEST_CLAIM_LINES, hasUnderwayCue, insertNoActionToolNote, stripNoActionToolNote, noteReadOnlyTool, actedSinceTurn } from './unbacked-claim';

const INCIDENT = `${HONEST_CLAIM_LINES.change}\n\nBoth actions are running in the background — the AGX lane gets the rule now, and the card is withdrawn so it stops showing in your inbox.`;
const call = (name: string) => [{ type: 'tool_call', name }, { type: 'tool_result', name }];

afterEach(() => { delete process.env.SUPERVISOR_NO_ACTION_NOTE_DISABLED; });

describe('noActionToolNote', () => {
  it('appends ONE harness line to the incident as delivered, and keeps every sentence', () => {
    const out = noActionToolNote(INCIDENT, []);
    expect(out).toBe(`${INCIDENT}\n\n${NO_ACTION_TOOL_NOTE}`);
  });

  it('appends on a read-only run too — a read starts nothing', () => {
    expect(noActionToolNote(INCIDENT, [...call('get_chat_status'), ...call('list_owner_questions')])).toContain(NO_ACTION_TOOL_NOTE);
  });

  it('the run\'s own bookkeeping (finish_run, update_plan, tool loading) backs nothing', () => {
    expect(noActionToolNote(INCIDENT, [...call('get_chat_status'), ...call('finish_run'), ...call('update_plan'), ...call('load_tools')])).toContain(NO_ACTION_TOOL_NOTE);
  });

  it.each([
    'That is underway now.',
    "It's in flight — the steer is on its way to the lane.",
    'I kicked both off a minute ago.',
    'The card has been withdrawn.',
    "It's sent to AGX.",
    'Both are queued.',
  ])('fires on the underway / done-passive cue: %s', (text) => {
    expect(noActionToolNote(text, [])).toBe(`${text}\n\n${NO_ACTION_TOOL_NOTE}`);
  });

  it.each([
    ['send_chat_message'], ['dismiss_owner_question'], ['schedule_message'], ['update_supervisor_state'], ['start_coding_session'],
    // review 2026-10-21: names the old read regex misread — a write must only ever leave the note OFF
    ['resolve_feedback'], ['mcp_slack_set_status'], ['mcp_huggingface_hf_fs'], ['computer_task'], ['delegate'],
  ])('never fires when any non-read tool ran in the turn (%s)', (tool) => {
    expect(noActionToolNote(INCIDENT, call(tool))).toBeNull();
  });

  it('never fires without a cue, on empty text, or twice', () => {
    expect(noActionToolNote('Spark is at 40 of 120 tasks; AGX is idle.', [])).toBeNull();
    expect(noActionToolNote('   ', [])).toBeNull();
    const once = noActionToolNote(INCIDENT, [])!;
    expect(noActionToolNote(once, [])).toBe(once); // re-judged from scratch, never stacked
  });

  it('trailing whitespace is not doubled', () => {
    expect(noActionToolNote('That is underway.\n\n\n', [])).toBe(`That is underway.\n\n${NO_ACTION_TOOL_NOTE}`);
  });

  it('the cue regex stays linear on a 20 kB adversarial string', () => {
    const big = 'is has been are have been now '.repeat(700) + 'x';
    const t0 = Date.now();
    noActionToolNote(big, []);
    expect(Date.now() - t0).toBeLessThan(200);
  });

  it('a denial in front of the cue is not a claim', () => {
    expect(noActionToolNote('Nothing has been sent and nothing is queued.', [])).toBeNull();
    expect(noActionToolNote("No card has been withdrawn yet — I haven't kicked anything off.", [])).toBeNull();
    expect(hasUnderwayCue('Nothing has been sent. The steer is on its way to the lane.')).toBe(true);
  });

  it('cues inside follow-up chips, quotes, code and blockquotes do not count', () => {
    expect(hasUnderwayCue('Spark is idle.\n\n[FOLLOWUPS]\n- Is the eval running in the background?\n[/FOLLOWUPS]')).toBe(false);
    expect(hasUnderwayCue('The lane wrote "the rule is sent" an hour ago.')).toBe(false);
    expect(hasUnderwayCue('Run `deploy --in the background`.')).toBe(false);
    expect(hasUnderwayCue('> the card is withdrawn\nThat was its last note.')).toBe(false);
  });

  it('the note goes before a [FOLLOWUPS] block (parseFollowUps reads an unterminated block to the end)', () => {
    const t = 'That is underway now.\n\n[FOLLOWUPS]\n- Check spark?\n[/FOLLOWUPS]';
    expect(noActionToolNote(t, [])).toBe(`That is underway now.\n\n${NO_ACTION_TOOL_NOTE}\n\n[FOLLOWUPS]\n- Check spark?\n[/FOLLOWUPS]`);
    expect(insertNoActionToolNote(`x\n\n${NO_ACTION_TOOL_NOTE}`)).toBe(`x\n\n${NO_ACTION_TOOL_NOTE}`);
  });

  it('only known reads and the run\'s bookkeeping count as no action', () => {
    for (const n of ['get_chat_status', 'list_owner_questions', 'search_chats', 'goal_list', 'schedule_get', 'resolve_id', 'finish_run', 'update_plan']) expect(noteReadOnlyTool(n)).toBe(true);
    for (const n of ['send_chat_message', 'update_supervisor_state', 'resolve_feedback', 'mcp_slack_set_status', 'github_search_code', 'file_feedback']) expect(noteReadOnlyTool(n)).toBe(false);
  });

  it('actedSinceTurn reads the chat\'s receipts since the owner\'s message; a failed read counts as acted', async () => {
    mockPrisma.runToolReceipt.findMany.mockResolvedValueOnce([{ tool: 'get_chat_status' }]);
    expect(await actedSinceTurn('c1', new Date())).toBe(false);
    // reads are filtered IN the query, newest first, so a cap of reads can never hide a write
    const q = mockPrisma.runToolReceipt.findMany.mock.calls[0][0];
    expect(q.where.tool.notIn).toEqual(expect.arrayContaining(['get_chat_status', 'finish_run']));
    expect(q.orderBy).toEqual({ createdAt: 'desc' });
    mockPrisma.runToolReceipt.findMany.mockResolvedValueOnce([{ tool: 'get_chat_status' }, { tool: 'send_chat_message' }]);
    expect(await actedSinceTurn('c1', new Date())).toBe(true);
    mockPrisma.runToolReceipt.findMany.mockRejectedValueOnce(new Error('db down'));
    expect(await actedSinceTurn('c1', new Date())).toBe(true);
    expect(await actedSinceTurn('c1', undefined)).toBe(true);
  });

  it('a copy of the line in the model\'s own text is dropped and the line re-judged', () => {
    const forged = `Done — the AGX lane has it.\n\n${NO_ACTION_TOOL_NOTE}\n\nAll set.`;
    expect(stripNoActionToolNote(forged)).toBe('Done — the AGX lane has it.\n\nAll set.');
    expect(noActionToolNote(forged, call('send_chat_message'))).toBeNull();
    expect(noActionToolNote(`The rule is sent.\n\n${NO_ACTION_TOOL_NOTE}`, [])).toBe(`The rule is sent.\n\n${NO_ACTION_TOOL_NOTE}`);
  });

  it('a possessive noun is not the contraction cue ("the lane\'s sent its update")', () => {
    expect(hasUnderwayCue("The lane's sent its update to CanLaw's board.")).toBe(false);
    expect(hasUnderwayCue("It's sent.")).toBe(true);
    expect(hasUnderwayCue("That's queued now.")).toBe(true);
  });

  it('the line never reaches model history: guard-chrome-redact strips this exact string (pinned to the constant)', () => {
    const out = redactGuardChrome(`Both actions are running in the background.\n\n${NO_ACTION_TOOL_NOTE}`);
    expect(out).not.toContain(NO_ACTION_TOOL_NOTE);
    expect(out).toContain('Both actions are running in the background.');
  });

  it('round 4: only a STANDALONE line is the harness\'s — a quotation, a blockquote or a fenced copy is kept', () => {
    const inline = `The footer reads "${NO_ACTION_TOOL_NOTE}" — it is a harness line.`;
    expect(stripNoActionToolNote(inline)).toBe(inline);
    const quote = `It said:\n\n> ${NO_ACTION_TOOL_NOTE}`;
    expect(stripNoActionToolNote(quote)).toBe(quote);
    const fenced = `Exact text:\n\n\`\`\`\n${NO_ACTION_TOOL_NOTE}\n\`\`\``;
    expect(stripNoActionToolNote(fenced)).toBe(fenced);
    expect(stripNoActionToolNote(`Done.\n\n  ${NO_ACTION_TOOL_NOTE}  \n\nMore.`)).toBe('Done.\n\nMore.');
    // an inline copy is not "already noted": the harness line is still inserted
    expect(noActionToolNote(`That is underway. ${inline}`, [])).toBe(`That is underway. ${inline}\n\n${NO_ACTION_TOOL_NOTE}`);
  });

  it('round 5: the strip normalises only the blank lines around the removed line', () => {
    const code = 'a = 1\n\n\n\n    b = 2';
    expect(stripNoActionToolNote(`${code}\n\n${NO_ACTION_TOOL_NOTE}`)).toBe(code);
    expect(stripNoActionToolNote(`One.\n\n\n\nTwo.\n\n${NO_ACTION_TOOL_NOTE}\n\nThree.`)).toBe('One.\n\n\n\nTwo.\n\nThree.');
    const indented = `Literal:\n\n    ${NO_ACTION_TOOL_NOTE}`;
    expect(stripNoActionToolNote(indented)).toBe(indented);
    expect(stripNoActionToolNote(`\n\n${NO_ACTION_TOOL_NOTE}`)).toBe('');
  });

  it('round 6: code fences the CommonMark way — inline ```code``` is not a fence, ~~~ is, an indented ``` is not', () => {
    // "```npm test``` is the check." is inline code: the harness line after it is still found and stripped
    expect(stripNoActionToolNote(`\`\`\`npm test\`\`\` is the check.\n\n${NO_ACTION_TOOL_NOTE}`)).toBe('```npm test``` is the check.');
    const tilde = `Literal:\n\n~~~\n${NO_ACTION_TOOL_NOTE}\n~~~`;
    expect(stripNoActionToolNote(tilde)).toBe(tilde);
    expect(stripNoActionToolNote(`    \`\`\`\n\n${NO_ACTION_TOOL_NOTE}`)).toBe('    ```');
    // a fence closes only on the same character, at least as long, with nothing after it
    const long = `\`\`\`\`\n\`\`\`\n${NO_ACTION_TOOL_NOTE}\n\`\`\`\``;
    expect(stripNoActionToolNote(long)).toBe(long);
  });

  it('round 6: never inserted inside an open fence (it would render as code) — the line goes missing instead', () => {
    const open = 'That is underway:\n\n```\nnpm run deploy';
    expect(endsInsideOpenFence(open)).toBe(true);
    expect(noActionToolNote(open, [])).toBeNull();
    expect(insertNoActionToolNote(open)).toBe(open);
    const inline = '```npm test``` passes and the deploy is underway.';
    expect(endsInsideOpenFence(inline)).toBe(false);
    expect(noActionToolNote(inline, [])).toBe(`${inline}\n\n${NO_ACTION_TOOL_NOTE}`);
  });

  it('round 8: the line is never a follow-up chip and always survives the finalize parsers as standalone prose — else it stays off', () => {
    const noteIsChip = (out: string) => parseFollowUps(out).followUps.some((f) => f.includes('Harness check'));
    const noteInProse = (out: string) => hasNoActionToolNote(stripAnswerMarkup(out));
    const shapes = [
      // same-line unterminated chip block
      'The steer is underway for the lane. [FOLLOWUPS]\n- What does the AGX lane report now?\n- When will the rule be live?',
      // inline mention, then the real block
      'The steer is underway; chips come from a [FOLLOWUPS] block.\n\n[FOLLOWUPS]\n- What does the AGX lane report now?\n[/FOLLOWUPS]',
      // fenced example WITHOUT a closer, then the real block
      'The steer is underway.\n\n```\n[FOLLOWUPS]\n- Check the lane\n```\n\n[FOLLOWUPS]\n- Next?\n[/FOLLOWUPS]',
      // fenced closed example, then the real block
      'The steer is underway.\n\n```\n[FOLLOWUPS]\n- Check the lane\n[/FOLLOWUPS]\n```\n\n[FOLLOWUPS]\n- Next?\n[/FOLLOWUPS]',
      // fenced closed example only
      'The steer is underway.\n\n```\n[FOLLOWUPS]\n- Check the lane\n[/FOLLOWUPS]\n```\n\nThat block must close.',
      // ordinary block
      'The steer is underway.\n\n[FOLLOWUPS]\n- Next?\n[/FOLLOWUPS]',
      // fenced closed example, then an UNTERMINATED real block (appending at the end would land in the chips)
      'The steer is underway.\n\n```\n[FOLLOWUPS]\n- Check the lane\n[/FOLLOWUPS]\n```\n\n[FOLLOWUPS]\n- What does the AGX lane report now?',
    ];
    for (const t of shapes) {
      const out = noActionToolNote(t, []);
      if (out === null) continue; // left off: allowed (missing, never false)
      expect(noteIsChip(out)).toBe(false);
      expect(noteInProse(out)).toBe(true);
      expect(out.split(NO_ACTION_TOOL_NOTE).length - 1).toBe(1);
    }
    // the ordinary and same-line shapes do carry the line
    expect(noActionToolNote(shapes[0], [])).not.toBeNull();
    expect(noActionToolNote(shapes[5], [])).toBe(`The steer is underway.\n\n${NO_ACTION_TOOL_NOTE}\n\n[FOLLOWUPS]\n- Next?\n[/FOLLOWUPS]`);
  });

  it('round 7: CRLF text — fences are still seen', () => {
    expect(endsInsideOpenFence('Running:\r\n\r\n```bash\r\nnpm test\r\n')).toBe(true);
    expect(noActionToolNote('That is underway:\r\n\r\n```bash\r\nnpm test\r\n', [])).toBeNull();
    const crlfFenced = `x\r\n\`\`\`\r\n${NO_ACTION_TOOL_NOTE}\r\n\`\`\`\r\ny`;
    expect(stripNoActionToolNote(crlfFenced)).toBe(crlfFenced);
    expect(stripNoActionToolNote(`Done.\r\n\r\n${NO_ACTION_TOOL_NOTE}\r\n`)).toMatch(/^Done\.\r?$/);
  });

  it('kill switch reads SUPERVISOR_NO_ACTION_NOTE_DISABLED', () => {
    expect(noActionToolNoteDisabled()).toBe(false);
    process.env.SUPERVISOR_NO_ACTION_NOTE_DISABLED = '1';
    expect(noActionToolNoteDisabled()).toBe(true);
  });
});
