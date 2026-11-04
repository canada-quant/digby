/** Pure request builders behind the 2026-09-23 write tools. */
import { describe, expect, it } from 'vitest';
import { docEndIndex } from './docs.js';
import { normalizeRows } from './sheets.js';
import { driveConvertMime } from './drive.js';
import { buildSlideRequests } from './slides.js';

describe('docEndIndex', () => {
  it('inserts before the trailing newline segment', () => {
    expect(docEndIndex({ body: { content: [{ endIndex: 1 }, { endIndex: 42 }] } })).toBe(41);
  });
  it('never returns below 1 for an empty document', () => {
    expect(docEndIndex({ body: { content: [] } })).toBe(1);
    expect(docEndIndex(undefined)).toBe(1);
  });
});

describe('normalizeRows', () => {
  it('keeps numbers/booleans, blanks null/undefined, stringifies the rest, drops non-arrays', () => {
    expect(normalizeRows([['a', 1, true, null, undefined], 'junk', [{ x: 1 }]])).toEqual([['a', 1, true, '', ''], ['[object Object]']]);
    expect(normalizeRows('nope')).toEqual([]);
  });
});

describe('driveConvertMime', () => {
  it('maps the three native targets and nothing else', () => {
    expect(driveConvertMime('doc')).toBe('application/vnd.google-apps.document');
    expect(driveConvertMime('Sheet')).toBe('application/vnd.google-apps.spreadsheet');
    expect(driveConvertMime('slides')).toBe('application/vnd.google-apps.presentation');
    expect(driveConvertMime('pdf')).toBeUndefined();
    expect(driveConvertMime(undefined)).toBeUndefined();
  });
});

describe('buildSlideRequests', () => {
  it('creates one TITLE_AND_BODY slide per spec with deterministic placeholder ids and fills only the text that exists', () => {
    const reqs = buildSlideRequests([{ title: 'Agenda', bullets: ['One', 'Two'] }, { body: 'Just a note' }], 'p');
    expect(reqs[0].createSlide.objectId).toBe('p_s1');
    expect(reqs[0].createSlide.slideLayoutReference.predefinedLayout).toBe('TITLE_AND_BODY');
    expect(reqs[0].createSlide.placeholderIdMappings.map((m: any) => m.objectId)).toEqual(['p_s1_t', 'p_s1_b']);
    expect(reqs[1]).toEqual({ insertText: { objectId: 'p_s1_t', text: 'Agenda' } });
    expect(reqs[2]).toEqual({ insertText: { objectId: 'p_s1_b', text: '• One\n• Two' } });
    // second slide: no title → no title insert
    expect(reqs[3].createSlide.objectId).toBe('p_s2');
    expect(reqs[4]).toEqual({ insertText: { objectId: 'p_s2_b', text: 'Just a note' } });
    expect(reqs).toHaveLength(5);
  });
});
