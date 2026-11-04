/**
 * tool-preflight replay pins (consolidated) — batch-train T3i (2026-10-17).
 *
 * Consolidation of the pure (mock-free) single-ticket replay suites that
 * pin this seam — one file per ticket became one file per seam. Every
 * original suite is preserved verbatim inside its own describe() (the
 * wrapper scopes each replay's module-level consts, so replays cannot
 * collide), and every ticket id stays greppable in its describe title:
 *   crossmodel/coding/tool-preflight.022eb482.test.ts
 *   crossmodel/coding/tool-preflight.7b2a0969.test.ts
 *   crossmodel/coding/tool-preflight.adf3bd6c.test.ts
 *   crossmodel/coding/tool-preflight.bf4654d3.test.ts
 *   crossmodel/coding/tool-preflight.c5615f58.test.ts
 *   crossmodel/coding/tool-preflight.c703225a.test.ts
 *   crossmodel/coding/tool-preflight.f6ed8ea9.test.ts
 *
 * Deliberately NOT consolidated here: the agent-derail-break family (78
 * files) — each replay carries its own jest.mock bodies (file-scoped; a
 * merge would collide mock registries), so those stay one-file-per-ticket.
 *
 * jest --findRelatedTests note: the seam-name prefix is kept so a change to
 * tool-preflight.ts still selects this suite by name.
 */

import { detectIntendedTool, detectIntendedToolChannels, findUngroundedIdArgs, groundingHaystack, proseMentionsTool, ungroundedIdRefusal, uriGroundedInHaystack } from './tool-preflight';
import { PLATFORM_TOOL_NAMES } from '../platform/platform-tool-names';

// ═══════���═══════════════════════════════════════════════════════════════════
// modules/crossmodel/coding/tool-preflight.022eb482.test.ts — replay ticket 022eb482 (verbatim below, inside its own scope)
// ═══════════════════════════════════════════════════════════════════════════
describe('replay 022eb482 — consolidated from tool-preflight.022eb482.test.ts', () => {
  const OFFERED = ['edit_file', 'verify', 'run_command', 'read_file', 'update_plan'];

  describe('022eb482: filename-glued mentions are not intent evidence (conviction leg)', () => {
    it('REPLAY — the wild instance: editing verify-wave.sh must NOT convict edit_file of intending verify', () => {
      // Verbatim shape of the five guilty turns' decision sentences.
      const reasoning =
        'Continuing step 3 — applying the remaining `verify-wave.sh` edits: the node filter (count + name pending runs), the sed parsers, and the verdict branch with the symmetric downgrade knob:';
      const content = 'Three surgical edits to `verify-wave.sh`:';
      // Single-channel form:
      expect(detectIntendedTool(reasoning, 'edit_file', OFFERED)).toBeNull();
      // Two-channel form (the agent-loop call shape):
      expect(detectIntendedToolChannels(reasoning, content, 'edit_file', OFFERED)).toBeNull();
    });

    it('a genuine decision-sentence mention still convicts (containment unchanged)', () => {
      expect(detectIntendedTool('Ran the wave check on the merge. Now verify.', 'edit_file', OFFERED)).toBe('verify');
      expect(detectIntendedTool('Shell first: run_command the probe, then read it.', 'edit_file', OFFERED)).toBe(
        'run_command'
      );
    });

    it('compound forms acquit: verify.sh, re-verify, verify-wave.test.sh', () => {
      expect(detectIntendedTool('Running verify.sh against the squash now.', 'edit_file', OFFERED)).toBeNull();
      expect(detectIntendedTool('Then the re-verify pass, and we are done.', 'edit_file', OFFERED)).toBeNull();
      expect(
        detectIntendedTool('Updating verify-wave.test.sh plus the README row.', 'edit_file', OFFERED)
      ).toBeNull();
    });

    it('sentence-final, bullet, and CLI-flag forms still count (the dot/hyphen edge is only glue with an identifier on the far side)', () => {
      // "verify." at end of sentence: dot followed by end-of-string, no ident char.
      expect(detectIntendedTool('The wave landed. verify.', 'edit_file', OFFERED)).toBe('verify');
      // "- verify" bullet: hyphen preceded by whitespace, not an identifier.
      expect(detectIntendedTool('Next steps:\n- verify the suite', 'edit_file', OFFERED)).toBe('verify');
      // "--verify" CLI flag: two hyphens, not a compound word.
      expect(detectIntendedTool('Relaunch with --verify before merging.', 'edit_file', OFFERED)).toBe('verify');
    });

    it('ACQUITTAL stays broad: a called tool named inside a filename still acquits (safe direction)', () => {
      // A lane CALLING verify while its narration names verify-wave.sh (and no
      // other tool standalone) is not convicted of anything — the broad
      // acquittal legs are unchanged by the fix.
      expect(detectIntendedTool('Re-running verify-wave.sh after the fix.', 'verify', OFFERED)).toBeNull();
    });

    it('most-mentioned-wins still prefers the standalone tool when both a filename and a genuine mention appear', () => {
      // One glued verify-wave.sh mention + a standalone run_command mention:
      // only the standalone one is intent evidence.
      expect(
        detectIntendedTool('Edit verify-wave.sh, then run_command the repro.', 'edit_file', OFFERED)
      ).toBe('run_command');
    });
  });
});

