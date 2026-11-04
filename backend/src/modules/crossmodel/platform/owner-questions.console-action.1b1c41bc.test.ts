/**
 * Ticket 1b1c41bc — owner action cards must carry paste-ready content +
 * click-by-click steps (owner asked 3× in one day; 2026-10-16 13:19Z:
 * "You need to send me what to put with more instructinos and better
 * instructions always…make sure to add this to frameowrk").
 *
 * The amd-server-1 deploy stall (the ticket's evidence): a card asked for ONE
 * Tailscale ACL save but summarized the artifact ("save the v2 ACL that
 * grants…") instead of carrying the JSON — QUESTION_MAX=2000 made the
 * summarize-first card the only shape that fit, the owner answered asking for
 * the actual content, and the deploy sat hours on a change the owner had
 * already approved twice.
 *
 * This suite pins the harness-enforced contract: a flag with a
 * consoleAction spec composes the four elements INTO the stored question —
 * (1) paste-ready fenced payload, (2) numbered click-by-click steps naming
 * the console URL, (3) what/why-safe line, (4) typed saved/error/defer
 * options — so no filing agent hand-formats them and no surface can lose
 * them (the question is the single source every surface renders).
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-characters-long!!';

jest.mock('../../../config/database', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createOwnerQuestionTable } = require('./owner-questions.testkit');
  const mockQuestions = createOwnerQuestionTable();
  return {
    __esModule: true,
    default: {
      ownerQuestion: mockQuestions.api,
      crossModelMessage: mockQuestions.crossModelMessage,
      crossModelChat: mockQuestions.crossModelChat,
    },
  };
});

// The service's lazy logger import would pull utils/logger → config/env →
// process.exit(1) without env vars — mock it (the ad4fae90 suite pattern).
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// The Telegram push is a dynamic import that would pull config/redis →
// config/env → process.exit(1) in tests — mock it (the ad4fae90 suite pattern).
jest.mock('../telegram/telegram.service', () => ({
  __esModule: true,
  isConfigured: () => false,
  sendMessage: jest.fn(),
}));

import {
  flagOwnerQuestion,
  normalizeConsoleAction,
  composeConsoleActionBody,
  parseStoredConsoleAction,
  CONSOLE_ACTION_QUESTION_MAX,
} from './owner-questions';

const TAILSCALE_SPEC = {
  consoleName: 'Tailscale admin console',
  consoleUrl: 'https://login.tailscale.com/admin/acls',
  whatAndWhySafe: 'Grants the digby-dev tag SSH access to controllers only — no other ports, no other nodes; reversible by deleting the rule.',
  payload: JSON.stringify(
    {
      action: 'accept',
      src: ['tag:digby-dev'],
      dst: ['tag:controller:22'],
    },
    null,
    2,
  ),
  payloadLanguage: 'json',
  steps: [
    'Open https://login.tailscale.com/admin/acls (Access Controls tab).',
    'Select-all inside the editor and copy the JSON below over it.',
    'Click Save — the console validates and applies the rule immediately.',
    'Reply "Saved" on this card (the waiting deploy resumes automatically).',
  ],
};

let flagSeq = 0;

// Synthetic key shapes for the redaction pins, ASSEMBLED AT RUNTIME so no
// source line carries a contiguous credential shape (the commit/merge secret
// scan scans diff lines) — the redactor still sees the full shape at
// runtime, which is what these tests pin. Deliberately non-secret alphabet
// sequences, never real keys.
const FAKE_KEY_A = ['sk-ant-api03-', 'abcdefghijklmnopqrstuvwx'].join('');
const FAKE_KEY_B = ['sk-ant-api03-', 'zyxwvutsrqponmlkjihgfe'].join('');

async function flag(spec: unknown, extra: Record<string, unknown> = {}) {
  // Each flag gets its OWN chat id — the in-memory table dedupes an exact
  // open question per chat, and sibling tests must not collide.
  flagSeq += 1;
  return flagOwnerQuestion({
    chatId: `chat_console_${flagSeq}`,
    userId: 'user_1',
    question: 'Save this ACL rule so the deploy can reach the controller.',
    consoleAction: spec,
    ...extra,
  } as any);
}

describe('normalizeConsoleAction (fail-closed validation)', () => {
  it('accepts a complete spec and normalizes it', () => {
    const v = normalizeConsoleAction(TAILSCALE_SPEC);
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.value.consoleName).toBe('Tailscale admin console');
      expect(v.value.steps).toHaveLength(4);
      expect(v.value.payload).toContain('"action": "accept"');
    }
  });

  it('refuses a non-https console URL', () => {
    const v = normalizeConsoleAction({ ...TAILSCALE_SPEC, consoleUrl: 'http://login.tailscale.com/admin/acls' });
    expect(v).toMatchObject({ ok: false });
    if (!v.ok) expect(v.error).toMatch(/https/i);
  });

  it('refuses a missing steps array (a pure summary card is never acceptable)', () => {
    const { steps: _steps, ...noSteps } = TAILSCALE_SPEC as any;
    const v = normalizeConsoleAction(noSteps);
    expect(v).toMatchObject({ ok: false });
    if (!v.ok) expect(v.error).toMatch(/steps/);
  });

  it('refuses a missing whatAndWhySafe line', () => {
    const { whatAndWhySafe: _w, ...noWhy } = TAILSCALE_SPEC as any;
    const v = normalizeConsoleAction(noWhy);
    expect(v).toMatchObject({ ok: false });
    if (!v.ok) expect(v.error).toMatch(/whatAndWhySafe/);
  });

  it('caps steps at 10 and drops empties', () => {
    const v = normalizeConsoleAction({
      ...TAILSCALE_SPEC,
      steps: [...Array(14).keys()].map((i) => (i === 3 ? '   ' : `Step ${i + 1}`)),
    });
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.value.steps).toHaveLength(10);
      expect(v.value.steps).not.toContain('Step 4'); // the blank entry is dropped
    }
  });

  it('allows a pure click-path ask (payload omitted)', () => {
    const { payload: _p, payloadLanguage: _l, ...noPayload } = TAILSCALE_SPEC as any;
    const v = normalizeConsoleAction(noPayload);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.value.payload).toBeUndefined();
  });

  it('refuses a payload over the 6000-char cap', () => {
    const v = normalizeConsoleAction({ ...TAILSCALE_SPEC, payload: 'x'.repeat(6001) });
    expect(v).toMatchObject({ ok: false });
    if (!v.ok) expect(v.error).toMatch(/payload/i);
  });

  it('REFUSES a payload carrying credential material; other spec fields redact (review finding H + ticket 26786762 — a secret never rides a console card)', () => {
    // The spec fields are agent-authored and ride the stored question, the
    // consoleAction column, the Inbox card and the Telegram DM — the same
    // inbound redaction that guards question/context must guard them, or a
    // key pasted into a payload bypasses the scan entirely.
    // Ticket 26786762 made the payload leg FAIL-CLOSED: a redacted fenced
    // block would hand the owner "[REDACTED: looked like a credential]"
    // exactly where the paste-ready key was (the destruction mishap this
    // ticket fixes). The agent delivers the key via deliverSecrets and
    // references the "[SECRET 1]" handle in the payload instead.
    const v = normalizeConsoleAction({
      ...TAILSCALE_SPEC,
      payload: `{\n  "api_key": "${FAKE_KEY_A}",\n  "rule": "accept"\n}`,
      whatAndWhySafe: `Safe because the token ${FAKE_KEY_B} is only a placeholder.`,
    });
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.error).toMatch(/deliverSecrets/);
    expect(v.error).toMatch(/\[SECRET 1\]/);
    // The non-payload fields still redact in place (their material is
    // context prose, not the paste-ready payload).
    const w = normalizeConsoleAction({
      ...TAILSCALE_SPEC,
      whatAndWhySafe: `Safe because the token ${FAKE_KEY_B} is only a placeholder.`,
    });
    expect(w.ok).toBe(true);
    if (!w.ok) return;
    expect(w.value.whatAndWhySafe).not.toContain(FAKE_KEY_B);
    expect(w.value.whatAndWhySafe).toContain('[REDACTED');
    // A clean payload passes through UNCHANGED (redaction never mangles a
    // legitimate ACL/app-password-setup body).
    const clean = normalizeConsoleAction(TAILSCALE_SPEC);
    expect(clean.ok).toBe(true);
    if (clean.ok) expect(clean.value.payload).toBe(TAILSCALE_SPEC.payload);
  });

  it('refuses a consoleUrl carrying credential material (review finding B-2 — a query-string token never rides the card)', () => {
    const v = normalizeConsoleAction({
      ...TAILSCALE_SPEC,
      consoleUrl: `https://login.tailscale.com/admin/acls?token=${FAKE_KEY_A}`,
    });
    expect(v).toMatchObject({ ok: false });
    if (!v.ok) expect(v.error).toMatch(/credential material/);
    // A bare console URL passes untouched.
    const clean = normalizeConsoleAction(TAILSCALE_SPEC);
    expect(clean.ok).toBe(true);
    if (clean.ok) expect(clean.value.consoleUrl).toBe(TAILSCALE_SPEC.consoleUrl);
  });

  it('refuses an oversized composed body instead of silently slicing the steps away (review finding B-1)', async () => {
    // Legal maximal fields: payload 6000 + why 300 + name/URL caps + 10 steps
    // at the 280-char cap compose OVER the 9000 budget — and steps are
    // composed LAST, so a silent slice would cut exactly the click-by-click
    // steps the owner asked for. The refusal names the sizes (fail-closed,
    // like every other spec defect).
    const oversized = {
      ...TAILSCALE_SPEC,
      whatAndWhySafe: `${'Grants the digby-dev tag SSH access to controllers only, nothing else, and is reversible. '.repeat(4)}safe.`,
      payload: `{\n${Array.from({ length: 120 }, (_, i) => `  "rule_${i}": { "src": ["tag:team-${i}"], "dst": ["tag:svc-${i}:443"], "note": "${'x'.repeat(30)}" }`).join(',\n')}\n}`.slice(0, 6000),
      steps: Array.from({ length: 10 }, (_, i) => `${'Click the highlighted UI element and choose the documented option from the dropdown. '.repeat(4)}Step ${i + 1}.`.slice(0, 280)),
    };
    const probe = normalizeConsoleAction(oversized);
    expect(probe.ok).toBe(true);
    if (!probe.ok) return;
    const body = composeConsoleActionBody(probe.value, 'Save this ACL.');
    expect(body.length).toBeGreaterThan(9000); // the hazard shape itself
    const r = await flag(oversized);
    expect(r.kind).toBe('refused');
    if (r.kind !== 'refused') return;
    expect(r.refused).toBe('invalid');
    expect((r as { message?: string }).message).toMatch(/consoleAction too large/);
  });

  it('admits a large-but-fitting spec whole (the B-1 guard does not over-refuse)', async () => {
    const fitting = {
      ...TAILSCALE_SPEC,
      payload: JSON.stringify({ rules: Array.from({ length: 30 }, (_, i) => ({ id: `r${i}`, src: [`tag:t${i}`], dst: [`tag:s${i}:443`] })) }, null, 2),
    };
    const r = await flag(fitting);
    expect(r.kind).toBe('created');
    if (r.kind !== 'created') return;
    // The whole payload AND the last step both survive to the stored row.
    expect(String(r.question.question)).toContain('"tag:t29"');
    expect(String(r.question.question)).toContain('4. Reply "Saved" on this card');
  });
});

describe('composeConsoleActionBody (the four elements)', () => {
  const v = normalizeConsoleAction(TAILSCALE_SPEC);
  if (!v.ok) throw new Error('spec must validate');
  const body = composeConsoleActionBody(v.value, 'Save this ACL rule so the deploy can reach the controller.');

  it('carries the original ask, then the what/why-safe line', () => {
    expect(body).toContain('Save this ACL rule so the deploy can reach the controller.');
    expect(body).toContain("**What this does + why it's safe:**");
    expect(body).toContain('reversible by deleting the rule');
  });

  it('names the console + URL as a headline', () => {
    expect(body).toContain('**Do this in Tailscale admin console — https://login.tailscale.com/admin/acls**');
  });

  it('carries the EXACT payload in a fenced block (copy-ready, not a summary)', () => {
    expect(body).toContain('```json');
    expect(body).toContain('"src": [\n    "tag:digby-dev"\n  ]');
    expect(body).not.toContain('the v2 ACL that grants'); // the summarize-first failure shape
  });

  it('numbers the click-by-click steps', () => {
    expect(body).toContain('**Click by click:**');
    expect(body).toContain('1. Open https://login.tailscale.com/admin/acls');
    expect(body).toContain('4. Reply "Saved" on this card');
  });
});

describe('flagOwnerQuestion with consoleAction (the harness-enforced card)', () => {
  it('stores the composed four-element body as the question', async () => {
    const r = await flag(TAILSCALE_SPEC);
    expect(r.kind).toBe('created');
    if (r.kind !== 'created') return;
    const q = String(r.question.question);
    expect(q).toContain('```json');
    expect(q).toContain('"action": "accept"');
    expect(q).toContain('**Click by click:**');
    expect(q).toContain('1. Open https://login.tailscale.com/admin/acls');
    expect(q).toContain("**What this does + why it's safe:**");
  });

  it('injects the Saved/Error/Defer typed options when the flagger supplied none', async () => {
    const r = await flag(TAILSCALE_SPEC);
    expect(r.kind).toBe('created');
    if (r.kind !== 'created') return;
    const options = (r.question as any).options as Array<{ id: string; label: string }>;
    expect(options.map((o) => o.id)).toEqual(['saved', 'error', 'defer']);
    expect(options.map((o) => o.label)).toEqual(['Saved', 'Error', 'Defer']);
  });

  it('keeps the flagger-supplied options over the injected ones', async () => {
    const r = await flag(TAILSCALE_SPEC, {
      options: [{ id: 'done', label: 'Done — saved it' }, { id: 'nope', label: 'Could not save' }],
    });
    expect(r.kind).toBe('created');
    if (r.kind !== 'created') return;
    const options = (r.question as any).options as Array<{ id: string }>;
    expect(options.map((o) => o.id)).toEqual(['done', 'nope']);
  });

  it('does NOT refuse the numbered-steps body as a multi-decision question', async () => {
    // The composed body carries "1. … 2. …" steps text — the exact shape the
    // looksLikeMultiDecisionQuestion heuristic refuses when no options exist.
    // The injected saved/error/defer options keep the flag alive.
    const r = await flag(TAILSCALE_SPEC);
    expect(r.kind).not.toBe('refused');
    if (r.kind === 'refused') return;
    expect((r.kind as string)).toBe('created');
  });

  it('routes a console-action ask straight to the owner (never supervisor triage)', async () => {
    const r = await flag(TAILSCALE_SPEC, { machineTriggered: true });
    expect(r.kind).toBe('created');
    if (r.kind !== 'created') return;
    expect((r.question as any).triage).toBeFalsy(); // no SLA hold on a physically-human ask
  });

  it('stores the structured spec in consoleAction for the pending surface', async () => {
    const r = await flag(TAILSCALE_SPEC);
    expect(r.kind).toBe('created');
    if (r.kind !== 'created') return;
    const stored = parseStoredConsoleAction((r.question as any).consoleAction);
    expect(stored).not.toBeNull();
    expect(stored?.consoleUrl).toBe('https://login.tailscale.com/admin/acls');
  });

  it('refuses an invalid consoleAction with the reason (fail-closed, no silent summary fallback)', async () => {
    const r = await flag({ consoleName: '', consoleUrl: 'https://x.example', whatAndWhySafe: 'y', steps: ['s'] });
    expect(r.kind).toBe('refused');
    if (r.kind !== 'refused') return;
    expect(r.refused).toBe('invalid');
    expect((r as { message?: string }).message).toMatch(/consoleAction invalid: /);
  });

  it('admits a payload that dwarfs QUESTION_MAX (the raised console-action budget)', async () => {
    // The 2000-char QUESTION_MAX forced summarize-first cards. A console-action
    // body with a realistic ACL JSON + steps must fit whole.
    const bigPayload = JSON.stringify({ rules: Array.from({ length: 40 }, (_, i) => ({ id: i, src: [`tag:team-${i}`], dst: [`tag:svc-${i}:443`] })) }, null, 2);
    expect(bigPayload.length).toBeGreaterThan(2000);
    const v = normalizeConsoleAction({ ...TAILSCALE_SPEC, payload: bigPayload });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    const body = composeConsoleActionBody(v.value, 'Save this ACL.');
    expect(body.length).toBeGreaterThan(2000);
    expect(body.length).toBeLessThanOrEqual(CONSOLE_ACTION_QUESTION_MAX);
    const r = await flag({ ...TAILSCALE_SPEC, payload: bigPayload }, {});
    expect(r.kind).toBe('created');
    if (r.kind !== 'created') return;
    // The stored question keeps the WHOLE payload — the owner never needs a
    // follow-up ask to obtain the paste content.
    expect(String(r.question.question)).toContain('"tag:team-39"');
  });

  it('leaves ordinary questions on the legacy 2000-char budget', async () => {
    const r = await flagOwnerQuestion({
      chatId: 'chat_console_2',
      userId: 'user_1',
      question: 'x'.repeat(2500),
    } as any);
    expect(r.kind).toBe('created');
    if (r.kind !== 'created') return;
    expect(String(r.question.question).length).toBeLessThanOrEqual(2000);
  });
});

describe('parseStoredConsoleAction (tolerant read)', () => {
  it('returns null for junk / legacy rows', () => {
    expect(parseStoredConsoleAction(null)).toBeNull();
    expect(parseStoredConsoleAction('nope')).toBeNull();
    expect(parseStoredConsoleAction({ nope: 1 })).toBeNull();
  });
});
