import { describe, expect, it } from 'vitest';
import { buildHowRows, transparencyLabel } from './answer-transparency';

describe('transparencyLabel', () => {
  it('maps every check state onto the one pill', () => {
    expect(transparencyLabel({ kind: 'checked' }, 2, false)).toEqual({ label: 'Checked by 2 models', tone: 'ok' });
    expect(transparencyLabel({ kind: 'checking' }, 2, false)).toEqual({ label: 'Checking…', tone: 'spin' });
    expect(transparencyLabel({ kind: 'updated', changed: ['a'] }, 2, false)).toEqual({ label: 'Updated · 1 correction', tone: 'updated' });
    expect(transparencyLabel({ kind: 'updated', changed: ['a', 'b'] }, 2, false)?.label).toBe('Updated · 2 corrections');
    expect(transparencyLabel({ kind: 'quick' }, 1, false)).toEqual({ label: 'Quick answer', tone: 'quick' });
    expect(transparencyLabel({ kind: 'interrupted' }, 2, false)).toEqual({ label: "Check didn't finish · Retry", tone: 'warn' });
  });

  it('open reads "Hide how Digby answered"; nothing to say → null', () => {
    expect(transparencyLabel({ kind: 'checked' }, 2, true)?.label).toBe('Hide how Digby answered');
    expect(transparencyLabel(null, 0, false)).toBeNull();
    expect(transparencyLabel(null, 3, false)?.label).toBe('Checked by 3 models');
  });
});

describe('buildHowRows', () => {
  const META = {
    models: {
      deepseek: { response: 'Agreed. The rebate cap is right.', time: 11200, modelUsed: 'deepseek-flash' },
      kimi: { response: 'For a typical bungalow…', time: 8400, modelUsed: 'kimi-k3', toolCalls: [{ name: 'search_engine' }, { name: 'scrape_as_markdown' }] },
    },
    modelLabels: { kimi: 'Kimi K3', deepseek: 'DeepSeek V4.1 Flash' },
  };

  it('admins: one row per seat in seat order, with model id + time (legacy vendor keys map onto seats)', () => {
    const rows = buildHowRows({ ...META, modelLabels: undefined }, { kind: 'checked' }, { showModels: true });
    expect(rows.map((r) => [r.n, r.name, r.role])).toEqual([
      [1, 'Digby', 'wrote the answer'],
      [2, 'Double Checker', 'reviewed it'],
    ]);
    expect(rows[0].note).toBe('Searched the web 2 times before answering.');
    expect(rows[0].model).toBe('kimi-k3 · web search');
    expect(rows[0].time).toBe('8.4s');
    expect(rows[1].note).toBe('Agreed with the answer.');
    expect(rows[1].model).toBe('deepseek-flash');
  });

  it('non-admins (the default) never see a model id or a vendor label — seat names only', () => {
    const rows = buildHowRows(META, { kind: 'checked' });
    expect(rows.map((r) => r.name)).toEqual(['Digby', 'Double Checker']);
    expect(rows.every((r) => r.model === undefined)).toBe(true);
    const flat = JSON.stringify(rows.map(({ response: _r, ...rest }) => rest));
    expect(flat).not.toMatch(/kimi|deepseek|glm/i);
    expect(rows[0].note).toBe('Searched the web 2 times before answering.');
  });

  it('an updated answer names its corrections on the checker row', () => {
    const rows = buildHowRows({ models: { digby: {}, double_checker: {} } }, { kind: 'updated', changed: ['price 12 → 14'] });
    expect(rows[1].note).toBe('Made 1 correction: price 12 → 14');
  });

  it('without a models map the plan still yields the lead (+ checker when one ran)', () => {
    expect(buildHowRows({}, { kind: 'quick' }).map((r) => r.seat)).toEqual(['digby']);
    expect(buildHowRows({}, { kind: 'checked' }).map((r) => r.seat)).toEqual(['digby', 'double_checker']);
    expect(buildHowRows(undefined, null)).toEqual([]);
  });

  it('seat labels from metadata.modelLabels win for admins only', () => {
    expect(buildHowRows({ models: { digby: {} }, modelLabels: { digby: 'Digby (custom)' } }, null)[0].name).toBe('Digby');
    const rows = buildHowRows({ models: { digby: {} }, modelLabels: { digby: 'Digby (custom)' } }, null, { showModels: true });
    expect(rows[0].name).toBe('Digby (custom)');
  });
});