// ═══════���═══════════════════════════════════════════════════════════════════
// modules/crossmodel/coding/tool-preflight.7b2a0969.test.ts — replay ticket 7b2a0969 (verbatim below, inside its own scope)
// ═══════════════════════════════════════════════════════════════════════════
describe('replay 7b2a0969 — consolidated from tool-preflight.7b2a0969.test.ts', () => {
  /** The incident narration, replayed from transcript row 984626ea: the lane
   *  names its own call in prose AND recaps the completed sibling. */
  const NARRATION = [
    'Probe sent — CID c88c4bcc. While it runs, I will register the watched resource',
    'for this window and run the schedules self-check in parallel. The list_schedules',
    'call already succeeded, so the poller state is known; the registration is next.',
  ].join(' ');

  const OFFERED = [
    'run_command', 'read_file', 'grep', 'list_schedules', 'register_watched_resource',
    'observe_resource', 'list_projects', 'update_plan',
  ];

  describe('replay 7b2a0969 — register_watched_resource({projectId:"cql-litellm-gateway"})', () => {
    it('convicts the invented slug exactly as on 2026-09-23 (the guard half — TRUE POSITIVE, unchanged)', () => {
      const haystack = groundingHaystack([
        { role: 'system', content: 'You are the LiteLLM gateway ALERT POLLER for project "CQL LiteLLM Gateway" (chat 7a8913e9-a162-40a5-8a96-2a1f252b1287).' },
        { role: 'tool', content: '{"ok":true,"schedules":[{"id":"df90b784","runs":164}]}' },
      ]);
      expect(findUngroundedIdArgs({ projectId: 'cql-litellm-gateway', label: 'swap window' }, haystack))
        .toEqual([{ key: 'projectId', value: 'cql-litellm-gateway' }]);
    });

    it('a REAL project id from a list_projects row is never convicted (shape rule)', () => {
      expect(findUngroundedIdArgs({ projectId: '8f2c1a90-1234-4abc-9def-0123456789ab', label: 'x' }, '')).toEqual([]);
      expect(findUngroundedIdArgs({ projectId: '8f2c1a90', label: 'x' }, '')).toEqual([]);
    });

    it('proseMentionsTool: the incident narration names register_watched_resource in prose', () => {
      expect(proseMentionsTool(NARRATION, 'register_watched_resource')).toBe(true);
      expect(proseMentionsTool('I will register the watched resource for this window.', 'register_watched_resource')).toBe(true);
      // The cea13871 boundary: INFLECTED forms do NOT acquit ("verifying the
      // durable stamps" is weaker evidence than the announce-form — that leg's
      // intent weight is adjudicated-correct behavior, pinned in its own test).
      expect(proseMentionsTool('search_memory has the artifact refs — verifying the durable stamps now.', 'verify_durable')).toBe(false);
    });

    it('proseMentionsTool: the 12-word window is a real boundary (review N3)', () => {
      // 10 stopword fillers between "register" and "watched": the span from the
      // first to the last token word is 12 positions (wi-start ≤ 12) → inside.
      const inside = `register ${Array(10).fill('the').join(' ')} watched resource`;
      expect(proseMentionsTool(inside, 'register_watched_resource')).toBe(true);
      // 11 fillers: the last token would land at wi-start = 13 > 12 → outside.
      const outside = `register ${Array(11).fill('the').join(' ')} watched resource`;
      expect(proseMentionsTool(outside, 'register_watched_resource')).toBe(false);
    });

    it('ALIAS self-naming acquits (review N1): "call triage_ticket" names update_feedback under the 2026-09-22 rename', () => {
      // The emitted name internalizes to update_feedback (agent.ts:2190) while
      // the model was OFFERED the model-facing spelling triage_ticket. A lane
      // faithfully narrating its own call must not be convicted of intending a
      // different tool — nor self-redirected to the tool it is already calling.
      expect(detectIntendedTool('I will call triage_ticket with the real ticket id now.', 'update_feedback', ['update_feedback', 'run_command', 'list_schedules'])).toBeNull();
      // A GENUINE wrong-tool emission still convicts.
      expect(detectIntendedTool('search_memory first for the prior verdict, then write.', 'update_feedback', ['update_feedback', 'run_command', 'search_memory'])).toBe('search_memory');
      // DELIBERATE boundary: only the EXACT alias identifier acquits — the
      // alias's PROSE form ("triage the ticket") does NOT: triage/ticket are a
      // ticket lane's domain vocabulary, far too common to ground an acquittal.
      expect(detectIntendedTool('Triaging the ticket row next; but first search_memory for the prior ruling.', 'update_feedback', ['update_feedback', 'search_memory'])).toBe('search_memory');
    });

    it('proseMentionsTool: negatives — unrelated words, out-of-order, overlong gaps, one-word tools', () => {
      expect(proseMentionsTool('The watched resource window is 30 minutes long.', 'register_watched_resource')).toBe(false); // "register" absent
      expect(proseMentionsTool('The resource watched register order was reversed.', 'register_watched_resource')).toBe(false); // wrong order
      expect(proseMentionsTool('register … then much later, after several unrelated words fill the gap of words here, the watched resource', 'register_watched_resource')).toBe(false); // window exceeded
      expect(proseMentionsTool('grep the config now', 'grep')).toBe(false); // one-word tool: prose form IS the identifier — literal check owns it
    });

    it('THE FIX: detectIntendedTool acquits the prose-named call — no intent weight, no wrong redirect', () => {
      // Before the fix this returned 'list_schedules' (the recapped sibling),
      // supplying the +1 that tripped the breaker on ONE refusal.
      expect(detectIntendedTool(NARRATION, 'register_watched_resource', OFFERED)).toBeNull();
    });

    it('the literal self-naming acquittal still holds (regression guard on the original seam)', () => {
      expect(detectIntendedTool('Calling register_watched_resource with the real project id now.', 'register_watched_resource', OFFERED)).toBeNull();
    });

    it('a GENUINE wrong-tool emission still convicts — the fast-trip class is NOT weakened', () => {
      // No prose or literal naming of the called tool; a different offered tool named.
      const wrongToolNarration = 'Shell first: run_command "aws s3 ls" to confirm the upload, then stamp durability.';
      expect(detectIntendedTool(wrongToolNarration, 'verify_durable', OFFERED)).toBe('run_command');
    });

    it('replays the incident refusal: the projectId recovery path is now named (the c5615f58 pattern)', () => {
      const refusal = JSON.parse(
        ungroundedIdRefusal('register_watched_resource', [{ key: 'projectId', value: 'cql-litellm-gateway' }], null),
      );
      expect(refusal).toMatchObject({
        ok: false,
        tool: 'register_watched_resource',
        reason: 'ungrounded_id',
        rejected: [{ key: 'projectId', value: 'cql-litellm-gateway' }],
      });
      expect(refusal.message).toContain('list_projects');
      expect(refusal.message).toContain('NAME or slug is not an id');
      expect(refusal.message).toContain('defaults to the current project');
      // With the fix, intended is null for this incident's narration — the
      // "you evidently meant list_schedules" misdiagnosis is gone.
      expect(refusal.message).not.toContain('evidently meant');
    });

    it('non-project refusals stay unchanged — no list_projects detour for chat/ticket ids', () => {
      const refusal = JSON.parse(ungroundedIdRefusal('update_feedback', [{ key: 'id', value: 'noop' }], 'run_command'));
      expect(refusal.message).not.toContain('list_projects');
      expect(refusal.message).toContain('run_command'); // intent redirect untouched
      const chatRefusal = JSON.parse(ungroundedIdRefusal('get_chat_messages', [{ key: 'chatId', value: 'this-chat' }], null));
      expect(chatRefusal.message).toContain('list_chats');
      expect(chatRefusal.message).not.toContain('list_projects');
    });

    it('wiring seam: register_watched_resource stays a preflight-covered platform tool, list_projects stays offered', () => {
      // agent.ts only runs the ungrounded-id preflight for PLATFORM_TOOL_NAMES —
      // a regression dropping either name would silently re-arm the incident
      // (with no recovery path offered).
      expect(PLATFORM_TOOL_NAMES).toContain('register_watched_resource');
      expect(PLATFORM_TOOL_NAMES).toContain('list_projects');
    });
  });
});

