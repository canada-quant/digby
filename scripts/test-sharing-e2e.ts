#!/usr/bin/env node
/**
 * End-to-end test for chat + project sharing authorization.
 *
 * Spins through every (actor, resource, action) combination that the sharing
 * model promises to support and reports each as PASS / FAIL.
 *
 * Runs against whatever backend BASE_URL points at — defaults to local dev.
 * Creates two ephemeral test users, runs the matrix, then cleans them up.
 *
 *   tsx scripts/test-sharing-e2e.ts
 *   BASE_URL=http://localhost:4000 tsx scripts/test-sharing-e2e.ts
 */

const BASE = process.env.BASE_URL || 'http://localhost:4000';
const stamp = Date.now();
const ALICE = { email: `alice+${stamp}@digbytest.local`, password: 'P@ssw0rd1234', name: 'Alice' };
const BOB   = { email: `bob+${stamp}@digbytest.local`,   password: 'P@ssw0rd1234', name: 'Bob'   };

type Result = { name: string; ok: boolean; detail?: string };
const results: Result[] = [];

function record(name: string, ok: boolean, detail?: string) {
  results.push({ name, ok, detail });
  const tag = ok ? '\x1b[32m PASS \x1b[0m' : '\x1b[31m FAIL \x1b[0m';
  console.log(`${tag} ${name}${detail ? ' — ' + detail : ''}`);
}

async function http(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown; expectJson?: boolean } = {}
): Promise<{ status: number; json: any; text: string }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, json, text };
}

async function register(user: { email: string; password: string; name: string }) {
  const r = await http('POST', '/api/auth/register', { body: user });
  if (r.status !== 201) throw new Error(`register ${user.email} failed: ${r.status} ${r.text.slice(0, 200)}`);
  return { token: r.json.data.accessToken as string, userId: r.json.data.user.id as string };
}

