/**
 * Ticket 6ee7a779 — owner feedback on a project-supervisor chat: "bad
 * formatting one big block of text… then double checker fixes it but should
 * show correct the first time". The fixtures are the REAL prod shapes
 * (2026-10-05/06 supervisor answers; ids/IPs anonymised): markdown written by
 * the model with every newline delivered as a space. Supervisor chats now run
 * without the Double Checker, so the lead's text must render right first time.
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { repairWallOfText, WALL_MIN_CHARS } from './wall-of-text';
import { normalizeAssistantMarkdown } from './markdown-normalize';

/** The answer the owner thumbed down (metadata.revision.previousContent, 1,647 chars, zero newlines). */
const CANLAW_STATUS = "Fresh probe across the board, the repo and S3 — here is the real state at 5:16 PM PDT (00:16Z): ## Not quite. **95% — two tail items left, both tracked.** **Done and verified on main (sha bc59c291 — nothing ahead of it):** - P1 Juriterm + Termium: 19,593 documents + 23 ZIPs - P2 Manitoba + New Brunswick + LégisQuébec current: 3,165 + 2,188 + 9,545 files - P3 LégisQuébec historique: 420,107 version pages, 0 errors (biggest single source) - P4 Érudit FR commentary: 5,991 files / 5.83 GB - Ontario statutes: 83,117 files (prior leg) - **Corpus in S3 right now: 115,018 files / 22.05 GB** (22,050,049,724 B exact recount just now) - Repo has a full S3 audit tool, a missing-objects repair tool, hourly insurance syncs, and a dry-run-verified truncated-file repair script — the corpus is durable **Still open — 2 items:** 1. **English commentary (bcli) wrapper chain:** ALIVE (PID 70221, checked moments ago) — 253 files / 263 MB harvested so far, on its 3rd deferral pass. Its tail PR is staged as ONE follow-up: repair ~225 truncated bcli files (dry-run confirmed), final S3 recount, results addendum, then it self-cancels its schedule. ETA overnight (bcli leg ~6–12h, then the small ulcc/dal legs). 2. **BC point-in-time + NB twin check:** fix committed, relaunch blocked on the remaining 2,111 E-Laws point-in-time queue draining. Then the same one-PR close-out. Once those land, the results docs get their final addendum and the board reads 100%. I have two scheduled watchdogs on it (06:31Z and ~11:31 PM PDT) — they'll catch chain exit and queue drain automatically, and I'll message you on Telegram the moment everything is truly finished.";

const CANLAW_STATUS_REPAIRED = [
  'Fresh probe across the board, the repo and S3 — here is the real state at 5:16 PM PDT (00:16Z):',
  '',
  '## Not quite. **95% — two tail items left, both tracked.**',
  '',
  '**Done and verified on main (sha bc59c291 — nothing ahead of it):**',
  '- P1 Juriterm + Termium: 19,593 documents + 23 ZIPs',
  '- P2 Manitoba + New Brunswick + LégisQuébec current: 3,165 + 2,188 + 9,545 files',
  '- P3 LégisQuébec historique: 420,107 version pages, 0 errors (biggest single source)',
  '- P4 Érudit FR commentary: 5,991 files / 5.83 GB',
  '- Ontario statutes: 83,117 files (prior leg)',
  '- **Corpus in S3 right now: 115,018 files / 22.05 GB** (22,050,049,724 B exact recount just now)',
  '- Repo has a full S3 audit tool, a missing-objects repair tool, hourly insurance syncs, and a dry-run-verified truncated-file repair script — the corpus is durable',
  '',
  '**Still open — 2 items:**',
  '1. **English commentary (bcli) wrapper chain:** ALIVE (PID 70221, checked moments ago) — 253 files / 263 MB harvested so far, on its 3rd deferral pass. Its tail PR is staged as ONE follow-up: repair ~225 truncated bcli files (dry-run confirmed), final S3 recount, results addendum, then it self-cancels its schedule. ETA overnight (bcli leg ~6–12h, then the small ulcc/dal legs).',
  "2. **BC point-in-time + NB twin check:** fix committed, relaunch blocked on the remaining 2,111 E-Laws point-in-time queue draining. Then the same one-PR close-out. Once those land, the results docs get their final addendum and the board reads 100%. I have two scheduled watchdogs on it (06:31Z and ~11:31 PM PDT) — they'll catch chain exit and queue drain automatically, and I'll message you on Telegram the moment everything is truly finished.",
].join('\n');

