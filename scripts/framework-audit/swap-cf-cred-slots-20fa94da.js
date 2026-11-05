#!/usr/bin/env node
/**
 * swap-cf-cred-slots-20fa94da.js — WRITE one-shot (feedback ticket 20fa94da).
 *
 * The mishap: the CQL Cloudflare pair was stored with the two values SWAPPED —
 * the 32-hex ACCOUNT ID under envKey CLOUDFLARE_API_TOKEN (label CQL) and the
 * working cfat_ ACCOUNT API TOKEN under envKey CLOUDFLARE_ACCOUNT_ID (label
 * CQL). Credential values are write-only, so nothing could flag the mapping;
 * lanes rediscovered it through live CF 400/6111 failures.
 *
 * What this does: for EVERY user, finds Cloudflare slot PAIRS whose values
 * carry the EXACT swapped shape (32-hex in the token slot AND a
 * cfk_/cfut_/cfat_ token in the account-id slot) and swaps the two stored
 * valueEnc BLOBS directly — the blobs are opaque AES-256-GCM ciphertext, so
 * swapping them swaps the values with NO decrypt→re-encrypt round trip and no
 * chance of touching the plaintext. Values are decrypted only to CLASSIFY the
 * shape and are NEVER printed — output carries row ids, envKeys, labels and
 * shape classes only.
 *
 * Pairing is NAMESPACE-AWARE (adversarial review F3): the pair key is the
 * derived INJECTED-name tail — envKey CLOUDFLARE_API_TOKEN + label CQL and
 * envKey CLOUDFLARE_API_TOKEN_CQL + label '' are BOTH (slot=token, tail=CQL)
 * and pair only with their own (slot=account-id, tail=CQL) counterpart. A
 * group with more than one row in a slot is never guessed at: the extra rows
 * are reported as unexamined (with row ids) and the group is skipped.
 *
 * ALL-OR-NOTHING APPLY (adversarial review F2): the swap runs inside ONE
 * INTERACTIVE transaction that re-reads both rows and throws — rolling the
 * whole transaction back — unless BOTH guarded updates match exactly one row.
 * A concurrent re-save between the scan and the apply therefore lands as a
 * clean skippedChanged (nothing written), never a partial swap. On the happy
 * path a re-run reports already-correct; the script deliberately keeps NO
 * backup row (the previous mapping is the same two blobs, and the apply is
 * atomic — there is no partial state to recover from).
 *
 * DRY RUN BY DEFAULT (prints the candidate list; writes nothing). --apply
 * performs the atomic swap. Filters: --user <userId-prefix|full> narrows to
 * one user.
 *
 * Usage (in the live backend container, via prodq.sh):
 *   bash /opt/crossmodel/scripts/framework-audit/prodq.sh swap-cf-cred-slots-20fa94da.js           # dry run
 *   bash /opt/crossmodel/scripts/framework-audit/prodq.sh swap-cf-cred-slots-20fa94da.js --apply   # swap
 *
 * Local proof: backend/src/scripts/swap-cf-cred-slots-20fa94da.test.ts
 */
'use strict';

// Mirror of the service guard's shapes (credentials.service.ts ticket
// 20fa94da) and the secret scanner's Cloudflare family (secret-scan.ts ticket
// 82dd8756). Inlined deliberately: the script must classify shapes the same
// way BEFORE and AFTER the validation ships, independent of deploy state.
const CF_TOKEN_RE = /^cf(?:k|ut|at)_[A-Za-z0-9]{30,}$/;
const CF_ACCOUNT_ID_RE = /^[0-9a-fA-F]{32}$/;
// Slot prefixes of the derived INJECTED name (envKey + '_' + label). The tail
// after the prefix is the pair namespace: base+label-CQL and suffix-in-envKey
// CQL both normalize to tail 'CQL' and pair within it, never across it.
const TOKEN_SLOT_PREFIX = 'CLOUDFLARE_API_TOKEN';
const ACCOUNT_SLOT_PREFIX = 'CLOUDFLARE_ACCOUNT_ID';
const shapeOf = (v) => {
  const s = String(v || '').trim();
  if (CF_ACCOUNT_ID_RE.test(s)) return 'account-id(32hex)';
  if (CF_TOKEN_RE.test(s)) return 'cf-token(cfk_/cfut_/cfat_)';
  return 'unknown';
};

