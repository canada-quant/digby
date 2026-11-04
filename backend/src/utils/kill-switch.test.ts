/**
 * The 2026-10-21 lane-lifecycle wave's ONE switch parser (third review,
 * 2026-10-22). Three of its seven switches used to turn off only on the exact
 * value '1' and four also on 'true' / 'on' — an operator rolling the whole wave
 * back with every switch set to 'true' turned four features off and left the
 * ticket drain's gap paths, the display-parent stamping and the extended branch
 * janitor running. Pins: the parser itself, the readers that are cheap to load,
 * and a source scan that no read site of the seven names compares with '1'.
 */
import fs from 'fs';
import path from 'path';

jest.mock('../config/database', () => ({ __esModule: true, default: {} }));
jest.mock('./logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { killSwitchOn } from './kill-switch';
import { displayParentNestingDisabled } from '../modules/crossmodel/platform/display-parent';
import { archiveCascadeDisabled, laneRetireSwitchOff, laneRestoreMarkerReadersOff } from '../modules/crossmodel/platform/lane-family-facts';
import { retireAutoArchiveClause } from '../modules/crossmodel/platform/role-profiles';

const WAVE_SWITCHES = [
  'DISPLAY_PARENT_NESTING_DISABLED', 'TICKET_LANE_ARCHIVE_GAPS_DISABLED', 'LANE_IDLE_RETIRE_DISABLED', 'ARCHIVE_CASCADE_DISABLED',
  'SESSION_API_ARCHIVE_STAMP_DISABLED', 'REAPER_CANDIDATE_ROTATION_DISABLED', 'BRANCH_JANITOR_EXTENDED_RULES_DISABLED',
];

describe('killSwitchOn', () => {
  it('ON for 1 / true / on (trimmed, any case); OFF for everything else', () => {
    for (const v of ['1', 'true', 'TRUE', 'True', 'on', 'ON', ' 1 ', ' on ']) expect(killSwitchOn(v)).toBe(true);
    for (const v of [undefined, null, '', '0', 'false', 'off', 'no', 'yes', '2', 'enabled']) expect(killSwitchOn(v)).toBe(false);
  });
});

describe('the lane-lifecycle wave reads every switch through it', () => {
  it('"true" turns each loadable reader on (the rollback an operator would type)', () => {
    expect(displayParentNestingDisabled({ DISPLAY_PARENT_NESTING_DISABLED: 'true' })).toBe(true);
    expect(archiveCascadeDisabled({ ARCHIVE_CASCADE_DISABLED: 'true' })).toBe(true);
    expect(laneRetireSwitchOff({ LANE_IDLE_RETIRE_DISABLED: 'true' })).toBe(true);
    expect(laneRestoreMarkerReadersOff({ LANE_IDLE_RETIRE_DISABLED: 'true', ARCHIVE_CASCADE_DISABLED: 'true', TICKET_LANE_ARCHIVE_GAPS_DISABLED: 'true' })).toBe(true);
    expect(laneRestoreMarkerReadersOff({ LANE_IDLE_RETIRE_DISABLED: 'true', ARCHIVE_CASCADE_DISABLED: 'true' })).toBe(false);
    expect(retireAutoArchiveClause({ LANE_IDLE_RETIRE_DISABLED: 'true' })).toBe(retireAutoArchiveClause({ LANE_IDLE_RETIRE_DISABLED: '1' }));
    expect(retireAutoArchiveClause({ LANE_IDLE_RETIRE_DISABLED: 'true' })).not.toBe(retireAutoArchiveClause({}));
  });

  it('no backend source compares one of the seven names with \'1\' (every read goes through the one parser)', () => {
    const root = path.resolve(__dirname, '..'); // backend/src
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') && !e.name.endsWith('.d.ts')) files.push(p);
      }
    };
    walk(root);
    expect(files.length).toBeGreaterThan(100);
    const offenders: string[] = [];
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8');
      for (const name of WAVE_SWITCHES) {
        // `env.NAME === '1'`, `process.env[NAME_ENV] === '1'`, `String(env.NAME ?? '')…` hand parsers
        const strict = new RegExp(`${name}(_ENV)?\\]?\\s*===\\s*'1'`);
        const hand = new RegExp(`String\\([^)]*${name}[^)]*\\)\\.trim\\(\\)\\.toLowerCase\\(\\)`);
        if (strict.test(src) || hand.test(src)) offenders.push(`${path.relative(root, f)}: ${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
