import { describe, expect, it } from 'vitest';

import { CHAT_DEEP_LINK, linkifySessionRefs } from './session-links';

const ID = '1ca12570-0921-4a94-a857-f0b9b75f8933';
const ID2 = 'c0e22e36-aaaa-bbbb-cccc-dddddddddddd';

describe('linkifySessionRefs (feedback b8e1b0a3 — session interlinks)', () => {
  it('linkifies a bare full UUID with an 8-char short-id label', () => {
    expect(linkifySessionRefs(`dispatched session ${ID}`)).toBe(
      `dispatched session [1ca12570](${CHAT_DEEP_LINK}${ID})`,
    );
  });

  it('linkifies a UUID inside a table cell', () => {
    const row = `| Lane ${ID} | ✅ healthy | firing 23:15Z |`;
    expect(linkifySessionRefs(row)).toBe(
      `| Lane [1ca12570](${CHAT_DEEP_LINK}${ID}) | ✅ healthy | firing 23:15Z |`,
    );
  });

  it('linkifies multiple UUIDs on one line', () => {
    const out = linkifySessionRefs(`${ID} vs ${ID2}`);
    expect(out).toBe(
      `[1ca12570](${CHAT_DEEP_LINK}${ID}) vs [c0e22e36](${CHAT_DEEP_LINK}${ID2})`,
    );
  });

  it('lowercases an uppercase UUID in the href', () => {
    const up = ID.toUpperCase();
    expect(linkifySessionRefs(up)).toBe(`[1ca12570](${CHAT_DEEP_LINK}${ID})`);
  });

  it('leaves a UUID inside an inline code span untouched', () => {
    const s = `id \`${ID}\` done`;
    expect(linkifySessionRefs(s)).toBe(s);
  });

  it('leaves UUIDs inside fenced code blocks untouched', () => {
    const s = `before\n\`\`\`\n${ID}\n\`\`\`\nafter ${ID}`;
    expect(linkifySessionRefs(s)).toBe(
      `before\n\`\`\`\n${ID}\n\`\`\`\nafter [1ca12570](${CHAT_DEEP_LINK}${ID})`,
    );
  });

  it('leaves a UUID that is already a link destination untouched', () => {
    const s = `[Backup-HX300](${CHAT_DEEP_LINK}${ID})`;
    expect(linkifySessionRefs(s)).toBe(s);
  });

  it('leaves a UUID inside an external link destination untouched', () => {
    const s = `[pr](https://github.com/x/y/pull/${ID})`;
    expect(linkifySessionRefs(s)).toBe(s);
  });

  // Review B1: a UUID inside ANY URL shape must survive — rewriting it
  // destroys the URL (verified on the production remark parser).
  it('leaves a UUID inside an angle autolink untouched', () => {
    const s = `<https://example.com/${ID}>`;
    expect(linkifySessionRefs(s)).toBe(s);
  });

  it('leaves a UUID inside a bare https URL untouched', () => {
    const s = `see https://github.com/x/y/pull/${ID} now`;
    expect(linkifySessionRefs(s)).toBe(s);
  });

  it('leaves the app OWN full deep-link URL untouched (pasted verbatim)', () => {
    const s = `open https://digby.ai/crossmodel?chatId=${ID} now`;
    expect(linkifySessionRefs(s)).toBe(s);
  });

  // Review B2: GFM also autolinks scheme-less www. URLs and case-variant
  // schemes — those shapes must be protected too.
  it('leaves a scheme-less www. URL with a UUID untouched', () => {
    const s = `open www.digby.ai/crossmodel?chatId=${ID} now`;
    expect(linkifySessionRefs(s)).toBe(s);
  });

  it('leaves an uppercase-scheme URL with a UUID untouched', () => {
    const s = `open HTTPS://digby.ai/crossmodel?chatId=${ID} now`;
    expect(linkifySessionRefs(s)).toBe(s);
  });

  it('still linkifies a bare UUID AFTER a bare URL on the same line', () => {
    const s = `https://x.com ${ID}`;
    expect(linkifySessionRefs(s)).toBe(
      `https://x.com [1ca12570](${CHAT_DEEP_LINK}${ID})`,
    );
  });

  // Review B3: GFM autolinks email-shaped tokens — a UUID in the local OR
  // domain part must be protected (completes the GFM autolink set).
  it('leaves a UUID in an email local part untouched', () => {
    const s = `mail ${ID}@example.com now`;
    expect(linkifySessionRefs(s)).toBe(s);
  });

  it('leaves a UUID in an email domain part untouched', () => {
    const s = `mail user@${ID}.com now`;
    expect(linkifySessionRefs(s)).toBe(s);
  });

  it('leaves a mailto: address with a UUID untouched', () => {
    const s = `write mailto:${ID}@example.com today`;
    expect(linkifySessionRefs(s)).toBe(s);
  });

  // Review B4: GFM email domains allow '_' — a UUID after an underscore must
  // not match (left boundary fails by construction under the boundary model).
  it('leaves a UUID in an underscore email domain untouched (B4)', () => {
    const s = `mail user@x_${ID}.example.com now`;
    expect(linkifySessionRefs(s)).toBe(s);
  });

  // Review B5: GFM counts balanced parens inside URL paths/destinations.
  it('leaves a UUID in a balanced-paren URL path untouched (B5)', () => {
    const s = `see https://x.com/a(b)/${ID} end`;
    expect(linkifySessionRefs(s)).toBe(s);
  });

  it('leaves a UUID in a balanced-paren link destination untouched (B5)', () => {
    const s = `[x](https://a.com/b(c)/${ID})`;
    expect(linkifySessionRefs(s)).toBe(s);
  });

  // Review B6: ']' can be part of a GFM autolink path.
  it('leaves a UUID after a mid-path bracket untouched (B6)', () => {
    const s = `see https://x.com/a]${ID} end`;
    expect(linkifySessionRefs(s)).toBe(s);
  });

  // Review B7 (REGRESSION): rewriteFileSchemeLinks output — a file: refdef
  // rewritten to the /api download route — must never be linkified.
  it('leaves a UUID in an /api download-route refdef untouched (B7)', () => {
    const s = `[report]: /api/crossmodel/generated-files/${ID}/download\n\nsee [report] for the export`;
    expect(linkifySessionRefs(s)).toBe(s);
  });

  // Boundary-model doctrine: a UUID inside a multi-word inline code span is
  // whitespace-bounded, so the code-span guard must catch it.
  it('leaves a UUID inside a multi-word inline code span untouched', () => {
    const s = `run \`deploy ${ID} now\` carefully`;
    expect(linkifySessionRefs(s)).toBe(s);
  });

  // Deliberate MISS (conservative direction): '(' is not a left boundary —
  // balanced parens are valid inside URL paths, so parenthesized UUIDs are
  // never linkified rather than risk severing a URL.
  it('does NOT linkify a parenthesized UUID (documented miss)', () => {
    const s = `(see ${ID})`;
    expect(linkifySessionRefs(s)).toBe(s);
  });

  it('linkifies a UUID followed by trail punctuation', () => {
    const s = `session ${ID}: green`;
    expect(linkifySessionRefs(s)).toBe(
      `session [1ca12570](${CHAT_DEEP_LINK}${ID}): green`,
    );
  });

  // Review B8: the fence tracker must match micromark — a closing fence
  // cannot carry an info string, and the close run must be >= the open run.
  it('B8-A: info-string line inside a fence is content, not a close', () => {
    const s = '```\n```bash\ndeploy ' + ID + ' now\n```\n```';
    expect(linkifySessionRefs(s)).toBe(s);
  });

  it('B8-B: a 3-backtick line does not close a 4-backtick fence', () => {
    const s = '````\n```markdown\nsession ' + ID + ' green\n```\n````';
    expect(linkifySessionRefs(s)).toBe(s);
  });

  it('B8-C: trailing content after a fence run is not a close', () => {
    const s = '```\n``` x\n' + ID + '\n```';
    expect(linkifySessionRefs(s)).toBe(s);
  });

  // Review B9: trail punctuation followed by MORE token chars is not a
  // boundary — these are plain tokens, not sentence punctuation.
  it('B9: does NOT linkify a UUID before .csv / .tld / :port', () => {
    expect(linkifySessionRefs(`exported ${ID}.csv now`)).toBe(`exported ${ID}.csv now`);
    expect(linkifySessionRefs(`ping ${ID}.example.com now`)).toBe(`ping ${ID}.example.com now`);
    expect(linkifySessionRefs(`agent ${ID}:8080 up`)).toBe(`agent ${ID}:8080 up`);
  });

  it('still linkifies a UUID before sentence-final punctuation at EOL', () => {
    expect(linkifySessionRefs(`session ${ID}!`)).toBe(
      `session [1ca12570](${CHAT_DEEP_LINK}${ID})!`,
    );
  });

  // Review B10: blockquote-prefixed fences are real fences (micromark) — the
  // tracker must open AND close on the same bq depth.
  it('B10: leaves a UUID inside a blockquote fence untouched', () => {
    const s = `> \`\`\`\n> ${ID}\n> \`\`\``;
    expect(linkifySessionRefs(s)).toBe(s);
  });

  it('B10: leaves a UUID inside a bq fence with info string untouched', () => {
    const s = `> \`\`\`bash\n> deploy ${ID} now\n> \`\`\``;
    expect(linkifySessionRefs(s)).toBe(s);
  });

  // Review B12: CommonMark allows up to 3 spaces (or a tab) between the bq
  // marker(s) and the fence run — every spacing variant is a real fence.
  it('B12: bq fence with 2 spaces after the marker is still a fence', () => {
    const s = '>  ```\n>  ' + ID + '\n>  ```';
    expect(linkifySessionRefs(s)).toBe(s);
  });

  it('B12: bq fence with a tab after the marker is still a fence', () => {
    const s = '>\t```\n>\t' + ID + '\n>\t```';
    expect(linkifySessionRefs(s)).toBe(s);
  });

  it('B12: nested bq fence with 2 spaces is still a fence', () => {
    const s = '>>  ```\n>>  ' + ID + '\n>>  ```';
    expect(linkifySessionRefs(s)).toBe(s);
  });

  it('B12: bq tilde fence with extra spacing is still a fence', () => {
    const s = '>  ~~~\n>  ' + ID + '\n>  ~~~';
    expect(linkifySessionRefs(s)).toBe(s);
  });

  // Review B13: a close run indented 4–6 spaces or ANY tab is fence CONTENT
  // to the parser (CommonMark measures ≤3 in expanded columns) — the tracker
  // must NOT close there, or the code that follows is linkified.
  it('B13: a 4-space-indented close run is content, not a close', () => {
    const s = '```\n' + ID + '\n    ```\n' + ID2 + '\n```';
    expect(linkifySessionRefs(s)).toBe(s);
  });

  it('B13: a tab-indented close run is content, not a close', () => {
    const s = '```\n' + ID + '\n\t```\n' + ID2 + '\n```';
    expect(linkifySessionRefs(s)).toBe(s);
  });

  it('B13: a tab-indented tilde close run is content, not a close', () => {
    const s = '~~~\n' + ID + '\n\t~~~\n' + ID2 + '\n~~~';
    expect(linkifySessionRefs(s)).toBe(s);
  });

  it('B13: a bq tight-marker tab close run is content, not a close', () => {
    const s = '>```\n>' + ID + '\n>\t\t```\n> ' + ID2 + '\n>```';
    expect(linkifySessionRefs(s)).toBe(s);
  });

  // Review B14: a tab/4–6-space-indented fence line is indented CODE to the
  // parser — it must NOT open the tracker, or the next real open is consumed
  // as the tracker's close and parity inverts (parser's fence content
  // linkified). Byte-identical = tracker stayed out of the way.
  it('B14: a tab-indented fence line is not an opener', () => {
    const s = '\t```\n```\n' + ID + '\n```';
    expect(linkifySessionRefs(s)).toBe(s);
  });

  it('B14: a 4-space-indented fence line is not an opener', () => {
    const s = '    ```\n```\n' + ID + '\n```';
    expect(linkifySessionRefs(s)).toBe(s);
  });

  // Review B15: after bq markers a SINGLE tab expands to ≤3 columns of
  // content indent — micromark treats '> \t```' / '>\t```' as REAL fence
  // events. The tracker must close there too or parity inverts downstream.
  it('B15: a bq tab-after-marker close is a real close', () => {
    const s = '> ```\n> code\n> \t```\n> text\n> ```\n> ' + ID + '\n> ```';
    expect(linkifySessionRefs(s)).toBe(s);
  });

  it('B15: a bq tight-marker tab close is a real close', () => {
    const s = '>```\n>code\n>\t```\n>text\n>```\n>' + ID + '\n>```';
    expect(linkifySessionRefs(s)).toBe(s);
  });

  // Review B11: CRLF documents — the fence regexes must tolerate '\r'.
  it('B11: leaves a UUID inside a CRLF fence untouched, linkifies after', () => {
    const s = '```\r\n' + ID + '\r\n```\r\nafter ' + ID;
    expect(linkifySessionRefs(s)).toBe(
      '```\r\n' + ID + '\r\n```\r\nafter [1ca12570](' + CHAT_DEEP_LINK + ID + ')',
    );
  });

  // Review M2: a whitespace-bounded UUID inside a link TITLE must not be
  // linkified (the titled link would be dismembered).
  it('M2: leaves a UUID inside a markdown link title untouched', () => {
    const s = `[report ${ID} and more](https://x.com)`;
    expect(linkifySessionRefs(s)).toBe(s);
  });

  it('does NOT linkify a 40-char git SHA (not UUID-shaped)', () => {
    const s = 'commit 1ca12570092a4a94a857f0b9b75f8933abcdef12 landed';
    expect(linkifySessionRefs(s)).toBe(s);
  });

  it('does NOT linkify a UUID embedded in a longer hex/dash token', () => {
    const s = `token ${ID}-ff tail`;
    expect(linkifySessionRefs(s)).toBe(s);
  });

  it('does NOT linkify a short 8-hex id', () => {
    const s = 'session 1ca12570 reported green';
    expect(linkifySessionRefs(s)).toBe(s);
  });

  it('is idempotent', () => {
    const once = linkifySessionRefs(`a ${ID} b ${ID2}`);
    expect(linkifySessionRefs(once)).toBe(once);
  });

  it('passes through text with no UUIDs byte-identical', () => {
    const s = '**Fleet sweep — 2:04 PM PDT:** all lanes green\n\n| Lane | Status |\n|---|---|';
    expect(linkifySessionRefs(s)).toBe(s);
  });
});