/** (slot, tail) of a row's derived injected name — slot null when it is not a CF slot row. */
function slotOf(envKey, label) {
  const injected = `${envKey}${label ? `_${label}` : ''}`;
  if (injected === TOKEN_SLOT_PREFIX) return { slot: 'token', tail: '' };
  if (injected.startsWith(`${TOKEN_SLOT_PREFIX}_`)) return { slot: 'token', tail: injected.slice(TOKEN_SLOT_PREFIX.length + 1) };
  if (injected === ACCOUNT_SLOT_PREFIX) return { slot: 'account-id', tail: '' };
  if (injected.startsWith(`${ACCOUNT_SLOT_PREFIX}_`)) return { slot: 'account-id', tail: injected.slice(ACCOUNT_SLOT_PREFIX.length + 1) };
  return { slot: null, tail: '' };
}

function parseArgs(argv) {
  const out = { apply: false, user: null };
  const args = argv || [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--apply') out.apply = true;
    else if (a === '--dry-run') out.apply = false;
    else if (a === '--user') {
      const next = args[i + 1];
      if (!next || next.startsWith('-')) throw new Error('--user needs a value: --user <userId-prefix>');
      out.user = next; i += 1;
    } else if (a.startsWith('--user=')) {
      const v = a.slice(7);
      if (!v) throw new Error('--user= is empty — pass a userId prefix or drop the filter');
      out.user = v;
    } else if (a.startsWith('--')) throw new Error(`unknown arg: ${a}`);
    else if (a.startsWith('-')) throw new Error(`unknown arg: ${a} (did you mean --apply?)`);
    else if (out.user === null) out.user = a;
    else throw new Error(`unexpected positional: ${a}`);
  }
  return out;
}

