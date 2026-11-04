/**
 * Switch scanner — build 2026-10-08 S-1 (simplify.md §4 stage 0). The ONE place that answers
 * "which env switches does the code read, and which does prod's compose deliver?" for the
 * switch registry's CI checks (src/modules/crossmodel/platform/switch-registry.ts) and the
 * `npm run switches:*` CLI (scripts/switches.ts).
 *
 * A SWITCH is an env name ending _DISABLED / _ENABLED / _ENFORCE (simplify.md §1.1's
 * definition — tuning knobs such as *_MS / *_CAP / *_MODE are out of scope for phase 1).
 *   • backend  — every such name in a string literal, a template-literal text part, a
 *                property access (`process.env.X`, `env.X`) or a destructured binding in
 *                non-test backend/src. Comments do not count (a retired switch named only in
 *                a comment is not read), so the scan parses with the TypeScript compiler.
 *   • frontend — NEXT_PUBLIC_* switches in the Next.js sources (build-time inlined).
 * FORWARDING (docker-compose.app.yml is explicit ${VAR} interpolation, backend/.dockerignore
 * drops .env — a key compose does not list never reaches a container): backend switches are
 * forwarded when the backend OR worker service lists them; frontend switches when the
 * frontend build args list them AND frontend/Dockerfile declares the ARG.
 *
 * Dev/CI-only module: `typescript` is a devDependency and is required lazily.
 */
import * as fs from 'fs';
import * as path from 'path';

export const SWITCH_SUFFIX_RE = /_(DISABLED|ENABLED|ENFORCE)$/;
export const SWITCH_NAME_RE = /^[A-Z][A-Z0-9_]*_(DISABLED|ENABLED|ENFORCE)$/;
const TOKEN_RE = /\b[A-Z][A-Z0-9_]*_(?:DISABLED|ENABLED|ENFORCE)\b/g;

/** Repo root (backend/scripts/ → ../..). */
export function repoRoot(): string {
  return path.resolve(__dirname, '..', '..');
}

function isTestFile(rel: string): boolean {
  return /\.(test|spec)\.tsx?$/.test(rel) || rel.split(path.sep).includes('__tests__');
}

