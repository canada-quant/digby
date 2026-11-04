/**
 * REPLAY — mishap ticket 82dd8756 (3× store_secret failure streak).
 *
 * The live incident (session 59f14be2, run 3993ff0f): the owner pasted a
 * Cloudflare Account API Token (`cfat_` + 49 alphanumerics — the scannable
 * format Cloudflare introduced for credential scanners) as plain dashboard
 * prose, no `KEY=value` line. store_secret lifted the text through
 * findSecretSpans, NOTHING matched — SECRET_PATTERNS had no Cloudflare shape
 * and the assignment pattern needs a `key:` / `key=` label — so the model's
 * correct calls were refused no_secret_found three times (once with the exact
 * right fromMessageId), and the refusal even guessed the stored copy "may
 * already be redacted", which was false. Failure #1 of the streak
 * (invalid_label) was the model passing a 47-char label the schema never said
 * was capped at 24.
 *
 * Fix: the three documented Cloudflare scannable prefixes join SECRET_PATTERNS
 * (shared by the inbound redaction AND the commit-time diff scan), and the
 * store_secret schema now states the 24-char label cap.
 *
 * SYNTHETIC same-shape values only — never the owner's real token.
 */
import { extractSecretForHandoff } from './secret-handoff-tools';
import { findSecretSpans, scanTextForSecrets, SECRET_PATTERNS } from './secret-scan';

// credentials.service imports config/database → config/env (validates env and
// exits) — mock the db + logger exactly like secret-handoff-tools.test.ts.
jest.mock('../../../config/database', () => ({ __esModule: true, default: {} }));
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { normalizeLabel, SECRET_HANDOFF_TOOL_SCHEMA } = require('./secret-handoff-tools');


// cfat_ + 49 alphanumerics — same shape as the live paste, synthetic value
// (split so the commit-time secret gate never sees one contiguous literal).
const CFAT = 'cfat_' + 'SyntheticReplayTokenA0b1C2d3E4f5G6h7I8j9K0l1M2n3O4p5Q6';
// cfut_ + 40 alphanumerics + checksum — Cloudflare User API Token shape
const CFUT = 'cfut_' + 'SyntheticUserToken0a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6';
// cfk_ + 40 alphanumerics + checksum — Cloudflare Global API Key shape
const CFK = 'cfk_' + 'SyntheticGlobalKey0a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q';

/** The owner's dashboard-prose paste, replica shape (account id + token on its
 *  own line, no `KEY=value` anywhere) — the exact shape that was refused. */
const OWNER_PASTE_REPLICA = [
  'i have another one here - 0123456789abcdef0123456789abcdef',
  '',
  'Token created successfully',
  '',
  'synthetic-account',
  'Account ID',
  '0123456789abcdef0123456789abcdef',
  'Your API Token',
  CFAT,
  'S3 API endpoint',
  'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com',
  'Example Usage',
  '',
  `curl -H "Authorization: Bearer ${CFAT}" https://api.cloudflare.com/client/v4/`,
  '',
  'can you also add this as a secondary coding key in my coding settings',
].join('\n');

describe('82dd8756 — store_secret sees a pasted Cloudflare cfat_ token (the live mishap, replayed)', () => {
  it('REPLAY: extractSecretForHandoff lifts the cfat_ token out of the dashboard-prose paste (was no_secret_found ×3 live)', () => {
    const out = extractSecretForHandoff(OWNER_PASTE_REPLICA, 'CLOUDFLARE_API_TOKEN_2', null);
    expect(out).toEqual({ ok: true, value: CFAT, pattern: 'Cloudflare API token' });
  });

  it('the scanner finds the token even when the paste carries no KEY=value line (the live shape)', () => {
    expect(findSecretSpans(OWNER_PASTE_REPLICA).map((s) => s.name)).toContain('Cloudflare API token');
  });

  it('all three documented Cloudflare scannable prefixes match (cfk_ Global Key, cfut_ User Token, cfat_ Account Token)', () => {
    expect(scanTextForSecrets(`Bearer ${CFAT}`)).toEqual(['Cloudflare API token']);
    expect(scanTextForSecrets(CFUT)).toEqual(['Cloudflare API token']);
    expect(scanTextForSecrets(CFK)).toEqual(['Cloudflare API token']);
  });

  it('the shared pattern set (inbound redaction + the commit-time diff scan, coding/tools.ts scanDiffForSecrets iterates this set) both catch a leaked cfat_ token', () => {
    expect(SECRET_PATTERNS.some((p) => p.name === 'Cloudflare API token' && p.re.test(`TOKEN=${CFAT}`))).toBe(true);
  });

  it('short non-token words starting cf… never match (no false positives on prose)', () => {
    // 29 alnum after the prefix = below the 30-char floor; prose never matches.
    expect(scanTextForSecrets('cfk_ cfut_ cfat_ cfat_abc cfat_short cfk_12345678901234567890123456789')).toEqual([]);
    expect(scanTextForSecrets('the cfa tracker config uses cfull_ and cfauth_ prefixes')).toEqual([]);
  });
});

describe('82dd8756 — the invalid_label leg (failure #1): the schema states the cap the model could not see', () => {
  it('the store_secret schema warns that labels are normalized UPPER_SNAKE and capped at 24 chars', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const schema = require('./secret-handoff-tools').SECRET_HANDOFF_TOOL_SCHEMA;
    const label = schema[0].function.parameters.properties.label.description;
    expect(String(label)).toMatch(/24 chars/);
    expect(String(label)).toMatch(/refused/i);
  });

  it('normalizeLabel still refuses (never truncates) a 47-char label — the exact arg the model passed live', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { normalizeLabel } = require('../coding/credentials.service');
    expect(() => normalizeLabel('wild-tree-47dc account d0f772b70e9197546c2eaf00f2ea214f')).toThrow(/Label too long/);
    expect(normalizeLabel('wild-tree-47dc')).toBe('WILD_TREE_47DC'); // the retry the model then used
  });
});