/** A machine-wake note (spark-cluster supervisor, 1,737 chars): bold headline, labels, ACTIONS TAKEN list. */
const WAKE_NOTE = "**07:25Z wake — adjudication CLOSED, saturation stands, backstop retired.** **What changed:** Lane c90fed41 posted its verdict (agent-sent, this chat, 12:21 AM PDT / 07:21Z): **rule (a) saturation-close, NO twin restart**, on fresh receipts — gateway completions 200 on both routes (`spark-mimo-v26-flash-rl` 73.4s, `spark-glm-5.3-flash` 33.2s, both finish=stop), S1 counters waiting 9→8 declining, +2,802 tok/25s ≈ **112 tok/s live**, aborts=0, census 07:17:22Z both deployments up (MiMo 132.8 tok/s, GLM 158.6 tok/s), and a continuous 2h10m `generation_tokens_total` climb (933,680 → 1,559,684) — the 09-25 wedge signature absent on every axis Rule (b)'s two triggers both fail (no 000 leg, no frozen counters), so the pre-committed adjudication resolves (a): the slow route is deep-queue saturation at scheduler capacity; the \"down\" readings were a 60s probe-bound vs 70–90s service-time mismatch, not an engine fault Incident 1 (01:05Z everything-down) closed with root cause: Hue plug 7 off 00:51:22Z → restored 01:09:53Z, watchdog ran the restore matrix Both stacks verified green 07:19Z. Backstop #4 is moot — cancelled this wake (sched fe4c8864, receipt e94037b1) The lane is mid-closeout (plan 8/10): relaying the saturation verdict + probe-bound mismatch to gateway lane f68bcb47 — the fix for monitor false-negatives — then docs, learnings, and pushing its session branch **Needs the owner:** nothing — 0 open owner questions **Next:** 2h sweep reads the f68bcb47 relay + the docs push and retires the finished lane No fleet action, so no report-up. ACTIONS TAKEN - Cancelled backstop #4 (adjudication resolved ahead of it) — sched fe4c8864, receipt e94037b1 - Recorded the close in supervisor state — no tool id (state merge)";

/** An owner reply (human turn, glm-5.3-flash lead): a ``` fence collapsed inline + one ACTIONS TAKEN item. */
const OWNER_REPLY = "Even better — that shrinks your part to **one short line** Skip tailscale too, I'll handle it myself: ``` sudo apt update && sudo apt install -y openssh-server ``` That's it — no key block, no tailscale, nothing else to type Here's why: the USB-C flash cable still plugged into the server gives me a direct network path to the board (192.0.2.1) Once sshd is up, I'll log in as `owner` and do **everything** from my side — my SSH key, the sudoers line, and tailscale restored from the backup I staged before the flash (so it comes back as the **same** 192.0.2.7 address, no browser re-auth) Then the rebuild chain runs: clocks/MAXN → weights → 4+1 services → verify Just reply **DONE** when apt finishes ACTIONS TAKEN - Steered lane 88ced668 (msg pending): plan change — owner installing openssh-server only";

/** A Fleet Supervisor answer whose sentence ends lost their periods with the newlines. */
const CONFIG_ANSWER = "I have a definitive picture now Fresh reads this run (10:30 AM PDT / 17:31Z): the config file itself, the lane's live status, and its run receipts **Short answer: the endpoint configuration is correct — but it's not live yet.** The gateway supervisor's lane has done the repoint properly in `config/config.yaml`, and it's still mid-pipeline on push → PR → deploy → the through-gateway validation gate **What's verified correct** (I read `config/config.yaml` directly off the lane's branch this run — not from memory): - Route `tt-model-next` → `api_base: http://192.0.2.10:8091/v1` — exactly the server that took over :8091 - Served model id `openai/Model-Next` — verbatim from `GET /v1/models`, not invented - The contract is baked into the config comments: `reasoning_effort` accepts minimal/low/medium/high/**xhigh** (NOT \"max\"), `tool_choice` \"auto\"/\"none\" only Former engine at :8091 marked RETIRED **What's NOT done yet** — the lane is running right now, step 74 of its current run, plan 2/7, no errors, with steady run_command activity Still ahead of it: push → PR → merge → deploy → the three-leg through-gateway validation → report-back to me So: correctly configured, properly validated so far, just not across the finish line";

