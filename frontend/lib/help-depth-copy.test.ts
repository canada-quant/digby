/**
 * /help/depth copy pins (audit/research-rung-dig-deeper, 2026-09-26, finding
 * docs-drift-1). The served page frontend/content/help/depth.md is GENERATED
 * from docs/DEPTH_AND_DIG_DEEPER.md by scripts/sync-help-docs.mjs — never
 * hand-edited — so the twin must stay byte-identical, and the Dig-deeper copy
 * must describe what the harness does: the research council keeps running on
 * the tapper's own turn (it survives a closed tab) and posts a NEW "Deeper
 * findings" message. It is not a background job, and the client's own status
 * line (PROGRESS_KEY_TEXT) must not say so either.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PROGRESS_KEY_TEXT } from './depth-ux';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TWIN = path.resolve(HERE, '../content/help/depth.md');
const SOURCE = path.resolve(HERE, '../../docs/DEPTH_AND_DIG_DEEPER.md');
const norm = (s: string) => s.replace(/\s+/g, ' ');

describe('/help/depth — Dig deeper copy', () => {
  const twin = readFileSync(TWIN, 'utf8');

  it('says the council keeps working on this turn (close the tab), never "in the background"', () => {
    expect(norm(twin)).not.toMatch(/runs it in the background/);
    expect(norm(twin)).toMatch(/keeps working on this turn — you can navigate away or close the tab/);
    expect(twin).toContain('"Deeper findings"');
  });

  // The frontend Docker build context is frontend/ only; the source doc exists in a repo checkout.
  it.skipIf(!existsSync(SOURCE))('the served twin is byte-identical to docs/DEPTH_AND_DIG_DEEPER.md (run `npm run sync-help-docs`)', () => {
    expect(twin).toBe(readFileSync(SOURCE, 'utf8'));
  });

  it('the client status line for deeper_findings_started does not claim a background job', () => {
    expect(PROGRESS_KEY_TEXT.deeper_findings_started).not.toMatch(/background|detach|queue/i);
    expect(PROGRESS_KEY_TEXT.deeper_findings_started).toMatch(/new message/i);
  });
});
