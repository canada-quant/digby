/**
 * ast-tools (harness roadmap item 3): the pure halves — command construction
 * (quoting invariant), output parsing against the live ast-grep 0.45.3 shapes
 * probed on box C 2026-09-20, unavailability classification and rendering.
 */
import {
  buildAstGrepCommand, parseAstGrepOutput, astGrepUnavailableReason, parseAppliedChanges,
  renderAstMatches, uniqueFiles, validateAstLang, astGrepVersion, AST_GREP_DEFAULT_VERSION,
} from './ast-tools';

const shq = (s: string) => `'${String(s).replace(/'/g, `'\\''`)}'`;

beforeEach(() => { delete process.env.AST_GREP_VERSION; });

describe('buildAstGrepCommand', () => {
  it('invokes the ast-grep binary (never sg — the container /usr/bin/sg is the group command) through a pinned npx package, JSON compact for searches', () => {
    const cmd = buildAstGrepCommand({ pattern: 'console.log($A)', scope: '.' }, shq);
    expect(cmd).toBe(`npx --yes --package '@ast-grep/cli@${AST_GREP_DEFAULT_VERSION}' ast-grep run --pattern 'console.log($A)' --json=compact '.' 2>&1`);
    expect(cmd).not.toMatch(/\bsg\b/);
  });

  it('single-quote-escapes every interpolated value — a prompt-injected pattern never reaches bash unquoted', () => {
    const cmd = buildAstGrepCommand({ pattern: '$(touch /tmp/pwned)', lang: "ts' ; rm -rf . ; '", glob: '*.ts`id`', rewrite: "x'y", scope: 'src' }, shq);
    expect(cmd).toContain(`--pattern '$(touch /tmp/pwned)'`);
    expect(cmd).toContain(`--lang 'ts'\\'' ; rm -rf . ; '\\'''`);
    expect(cmd).toContain(`--globs '*.ts\`id\`'`);
    expect(cmd).toContain(`--rewrite 'x'\\''y'`);
    expect(cmd).toContain(`--json=compact 'src' 2>&1`);
    expect(cmd).not.toMatch(/--pattern \$\(/);
  });

  it('a rewrite apply swaps --json=compact for --update-all; an EMPTY rewrite template (delete) is still passed', () => {
    const dry = buildAstGrepCommand({ pattern: 'debugger', rewrite: '', lang: 'ts', scope: '.' }, shq);
    expect(dry).toContain(`--rewrite ''`);
    expect(dry).toContain('--json=compact');
    const apply = buildAstGrepCommand({ pattern: 'debugger', rewrite: '', lang: 'ts', scope: '.', update: true }, shq);
    expect(apply).toContain('--update-all');
    expect(apply).not.toContain('--json');
  });

  it('AST_GREP_VERSION overrides the pin only when it is a semver triple', () => {
    process.env.AST_GREP_VERSION = '0.46.1';
    expect(astGrepVersion()).toBe('0.46.1');
    process.env.AST_GREP_VERSION = 'latest; rm -rf /';
    expect(astGrepVersion()).toBe(AST_GREP_DEFAULT_VERSION);
  });
});

describe('validateAstLang', () => {
  it('accepts ast-grep language ids and omission; rejects anything shell-shaped', () => {
    for (const ok of [undefined, null, '', 'ts', 'tsx', 'py', 'c++', 'C#', 'objective-c']) expect(validateAstLang(ok)).toBeNull();
    expect(validateAstLang('ts; rm -rf /')).toMatch(/is not a language id/);
    expect(validateAstLang('$(id)')).toMatch(/is not a language id/);
  });
});

// Live shapes from the 2026-09-20 probe (ast-grep 0.45.3, --json=compact).
const MATCH = '[{"text":"console.log(1)","range":{"byteOffset":{"start":14,"end":28},"start":{"line":0,"column":14},"end":{"line":0,"column":28}},"file":"x.ts","lines":"function a(){ console.log(1) }","charCount":{"leading":14,"trailing":2},"language":"TypeScript","metaVariables":{"single":{"A":{"text":"1","range":{"byteOffset":{"start":26,"end":27},"start":{"line":0,"column":26},"end":{"line":0,"column":27}}}},"multi":{},"transformed":{}}},{"text":"console.log(3)","range":{"byteOffset":{"start":0,"end":14},"start":{"line":0,"column":0},"end":{"line":0,"column":14}},"file":"sub/z.js","lines":"console.log(3)","charCount":{"leading":0,"trailing":0},"replacement":"log(3)","replacementOffsets":{"start":0,"end":14},"language":"JavaScript","metaVariables":{"single":{},"multi":{},"transformed":{}}}]';

