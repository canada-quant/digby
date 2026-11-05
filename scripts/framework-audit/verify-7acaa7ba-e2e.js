#!/usr/bin/env node
/* E2E member probe — ticket 7acaa7ba — runs INSIDE the live backend container.
 * Requires '/app/dist/config/database' (never new PrismaClient()).
 * Probes the LIVE HTTP surface with minted JWTs as: session owner, project
 * member (viewer), stranger, and no-auth. Expected (PR #1123 / e18c15c4c08a):
 *   owner     GET  /api/crossmodel/coding/sessions/:id      -> 200
 *   member    GET  /api/crossmodel/coding/sessions/:id      -> 200 (read access, session visible)
 *   stranger  GET  /api/crossmodel/coding/sessions/:id      -> 404 (no existence leak)
 *   member    POST /api/crossmodel/coding/sessions/:id/run  -> 403 {code:'CODING_OWNER_ONLY'}
 *   stranger  POST /api/crossmodel/coding/sessions/:id/run  -> 404
 *   no-auth   POST /api/crossmodel/coding/sessions/:id/run  -> 401
 */
const fs = require('fs');
// A probe at /tmp/<name>.js resolves requires from /tmp, not the backend's
// /app/node_modules — address the container's copy explicitly.
let jwt;
try { jwt = require('/app/node_modules/jsonwebtoken'); }
catch { jwt = require('jsonwebtoken'); }

const DB = '/app/dist/config/database';
// existsSync('/…/database') is FALSE even when require() works — the on-disk
// file is database.js (or database/index.js); require resolves extensions.
let prisma;
// Repo convention (audit-live-state.js et al.): the dist client is the DEFAULT
// export — `.prisma` doesn't exist on the compiled module.
try { prisma = require(DB).default; }
catch (e) { console.log('PROBE_FAIL cannot require ' + DB + ': ' + String(e).slice(0,200)); process.exit(2); }

const results = [];
function record(who, method, route, r) {
  const code = r.body && r.body.code;
  const err = ((r.body && (r.body.error || r.body.message)) || '').slice(0, 110);
  results.push({ who, method, route, status: r.status, code, err });
  console.log(`${who.padEnd(8)} ${method} ${route.padEnd(30)} -> ${r.status} code=${code} err=${err.slice(0, 80)}`);
}

async function main() {
  // 1. Find a real shared coding session: chat with a project that has a non-owner member.
  const chats = await prisma.crossModelChat.findMany({
    where: { projectId: { not: null }, codingState: { isNot: null } },
    select: {
      id: true,
      userId: true,
      project: { select: { id: true, userId: true, members: { select: { userId: true, role: true } } } },
    },
    take: 400,
    orderBy: { updatedAt: 'desc' },
  });
  const candidate = chats.find(
    (c) => c.project && c.project.members && c.project.members.length > 0 &&
      c.project.members.some((m) => m.userId !== c.userId)
  );
  if (!candidate) { console.log('PROBE_FAIL no shared session with a non-owner member found'); process.exit(2); }
  const chatId = candidate.id;
  // Session owner = the chat own userId (CrossModelProject has no ownerId field
  // — its owner is project.userId); member = a project member who is not the session owner.
  const owner = candidate.userId;
  const member = candidate.project.members.find((m) => m.userId !== candidate.userId);
  console.log(`session=${chatId} owner=${owner} member=${member.userId} role=${member.role}`);

  // 2. Mint tokens (backend/src/utils/jwt.ts shape: userId, email, role).
  const secret = process.env.JWT_SECRET;
  if (!secret) { console.log('PROBE_FAIL no JWT_SECRET in env'); process.exit(2); }
  const mkTok = (u) => jwt.sign({ userId: u, email: `probe-${u}@digby.ai`, role: 'user' }, secret, { expiresIn: '5m' });
  const tokOwner = mkTok(owner);
  const tokMember = mkTok(member.userId);
  const tokStranger = mkTok('nonexistent-user-probe-000');

  // 3. Hit the live surface (backend listens on 127.0.0.1:4000 inside the container).
  const H = (t) => ({ Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' });
  const call = async (url, method, t, body) => {
    const r = await fetch(url, {
      method,
      headers: t ? H(t) : { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    let jb = {};
    try { jb = await r.json(); } catch {}
    return { status: r.status, body: jb };
  };
  const GET = `http://127.0.0.1:4000/api/crossmodel/coding/sessions/${chatId}`;
  const RUN = `${GET}/run`;

  const gOwner = await call(GET, 'GET', tokOwner);
  record('owner', 'GET', '/sessions/:id', gOwner);
  const gMember = await call(GET, 'GET', tokMember);
  record('member', 'GET', '/sessions/:id', gMember);
  const gStranger = await call(GET, 'GET', tokStranger);
  record('stranger', 'GET', '/sessions/:id', gStranger);

  const pMember = await call(RUN, 'POST', tokMember, { message: 'probe: member send (7acaa7ba E2E)' });
  record('member', 'POST', '/sessions/:id/run', pMember);
  const pStranger = await call(RUN, 'POST', tokStranger, { message: 'probe' });
  record('stranger', 'POST', '/sessions/:id/run', pStranger);
  const pNone = await call(RUN, 'POST', null, { message: 'probe' });
  record('noauth', 'POST', '/sessions/:id/run', pNone);

  // 4. Verdict
  const pass =
    gOwner.status === 200 &&
    gMember.status === 200 &&
    gStranger.status === 404 &&
    pMember.status === 403 &&
    pMember.body && pMember.body.code === 'CODING_OWNER_ONLY' &&
    pStranger.status === 404 &&
    pNone.status === 401;
  console.log(`VERDICT: ${pass ? 'PASS' : 'FAIL'}`);
  console.log(`SUMMARY_JSON: ${JSON.stringify(results)}`);
  await prisma.$disconnect();
  process.exit(pass ? 0 : 1);
}

main().catch((e) => { console.log('PROBE_FAIL ' + String(e).slice(0, 300)); process.exit(2); });
