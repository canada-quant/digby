/**
 * AST-aware search / rewrite — harness roadmap item 3 (2026-09-20).
 *
 * `ast_search` and `ast_rewrite` run ast-grep (https://ast-grep.github.io)
 * inside the session's dev container through `npx --package @ast-grep/cli`
 * — no image change: the shared dev container is plain node:20 with npm
 * registry access, and the pinned package resolves in ~1 s cold / 0 s warm
 * (probed live 2026-09-20 on box C). Patterns are ast-grep pattern syntax
 * (`$A` = one node, `$$$ARGS` = many); the language is inferred per file when
 * omitted. NEVER invoke the binary as `sg` — the container's /usr/bin/sg is the
 * shadow-utils group command; the package's other binary name `ast-grep` is the
 * one this module uses.
 *
 * Observations baked in from the probe: no match prints `[]` and exits 1 (so
 * the exit code is not an error signal — the JSON is); a pattern that does not
 * parse prints `[]` plus a `Warning: Pattern contains an ERROR node` line on
 * stderr (the renderer surfaces it so the model fixes the pattern instead of
 * concluding "no matches"); `--update-all` prints `Applied N changes` and no
 * JSON. AST_GREP_VERSION pins the package.
 */

export const AST_GREP_DEFAULT_VERSION = '0.45.3';
/** Cold npx fetch (≈10 MB) + the scan; warm runs finish in well under a second. */
export const AST_TIMEOUT_MS = 90_000;
/** Rendered match cap per result (the full count is always stated). */
export const AST_MAX_RENDERED = 100;
/** A rewrite touching more files than this is refused — narrow with path/glob. */
export const AST_REWRITE_MAX_FILES = 200;

/** The pinned @ast-grep/cli version (env override must be a plain semver triple). */
export function astGrepVersion(): string {
  const v = String(process.env.AST_GREP_VERSION ?? '').trim();
  return /^\d+\.\d+\.\d+$/.test(v) ? v : AST_GREP_DEFAULT_VERSION;
}

const LANG_RE = /^[A-Za-z][A-Za-z0-9+#.-]{0,15}$/;

/** Null when `lang` is acceptable to pass through; otherwise the tool-facing error. */
export function validateAstLang(lang: unknown): string | null {
  if (lang === undefined || lang === null || lang === '') return null;
  const s = String(lang).trim();
  if (LANG_RE.test(s)) return null;
  return `Tool failed: lang ${JSON.stringify(String(lang).slice(0, 40))} is not a language id (use ast-grep ids such as ts, tsx, js, py, rs, go, java, c, cpp, cs, rb, php, kt, swift, html, css, json, yaml, bash — or omit it to infer per file).`;
}

export interface AstGrepCommandArgs {
  pattern: string;
  lang?: string | null;
  glob?: string | null;
  rewrite?: string | null;
  /** Apply the rewrite (`--update-all`) instead of reporting matches as JSON. */
  update?: boolean;
  /** Scope relative to the worktree ('.' or a subpath) — output paths stay worktree-relative. */
  scope: string;
}

/**
 * Build the shell command. Every interpolated value goes through the caller's
 * single-quote escaper (tools.ts shq) — the same read-only-tool invariant grep
 * and glob hold: a prompt-injected pattern must never reach bash unquoted.
 * stderr is merged so the pattern warnings reach the parser.
 */
export function buildAstGrepCommand(a: AstGrepCommandArgs, shq: (s: string) => string): string {
  const parts = [
    'npx', '--yes', '--package', shq(`@ast-grep/cli@${astGrepVersion()}`), 'ast-grep', 'run',
    '--pattern', shq(a.pattern),
  ];
  if (a.lang) parts.push('--lang', shq(String(a.lang).trim()));
  if (a.glob) parts.push('--globs', shq(String(a.glob)));
  if (a.rewrite !== undefined && a.rewrite !== null) parts.push('--rewrite', shq(String(a.rewrite)));
  parts.push(a.update ? '--update-all' : '--json=compact');
  parts.push(shq(a.scope || '.'), '2>&1');
  return parts.join(' ');
}

export interface AstMatch {
  file: string;
  /** 1-based. */
  line: number;
  /** 1-based. */
  column: number;
  text: string;
  /** The full source line(s) the match sits on. */
  lines: string;
  replacement?: string;
}

export interface AstGrepParse {
  /** False when no JSON array line was found (the process died, npx failed, …). */
  parsed: boolean;
  matches: AstMatch[];
  /** Non-JSON lines worth showing (pattern warnings); help/URL boilerplate dropped. */
  notes: string[];
}

const NOTE_DROP_RE = /^(Help:|See also:|For more information)/i;

/** Parse merged stdout+stderr: the first line starting with `[` is the JSON array. */
export function parseAstGrepOutput(raw: string): AstGrepParse {
  const lines = String(raw ?? '').split('\n');
  let matches: AstMatch[] = [];
  let parsed = false;
  const notes: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    if (!parsed && t.startsWith('[')) {
      try {
        const arr = JSON.parse(t);
        if (Array.isArray(arr)) {
          parsed = true;
          matches = arr.map((m: any) => ({
            file: String(m?.file ?? ''),
            line: Number(m?.range?.start?.line ?? 0) + 1,
            column: Number(m?.range?.start?.column ?? 0) + 1,
            text: String(m?.text ?? ''),
            lines: String(m?.lines ?? ''),
            ...(typeof m?.replacement === 'string' ? { replacement: m.replacement } : {}),
          }));
          continue;
        }
      } catch { /* not the JSON line after all — keep it as a note */ }
    }
    if (!NOTE_DROP_RE.test(t)) notes.push(t.slice(0, 240));
  }
  return { parsed, matches, notes };
}

