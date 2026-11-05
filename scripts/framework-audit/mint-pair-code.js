// mint-pair-code.js — OWNER-DIRECTED WRITE ONE-SHOT (ticket 1ea9a120, pro-2 re-pair),
// in the backfill-chat-mode-auto.js mold: read-only without --apply; with --apply
// it mints the SAME single-use 600s redis pairing key startPairing() would issue
// for this user (imessage_pair:<key> → userId), so the pro-2 agent can self-pair
// via DIGBY_PAIR_CODE without a GUI code-entry popup.
//
// Usage (inside the live backend container via prodq.sh):
//   node mint-pair-code.js <PAIR_KEY>          # dry-run: verify row, echo plan
//   node mint-pair-code.js <PAIR_KEY> --apply  # mint + read back TTL
//
// The key MUST already be 8 chars of the backend's PAIR_ALPHABET
// (ABCDEFGHJKLMNPQRSTUVWXYZ23456789 — no ambiguous 0/O/1/I); this script
// normalizes exactly like imessage.service.ts normalizeCode() and refuses
// anything else. Output is deterministic lines; the userId is NEVER printed.
'use strict';
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const normalize = (s) => (s || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
const rawKey = process.argv[2] || '';
const apply = process.argv.includes('--apply');
const key = normalize(rawKey);
if (!key || key.length !== 8 || ![...key].every(c => ALPHABET.includes(c))) {
  console.log('MINT_ERROR=bad key (need 8 chars of ' + ALPHABET + ')');
  process.exit(2);
}
(async () => {
  const prisma = require('/app/dist/config/database').default;
  const { createClient } = require('/app/node_modules/redis');
  const r = createClient({ url: process.env.REDIS_URL });
  await r.connect();
  const row = await prisma.iMessageAgent.findFirst({ where: { deviceId: '7e68abfd-89e6-41d9-ad3f-8bb60be9e6eb' } });
  if (!row) { console.log('MINT_ERROR=no pro-2 row'); process.exit(2); }
  console.log('PAIRING_KEY=' + key);
  console.log('USER_ID_SET=' + (row.userId ? '1' : '0'));
  console.log('AGENT_LABEL=' + row.label);
  if (!apply) { console.log('DRY_RUN=1 (pass --apply to mint)'); }
  else {
    await r.setEx('imessage_pair:' + key, 600, row.userId);
    console.log('PAIRING_TTL=' + (await r.ttl('imessage_pair:' + key)));
    console.log('MINT_CHECK=' + ((await r.get('imessage_pair:' + key)) ? 'value-present' : 'value-missing'));
  }
  await r.disconnect();
  await prisma.$disconnect();
})().catch(e => { console.error('MINT_ERROR=' + e.message); process.exit(1); });
