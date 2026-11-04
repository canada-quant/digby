/**
 * Capability doctrine (2026-09-08 agentic expansion) — pure-leaf pins.
 *
 * What is pinned and why:
 *   - the key phrases the service suite (search-discipline.test.ts) and the
 *     playbook's readers depend on (section headings, the "This chat" line, the
 *     trigger → tool rows naming the account tools EXACTLY as registered);
 *   - the project / no-project / supervisor / anonymous variants;
 *   - the [FOLLOWUPS] markup shape — uppercase brackets + the LITERAL
 *     backslash-n sequence — which sse-adapter's live suppression and
 *     pipeline-utils parseFollowUps key on;
 *   - the per-turn prompt budgets (playbook ≤ PLAYBOOK_CHAR_BUDGET / offers ≤ 1,500 /
 *     follow-ups ≤ FOLLOWUPS_CHAR_BUDGET chars) at worst-case inputs;
 *   - that the doctrine's example action chips SURVIVE parseFollowUps
 *     (rewriteFollowUp / isLeakedReasoningFollowUp / splitCompoundFollowUp)
 *     byte-identically — an offer chip that gets rewritten or dropped is an
 *     offer the user can never tap.
 *
 * Both modules under test are import-free leaves, so no boundary mocks.
 */

import {
  platformPlaybookBlock, proactiveOffersBlock, followUpsInstruction, GUEST_SIGNUP_LINK,
  isActionChip, countActionChips,
  PLAYBOOK_HEADING, OFFERS_HEADING, PROACTIVE_OFFERS_OPTOUT_KEY, QUIET_RUN_REPLY,
  PLAYBOOK_CHAR_BUDGET, OFFERS_CHAR_BUDGET, FOLLOWUPS_CHAR_BUDGET,
} from './capability-doctrine';
import { parseFollowUps } from '../langgraph/pipeline-utils';
// memory-relevance.ts is an import-free leaf too — safe to pull in here.
import { ALWAYS_INJECT_FACT_KEYS } from '../memory-relevance';

const CHAT_ID = '0f3c2a1b-1111-2222-3333-444455556666';
const PROJECT_ID = '9e8d7c6b-1111-2222-3333-444455556666';
const LONG_TITLE = 'Comparing NVMe drives for the NAS build this weekend and beyond';

const signedIn = (over: Partial<Parameters<typeof platformPlaybookBlock>[0]> = {}) =>
  platformPlaybookBlock({ chatId: CHAT_ID, chatTitle: null, projectId: null, isSupervisor: false, hasUser: true, ...over });

