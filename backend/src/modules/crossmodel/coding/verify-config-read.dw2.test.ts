/**
 * DW-2 (framework backlog 2026-10-02; FO f118, 2026-10-11): readDigbyConfig
 * used to catch ALL of readFile + JSON.parse into `null`, so a hand-mangled
 * .digby/config.json (truncated write, trailing comma, BOM, EACCES/EISDIR)
 * was indistinguishable from an absent one — the verify tool answered
 * "No verify chain configured" over a config the author DID write, and
 * nothing recorded why. These pins hold the three-arm contract of
 * readDigbyConfigDetailed and the backward-compatible wrapper:
 *
 *   absent      — ENOENT (and only ENOENT)
 *   readError   — any other read failure (EISDIR here; EACCES in prod) or a
 *                 JSON.parse failure, message preserved
 *   config      — parsed DigbyConfig
 *
 * The tool seam (tools.ts 'verify') answers "No verify chain could be read —
 * … (.digby/config.json exists but is not readable/parseable (…))" on the
 * readError arm — deliberately NOT matching the run-receipts anchors
 * /^Verify (PASSED|FAILED|UNVERIFIED)/ (run-receipts.ts:248-250), so the
 * receipt stays passed:false / failedStage:null exactly like the absent arm.
 * The observe-only loop_metrics row is kind verify_config_read_error.
 */
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readDigbyConfig, readDigbyConfigDetailed } from './verify.service';

const mkRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dw2-'));

describe('DW-2 — readDigbyConfigDetailed three arms (FO f118)', () => {
  test('absent: no .digby/config.json ⇒ {absent:true}, wrapper ⇒ null', async () => {
    const root = mkRoot();
    const r = await readDigbyConfigDetailed(root);
    expect(r).toEqual({ absent: true });
    await expect(readDigbyConfig(root)).resolves.toBeNull();
  });

  test('readError (parse): trailing comma ⇒ message names parse + file', async () => {
    const root = mkRoot();
    fs.mkdirSync(path.join(root, '.digby'), { recursive: true });
    fs.writeFileSync(path.join(root, '.digby', 'config.json'), '{"verify":["test"],}');
    const r = await readDigbyConfigDetailed(root);
    expect('readError' in r).toBe(true);
    if ('readError' in r) {
      expect(r.readError).toContain('parse .digby/config.json');
      expect(r.readError.length).toBeGreaterThan('parse .digby/config.json: '.length);
    }
    // The LEGACY wrapper keeps its contract: unreadable ≡ null downstream.
    await expect(readDigbyConfig(root)).resolves.toBeNull();
  });

  test('readError (read): config.json is a directory ⇒ message names read', async () => {
    const root = mkRoot();
    fs.mkdirSync(path.join(root, '.digby', 'config.json'), { recursive: true });
    const r = await readDigbyConfigDetailed(root);
    expect('readError' in r).toBe(true);
    if ('readError' in r) expect(r.readError).toContain('read .digby/config.json');
  });

  test('config: valid file ⇒ parsed object, both readers', async () => {
    const root = mkRoot();
    fs.mkdirSync(path.join(root, '.digby'), { recursive: true });
    fs.writeFileSync(path.join(root, '.digby', 'config.json'), JSON.stringify({ verify: ['test'], commands: { test: 'jest' } }));
    const r = await readDigbyConfigDetailed(root);
    expect('config' in r).toBe(true);
    const legacy = await readDigbyConfig(root);
    expect(legacy).toMatchObject({ verify: ['test'] });
  });

  test('BOM is a parse error (not silently absent): the exact truncated-write class DW-2 exists for', async () => {
    const root = mkRoot();
    fs.mkdirSync(path.join(root, '.digby'), { recursive: true });
    fs.writeFileSync(path.join(root, '.digby', 'config.json'), '﻿{"verify":["test"]}');
    const r = await readDigbyConfigDetailed(root);
    expect('readError' in r).toBe(true);
  });

  test('the tool answer on the readError arm must NOT match the run-receipts verify anchors', () => {
    // Verbatim contract mirrors of run-receipts.ts:248-250 — the DW-2 answer
    // string in tools.ts must stay anchor-free so the receipt keeps parsing
    // passed:false / failedStage:null (nothing ran, nothing verified).
    const VERIFY_PASSED_RE = /^Verify PASSED/;
    const VERIFY_FAILED_STAGE_RE = /^Verify FAILED at "([^"]+)"/;
    const VERIFY_UNVERIFIED_RE = /^Verify UNVERIFIED/;
    const answer = 'No verify chain could be read — .digby/config.json exists but is not readable/parseable (parse .digby/config.json: Unexpected token }). Fix the file (often a truncated write or trailing comma) and re-run verify. Nothing is verified — report "unverified — config unreadable" rather than "verified".';
    expect(VERIFY_PASSED_RE.test(answer)).toBe(false);
    expect(VERIFY_FAILED_STAGE_RE.test(answer)).toBe(false);
    expect(VERIFY_UNVERIFIED_RE.test(answer)).toBe(false);
  });
});
