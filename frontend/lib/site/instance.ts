/**
 * Which Digby this build is (self-host setup hardening, 2026-10-20).
 *
 * Mirrors the backend's platform/instance-targets.ts rule: DIGBY_INSTANCE
 * unset, empty or 'prod' is production; anything else is a self-hosted /
 * edge build. Read at BUILD time by the server-rendered public site (the
 * (site) pages are static), so docker-compose.selfhost.yml passes it as a
 * frontend build arg as well as a runtime env. Production builds never set it,
 * so every call here answers false there.
 */
export function isSelfHostedBuild(env: Record<string, string | undefined> = process.env): boolean {
  const v = (env.DIGBY_INSTANCE || '').trim().toLowerCase();
  return v !== '' && v !== 'prod';
}

/** The served installers are production builds that sign into digby.example.com — a self-host hides their links. */
export function isInstallerHref(href: string): boolean {
  return /\.(dmg|exe)$/i.test(href);
}
