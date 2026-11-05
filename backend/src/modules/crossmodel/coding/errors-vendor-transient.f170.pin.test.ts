/**
 * PIN (FO firing 170, 2026-10-20) — the errors_4h vendor_transient rung
 * (33rd f64 bake), live-proven by this firing's own hand-run box-A probe.
 *
 * DEFECT (audit bar, not backend): a BrightData vendor degradation ramps the
 * pinned web-search wrapper classes past the n>30 spike bar for HOURS with
 * zero user impact, and every firing that sees the rows hand-adjudicates
 * "vendor-transient, ok" — the exact by-eye tax the f64 doctrine retires.
 * f169 read the classes at n:11/n:13 (verdict ok); f170 read the SAME four
 * classes at n:185/113/49/36 (ESCALATE ×4 — the audit's ONLY ESCALATEs) after
 * the 08:00Z onset and hand-proved vendor-side: hourly distribution onset
 * 08:00-09:00Z PREDATES the 4024e26ac CI start (08:54:18Z) and the edbf40c5
 * deploy; BOTH the direct and MCP lanes degrade together; BrightData's own
 * 504 Gateway Time-out pages appear at 10:18Z; six consecutive 4h buckets
 * over 30 raw vendor rows in 7d with failed_runs = 0 in EVERY bucket; zero
 * failed agent runs in 12h (retries absorb; no user-visible impact).
 *
 * BAKE: a third rung, vendor_transient — downgrades ONLY when ALL hold:
 * (1) the normalized group is one of the two vendor-call wrappers
 *     ('BrightData direct:%' | 'Digby Web Search:%'),
 * (2) the message matches a KNOWN-transient shape (timeout | timed out |
 *     missing organic results | status code 50x | transient 50x retry) —
 *     40x auth/billing is NEVER pinned (the revoked-key class must keep
 *     ESCALATE; the 2026-10-11 security-incident briefing rules 401s are
 *     revoked-key behavior, not billing), and
 * (3) NO agent_run failed in the window (any failed run keeps ESCALATE —
 *     same conservative impact axis as the firing-84 absorbed:failover arm).
 * New signatures outside the pin list still ESCALATE — the rung covers
 * exactly the measured population, never a blanket source exemption. The
 * rollup never reads errors_4h (its 9 conditions printed verbatim below the
 * bar) — section-only, zero rollup impact.
 *
 * TEXTUAL + BEHAVIORAL, same shape as the f92–f169 pins.
 */

const fs = require('fs');
const path = require('path');

export {};

function repoRoot(start: string): string {
  let d = start;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(d, 'scripts/framework-audit/audit-live-state.js'))) return d;
    d = path.dirname(d);
  }
  throw new Error('repo root not found from ' + start);
}

const ROOT = repoRoot(__dirname);
const src = fs.readFileSync(path.join(ROOT, 'scripts/framework-audit/audit-live-state.js'), 'utf8');

/** The behavioral model of the errors_4h CASE — same inputs as the SQL row. */
function verdictFor(r: { n: number; msg: string; http_code: string | null; failed_runs: number; codes: string[] }): string {
  if (r.n > 30 && r.http_code !== null && r.failed_runs === 0 && r.codes.includes(r.http_code)) return 'absorbed:failover';
  if (
    r.n > 30 &&
    r.failed_runs === 0 &&
    (r.msg.startsWith('BrightData direct:') || r.msg.startsWith('Digby Web Search:')) &&
    (/timeout/i.test(r.msg) || /timed out/i.test(r.msg) || /missing organic results/i.test(r.msg) || /status code 50/i.test(r.msg) || /transient 50/i.test(r.msg))
  ) {
    return 'vendor_transient';
  }
  if (r.n > 30) return 'ESCALATE';
  return 'ok';
}

