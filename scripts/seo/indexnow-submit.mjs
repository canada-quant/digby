#!/usr/bin/env node
/**
 * Submit every URL in https://digby.ai/sitemap.xml to IndexNow (Bing, Yandex,
 * Seznam, Naver … share submissions). The key file is
 * frontend/public/<key>.txt — public by design (IndexNow ownership proof).
 * Run after a deploy that adds or changes public pages:
 *   node scripts/seo/indexnow-submit.mjs            (all sitemap URLs)
 *   node scripts/seo/indexnow-submit.mjs /about ... (just these paths)
 */
const HOST = 'digby.ai';
const KEY = 'd3fae3e0e8874b6aa25929e5cd74628e';
const KEY_LOCATION = `https://${HOST}/${KEY}.txt`;

const args = process.argv.slice(2);
let urlList;
if (args.length) {
  urlList = args.map((p) => (p.startsWith('http') ? p : `https://${HOST}${p.startsWith('/') ? p : `/${p}`}`));
} else {
  const xml = await (await fetch(`https://${HOST}/sitemap.xml`)).text();
  urlList = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
}
const keyBody = (await (await fetch(KEY_LOCATION)).text()).trim();
if (keyBody !== KEY) {
  console.error(`key file at ${KEY_LOCATION} does not contain the key (got ${JSON.stringify(keyBody.slice(0, 60))}) — deploy first`);
  process.exit(1);
}
const res = await fetch('https://api.indexnow.org/IndexNow', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json; charset=utf-8' },
  body: JSON.stringify({ host: HOST, key: KEY, keyLocation: KEY_LOCATION, urlList }),
});
console.log(`IndexNow ${res.status} ${res.statusText} — ${urlList.length} URLs`);
console.log(await res.text());
process.exit(res.status === 200 || res.status === 202 ? 0 : 1);
