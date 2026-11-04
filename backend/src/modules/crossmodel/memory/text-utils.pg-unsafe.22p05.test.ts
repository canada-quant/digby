/**
 * 22P05 pin suite (FO firing 20, 2026-09-24) — PG-unsafe strings stripped at
 * DB write boundaries.
 *
 * Prod evidence: an LLM answer carrying a LONE surrogate made every write of
 * that text fail with `unsupported Unicode escape sequence` — run e8975be5
 * lost 12+ agentEvent appends and its final transcript persist failed 5×
 * (18 errors/24h, spike from a 3–6/day chronic background). These pins hold
 * the sanitizer's exact semantics: valid surrogate pairs SURVIVE, lone
 * surrogates and NULs are dropped, and clean values pass through by identity.
 */

import { stripPgUnsafe, pgSafeDeep } from './text-utils';

const LONE_HIGH = '\uD835'; // unpaired high surrogate
const LONE_LOW = '\uDC9C'; // unpaired low surrogate
const VALID_PAIR = '𝒜'; // U+1D49C == \uD835\uDC9C — must survive intact
const EMOJI = '⏳'; // U+23F3 — BMP symbol, untouched by the surrogate scan

describe('stripPgUnsafe (22P05 boundary sanitizer)', () => {
  it('preserves VALID surrogate pairs (astral code points) byte-for-byte', () => {
    expect(stripPgUnsafe(`ok ${VALID_PAIR} ok`)).toBe(`ok ${VALID_PAIR} ok`);
    expect(stripPgUnsafe(VALID_PAIR)).toBe(VALID_PAIR);
  });

  it('drops a lone HIGH surrogate', () => {
    expect(stripPgUnsafe(`bad${LONE_HIGH}end`)).toBe('badend');
  });

  it('drops a lone LOW surrogate', () => {
    expect(stripPgUnsafe(`bad${LONE_LOW}end`)).toBe('badend');
  });

  it('drops a high surrogate whose pair partner is beyond the string end', () => {
    expect(stripPgUnsafe(`tail${LONE_HIGH}`)).toBe('tail');
  });

  it('drops NUL bytes (22021 in text, 22P05 escaped in jsonb)', () => {
    expect(stripPgUnsafe('a\u0000b')).toBe('ab');
  });

  it('keeps a lone surrogate between a valid pair and a NUL from corrupting the pair', () => {
    const s = `${VALID_PAIR}${LONE_HIGH}\u0000${EMOJI}`;
    expect(stripPgUnsafe(s)).toBe(`${VALID_PAIR}${EMOJI}`);
  });

  it('returns clean strings by identity (fast path)', () => {
    const clean = 'plain ascii + é + ⏳ + 𝒜';
    expect(stripPgUnsafe(clean)).toBe(clean);
  });
});

describe('pgSafeDeep (deep boundary walk)', () => {
  it('strips nested strings in objects and arrays, keeps clean values by identity', () => {
    const cleanChild = { a: 'clean' };
    const v = { text: `x${LONE_HIGH}y`, arr: [cleanChild, `z${LONE_LOW}w`], n: 1, keep: 'ok' };
    const report = { stripped: false, dropped: 0 };
    const out: any = pgSafeDeep(v, report);
    expect(out.text).toBe('xy');
    expect(out.arr[0]).toBe(cleanChild); // clean subtree untouched by identity
    expect(out.arr[1]).toBe('zw');
    expect(out.n).toBe(1);
    expect(out.keep).toBe('ok');
    expect(report.stripped).toBe(true);
    expect(report.dropped).toBe(2);
  });

  it('returns the ORIGINAL object identity when nothing needed stripping', () => {
    const v = { a: 'clean', b: [{ c: 'also clean' }] };
    const report = { stripped: false, dropped: 0 };
    expect(pgSafeDeep(v, report)).toBe(v);
    expect(report.stripped).toBe(false);
  });

  it('strips unsafe OBJECT KEYS too', () => {
    const v = { [`k${LONE_HIGH}`]: 'v' };
    const out: any = pgSafeDeep(v, { stripped: false, dropped: 0 });
    expect(Object.keys(out)).toEqual(['k']);
  });

  it('passes Dates and Uint8Arrays through untouched', () => {
    const d = new Date(0);
    const buf = new Uint8Array([1, 2, 3]);
    expect(pgSafeDeep(d, { stripped: false, dropped: 0 })).toBe(d);
    expect(pgSafeDeep(buf, { stripped: false, dropped: 0 })).toBe(buf);
  });
});
