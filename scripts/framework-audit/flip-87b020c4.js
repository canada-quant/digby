#!/usr/bin/env node
/**
 * flip-87b020c4.js — ONE-SHOT registry flip for todo 87b020c4 (owner ruling oq_7af5537b).
 * Sets imagesUrl='http://100.64.0.1:4001/v1' on the llm-cql endpoint's
 * qwen-image-2.1 AND qwen-image-2.1-turbo entries (every other field untouched),
 * printing the BEFORE and AFTER models JSON snapshots plus a fresh read-back.
 * Runs inside the live admin-backend container via prodq.sh.
 * Pass REVERT=1 in the env to CLEAR imagesUrl on both entries instead (the RED path).
 */
'use strict';
async function main() {
  let prisma;
  try { prisma = require('/app/dist/config/database').default; } catch (err) {
    console.log(JSON.stringify({ error: `runtime modules unavailable (${err && err.message})` }));
    process.exit(3);
  }
  const REVERT = process.env.REVERT === '1';
  const TARGET = 'http://100.64.0.1:4001/v1';
  const IDS = ['qwen-image-2.1', 'qwen-image-2.1-turbo'];
  const ep = await prisma.modelEndpoint.findFirst({ where: { label: 'llm-cql' } });
  if (!ep) { console.log(JSON.stringify({ error: 'llm-cql endpoint not found' })); process.exit(4); }
  const models = Array.isArray(ep.models) ? ep.models.map((m) => ({ ...m })) : [];
  console.log('BEFORE ' + JSON.stringify(models, null, 1));
  let touched = 0;
  for (const m of models) {
    if (m && IDS.includes(String(m.id))) {
      if (REVERT) { delete m.imagesUrl; } else { m.imagesUrl = TARGET; }
      touched++;
    }
  }
  if (touched !== IDS.length) {
    console.log(JSON.stringify({ error: `expected ${IDS.length} matching entries, found ${touched}` }));
    process.exit(5);
  }
  await prisma.modelEndpoint.update({ where: { id: ep.id }, data: { models } });
  console.log('AFTER ' + JSON.stringify(models, null, 1));
  // Fresh read-back (proves the write persisted, not just the local object).
  const back = await prisma.modelEndpoint.findFirst({ where: { label: 'llm-cql' } });
  const bm = Array.isArray(back.models) ? back.models : [];
  const check = {};
  for (const id of IDS) {
    const e = bm.find((m) => m && String(m.id) === id);
    check[id] = e ? (e.imagesUrl ?? '(absent)') : '(entry missing)';
  }
  console.log('READBACK ' + JSON.stringify({ mode: REVERT ? 'REVERT' : 'FLIP', endpointId: ep.id, imagesUrl: check }, null, 1));
  await prisma.$disconnect();
}
main().catch((err) => { console.log(JSON.stringify({ error: String((err && err.message) || err) })); process.exit(1); });
