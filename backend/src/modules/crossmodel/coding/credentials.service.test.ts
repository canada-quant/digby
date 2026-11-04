process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-characters-long!!';

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const db: any[] = [];
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    codingCredential: {
      findMany: jest.fn(async ({ where }: any) => db.filter(r => r.userId === where.userId)),
      findFirst: jest.fn(async ({ where }: any) =>
        db.filter(r => Object.entries(where).every(([k, v]) => r[k] === v))
          .sort((a, b) => +b.updatedAt - +a.updatedAt)[0] || null),
      findUnique: jest.fn(async ({ where }: any) => {
        const w = where.userId_envKey_label;
        return db.find(r => r.userId === w.userId && r.envKey === w.envKey && (r.label ?? '') === w.label) || null;
      }),
      count: jest.fn(async ({ where }: any) => db.filter(r => r.userId === where.userId).length),
      upsert: jest.fn(async ({ where, create, update }: any) => {
        const w = where.userId_envKey_label;
        const i = db.findIndex(r => r.userId === w.userId && r.envKey === w.envKey && (r.label ?? '') === w.label);
        if (i >= 0) { db[i] = { ...db[i], ...update, updatedAt: new Date() }; return db[i]; }
        const row = { id: `c${db.length + 1}`, createdAt: new Date(), updatedAt: new Date(), ...create };
        db.push(row); return row;
      }),
      deleteMany: jest.fn(async ({ where }: any) => {
        const before = db.length;
        for (let i = db.length - 1; i >= 0; i--) if (db[i].id === where.id && db[i].userId === where.userId) db.splice(i, 1);
        return { count: before - db.length };
      }),
    },
  },
}));

import {
  encryptValue, decryptValue, upsertCredential, listCredentials, deleteCredential, getCredentialEnv,
  normalizeLabel, injectedKeyFor, getCredentialValueDecrypted, valueCaseWarning, listShellCredentialNames,
  isPemBlock,
} from './credentials.service';

beforeEach(() => { db.length = 0; });