describe('parseAstGrepOutput', () => {
  it('maps the compact JSON to 1-based file:line:col matches with the source line and optional replacement', () => {
    const r = parseAstGrepOutput(MATCH + '\n');
    expect(r.parsed).toBe(true);
    expect(r.matches).toEqual([
      { file: 'x.ts', line: 1, column: 15, text: 'console.log(1)', lines: 'function a(){ console.log(1) }' },
      { file: 'sub/z.js', line: 1, column: 1, text: 'console.log(3)', lines: 'console.log(3)', replacement: 'log(3)' },
    ]);
    expect(r.notes).toEqual([]);
    expect(uniqueFiles(r.matches)).toEqual(['x.ts', 'sub/z.js']);
  });

  it('a non-parsing pattern is `[]` plus the ERROR-node warning: parsed, zero matches, the warning kept, boilerplate dropped', () => {
    const r = parseAstGrepOutput('[]\nWarning: Pattern contains an ERROR node and may cause unexpected results.\nHelp: ast-grep parsed the pattern but it matched nothing in this run. Try using playground to refine the pattern.\nSee also: https://ast-grep.github.io/playground.html\n');
    expect(r.parsed).toBe(true);
    expect(r.matches).toEqual([]);
    expect(r.notes).toEqual(['Warning: Pattern contains an ERROR node and may cause unexpected results.']);
  });

  it('no JSON line at all (npx died, command failed) → parsed:false with the lines as notes', () => {
    const r = parseAstGrepOutput('[command failed] spawn ENOMEM');
    expect(r.parsed).toBe(false);
    expect(r.notes).toEqual(['[command failed] spawn ENOMEM']);
    expect(parseAstGrepOutput('').parsed).toBe(false);
  });
});

describe('astGrepUnavailableReason / parseAppliedChanges', () => {
  it('classifies npx / registry failures (not ast-grep verdicts) as unavailability', () => {
    expect(astGrepUnavailableReason('npm ERR! code ENOTFOUND\nnpm ERR! network request to https://registry.npmjs.org/@ast-grep%2fcli failed')).toMatch(/ENOTFOUND/);
    expect(astGrepUnavailableReason('sh: 1: npx: not found')).toMatch(/npx: not found/);
    expect(astGrepUnavailableReason('npm error could not determine executable to run')).toMatch(/could not determine executable/);
    expect(astGrepUnavailableReason(MATCH)).toBeNull();
    expect(astGrepUnavailableReason('[]\nWarning: Pattern contains an ERROR node')).toBeNull();
  });

  // ── ticket 05198c8e (2026-09-23, prod lane 5f90c628): a WORKING ast_search
  // was false-flagged "unavailable" ×3 because the reason scanner tested the
  // MATCH JSON lines too — their text/lines fields EMBED THE MATCHED SOURCE,
  // and repo docs describing an npm failure carry the trigger phrases. The
  // filed failure text's "reason" was itself a match-JSON fragment. ──
  it('(05198c8e) match JSON whose embedded source text contains an npm-failure phrase is NOT unavailability', () => {
    const poisoned = JSON.stringify([{
      text: '`docker-compose.app.yml` — run `npm error code ENOTFOUND` repro notes',
      range: { byteOffset: { start: 9477, end: 9560 }, start: { line: 77, column: 2 }, end: { line: 77, column: 83 } },
      file: 'docs/TROUBLESHOOTING.md', lines: 'see npm error output below',
    }]);
    expect(astGrepUnavailableReason(poisoned)).toBeNull();
    // Mixed shapes: a real npx failure line still wins, match JSON stays inert.
    expect(astGrepUnavailableReason(`${poisoned}\nsh: 1: npx: not found`)).toMatch(/npx: not found/);
  });

  it('(05198c8e) a bracket line that does NOT parse as a JSON array is still scanned', () => {
    expect(astGrepUnavailableReason('[npm ERR! code E404]')).toMatch(/E404/);
    expect(astGrepUnavailableReason('[]\nnot json [oops')).toBeNull();
  });

  it('reads the apply receipt', () => {
    expect(parseAppliedChanges('Applied 1 changes\n')).toBe(1);
    expect(parseAppliedChanges('Applied 12 changes')).toBe(12);
    expect(parseAppliedChanges('[]')).toBeNull();
  });
});

describe('renderAstMatches', () => {
  it('states the count, lists file:line:col with the source line (and the replacement on a dry run), caps the listing', () => {
    const r = parseAstGrepOutput(MATCH);
    const out = renderAstMatches(r);
    expect(out).toMatch(/^2 match\(es\) in 2 file\(s\)\n/);
    expect(out).toContain('x.ts:1:15  function a(){ console.log(1) }');
    expect(out).toContain('sub/z.js:1:1  console.log(3)  →  log(3)');
    const many = { parsed: true, notes: [], matches: Array.from({ length: 7 }, (_, i) => ({ file: `f${i}.ts`, line: i + 1, column: 1, text: 'x', lines: 'x' })) };
    const capped = renderAstMatches(many, { max: 5 });
    expect(capped).toContain('…+2 more');
    expect(capped.split('\n').filter((l) => /^f\d\.ts:/.test(l))).toHaveLength(5);
  });

  it('a non-parsing pattern renders the warning AND tells the model to fix the pattern rather than conclude "no matches"', () => {
    const out = renderAstMatches(parseAstGrepOutput('[]\nWarning: Pattern contains an ERROR node and may cause unexpected results.'));
    expect(out).toMatch(/^\(no matches\)\n\[ast-grep\] Warning: Pattern contains an ERROR node/);
    expect(out).toMatch(/fix the pattern/);
    expect(renderAstMatches(parseAstGrepOutput('[]'))).toBe('(no matches)');
  });
});
