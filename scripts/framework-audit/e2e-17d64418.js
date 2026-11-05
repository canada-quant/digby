// e2e-17d64418.js — LIVE post-deploy E2E replay for ticket 17d64418
// (vault-fix review follow-ups, PR #1885, squash 05b265cb).
//
// RUN ONLY AFTER THE FIX HAS DEPLOYED (it asserts the FIXED behavior; on the
// pre-fix tree legs fail by design — each leg carries a pre/post discriminator,
// so the probe is self-verifying against whatever container runs it).
//
// Legs (mirroring the committed suites at 05b265cb):
//  (b) owner-answer-vault.17d64418: three contradictory-labeled spans fill the
//      per-answer cap; the paste candidate that claimed the declared slot is
//      cap-refused and the notice NAMES it (pre-fix: silently dropped while the
//      notice read "3 … stored"). Full path through the REAL answerOwnerQuestion.
//  (c) credentials.service.17d64418: awsSlotFamily edge classifications —
//      S3_BUCKET_KEY/MY_AWS_KEY no longer key-ID slots; S3_SECRET_KEY_2 and
//      label-suffixed key-ID slots now measure their families; corridor pins
//      (CANLAW_CPT_S3_KEY) stay put. Plus one REAL store that pre-fix THREW
//      (S3_BUCKET_KEY + genuine 40-char secret) and one REAL refusal that must
//      still throw (CANLAW_CPT_S3_KEY + 40-char secret).
//  (d) credential-gate.17d64418: the credentialLifted decision table against a
//      stub prisma (pure, no writes) — the fail-OPEN-on-unreadable branch is
//      THE pin, plus the (c)-interplay leg (a readable 40-char secret in a
//      label-suffixed key-ID slot must NOT lift; pre-(c) it did).
//
// MASKED: zero secret values printed — only lengths, sha8 fingerprints and
// pass/fail flags. Synthetic user + non-existent chatId string; every row the
// probe creates is deleted in finally (the e2e-7caf07ed.js pattern).
//
// Usage (POST-DEPLOY only, from the repo root):
//   bash scripts/framework-audit/run-on-box.sh A \
//     "bash /opt/crossmodel/scripts/framework-audit/prodq.sh /tmp/e2e-17d64418.js"
var USER_TAG = 'e2e-17d64418';
var DECLARED = 'E2E_17D64418_SECRET_ACCESS_KEY'; // classic SECRET_ACCESS_KEY anchor → family 'secret'