async function run({ prisma, argv, decrypt }) {
  const args = parseArgs(argv || []);
  const result = { ticket: '20fa94da', apply: args.apply, scannedPairs: 0, swapped: 0, alreadyCorrect: 0, skippedChanged: 0, skippedIncomplete: 0, skippedWrongShape: 0, candidates: [], unexamined: [], errors: [] };

  // Every Cloudflare slot row; the namespace filter below does the real work.
  const rows = await prisma.codingCredential.findMany({
    where: { envKey: { startsWith: 'CLOUDFLARE_' } },
    select: { id: true, userId: true, provider: true, envKey: true, label: true, valueEnc: true, updatedAt: true },
    orderBy: [{ userId: 'asc' }, { label: 'asc' }, { envKey: 'asc' }],
  });
  const filtered = args.user ? rows.filter((r) => r.userId === args.user || r.userId.startsWith(args.user)) : rows;

  // Group per (userId, injected-name tail) — the derived NAMESPACE, so base+label
  // pairs and suffix-in-envKey pairs each stay within their own namespace.
  const groups = new Map();
  for (const r of filtered) {
    const { slot, tail } = slotOf(r.envKey, r.label || '');
    if (!slot) continue; // some other CLOUDFLARE_* key (e.g. CLOUDFLARE_ZONE_ID)
    const key = `${r.userId}\u0000${tail}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ ...r, slot });
  }

  for (const [key, group] of groups) {
    result.scannedPairs += 1;
    const [userId, tail] = key.split('\u0000');
    const tokenRows = group.filter((r) => r.slot === 'token');
    const idRows = group.filter((r) => r.slot === 'account-id');
    const describe = { userId: userId.slice(0, 8), namespace: tail || '(primary)', provider: group[0].provider || '' };
    // Never guess a slot with more than one candidate row (review F3a): report
    // the unexamined rows and skip the whole group.
    if (tokenRows.length > 1 || idRows.length > 1) {
      result.skippedIncomplete += 1;
      result.unexamined.push({ ...describe, verdict: 'ambiguous-slot', rowIds: group.map((r) => r.id), envKeys: group.map((r) => r.envKey) });
      continue;
    }
    const tokenSlot = tokenRows[0];
    const idSlot = idRows[0];
    if (!tokenSlot || !idSlot) {
      result.skippedIncomplete += 1;
      result.candidates.push({ ...describe, verdict: 'incomplete-pair', slots: group.map((r) => `${r.envKey}${r.label ? '+' + r.label : ''}`) });
      continue;
    }
    let tokenVal, idVal;
    try {
      tokenVal = decrypt(tokenSlot.valueEnc);
      idVal = decrypt(idSlot.valueEnc);
    } catch (err) {
      result.errors.push({ ...describe, verdict: 'undecryptable', message: String(err && err.message ? err.message : err).slice(0, 120) });
      continue;
    }
    const tokenShape = shapeOf(tokenVal);
    const idShape = shapeOf(idVal);
    const swapped = tokenShape === 'account-id(32hex)' && idShape === 'cf-token(cfk_/cfut_/cfat_)';
    if (!swapped) {
      if (tokenShape === 'cf-token(cfk_/cfut_/cfat_)' && (idShape === 'account-id(32hex)' || idShape === 'unknown')) {
        result.alreadyCorrect += 1; // token in the token slot — correctly mapped (or the id slot holds something we don't classify)
        result.candidates.push({ ...describe, verdict: 'already-correct', tokenSlotShape: tokenShape, idSlotShape: idShape });
      } else {
        result.skippedWrongShape += 1;
        result.candidates.push({ ...describe, verdict: 'wrong-shape', tokenSlotShape: tokenShape, idSlotShape: idShape });
      }
      continue;
    }
    result.candidates.push({ ...describe, verdict: 'SWAPPED', tokenSlotShape: tokenShape, idSlotShape: idShape, rowIds: [tokenSlot.id, idSlot.id] });
    if (!args.apply) continue;

    // ALL-OR-NOTHING (review F2): one INTERACTIVE transaction that re-reads
    // both rows and THROWS — rolling back everything — unless both guarded
    // updates match exactly one row. A concurrent re-save between the scan and
    // this point surfaces as skippedChanged with NOTHING written.
    try {
      const outcome = await prisma.$transaction(async (tx) => {
        const freshTok = await tx.codingCredential.findUnique({ where: { id: tokenSlot.id }, select: { valueEnc: true } });
        const freshId = await tx.codingCredential.findUnique({ where: { id: idSlot.id }, select: { valueEnc: true } });
        if (!freshTok || !freshId || freshTok.valueEnc !== tokenSlot.valueEnc || freshId.valueEnc !== idSlot.valueEnc) return 'changed';
        const w1 = await tx.codingCredential.updateMany({ where: { id: tokenSlot.id, valueEnc: tokenSlot.valueEnc }, data: { valueEnc: idSlot.valueEnc } });
        const w2 = await tx.codingCredential.updateMany({ where: { id: idSlot.id, valueEnc: idSlot.valueEnc }, data: { valueEnc: tokenSlot.valueEnc } });
        if (!w1 || w1.count !== 1 || !w2 || w2.count !== 1) throw new Error(`partial-write guard tripped (${w1 && w1.count}/${w2 && w2.count}) — transaction rolled back`);
        return 'ok';
      });
      if (outcome === 'ok') result.swapped += 1;
      else result.skippedChanged += 1;
    } catch (err) {
      // The guard threw and rolled back — the pair moved mid-apply. Not lost,
      // not half-swapped: report it with its row ids for a re-run.
      result.skippedChanged += 1;
      result.candidates[result.candidates.length - 1].applyError = String(err && err.message ? err.message : err).slice(0, 160);
    }
  }

  result.wouldSwap = result.candidates.filter((c) => c.verdict === 'SWAPPED').length;
  console.log(JSON.stringify(result, (k, v) => (typeof v === 'bigint' ? Number(v) : v)));
  return result;
}

module.exports = { run, parseArgs, shapeOf, slotOf };

if (require.main === module) {
  (async () => {
    // The compiled service in the live container: same key derivation
    // (sha256("digby-coding-credentials:" + JWT_SECRET)) as every other
    // reader of these rows. The compiled database module is an ES module —
    // require() returns { default: prisma } (the probe idiom, probe-f102-cired.js).
    const creds = require('/app/dist/modules/crossmodel/coding/credentials.service');
    const mod = require('/app/dist/config/database');
    const prismaBase = mod && mod.default ? mod.default : mod;
    const prisma = prismaBase && prismaBase.prisma ? prismaBase.prisma : prismaBase;
    try {
      await run({ prisma, argv: process.argv.slice(2), decrypt: creds.decryptValue });
    } catch (err) {
      console.error(String(err && err.message ? err.message : err));
      process.exit(1);
    } finally {
      await prisma.$disconnect().catch(() => {});
    }
  })();
}
