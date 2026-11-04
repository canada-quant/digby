/**
 * FilesPane (2026-10-07, owner: "not artifacts it should just all be files"):
 * ONE files list; the document editor replaces it only while a document is
 * open (state-preserving hide); chatless sessions show the document panel alone.
 */
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { FilesPane } from './FilesPane';

const render = (props: Parameters<typeof FilesPane>[0]) => renderToStaticMarkup(createElement(FilesPane, props));

describe('FilesPane', () => {
  it('shows only the one files list when no document is open (no second list)', () => {
    const html = render({ filesNode: createElement('div', null, 'FILES'), docNode: createElement('div', null, 'EDITOR') });
    expect(html).toContain('FILES');
    expect(html).not.toContain('EDITOR');
    expect(html).not.toContain('hidden');
  });
  it('hides (does not unmount) the list while a document is open', () => {
    const html = render({ filesNode: createElement('div', null, 'FILES'), docNode: createElement('div', null, 'EDITOR'), docOpen: true });
    expect(html).toContain('FILES');
    expect(html).toContain('hidden');
    expect(html).toContain('EDITOR');
  });
  it('a chatless session renders the document panel alone', () => {
    const html = render({ docNode: createElement('div', null, 'DOCS') });
    expect(html).not.toContain('files-part');
    expect(html).toContain('DOCS');
  });
});
