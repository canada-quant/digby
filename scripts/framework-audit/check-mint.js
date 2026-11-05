// check-mint.js — READ-ONLY: did the pro-2 agent consume the minted pairing key?
const key = process.argv[2] || '';
(async () => {
  const { createClient } = require('/app/node_modules/redis');
  const r = createClient({ url: process.env.REDIS_URL });
  await r.connect();
  const ttl = await r.ttl('imessage_pair:' + key);
  const exists = await r.exists('imessage_pair:' + key);
  console.log('KEY=' + key);
  console.log('TTL=' + ttl);
  console.log('EXISTS=' + exists);
  await r.disconnect();
})().catch(e => { console.error('ERR ' + e.message); process.exit(1); });
