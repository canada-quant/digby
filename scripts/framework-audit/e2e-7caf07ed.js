// e2e-7caf07ed.js — LIVE post-deploy E2E replay for tickets 7caf07ed / c54074df.
// RUN ONLY AFTER THE FIX HAS DEPLOYED (it asserts the FIXED behavior; on unfixed
// prod it would fail by design — the signature-3 corruption).
//
// Acceptance definition (supervisor-split): vault a known 40-char test value through
// the card-answer path, read it back, assert len 40 + byte-identity — MASKED (zero
// values printed; only lengths, sha8 fingerprints, pass/fail).
//
// Method: runs inside the live backend container via prodq.sh (the established
// framework-audit probe pattern). Creates a SYNTHETIC user + owner question with
// expectedAnswerType credential:<TEST_ENV_KEY>, answers it through the REAL
// answerOwnerQuestion (the deployed dist — the exact card-answer path), reads the
// vault row back via decryptValue, asserts byte-identity, then DELETES every row it
// created (cleanup by id — nothing persists). The fresh-shell injection layer is
// separately proven byte-faithful (paste-3's 20-char KEY row arrived intact in a
// fresh shell), so the decryptValue readback is the equivalent evidence without
// minting a whole coding session for a synthetic user.
//
// Usage (POST-DEPLOY only):
//   bash scripts/framework-audit/run-on-box.sh A \
//     "bash /opt/crossmodel/scripts/framework-audit/prodq.sh /tmp/e2e-7caf07ed.js"
var TEST_ENV_KEY = 'E2E_7CAF07ED_TEST_SECRET';
// Leg (b) declares its OWN key: if both legs shared one envKey, leg (b)'s
// paste-intent store would OVERWRITE leg (a)'s declared row — and a broken
// leg (a) (the AKIA-in-declared-slot bug) would read back green after the
// overwrite. Independent keys make each leg separately falsifiable.
var TEST_ENV_KEY_2 = 'E2E_7CAF07ED_TEST_SECRET2';
var USER_TAG = 'e2e-7caf07ed';