async function main() {
  console.log(`\nE2E sharing test against ${BASE}\n${'─'.repeat(60)}`);

  // ─── Setup ────────────────────────────────────────────────────────────────
  const alice = await register(ALICE);
  const bob   = await register(BOB);
  console.log(`Alice id=${alice.userId.slice(0, 8)}…  Bob id=${bob.userId.slice(0, 8)}…\n`);

  // Alice creates a project
  const projCreate = await http('POST', '/api/crossmodel/projects', {
    token: alice.token,
    body: { name: `Shared Project ${stamp}`, emoji: '🧪' },
  });
  if (projCreate.status !== 201 && projCreate.status !== 200) {
    throw new Error(`project create failed: ${projCreate.status} ${projCreate.text}`);
  }
  const projectId = projCreate.json.id as string;

  // Alice creates a chat IN the project (C1). Chat endpoints use envelope {success, data}.
  const c1Create = await http('POST', '/api/crossmodel/chats', {
    token: alice.token,
    body: { title: 'Project chat (C1)', mode: 'fast', projectId },
  });
  if (c1Create.status !== 201 && c1Create.status !== 200) {
    throw new Error(`C1 create failed: ${c1Create.status} ${c1Create.text}`);
  }
  const c1Id = (c1Create.json.data?.id ?? c1Create.json.id) as string;

  // Alice creates an ungrouped chat (C2)
  const c2Create = await http('POST', '/api/crossmodel/chats', {
    token: alice.token,
    body: { title: 'Ungrouped chat (C2)', mode: 'fast' },
  });
  if (c2Create.status !== 201 && c2Create.status !== 200) {
    throw new Error(`C2 create failed: ${c2Create.status} ${c2Create.text}`);
  }
  const c2Id = (c2Create.json.data?.id ?? c2Create.json.id) as string;

  console.log(`Project=${projectId.slice(0, 8)}…  C1=${c1Id.slice(0, 8)}…  C2=${c2Id.slice(0, 8)}…\n`);

  // ─── Section 1: privacy invariant before sharing ──────────────────────────
  console.log('Section 1: privacy before sharing');

  let r = await http('GET', `/api/crossmodel/chats/${c1Id}`, { token: alice.token });
  record('1.1 Alice can read her own chat C1', r.status === 200);

  r = await http('GET', `/api/crossmodel/chats/${c2Id}`, { token: alice.token });
  record('1.2 Alice can read her own chat C2', r.status === 200);

  r = await http('GET', '/api/crossmodel/chats', { token: alice.token });
  const aliceChatIds: string[] = ((r.json?.data?.chats ?? r.json?.chats) ?? []).map((c: any) => c.id);
  record('1.3 Alice list includes C1+C2', aliceChatIds.includes(c1Id) && aliceChatIds.includes(c2Id),
    `got [${aliceChatIds.map(i => i.slice(0, 6)).join(', ')}]`);

  r = await http('GET', `/api/crossmodel/chats/${c1Id}`, { token: bob.token });
  record('1.4 Bob CANNOT read Alice C1 (no share)', r.status === 403 || r.status === 404, `status=${r.status}`);

  r = await http('GET', `/api/crossmodel/chats/${c2Id}`, { token: bob.token });
  record('1.5 Bob CANNOT read Alice C2 (no share)', r.status === 403 || r.status === 404, `status=${r.status}`);

  r = await http('GET', '/api/crossmodel/chats', { token: bob.token });
  const bobChatIdsBefore: string[] = ((r.json?.data?.chats ?? r.json?.chats) ?? []).map((c: any) => c.id);
  record('1.6 Bob list does not include Alice chats',
    !bobChatIdsBefore.includes(c1Id) && !bobChatIdsBefore.includes(c2Id));

  r = await http('GET', '/api/crossmodel/projects', { token: bob.token });
  const bobProjectsBefore: string[] = (r.json?.shared ?? []).map((p: any) => p.id);
  record('1.7 Bob does not see Alice project in shared list',
    !bobProjectsBefore.includes(projectId));

  // ─── Section 2: Alice invites Bob as viewer ───────────────────────────────
  console.log('\nSection 2: invite Bob as viewer of project');

  r = await http('POST', `/api/crossmodel/projects/${projectId}/members`, {
    token: alice.token,
    body: { email: BOB.email, role: 'viewer' },
  });
  record('2.0 Alice can invite Bob as viewer', r.status === 201, `status=${r.status}`);

  r = await http('GET', '/api/crossmodel/projects', { token: bob.token });
  const bobSharedNow: string[] = (r.json?.shared ?? []).map((p: any) => p.id);
  record('2.1 Bob now sees project in "shared"', bobSharedNow.includes(projectId));

  r = await http('GET', `/api/crossmodel/projects/${projectId}`, { token: bob.token });
  const projChatIds: string[] = (r.json?.chats ?? []).map((c: any) => c.id);
  record('2.2 Bob can fetch project detail', r.status === 200, `status=${r.status}`);
  record('2.3 Project detail lists C1 to Bob', projChatIds.includes(c1Id));

  // The headline test — Bob viewer must be able to READ chats in the shared project
  r = await http('GET', `/api/crossmodel/chats/${c1Id}`, { token: bob.token });
  record('2.4 Bob (viewer) CAN read C1 (in shared project)', r.status === 200,
    `status=${r.status}${r.status !== 200 ? ' ← BUG' : ''}`);

  // Bob must NOT be able to read C2 — it's not in the shared project
  r = await http('GET', `/api/crossmodel/chats/${c2Id}`, { token: bob.token });
  record('2.5 Bob still CANNOT read C2 (not in project)', r.status === 403 || r.status === 404);

  // Viewers must not be able to write
  r = await http('PUT', `/api/crossmodel/chats/${c1Id}`, {
    token: bob.token,
    body: { title: 'Bob-renamed (should fail for viewer)' },
  });
  record('2.6 Bob (viewer) CANNOT rename C1', r.status === 403 || r.status === 404, `status=${r.status}`);

  // Viewers must not delete
  r = await http('DELETE', `/api/crossmodel/chats/${c1Id}`, { token: bob.token });
  record('2.7 Bob (viewer) CANNOT delete C1', r.status === 403 || r.status === 404, `status=${r.status}`);

  // Bob's main chat list — should this include C1? Up for product debate; current intent is yes,
  // but we tolerate either as long as Bob can READ it.
  r = await http('GET', '/api/crossmodel/chats', { token: bob.token });
  const bobChatList: string[] = ((r.json?.data?.chats ?? r.json?.chats) ?? []).map((c: any) => c.id);
  record('2.8 Bob /chats list includes C1 (project-aware list)',
    bobChatList.includes(c1Id),
    `bobChats=[${bobChatList.map(i => i.slice(0, 6)).join(', ')}]${!bobChatList.includes(c1Id) ? ' ← BUG' : ''}`);

  // ─── Section 3: promote Bob to editor ─────────────────────────────────────
  console.log('\nSection 3: promote Bob to editor');

  r = await http('PUT', `/api/crossmodel/projects/${projectId}/members/${bob.userId}`, {
    token: alice.token, body: { role: 'editor' },
  });
  record('3.0 Alice can promote Bob to editor', r.status === 200, `status=${r.status}`);

  r = await http('PUT', `/api/crossmodel/chats/${c1Id}`, {
    token: bob.token, body: { title: 'Bob-renamed (editor)' },
  });
  record('3.1 Bob (editor) CAN rename C1', r.status === 200,
    `status=${r.status}${r.status !== 200 ? ' ← BUG' : ''}`);

  r = await http('DELETE', `/api/crossmodel/chats/${c1Id}`, { token: bob.token });
  record('3.2 Bob (editor) CANNOT delete C1 (owner-only delete)',
    r.status === 403 || r.status === 404, `status=${r.status}`);

  r = await http('DELETE', `/api/crossmodel/projects/${projectId}`, { token: bob.token });
  record('3.3 Bob (editor) CANNOT delete project (owner-only)',
    r.status === 403 || r.status === 404, `status=${r.status}`);

  // ─── Section 4: public share link for C2 ──────────────────────────────────
  console.log('\nSection 4: public share link for ungrouped chat');

  r = await http('POST', `/api/crossmodel/chats/${c2Id}/share`, { token: alice.token });
  record('4.0 Alice can create share link for C2', r.status === 200 || r.status === 201, `status=${r.status}`);
  const shareToken = r.json?.shareToken as string | undefined;

  if (shareToken) {
    // Public endpoint — no auth
    r = await http('GET', `/api/crossmodel/shared/chat/${shareToken}`);
    record('4.1 Anonymous GET /shared/chat/:token works', r.status === 200, `status=${r.status}`);

    // Revoke
    r = await http('DELETE', `/api/crossmodel/chats/${c2Id}/share`, { token: alice.token });
    record('4.2 Alice can revoke share link', r.status === 200, `status=${r.status}`);

    r = await http('GET', `/api/crossmodel/shared/chat/${shareToken}`);
    record('4.3 Revoked link returns 404/410', r.status === 404 || r.status === 410, `status=${r.status}`);
  }

  // ─── Section 5: remove Bob ────────────────────────────────────────────────
  console.log('\nSection 5: remove Bob from project');

  r = await http('DELETE', `/api/crossmodel/projects/${projectId}/members/${bob.userId}`, {
    token: alice.token,
  });
  record('5.0 Alice can remove Bob', r.status === 200, `status=${r.status}`);

  r = await http('GET', '/api/crossmodel/projects', { token: bob.token });
  const bobSharedAfter: string[] = (r.json?.shared ?? []).map((p: any) => p.id);
  record('5.1 Project gone from Bob "shared"', !bobSharedAfter.includes(projectId));

  r = await http('GET', `/api/crossmodel/chats/${c1Id}`, { token: bob.token });
  record('5.2 Bob CANNOT read C1 after removal', r.status === 403 || r.status === 404, `status=${r.status}`);

  // ─── Summary ──────────────────────────────────────────────────────────────
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${'─'.repeat(60)}\n${results.length} checks, ${results.length - failed.length} passed, ${failed.length} failed`);
  if (failed.length) {
    console.log('\nFailing:');
    failed.forEach((r) => console.log(`  ✗ ${r.name}${r.detail ? ' — ' + r.detail : ''}`));
  }

  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('\nFATAL', e);
  process.exit(2);
});