async function main() {
  var db = require('/app/dist/config/database');
  var prisma = await (db.default || db);
  var crypto = require('crypto');
  var oq = require('/app/dist/modules/crossmodel/platform/owner-questions');
  var creds = require('/app/dist/modules/crossmodel/coding/credentials.service');
  var gate = require('/app/dist/modules/crossmodel/platform/credential-gate');
  var out = { legs: {}, cleanup: {} };

  // ── fixtures: assembled from parts, structurally valid shapes only ──
  var SECRET40 = '/' + ['fLnGw229n89c5Ufq', 'Zvrx9xwDLyaVz328', 'LAqYLz9'].join(''); // 40 chars
  if (SECRET40.length !== 40) throw new Error('fixture length ' + SECRET40.length);
  var AKIA20 = ['AKIA', 'QWERTYUIOP123456'].join(''); // 20-char fake key ID, never real
  var SPAN_VALUES = [
    ['Kx9mQ2vLpR7tW4nZb8yC3dH6fJ1sA5', 'eG'].join(''),
    ['Qw7rT4xZb2nM9kPd6hJ3cF8vL5sY1u', 'aD'].join(''),
    ['Zt5bN8kJ2mH7cQ4xV9dL6pR3wS1yF', 'gB'].join(''),
  ]; // 34-char mixed tokens — NOT AWS-shaped (cap-refused only, never value-refused)
  var SPAN_LABELS = ['aws_access_key_id', 'backup_access_key_id', 'old_access_key_id'];
  var spanAnswer = function (labels, values) {
    return labels.map(function (l, i) { return l + '=' + values[i]; }).join(', ');
  };
  var sha8 = function (v) { return crypto.createHash('sha256').update(v).digest('hex').slice(0, 8); };
  out.fixtureSha8 = { secret40: sha8(SECRET40) }; // for cross-checking readbacks

  var userId = 'user-' + USER_TAG + '-' + Date.now();
  var chatId = 'e2e-chat-' + USER_TAG + '-' + Date.now(); // NON-EXISTENT string, never null (7caf07ed rule)
  var qidB = null;
  try {
    await prisma.user.create({ data: { id: userId, email: USER_TAG + '@invalid.test', name: USER_TAG, password: 'x' } });

    // ── LEG (c) — slot-family edges, PURE reads first (write-free) ──
    var fam = {
      S3_BUCKET_KEY: creds.awsSlotFamily('S3_BUCKET_KEY'),            // pre-fix: 'key-id'  → null
      MY_AWS_KEY: creds.awsSlotFamily('MY_AWS_KEY'),                  // pre-fix: 'key-id'  → null
      OPENAI_API_KEY: creds.awsSlotFamily('OPENAI_API_KEY'),          // generic: stays null
      S3_SECRET_KEY_2: creds.awsSlotFamily('S3_SECRET_KEY_2'),        // pre-fix: null      → 'secret'
      AWS_ACCESS_KEY_ID_DIGBYOPERATOR: creds.awsSlotFamily('AWS_ACCESS_KEY_ID_DIGBYOPERATOR'), // pre-fix: null → 'key-id'
      CANLAW_CPT_S3_KEY: creds.awsSlotFamily('CANLAW_CPT_S3_KEY'),    // corridor pin: stays 'key-id'
    };
    var mism = {
      S3_SECRET_KEY_2_akia: creds.valueSlotMismatch('S3_SECRET_KEY_2', AKIA20) !== null, // pre-fix: false (no pair protection)
      suffixedKeyId_secret: creds.valueSlotMismatch('AWS_ACCESS_KEY_ID_DIGBYOPERATOR', SECRET40) !== null, // pre-fix: false
      S3_BUCKET_KEY_secret: creds.valueSlotMismatch('S3_BUCKET_KEY', SECRET40) === null, // genuine secret stores unrefused
    };
    // REAL store that pre-fix THREW (the review's exact edge) + corridor refusal that must still throw
    var storeEdge = {};
    try {
      await creds.upsertCredential(userId, 'custom', 'S3_BUCKET_KEY', SECRET40);
      storeEdge.s3BucketKeyStores = true;
    } catch (e) { storeEdge.s3BucketKeyStores = false; storeEdge.s3BucketKeyErr = String(e).slice(0, 120); }
    try {
      await creds.upsertCredential(userId, 'custom', 'CANLAW_CPT_S3_KEY', SECRET40);
      storeEdge.corridorRefuses = false; // MUST throw — a green here is a corridor regression
    } catch (e) { storeEdge.corridorRefuses = true; }
    out.legs.c = {
      families: fam, mismatches: mism, storeEdge: storeEdge,
      PASS: fam.S3_BUCKET_KEY === null && fam.MY_AWS_KEY === null && fam.OPENAI_API_KEY === null
        && fam.S3_SECRET_KEY_2 === 'secret' && fam.AWS_ACCESS_KEY_ID_DIGBYOPERATOR === 'key-id'
        && fam.CANLAW_CPT_S3_KEY === 'key-id'
        && mism.S3_SECRET_KEY_2_akia && mism.suffixedKeyId_secret && mism.S3_BUCKET_KEY_secret
        && storeEdge.s3BucketKeyStores && storeEdge.corridorRefuses,
    };

    // ── LEG (d) — credentialLifted decision table (stub prisma, pure) ──
    var CORRUPT = Buffer.from('not-actual-ciphertext').toString('base64'); // valid base64, no AES-GCM tag
    var stub = function (row) {
      return {
        runToolReceipt: { findFirst: async function () { return null; } },
        codingCredential: { findFirst: async function () { return row; } },
      };
    };
    var row = function (envKey, valueEnc) {
      return { id: 'cred-' + envKey, envKey: envKey, valueEnc: valueEnc, label: '', userId: userId, provider: 'custom' };
    };
    var d1 = await gate.credentialLifted(stub(row(DECLARED, CORRUPT)), userId, DECLARED);                    // THE (d) PIN: unreadable → fail-OPEN
    var d2 = await gate.credentialLifted(stub(row(DECLARED, creds.encryptValue(AKIA20))), userId, DECLARED); // readable mismatch → SHUT
    var d3 = await gate.credentialLifted(stub(row(DECLARED, creds.encryptValue(SECRET40))), userId, DECLARED); // readable fitting → lifted
    var d4 = await gate.credentialLifted(stub(null), userId, DECLARED);                                      // no row → fail-closed
    var d5 = await gate.credentialLifted(stub(row('AWS_ACCESS_KEY_ID_DIGBYOPERATOR', creds.encryptValue(SECRET40))), userId, 'AWS_ACCESS_KEY_ID_DIGBYOPERATOR'); // (c) interplay: readable secret in suffixed key-ID slot → SHUT (pre-(c): lifted)
    out.legs.d = {
      unreadable_lifts: d1, readableMismatch_shut: d2, readableFitting_lifts: d3, noRow_failClosed: d4, suffixedKeyId_shut: d5,
      PASS: d1.lifted === true && d1.via === 'store'
        && d2.lifted === false && d3.lifted === true && d3.via === 'store'
        && d4.lifted === false && d5.lifted === false,
    };

    // ── LEG (b) — the cap-exhausted paste is NAMED, through the REAL path ──
    var qb = await oq.flagOwnerQuestion({
      chatId: chatId, userId: userId,
      question: 'E2E ' + USER_TAG + ' b', expectedAnswerType: 'credential:' + DECLARED,
    });
    if (!qb || qb.kind !== 'created' || !qb.question) throw new Error('flag refused: ' + JSON.stringify(qb).slice(0, 200));
    qidB = qb.question.id;
    var answerB = spanAnswer(SPAN_LABELS, SPAN_VALUES);
    var rB = await oq.answerOwnerQuestion(qidB, userId, answerB, { answeredBy: 'owner', credentialPaste: true });
    var rowsB = await prisma.codingCredential.findMany({
      where: { userId: userId }, select: { envKey: true, label: true, valueEnc: true },
    });
    var declaredRow = rowsB.find(function (r) { return r.envKey === DECLARED && !r.label; }) || null;
    var spanRows = rowsB.filter(function (r) { return ['AWS_ACCESS_KEY_ID', 'BACKUP_ACCESS_KEY_ID', 'OLD_ACCESS_KEY_ID'].indexOf(r.envKey) >= 0; });
    var answerText = '';
    try {
      var rowB = await prisma.ownerQuestion.findUnique({ where: { id: qidB } });
      answerText = String(rowB && rowB.answer);
    } catch (e) { answerText = 'READ_ERR ' + String(e).slice(0, 100); }
    var txt = {
      namesPaste: answerText.indexOf('the pasted value') >= 0,
      reSupply: answerText.indexOf('Re-supply') >= 0,
      warning1more: answerText.indexOf('WARNING: 1 more credential-shaped value was captured but could NOT be stored') >= 0,
      stored3truthful: answerText.indexOf('3 credential-shaped values in this answer were stored') >= 0,
      redactedSpans: SPAN_VALUES.every(function (v) { return answerText.indexOf(v) < 0; }),
    };
    out.legs.b = {
      answerResult: String(rB), spanRowsStored: spanRows.length, declaredRowStored: !!declaredRow,
      spanRowLens: spanRows.map(function (r) { return creds.decryptValue(r.valueEnc).length; }),
      notice: txt,
      PASS: ['ok', 'reply_recorded', 'credential_pending'].indexOf(String(rB)) >= 0
        && spanRows.length === 3 && !declaredRow
        && txt.namesPaste && txt.reSupply && txt.warning1more && txt.stored3truthful && txt.redactedSpans,
    };

    out.E2E_PASS = out.legs.b.PASS && out.legs.c.PASS && out.legs.d.PASS;
  } finally {
    try {
      if (userId) {
        var delC = await prisma.codingCredential.deleteMany({ where: { userId: userId } });
        var delQ = await prisma.ownerQuestion.deleteMany({ where: { userId: userId } });
        var delM = await prisma.crossModelMessage.deleteMany({ where: { chatId: chatId } });
        var delU = await prisma.user.deleteMany({ where: { id: userId } });
        out.cleanup = { credentials: delC.count, questions: delQ.count, messages: delM.count, users: delU.count };
      }
    } catch (e) { out.cleanupErr = String(e).slice(0, 200); }
  }
  console.log(JSON.stringify(out, null, 1));
  if (!out.E2E_PASS) process.exit(2);
}
// Exit 0 EXPLICITLY on success (7caf07ed: the container's redis quit-handler
// ClientClosedError flips a green probe to rc:1 at drain time otherwise).
main().then(function () { process.exit(0); }).catch(function (e) { console.error('E2E_FAIL', String(e).slice(0, 400)); process.exit(1); });