// ═══════���═══════════════════════════════════════════════════════════════════
// modules/crossmodel/coding/tool-preflight.adf3bd6c.test.ts — replay ticket adf3bd6c (verbatim below, inside its own scope)
// ═══════════════════════════════════════════════════════════════════════════
describe('replay adf3bd6c — consolidated from tool-preflight.adf3bd6c.test.ts', () => {
  describe('replay adf3bd6c — update_feedback({id:"noop-intentional-invalid"})', () => {
    // What the Path-C monitor lane could legitimately have read in firing 194:
    // its schedule prompt cites ticket ids in prose (3892de13 = the evidence-
    // discipline mandate; d0597e02 = the claims-fence guard) and tool results
    // carry real schedule ids — but never the literal placeholder token.
    const briefAndToolText = [
      'EVIDENCE DISCIPLINE (fleet-mandated ticket 3892de13; hardened 20a340cd/bd5eeacc/e8507f9a — non-negotiable)',
      'GUARD-RECURRENCE (ticket d0597e02): the ```claims fence is model-authored, NEVER tool output',
      'RENEWAL: list_schedules each firing; if <48h of firings left, schedule_get this schedule\'s own id',
      'list_schedules → [{"id":"39346220-5538-4c38-95da-04da67b90dd3","kind":"recurring","status":"active"}]',
      'schedule_get → {"id":"39346220-5538-4c38-95da-04da67b90dd3","promptSha256":"a469fb9284d6"}',
    ].join('\n');

    it('refuses the verbatim incident placeholder exactly as on 2026-09-14', () => {
      expect(findUngroundedIdArgs({ id: 'noop-intentional-invalid', status: 'done' }, briefAndToolText))
        .toEqual([{ key: 'id', value: 'noop-intentional-invalid' }]);
    });

    it("the lane's own narration of the placeholder cannot self-ground it (assistant turns excluded)", () => {
      const messages = [
        { role: 'user', content: briefAndToolText },
        // The lane narrated the token around the derailed call (its disclosure:
        // "one update_feedback with a fabricated placeholder id") — assistant
        // turns are excluded from the haystack BY DESIGN, so a placeholder the
        // model just invented in its own reasoning stays ungrounded at the call.
        { role: 'assistant', content: 'I will no-op update_feedback with id noop-intentional-invalid here.' },
        { role: 'tool', content: 'schedule_get → {"id":"39346220-5538-4c38-95da-04da67b90dd3"}' },
      ];
      const haystack = groundingHaystack(messages);
      expect(haystack).not.toContain('noop-intentional-invalid');
      expect(findUngroundedIdArgs({ id: 'noop-intentional-invalid' }, haystack))
        .toEqual([{ key: 'id', value: 'noop-intentional-invalid' }]);
    });

    it('the placeholder family has no shape-rule escape on the id arg', () => {
      for (const v of [
        'noop-intentional-invalid', // this incident
        'noop-audit-placeholder',   // f95bd4c8
        'noop',                     // 03e8cd3d
        'placeholder',
        'INTENTIONALLY_INVALID',
        'TBD',
        'N/A',
      ]) {
        expect(findUngroundedIdArgs({ id: v }, briefAndToolText)).toEqual([{ key: 'id', value: v }]);
      }
    });

    it('no false positive on a REAL ticket id (uuid shape and 8-hex citation prefix ground unconditionally)', () => {
      expect(findUngroundedIdArgs({ id: 'adf3bd6c-9f90-4927-bf84-2504ea93f832', status: 'done' }, '')).toEqual([]);
      expect(findUngroundedIdArgs({ id: 'adf3bd6c' }, '')).toEqual([]);
    });

    it('a ticket id cited verbatim in the brief is grounded (the 3892de13 side-effect path — by design)', () => {
      // Firing 194's update_feedback on 3892de13 EXECUTED because the id occurs
      // verbatim in the lane's schedule prompt ("fleet-mandated ticket
      // 3892de13"). That grounding rule is INTENTIONAL — dispatch briefs cite
      // the tickets a lane must work — so pin it: a future "tightening" that
      // convicts brief-cited ids would break the dispatch contract silently.
      expect(findUngroundedIdArgs({ id: '3892de13', status: 'done' }, briefAndToolText)).toEqual([]);
    });

    it('replays the exact refusal envelope: ungrounded_id, rejected id arg, schedule_get redirect, no chat recovery suffix', () => {
      const refusal = JSON.parse(
        ungroundedIdRefusal('update_feedback', [{ key: 'id', value: 'noop-intentional-invalid' }], 'schedule_get'),
      );
      expect(refusal).toMatchObject({
        ok: false,
        tool: 'update_feedback',
        reason: 'ungrounded_id',
        rejected: [{ key: 'id', value: 'noop-intentional-invalid' }],
      });
      expect(refusal.message).toContain('NOT EXECUTED');
      expect(refusal.message).toContain('id="noop-intentional-invalid"');
      expect(refusal.message).toContain('not an id you obtained this run');
      expect(refusal.message).toContain('never from narration');
      expect(refusal.message).toContain(
        'Your reasoning named schedule_get — you evidently meant to call schedule_get; call it now with its real parameters.',
      );
      // Key is `id`, not a chat arg — the c5615f58 chat recovery path stays
      // OUT of this envelope (the ticket's quoted text ends at "parameters.").
      expect(refusal.message).not.toContain('list_chats');
    });
  });
});