function walk(dir: string, out: string[]): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.next' || e.name === 'dist') continue;
      walk(p, out);
    } else if (/\.tsx?$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

/**
 * Dynamic switch FAMILIES a source text builds: a template literal whose text ends
 * with a switch suffix and interpolates part of the name (`DECISION_GATE_${p}_ACT_CAP_DISABLED`)
 * — rendered with `<*>` for each interpolation. Pure given the compiler.
 */
export function switchFamiliesInSource(fileName: string, text: string): string[] {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const ts = require('typescript') as typeof import('typescript');
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, false, fileName.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found = new Set<string>();
  const visit = (n: import('typescript').Node): void => {
    if (ts.isTemplateExpression(n)) {
      const pattern = n.head.text + n.templateSpans.map((s) => `<*>${s.literal.text}`).join('');
      if (/^[A-Z0-9_]*(<\*>[A-Z0-9_]*)+$/.test(pattern) && SWITCH_SUFFIX_RE.test(pattern)) found.add(pattern);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return [...found];
}

/** Switch names a source text reads (comments excluded). Pure given the compiler. */
export function switchNamesInSource(fileName: string, text: string): string[] {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const ts = require('typescript') as typeof import('typescript');
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, false, fileName.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found = new Set<string>();
  const take = (t: string) => { for (const m of t.matchAll(TOKEN_RE)) found.add(m[0]); };
  const visit = (n: import('typescript').Node): void => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) take(n.text);
    else if (ts.isTemplateExpression(n)) { take(n.head.text); for (const s of n.templateSpans) take(s.literal.text); }
    else if (ts.isPropertyAccessExpression(n)) take(n.name.text);
    else if (ts.isBindingElement(n)) take((n.propertyName ?? n.name).getText(sf));
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return [...found];
}

/** name → repo-relative files that read it. */
export type SwitchReads = Map<string, string[]>;

/** The registry itself names every switch — it is the list, not a reader. */
export const SCAN_EXCLUDE = new Set(['backend/src/modules/crossmodel/platform/switch-registry.ts']);

function scanFiles(root: string, files: string[], keep: (name: string) => boolean): SwitchReads {
  const reads: SwitchReads = new Map();
  for (const f of files.sort()) {
    const rel = path.relative(root, f);
    if (isTestFile(rel) || SCAN_EXCLUDE.has(rel.split(path.sep).join('/'))) continue;
    for (const n of switchNamesInSource(f, fs.readFileSync(f, 'utf8'))) {
      if (!keep(n)) continue;
      const list = reads.get(n) ?? [];
      list.push(rel.split(path.sep).join('/'));
      reads.set(n, list);
    }
  }
  return reads;
}

export function scanBackendSwitches(root = repoRoot()): SwitchReads {
  return scanFiles(root, walk(path.join(root, 'backend', 'src'), []), () => true);
}

/** Dynamic switch families (pattern → files) built anywhere in non-test backend/src. */
export function scanBackendSwitchFamilies(root = repoRoot()): SwitchReads {
  const reads: SwitchReads = new Map();
  for (const f of walk(path.join(root, 'backend', 'src'), []).sort()) {
    const rel = path.relative(root, f).split(path.sep).join('/');
    if (isTestFile(rel) || SCAN_EXCLUDE.has(rel)) continue;
    for (const p of switchFamiliesInSource(f, fs.readFileSync(f, 'utf8'))) reads.set(p, [...(reads.get(p) ?? []), rel]);
  }
  return reads;
}

export const FRONTEND_SOURCE_DIRS = ['app', 'lib', 'components', 'hooks', 'src', 'content'];
export function scanFrontendSwitches(root = repoRoot()): SwitchReads {
  const fe = path.join(root, 'frontend');
  const files: string[] = [];
  for (const d of FRONTEND_SOURCE_DIRS) walk(path.join(fe, d), files);
  for (const f of ['proxy.ts', 'next.config.ts', 'middleware.ts']) if (fs.existsSync(path.join(fe, f))) files.push(path.join(fe, f));
  return scanFiles(root, files, (n) => n.startsWith('NEXT_PUBLIC_'));
}

export interface ComposeForwarding {
  backend: Set<string>;
  worker: Set<string>;
  /** frontend service build args */
  frontendArgs: Set<string>;
}

/**
 * Env names each service of a compose file lists (environment entries, `- NAME=…` or
 * `NAME: …`) plus the frontend build args. Line-based on purpose: docker-compose.app.yml is
 * a flat, two-space-indented list file; a structural change there fails this scan's pin test.
 */
export function composeForwarding(text: string): ComposeForwarding {
  const out: ComposeForwarding = { backend: new Set(), worker: new Set(), frontendArgs: new Set() };
  let service: string | null = null;
  let block: string | null = null; // service-level key (environment / build / …)
  let sub: string | null = null; // build-level key (args / context / …)
  let inServices = false;
  for (const line of text.split('\n')) {
    if (/^\s*(#.*)?$/.test(line)) continue;
    if (/^\S/.test(line)) { inServices = /^services:\s*$/.test(line); service = null; continue; }
    if (!inServices) continue;
    const svc = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
    if (svc) { service = svc[1]; block = null; sub = null; continue; }
    const key4 = line.match(/^ {4}([A-Za-z0-9_-]+):/);
    if (key4) { block = key4[1]; sub = null; continue; }
    const key6 = line.match(/^ {6}([a-z0-9_-]+):/);
    if (key6) { sub = key6[1]; continue; }
    const item = line.match(/^\s+-\s+([A-Z][A-Z0-9_]*)=/) ?? line.match(/^\s{6,}([A-Z][A-Z0-9_]*):\s/);
    if (!item || !service) continue;
    if ((service === 'backend' || service === 'worker') && block === 'environment') out[service].add(item[1]);
    else if (service === 'frontend' && block === 'build' && sub === 'args') out.frontendArgs.add(item[1]);
  }
  return out;
}

/** `ARG NAME` declarations in a Dockerfile. */
export function dockerfileArgs(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/^\s*ARG\s+([A-Z][A-Z0-9_]*)/gm)) out.add(m[1]);
  return out;
}

export interface RepoSwitchScan {
  backend: SwitchReads;
  frontend: SwitchReads;
  /** dynamic families (pattern with `<*>`) */
  families: SwitchReads;
  compose: ComposeForwarding;
  frontendDockerArgs: Set<string>;
}

export function scanRepo(root = repoRoot()): RepoSwitchScan {
  return {
    backend: scanBackendSwitches(root),
    frontend: scanFrontendSwitches(root),
    families: scanBackendSwitchFamilies(root),
    compose: composeForwarding(fs.readFileSync(path.join(root, 'docker-compose.app.yml'), 'utf8')),
    frontendDockerArgs: dockerfileArgs(fs.readFileSync(path.join(root, 'frontend', 'Dockerfile'), 'utf8')),
  };
}

/** The owner area a switch belongs to, from the first file that reads it. */
export function areaOf(file: string): string {
  const parts = file.split('/');
  if (parts[0] === 'frontend') return 'frontend';
  // backend/src/…
  const rest = parts.slice(2);
  if (rest[0] === 'modules' && rest[1] === 'crossmodel') return rest.length > 3 ? rest[2] : 'crossmodel';
  if (rest[0] === 'modules') return rest[1];
  return rest.length > 1 ? rest[0] : rest[0].replace(/\.ts$/, '');
}

/** The owner area of a switch read by `files`: the most common area (ties → the first file's). */
export function areaFor(files: string[]): string {
  const counts = new Map<string, number>();
  for (const f of files) counts.set(areaOf(f), (counts.get(areaOf(f)) ?? 0) + 1);
  let best = areaOf(files[0]);
  for (const [a, n] of counts) if (n > (counts.get(best) ?? 0)) best = a;
  return best;
}
