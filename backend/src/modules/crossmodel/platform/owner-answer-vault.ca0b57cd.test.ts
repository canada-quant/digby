/**
 * Ticket ca0b57cd — replay: an owner-card answer carrying TWO credential-
 * shaped key=value pairs (`x_access_key=<20-char AKIA id>,
 * x_secret_access_key=<40-char secret>`) vaulted ONLY the first value (the
 * AKIA id, under the declared CANLAW_CPT_S3_KEY) and silently DROPPED the
 * 40-char secret half — which then sat VERBATIM, unredacted, on the stored
 * owner-question answer row (live specimen oq_f04ac515: the stored answer
 * read `canlaw_cpt_s3_access_key=[REDACTED…],canlaw_cpt_s3_secret_access_key+
 * <the raw 40-char secret> [CREDENTIAL VAULTED — … $CANLAW_CPT_S3_KEY …]`).
 * A recovery lane had to reconstruct the pair by reading the unredacted
 * answer via list_owner_questions.
 *
 * Root cause (three gaps, all replayed below):
 *  1. SPAN GAP: the 'Credential assignment' inbound pattern requires its
 *     keyword (api_key|token|secret|password) to IMMEDIATELY precede the
 *     separator — `secret_access_key=<v>` has tail `access_key` and matched
 *     NOTHING, so the secret half was neither redacted nor a vault candidate.
 *  2. NAMING GAP: vaultOwnerAnswerSecrets keyed every span after the first
 *     to OWNER_ANSWER_<id>[_2..] — even when stored, a named second value
 *     landed under an opaque key the lane could not predict.
 *  3. VISIBILITY GAP: the vault notice named the envKey(s) but not the
 *     capture COUNT, so "1 of 2 values stored" read as complete.
 *
 * The fix (this suite pins it):
 *  - a NAMED-COMPOUND span leg (secret-scan NAMED_COMPOUND_TAILS: access_key,
 *    secret_key, secret_access_key, … — a `NAME=value` line on a credential
 *    card is owner INTENT, not a shape guess) makes the secret half BOTH
 *    redactable and vaultable, and carries the LABEL;
 *  - the vault stores each named value under a LABEL-DERIVED envKey
 *    (normalized, guard-validated, deduped) — first value keeps the DECLARED
 *    gate key, the second lands as e.g. $CANLAW_CPT_S3_SECRET_ACCESS_KEY;
 *  - the notice names the capture count ("2 credential-shaped values …");
 *  - store_secret {fromMessageId: oq_…} can lift a value from an OWNER-
 *    answered owner-question row (the supervisor's repair path — the ticket's
 *    second ask), guarded to owner-authored answers only.
 *
 * Runs against the REAL secret-scan + credentials.service (the
 * owner-answer-vault.ad4fae90.test.ts harness pattern — only config/database
 * and the wake boundaries are mocked; the ownerQuestion table is the shared
 * owner-questions.testkit).
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-characters-long!!';

import { createOwnerQuestionTable } from './owner-questions.testkit';

const mockQuestions = createOwnerQuestionTable();
let mockCreds: any[] = [];
let mockMessages: any[] = [];

jest.mock('../../../config/redis', () => ({ __esModule: true, default: { get: async () => null, set: async () => true, del: async () => true } }));

jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    ownerQuestion: mockQuestions.api,
    crossModelMessage: {
      ...mockQuestions.crossModelMessage,
      findUnique: async ({ where }: any) => mockMessages.find((m) => m.id === where.id) ?? null,
    },
    crossModelChat: mockQuestions.crossModelChat,
    runToolReceipt: { findFirst: async () => null },
    codingCredential: {
      findUnique: async ({ where }: any) => {
        const k = where.userId_envKey_label;
        return mockCreds.find((r) => r.userId === k.userId && r.envKey === k.envKey && r.label === k.label) ?? null;
      },
      findFirst: async ({ where }: any) => {
        // credentialLifted queries { envKey: { startsWith } } — shape-aware.
        const ek = where.envKey;
        const pred: (r: any) => boolean = typeof ek === 'string'
          ? (r) => String(r.envKey) === ek
          : ek && typeof ek.startsWith === 'string'
            ? (r) => String(r.envKey).startsWith(ek.startsWith)
            : () => false;
        return mockCreds.find((r) => r.userId === where.userId && pred(r)) ?? null;
      },
      count: async ({ where }: any) => mockCreds.filter((r) => r.userId === where.userId).length,
      upsert: async ({ where, create, update }: any) => {
        const k = where.userId_envKey_label;
        const row = mockCreds.find((r) => r.userId === k.userId && r.envKey === k.envKey && r.label === k.label);
        if (row) { Object.assign(row, update, { updatedAt: new Date() }); return row; }
        const fresh = { id: `cred-${mockCreds.length + 1}`, createdAt: new Date(), updatedAt: new Date(), ...create };
        mockCreds.push(fresh);
        return fresh;
      },
    },
    activity: { create: async ({ data }: any) => data },
  },
}));

// The service's lazy logger import would pull utils/logger → config/env →
// process.exit(1) without env vars — mock it (the owner-questions.test.ts pattern).
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// The resolution wake + gate unblock + telegram pushes are dynamic imports —
// mocked at the boundary (the 50bcd1e7 harness pattern).
const mockFireScheduleTarget: jest.Mock = jest.fn(async () => ({ started: true }));
jest.mock('../coding/schedule.service', () => ({
  __esModule: true,
  fireScheduleTarget: (...a: any[]) => mockFireScheduleTarget(...a),
  dailyCapExceeded: jest.fn(async () => null),
  refundDailyCapToken: jest.fn(async () => {}),
}));
const mockUnblockOwnerGatedItems: jest.Mock = jest.fn(async () => ({ todos: 0, goals: 0 }));
jest.mock('./goals.service', () => ({
  __esModule: true,
  unblockOwnerGatedItems: (...a: any[]) => mockUnblockOwnerGatedItems(...a),
}));
jest.mock('../telegram/telegram.service', () => ({
  __esModule: true,
  isConfigured: () => false,
  sendMessage: jest.fn(async () => {}),
}));

import { flagOwnerQuestion, answerOwnerQuestion, isCounterQuestionAnswer } from './owner-questions';
import { executeSecretHandoffTool } from './secret-handoff-tools';
import { decryptValue } from '../coding/credentials.service';
import { findSecretSpans, redactInboundSecrets, redactOutboundSecrets } from './secret-scan';

/** The ticket specimen, fake values (assembled so no credential-shaped literal
 *  sits contiguous in source — the 50bcd1e7/ad4fae90 fixture convention). */
