/**
 * Framework surface (ticket 9471d338) — frontend pins.
 *
 * THE OWNER REQUEST (2026-10-27): "remove the actual framework and digby/cross
 * model project out of the sidebar and only into the management as a tab
 * properly scaffolded so digby is scaffolded and hardened and not just another
 * project."
 *
 * Three layers pinned here:
 *  1. SIDEBAR — the chat page's visibleProjects filter drops the framework
 *     project by the server-stamped isFrameworkProject marker, WITH the
 *     fleetHidden belt still in place (defense in depth against an old
 *     backend), and every other exclusion preserved (regression).
 *  2. TAB — management/page.tsx wires a Framework tab (type union, TABS row,
 *     ?tab=framework deep link, render branch).
 *  3. SURFACE — FrameworkSurface renders the live snapshot (chats/lanes with
 *     status + deep links, goal board, workspace + backlog pointer) and its
 *     loading / error / no-project / hardened states, with NO rename/move/
 *     delete/share affordances anywhere in the file (the API refuses them;
 *     the UI never offers them).
 */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';

// The component file imports the real API modules at module scope (browser
// axios client). Node-environment test: stub the transport so the import
// graph loads; the tests below render the PRESENTATIONAL core only.
vi.mock('@/lib/api-client', () => ({
  default: {
    get: vi.fn(async () => ({ data: {} })),
    post: vi.fn(async () => ({ data: {} })),
    interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } },
  },
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const readSrc = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

const PAGE = readSrc('../page.tsx');
const MGMT = readSrc('./page.tsx');
const TAB = readSrc('./FrameworkTab.tsx');
const API = readSrc('../../../lib/api/crossmodel.ts');

import { FrameworkSurface } from './FrameworkTab';

const baseSnapshot = (over: Record<string, unknown> = {}) => ({
  project: {
    id: 'p-fw',
    name: 'crossmodel',
    isFrameworkProject: true,
    isPublic: false,
    chatCount: 2,
    documentCount: 0,
    updatedAt: '2026-10-27T17:00:00.000Z',
  },
  sessions: [
    {
      chatId: 'chat-1',
      title: 'Framework Operator',
      goalHalf: 'framework ops',
      stepHalf: null,
      pinned: false,
      status: 'running',
      lastReceiptAgeSec: 42,
      spendTodayUsd: 0.4,
      goalId: 'g1',
      goalTitle: 'Framework hardening',
      todoCounts: { open: 2 },
      runs14d: 9,
      enabledSchedules: 1,
      isSupervisor: false,
      hasWorkspaceState: true,
      updatedAt: '2026-10-27T17:20:00.000Z',
      archivedAt: null,
    },
    {
      chatId: 'chat-2',
      title: 'Ticket lane',
      goalHalf: '',
      stepHalf: null,
      pinned: false,
      status: 'idle',
      lastReceiptAgeSec: null,
      spendTodayUsd: null,
      goalId: null,
      goalTitle: null,
      todoCounts: { open: 0 },
      runs14d: 3,
      enabledSchedules: 0,
      isSupervisor: false,
      hasWorkspaceState: false,
      updatedAt: '2026-10-26T10:00:00.000Z',
      archivedAt: null,
    },
  ],
  goals: [
    {
      goalId: 'g1',
      title: 'Framework hardening',
      status: 'active',
      todosDone: 3,
      todosTotal: 5,
      blockedCount: 1,
      completed24h: 1,
      completed7d: 3,
      eta: { remaining: 2, pacePerDay: 1.5, etaDays: 1.3, class: 'on_pace' },
    },
  ],
  workspace: { provider: 'github', repoUrl: 'https://github.com/canada-quant/digby', defaultBranch: 'main', provisioned: true, workspaceAt: '2026-10-01T00:00:00.000Z', knowledgeBranch: 'digby/knowledge' },
  digestGeneratedAt: '2026-10-27T17:00:00.000Z',
  ...over,
} as any);

const renderSurface = (over: { snapshot?: any; loading?: boolean; error?: string | null } = {}) =>
  renderToStaticMarkup(
    createElement(FrameworkSurface, {
      snapshot: over.snapshot === undefined ? baseSnapshot() : over.snapshot,
      loading: over.loading ?? false,
      error: over.error ?? null,
      onOpenChat: () => {},
      onRetry: () => {},
      onSyncWorkspace: () => {},
    }),
  );

describe('Framework surface — sidebar exclusion (page.tsx, ticket 9471d338)', () => {
  it('visibleProjects drops the framework project by the server-stamped marker', () => {
    const region = PAGE.slice(PAGE.indexOf('const visibleProjects'), PAGE.indexOf('const visibleProjects') + 400);
    expect(region).toContain('!p.isFrameworkProject');
    expect(region).toContain('!p.isUserSpace');
    expect(region).toContain('!p.archivedAt');
  });

  it('the fleetHidden belt survives (defense in depth against an old backend)', () => {
    const region = PAGE.slice(PAGE.indexOf('const visibleProjects'), PAGE.indexOf('const visibleProjects') + 400);
    expect(region).toContain('!fleetHidden.projectIds.has(p.id)');
  });

  it('the Project type carries the isFrameworkProject marker', () => {
    expect(API).toContain('isFrameworkProject?: boolean');
  });

  it('the comment names Management → Framework as the project home', () => {
    expect(PAGE).toContain('Management → Framework');
  });
});

describe('Framework surface — management tab wiring (management/page.tsx)', () => {
  it('a framework tab id exists in the Tab union and the TABS row', () => {
    expect(MGMT).toMatch(/type Tab = .*'framework'/);
    expect(MGMT).toContain("{ id: 'framework',  label: 'Framework',       icon: Bot           },");
  });

  it('?tab=framework deep-links into the tab', () => {
    expect(MGMT).toContain("tab === 'framework'");
  });

  it('the render branch mounts FrameworkTab', () => {
    expect(MGMT).toContain("{activeTab === 'framework'  && <FrameworkTab />}");
    expect(MGMT).toContain("import { FrameworkTab } from './FrameworkTab';");
  });
});

describe('FrameworkSurface — rendered states', () => {
  it('loading state renders the spinner line', () => {
    const html = renderSurface({ loading: true, snapshot: null });
    expect(html).toContain('Loading framework surface');
    expect(html).not.toContain('Platform surface');
  });

  it('error state renders the message + a retry affordance', () => {
    const html = renderSurface({ error: 'Network unreachable' });
    expect(html).toContain('Network unreachable');
    expect(html).toContain('Retry');
  });

  it('no framework project on the instance → honest empty state naming the repo, not an error', () => {
    const html = renderSurface({ snapshot: baseSnapshot({ project: null, sessions: [], goals: [], workspace: null, digestGeneratedAt: null }) });
    expect(html).toContain('No framework project on this instance');
    expect(html).toContain('canada-quant/digby');
    expect(html).toContain('User projects are unaffected');
  });

  it('the loaded surface shows the project, its repo + branch, and the backlog pointer', () => {
    const html = renderSurface();
    expect(html).toContain('crossmodel');
    expect(html).toContain('Platform surface');
    expect(html).toContain('https://github.com/canada-quant/digby');
    expect(html).toContain('main');
    expect(html).toContain('docs/FRAMEWORK_BACKLOG.md');
    expect(html).toContain('https://github.com/canada-quant/digby/blob/main/docs/FRAMEWORK_BACKLOG.md');
  });

  it('the goal board renders tracked goals with todos + blocked count + ETA', () => {
    const html = renderSurface();
    expect(html).toContain('Framework hardening');
    expect(html).toContain('3/5 todos done');
    expect(html).toContain('1 blocked');
    expect(html).toContain('ETA ~1.3d');
  });

  it('chats render with status badges and deep-link buttons carrying the chatId', () => {
    const html = renderSurface();
    expect(html).toContain('Framework Operator');
    expect(html).toContain('Ticket lane');
    expect(html).toContain('>Running<');
    expect(html).toContain('>Idle<');
    expect(html).toContain('goal: Framework hardening');
    expect(html).toContain('2 open todos');
  });

  it('empty sessions → the honest empty line (no crash, no fake rows)', () => {
    const html = renderSurface({ snapshot: baseSnapshot({ sessions: [] }) });
    expect(html).toContain('No chats filed in the framework project yet');
  });
});

describe('FrameworkSurface — hardening pins (no user-project affordances)', () => {
  it('the only project-API calls the surface makes are reads + knowledge sync', () => {
    // Extract every projectsApi.<method>( reference in the tab file; the set
    // must be exactly the read surface + sync (a rename/delete/archive/share
    // affordance would have to call something else).
    const calls = [...TAB.matchAll(/projectsApi\.([a-zA-Z]+)\(/g)].map((m) => m[1]);
    expect([...new Set(calls)].sort()).toEqual(['getWorkspace', 'list', 'sessions', 'syncWorkspace']);
  });

  it('the only write affordance offered in the UI is the knowledge sync button', () => {
    expect(TAB).toContain('Sync knowledge');
    expect(TAB).toContain('onSyncWorkspace');
  });

  it('states its hardened contract in the UI copy', () => {
    expect(TAB).toContain('cannot be renamed, moved, deleted, archived, shared');
  });

  it('deep-links chats through the chat route (?chatId=), never a project page', () => {
    expect(TAB).toContain('/crossmodel?chatId=');
    expect(TAB).not.toContain('/projects/');
  });
});