describe('platformPlaybookBlock — signed-in', () => {
  it('carries the heading, the WHY, and the HOW rules', () => {
    const b = signedIn();
    expect(b.startsWith(PLAYBOOK_HEADING)).toBe(true);
    expect(PLAYBOOK_HEADING).toBe('## Doing things for the user (you operate Digby)');
    expect(b).toContain('Digby is a platform, not an answer box');
    expect(b).toContain('Read tools → just call them');
    expect(b).toContain('report the returned ids');
    expect(b).toContain('STAGES a confirmation');
    expect(b).toContain('you cannot confirm in the same turn');
    expect(b).toContain('NEVER narrate an action you did not execute');
    expect(b).toContain('citing the returned id');
    expect(b).toContain('relay any tool refusal honestly');
  });

  it('prints the "This chat" line with the chat id so tools target it without a list_chats round-trip', () => {
    expect(signedIn()).toContain(`This chat: id ${CHAT_ID}`);
    // no title → no title fragment; no project → "not in a project"; not supervisor → no note
    const plain = signedIn();
    expect(plain).not.toContain(' — title "');
    expect(plain).toContain('; not in a project.');
    expect(plain).not.toContain('fleet supervisor.');
  });

  it('project variant names the project id; supervisor variant carries the supervisor note', () => {
    const inProject = signedIn({ projectId: PROJECT_ID, chatTitle: 'NAS drives' });
    expect(inProject).toContain(`This chat: id ${CHAT_ID} — title "NAS drives"; in project ${PROJECT_ID}.`);
    expect(inProject).not.toContain('not in a project');
    const sup = signedIn({ isSupervisor: true, chatTitle: 'Fleet Supervisor' });
    expect(sup).toContain(`; not in a project; fleet supervisor.`);
  });

  it('truncates a long title with an ellipsis and ignores blank titles', () => {
    const b = signedIn({ chatTitle: LONG_TITLE });
    expect(b).toContain(' — title "Comparing NVMe drives for the…"');
    expect(b).not.toContain(LONG_TITLE);
    expect(signedIn({ chatTitle: '   ' })).not.toContain(' — title "');
  });

  it('the trigger → tool table names every account/platform tool exactly as registered', () => {
    const b = signedIn();
    for (const tool of [
      'schedule_message on this chat', 'then notify_user with the result',
      'remember_fact', 'list_memory', 'forget_fact',
      'add_knowledge_url', 'add_knowledge_note', 'create_project + move_chat', 'list_projects',
      'attach_workspace', 'start_coding_session',
      'generate_image',
      'create_share_link',
      'notify_user', 'telegram_connect_link',
      'send_email_as_digby',
      'create_project / move_chat / rename_chat / archive_chat',
      'goal_create + todo_create',
      'set_chat_instructions', 'update_project systemPrompt',
      'get_account_overview',
      'list_canvases → get_canvas → update_canvas',
      // WI-B 2026-09-25: housekeeping / self-service / read-back rows (52 tools had zero doctrine mentions)
      // (the feeds rows were retired with the feeds subsystem, 43c24152 — a
      //  retired-feed row now routes to the schedule tools)
      'pause_schedule / resume_schedule / update_schedule',
      'create_canvas', 'share_canvas', 'revoke_canvas_share', 'delete_canvas', 'revoke_share_link',
      // 92857a41: the document row names BOTH routes — create_canvas for "a document they can open"
      // (unchanged) and create_document for a downloadable FILE (md/docx/pdf/csv/xlsx, "save a file").
      'create_document (html is a canvas, never a file)',
      'add_knowledge_file', 'list_knowledge_documents', 'remove_knowledge_document',
      'list_chat_uploads → read_chat_upload', 'delete_chat_upload / delete_document', 'create_chat',
      'archive_project', 'share_project / add_project_member / remove_project_member', 'get_project',
      'get_preferences → set_preferences', 'consolidate_memory / rebuild_memory', 'memory_rebuild_status',
      'get_chat_webhook → create_chat_webhook', 'revoke_chat_webhook', 'resolve_feedback', 'get_feedback',
      'get_chat_autonomy / search_chats / list_pending_confirmations',
      'get_project / schedule_get / goal_get / todo_get / hook_list',
      'file_feedback',
    ]) {
      expect(b).toContain(tool);
    }
    // the knowledge-base row is scoped to project chats; the feedback row to Digby itself
    expect(b).toContain('project chats only');
    expect(b).toContain('never for the user\'s own project');
    // the Telegram row branches on link state
    expect(b).toMatch(/Telegram linked ⇒ notify_user[\s\S]*not linked ⇒ telegram_connect_link/);
  });

  it('lists the consequential tools including the new account ones', () => {
    const b = signedIn();
    for (const t of ['schedule_message', 'send_chat_message', 'start_coding_session', 'create_share_link', 'set_chat_autonomy']) {
      expect(b).toContain(t);
    }
    // WI-B 2026-09-25: the staged housekeeping / self-service tools are named in
    // the consequential clause too, so the model expects the card.
    const consequential = b.slice(b.indexOf('Consequential tools'), b.indexOf('NEVER narrate'));
    for (const t of ['share_canvas', 'share_project', 'add/remove_project_member', 'create_chat_webhook']) {
      expect(consequential).toContain(t);
    }
    // the read-back row says why a read follows every write
    expect(b).toContain('an update without a read-back is a claim, not evidence');
  });

  // Ticket e3113ec9 (2026-11-01): a user asked for a 60-second advertising Reel; the run
  // happily burned multiple turns producing 4 still frames + external-app prompts, and the
  // user's complaint was that the capability gap was never disclosed first («وقتی بلد نیستی
  // ویدیو بسازی چرا وقتمو می‌گیری — همون اول بگو» — "if you can't make videos, say so at the
  // START"). The doctrine must teach the FIRST-LINE disclosure: no video tool exists, offer
  // the still-image / storyboard / script / paste-ready-prompt alternatives instead, and
  // never spend turns on frames and planning before saying it.
  it('e3113ec9 replay: a VIDEO ask routes to a FIRST-LINE capability disclosure with the alternatives — never to multi-turn frame work', () => {
    const b = signedIn();
    const videoStart = b.indexOf('a VIDEO or animation');
    const videoRow = b.slice(videoStart, b.indexOf('\n', videoStart));
    expect(videoRow).toContain('say in the FIRST line that you cannot generate video');
    expect(videoRow).toContain('no video tool exists');
    expect(videoRow).toContain('none can arrive mid-conversation');
    // The alternatives the incident's run eventually offered AFTER wasting turns —
    // the row must name them so the model offers them IN the first answer.
    for (const t of ['still images via generate_image', 'a storyboard', 'a shot list', 'a script', 'ready-to-paste prompt for a video tool']) {
      expect(videoRow).toContain(t);
    }
    // The two halves of the user's complaint, as behavior rules:
    expect(videoRow).toContain('never let the user spend turns discovering the gap');
    expect(videoRow).toContain('never spend multiple turns on frames, planning or prompts before that first-line disclosure');
    // The row sits in the trigger → tool table right under the generate_image row it
    // contrasts with (the incident's run DID have generate_image — that was the trap).
    expect(b.indexOf('generate_image (it is shown in the chat')).toBeLessThan(b.indexOf('a VIDEO or animation'));
    // Both variants carry it: the incident chat was signed-in, but an anonymous Reel ask
    // must disclose too — the anonymous variant names generate_image's absence the same way.
    // (The anonymous block is a separate compact variant; the signed-in row is the doctrine
    // of record — pinned here so the row can never silently drop from the table.)
    expect(b).toMatch(/make \/ generate \/ render \/ animate a VIDEO/);
  });

  it('feeds are retired (43c24152): never in the org-mutation or requested-work lists; the retired-feed row routes to schedules', () => {
    const b = signedIn();
    const org = b.slice(b.indexOf('Organizational mutations'), b.indexOf('Requested work'));
    expect(org).toContain('(projects, moves, memory, canvases, goals/todos, instructions)');
    expect(org).not.toMatch(/feed/i);
    // The requested-work clause names no feed tool — the feeds subsystem is gone.
    const work = b.slice(b.indexOf('Requested work'), b.indexOf('Consequential tools'));
    expect(work).not.toContain('create_feed');
    expect(work).toContain('runs at once');
    expect(work).toContain('never that it is waiting on a click');
    // The trigger table routes "keep me posted / follow this topic / daily
    // digest" to schedule_message and the retired-feed row to the schedule
    // tools — never to a feed tool.
    expect(b).toContain('keep me posted / follow this topic / daily digest / topic digest → schedule_message');
    expect(b).toContain('never list_feeds / set_feed / refresh_feed / delete_feed');
    const consequential = b.slice(b.indexOf('Consequential tools'), b.indexOf('NEVER narrate'));
    expect(consequential).toContain('run from a machine turn');
    expect(consequential).toContain('aimed at ANOTHER chat');
  });

  it('names every requested-work tool in the work clause (work-tools.ts table) and no external-effect tool there', () => {
    const b = signedIn();
    const work = b.slice(b.indexOf('Requested work'), b.indexOf('Consequential tools'));
    for (const t of ['start_coding_session', 'attach_workspace', 'configure_workspace', 'import_repo', 'schedule_message', 'on THIS chat']) {
      expect(work).toContain(t);
    }
    for (const t of ['send_chat_message', 'create_share_link', 'set_chat_autonomy', 'share_project', 'create_chat_webhook']) {
      expect(work).not.toContain(t);
    }
  });
});

