/**
 * ISOLATION PIN for the display-only parent (2026-10-21, lanefix/nesting).
 *
 * crossmodel_chats.displayParentChatId is a SIDEBAR hint: the folder's Project
 * Supervisor for a machine-spawned lane. It must never become a second lineage
 * column — parentChatId alone drives the parent's fire-cap billing, implicit
 * parent autonomy, [CHILD RUN FAILED] wakes, deliverable hand-off targeting, the
 * child reapers and any archive cascade, and pointing those at the supervisor
 * would bill, wake and authorize it for every ticket lane.
 *
 * So the column name may appear ONLY in the writer, the list read paths and the
 * pure lineage splice. A new reader anywhere else fails here — if a real need
 * appears, add it to the allowlist with the reason in the same change.
 */
import fs from 'fs';
import path from 'path';

const SRC = path.resolve(__dirname, '../../..'); // backend/src
const TOKEN = 'displayParentChatId';

/** Paths relative to backend/src/modules/crossmodel. */
const ALLOWED = new Set([
  'platform/display-parent.ts', // the writer + the kill switch
  'platform/platform.service.ts', // startCodingSession calls the writer
  'crossmodel.service.ts', // listChats row select (GET /chats, /chats/changes)
  'chat-list-lineage.ts', // the pure lineage completion splice
  'projects.controller.ts', // GET /projects/:id folder rows
]);

function walk(dir: string, out: string[]): void {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile() && e.name.endsWith('.ts') && !e.name.endsWith('.d.ts') && !/\.test\.ts$/.test(e.name)) out.push(p);
  }
}

describe('displayParentChatId is read only by the sidebar paths', () => {
  it('no non-test backend source outside the allowlist names the column', () => {
    const files: string[] = [];
    walk(SRC, files);
    expect(files.length).toBeGreaterThan(100); // the walk really saw the tree
    const crossmodelDir = path.join(SRC, 'modules', 'crossmodel');
    const offenders = files
      .filter((f) => fs.readFileSync(f, 'utf8').includes(TOKEN))
      .map((f) => (f.startsWith(crossmodelDir + path.sep) ? path.relative(crossmodelDir, f) : path.relative(SRC, f)).split(path.sep).join('/'))
      .filter((rel) => !ALLOWED.has(rel));
    expect(offenders).toEqual([]);
  });

  it('every allowlisted file exists (a rename must update the pin)', () => {
    for (const rel of ALLOWED) expect(fs.existsSync(path.join(SRC, 'modules', 'crossmodel', rel))).toBe(true);
  });
});
