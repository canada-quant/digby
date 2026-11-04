import { collectStructuredBlocks } from './structured-blocks';

describe('collectStructuredBlocks (ticket 2ce29c32)', () => {
  const BLOCK = [
    '**[DISPATCH-NEEDED — for Fleet Supervisor c0e22e36, executing off this run_completed event]**',
    '',
    '1. **TARGET: serving session 7fbd168c-3417-4370-a763-3b8489491603** — serve ckpt-45.',
    '2. **TARGET: eval lane 596102ca-53de-4f90-a6c1-6e3003a7df95** — run the full suite.',
  ].join('\n');

  it('carries a mid-run dispatch block missing from finalText', () => {
    const parts = [
      { type: 'text', text: `Posting the dispatch now.\n\n${BLOCK}` },
      { type: 'tool_call', name: 'todo_get' },
    ];
    const out = collectStructuredBlocks(parts, 'Dispatch posted (three blocks above).');
    expect(out).toContain('[DISPATCH-NEEDED');
    expect(out).toContain('7fbd168c-3417-4370-a763-3b8489491603');
  });

  it('does NOT duplicate a block the final message already re-posts (83af154d self-audit pattern)', () => {
    const finalText = `Self-audit passed. The durable copy is this message:\n\n---\n\n${BLOCK}\n\n---\n\nNext check: 02:20Z.`;
    const parts = [{ type: 'text', text: BLOCK }];
    expect(collectStructuredBlocks(parts, finalText)).toBe('');
  });

  it('returns empty when no tagged blocks exist', () => {
    const parts = [{ type: 'text', text: 'Round 42 in progress, all lanes healthy.' }];
    expect(collectStructuredBlocks(parts, 'Status note.')).toBe('');
    expect(collectStructuredBlocks([], 'x')).toBe('');
    expect(collectStructuredBlocks(undefined, 'x')).toBe('');
    expect(collectStructuredBlocks(null, 'x')).toBe('');
  });

  it('ignores non-text parts and non-string text', () => {
    const parts = [
      { type: 'reasoning', text: '[DISPATCH-NEEDED] hidden' },
      { type: 'tool_result', name: 'x' },
      { type: 'text', text: 42 as unknown as string },
    ];
    expect(collectStructuredBlocks(parts as never[], 'final')).toBe('');
  });

  it('carries blocks from multiple parts in order, deduped', () => {
    const b1 = '[DISPATCH-NEEDED] warm the serving session';
    const b2 = '[DISPATCH-NEEDED] pull CloudTrail for the tamper window';
    const parts = [
      { type: 'text', text: `first:\n${b1}` },
      { type: 'text', text: `repeat:\n${b1}` }, // duplicate — carried once
      { type: 'text', text: `second:\n${b2}` },
    ];
    const out = collectStructuredBlocks(parts, 'posted two dispatches');
    expect(out).toBe(`${b1}\n\n${b2}`);
  });

  it('stops a block at a horizontal rule instead of swallowing trailing prose', () => {
    const part = `${BLOCK}\n\n---\n\nThis trailing status prose is NOT part of the dispatch.`;
    const out = collectStructuredBlocks([{ type: 'text', text: part }], 'final');
    expect(out).toContain('[DISPATCH-NEEDED');
    expect(out).not.toContain('trailing status prose');
  });

  it('matches a bare (non-bold) header and an em-dash suffix form', () => {
    const part = '[DISPATCH-NEEDED — escalate to owner]\nGPU allocation needed for B300 #3.';
    const out = collectStructuredBlocks([{ type: 'text', text: part }], 'final');
    expect(out).toContain('GPU allocation needed');
  });

  it('does not match a lookalike tag prefix', () => {
    const part = '[DISPATCH-NEEDEDX] not a real block header';
    expect(collectStructuredBlocks([{ type: 'text', text: part }], 'final')).toBe('');
  });

  it('caps one oversized block and the total carried volume', () => {
    const huge = `[DISPATCH-NEEDED] ${'x'.repeat(5000)}`;
    const out = collectStructuredBlocks([{ type: 'text', text: huge }], 'final');
    expect(out.length).toBeLessThan(1600);
    expect(out).toContain('…[truncated]');

    const mk = (n: number) => `[DISPATCH-NEEDED] block-${n} ${'y'.repeat(1200)}`;
    const parts = [0, 1, 2, 3].map((n) => ({ type: 'text', text: mk(n) }));
    const multi = collectStructuredBlocks(parts, 'final');
    expect(multi.length).toBeLessThanOrEqual(3000);
    expect(multi).toContain('block-0');
    expect(multi).not.toContain('block-3');
  });

  it('F1: does NOT promote a header quoted inside a fenced code block', () => {
    const part = [
      'Here is what a dispatch looks like:',
      '```markdown',
      '[DISPATCH-NEEDED] fake quoted dispatch',
      '---',
      '```',
      'No real block follows.',
    ].join('\n');
    expect(collectStructuredBlocks([{ type: 'text', text: part }], 'final')).toBe('');
  });

  it('F1: does NOT promote a 4-space/tab-indented header (indented code)', () => {
    const part = 'Example:\n    [DISPATCH-NEEDED] indented fake\n\t[DISPATCH-NEEDED] tab fake';
    expect(collectStructuredBlocks([{ type: 'text', text: part }], 'final')).toBe('');
  });

  it('F1: a `---` inside a fence does not terminate a real block', () => {
    const part = [
      '[DISPATCH-NEEDED] real dispatch',
      '```',
      '---',
      '```',
      'still the same dispatch',
      '---',
      'trailing prose',
    ].join('\n');
    const out = collectStructuredBlocks([{ type: 'text', text: part }], 'final');
    expect(out).toContain('still the same dispatch');
    expect(out).not.toContain('trailing prose');
  });

  it('F1: a legit header AFTER a closed fence is still carried', () => {
    const part = '```\nsome code\n```\n[DISPATCH-NEEDED] the real one';
    const out = collectStructuredBlocks([{ type: 'text', text: part }], 'final');
    expect(out).toBe('[DISPATCH-NEEDED] the real one');
  });

  it('F2: a CRLF `---\\r` rule terminates the block', () => {
    const part = '[DISPATCH-NEEDED] real\r\n---\r\ntrailing prose not carried';
    const out = collectStructuredBlocks([{ type: 'text', text: part }], 'final');
    expect(out).toContain('[DISPATCH-NEEDED] real');
    expect(out).not.toContain('trailing prose');
  });

  it('F3 (by design): `***`/`___` rules do NOT terminate a block (fleet convention is `---`)', () => {
    const part = '[DISPATCH-NEEDED] real\n***\nfollowing prose stays in the block';
    const out = collectStructuredBlocks([{ type: 'text', text: part }], 'final');
    expect(out).toContain('following prose stays in the block');
  });
});
