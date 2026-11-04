/**
 * Account → Coding — seats govern sessions (2026-09-28). Source-level pins (the
 * repo's idiom for effectful components — CodingTab fetches in effects, so a full
 * render only shows the spinner): the tab reads the backend's explicit-pick flag
 * + the live Workspace default seat, renders "Following the admin seat (<model>)"
 * with a "Choose my own" affordance when the user has no explicit pick, folds the
 * picker behind it, offers "Use the workspace default instead" when a pick is set
 * (saves codingModel '' — the clear), never highlights an implicit value, and
 * tolerates a pre-change backend (flag absent → picker shown as before).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const readSrc = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const TAB = readSrc('./CodingTab.tsx');
const API = readSrc('../../../lib/api/crossmodel.ts');

describe('CodingTab — Following the admin seat (2026-09-28)', () => {
  it('reads codingModelExplicit + codingSeatModel from GET /preferences (absent flag = picker shown, pre-change backend)', () => {
    expect(TAB).toContain("setModelExplicit(p.codingModelExplicit === undefined ? true : p.codingModelExplicit === true);");
    expect(TAB).toContain("setSeatModel(typeof p.codingSeatModel === 'string' ? displayModelId(p.codingSeatModel) : '');");
    expect(API).toContain('codingModelExplicit?: boolean;');
    expect(API).toContain('codingSeatModel?: string;');
  });

  it('renders the "Following the admin seat (<model>)" card with "Choose my own" when there is no explicit pick, and folds the picker behind it', () => {
    expect(TAB).toContain('data-testid="coding-model-following-seat"');
    expect(TAB).toContain("Following the admin seat{seatModel ? ` (${seatModel})` : ''}");
    expect(TAB).toContain('data-testid="coding-model-choose-own"');
    expect(TAB).toContain('{(modelExplicit || choosingOwn) && MODELS.map(m => (');
    expect(TAB).toContain('{(modelExplicit || choosingOwn) && registryModels.length > 0 && (');
  });

  it('an explicit pick offers "Use the workspace default instead", which saves codingModel "" (the clear) and follows the seat', () => {
    expect(TAB).toContain('data-testid="coding-model-follow-seat"');
    expect(TAB).toContain("await preferencesApi.updateCoding({ codingModel: '' });");
    expect(TAB).toContain('setModelExplicit(false); setChoosingOwn(false);');
  });

  it('a pick made here is marked explicit client-side and the highlight never claims an implicit value', () => {
    expect(TAB).toContain('setModel(m); setModelExplicit(true);');
    expect(TAB).not.toMatch(/\n\s+model === m\.id \? 'border-brand-accent/);
    expect((TAB.match(/modelExplicit && model === m\.id/g) || []).length).toBe(4);
  });
});

// Dev container (tailnet) panel — routed to the coding server (2026-10-13).
describe('CodingTab — dev container panel (2026-10-13)', () => {
  const CODING_API = readSrc('../../../lib/api/coding.ts');

  it('renders from devContainerPanelView (state unknown / messages / login link only without a key)', () => {
    expect(TAB).toContain("import { devContainerPanelView } from '@/lib/dev-container-panel';");
    expect(TAB).toContain('const view = devContainerPanelView(dc);');
    expect(TAB).toContain('{view.containerState}');
    expect(TAB).toContain('{view.showLoginLink && dc.tailscale?.loginUrl && (');
    expect(TAB).not.toContain('click here to approve the node');
  });

  it('offers Reconnect (saved key, mid-run safe) beside Restart, wired to the new route', () => {
    expect(TAB).toContain('data-testid="dev-container-reconnect"');
    expect(TAB).toContain('disabled={dcBusy !== null || !view.reconnectEnabled}');
    expect(TAB).toContain('data-testid="dev-container-restart"');
    expect(CODING_API).toContain("apiClient.post('/crossmodel/coding/dev-container/tailnet/reconnect')");
  });

  it('a refused / unreachable action shows the server\'s reason and adopts the returned status', () => {
    expect(TAB).toContain('if (data?.data) setDc(data.data);');
    expect(TAB).toContain("toast.error(data?.error || (kind === 'restart' ? 'Restart failed' : 'Reconnect failed'));");
  });

  it('polls status while an action runs on the coding server, bounded', () => {
    expect(TAB).toContain("const dcActionRunning = dc?.action?.state === 'running';");
    expect(TAB).toContain('6 * 60_000');
    expect(TAB).toMatch(/setInterval\(\(\) => \{[\s\S]*?codingApi\.devContainerStatus\(\)\.then\(setDc\)/);
  });
});