const UNAVAILABLE_RE = /npx: (command )?not found|npm ERR!|npm error|ENOTFOUND|ETIMEDOUT|ECONNREFUSED|ECONNRESET|EAI_AGAIN|could not determine executable|Cannot find module|No matching version|E4(?:03|04)|network request .* failed/i;

/** True when the line is a JSON array — ast-grep's match output shape. A
 *  match line's text/lines fields EMBED THE MATCHED SOURCE TEXT, so repo
 *  content that merely DESCRIBES an npm/npx failure (docs, troubleshooting
 *  notes) would false-flag a working ast_search as "unavailable" (ticket
 *  05198c8e, prod lane 5f90c628: a docs line about docker-compose params rode
 *  the "reason" verbatim into the failure text). npm/npx diagnostics are
 *  never JSON. */
function isJsonArrayLine(line: string): boolean {
  const t = line.trim();
  if (!t.startsWith('[')) return false;
  try { return Array.isArray(JSON.parse(t)); } catch { return false; }
}

/** When the output shows npx / the registry failed (not ast-grep itself), the first such line. */
export function astGrepUnavailableReason(raw: string): string | null {
  for (const line of String(raw ?? '').split('\n')) {
    if (isJsonArrayLine(line)) continue; // 05198c8e: match JSON embeds source text, never an npm diagnostic
    if (UNAVAILABLE_RE.test(line)) return line.trim().slice(0, 200);
  }
  return null;
}

/** "Applied N changes" → N; null when the line is absent. */
export function parseAppliedChanges(raw: string): number | null {
  const m = /Applied (\d+) changes?/.exec(String(raw ?? ''));
  return m ? Number(m[1]) : null;
}

export function uniqueFiles(matches: AstMatch[]): string[] {
  return [...new Set(matches.map((m) => m.file).filter(Boolean))];
}

function matchLine(m: AstMatch): string {
  const src = (m.lines || m.text).replace(/\s+/g, ' ').trim().slice(0, 200);
  return `${m.file}:${m.line}:${m.column}  ${src}${m.replacement !== undefined ? `  →  ${m.replacement.replace(/\s+/g, ' ').trim().slice(0, 160)}` : ''}`;
}

/** Render a search (or dry-run rewrite) result for the model. */
export function renderAstMatches(res: AstGrepParse, opts: { max?: number } = {}): string {
  const max = opts.max ?? AST_MAX_RENDERED;
  const noteText = res.notes.length ? `\n${res.notes.map((n) => `[ast-grep] ${n}`).join('\n')}` : '';
  if (!res.matches.length) {
    const hint = res.notes.some((n) => /ERROR node/i.test(n))
      ? '\nThe PATTERN did not parse as code in this language — fix the pattern (use ast-grep pattern syntax: $A for one node, $$$ARGS for many) rather than concluding nothing matches.'
      : '';
    return `(no matches)${noteText}${hint}`;
  }
  const files = uniqueFiles(res.matches);
  const shown = res.matches.slice(0, max).map(matchLine);
  const more = res.matches.length > max ? `\n…+${res.matches.length - max} more (narrow with path / glob)` : '';
  return `${res.matches.length} match(es) in ${files.length} file(s)\n${shown.join('\n')}${more}${noteText}`;
}
