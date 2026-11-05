// verify-19fbd876-raw.js — E2E probe for the Files-tab binary download fix (ticket 19fbd876)
// + dist markers for the staging-claims fix (ticket a235fbd6, same deploy wave).
//
// Runs INSIDE the live backend container (scripts/framework-audit/prodq.sh): mints a
// short-lived owner JWT via the app's own compiled mint (/app/dist/utils/jwt —
// generateAccessToken, the exact real login-token shape; a bare require('jsonwebtoken')
// fails because /tmp-hosted probes don't see /app/node_modules), then GETs
//   /api/crossmodel/chats/:chatId/worktree/raw?path=deck/cql-dgx-b300-deck.pdf
// and asserts REAL bytes come back: 200 + application/octet-stream + a
// Content-Disposition attachment naming the .pdf + the exact incident byte count
// (58,993) + the %PDF magic — the file from the original report, served through
// the same route the Files-tab download button now uses.
//
// Dist markers (both fixes ride the same wave):
//   19fbd876 — getWorktreeRaw compiled into dist/modules/.../worktree-files.js
//   a235fbd6 — 'claim.staging-actions' rule in dist core-doctrine.js +
//              STAGING_CLAIM_IDIOM in dist action-verifier.js
// Read-only except the HTTP GET. Exit 0 only on VERDICT:PASS.
const prisma = require('/app/dist/config/database').default;
const { generateAccessToken } = require('/app/dist/utils/jwt');

const CHAT = '9dfade89-8389-4154-a905-864abf85612a';
const FILE = 'deck/cql-dgx-b300-deck.pdf';
const EXPECT_BYTES = 58993;

const out = {};

async function main() {
  const fs = require('fs');
  const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '');

  // 1. dist markers — is THIS container running the fixed code?
  out.dist_19fbd876_worktreeRaw = read('/app/dist/modules/crossmodel/coding/worktree-files.js').includes('getWorktreeRaw');
  const avSrc = read('/app/dist/modules/crossmodel/platform/action-verifier.js');
  out.dist_a235fbd6_stagingIdiom = avSrc.includes('STAGING_CLAIM_IDIOM');
  out.dist_a235fbd6_doctrine = read('/app/dist/modules/crossmodel/platform/core-doctrine.js').includes('claim.staging-actions');

  // 2. resolve the chat's owner and mint a real-shaped token
  const chat = await prisma.crossModelChat.findUnique({ where: { id: CHAT } });
  if (!chat) throw new Error('chat ' + CHAT + ' not found');
  const user = await prisma.user.findUnique({ where: { id: chat.userId } });
  if (!user) throw new Error('owner user not found');
  out.ownerId = chat.userId.slice(0, 8);
  const token = generateAccessToken(
    { userId: user.id, email: user.email, role: user.role },
  );

  // 3. hit the download route exactly as the Files tab does
  const base = `http://localhost:${process.env.PORT || '4000'}`;
  const res = await fetch(
    `${base}/api/crossmodel/chats/${CHAT}/worktree/raw?path=${encodeURIComponent(FILE)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  out.httpStatus = res.status;
  out.contentType = res.headers.get('content-type');
  out.contentDisposition = res.headers.get('content-disposition');
  const buf = Buffer.from(await res.arrayBuffer());
  out.bodyBytes = buf.length;
  out.pdfMagic = buf.slice(0, 5).toString('latin1');
  if (res.status !== 200) out.bodyHead = buf.slice(0, 200).toString('utf8');

  // 4. verdict
  out.PASS_200 = res.status === 200;
  out.PASS_octet = (out.contentType || '').includes('application/octet-stream');
  out.PASS_disposition =
    (out.contentDisposition || '').includes('attachment') &&
    (out.contentDisposition || '').includes('cql-dgx-b300-deck.pdf');
  out.PASS_bytes = out.bodyBytes === EXPECT_BYTES;
  out.PASS_pdfMagic = out.pdfMagic === '%PDF-';
  out.PASS_dist19fbd876 = out.dist_19fbd876_worktreeRaw;
  out.PASS_dista235fbd6 = out.dist_a235fbd6_stagingIdiom && out.dist_a235fbd6_doctrine;
  const all = [
    out.PASS_200, out.PASS_octet, out.PASS_disposition,
    out.PASS_bytes, out.PASS_pdfMagic, out.PASS_dist19fbd876, out.PASS_dista235fbd6,
  ];
  out.VERDICT = all.every(Boolean) ? 'PASS' : 'FAIL';
  console.log(JSON.stringify(out));
  process.exit(out.VERDICT === 'PASS' ? 0 : 1);
}

main().catch((e) => {
  out.ERR = String((e && e.message) || e).slice(0, 300);
  console.log(JSON.stringify(out));
  process.exit(1);
});
