#!/usr/bin/env node
/**
 * remove-registry-model.js — take a model OUT of Digby entirely (owner 2026-10-06: "remove that it is a bad model
 * entirely" — cql-litellm:api-cohere-command-a-plus).
 *
 * Removes every trace that lets the framework USE a model:
 *   1. the model's entry in its endpoint's `model_endpoints.models` list (ONLY that entry is filtered out; every other
 *      model entry is written back byte-identical — the service's updateEndpoint re-validates the whole list, which can
 *      drop detected fields, so it is deliberately NOT used);
 *   2. the model's entry in the bench scorecard (context store ['instance','model-bench'] / 'scorecard') — the pickers'
 *      evidence;
 *   3. `crossmodel_chats.leadModel` pins naming the spec (set to NULL — the chat follows its seat again);
 *   4. model-roles seats / fallbacks and Auto pools that name it are REPORTED (refused, not edited) — an admin choice.
 * Text that merely mentions the model (lane memories, plans, transcripts) is history and is left alone.
 * Registry caches expire within 30 s on every process.
 *
 * Runs INSIDE the backend container (prodq.sh copies it to /tmp and runs it from /app):
 *   bash /opt/crossmodel/scripts/framework-audit/prodq.sh remove-registry-model.js cql-litellm:api-cohere-command-a-plus          # dry run
 *   bash /opt/crossmodel/scripts/framework-audit/prodq.sh remove-registry-model.js cql-litellm:api-cohere-command-a-plus --apply
 * Exit 0 ok, 2 usage / refused, 3 runtime modules unavailable. Output: one JSON object (no secrets — the endpoint's key
 * column is never read).
 */
'use strict';

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const spec = args.find((a) => !a.startsWith('--')) || '';
  const m = /^([^:]+):(.+)$/.exec(spec);
  if (!m) {
    console.log(JSON.stringify({ error: 'usage: remove-registry-model.js <label>:<modelId> [--apply]' }));
    process.exit(2);
  }
  const [, label, modelId] = m;
  let prisma, store;
  try {
    prisma = require('/app/dist/config/database').default;
    store = require('/app/dist/modules/crossmodel/memory/context-store');
  } catch (err) {
    console.log(JSON.stringify({ error: `runtime modules unavailable (${err && err.message})` }));
    process.exit(3);
  }

  const out = { spec, apply, endpoint: null, scorecard: null, chatLeadPins: null, seatsNamingIt: [], poolsNamingIt: [] };

  // 1. endpoint registry entry
  const eps = await prisma.modelEndpoint.findMany({ where: { label }, select: { id: true, label: true, models: true } });
  const ep = eps.find((e) => Array.isArray(e.models) && e.models.some((x) => x && x.id === modelId));
  if (ep) {
    const kept = ep.models.filter((x) => !(x && x.id === modelId));
    out.endpoint = { id: ep.id, label: ep.label, modelsBefore: ep.models.length, modelsAfter: kept.length };
    if (apply) await prisma.modelEndpoint.update({ where: { id: ep.id }, data: { models: kept } });
  } else {
    out.endpoint = { note: `no endpoint labelled "${label}" lists "${modelId}"` };
  }

  // 2. bench scorecard entry
  const NS = ['instance', 'model-bench'];
  const card = await store.storeGet(NS, 'scorecard');
  if (card && card.models && card.models[spec]) {
    out.scorecard = { removed: true, modelsBefore: Object.keys(card.models).length };
    if (apply) {
      const models = { ...card.models };
      delete models[spec];
      await store.storePut(NS, 'scorecard', { ...card, models, updatedAt: new Date().toISOString(), updatedBy: 'remove-registry-model' });
    }
  } else {
    out.scorecard = { removed: false, note: 'no scorecard entry' };
  }

  // 3. chat lead pins
  const pinned = await prisma.crossModelChat.count({ where: { leadModel: spec } });
  out.chatLeadPins = { count: pinned };
  if (apply && pinned) await prisma.crossModelChat.updateMany({ where: { leadModel: spec }, data: { leadModel: null } });

  // 4. seats / pools — report only
  const roles = await store.storeGet(['instance', 'model-roles'], 'config');
  const scan = (obj, path, hits) => {
    if (!obj || typeof obj !== 'object') return;
    for (const [k, v] of Object.entries(obj)) {
      const p = path ? `${path}.${k}` : k;
      if (typeof v === 'string' && v === spec) hits.push(p);
      else if (Array.isArray(v)) v.forEach((x, i) => { if (x === spec) hits.push(`${p}[${i}]`); else scan(x, `${p}[${i}]`, hits); });
      else scan(v, p, hits);
    }
  };
  scan(roles, '', out.seatsNamingIt);
  const pools = await store.storeGet(['instance', 'auto-pools'], 'config');
  if (pools) scan(pools, 'auto-pools', out.poolsNamingIt);
  const council = await store.storeGet(['instance', 'model-roles'], 'reflection-council');
  if (council) scan(council, 'reflection-council', out.seatsNamingIt);

  console.log(JSON.stringify({ ...(apply ? { applied: true } : { dryRun: true }), ...out }));
  try { await prisma.$disconnect(); } catch { /* ignore */ }
}

if (require.main === module) {
  main().catch((err) => { console.log(JSON.stringify({ error: String(err && err.message || err) })); process.exit(1); });
}