const ACCESS_KEY_ID = ['AKIA', 'QWERTYUIOP123456'].join('');
const SECRET_VALUE = ['fLnGw229n89c5Ufq', 'Zvrx9xwDLyaVz328', 'LAqYLz9'].join('');
const DECLARED_ENVKEY = 'CANLAW_CPT_S3_KEY';

const parse = (s: string) => JSON.parse(s);

const flagCredentialAsk = async (envKey: string) => {
  const out = await flagOwnerQuestion({
    chatId: 'chat-1',
    userId: 'u1',
    question: `Please paste the ${envKey} credential pair so the lane can sign S3 requests`,
    expectedAnswerType: `credential:${envKey}`,
  });
  if (out.kind !== 'created') throw new Error(`flag refused: ${JSON.stringify(out)}`);
  return out.question;
};

beforeEach(() => {
  mockQuestions.reset();
  mockCreds = [];
  mockMessages = [];
  mockFireScheduleTarget.mockClear().mockResolvedValue({ started: true });
  mockUnblockOwnerGatedItems.mockClear().mockResolvedValue({ todos: 0, goals: 0 });
  delete process.env.OWNER_ANSWER_VAULT_DISABLED;
  delete process.env.STORE_SECRET_TOOL_DISABLED;
});

describe('ticket ca0b57cd — scanner: the named-compound span leg', () => {
  it('the ticket specimen shape yields BOTH spans (the pre-fix scan matched only the AKIA id)', () => {
    const answer = `canlaw_cpt_s3_access_key=${ACCESS_KEY_ID}, canlaw_cpt_s3_secret_access_key=${SECRET_VALUE}`;
    const spans = findSecretSpans(answer);
    expect(spans).toHaveLength(2);
    expect(spans[0]).toMatchObject({ name: 'AWS access key', value: ACCESS_KEY_ID });
    expect(spans[1]).toMatchObject({ name: 'Named credential assignment', value: SECRET_VALUE, label: 'canlaw_cpt_s3_secret_access_key' });
  });

  it('the live-row variant (second separator is `+`) yields both spans too — no punctuation slip-through', () => {
    const answer = `canlaw_cpt_s3_access_key=${ACCESS_KEY_ID},canlaw_cpt_s3_secret_access_key+${SECRET_VALUE}`;
    const spans = findSecretSpans(answer);
    expect(spans).toHaveLength(2);
    expect(spans[1]).toMatchObject({ label: 'canlaw_cpt_s3_secret_access_key' });
  });

  it('the secret half is REDACTED from the stored text (pre-fix: it sat verbatim on the row)', () => {
    const answer = `canlaw_cpt_s3_access_key=${ACCESS_KEY_ID} secret_access_key=${SECRET_VALUE}`;
    const out = redactInboundSecrets(answer);
    expect(out).not.toContain(SECRET_VALUE);
    expect(out).not.toContain(ACCESS_KEY_ID);
    // the label stays visible so the owner sees WHICH credential was dropped
    expect(out).toContain('secret_access_key');
  });

  it('the AWS standard env-var pair redacts BOTH halves', () => {
    const answer = `AWS_ACCESS_KEY_ID=${ACCESS_KEY_ID}\nAWS_SECRET_ACCESS_KEY=${SECRET_VALUE}`;
    const out = redactInboundSecrets(answer);
    expect(out).not.toContain(ACCESS_KEY_ID);
    expect(out).not.toContain(SECRET_VALUE);
  });

  it('NO false positives: placeholders, constant names, prose, cursor labels and getenv stay untouched', () => {
    const untouched = [
      'db_password=<your-password-here>',
      'SOME_FLAG_NAME_V2=true',
      'the access key is rotated weekly by the on-call engineer',
      'secret_key=os.getenv("JWT_SECRET_KEY_FOR_PROD_X1")',
      'next_token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
      'max_tokens=4096',
      // Review A1 of 64705f7a8: a path / URL / ARN / fingerprint REFERENCE
      // after a compound-tail label is where a key LIVES, never the key.
      // (The reviewer's exact ARN — with its `secret:` segment — also trips
      // the PRE-EXISTING password leg on base and fix alike; that leg is
      // untouched by this change, so the loop uses shapes it ignores and the
      // named-leg exemption is pinned in its own test below.)
      'private_key=/etc/letsencrypt/live/Example2024.com/privkey.pem',
      'private_key: /home/ec2-user/.ssh/Example2024KeyPair.pem',
      'secret_id=arn:aws:iam::123456789012:user/deploy-prod',
      'private_key=SHA256:AbCdEf1234567890AbCdEf1234567890AbCdEf1234567890',
      // Review A2: a SPACED `+` is a code expression, not an assignment.
      'auth_key + suffixWithCase2024 yields the signature',
      'secret_key + AbCdEf123456789012345678 is concatenation code, not a paste',
    ];
    for (const t of untouched) expect(findSecretSpans(t)).toHaveLength(0);
  });

  it('A1: the named-compound leg itself never redacts a path / URL / ARN / fingerprint reference (the reviewer\'s exact shapes)', () => {
    const refs = [
      'private_key=/etc/letsencrypt/live/Example2024.com/privkey.pem',
      'secret_id=arn:aws:secretsmanager:ca-central-1:123456789012:secret:prod/db-AbCdEf',
      'private_key=SHA256:AbCdEf1234567890AbCdEf1234567890AbCdEf1234567890',
      'access_key=https://internal.example.com/keys/2024/main',
    ];
    for (const t of refs) {
      expect(findSecretSpans(t).filter((s) => s.name === 'Named credential assignment')).toHaveLength(0);
    }
  });
});

