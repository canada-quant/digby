import { describe, expect, it } from 'vitest';
import { linkifyWorktreePaths, parseWorktreeLinkHref, worktreeLinkHref } from './worktree-links';

const link = (p: string) => `[${p}](${worktreeLinkHref(p)})`;

describe('linkifyWorktreePaths (owner 2026-09-17: chat text interlinks the files it names)', () => {
  it('links a repo-relative path with an extension, keeping trailing punctuation outside the link', () => {
    expect(linkifyWorktreePaths('Created docs/BACKUPS.md.')).toBe(`Created ${link('docs/BACKUPS.md')}.`);
    expect(linkifyWorktreePaths('see (backend/src/worker.ts) and scripts/deploy/deploy-coding-worker.sh:'))
      .toBe(`see (${link('backend/src/worker.ts')}) and ${link('scripts/deploy/deploy-coding-worker.sh')}:`);
  });

  it('strips a leading ./ from the target and links dotfiles under a directory', () => {
    expect(linkifyWorktreePaths('edit ./config/.env first')).toBe(`edit ${link('config/.env')} first`);
  });

  it('links bare doc filenames but not bare source filenames', () => {
    expect(linkifyWorktreePaths('read README.md and package.json')).toBe(`read ${link('README.md')} and ${link('package.json')}`);
    expect(linkifyWorktreePaths('fix index.ts and app.py')).toBe('fix index.ts and app.py');
  });

  it('leaves code spans, fences, existing links and images alone', () => {
    const md = [
      'Run `cat docs/BACKUPS.md` first.',
      '',
      '```',
      'docs/BACKUPS.md',
      '```',
      '',
      '[docs](docs/BACKUPS.md) ![x](img/a.png) already linked: [docs/BACKUPS.md](#worktree:docs%2FBACKUPS.md)',
    ].join('\n');
    expect(linkifyWorktreePaths(md)).toBe(md);
  });

  it('never links mid-URL, absolute container paths, home paths, or node_modules/.git', () => {
    const md = [
      'https://github.com/canada-quant/digby/blob/main/docs/BACKUPS.md',
      '/app/dist/config/database.js and ~/.ssh/config',
      'node_modules/react/index.js .git/HEAD',
      'api.z.ai/paas/v4 digby.example.com',
    ].join('\n');
    expect(linkifyWorktreePaths(md)).toBe(md);
  });

  it('is idempotent and survives emphasis and table cells', () => {
    const once = linkifyWorktreePaths('**docs/X.md** | frontend/lib/a.ts |');
    expect(once).toBe(`**${link('docs/X.md')}** | ${link('frontend/lib/a.ts')} |`);
    expect(linkifyWorktreePaths(once)).toBe(once);
  });

  it('returns the input untouched when nothing matches (no parse cost)', () => {
    const md = 'Plain prose with a UUID 83e4fbf9-e18c-42f1-9bf7-7a99caf9d9c4 and numbers 1.2.3';
    expect(linkifyWorktreePaths(md)).toBe(md);
  });
});

describe('parseWorktreeLinkHref', () => {
  it('round-trips an encoded path and rejects foreign, absolute or escaping hrefs', () => {
    expect(parseWorktreeLinkHref(worktreeLinkHref('docs/a b.md'))).toBe('docs/a b.md');
    expect(parseWorktreeLinkHref('#worktree:%2Fetc%2Fpasswd')).toBeNull();
    expect(parseWorktreeLinkHref('#worktree:..%2Fx.md')).toBeNull();
    expect(parseWorktreeLinkHref('https://digby.example.com/x')).toBeNull();
    expect(parseWorktreeLinkHref(undefined)).toBeNull();
  });
});
