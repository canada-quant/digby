/** lib/site/instance — the public site's build-time instance check (self-host setup hardening, 2026-10-20). */
import { describe, it, expect } from 'vitest';
import { isInstallerHref, isSelfHostedBuild } from './instance';

describe('isSelfHostedBuild', () => {
  it('mirrors the backend rule: unset, empty or prod is production', () => {
    expect(isSelfHostedBuild({})).toBe(false);
    expect(isSelfHostedBuild({ DIGBY_INSTANCE: '' })).toBe(false);
    expect(isSelfHostedBuild({ DIGBY_INSTANCE: 'prod' })).toBe(false);
    expect(isSelfHostedBuild({ DIGBY_INSTANCE: 'PROD' })).toBe(false);
    expect(isSelfHostedBuild({ DIGBY_INSTANCE: 'selfhost' })).toBe(true);
    expect(isSelfHostedBuild({ DIGBY_INSTANCE: ' edge ' })).toBe(true);
  });
  it('only the served installers count as installer links', () => {
    expect(isInstallerHref('/Digby.dmg')).toBe(true);
    expect(isInstallerHref('/Digby-Setup.exe')).toBe(true);
    expect(isInstallerHref('/download')).toBe(false);
    expect(isInstallerHref('/help/self-host')).toBe(false);
  });
});