describe('repairWallOfText — the 6ee7a779 shapes re-line exactly', () => {
  it('the owner\'s thumbed-down answer: heading, bold labels, bullet list and numbered list come back', () => {
    expect(repairWallOfText(CANLAW_STATUS)).toBe(CANLAW_STATUS_REPAIRED);
  });

  it('a machine-wake note: headline, label paragraphs, the long paragraph split at a sentence end, ACTIONS TAKEN as a list', () => {
    const out = repairWallOfText(WAKE_NOTE);
    expect(out.startsWith('**07:25Z wake — adjudication CLOSED, saturation stands, backstop retired.**\n\n**What changed:** Lane c90fed41')).toBe(true);
    expect(out).toContain('Both stacks verified green 07:19Z.\n\nBackstop #4 is moot');
    expect(out).toContain('\n\n**Needs the owner:** nothing — 0 open owner questions\n\n**Next:** 2h sweep');
    expect(out.endsWith('\n\nACTIONS TAKEN\n- Cancelled backstop #4 (adjudication resolved ahead of it) — sched fe4c8864, receipt e94037b1\n- Recorded the close in supervisor state — no tool id (state merge)')).toBe(true);
    // Inline code and mid-sentence bold stay inline.
    expect(out).toContain('(`spark-mimo-v26-flash-rl` 73.4s, `spark-glm-5.3-flash` 33.2s');
    expect(out).toContain(': **rule (a) saturation-close, NO twin restart**, on fresh receipts');
    expect(out).not.toContain('\n#4');
  });

  it('a collapsed ``` fence becomes a real fenced block; a lone bullet after ACTIONS TAKEN is a list item', () => {
    const out = repairWallOfText(OWNER_REPLY);
    expect(out).toContain("I'll handle it myself:\n\n```\nsudo apt update && sudo apt install -y openssh-server\n```\n\nThat's it — no key block");
    expect(out.endsWith('when apt finishes\n\nACTIONS TAKEN\n- Steered lane 88ced668 (msg pending): plan change — owner installing openssh-server only')).toBe(true);
    expect(out).toContain('log in as `owner` and do **everything** from my side'); // lowercase bold stays inline
  });

  it('bold leads (a whole bold sentence, a Title-case bold followed by a dash/paren) start paragraphs; bullets end at the next lead', () => {
    const out = repairWallOfText(CONFIG_ANSWER);
    expect(out).toContain('and its run receipts\n\n**Short answer: the endpoint configuration is correct — but it\'s not live yet.** The gateway');
    expect(out).toContain('validation gate\n\n**What\'s verified correct** (I read `config/config.yaml`');
    expect(out).toContain('not from memory):\n- Route `tt-model-next` → `api_base: http://192.0.2.10:8091/v1`');
    expect(out).toContain('\n- Served model id `openai/Model-Next`');
    expect(out).toContain('marked RETIRED\n\n**What\'s NOT done yet** — the lane is running');
    // The ' - ' inside an inline code span or a bold span is never a bullet.
    expect(out).not.toContain('\n- Model-Next');
  });

  it('is idempotent and keeps every character of content (only whitespace changes)', () => {
    for (const fixture of [CANLAW_STATUS, WAKE_NOTE, OWNER_REPLY, CONFIG_ANSWER]) {
      const once = repairWallOfText(fixture);
      expect(repairWallOfText(once)).toBe(once);
      const squash = (t: string) => t.replace(/```\n?/g, '```').replace(/\s+/g, ' ').replace(/``` /g, '```').trim();
      expect(squash(once)).toBe(squash(fixture));
    }
  });
});

describe('repairWallOfText — never touches what is not a lost-newline wall', () => {
  it('short text, text that already has a line break, and blockquotes are returned as-is', () => {
    const short = 'Done: - A item - B item ## Head **Label:** x';
    expect(short.length).toBeLessThan(WALL_MIN_CHARS);
    expect(repairWallOfText(short)).toBe(short);
    const withBreak = `${CANLAW_STATUS.slice(0, 200)}\n${CANLAW_STATUS.slice(200)}`;
    expect(repairWallOfText(withBreak)).toBe(withBreak);
    const quote = `> ${CANLAW_STATUS}`;
    expect(repairWallOfText(quote)).toBe(quote);
  });

  it('a long plain-prose paragraph with ordinary dashes and numbers stays one paragraph', () => {
    const prose = ('The run took 10 - 12 minutes on the old box and the second pass - which we expected - was faster. '
      + 'In step 2. the cache warmed and in phase 3. it settled; the lane said it was fine and the numbers look steady across the window, '
      + 'so nothing needs a change today and the next check is tomorrow morning when the nightly finishes its sweep of the corpus. ').repeat(2);
    expect(prose.length).toBeGreaterThan(WALL_MIN_CHARS);
    expect(repairWallOfText(prose)).toBe(prose);
  });

  it('one structural marker is not enough (≥ 2 required)', () => {
    const one = `${'Context words go here and keep going for a while. '.repeat(9)}**Next:** the sweep runs at noon and reads the relay.`;
    expect(repairWallOfText(one)).toBe(one);
  });

  it('collapsed tables are left to the table repairs; an unbalanced fence is never guessed', () => {
    const table = `${'Status of the fleet this morning. '.repeat(10)}| Lane | State | |---|---| | a | ok | | b | ok | ## Next - A thing - B thing`;
    expect(repairWallOfText(table)).toBe(table);
    const fence = `${'Run this now please. '.repeat(20)}\`\`\` npm ci ## Then - Check A - Check B`;
    expect(repairWallOfText(fence)).toBe(fence);
  });

  it('markers inside inline code are not markers', () => {
    const code = `${'Context for the change follows here. '.repeat(10)}Run \`grep -n " ## " file - **Label:** x\` and \`ls - A\` then wait for the result before you continue.`;
    expect(repairWallOfText(code)).toBe(code);
  });

  it('a stray "1." in prose never steals the real list\'s first item', () => {
    const t = `${'Phase 1. was the warmup and it went fine overall today. '.repeat(8)}**Plan:** 1. **Fetch:** pull the corpus 2. **Index:** build it 3. **Verify:** spot-check twenty docs`;
    const out = repairWallOfText(t);
    expect(out).toContain('\n1. **Fetch:** pull the corpus\n2. **Index:** build it\n3. **Verify:** spot-check twenty docs');
    expect(out).toContain('Phase 1. was the warmup');
  });
});

describe('normalizeAssistantMarkdown — the persist path runs the repair (MARKDOWN_WALL_REPAIR_DISABLED kill switch)', () => {
  afterEach(() => { delete process.env.MARKDOWN_WALL_REPAIR_DISABLED; });

  it('persists the repaired answer as clean CommonMark (blank line before each list) and stays idempotent', () => {
    const out = normalizeAssistantMarkdown(CANLAW_STATUS);
    expect(out).toContain('(00:16Z):\n\n## Not quite.');
    expect(out).toContain('(sha bc59c291 — nothing ahead of it):**\n\n- P1 Juriterm');
    expect(out).toContain('**Still open — 2 items:**\n\n1. **English commentary');
    expect(normalizeAssistantMarkdown(out)).toBe(out);
  });

  it('protected regions ([FOLLOWUPS] …) stay byte-identical while the wall before them is repaired', () => {
    const followups = '[FOLLOWUPS]\n- Shall I re-run the recount? - Next item\n[/FOLLOWUPS]';
    const out = normalizeAssistantMarkdown(`${WAKE_NOTE} ${followups}`);
    // (markdown-normalize then blank-separates the list from its label, as it does for any list)
    expect(out).toContain('\n\nACTIONS TAKEN\n\n- Cancelled backstop #4');
    expect(out.endsWith(` ${followups}`)).toBe(true);
  });

  it('MARKDOWN_WALL_REPAIR_DISABLED=1 restores the pre-6ee7a779 output', () => {
    process.env.MARKDOWN_WALL_REPAIR_DISABLED = '1';
    const out = normalizeAssistantMarkdown(CANLAW_STATUS);
    expect(out).not.toContain('\n- P1');
    expect(out).toBe(CANLAW_STATUS); // nothing in the old passes fires on this shape — the bug
  });
});

describe('frontend port stays in sync', () => {
  it('frontend/lib/wall-of-text.ts is byte-identical below its header', () => {
    const fe = join(__dirname, '../../../../frontend/lib/wall-of-text.ts');
    if (!existsSync(fe)) return; // backend-only checkout
    const body = (p: string) => readFileSync(p, 'utf8').split('\n').filter((l) => !l.startsWith(' * KEEP IN SYNC')).join('\n');
    expect(body(fe)).toBe(body(join(__dirname, 'wall-of-text.ts')));
  });
});