describe('platformPlaybookBlock — anonymous', () => {
  it('has NO account tools, names the free-account unlock in one sentence, never pretends', () => {
    const b = platformPlaybookBlock({ chatId: 'anon-abc', chatTitle: null, projectId: null, isSupervisor: false, hasUser: false });
    expect(b.startsWith(PLAYBOOK_HEADING)).toBe(true);
    expect(b).toContain('NO account tools');
    expect(b).toContain('free account');
    expect(b).toContain('Never pretend to save, schedule, or remember anything');
    // none of the signed-in machinery leaks into the anonymous variant
    expect(b).not.toContain('This chat: id');
    expect(b).not.toContain('schedule_message');
    expect(b).not.toContain('Trigger → tool');
    // 2026-09-26 (audit docs-drift-5 / docs-drift-6, merged): a guest has no
    // depth control (depth-ux.ts depthPrefToWire) and under patience_auto_only
    // the router may hand them Level 1 or 2 — never "all patience levels", never
    // a promised "two-model" shape; the copy names what they see instead.
    expect(b).not.toContain('all patience levels');
    expect(b).not.toContain('two-model');
    expect(b).toContain('Sign in for a deeper look');
  });

  it('carries the sign-up CTA link for account-only asks like recurring messages (owner 2026-09-23)', () => {
    const b = platformPlaybookBlock({ chatId: 'anon-abc', chatTitle: null, projectId: null, isSupervisor: false, hasUser: false });
    expect(GUEST_SIGNUP_LINK).toBe('[Create a free account](/login?signup=true)');
    expect(b).toContain(GUEST_SIGNUP_LINK);
    expect(b).toContain('recurring messages');
    expect(b).toContain('never withhold or water down the answer');
    expect(proactiveOffersBlock({ hasUser: false })).toContain(GUEST_SIGNUP_LINK);
  });

  it('describes guest depth honestly — no picker / Dig deeper / late corrections, never "all patience levels" (docs-drift-6, 2026-09-26)', () => {
    // Guest reality on main: the controller refuses escalationOf for !userId
    // (SIGNIN_DEEPER), answerFirst requires a chatId (guests have none), and the
    // web client shows no picker — the router picks the depth. Naming levels or
    // "all patience levels" would have the model tell a guest to raise a level
    // they cannot reach.
    const b = platformPlaybookBlock({ chatId: 'anon-abc', chatTitle: null, projectId: null, isSupervisor: false, hasUser: false });
    expect(b).toContain('whatever depth Digby picks');
    expect(b).toContain('no Dig deeper');
    expect(b).toContain('no late corrections');
    expect(b).not.toContain('all patience levels');
    expect(b).not.toContain('two-model'); // the router may hand a guest Level 1 under patience_auto_only
  });
});

