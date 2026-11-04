/**
 * Renderer tests for MarkdownContent (feedback fc841f58 / 112f82db / da7dc5ea).
 *
 * Regression target: degraded model output — missing blank lines before
 * headings/lists, collapsed single-line structure, accidental setext — must
 * still render as real headings/lists/tables, never raw ## / - / | characters
 * or accidental giant H2s. Rendered via react-dom/server (no jsdom needed;
 * the shiki highlighter is effect-only, so SSR shows the plain-code fallback).
 */

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { MarkdownContent } from './markdown-content';

const render = (md: string) =>
  renderToStaticMarkup(createElement(MarkdownContent, null, md));

describe('MarkdownContent — well-formed input', () => {
  it('renders headings, bold, and lists', () => {
    const html = render('Intro\n\n## Section\n\n**key term** here\n\n- one\n- two');
    expect(html).toContain('<h2');
    expect(html).toContain('Section');
    expect(html).toContain('<strong');
    expect(html).toContain('<ul');
    expect(html).toContain('<li');
  });

  it('renders a GFM table', () => {
    const html = render('| a | b |\n|---|---|\n| 1 | 2 |');
    expect(html).toContain('<table');
    expect(html).toContain('<td');
  });

  it('renders fenced code as a code block, not headings', () => {
    const html = render('```\n# not a heading\n## also not\n```');
    expect(html).not.toContain('<h1');
    expect(html).not.toContain('<h2');
    expect(html).toContain('not a heading');
  });
});

describe('MarkdownContent — inline audio links (ticket 6c050917)', () => {
  const FILE_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

  it('a chat-file INLINE link with an audio extension renders the audio player, not an image embed or a download card', () => {
    const html = render(`[kokoro_af_heart_all4.wav](/api/crossmodel/files/${FILE_ID}/inline)`);
    // The player's SSR placeholder mounts — the model's "play this inline" link.
    expect(html).toContain('data-audio-player="loading"');
    expect(html).toContain('aria-label="Loading kokoro_af_heart_all4.wav"');
    // NOT the image embed, NOT the download card.
    expect(html).not.toContain('data-authed-file-image');
    expect(html).not.toContain('data-file-link-card');
  });

  it('the href extension drives the route when the link text has none (the raw-URL text form)', () => {
    const html = render(`[/api/crossmodel/files/${FILE_ID}/inline](${'/api/crossmodel/files/' + FILE_ID + '/inline'})`);
    // The href itself ends in /inline with no extension — NOT audio-routed.
    expect(html).toContain('data-authed-file-image="loading"');
  });

  it('an inline link whose FILENAME label carries the audio extension routes to the player', () => {
    const html = render(`[phonon-31m-en_Easton_all4.wav](/api/crossmodel/files/${FILE_ID}/inline)`);
    expect(html).toContain('data-audio-player="loading"');
    expect(html).not.toContain('data-file-link-card');
  });

  it('a DOWNLOAD-route audio link stays the download card (the explicit download shape)', () => {
    const html = render(`[clip.mp3](/api/crossmodel/files/${FILE_ID}/download)`);
    expect(html).toContain('data-file-link-card="chat-file"');
    expect(html).not.toContain('data-audio-player');
  });

  it('a non-audio inline link keeps the image embed (png untouched)', () => {
    const html = render(`[photo.png](/api/crossmodel/files/${FILE_ID}/inline)`);
    expect(html).toContain('data-authed-file-image="loading"');
    expect(html).not.toContain('data-audio-player');
  });

  it('every audio extension family routes to the player', () => {
    for (const ext of ['wav', 'mp3', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'flac', 'webm']) {
      const html = render(`[clip.${ext}](/api/crossmodel/files/${FILE_ID}/inline)`);
      expect(html).toContain('data-audio-player="loading"');
    }
  });
});

describe('MarkdownContent — degraded input tolerance', () => {
  it('single newline before a heading still renders an <h2>', () => {
    const html = render('Some intro text\n## Heading\nBody paragraph');
    expect(html).toContain('<h2');
    expect(html).not.toContain('## Heading');
  });

  it('single newline before a list still renders a <ul> (grocery-list case)', () => {
    const html = render('**Cooler:**\n- 1 lb ground beef\n- butter');
    expect(html).toContain('<ul');
    expect(html).toContain('1 lb ground beef');
  });

  it('ordered list not starting at 1 still renders an <ol>', () => {
    const html = render('Steps:\n2. second\n3. third');
    expect(html).toContain('<ol');
  });

  it('lists indent with PADDING so outside markers stay inside the list box (owner 2026-09-22: "list numbers are cut off")', () => {
    // `ml-5` put the list box 20px in and left the marker hanging in the parent\'s
    // gutter, where the transcript scroller clipped "1." to "L." — bullets are
    // narrow enough to survive, digits are not. Padding keeps the marker inside.
    const html = render('Steps:\n1. one\n2. two\n\nAlso:\n- a\n- b');
    const ol = html.match(/<ol[^>]*class="([^"]*)"/)?.[1] ?? '';
    const ul = html.match(/<ul[^>]*class="([^"]*)"/)?.[1] ?? '';
    expect(ol).toContain('pl-7');
    expect(ol).toContain('list-decimal');
    expect(ul).toContain('pl-6');
    expect(ol).not.toMatch(/\bml-\d/);
    expect(ul).not.toMatch(/\bml-\d/);
  });

  it('accidental setext ("text\\n---") renders as hr, NOT a giant H2', () => {
    const html = render('Some text\n---\nNext section');
    expect(html).toContain('<hr');
    expect(html).not.toMatch(/<h[12][^>]*>Some text/);
  });

  it('table after text without a blank line still renders a <table>', () => {
    const html = render('Here is the table:\n| Method | Time |\n|---|---|\n| Grill | 30 min |');
    expect(html).toContain('<table');
  });

  it('fully-collapsed single-line answer recovers its headings', () => {
    const html = render('Here is the ruleset: ## Setup 1. First thing ### Details More prose');
    expect(html).toContain('<h2');
    expect(html).toContain('<h3');
  });

  it('snapshot: degraded long-conversation answer renders structured', () => {
    const degraded =
      'Perfect — here is the plan: ## Meal Plan (2 nights)\n- **Day 1 lunch:** sandwiches\n- **Day 1 dinner:** hobo packets\n## Grocery List\n**Cooler:**\n- 1 lb ground beef\n- butter';
    expect(render(degraded)).toMatchSnapshot();
  });
});