// ═══════���═══════════════════════════════════════════════════════════════════
// modules/crossmodel/coding/tool-preflight.bf4654d3.test.ts — replay ticket bf4654d3 (verbatim below, inside its own scope)
// ═══════════════════════════════════════════════════════════════════════════
describe('replay bf4654d3 — consolidated from tool-preflight.bf4654d3.test.ts', () => {
  /** The cec340f2 incident shape: the run's own aws s3 ls output names the
   *  bucket and the checkpoint artifact, but never the assembled final path. */
  const S3_LS_HAYSTACK = [
    'aws s3 ls s3://digby-checkpoints/run-42/ --recursive',
    '2026-09-30 14:02  812345  run-42/post-cpt-resequencing-0003.pt',
  ].join('\n');

  const INCIDENT_URI = 's3://digby-checkpoints/run-42/post-cpt-resequencing-0003.pt';

  describe('tool-preflight uri grounding (ticket bf4654d3)', () => {
    it('REPLAY: an S3 uri assembled from the run\'s own s3-ls output is NOT ungrounded', () => {
      // Pre-fix this returned [{ key: 'id', value: INCIDENT_URI }] and the
      // verify_durable call was refused as an invented id (the mishap).
      expect(findUngroundedIdArgs({ id: INCIDENT_URI }, S3_LS_HAYSTACK)).toEqual([]);
    });

    it('a uri echoed back verbatim (register_artifact result) stays grounded', () => {
      const echo = `Registered checkpoint "post-cpt" at ${INCIDENT_URI}. Verify it durable…`;
      expect(findUngroundedIdArgs({ id: INCIDENT_URI }, echo)).toEqual([]);
      expect(uriGroundedInHaystack(INCIDENT_URI, echo)).toBe(true);
    });

    it('a bucket from the haystack PLUS a fabricated segment stays UNGROUNDED', () => {
      const invented = 's3://digby-checkpoints/run-42/hallucinated-artifact-name.pt';
      expect(findUngroundedIdArgs({ id: invented }, S3_LS_HAYSTACK)).toEqual([
        { key: 'id', value: invented },
      ]);
    });

    it('a uri whose bucket never appears in the haystack stays UNGROUNDED', () => {
      const foreign = 's3://some-other-bucket/post-cpt-resequencing-0003.pt';
      expect(findUngroundedIdArgs({ id: foreign }, S3_LS_HAYSTACK)).toEqual([
        { key: 'id', value: foreign },
      ]);
    });

    it('groundingHaystack + findUngroundedIdArgs together: the full tool-result path grounds the call', () => {
      const messages = [
        { role: 'user', content: 'verify the checkpoint is durable' },
        { role: 'assistant', content: JSON.stringify({ id: INCIDENT_URI }) }, // excluded on purpose
        { role: 'tool', content: S3_LS_HAYSTACK },
      ];
      expect(findUngroundedIdArgs({ id: INCIDENT_URI }, groundingHaystack(messages))).toEqual([]);
    });

    it('HARDENING (adversarial review): a common-word authority grounds nothing', () => {
      // "https://am/pp" was grounded by the prose word "am" — the authority half
      // must be a real host/bucket, not a dictionary word that occurs anywhere.
      expect(findUngroundedIdArgs({ id: 'https://am/pp' }, 'the letter am appears here')).toEqual([
        { key: 'id', value: 'https://am/pp' },
      ]);
      expect(findUngroundedIdArgs({ id: 'https://localhost/runs' }, 'run it on localhost please')).toEqual([
        { key: 'id', value: 'https://localhost/runs' },
      ]);
    });

    it('HARDENING (adversarial review): an all-short-segment path is NOT grounded by its bucket alone', () => {
      // The vacuous every() over zero qualifying segments grounded this shape;
      // a path with nothing ≥4 chars verified nothing.
      expect(findUngroundedIdArgs({ id: 's3://digby-checkpoints/a/b' }, S3_LS_HAYSTACK)).toEqual([
        { key: 'id', value: 's3://digby-checkpoints/a/b' },
      ]);
    });

    it('HARDENING (adversarial review): unattested schemes never decompose — verbatim or refuse', () => {
      expect(findUngroundedIdArgs({ id: 'file:///etc/passwd' }, 'file etc passwd words here')).toEqual([
        { key: 'id', value: 'file:///etc/passwd' },
      ]);
    });

    it('NON-uri behaviour is unchanged: narration tokens are still convicted', () => {
      // Regression guard for the original derailment class this module exists
      // for — placeholder/narration ids must keep being refused.
      expect(findUngroundedIdArgs({ id: 'noop' }, 'the decision gate purpose supervisor_turn_noop')).toEqual([
        { key: 'id', value: 'noop' },
      ]);
      expect(findUngroundedIdArgs({ id: 'BREAKING_NOW' }, S3_LS_HAYSTACK)).toEqual([
        { key: 'id', value: 'BREAKING_NOW' },
      ]);
    });
  });
});

