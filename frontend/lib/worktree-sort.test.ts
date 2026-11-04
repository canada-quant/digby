import { describe, expect, it } from 'vitest';
import { formatRelativeTime, sortWorktreeEntries } from './worktree-sort';

const T0 = Date.UTC(2026, 8, 17, 12, 0, 0);

describe('sortWorktreeEntries (owner 2026-09-17: most recently changed on top)', () => {
  const entries = [
    { name: 'b.md', type: 'file' as const, mtime: T0 - 5_000 },
    { name: 'a.md', type: 'file' as const, mtime: T0 - 60_000 },
    { name: 'gone.txt', type: 'file' as const, status: 'D' as const },
    { name: 'zed', type: 'dir' as const, mtime: T0 - 1_000 },
    { name: 'alpha', type: 'dir' as const, mtime: T0 - 90_000 },
    { name: 'c.md', type: 'file' as const, mtime: T0 - 5_000 },
  ];

  it('recent: folders first (newest folder first), then files newest first, ties by name, no-mtime rows last', () => {
    expect(sortWorktreeEntries(entries, 'recent').map(e => e.name)).toEqual([
      'zed', 'alpha', 'b.md', 'c.md', 'a.md', 'gone.txt',
    ]);
  });

  it('name: folders first, then plain codepoint order', () => {
    expect(sortWorktreeEntries(entries, 'name').map(e => e.name)).toEqual([
      'alpha', 'zed', 'a.md', 'b.md', 'c.md', 'gone.txt',
    ]);
  });

  it('does not mutate the input', () => {
    const copy = [...entries];
    sortWorktreeEntries(entries, 'recent');
    expect(entries).toEqual(copy);
  });
});

describe('formatRelativeTime', () => {
  it('walks the ladder: just now → minutes → hours → days → short date', () => {
    expect(formatRelativeTime(T0 - 10_000, T0)).toBe('just now');
    expect(formatRelativeTime(T0 - 5 * 60_000, T0)).toBe('5m ago');
    expect(formatRelativeTime(T0 - 3 * 3600_000, T0)).toBe('3h ago');
    expect(formatRelativeTime(T0 - 2 * 86400_000, T0)).toBe('2d ago');
    const tenDaysAgo = T0 - 10 * 86400_000;
    const d = new Date(tenDaysAgo);
    expect(formatRelativeTime(tenDaysAgo, T0)).toBe(`Sep ${d.getDate()}`);
  });

  it('never reads a future stamp as negative (clock skew → "just now") and names the year across a boundary', () => {
    expect(formatRelativeTime(T0 + 30_000, T0)).toBe('just now');
    const lastYear = Date.UTC(2025, 2, 3, 12);
    expect(formatRelativeTime(lastYear, T0)).toMatch(/^Mar \d+, 2025$/);
  });
});
