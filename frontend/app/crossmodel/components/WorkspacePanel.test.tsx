/**
 * WorkspacePanel chrome pins (2026-08-31 panel unification): ONE close
 * affordance lives in this shell for every section — the tab strip's right
 * end (multi-section) or a slim label header (single-section) — so sections
 * no longer grow their own close buttons. Same react-dom/server idiom as
 * PatiencePicker.test.tsx (node-environment vitest, no jsdom). onClose firing
 * is a DOM event, out of SSR's reach — these pins cover presence/absence and
 * placement only.
 */

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import WorkspacePanel, { type WorkspaceSection } from './WorkspacePanel';

const section = (id: string, label: string): WorkspaceSection =>
  ({ id, label, node: createElement('div', null, `${label} body`) });

const render = (sections: WorkspaceSection[], onClose?: () => void) =>
  renderToStaticMarkup(createElement(WorkspacePanel, { sections, onClose }));

describe('WorkspacePanel — unified close chrome (2026-08-31)', () => {
  it('multi-section: tab strip carries the close X', () => {
    const html = render([section('overview', 'Overview'), section('files', 'Files')], () => {});
    expect(html).toContain('Overview');
    expect(html).toContain('Files');
    expect(html).toContain('title="Hide panel"');
  });

  it('single-section: slim header shows the label AND the close X', () => {
    const html = render([section('schedules', 'Schedules')], () => {});
    expect(html).toContain('Schedules');
    expect(html).toContain('title="Hide panel"');
  });

  it('no onClose → no close affordance (and no single-section header chrome)', () => {
    const html = render([section('schedules', 'Schedules')]);
    expect(html).not.toContain('title="Hide panel"');
    // The section body still renders.
    expect(html).toContain('Schedules body');
  });

  it('empty section list renders nothing', () => {
    expect(render([], () => {})).toBe('');
  });
});

describe('WorkspacePanel — icon-first tab strip (owner directive 2026-09-09)', () => {
  it('multi-section tabs are role=tab with the label as tooltip + aria-label (icons carry the strip)', () => {
    const html = render([section('artifacts', 'Artifacts'), section('files', 'Files'), section('schedules', 'Schedules'), section('browser', 'Browser')], () => {});
    expect(html).toContain('role="tablist"');
    for (const label of ['Artifacts', 'Files', 'Schedules', 'Browser']) {
      expect(html).toContain(`title="${label}"`);
      expect(html).toContain(`aria-label="${label}"`);
    }
    // Every tab gets an icon even when the mount passes none (SECTION_ICONS fallback).
    expect((html.match(/<svg/g) || []).length).toBeGreaterThanOrEqual(4);
  });

  it('labels are inline only past the container-query width (never overflow at the 280px rail minimum)', () => {
    const html = render([section('artifacts', 'Artifacts'), section('files', 'Files')], () => {});
    expect(html).toContain('hidden @[26rem]:inline');
    expect(html).toContain('@container');
  });

  it('the active tab is aria-selected', () => {
    const html = render([section('artifacts', 'Artifacts'), section('files', 'Files')], () => {});
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('aria-selected="false"');
  });
});