// ═══════���═══════════════════════════════════════════════════════════════════
// modules/crossmodel/coding/tool-preflight.c5615f58.test.ts — replay ticket c5615f58 (verbatim below, inside its own scope)
// ═══════════════════════════════════════════════════════════════════════════
describe('replay c5615f58 — consolidated from tool-preflight.c5615f58.test.ts', () => {
  describe('replay c5615f58 — get_chat_messages({chatId:"this-chat"})', () => {
    // What the lane could legitimately have read: its own context carries "THIS CHAT"
    // prose + a real uuid, and a list_chats result carries the TARGET chat's title —
    // but never the literal token "this-chat".
    const haystack = [
      'THIS CHAT id: cec340f2-f605-4370-b87a-d85b59cb243f — you are running in this chat.',
      'list_chats → [{"id":"9aa4c211-1111-4222-8333-555555555555","title":"Re-Send Path C Phase 2 Kickoff","running":true}]',
      'user: check what the kickoff session concluded',
    ].join('\n');

    it('refuses the invented placeholder chatId exactly as on 2026-09-12', () => {
      expect(findUngroundedIdArgs({ chatId: 'this-chat' }, haystack)).toEqual([{ key: 'chatId', value: 'this-chat' }]);
    });

    it('the placeholder is not saved by the id-shape rule (hex/uuid/digit prefixes only)', () => {
      expect(findUngroundedIdArgs({ chatId: 'this-chat' }, '')).toEqual([{ key: 'chatId', value: 'this-chat' }]);
    });

    it('no false positive on the real chat ids the lane actually held', () => {
      expect(findUngroundedIdArgs({ chatId: 'cec340f2-f605-4370-b87a-d85b59cb243f' }, '')).toEqual([]); // shape
      expect(findUngroundedIdArgs({ chatId: '9aa4c211-1111-4222-8333-555555555555' }, '')).toEqual([]); // shape
    });

    it('replays the exact refusal envelope: ungrounded_id, the rejected arg, the intent redirect', () => {
      const refusal = JSON.parse(
        ungroundedIdRefusal('get_chat_messages', [{ key: 'chatId', value: 'this-chat' }], 'list_schedules'),
      );
      expect(refusal).toMatchObject({
        ok: false,
        tool: 'get_chat_messages',
        reason: 'ungrounded_id',
        rejected: [{ key: 'chatId', value: 'this-chat' }],
      });
      expect(refusal.message).toContain('NOT EXECUTED');
      expect(refusal.message).toContain('list_schedules'); // the narration-implied tool, preserved
    });

    it('the refusal now names the chat recovery path (the c5615f58 fix)', () => {
      const refusal = JSON.parse(
        ungroundedIdRefusal('get_chat_messages', [{ key: 'chatId', value: 'this-chat' }], 'list_schedules'),
      );
      expect(refusal.message).toContain('list_chats');
      expect(refusal.message).toContain('TITLE is not an id');
    });

    it('the chat hint fires for every *ChatId arg shape (sourceChatId/targetChatId/…)', () => {
      const refusal = JSON.parse(
        ungroundedIdRefusal('hook_subscribe', [
          { key: 'sourceChatId', value: 'that-chat' },
          { key: 'targetChatId', value: 'the-supervisor' },
        ], null),
      );
      expect(refusal.message).toContain('list_chats');
    });

    it('non-chat refusals stay unchanged — no list_chats detour for ticket/goal ids', () => {
      const refusal = JSON.parse(ungroundedIdRefusal('update_feedback', [{ key: 'id', value: 'noop' }], 'run_command'));
      expect(refusal.message).not.toContain('list_chats');
      expect(refusal.message).toContain('run_command'); // intent redirect untouched
    });

    it('wiring seam: get_chat_messages stays a preflight-covered platform tool, list_chats stays offered', () => {
      // agent.ts:2194 only runs the ungrounded-id preflight for PLATFORM_TOOL_NAMES —
      // a regression removing get_chat_messages would silently re-arm the incident.
      expect(PLATFORM_TOOL_NAMES).toContain('get_chat_messages');
      expect(PLATFORM_TOOL_NAMES).toContain('list_chats');
    });
  });
});