describe('proactiveOffersBlock', () => {
  it('signed-in: ONE grounded offer, mirrored as a chip, with the skip/decline/off rules and examples', () => {
    const b = proactiveOffersBlock({ hasUser: true });
    expect(b.startsWith(OFFERS_HEADING)).toBe(true);
    expect(OFFERS_HEADING).toBe('## Offer the next step');
    expect(b).toContain('GENUINELY help THIS user with THIS topic');
    expect(b).toContain('ONE short plain-language offer');
    expect(b).toContain('ONE action chip in the follow-ups');
    expect(b).toContain('At most one offer per answer');
    expect(b).toContain('never delay, hedge, or replace the answer');
    expect(b).toContain('[YOUR INTEGRATION STATUS]');
    expect(b).toContain('get_account_overview');
    expect(b).toContain('never offer connecting an app that is connected');
    expect(b).toContain('never offer Telegram setup when it is linked');
    expect(b).toContain('never offer saving to a project when this chat has none');
    expect(b).toContain('trivial, one-off, emotional, or very short exchanges');
    expect(b).toContain('Never repeat an offer they declined');
    expect(b).toContain("remember_fact (key 'preferences.proactive_offers', value 'off')");
    expect(b).toContain('honor that fact whenever it is in memory');
    // 3 good + 2 bad examples
    expect(b).toContain('Good:');
    expect(b).toContain('check this again tomorrow morning and message you on Telegram');
    expect(b).toContain("save these sources to the project's knowledge base");
    expect(b).toContain('turn this into a daily feed');
    expect(b).toContain('Bad:');
    expect(b).toContain('joke');
    expect(b).toContain('status block shows it linked');
  });

  it('anonymous: at most a one-sentence free-account note, no account tools named', () => {
    const b = proactiveOffersBlock({ hasUser: false });
    expect(b.startsWith(OFFERS_HEADING)).toBe(true);
    expect(b).toContain('free account');
    expect(b).toContain('ONE sentence');
    expect(b).not.toContain('remember_fact');
    expect(b).not.toContain('notify_user');
  });

  it('grounds offers in the status block ALREADY in context; get_account_overview only for state it lacks, never to decorate an offer (review 2026-09-08)', () => {
    // The old line read "the [YOUR INTEGRATION STATUS] block / get_account_overview"
    // — with the tool's own "call this BEFORE offering" that meant a 21-query
    // snapshot round before nearly every answer, contradicting "offers never
    // delay the answer".
    const b = proactiveOffersBlock({ hasUser: true });
    expect(b).toContain('account state you ALREADY have');
    expect(b).toContain('[YOUR INTEGRATION STATUS] block in your context covers integrations + Telegram');
    // (the feeds word in this pin was retired with the feeds subsystem, 43c24152 — the offers row now reads (schedules, projects, memory))
    expect(b).toContain('call get_account_overview only for state it lacks (schedules, projects, memory)');
    expect(b).toContain('never solely to decorate an offer');
    // the old phrasing ("the [YOUR INTEGRATION STATUS] block / get_account_overview") is gone
    expect(b).not.toContain('block / get_account_overview');
  });

  it("the opt-out key it names is an ALWAYS-INJECT memory key (else the gate withholds it and the offers fire again next turn)", () => {
    expect(PROACTIVE_OFFERS_OPTOUT_KEY).toBe('preferences.proactive_offers');
    expect(proactiveOffersBlock({ hasUser: true })).toContain(`remember_fact (key '${PROACTIVE_OFFERS_OPTOUT_KEY}', value 'off')`);
    // The SAME normalization memory-relevance.ts / user-facts.service.ts apply
    // to a stored key before consulting ALWAYS_INJECT_FACT_KEYS.
    const keyNorm = PROACTIVE_OFFERS_OPTOUT_KEY.toLowerCase().replace(/[^a-z]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
    expect(keyNorm).toBe('preferences_proactive_offers');
    expect(ALWAYS_INJECT_FACT_KEYS.has(keyNorm)).toBe(true);
  });

  it('accepted offers: a WATCH cue, act on yes in THIS turn, a 1–2 sentence confirmation, quiet runs stay silent (2026-10-16)', () => {
    const b = proactiveOffersBlock({ hasUser: true });
    expect(b).toContain('is the cue for a WATCH');
    expect(b).toContain('On yes ("sure", "do it"): set it up in THIS turn');
    expect(b).toContain('when it next runs and how often (the cadence counts from now)');
    expect(b).toContain('quiet runs stay silent');
    expect(b).toContain(`reply with exactly: ${QUIET_RUN_REPLY}`);
    expect(QUIET_RUN_REPLY).toBe('Nothing new.');
    // the machine firing honours the quiet reply, still with no offers
    const m = proactiveOffersBlock({ hasUser: true, machine: true });
    expect(m).toContain(`replies "${QUIET_RUN_REPLY}"`);
    expect(m).not.toContain('Want me to');
  });

  it('MACHINE run: no offers, no action chips — nobody is on the turn to tap one (review 2026-09-08)', () => {
    const b = proactiveOffersBlock({ hasUser: true, machine: true });
    expect(b.startsWith(OFFERS_HEADING)).toBe(true); // the heading stays (service-suite pins + section order)
    expect(b).toContain('MACHINE-triggered run');
    expect(b).toContain('NO offers and NO action chips');
    expect(b).toContain('schedule/feed that produced this run');
    expect(b).toContain('notify_user only when the prompt asks');
    // none of the live-turn offer machinery leaks in
    expect(b).not.toContain('Want me to');
    expect(b).not.toContain('remember_fact');
    expect(b).not.toContain('Good:');
    // machine wins over the anonymous variant too (a wake always has a user, but fail safe)
    expect(proactiveOffersBlock({ hasUser: false, machine: true })).toBe(b);
    // and machine: false / omitted is byte-identical to the plain signed-in block
    expect(proactiveOffersBlock({ hasUser: true, machine: false })).toBe(proactiveOffersBlock({ hasUser: true }));
  });
});

describe('followUpsInstruction', () => {
  // The markup the doctrines have always shown the model: uppercase brackets
  // with the LITERAL backslash-n sequence (two characters), never a real newline.
  const MARKUP = '[FOLLOWUPS]\\n- q1\\n- q2\\n[/FOLLOWUPS]';

  it('keeps the exact [FOLLOWUPS] markup shape the sse-adapter and parseFollowUps key on', () => {
    for (const hasUser of [true, false]) {
      const line = followUpsInstruction({ hasUser });
      expect(line.startsWith('- End with 2-4 follow-ups inside a ')).toBe(true);
      expect(line).toContain(MARKUP);
      expect(line).not.toContain('\n');           // one line — no real newlines
      expect(line).not.toMatch(/\[Followups\]/);  // never the lowercase variant
    }
  });

  it('signed-in: asks for next QUESTIONS plus ONE imperative action chip in the user\'s voice', () => {
    const line = followUpsInstruction({ hasUser: true });
    expect(line).toContain('natural next QUESTIONS');
    expect(line).toContain('ONE action chip');
    expect(line).toContain("in the user's voice");
    expect(line).toContain('imperative, ≤ 80 chars');
    expect(line).toContain('"Check this again tomorrow morning and message me on Telegram"');
    expect(line).toContain('"Save this to my project\'s knowledge base"');
    expect(line).toContain('"Turn this into a daily feed"');
    expect(line).toContain('"Set up Telegram so you can message me" (only when Telegram is not linked)');
  });

  it('anonymous: questions only, no action chips', () => {
    const line = followUpsInstruction({ hasUser: false });
    expect(line).toContain('no action chips');
    expect(line).not.toContain('Telegram');
  });

  it('MACHINE run: questions only, NO action chips, same markup shape (review 2026-09-08)', () => {
    const line = followUpsInstruction({ hasUser: true, machine: true });
    expect(line.startsWith('- End with 2-4 follow-ups inside a ')).toBe(true);
    expect(line).toContain(MARKUP);
    expect(line).not.toContain('\n');
    expect(line).toContain('QUESTIONS only');
    expect(line).toContain('machine-triggered run');
    expect(line).toContain('NO action chips');
    expect(line).not.toContain('ONE action chip');
    expect(line).not.toContain('Telegram');
    expect(followUpsInstruction({ hasUser: true, machine: false })).toBe(followUpsInstruction({ hasUser: true }));
  });
});

describe('budgets (per-turn prompt cost)', () => {
  it('playbook ≤ PLAYBOOK_CHAR_BUDGET chars at worst-case inputs (uuid ids, long title, supervisor)', () => {
    expect(PLAYBOOK_CHAR_BUDGET).toBe(13_750); // ticket e3113ec9 2026-11-01: +the VIDEO capability row (first-line disclosure on a video/Reel/animation ask — no video tool exists, offer still images / storyboard / script / paste-ready prompt instead, never let the user spend turns discovering the gap; measured worst case 13,243 — budget = actual +4%) // ticket 2eef354e 2026-10-20: the webhook row gains the envKey delegated-delivery clause + the Drive watch first-class route (measured worst case 12,448 — review-corrected from a first pin of 12,437) // merge 2026-10-07 (ticket 92857a41): the 92857a41 document row + the F2 consult_frontier_council row compose — merged worst case 11,771; budget = actual +4% // 92857a41 2026-10-06: the document row names BOTH routes — create_canvas for "a document they can open" (unchanged) and create_document for a downloadable FILE (md/docx/pdf/csv/xlsx, "save a file", a named extension); measured worst case 11,563 // 2026-10-06 (F2 frontier reflection council): +the consult_frontier_council row (measured worst case 11,642) // 2026-09-28 (hand-off polish, audit CT-2): the finished-files row gains the never-poll clause (measured worst case 10,994)
    const worst = platformPlaybookBlock({ chatId: CHAT_ID, chatTitle: LONG_TITLE, projectId: PROJECT_ID, isSupervisor: true, hasUser: true });
    expect(worst.length).toBeLessThanOrEqual(PLAYBOOK_CHAR_BUDGET);
    expect(platformPlaybookBlock({ chatId: 'anon-x', chatTitle: null, projectId: null, isSupervisor: false, hasUser: false }).length).toBeLessThanOrEqual(PLAYBOOK_CHAR_BUDGET);
  });

  it('offers ≤ 1,500 chars, follow-ups line ≤ FOLLOWUPS_CHAR_BUDGET chars (both variants)', () => {
    expect(OFFERS_CHAR_BUDGET).toBe(2_425); // 2026-10-16: the watch / on-yes / quiet-run lines (see capability-doctrine.ts)
    expect(FOLLOWUPS_CHAR_BUDGET).toBe(806); // 2026-10-15 (ambition map A4, tranche 4): the hasUser line gains the altitude follow-up clause — measured 775 this run; budget = actual +4%. Prior value 600 (hasUser measured 527 before the append).
    for (const hasUser of [true, false]) {
      for (const machine of [false, true]) {
        expect(proactiveOffersBlock({ hasUser, machine }).length).toBeLessThanOrEqual(OFFERS_CHAR_BUDGET);
        expect(followUpsInstruction({ hasUser, machine }).length).toBeLessThanOrEqual(FOLLOWUPS_CHAR_BUDGET);
      }
    }
  });
});

describe('example action chips survive parseFollowUps intact', () => {
  // The doctrine's example chips, emitted exactly as the model would emit them.
  const CHIPS = [
    'Check this again tomorrow morning and message me on Telegram',
    "Save this to my project's knowledge base",
    'Turn this into a daily feed',
    'Set up Telegram so you can message me',
  ];

  it('rewriteFollowUp / isLeakedReasoningFollowUp / splitCompoundFollowUp pass each chip through byte-identically', () => {
    const text = `The answer body.\n\n[FOLLOWUPS]\n- What else should I compare?\n${CHIPS.map(c => `- ${c}`).join('\n')}\n[/FOLLOWUPS]`;
    const { followUps, cleanText } = parseFollowUps(text);
    expect(cleanText).toBe('The answer body.');
    expect(followUps).toEqual(['What else should I compare?', ...CHIPS]);
    // …and the telemetry heuristic sees exactly the four offers among them.
    expect(countActionChips(followUps)).toBe(4);
  });

  it('a chip with an internal " and " is NOT split (message is not a question-word boundary)', () => {
    const { followUps } = parseFollowUps('[FOLLOWUPS]\n- Check this again tomorrow morning and message me on Telegram\n[/FOLLOWUPS]');
    expect(followUps).toEqual(['Check this again tomorrow morning and message me on Telegram']);
  });
});

describe('isActionChip / countActionChips (telemetry heuristic)', () => {
  it('classifies by imperative first word, case-insensitively; questions are not offers', () => {
    expect(isActionChip('Check this again tomorrow')).toBe(true);
    expect(isActionChip('remember my birthday is in May')).toBe(true);
    expect(isActionChip('Schedule a weekly summary')).toBe(true);
    expect(isActionChip('Connect my GitHub account')).toBe(true);
    expect(isActionChip('What are the risks?')).toBe(false);
    expect(isActionChip('How does this compare to last year?')).toBe(false);
    expect(isActionChip('Tell me about the timeline')).toBe(false);
    expect(isActionChip('')).toBe(false);
    expect(isActionChip(null)).toBe(false);
    expect(isActionChip(42)).toBe(false);
  });

  it('counts offers in a list and tolerates garbage', () => {
    expect(countActionChips(['Save this to my project', 'What next?', 'Turn this into a daily feed'])).toBe(2);
    expect(countActionChips([])).toBe(0);
    expect(countActionChips(undefined)).toBe(0);
    expect(countActionChips('nope')).toBe(0);
  });
});

describe('task lifecycle (rule task.lifecycle — the cohesive-chat doctrine)', () => {
  it('the signed-in playbook states the contract: done in this answer or running with a visible task card, never handed back, deliverable in THIS chat', () => {
    const text = platformPlaybookBlock({ chatId: CHAT_ID, chatTitle: null, projectId: null, isSupervisor: false, hasUser: true });
    expect(text).toContain('Task lifecycle (rule task.lifecycle)');
    expect(text).toContain('either DONE in this answer, or RUNNING with a visible task card');
    // the THIRD state: an external-effect tool staged on a confirmation card — said as NOT done
    expect(text).toContain('or STAGED on a confirmation card only because the action leaves this chat');
    expect(text).toContain('say plainly it is NOT done and what the card does');
    expect(text).toContain('never handed back as a question for work the user already asked for');
    for (const phrase of ['"say the word"', '"confirm the card"', '"shall I"', '"let me know if you want me to"']) expect(text).toContain(phrase);
    expect(text).toContain('Ask a question only when you genuinely cannot proceed without the user');
    expect(text).toContain('the user gets the deliverable in THIS chat');
    expect(text).toContain('never a pointer to another tab');
    // stated once
    expect(text.split('(rule task.lifecycle)').length).toBe(2);
  });

  it('the anonymous variant carries the one-sentence form (no sub-sessions, no cards for guests)', () => {
    const text = platformPlaybookBlock({ chatId: 'anon-x', chatTitle: null, projectId: null, isSupervisor: false, hasUser: false });
    expect(text).toContain('Work you can do in this answer is DONE in it');
    expect(text).toContain('never handed back as "shall I" / "let me know if you want me to"');
    expect(text).not.toContain('task card');
  });
});
