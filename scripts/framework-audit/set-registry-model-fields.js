#!/usr/bin/env node
/**
 * set-registry-model-fields.js — set per-model fields on an endpoint's registry entries (the "max tools" box in the
 * endpoint dialog, etc.) without touching any other entry. First use 2026-10-07 (owner: "just do 1"): maxTools=96 on the
 * cql-litellm spark-* chat models — the Digby seat sent all 208 tool definitions (212 KB), and a COLD prefill of that on
 * the Spark took 41 s before the first token (warm: 1.3 s; bare prompt: 0.6 s). With a cap, coding/tool-groups.ts sends
 * the core set (chat 55 / coding 83 ≤ CORE_MAX 96) and loads the rest on demand. 96 = CORE_MAX, so no core tool is ever
 * trimmed.
 *
 * Runs INSIDE the backend container (prodq.sh copies it to /tmp and runs it from /app):
 *   bash /opt/crossmodel/scripts/framework-audit/prodq.sh set-registry-model-fields.js cql-litellm spark-glm-5.3-flash,spark-mimo-v26-flash-rl maxTools=96            # dry run
 *   bash /opt/crossmodel/scripts/framework-audit/prodq.sh set-registry-model-fields.js cql-litellm spark-glm-5.3-flash,spark-mimo-v26-flash-rl maxTools=96 --apply
 *   … maxTools=  (empty value) removes the field.
 * Allowed fields: maxTools (positive integer). The model ids may also be a prefix ending in '*' (e.g. 'spark-*').
 * Registry caches expire within 30 s on every process. Exit 0 ok, 2 usage, 3 runtime modules unavailable.
 */
'use strict';

const ALLOWED = { maxTools: (v) => (v === '' ? undefined : (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : NaN)) };

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const pos = args.filter((a) => !a.startsWith('--'));
  const [label, idsArg, ...assigns] = pos;
  if (!label || !idsArg || !assigns.length) {
    console.log(JSON.stringify({ error: 'usage: set-registry-model-fields.js <endpointLabel> <modelId[,modelId…]|prefix*> field=value… [--apply]' }));
    process.exit(2);
  }
  const set = {};
  for (const a of assigns) {
    const i = a.indexOf('=');
    const k = i > 0 ? a.slice(0, i) : a;
    if (!ALLOWED[k]) { console.log(JSON.stringify({ error: `field "${k}" is not settable here (allowed: ${Object.keys(ALLOWED).join(', ')})` })); process.exit(2); }
    const v = ALLOWED[k](i > 0 ? a.slice(i + 1) : '');
    if (Number.isNaN(v)) { console.log(JSON.stringify({ error: `bad value for ${k}` })); process.exit(2); }
    set[k] = v;
  }
  let prisma;
  try { prisma = require('/app/dist/config/database').default; } catch (err) {
    console.log(JSON.stringify({ error: `runtime modules unavailable (${err && err.message})` }));
    process.exit(3);
  }
  const wanted = idsArg.split(',').map((s) => s.trim()).filter(Boolean);
  const matches = (id) => wanted.some((w) => (w.endsWith('*') ? id.startsWith(w.slice(0, -1)) : id === w));
  const eps = await prisma.modelEndpoint.findMany({ where: { label }, select: { id: true, label: true, models: true } });
  if (!eps.length) { console.log(JSON.stringify({ error: `no endpoint labelled "${label}"` })); process.exit(2); }
  const changes = [];
  for (const ep of eps) {
    const models = Array.isArray(ep.models) ? ep.models : [];
    let touched = false;
    const next = models.map((m) => {
      if (!m || typeof m.id !== 'string' || !matches(m.id)) return m;
      const before = {}; const after = { ...m };
      for (const [k, v] of Object.entries(set)) { before[k] = m[k] ?? null; if (v === undefined) delete after[k]; else after[k] = v; }
      changes.push({ endpoint: ep.label, model: m.id, before, after: Object.fromEntries(Object.keys(set).map((k) => [k, after[k] ?? null])) });
      touched = true;
      return after;
    });
    if (apply && touched) await prisma.modelEndpoint.update({ where: { id: ep.id }, data: { models: next } });
  }
  const missing = wanted.filter((w) => !changes.some((c) => (w.endsWith('*') ? c.model.startsWith(w.slice(0, -1)) : c.model === w)));
  console.log(JSON.stringify({ ...(apply ? { applied: true } : { dryRun: true }), set, changes, missing }));
  try { await prisma.$disconnect(); } catch { /* ignore */ }
}

if (require.main === module) {
  main().catch((err) => { console.log(JSON.stringify({ error: String(err && err.message || err) })); process.exit(1); });
}
