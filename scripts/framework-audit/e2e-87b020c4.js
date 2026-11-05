#!/usr/bin/env node
/**
 * e2e-87b020c4.js — the acceptance gate for todo 87b020c4 (owner ruling oq_7af5537b).
 * Runs INSIDE the live admin-backend container on box A (prodq.sh), so the request
 * leaves from the prod serving surface — never the dev container (ACL-refused by design).
 *  1. Resolves the leg for spec 'llm-cql:qwen-image-2.1-turbo' and prints the URL it
 *     will POST to (MUST read http://100.64.0.1:4001/v1/images/generations).
 *  2. Runs the REAL generation through the built image-generate module with a 720000 ms
 *     budget and prints latencyMs (MUST be >120000 — the >2-min class that dies on the
 *     Cloudflare edge cut), bytes length and mimeType.
 * GREEN = completes, tailnet URL confirmed, latencyMs>120000, bytes>0. Anything else = RED.
 */
'use strict';
async function main() {
  const t0 = Date.now();
  let svc, ig;
  try {
    svc = require('/app/dist/modules/crossmodel/model-endpoints/model-endpoints.service.js');
    ig = require('/app/dist/modules/crossmodel/image-generate.js');
  } catch (err) {
    console.log(JSON.stringify({ verdict: 'RED', stage: 'require', error: String((err && err.message) || err) }));
    process.exit(3);
  }
  const SPEC = 'llm-cql:qwen-image-2.1-turbo';
  // 1) leg resolution (the same read image-generate.ts legForSpec performs)
  const reg = await svc.resolveRegistryModel(SPEC);
  if (!reg) {
    console.log(JSON.stringify({ verdict: 'RED', stage: 'resolve', error: 'spec did not resolve' }));
    process.exit(4);
  }
  const legUrl = `${reg.imagesUrl ?? reg.baseUrl}/images/generations`;
  console.log('LEG ' + JSON.stringify({ spec: SPEC, baseUrl: reg.baseUrl, imagesUrl: reg.imagesUrl ?? '(absent)', legUrl, imageTimeoutMs: reg.imageTimeoutMs ?? '(absent)' }));
  // 2) the real generation
  try {
    const img = await ig.generateImage({
      prompt: 'a lighthouse at dawn over a rocky coast, detailed oil painting',
      aspect: 'landscape',
      spec: SPEC,
      timeoutMs: 720000,
    });
    console.log('RESULT ' + JSON.stringify({
      verdict: img.latencyMs > 120000 && img.bytes && img.bytes.length > 0 && legUrl.startsWith('http://100.64.0.1:4001/v1/') ? 'GREEN' : 'RED',
      latencyMs: img.latencyMs,
      bytes: img.bytes ? img.bytes.length : 0,
      mimeType: img.mimeType,
      model: img.model,
      provider: img.provider,
      spec: img.spec,
      width: img.width, height: img.height,
      wallMs: Date.now() - t0,
    }));
    process.exit(0);
  } catch (err) {
    console.log('RESULT ' + JSON.stringify({
      verdict: 'RED', stage: 'generate',
      error: String((err && err.message) || err),
      class: err && err.class, wallMs: Date.now() - t0,
    }));
    process.exit(5);
  }
}
main().catch((err) => { console.log(JSON.stringify({ verdict: 'RED', stage: 'top', error: String((err && err.message) || err) })); process.exit(1); });