describe('errors_4h vendor_transient rung (f170 pin)', () => {
  describe('textual', () => {
    it('the probe carries the vendor_transient rung', () => {
      expect(src).toContain("'vendor_transient'");
    });
    it('the rung sits AFTER absorbed:failover and BEFORE the bare ESCALATE', () => {
      const iAbs = src.indexOf("'absorbed:failover'");
      const iVen = src.indexOf("'vendor_transient'");
      expect(iAbs).toBeGreaterThan(-1);
      expect(iVen).toBeGreaterThan(iAbs);
      expect(src.indexOf("THEN 'ESCALATE'", iVen)).toBeGreaterThan(iVen);
    });
    it('the rung requires zero failed runs in the window', () => {
      const arm = src.slice(src.indexOf("WHEN t.n > 30 AND f.failed_runs = 0 AND (t.msg LIKE 'BrightData direct:%'"), src.indexOf("'vendor_transient'"));
      expect(arm).toContain('f.failed_runs = 0');
    });
    it('pins exactly the two vendor wrappers and the five transient shapes', () => {
      expect(src).toContain("t.msg LIKE 'BrightData direct:%'");
      expect(src).toContain("t.msg LIKE 'Digby Web Search:%'");
      for (const p of ['%timeout%', '%timed out%', '%missing organic results%', '%status code 50%', '%transient 50%']) {
        expect(src).toContain(`'${p}'`);
      }
    });
  });

  describe('behavioral', () => {
    it('the four f170 live classes flip to vendor_transient at failed_runs=0', () => {
      const rows = [
        { msg: 'BrightData direct: search_engine failed:  direct SERP response missing organic results (other)', n: 185 },
        { msg: 'BrightData direct: search_engine failed:  timeout of 60000ms exceeded', n: 113 },
        { msg: 'BrightData direct: scrape_as_markdown failed:  timeout of 45000ms exceeded', n: 49 },
        { msg: 'Digby Web Search: scrape_as_markdown SSE stream timed out (45s)', n: 36 },
      ];
      for (const r of rows) {
        expect(verdictFor({ ...r, http_code: null, failed_runs: 0, codes: [] })).toBe('vendor_transient');
      }
    });
    it('a failed run in the window keeps ESCALATE (impact axis)', () => {
      expect(
        verdictFor({ msg: 'BrightData direct: search_engine failed:  timeout of 60000ms exceeded', n: 113, http_code: null, failed_runs: 1, codes: [] }),
      ).toBe('ESCALATE');
    });
    it('40x auth/billing is never pinned — ESCALATE stands', () => {
      for (const code of ['401', '402', '403', '429']) {
        expect(
          verdictFor({ msg: `BrightData direct: search_engine failed:  Request failed with status code ${code}`, n: 60, http_code: code, failed_runs: 0, codes: [] }),
        ).toBe('ESCALATE');
      }
    });
    it('vendor 50x waves (status code / transient retry) are pinned', () => {
      expect(
        verdictFor({ msg: 'BrightData direct: search_engine failed: 504 Request failed with status code 504 — body: <html>', n: 55, http_code: '504', failed_runs: 0, codes: [] }),
      ).toBe('vendor_transient');
      expect(
        verdictFor({ msg: 'BrightData direct: transient 502 (attempt 1/3) — retrying in 586ms', n: 44, http_code: null, failed_runs: 0, codes: [] }),
      ).toBe('vendor_transient');
    });
    it('absorbed:failover keeps priority when the failover named the code', () => {
      expect(
        verdictFor({ msg: 'coding agent turn failed:  Request failed with status code 502', n: 40, http_code: '502', failed_runs: 0, codes: ['502'] }),
      ).toBe('absorbed:failover');
    });
    it('new vendor signatures outside the pin list still ESCALATE', () => {
      expect(
        verdictFor({ msg: 'BrightData direct: scrape_as_markdown failed:  Parse Error: Header overflow', n: 41, http_code: null, failed_runs: 0, codes: [] }),
      ).toBe('ESCALATE');
      expect(
        verdictFor({ msg: 'BrightData direct: account suspended', n: 31, http_code: null, failed_runs: 0, codes: [] }),
      ).toBe('ESCALATE');
    });
    it('the n>30 bar itself is unchanged (30 ok, 31 verdict)', () => {
      expect(verdictFor({ msg: 'Digby Web Search: scrape_as_markdown SSE stream timed out (45s)', n: 30, http_code: null, failed_runs: 0, codes: [] })).toBe('ok');
      expect(verdictFor({ msg: 'Digby Web Search: scrape_as_markdown SSE stream timed out (45s)', n: 31, http_code: null, failed_runs: 0, codes: [] })).toBe('vendor_transient');
    });
    it('non-vendor classes are untouched', () => {
      expect(
        verdictFor({ msg: 'coding tool read_file failed: ENOENT: no such file or directory', n: 55, http_code: null, failed_runs: 0, codes: [] }),
      ).toBe('ESCALATE');
    });
  });
});