// ═══════���═══════════════════════════════════════════════════════════════════
// modules/crossmodel/coding/tool-preflight.c703225a.test.ts — replay ticket c703225a (verbatim below, inside its own scope)
// ═══════════════════════════════════════════════════════════════════════════
describe('replay c703225a — consolidated from tool-preflight.c703225a.test.ts', () => {
  describe('replay c703225a — get_chat_messages({chatId:"THIS_CHAT"})', () => {
    // What the lane could legitimately have read: its own context carries "THIS
    // CHAT" prose + real uuids, and tool results carry real ids — but never the
    // literal token "THIS_CHAT" (mirrors the c5615f58 haystack shape).
    const haystack = [
      '[PREVIOUS RUNS IN THIS CHAT — what earlier runs set out to do, decided, and learned; newest first]',
      'THIS CHAT id: cec340f2-f605-4370-b87a-d85b59cb243f — you are running in this chat.',
      'list_chats → [{"id":"9aa4c211-1111-4222-8333-555555555555","title":"Re-Send Path C Phase 2 Kickoff","running":true}]',
      'todo_get → {"todoId":"0a7f2a5e-real-todo"}',
    ].join('\n');

    it('refuses the invented THIS_CHAT placeholder exactly as on 2026-09-14', () => {
      expect(findUngroundedIdArgs({ chatId: 'THIS_CHAT' }, haystack)).toEqual([{ key: 'chatId', value: 'THIS_CHAT' }]);
    });

    it('placeholder case/separator variants are refused too (no shape-rule escape)', () => {
      for (const v of ['THIS_CHAT', 'this_chat', 'this-chat', 'THIS-CHAT', 'ThisChat']) {
        expect(findUngroundedIdArgs({ chatId: v }, haystack)).toEqual([{ key: 'chatId', value: v }]);
      }
    });

    it('no false positive on the real ids the lane actually held (self + target)', () => {
      expect(findUngroundedIdArgs({ chatId: 'cec340f2-f605-4370-b87a-d85b59cb243f' }, '')).toEqual([]); // shape
      expect(findUngroundedIdArgs({ chatId: '9aa4c211-1111-4222-8333-555555555555' }, haystack)).toEqual([]); // shape + haystack
    });

    it('replays the exact refusal envelope: ungrounded_id, rejected arg, todo_get redirect, chat recovery path', () => {
      const refusal = JSON.parse(
        ungroundedIdRefusal('get_chat_messages', [{ key: 'chatId', value: 'THIS_CHAT' }], 'todo_get'),
      );
      expect(refusal).toMatchObject({
        ok: false,
        tool: 'get_chat_messages',
        reason: 'ungrounded_id',
        rejected: [{ key: 'chatId', value: 'THIS_CHAT' }],
      });
      expect(refusal.message).toContain('NOT EXECUTED');
      expect(refusal.message).toContain('todo_get'); // the narration-implied tool, preserved (as in the ticket text)
      expect(refusal.message).toContain('list_chats'); // the c5615f58 recovery-path fix firing on the new placeholder shape
      expect(refusal.message).toContain('TITLE is not an id');
      expect(refusal.message).toContain("your own session's chat id");
    });
  });
});