async function main() {
  const db = require('/app/dist/config/database');
  const prisma = (await (db.default || db));
  const crypto = require('crypto');
  const oq = require('/app/dist/modules/crossmodel/platform/owner-questions');
  const creds = require('/app/dist/modules/crossmodel/coding/credentials.service');
  const out = { created: {}, assertions: {}, cleanup: {} };

  // Known 40-char synthetic value, leading '/' (the ca0b57cd-sensitive class),
  // assembled from parts so no contiguous credential-shaped literal sits in source.
  const secret = '/' + ['e2E7cafA', 'Zq1wL', 'PbRtYv8k6', 'CdFgHj3l2', 'SsUuWw9x'].join('');
  if (secret.length !== 40) throw new Error('fixture length ' + secret.length);
  const sha8 = crypto.createHash('sha256').update(secret).digest('hex').slice(0, 8);
  const AKIA = ['AKIA', 'E2ETESTFAKEKEY99'].join(''); // 20-char fake, never a real key

  const userId = 'user-' + USER_TAG + '-' + Date.now();
  let questionId = null;
  try {
    // 1. synthetic user (deleted in finally)
    await prisma.user.create({ data: { id: userId, email: USER_TAG + '@invalid.test', name: USER_TAG, password: 'x' } });
    out.created.user = true;

    // 2. the incident shapes through the REAL deployed card-answer path
    const results = {};
    // Synthetic NON-EXISTENT chatId (the prisma column is a non-null String with
    // no FK; every crossModelChat lookup on it is best-effort findUnique → null,
    // so no triage wake, no project prefix, no ledger fanout).
    const chatId = 'e2e-chat-' + USER_TAG + '-' + Date.now();
    // (a) two-value paste on a SECRET-declared card (the oq_6a08615e replay)
    const q1 = await oq.flagOwnerQuestion({
      chatId: chatId, userId: userId,
      question: 'E2E ' + USER_TAG + ' a', expectedAnswerType: 'credential:' + TEST_ENV_KEY,
    });
    questionId = q1 && q1.question ? q1.question.id : null;
    results.twoValue = await oq.answerOwnerQuestion(questionId, userId,
      'x_access_key=' + AKIA + ', x_secret_access_key=' + secret, { answeredBy: 'owner' });
    // (b) paste-intent single value (the card's dedicated secret input)
    const q2 = await oq.flagOwnerQuestion({
      chatId: chatId, userId: userId,
      question: 'E2E ' + USER_TAG + ' b', expectedAnswerType: 'credential:' + TEST_ENV_KEY_2,
    });
    results.pasteIntent = await oq.answerOwnerQuestion(q2.question.id, userId, secret,
      { answeredBy: 'owner', credentialPaste: true });

    // 3. read back the vault rows — MASKED (len + sha8 + equality flags only)
    const rows = await prisma.codingCredential.findMany({
      where: { userId: userId, envKey: { contains: 'E2E_7CAF07ED' } },
      select: { envKey: true, label: true, valueEnc: true },
    });
    const read = rows.map(function (r) {
      const v = creds.decryptValue(r.valueEnc);
      return { envKey: r.envKey, label: r.label, len: v.length,
        sha8: crypto.createHash('sha256').update(v).digest('hex').slice(0, 8),
        byteEqualToFixture: v === secret, isAkiaShaped: /^AKIA/.test(v) };
    });
    out.readback = read;

    // 4. assertions (the acceptance bar) — PER LEG, each separately falsifiable
    const declared = read.find(function (r) { return r.envKey === TEST_ENV_KEY && !r.label; });
    out.assertions.legA_rowExists = !!declared;
    out.assertions.legA_len40 = !!(declared && declared.len === 40);
    out.assertions.legA_byteIdentical = !!(declared && declared.byteEqualToFixture);
    out.assertions.legA_notAkia = !!(declared && !declared.isAkiaShaped);
    const declaredB = read.find(function (r) { return r.envKey === TEST_ENV_KEY_2 && !r.label; });
    out.assertions.legB_rowExists = !!declaredB;
    out.assertions.legB_len40 = !!(declaredB && declaredB.len === 40);
    out.assertions.legB_byteIdentical = !!(declaredB && declaredB.byteEqualToFixture);
    out.assertions.fixtureSha8 = sha8; // for cross-checking the readback fingerprint
    out.E2E_PASS = out.assertions.legA_rowExists && out.assertions.legA_len40
      && out.assertions.legA_byteIdentical && out.assertions.legA_notAkia
      && out.assertions.legB_rowExists && out.assertions.legB_len40
      && out.assertions.legB_byteIdentical;
    out.answerResults = { twoValue: String(results.twoValue), pasteIntent: String(results.pasteIntent) };
  } finally {
    // 5. cleanup — delete EVERYTHING this probe created (by exact ids/tag)
    try {
      if (userId) {
        const delCreds = await prisma.codingCredential.deleteMany({ where: { userId: userId } });
        const delQ = await prisma.ownerQuestion.deleteMany({ where: { userId: userId } });
        const delU = await prisma.user.deleteMany({ where: { id: userId } });
        out.cleanup = { credentials: delCreds.count, questions: delQ.count, users: delU.count };
      }
    } catch (e) { out.cleanupErr = String(e).slice(0, 200); }
  }
  console.log(JSON.stringify(out, null, 1));
  if (!out.E2E_PASS) process.exit(2);
}
// Exit 0 EXPLICITLY on success: the container's redis client registers a
// process-level quit handler (/app/dist/config/redis.js) whose ClientClosedError
// at drain-time flips a green probe to rc:1 — observed live 2026-10-22.
main().then(function () { process.exit(0); }).catch(function (e) { console.error('E2E_FAIL', String(e).slice(0, 400)); process.exit(1); });