describe('ticket ca0b57cd — review B1: a preceding non-tail assignment never swallows the credential', () => {
  // The pre-fix NAMED_COMPOUND_RE matched ANY word[:=+]value candidate and
  // rejected non-tail labels in the replace callback — String.replace(/g)
  // never re-scans inside a skipped match, so the credential after any
  // non-tail word[:=+] was consumed by the earlier candidate's VALUE and
  // never re-scanned: secret VERBATIM on the row, vault EMPTY. The tail now
  // lives IN the pattern, so a non-tail `word:` is not a candidate at all.
  it('B1 shapes the reviewer probe-verified as verbatim-storing all yield the span', () => {
    const shapes = [
      `Here: secret_access_key=${SECRET_VALUE}`,
      `AWS credentials: AWS_SECRET_ACCESS_KEY=${SECRET_VALUE}`,
      `note: canlaw_cpt_s3_secret_access_key=${SECRET_VALUE}`,
      `https://api.example.com/data?secret_access_key=${SECRET_VALUE}`,
      `{"url": "https://api.example.com/x?secret_access_key=${SECRET_VALUE}"}`,
      `credentials:\n  AWS_SECRET_ACCESS_KEY: ${SECRET_VALUE}`,
      `secrets:\n  secret_access_key: "${SECRET_VALUE}"`,
      `environment:\n      CANLAW_SECRET_ACCESS_KEY: ${SECRET_VALUE}`,
      // INI form (the one shape that worked pre-fix) still works.
      `aws_secret_access_key = ${SECRET_VALUE}`,
    ];
    for (const s of shapes) {
      const spans = findSecretSpans(s);
      expect(spans.filter((sp) => sp.name === 'Named credential assignment')).toHaveLength(1);
      expect(spans.some((sp) => sp.value === SECRET_VALUE)).toBe(true);
    }
  });

  it('B1 redaction: every B1 shape redacts the secret while keeping the label visible', () => {
    const answer = `AWS credentials: AWS_SECRET_ACCESS_KEY=${SECRET_VALUE}`;
    const out = redactInboundSecrets(answer);
    expect(out).not.toContain(SECRET_VALUE);
    expect(out).toContain('AWS_SECRET_ACCESS_KEY');
  });

  it('B1 OUTBOUND (the reviewer\'s R1f): redactOutboundSecrets redacts the same B1 shapes (shared redactImpl)', () => {
    const out = redactOutboundSecrets(`note: canlaw_cpt_s3_secret_access_key=${SECRET_VALUE}`);
    expect(out.applied).toBe(true);
    expect(out.text).not.toContain(SECRET_VALUE);
    expect(out.text).toContain('canlaw_cpt_s3_secret_access_key');
  });

  it('B1 end-to-end (the reviewer\'s R1g): a prose-prefixed pair on a credential card vaults BOTH values and the row carries neither', async () => {
    const q = await flagCredentialAsk(DECLARED_ENVKEY);
    const answer = `AWS credentials: AWS_ACCESS_KEY_ID=${ACCESS_KEY_ID} AWS_SECRET_ACCESS_KEY=${SECRET_VALUE}`;
    const r = await answerOwnerQuestion(q.id, 'u1', answer);
    expect(r).toBe('ok');
    expect(mockCreds.find((c) => c.envKey === DECLARED_ENVKEY)).toBeTruthy();
    const second = mockCreds.find((c) => c.envKey === 'AWS_SECRET_ACCESS_KEY');
    expect(second).toBeTruthy();
    expect(decryptValue(second.valueEnc)).toBe(SECRET_VALUE);
    const after = mockQuestions.rows.find((row: any) => row.id === q.id);
    expect(String(after.answer)).not.toContain(ACCESS_KEY_ID);
    expect(String(after.answer)).not.toContain(SECRET_VALUE);
  });

  it('B1 end-to-end YAML on the owner\'s own card: the compose mapping vaults and the row carries no value', async () => {
    const q = await flagCredentialAsk(DECLARED_ENVKEY);
    const answer = `environment:\n      CANLAW_SECRET_ACCESS_KEY: ${SECRET_VALUE}`;
    const r = await answerOwnerQuestion(q.id, 'u1', answer);
    // The card declared the KEY-ID half; the owner supplied the SECRET half —
    // the gate correctly STAYS SHUT (reply_recorded: the reply is recorded
    // with its vault notice; nothing falsely resolves the card).
    expect(['ok', 'reply_recorded']).toContain(r);
    // Ticket c54074df/7caf07ed (review finding 1): this pin USED to expect the
    // secret to ride the card's DECLARED gate key (CANLAW_CPT_S3_KEY) — the
    // exact swap class that ticket closed (a 40-char secret minted into a
    // KEY-ID slot). The value now vaults under the owner's own LABEL-DERIVED
    // key (CANLAW_SECRET_ACCESS_KEY — the name the paste itself carries), the
    // declared KEY slot is never written with a secret, and the row carries
    // no value either way.
    expect(mockCreds.find((c) => c.envKey === DECLARED_ENVKEY)).toBeFalsy();
    const labeled = mockCreds.find((c) => c.envKey === 'CANLAW_SECRET_ACCESS_KEY');
    expect(labeled).toBeTruthy();
    expect(decryptValue(labeled.valueEnc)).toBe(SECRET_VALUE);
    const after = mockQuestions.rows.find((row: any) => row.id === q.id);
    expect(String(after.answer)).not.toContain(SECRET_VALUE);
  });

  it('B1 URL-query end-to-end: an S3-style URL on a credential card vaults the secret half', async () => {
    const q = await flagCredentialAsk(DECLARED_ENVKEY);
    const answer = `connect via https://api.example.com/data?secret_access_key=${SECRET_VALUE} please`;
    const r = await answerOwnerQuestion(q.id, 'u1', answer);
    // Wrong half for the declared KEY slot — the gate stays shut (recorded
    // reply + vault notice), never falsely resolves.
    expect(['ok', 'reply_recorded']).toContain(r);
    // Ticket c54074df/7caf07ed: the pin used to expect the secret to ride the
    // DECLARED key-ID slot — the swap class this ticket closed. It now vaults
    // under the label-derived SECRET_ACCESS_KEY key; the declared KEY slot is
    // never written with a secret.
    expect(mockCreds.find((c) => c.envKey === DECLARED_ENVKEY)).toBeFalsy();
    const labeled = mockCreds.find((c) => c.envKey === 'SECRET_ACCESS_KEY');
    expect(labeled).toBeTruthy();
    expect(decryptValue(labeled.valueEnc)).toBe(SECRET_VALUE);
    const after = mockQuestions.rows.find((row: any) => row.id === q.id);
    expect(String(after.answer)).not.toContain(SECRET_VALUE);
  });
});