// ═══════���═══════════════════════════════════════════════════════════════════
// modules/crossmodel/coding/tool-preflight.f6ed8ea9.test.ts — replay ticket f6ed8ea9 (verbatim below, inside its own scope)
// ═══════════════════════════════════════════════════════════════════════════
describe('replay f6ed8ea9 — consolidated from tool-preflight.f6ed8ea9.test.ts', () => {
  describe('replay f6ed8ea9 — update_schedule({id:"noop-do-not-call"})', () => {
    // What the Post-CPT coordination lane could legitimately have read in run
    // ba76b215: its firing brief names coordination steps, and list_schedules
    // rows carry REAL schedule ids (uuids) — but never the literal placeholder.
    const briefAndToolText = [
      'POST-CPT COORDINATION — SFT/GRPO/GSPO: reconcile trainer schedules; get_account_overview for fleet spend state before edits.',
      'list_schedules → [{"id":"7c9e2b41-0f5a-4c2d-9e31-2a6d8f0b1c44","kind":"recurring","status":"active"}]',
      'schedule_get → {"id":"7c9e2b41-0f5a-4c2d-9e31-2a6d8f0b1c44","promptSha256":"b5f1a2c3d4e5"}',
    ].join('\n');

    it('refuses the verbatim incident placeholder exactly as on 2026-09-14', () => {
      expect(findUngroundedIdArgs({ id: 'noop-do-not-call' }, briefAndToolText))
        .toEqual([{ key: 'id', value: 'noop-do-not-call' }]);
    });

    it("the lane's own narration of the placeholder cannot self-ground it (assistant turns excluded)", () => {
      const messages = [
        { role: 'user', content: briefAndToolText },
        // The lane narrated around the derailed call (its reasoning trail named
        // get_account_overview) — assistant turns are excluded from the
        // haystack BY DESIGN, so a placeholder the model just invented in its
        // own reasoning stays ungrounded at the call.
        { role: 'assistant', content: 'I should call update_schedule with id noop-do-not-call after get_account_overview.' },
        { role: 'tool', content: 'schedule_get → {"id":"7c9e2b41-0f5a-4c2d-9e31-2a6d8f0b1c44"}' },
      ];
      const haystack = groundingHaystack(messages);
      expect(haystack).not.toContain('noop-do-not-call');
      expect(findUngroundedIdArgs({ id: 'noop-do-not-call' }, haystack))
        .toEqual([{ key: 'id', value: 'noop-do-not-call' }]);
    });

    it('the placeholder family has no shape-rule escape on the id arg', () => {
      for (const v of [
        'noop-do-not-call',         // this incident
        'noop-intentional-invalid', // adf3bd6c
        'noop-audit-placeholder',   // f95bd4c8
        'nonexistent-test-noop',    // ad0ebb8b
        'noop',                     // 03e8cd3d
        'placeholder',
        'INTENTIONALLY_INVALID',
        'TBD',
        'N/A',
      ]) {
        expect(findUngroundedIdArgs({ id: v }, briefAndToolText)).toEqual([{ key: 'id', value: v }]);
      }
    });

    it('real schedule ids can never be convicted: uuid + 8-hex prefix shapes, and verbatim-seen ids', () => {
      // Shape-rule exemption (ID_SHAPE_RE ^[0-9a-f]{8}): never even checked
      // against the haystack.
      expect(findUngroundedIdArgs({ id: '7c9e2b41-0f5a-4c2d-9e31-2a6d8f0b1c44' }, '')).toEqual([]);
      expect(findUngroundedIdArgs({ id: '7c9e2b41' }, '')).toEqual([]);
      // Non-hex-shaped but VERBATIM-PRESENT in what the lane read: grounded.
      const seen = `${briefAndToolText}\nupdate_schedule → {"ok":true,"id":"sched-post-cpt-nightly"}`;
      expect(findUngroundedIdArgs({ id: 'sched-post-cpt-nightly' }, seen)).toEqual([]);
    });

    it('intent detection names get_account_overview from the lane\'s own reasoning, exactly as the ticket quotes', () => {
      // The incident's reasoning trail named get_account_overview (never the
      // called tool) → the steer fires.
      const reasoning =
        'The fleet state is stale; I need get_account_overview before touching any schedule. get_account_overview first.';
      expect(detectIntendedTool(reasoning, 'update_schedule', ['update_schedule', 'get_account_overview', 'list_schedules']))
        .toBe('get_account_overview');
    });

    it('ambiguity guard: reasoning that ALSO names the called tool gets NO steer (null), by design', () => {
      // detectIntendedTool returns null when the narration mentions the called
      // tool — no intent mismatch is asserted on an ambiguous trail, so the
      // refusal falls back to the generic "call the tool that advances the
      // task" sentence rather than mis-steering.
      const reasoning = 'get_account_overview is stale, then update_schedule can pause the GRPO lane.';
      expect(detectIntendedTool(reasoning, 'update_schedule', ['update_schedule', 'get_account_overview', 'list_schedules']))
        .toBeNull();
    });

    it('the refusal envelope matches the ticket-quoted text char-for-char (no chat recovery suffix)', () => {
      const refusal = JSON.parse(
        ungroundedIdRefusal('update_schedule', [{ key: 'id', value: 'noop-do-not-call' }], 'get_account_overview'),
      );
      expect(refusal.ok).toBe(false);
      expect(refusal.tool).toBe('update_schedule');
      expect(refusal.reason).toBe('ungrounded_id');
      expect(refusal.rejected).toEqual([{ key: 'id', value: 'noop-do-not-call' }]);
      expect(refusal.message).toContain('id="noop-do-not-call"');
      expect(refusal.message).toContain('not an id you obtained this run');
      expect(refusal.message).toContain('never from narration');
      expect(refusal.message).toContain(
        'Your reasoning named get_account_overview — you evidently meant to call get_account_overview; call it now with its real parameters.',
      );
      // Key is `id`, not a chat arg — the c5615f58 chat recovery path stays
      // OUT of this envelope (the ticket's quoted text ends at "parameters.").
      expect(refusal.message).not.toContain('list_chats');
    });
  });

  /* ── Ticket ad0ebb8b — update_schedule({id:"nonexistent-test-noop"}) ──────────
   *
   * THE INCIDENT (auto-filed at breaker trip 2026-09-23T00:02Z, session
   * c0e22e36-1c74-4295-8049-9b48335c6c37 "Fleet Supervisor"): one call —
   *   update_schedule({id:"nonexistent-test-noop"})
   * — with the lane's reasoning naming get_chat_messages. The deterministic
   * pre-flight refused it as ungrounded_id with the get_chat_messages redirect,
   * and the weighted-3 fast trip (ungrounded +1, intent mismatch +1, failure
   * shape +1) auto-filed the "3× tool-failure streak" ticket.
   *
   * ADJUDICATION (engineering lane, 2026-09-23, fresh code reads + repo grep):
   * MODEL behavior — the seventh recurrence of the placeholder-emission class
   * (f6ed8ea9 lineage: 03e8cd3d / c5615f58 / c703225a / f95bd4c8 / adf3bd6c /
   * 13b2f286 — this one the exact 13b2f286 signature: same called tool
   * update_schedule, same intended tool get_chat_messages). Evidence:
   *   1. "nonexistent-test-noop" appears NOWHERE in the framework — a repo-wide
   *      grep over backend/src returned zero matches this run; no schema
   *      default, prompt, or doctrine seeds the token. The model invented it.
   *   2. The grounding rule is UNCHANGED since the 2026-09-09 build
   *      (f356e14a7) — diffed against HEAD this run; only additive functions
   *      (isNoopShellCommand 9e2c69a2, detectNarratedToolIntent 8e53daeff,
   *      measure-only intentMismatchDiscount 28d8920e4) landed since, none in
   *      findUngroundedIdArgs / groundingHaystack / ID_SHAPE_RE.
   *   3. No false-positive path: the token fails ID_SHAPE_RE and occurred in
   *      nothing the lane read; assistant turns never ground (no self-ground
   *      by narration).
   * This replay locks the ad0ebb8b envelope verbatim so a future guard edit
   * that would let this class execute fails loudly. Test-only pin — no
   * framework change, mirroring the f6ed8ea9/adf3bd6c idiom.
   */
  describe('replay ad0ebb8b — update_schedule({id:"nonexistent-test-noop"})', () => {
    // What the Fleet Supervisor lane could legitimately have read: its
    // supervisor wake doctrine and list_schedules rows (real uuid ids) — never
    // the literal placeholder.
    const supervisorHaystack = [
      'FLEET SUPERVISOR wake: probe attention state, then get_chat_messages for the flagged lane transcript.',
      'list_schedules → [{"id":"02bda0ef-835d-4475-a962-91f8f22dc91f","kind":"once","status":"active"}]',
      'get_chat_messages → page 1 of 50 (chat c0e22e36-1c74-4295-8049-9b48335c6c37)',
    ].join('\n');

    it('refuses the verbatim incident placeholder exactly as on 2026-09-23', () => {
      expect(findUngroundedIdArgs({ id: 'nonexistent-test-noop' }, supervisorHaystack))
        .toEqual([{ key: 'id', value: 'nonexistent-test-noop' }]);
    });

    it('the refusal envelope matches the ticket-quoted text (ungrounded_id, get_chat_messages redirect, no chat suffix)', () => {
      const refusal = JSON.parse(
        ungroundedIdRefusal('update_schedule', [{ key: 'id', value: 'nonexistent-test-noop' }], 'get_chat_messages'),
      );
      expect(refusal.ok).toBe(false);
      expect(refusal.tool).toBe('update_schedule');
      expect(refusal.reason).toBe('ungrounded_id');
      expect(refusal.rejected).toEqual([{ key: 'id', value: 'nonexistent-test-noop' }]);
      expect(refusal.message).toContain('id="nonexistent-test-noop"');
      expect(refusal.message).toContain(
        'Your reasoning named get_chat_messages — you evidently meant to call get_chat_messages; call it now with its real parameters.',
      );
      expect(refusal.message).not.toContain('list_chats');
    });

    it('intent detection names get_chat_messages from the incident reasoning, exactly as the ticket quotes', () => {
      const reasoning =
        'The wake summary is stale; I need get_chat_messages for the lane transcript before touching any schedule. get_chat_messages first.';
      expect(detectIntendedTool(reasoning, 'update_schedule', ['update_schedule', 'get_chat_messages', 'list_schedules']))
        .toBe('get_chat_messages');
    });
  });
});
