/**
 * scripts/framework-audit/set-roster-policy.js — the writer of the roster model-access switches (roster 2026-10-06
 * Team C). Pins its argument parsing against the backend reader's field names (platform/roster-policy.ts
 * normalizeRosterPolicy reads exactly these keys).
 */
import * as path from 'path';
import { normalizeRosterPolicy } from '../modules/crossmodel/platform/roster-policy';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const script: any = require(path.resolve(__dirname, '..', '..', '..', 'scripts', 'framework-audit', 'set-roster-policy.js'));

describe('set-roster-policy.js', () => {
  it('every field it writes is one the reader understands, with the same value shapes', () => {
    const { set, errors } = script.parseArgs(['--apply', 'autoPickPolicy=open_only', 'costPerUsd=0.5', 'rolePick=act', 'rolePickCanaryUserIds=u1,u2', 'quickWebCap=act', 'quickWebCapCanaryUserIds=u1']);
    expect(errors).toEqual([]);
    const p = normalizeRosterPolicy(set);
    expect(p).toMatchObject({ autoPickPolicy: 'open_only', costPerUsd: 0.5, rolePick: 'act', quickWebCap: 'act' });
    expect([...p.rolePickCanaryUserIds]).toEqual(['u1', 'u2']);
    expect([...p.quickWebCapCanaryUserIds]).toEqual(['u1']);
  });

  it('refuses unknown fields (including other teams\' fields on the same row) and bad values', () => {
    expect(script.parseArgs(['--apply', 'modelPick=act']).errors).toHaveLength(1);
    expect(script.parseArgs(['--apply', 'actCanaryUserIds=u1']).errors).toHaveLength(1);
    expect(script.parseArgs(['--apply', 'rolePick=on']).errors).toHaveLength(1);
    expect(script.parseArgs(['--apply']).errors).toHaveLength(1);
    expect(script.parseArgs([]).errors).toEqual([]);
  });
});