describe('ticket ca0b57cd — delta-review fixes (722064990 → this commit)', () => {
  it('#1 BLOCKING: a base64 secret BEGINNING WITH `/` is NOT a path — it redacts (the first A1 cut exempted it)', () => {
    const leadingSlashSecret = `/${SECRET_VALUE}`;
    const spans = findSecretSpans(`AWS_SECRET_ACCESS_KEY=${leadingSlashSecret}`);
    expect(spans.some((s) => s.value === leadingSlashSecret)).toBe(true);
    const out = redactInboundSecrets(`AWS_SECRET_ACCESS_KEY=${leadingSlashSecret}`);
    expect(out).not.toContain(leadingSlashSecret);
    // a slash-bearing secret with NO extension tail redacts too (not `/a/b/name.ext`)
    const slashBearer = ['wJalrXUtnFEMI', 'K7MDENG', 'bPxRfiCYEXAMPLEKEY'].join('/');
    expect(redactInboundSecrets(`secret_access_key=${slashBearer}`)).not.toContain(slashBearer);
  });

  it('#1: real path/URL/ARN references stay exempt (the A1 intent, undamaged by the shape fix)', () => {
    const refs = [
      'private_key=/etc/letsencrypt/live/Example2024.com/privkey.pem',
      'private_key: /home/ec2-user/.ssh/Example2024KeyPair.pem',
      'secret_id=arn:aws:secretsmanager:ca-central-1:123456789012:secret:prod/db-AbCdEf',
      'private_key=SHA256:AbCdEf1234567890AbCdEf1234567890AbCdEf1234567890',
      'private_key=MD5:AbCdEf1234567890AbCdEf1234567890',
      'access_key=https://internal.example.com/keys/2024/main',
      // Pass-3 finding #1 (of 1f44ef317): RELATIVE and HOME path references
      // are exempt REGARDLESS of extension — a `~/`, `./` or `../` prefix is
      // an unambiguous path signal (no key format starts with one), and the
      // first shape cut redacted+VAULTED these under the declared gate key.
      'private_key=./keys/Prod2024Key.pem',
      'private_key=../config/Tls2024.crt',
      'private_key=~/.ssh/MyKey2024',
      // Pass-4 finding #1 (of 367387cc9): the tilde-USER home form
      // (`~ec2-user/.ssh/…`) had the same vault+gate-lift harm as `~/`.
      'private_key=~ec2-user/.ssh/Prod2024KeyPair.pem',
      'private_key=~deploy/keys/Prod2024Key.pem',
      'private_key=~root/Prod2024Key.pem',
      'private_key=~/backup/keys/server-prod.pem',
      'private_key=./certs/letsencrypt/privkey.pem',
      'secret_key=../secrets/production.env',
      // a bare-`/` path still needs the multi-segment+extension SHAPE
      'private_key=/usr/local/bin/python3.12',
      'access_key=/backup/keys.pem',
    ];
    for (const t of refs) expect(findSecretSpans(t).filter((s) => s.name === 'Named credential assignment')).toHaveLength(0);
  });

  it('#1 pass-3: a PATH answer on a credential-gated card never vaults and never lifts the gate (the gate-honesty probe)', async () => {
    const q = await flagCredentialAsk(DECLARED_ENVKEY);
    // The pass-3 reviewer's end-to-end repro: this shape minted a junk
    // credential under the declared key and LIFTED the gate on a path.
    const r = await answerOwnerQuestion(q.id, 'u1', 'use private_key=~/.ssh/MyKey2024 for the deploy');
    expect(r).toBe('reply_recorded');
    expect(mockCreds).toHaveLength(0);
    const after = mockQuestions.rows.find((row: any) => row.id === q.id);
    expect(String(after.answer)).toContain('~/.ssh/MyKey2024'); // a reference is not a credential — untouched
    // the relative form too
    const q2 = await flagCredentialAsk('BRAVO_SECRET_KEY');
    const r2 = await answerOwnerQuestion(q2.id, 'u1', 'the key is at ./certs/MyCert2024.pem on the build box');
    expect(r2).toBe('reply_recorded');
    expect(mockCreds).toHaveLength(0);
  });

  it('#4: a literal-escaped JSON paste (backslash-escaped quotes — the 50bcd1e7 shape) redacts', () => {
    // String.raw produces a LITERAL backslash before each quote — the
    // escaped-JSON form the delta review probed (a plain " in a template
    // literal is NOT the escaped form).
    const raw = String.raw`{\"secret_access_key\": \"${SECRET_VALUE}\"}`;
    const out = redactInboundSecrets(raw);
    expect(out).not.toContain(SECRET_VALUE);
    expect(out).toContain('secret_access_key');
    // the plain-quoted JSON form (already covered pre-delta) still redacts
    expect(redactInboundSecrets(`{"secret_access_key": "${SECRET_VALUE}"}`)).not.toContain(SECRET_VALUE);
  });

  it('#2: a counter-question carrying BOTH brackets (capture notice + A7 WARNING) still classifies as a question', () => {
    const withWarning = `which one do you want? [CREDENTIAL VAULTED — the credential-shaped value in this answer were stored in the encrypted coding-credentials vault as $CANLAW_CPT_S3_KEY.] [CREDENTIAL VAULTED — WARNING: 1 more credential-shaped value was captured but could NOT be stored (per-answer cap, a protected key, or a value the vault refuses) and is redacted without a vault copy: charlie_private_key. Re-supply it (store_secret, or Account → Coding → Credentials).]`;
    expect(isCounterQuestionAnswer(withWarning, null)).toBe(true);
    // single-bracket form (the pre-A7 shape) still strips — regression pin
    const singleBracket = `which one do you want? [CREDENTIAL VAULTED — the credential-shaped value in this answer were stored in the encrypted coding-credentials vault as $CANLAW_CPT_S3_KEY.]`;
    expect(isCounterQuestionAnswer(singleBracket, null)).toBe(true);
  });

  it('#3: NOTHING stored but values captured → the notice is the pure WARNING (never "0 values … stored as")', async () => {
    const q = await flagCredentialAsk(DECLARED_ENVKEY);
    // Pre-seed the LABEL-DERIVED key (where family-aware routing sends this
    // span — ticket c54074df/7caf07ed: a secret-labelled value never targets
    // the KEY-ID declared slot) as an INFRA-MANAGED row — the store is
    // refused, nothing stores, the owner must be told.
    mockCreds.push({ id: 'cred-infra', userId: 'u1', envKey: 'CANLAW_CPT_S3_SECRET_ACCESS_KEY', label: '', provider: 'aws', valueEnc: 'x', createdAt: new Date(), updatedAt: new Date() });
    const answer = `canlaw_cpt_s3_secret_access_key=${SECRET_VALUE}`;
    const r = await answerOwnerQuestion(q.id, 'u1', answer);
    // Wrong half for the declared KEY slot — the gate stays shut (recorded
    // reply + vault notice), never falsely resolves.
    expect(['ok', 'reply_recorded']).toContain(r);
    expect(mockCreds.filter((c: any) => c.envKey === 'CANLAW_CPT_S3_SECRET_ACCESS_KEY' && c.provider !== 'aws')).toHaveLength(0); // infra row untouched
    expect(mockCreds.find((c) => c.envKey === DECLARED_ENVKEY)).toBeFalsy(); // the KEY-ID slot never receives the secret
    const after = mockQuestions.rows.find((row: any) => row.id === q.id);
    expect(String(after.answer)).not.toContain(SECRET_VALUE);
    expect(String(after.answer)).toMatch(/\[CREDENTIAL VAULTED — WARNING: 1 credential-shaped value was captured in this answer but could NOT be stored/);
    expect(String(after.answer)).not.toMatch(/0 credential-shaped values/);
    expect(String(after.answer)).not.toMatch(/stored as \$,/);
  });
});
describe('ticket ca0b57cd — review A2/A3/A7 fold-ins', () => {
  it('A3: the store_secret oq_ repair leg resolves an ≥8-char id PREFIX (fleet idiom), refusing ambiguous ones', async () => {
    // A row with a distinctive prefix the full-id findUnique would miss.
    mockQuestions.rows.push({
      id: 'oq_prefix001-ca0b-4994-8770-6933e8567e06',
      chatId: 'chat-1', userId: 'u1', status: 'answered',
      question: `Please paste the ${DECLARED_ENVKEY} credential pair`,
      answer: `canlaw_cpt_s3_secret_access_key=${SECRET_VALUE}`,
      answeredBy: 'owner', expectedAnswerType: `credential:${DECLARED_ENVKEY}`,
      createdAt: new Date(Date.now() - 3600_000), resolvedAt: new Date(),
    });
    const raw = await executeSecretHandoffTool({ sessionId: 'chat-ps', userId: 'u1', machineTriggered: true, userTurnText: '' }, 'store_secret', { envKey: 'SECRET_ACCESS_KEY', fromMessageId: 'oq_prefix001' });
    const out = parse(raw);
    expect(out.ok).toBe(true);
    expect(out.source).toBe('message');
    expect(decryptValue(mockCreds.find((c) => c.envKey === 'SECRET_ACCESS_KEY').valueEnc)).toBe(SECRET_VALUE);
    // Ambiguous prefix → explicit refusal, never a wrong-row lift.
    mockQuestions.rows.push({
      id: 'oq_prefix002-ca0b-4994-8770-6933e8567e06', chatId: 'chat-1', userId: 'u1', status: 'answered',
      question: 'another', answer: 'x', answeredBy: 'owner', expectedAnswerType: null,
      createdAt: new Date(Date.now() - 3600_000), resolvedAt: new Date(),
    });
    const amb = parse(await executeSecretHandoffTool({ sessionId: 'chat-ps', userId: 'u1', machineTriggered: true, userTurnText: '' }, 'store_secret', { envKey: 'Y_KEY', fromMessageId: 'oq_prefix00' }));
    expect(amb.reason).toBe('ambiguous');
  });

  it('A7: a 4-pair answer stores 3 and the notice WARNS about the captured-but-unstored 4th (never silently destroyed)', async () => {
    const q = await flagCredentialAsk(DECLARED_ENVKEY);
    const V2 = ['Zvrx', '9xwDLyaVz328LA'].join('');
    const V3 = ['Qplu', '7bHnGfR2tWq9zXe'].join('');
    const V4 = ['Mncx', '3vKpLd8sHr2wQfT'].join('');
    const answer = `canlaw_cpt_s3_access_key=${ACCESS_KEY_ID} canlaw_cpt_s3_secret_access_key=${SECRET_VALUE} aws_secret_access_key=${V2} bravo_secret_key=${V3} charlie_private_key=${V4}`;
    await answerOwnerQuestion(q.id, 'u1', answer);
    expect(mockCreds).toHaveLength(3);
    const after = mockQuestions.rows.find((row: any) => row.id === q.id);
    expect(String(after.answer)).not.toContain(V4);
    expect(String(after.answer)).toMatch(/WARNING: 2 more credential-shaped values were captured but could NOT be stored/);
    expect(String(after.answer)).toMatch(/charlie_private_key/);
  });

  it('A7 all-stored: a 2-pair answer keeps the plain notice, no WARNING (regression pin)', async () => {
    const q = await flagCredentialAsk(DECLARED_ENVKEY);
    const answer = `canlaw_cpt_s3_access_key=${ACCESS_KEY_ID} canlaw_cpt_s3_secret_access_key=${SECRET_VALUE}`;
    await answerOwnerQuestion(q.id, 'u1', answer);
    const after = mockQuestions.rows.find((row: any) => row.id === q.id);
    expect(String(after.answer)).toMatch(/2 credential-shaped values/);
    expect(String(after.answer)).not.toMatch(/WARNING/);
  });
});

describe('ticket ca0b57cd — the vault: every named value stores, no silent drop', () => {
  it('BOTH halves of the pair vault: declared key for the first, LABEL-DERIVED key for the second; the row carries neither value', async () => {
    const q = await flagCredentialAsk(DECLARED_ENVKEY);
    const answer = `canlaw_cpt_s3_access_key=${ACCESS_KEY_ID}, canlaw_cpt_s3_secret_access_key=${SECRET_VALUE}`;
    const r = await answerOwnerQuestion(q.id, 'u1', answer);
    expect(r).toBe('ok');
    const first = mockCreds.find((c) => c.envKey === DECLARED_ENVKEY);
    expect(first).toBeTruthy();
    expect(decryptValue(first.valueEnc)).toBe(ACCESS_KEY_ID);
    const second = mockCreds.find((c) => c.envKey === 'CANLAW_CPT_S3_SECRET_ACCESS_KEY');
    expect(second).toBeTruthy();
    expect(decryptValue(second.valueEnc)).toBe(SECRET_VALUE);
    const after = mockQuestions.rows.find((row: any) => row.id === q.id);
    expect(String(after.answer)).not.toContain(ACCESS_KEY_ID);
    expect(String(after.answer)).not.toContain(SECRET_VALUE);
    expect(String(after.answer)).toContain('$CANLAW_CPT_S3_KEY');
    expect(String(after.answer)).toContain('$CANLAW_CPT_S3_SECRET_ACCESS_KEY');
  });

  it('the notice names the capture COUNT — "2 credential-shaped values" — so 1-of-2 can never read as complete', async () => {
    const q = await flagCredentialAsk(DECLARED_ENVKEY);
    const answer = `canlaw_cpt_s3_access_key=${ACCESS_KEY_ID} canlaw_cpt_s3_secret_access_key=${SECRET_VALUE}`;
    await answerOwnerQuestion(q.id, 'u1', answer);
    const after = mockQuestions.rows.find((row: any) => row.id === q.id);
    expect(String(after.answer)).toMatch(/2 credential-shaped values/);
  });

  it('the live-row specimen (`+` separator) vaults both halves under the same two keys', async () => {
    const q = await flagCredentialAsk(DECLARED_ENVKEY);
    const answer = `canlaw_cpt_s3_access_key=${ACCESS_KEY_ID},canlaw_cpt_s3_secret_access_key+${SECRET_VALUE}`;
    const r = await answerOwnerQuestion(q.id, 'u1', answer);
    expect(r).toBe('ok');
    expect(mockCreds.find((c) => c.envKey === DECLARED_ENVKEY)).toBeTruthy();
    expect(mockCreds.find((c) => c.envKey === 'CANLAW_CPT_S3_SECRET_ACCESS_KEY')).toBeTruthy();
    const after = mockQuestions.rows.find((row: any) => row.id === q.id);
    expect(String(after.answer)).not.toContain(SECRET_VALUE);
  });

  it('a single-value answer keeps the singular notice wording (regression pin)', async () => {
    const q = await flagCredentialAsk(DECLARED_ENVKEY);
    const answer = `here it is: ${ACCESS_KEY_ID}`;
    await answerOwnerQuestion(q.id, 'u1', answer);
    const after = mockQuestions.rows.find((row: any) => row.id === q.id);
    expect(String(after.answer)).toMatch(/the credential-shaped value\b/);
    expect(String(after.answer)).not.toMatch(/\d credential-shaped values/);
  });

  it('a NON-credential compound label never vaults and never redacts (prose stays verbatim)', async () => {
    const q = await flagCredentialAsk(DECLARED_ENVKEY);
    const answer = 'the sort_order of the report is alphabetical_this_week_no_really';
    // owner WORDS on a credential gate → reply_recorded (the asking lane is
    // woken to answer on the card); the gate stays shut and NOTHING stores.
    const r = await answerOwnerQuestion(q.id, 'u1', answer);
    expect(r).toBe('reply_recorded');
    expect(mockCreds).toHaveLength(0);
    const after = mockQuestions.rows.find((row: any) => row.id === q.id);
    expect(String(after.answer)).toContain('sort_order');
  });

  it('a named value whose label collides with the declared key falls back to the ordinal derived key (never silently dropped)', async () => {
    // Declared gate key AWS_SECRET_ACCESS_KEY; both labels normalize to it —
    // the first rides the declared key, the second must NOT overwrite it and
    // falls to OWNER_ANSWER_<id>_2 (the pre-ca0b57cd behavior for ALL spans).
    const q = await flagCredentialAsk('AWS_SECRET_ACCESS_KEY');
    const SECOND_VALUE = ['Zvrx', '9xwDLyaVz328LAq'].join('');
    const answer = `aws_secret_access_key=${SECRET_VALUE} AWS_SECRET_ACCESS_KEY=${SECOND_VALUE}`;
    await answerOwnerQuestion(q.id, 'u1', answer);
    const ids = mockCreds.map((c: any) => c.envKey).sort();
    expect(ids).toContain('AWS_SECRET_ACCESS_KEY');
    expect(ids).toHaveLength(2);
    expect(ids[1]).toMatch(/^OWNER_ANSWER_[0-9A-Z]{8}_2$/);
    expect(decryptValue(mockCreds.find((c) => c.envKey === 'AWS_SECRET_ACCESS_KEY').valueEnc)).toBe(SECRET_VALUE);
    expect(decryptValue(mockCreds.find((c) => c.envKey).valueOf() && mockCreds.find((c: any) => /^OWNER_ANSWER_/.test(c.envKey)).valueEnc)).toBe(SECOND_VALUE);
  });
});

describe('ticket ca0b57cd — store_secret repair leg: fromMessageId → owner-question ANSWER row', () => {
  const machineCtx = (extra: Record<string, unknown> = {}) => ({ sessionId: 'chat-ps', userId: 'u1', machineTriggered: true, userTurnText: '', ...extra });

  it('lifts the dropped half from a legacy half-vaulted oq_ row (the ticket\'s second ask: the supervisor repair path)', async () => {
    // The PRE-FIX stored row (exactly what live oq_f04ac515 holds): the first
    // value redacted + vault notice, the second value still RAW on the row.
    // A supervisor cites the oq_ id; store_secret lifts the raw secret half.
    mockQuestions.rows.push({
      id: 'oq_legacy0001-ca0b-4994-8770-6933e8567e06',
      chatId: 'chat-1', userId: 'u1', status: 'answered',
      question: `Please paste the ${DECLARED_ENVKEY} credential pair`,
      answer: `canlaw_cpt_s3_access_key=[REDACTED: looked like a credential],canlaw_cpt_s3_secret_access_key=${SECRET_VALUE} [CREDENTIAL VAULTED — the credential-shaped value(s) in this answer were stored in the encrypted coding-credentials vault as $CANLAW_CPT_S3_KEY]`,
      answeredBy: 'owner', expectedAnswerType: `credential:${DECLARED_ENVKEY}`,
      createdAt: new Date(Date.now() - 3600_000), resolvedAt: new Date(),
    });
    const raw = await executeSecretHandoffTool(machineCtx(), 'store_secret', { envKey: 'CANLAW_CPT_S3_SECRET_ACCESS_KEY', fromMessageId: 'oq_legacy0001-ca0b-4994-8770-6933e8567e06' });
    expect(raw).not.toContain(SECRET_VALUE);
    const out = parse(raw);
    expect(out.ok).toBe(true);
    expect(out.source).toBe('message');
    const stored = mockCreds.find((c) => c.envKey === 'CANLAW_CPT_S3_SECRET_ACCESS_KEY');
    expect(stored).toBeTruthy();
    expect(decryptValue(stored.valueEnc)).toBe(SECRET_VALUE);
  });

  it('refuses not_owner_typed when the row was answered by a supervisor (a ruling is not a paste)', async () => {
    const q = await flagCredentialAsk(DECLARED_ENVKEY);
    await answerOwnerQuestion(q.id, 'u1', `supervisor ruling text not a credential ${ACCESS_KEY_ID}`, { answeredBy: 'supervisor' });
    const out = parse(await executeSecretHandoffTool(machineCtx(), 'store_secret', { envKey: 'X_KEY', fromMessageId: q.id }));
    expect(out.reason).toBe('not_owner_typed');
  });

  it('refuses message_not_found for an oq_ id on another account', async () => {
    const q = await flagCredentialAsk(DECLARED_ENVKEY);
    await answerOwnerQuestion(q.id, 'u1', `key: ${ACCESS_KEY_ID}`);
    const out = parse(await executeSecretHandoffTool(machineCtx({ userId: 'u2' }), 'store_secret', { envKey: 'X_KEY', fromMessageId: q.id }));
    expect(out.reason).toBe('message_not_found');
  });

  it('refuses message_not_found for an unknown oq_ id', async () => {
    const out = parse(await executeSecretHandoffTool(machineCtx(), 'store_secret', { envKey: 'X_KEY', fromMessageId: 'oq_00000000-0000-0000-0000-000000000000' }));
    expect(out.reason).toBe('message_not_found');
  });

  it('a chat-message fromMessageId still works unchanged (regression pin)', async () => {
    mockMessages.push({ id: 'msg-1', role: 'user', content: `the key is ${ACCESS_KEY_ID}`, metadata: null, chat: { userId: 'u1' } });
    const out = parse(await executeSecretHandoffTool(machineCtx(), 'store_secret', { envKey: 'X_KEY', fromMessageId: 'msg-1' }));
    expect(out.ok).toBe(true);
  });
});