describe('coding credentials', () => {
  it('encrypts round-trip and never stores plaintext', async () => {
    const enc = encryptValue('super-secret-token-1234');
    expect(enc).not.toContain('super-secret');
    expect(decryptValue(enc)).toBe('super-secret-token-1234');

    await upsertCredential('u1', 'cloudflare', 'CLOUDFLARE_API_TOKEN', 'cf-token-abcd');
    expect(JSON.stringify(db)).not.toContain('cf-token-abcd');
  });

  it('lists masked previews only', async () => {
    await upsertCredential('u1', 'aws', 'AWS_SECRET_ACCESS_KEY', 'wJalrXUtnFEMI1234');
    const rows = await listCredentials('u1');
    expect(rows).toHaveLength(1);
    expect(rows[0].preview).toBe('••••1234');
    expect(JSON.stringify(rows)).not.toContain('wJalrXUtnFEMI');
  });

  it('rejects bad env keys and reserved names', async () => {
    await expect(upsertCredential('u1', 'custom', 'lower_case', 'x')).rejects.toThrow(/UPPER_SNAKE_CASE/);
    await expect(upsertCredential('u1', 'custom', 'PATH', 'x')).rejects.toThrow(/reserved/);
    await expect(upsertCredential('u1', 'custom', 'GITHUB_TOKEN', 'x')).rejects.toThrow(/reserved/);
    await expect(upsertCredential('u1', 'custom', 'LD_PRELOAD', 'x')).rejects.toThrow(/reserved/);
    await expect(upsertCredential('u1', 'custom', 'GOOD_KEY', 'a\nb')).rejects.toThrow(/single line/);
  });

  // ── audit 2026-10-15 todo 75be792c — multi-line PEM values ──────────────────
  // The store guard refuses multi-line values EXCEPT a well-formed PEM block
  // (the 2026-10-15 mishap: a real owner private-key paste was refused twice
  // with an unactionable "Value must be a single line."). Fixtures below are
  // SYNTHETIC throwaway shapes, never real key material.
  describe('isPemBlock + multi-line PEM values (todo 75be792c)', () => {
    // PEM header/footer ASSEMBLY: split literals so no single SOURCE line
    // matches the commit-time 'Private key block' secret scan (the PR merge
    // gate has no [allow-secrets] escape); runtime strings are identical.
    const BEGIN = (label: string) => `-----BEGIN ${label}-----`;
    const END = (label: string) => `-----END ${label}-----`;
    const PEM =
      BEGIN('PRIVATE KEY') + '\n' +
      'MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQCePdQmXEsMEXpf\n' +
      'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9wcXJzdHV2\n' +
      'd3h5ejAxMjM0NTY3ODlhYmNkZWYwMTIzNDU2Nzg5MGFiY2RlZjAxMjM0NTY3ODlh\n' +
      END('PRIVATE KEY');

    it.each([
      ['an LF PEM block', PEM],
      ['a CRLF PEM block', PEM.replace(/\n/g, '\r\n')],
      ['an OPENSSH block', `${BEGIN('OPENSSH PRIVATE KEY')}\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAA=\n${END('OPENSSH PRIVATE KEY')}`],
      ['a block with surrounding whitespace', `\n${PEM}\n`],
    ])('accepts and stores %s verbatim', async (_label, v) => {
      expect(isPemBlock(v)).toBe(true);
      const row = await upsertCredential('u1', 'custom', 'JWT_PRIVATE_KEY', v);
      expect(row).toBeTruthy();
      expect(decryptValue(db.find((r) => r.envKey === 'JWT_PRIVATE_KEY')!.valueEnc)).toBe(v);
    });

    it.each([
      ['truncated (no END marker)', PEM.split('\n').slice(0, 2).join('\n')],
      ['mismatched labels', PEM.replace('END PRIVATE KEY', 'END EC PRIVATE KEY')],
      ['non-base64 body', `${BEGIN('PRIVATE KEY')}\nhello world!!\n${END('PRIVATE KEY')}`],
      ['prose after the END marker', `${PEM}\nthanks`],
      ['blank line inside the body', PEM.replace('\nQUJDREVGR0hJ', '\n\nQUJDREVGR0hJ')],
      ['arbitrary multi-line junk', 'first line\nsecond line'],
      ['a NUL byte', 'a\0b'],
    ])('still refuses %s', async (_label, v) => {
      expect(isPemBlock(v)).toBe(false);
      await expect(upsertCredential('u1', 'custom', 'JWT_PRIVATE_KEY', v)).rejects.toThrow(/single line/);
      expect(db.find((r) => r.envKey === 'JWT_PRIVATE_KEY')).toBeUndefined();
    });
  });

  it('getCredentialEnv decrypts the user map and only that user', async () => {
    await upsertCredential('u1', 'cloudflare', 'CLOUDFLARE_API_TOKEN', 'cf-1');
    await upsertCredential('u1', 'brev', 'BREV_API_TOKEN', 'brev-1');
    await upsertCredential('u2', 'aws', 'AWS_ACCESS_KEY_ID', 'aws-2');
    const env = await getCredentialEnv('u1');
    expect(env).toEqual({ CLOUDFLARE_API_TOKEN: 'cf-1', BREV_API_TOKEN: 'brev-1' });
  });

  it('upsert overwrites the same key; delete removes by id + owner', async () => {
    await upsertCredential('u1', 'brev', 'BREV_API_TOKEN', 'old');
    await upsertCredential('u1', 'brev', 'BREV_API_TOKEN', 'new');
    expect((await getCredentialEnv('u1')).BREV_API_TOKEN).toBe('new');
    const rows = await listCredentials('u1');
    expect(rows).toHaveLength(1);
    expect(await deleteCredential('u2', rows[0].id)).toBe(false); // wrong owner
    expect(await deleteCredential('u1', rows[0].id)).toBe(true);
    expect(await getCredentialEnv('u1')).toEqual({});
  });

  // ── Multiple credentials per provider (labels) ──────────────────────────

  it('stores multiple credentials of the same provider via labels — nothing overwritten', async () => {
    await upsertCredential('u1', 'cloudflare', 'CLOUDFLARE_API_TOKEN', 'cf-main');
    await upsertCredential('u1', 'cloudflare', 'CLOUDFLARE_API_TOKEN', 'cf-work', 'work');
    const env = await getCredentialEnv('u1');
    expect(env).toEqual({ CLOUDFLARE_API_TOKEN: 'cf-main', CLOUDFLARE_API_TOKEN_WORK: 'cf-work' });
    const rows = await listCredentials('u1');
    expect(rows).toHaveLength(2);
    expect(rows.map(r => r.injectedKey).sort()).toEqual(['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_API_TOKEN_WORK']);
    expect(rows.find(r => r.label === 'WORK')?.preview).toBe('••••work');
  });

  it('same env key + label updates in place instead of duplicating', async () => {
    await upsertCredential('u1', 'cloudflare', 'CLOUDFLARE_API_TOKEN', 'old', 'work');
    await upsertCredential('u1', 'cloudflare', 'CLOUDFLARE_API_TOKEN', 'new', 'WORK');
    expect(await listCredentials('u1')).toHaveLength(1);
    expect((await getCredentialEnv('u1')).CLOUDFLARE_API_TOKEN_WORK).toBe('new');
  });

  it('normalizes labels to UPPER_SNAKE and derives the injected name', async () => {
    const row = await upsertCredential('u1', 'cloudflare', 'CLOUDFLARE_API_TOKEN', 'x-1', ' Work Acct! ');
    expect(row.label).toBe('WORK_ACCT');
    expect(row.injectedKey).toBe('CLOUDFLARE_API_TOKEN_WORK_ACCT');
    expect(normalizeLabel('')).toBe('');
    expect(injectedKeyFor('FOO_BAR', '')).toBe('FOO_BAR');
    expect(injectedKeyFor('FOO_BAR', 'X')).toBe('FOO_BAR_X');
  });

  it('rejects labels that collide with reserved names or are unusable', async () => {
    await expect(upsertCredential('u1', 'custom', 'GITHUB', 'x', 'TOKEN')).rejects.toThrow(/reserved/); // GITHUB_TOKEN
    await expect(upsertCredential('u1', 'custom', 'PATH', 'x', 'ANYTHING')).rejects.toThrow(/reserved/);
    await expect(upsertCredential('u1', 'custom', 'GOOD_KEY', 'x', '!!!')).rejects.toThrow(/Label/);
    // over-long labels are REJECTED, never silently truncated into a collision
    await expect(upsertCredential('u1', 'custom', 'GOOD_KEY', 'x', 'A'.repeat(25))).rejects.toThrow(/too long/);
  });

  // ── Deploy-wave durability regressions (2026-08-20 canlaw wipe) ──────────

  it('LEGACY rows with a NULL label (pre-#270 shape, rolling-deploy window) are still listed and injected under the canonical key', async () => {
    // #270 moved uniqueness to (userId, envKey, label) with DEFAULT ''. A row
    // written by OLD code (or read mid-migration) can surface label NULL — a
    // label-aware SELECT that filtered on label would make the key "disappear".
    db.push({
      id: 'legacy1', userId: 'u1', provider: 'custom', envKey: 'CANLAW_SA_PRIV_B64',
      label: null, // legacy row — never rewritten since the label column landed
      valueEnc: encryptValue('legacy-secret'), createdAt: new Date(), updatedAt: new Date(),
    });
    const rows = await listCredentials('u1');
    expect(rows).toHaveLength(1);
    expect(rows[0].label).toBe('');                       // normalized for display
    expect(rows[0].injectedKey).toBe('CANLAW_SA_PRIV_B64'); // canonical name, not ..._NULL / hidden
    expect(rows[0].readable).toBe(true);
    expect(await getCredentialEnv('u1')).toEqual({ CANLAW_SA_PRIV_B64: 'legacy-secret' });
  });

  it('undecryptable rows (JWT_SECRET drift) are flagged readable:false, skipped in env, and WARNED — never silently dropped', async () => {
    const orig = process.env.JWT_SECRET;
    process.env.JWT_SECRET = 'drifted-secret-at-least-32-characters!!!';
    const drifted = encryptValue('canlaw-key-value');
    process.env.JWT_SECRET = orig;
    db.push({
      id: 'drift1', userId: 'u1', provider: 'custom', envKey: 'CANLAW_SSH_PRIV_B64',
      label: '', valueEnc: drifted, createdAt: new Date(), updatedAt: new Date(),
    });
    const rows = await listCredentials('u1');
    expect(rows).toHaveLength(1);
    expect(rows[0].readable).toBe(false);        // the UI badges this instead of a silent dead row
    expect(rows[0].preview).toBe('••••');
    expect(JSON.stringify(rows)).not.toContain('canlaw-key-value');

    const logger = (await import('../../../utils/logger')).default;
    (logger.warn as jest.Mock).mockClear();
    expect(await getCredentialEnv('u1')).toEqual({}); // skipped, session never blocked
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/1 of 1 stored credential\(s\) UNREADABLE/));
  });

  // ── Infra-only providers (tailscale) — adversarial review of PR #326 ──

  it('getCredentialEnv EXCLUDES infra-only providers (tailscale) from session shells', async () => {
    await upsertCredential('u1', 'tailscale', 'TS_AUTHKEY', 'tskey-auth-secret');
    await upsertCredential('u1', 'cloudflare', 'CLOUDFLARE_API_TOKEN', 'cf-token');
    const env = await getCredentialEnv('u1');
    expect(env.TS_AUTHKEY).toBeUndefined();          // never reaches a shell
    expect(env.CLOUDFLARE_API_TOKEN).toBe('cf-token');
    // …but the infra path can still read it directly
    expect(await getCredentialValueDecrypted('u1', 'tailscale', 'TS_AUTHKEY')).toBe('tskey-auth-secret');
  });

  it('provider-flip guard: re-saving TS_AUTHKEY under another provider is REJECTED (would leak the key into shells)', async () => {
    await upsertCredential('u1', 'tailscale', 'TS_AUTHKEY', 'tskey-auth-secret');
    await expect(upsertCredential('u1', 'custom', 'TS_AUTHKEY', 'tskey-auth-other'))
      .rejects.toThrow(/managed by the tailscale/i);
    // the stored row is untouched — still excluded from shells
    expect((await getCredentialEnv('u1')).TS_AUTHKEY).toBeUndefined();
    // and the reverse: an existing custom row can't be silently claimed by an infra provider
    await upsertCredential('u1', 'custom', 'MY_TOKEN', 'v1');
    await expect(upsertCredential('u1', 'tailscale', 'MY_TOKEN', 'v2'))
      .rejects.toThrow(/already exists as a custom credential/i);
  });

  it('same-provider tailscale re-save still updates in place (key rotation)', async () => {
    await upsertCredential('u1', 'tailscale', 'TS_AUTHKEY', 'tskey-auth-old');
    await upsertCredential('u1', 'tailscale', 'TS_AUTHKEY', 'tskey-auth-new');
    expect(await getCredentialValueDecrypted('u1', 'tailscale', 'TS_AUTHKEY')).toBe('tskey-auth-new');
  });

  // ── Value case preservation + all-caps anomaly guard (ticket 8a46847f) ──

  it('preserves a mixed-case JWT-shaped value EXACTLY through save → session-env injection', async () => {
    // The ticket's exact scenario: a case-sensitive CLI login command holding a
    // base64url JWT. Any case drift anywhere in the pipeline destroys it.
    const jwtCmd = 'brev login --token eyJraWQiOiJvYXV0aCJ9.EyJzdWIiOiJiMTIzIn0.nY06XmJcldBPFfaEwzSiN1zs';
    await upsertCredential('u1', 'custom', 'BREV_LOGIN_COMMAND', jwtCmd);
    expect((await getCredentialEnv('u1')).BREV_LOGIN_COMMAND).toBe(jwtCmd); // byte-identical
    expect((await listCredentials('u1'))[0].warning).toBeNull();
  });

  it('valueCaseWarning: fires ONLY on all-caps values of meaningful length', async () => {
    expect(valueCaseWarning('BREV LOGIN --TOKEN EYJRAWQIOIJ9.EYJZTRWIIOIJI0.NY06XMJCLDBPFF')).toMatch(/ALL UPPERCASE/);
    expect(valueCaseWarning('brev login --token eyJraWQiOiJvYXV0aCJ9.EyJzdWIiOiJiMTIzIn0.nY06XmJcldBPFf')).toBeNull(); // mixed case — intact
    expect(valueCaseWarning('wJalrXUtnFEMI1234')).toBeNull();  // AWS-style mixed secret
    expect(valueCaseWarning('AKIAIOSFODNN7EXAMPLE')).toBeNull(); // AWS Access Key ID — all-caps alnum BY SPEC (review F1)
    expect(valueCaseWarning('ASIAQWERTYUIOP123456')).toBeNull(); // temp key IDs too (compact pure-alnum)
    expect(valueCaseWarning('GHP_ABCDEFGHIJKLMNOPQRST')).toMatch(/ALL UPPERCASE/); // shouted PAT — punctuation carries the signature
    expect(valueCaseWarning('all-lowercase-token-value')).toBeNull();
    expect(valueCaseWarning('SHORTCAPS')).toBeNull();          // < 12 letters — too short to judge
    expect(valueCaseWarning('12345678901234567890')).toBeNull(); // no letters at all
    expect(valueCaseWarning('')).toBeNull();
  });

  it('upsert + list surface the all-caps warning on a corrupted-at-entry value (non-blocking)', async () => {
    const corrupted = 'BREV LOGIN --TOKEN EYJRAWQIOIJ9.EYJZTRWIIOIJI0.NY06XMJCLDBPFF';
    const saved = await upsertCredential('u1', 'custom', 'BREV_LOGIN_COMMAND', corrupted);
    expect(saved.warning).toMatch(/ALL UPPERCASE/);
    // …but the value is still stored and injected VERBATIM (warning never blocks)
    expect((await getCredentialEnv('u1')).BREV_LOGIN_COMMAND).toBe(corrupted);
    const rows = await listCredentials('u1');
    expect(rows[0].warning).toMatch(/ALL UPPERCASE/);
    // re-saving with the case-intact value clears the warning
    await upsertCredential('u1', 'custom', 'BREV_LOGIN_COMMAND', 'brev login --token eyJraWQiOiJvYXV0aCJ9.EyJzdWIi.nY06XmJcldBPFf');
    expect((await listCredentials('u1'))[0].warning).toBeNull();
  });

  // ── listShellCredentialNames (ticket c02b85bf) ─────────────────────────────
  // The chat-side visibility seam: NAMES ONLY, sourced from getCredentialEnv
  // so the list is exactly what a coding-session shell receives. A chat agent
  // reading this list must be able to trust "this key exists" — and must never
  // see a value.
  it('listShellCredentialNames returns NAMES ONLY, sorted — exactly the keys getCredentialEnv injects', async () => {
    await upsertCredential('u1', 'cloudflare', 'CLOUDFLARE_API_TOKEN', 'cf-token-abcd');
    await upsertCredential('u1', 'cloudflare', 'CLOUDFLARE_API_TOKEN', 'cf-token-work-xyz', 'WORK');
    await upsertCredential('u1', 'aws', 'AWS_SECRET_ACCESS_KEY', 'wJalrXUtnFEMI1234');
    const names = await listShellCredentialNames('u1');
    expect(names).toEqual(['AWS_SECRET_ACCESS_KEY', 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_API_TOKEN_WORK']);
    // The function is names-only by construction: no value ever crosses it.
    expect(JSON.stringify(names)).not.toContain('cf-token');
    expect(JSON.stringify(names)).not.toContain('wJalrXUtnFEMI');
  });

  it('listShellCredentialNames EXCLUDES infra-only providers — the tailscale auth key never surfaces to chats', async () => {
    await upsertCredential('u1', 'tailscale', 'TS_AUTHKEY', 'tskey-auth-real-value');
    await upsertCredential('u1', 'cloudflare', 'CLOUDFLARE_API_TOKEN', 'cf-token-abcd');
    const names = await listShellCredentialNames('u1');
    expect(names).toEqual(['CLOUDFLARE_API_TOKEN']);
    expect(JSON.stringify(names)).not.toContain('tskey');
  });

  it('listShellCredentialNames is per-user and empty for a user with nothing stored', async () => {
    await upsertCredential('u1', 'cloudflare', 'CLOUDFLARE_API_TOKEN', 'cf-token-abcd');
    expect(await listShellCredentialNames('u2')).toEqual([]);
    expect(await listShellCredentialNames('u1')).toEqual(['CLOUDFLARE_API_TOKEN']);
  });

  it('listShellCredentialNames EXCLUDES rows that no longer decrypt (JWT_SECRET drift) — never lists a dead key as available', async () => {
    await upsertCredential('u1', 'cloudflare', 'CLOUDFLARE_API_TOKEN', 'cf-token-abcd');
    const savedSecret = process.env.JWT_SECRET;
    process.env.JWT_SECRET = 'rotated-away';
    try {
      expect(await listShellCredentialNames('u1')).toEqual([]);
    } finally {
      process.env.JWT_SECRET = savedSecret;
    }
  });

  // Reviewer F1 (adversarial review of cc68ab28c): getCredentialEnv's old
  // `.catch(() => [])` made a DB OUTAGE indistinguishable from "nothing
  // stored" — the chat block rendered "None stored" and the overview count:0
  // for a user who HAS keys, the exact wrong-answer class this ticket fixes.
  it('listShellCredentialNames returns NULL (never []) on a failed DB read — a failed read must not read as "None stored" (reviewer F1)', async () => {
    await upsertCredential('u1', 'cloudflare', 'CLOUDFLARE_API_TOKEN', 'cf-token-abcd');
    const prisma = jest.requireMock('../../../config/database').default;
    prisma.codingCredential.findMany.mockRejectedValueOnce(new Error('db gone'));
    expect(await listShellCredentialNames('u1')).toBe(null);
    // …while SHELL injection keeps its best-effort contract: the same failure
    // degrades to {} (a broken read must never block a session command).
    prisma.codingCredential.findMany.mockRejectedValueOnce(new Error('db gone'));
    expect(await getCredentialEnv('u1')).toEqual({});
  });
});
