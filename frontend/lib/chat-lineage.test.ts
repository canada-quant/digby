import { describe, it, expect } from 'vitest';
import { groupChatsByParent, flattenChatGroups, type LineageChat } from './chat-lineage';

interface TChat extends LineageChat { title?: string }
const c = (id: string, parentChatId?: string | null): TChat => ({ id, parentChatId: parentChatId ?? null });

const ids = (groups: ReturnType<typeof groupChatsByParent<TChat>>) =>
  groups.map((g) => ({ id: g.chat.id, children: g.children.map((ch) => ch.id) }));

describe('groupChatsByParent', () => {
  it('groups children under their in-list parent, preserving root input order', () => {
    const list = [c('a'), c('a1', 'a'), c('b'), c('a2', 'a')];
    expect(ids(groupChatsByParent(list))).toEqual([
      { id: 'a', children: ['a1', 'a2'] },
      { id: 'b', children: [] },
    ]);
  });

  it('a child whose parent is NOT in the list renders flat (fallback contract)', () => {
    const list = [c('x'), c('orphan', 'gone-parent')];
    expect(ids(groupChatsByParent(list))).toEqual([
      { id: 'x', children: [] },
      { id: 'orphan', children: [] },
    ]);
  });

  it('children appearing BEFORE their parent in the input still nest under it', () => {
    // Lists arrive sorted by recency — an active child is often newer than its parent.
    const list = [c('a1', 'a'), c('b'), c('a')];
    expect(ids(groupChatsByParent(list))).toEqual([
      { id: 'b', children: [] },
      { id: 'a', children: ['a1'] },
    ]);
  });

  it('grandchildren attach to their nearest IN-LIST top ancestor (one indent level, nothing hidden)', () => {
    const list = [c('root'), c('child', 'root'), c('grandchild', 'child')];
    expect(ids(groupChatsByParent(list))).toEqual([
      { id: 'root', children: ['child', 'grandchild'] },
    ]);
  });

  it('a grandchild whose mid-parent is off-list nests under nothing (flat) unless an ancestor is present', () => {
    // 'child' absent: grandchild's parent is not in the list → flat row.
    const list = [c('root'), c('grandchild', 'child')];
    expect(ids(groupChatsByParent(list))).toEqual([
      { id: 'root', children: [] },
      { id: 'grandchild', children: [] },
    ]);
  });

  it('an empty list yields no groups; a flat list maps 1:1', () => {
    expect(groupChatsByParent<TChat>([])).toEqual([]);
    expect(ids(groupChatsByParent([c('a'), c('b')]))).toEqual([
      { id: 'a', children: [] },
      { id: 'b', children: [] },
    ]);
  });

  it('a lineage CYCLE (soft-ref pathology) degrades safely: every chat still renders', () => {
    const list = [c('a', 'b'), c('b', 'a'), c('z')];
    const flat = flattenChatGroups(groupChatsByParent(list), new Set());
    const rendered = flat.map((r) => r.chat.id).sort();
    expect(rendered).toEqual(['a', 'b', 'z']);
  });

  it('a self-parent chat renders as its own root', () => {
    const flat = flattenChatGroups(groupChatsByParent([c('a', 'a'), c('b')]), new Set());
    expect(flat.map((r) => r.chat.id)).toEqual(['a', 'b']);
    expect(flat.every((r) => !r.isChild)).toBe(true);
  });
});

describe('flattenChatGroups', () => {
  const list = [c('a'), c('a1', 'a'), c('a2', 'a'), c('b')];

  it('emits parent rows followed by indented child rows, with childCount on the parent', () => {
    const rows = flattenChatGroups(groupChatsByParent(list), new Set());
    expect(rows.map((r) => [r.chat.id, r.isChild, r.childCount])).toEqual([
      ['a', false, 2],
      ['a1', true, 0],
      ['a2', true, 0],
      ['b', false, 0],
    ]);
    expect(rows.every((r) => !r.collapsed)).toBe(true);
  });

  it('a COLLAPSED parent keeps its row (count shown) and hides its children', () => {
    const rows = flattenChatGroups(groupChatsByParent(list), new Set(['a']));
    expect(rows.map((r) => r.chat.id)).toEqual(['a', 'b']);
    expect(rows[0]).toMatchObject({ isChild: false, childCount: 2, collapsed: true });
  });

  it('collapse state on a CHILDLESS chat is inert (never marked collapsed)', () => {
    const rows = flattenChatGroups(groupChatsByParent(list), new Set(['b']));
    expect(rows.map((r) => r.chat.id)).toEqual(['a', 'a1', 'a2', 'b']);
    expect(rows.find((r) => r.chat.id === 'b')!.collapsed).toBe(false);
  });
});

/* ── 2026-10-20: preview over GROUPS — nesting is settled before the slice ── */
import { previewChatGroups, groupActivityMs } from './chat-lineage';

describe('previewChatGroups (folder preview taken over parent groups)', () => {
  const at = (h: number) => new Date(Date.UTC(2026, 9, 20, h)).toISOString();
  // Parent P1 is OLD (06:00); its child C1 is the NEWEST chat (12:00). Five
  // standalone chats sit in between — the flat newest-5 slice used to show C1
  // flat and leave P1 behind "Show more".
  const chats = [
    { id: 'c1', parentChatId: 'p1', updatedAt: at(12) },
    { id: 's1', updatedAt: at(11) },
    { id: 's2', updatedAt: at(10) },
    { id: 's3', updatedAt: at(9) },
    { id: 's4', updatedAt: at(8) },
    { id: 's5', updatedAt: at(7) },
    { id: 'p1', updatedAt: at(6) },
    { id: 's6', updatedAt: at(5) },
  ];

  it('a group sorts by its newest member, so a fresh child surfaces WITH its parent (nested, never flat)', () => {
    const groups = groupChatsByParent(chats);
    const p1 = groups.find((g) => g.chat.id === 'p1')!;
    expect(groupActivityMs(p1)).toBe(new Date(at(12)).getTime());
    const { visible, hiddenCount, overflow } = previewChatGroups(groups, () => false, 5);
    expect(visible.map((g) => g.chat.id)).toEqual(['p1', 's1', 's2', 's3', 's4']);
    expect(visible[0].children.map((c) => c.id)).toEqual(['c1']);
    expect(hiddenCount).toBe(2); // s5, s6 — the child is counted inside its group
    expect(overflow).toBe(true);
  });

  it('is deterministic across the fetch order: the same inputs give the same nesting with or without running ids', () => {
    const groups = groupChatsByParent(chats);
    const quiet = previewChatGroups(groups, () => false, 5).visible.map((g) => [g.chat.id, g.children.map((c) => c.id)]);
    const running = previewChatGroups(groups, (c) => c.id === 'c1', 5).visible.map((g) => [g.chat.id, g.children.map((c) => c.id)]);
    expect(running).toEqual(quiet); // c1's group is already first; pinning changes nothing
  });

  it('an active member pins its WHOLE group to the front and never counts against the limit', () => {
    const groups = groupChatsByParent(chats);
    const { visible } = previewChatGroups(groups, (c) => c.id === 's6', 2);
    expect(visible.map((g) => g.chat.id)).toEqual(['s6', 'p1']);
    const { visible: many } = previewChatGroups(groups, (c) => c.id === 's5' || c.id === 's6' || c.id === 'c1', 1);
    expect(many.map((g) => g.chat.id)).toEqual(['p1', 's5', 's6']);
  });

  it('showAll returns every group (activity-ordered) with nothing hidden; under the limit there is no overflow', () => {
    const groups = groupChatsByParent(chats);
    const all = previewChatGroups(groups, () => false, 5, true);
    expect(all.visible.length).toBe(7);
    expect(all.hiddenCount).toBe(0);
    expect(all.overflow).toBe(true);
    const small = previewChatGroups(groupChatsByParent(chats.slice(0, 3)), () => false, 5);
    expect(small.overflow).toBe(false);
    expect(small.hiddenCount).toBe(0);
  });
});

/* ── 2026-10-21: display parents — machine-spawned lanes nest under the folder's
 * Project Supervisor (server: platform/display-parent.ts) ─────────────────── */
import { nestParentId } from './chat-lineage';

describe('display parents (2026-10-21)', () => {
  // A lane row as the sidebar holds it: real parent (maybe none / off-list) + display parent.
  const lane = (id: string, parentChatId: string | null, displayParentChatId: string | null): TChat & { displayParentChatId?: string | null } =>
    ({ id, parentChatId, displayParentChatId });
  const ps = c('ps-daee2916');

  it('a parentless ticket lane nests under the folder supervisor', () => {
    const list = [ps, lane('ticket-b839643b', null, 'ps-daee2916'), lane('family-4e2d280b', null, 'ps-daee2916')];
    expect(ids(groupChatsByParent(list))).toEqual([{ id: 'ps-daee2916', children: ['ticket-b839643b', 'family-4e2d280b'] }]);
  });

  it('a Fleet-parented lane (the Fleet chat filtered out of the folder) falls back to the supervisor', () => {
    const list = [lane('spark-69fb25fc', 'fleet-c0e22e36', 'ps-590d604e'), c('ps-590d604e')];
    expect(ids(groupChatsByParent(list))).toEqual([{ id: 'ps-590d604e', children: ['spark-69fb25fc'] }]);
  });

  it("the real parent wins when it is in the list: a lane's own child stays under that lane's group", () => {
    const list = [ps, lane('lane-3af12528', null, 'ps-daee2916'), lane('review-4290107f', 'lane-3af12528', 'ps-daee2916')];
    const byId = new Map(list.map((x) => [x.id, x]));
    expect(nestParentId(list[2], byId)).toBe('lane-3af12528');
    // One indent level: the grandchild reaches the supervisor root THROUGH its lane.
    expect(ids(groupChatsByParent(list))).toEqual([{ id: 'ps-daee2916', children: ['lane-3af12528', 'review-4290107f'] }]);
  });

  it('a grandchild nests through a display parent even when its lane is the only link', () => {
    const list = [lane('child', 'lane', null), lane('lane', null, 'ps'), c('ps')];
    expect(ids(groupChatsByParent(list))).toEqual([{ id: 'ps', children: ['child', 'lane'] }]);
  });

  it('no parent and no display parent in the list → flat (fallback contract)', () => {
    const list = [lane('orphan', 'gone', 'ps-not-loaded'), c('x')];
    expect(ids(groupChatsByParent(list))).toEqual([
      { id: 'orphan', children: [] },
      { id: 'x', children: [] },
    ]);
  });

  it('a display parent absent (field missing — the server switch) keeps parentChatId-only nesting', () => {
    const list = [c('ps'), c('lane'), c('child', 'lane')];
    expect(ids(groupChatsByParent(list))).toEqual([
      { id: 'ps', children: [] },
      { id: 'lane', children: ['child'] },
    ]);
  });

  it('a display-parent CYCLE degrades safely: every chat renders exactly once', () => {
    const list = [lane('a', null, 'b'), lane('b', null, 'a'), c('z')];
    const flat = flattenChatGroups(groupChatsByParent(list), new Set());
    expect(flat.map((r) => r.chat.id).sort()).toEqual(['a', 'b', 'z']);
    expect(new Set(flat.map((r) => r.chat.id)).size).toBe(3);
  });

  it('nestParentId never returns a self-reference or an off-list id', () => {
    const self = lane('s', 's', 's');
    const byId = new Map([[self.id, self]]);
    expect(nestParentId(self, byId)).toBeNull();
    expect(nestParentId(lane('l', 'off', 'off2'), byId)).toBeNull();
  });
});

/* ── 2026-10-21 review fix: display parents must not defeat the folder preview
 * cap — once every lane nests under the Project Supervisor the folder is ONE
 * group, and a group used to render all of its children ─────────────────── */
describe('folder preview bounds display-attached children (2026-10-21 review fix)', () => {
  const at = (m: number) => new Date(Date.UTC(2026, 9, 21, 12, m)).toISOString();
  type Row = TChat & { displayParentChatId?: string | null; updatedAt?: string | null };
  // The PS + 12 machine-spawned lanes, newest first (the sidebar's input order).
  const folder = (stampDisplay: boolean): Row[] => [
    { id: 'ps', parentChatId: null, updatedAt: at(0) },
    ...Array.from({ length: 12 }, (_, i): Row => ({ id: `lane-${String(i).padStart(2, '0')}`, parentChatId: null, displayParentChatId: stampDisplay ? 'ps' : null, updatedAt: at(59 - i) })),
  ];
  const rowIds = (rows: Array<{ chat: Row }>) => rows.map((r) => r.chat.id);

  it('the reviewer repro: PS + 12 display lanes shows PS + 5 newest lanes, 7 behind "Show more"', () => {
    const flatBefore = previewChatGroups(groupChatsByParent(folder(false)), () => false, 5);
    expect(flatBefore.visible.length).toBe(5);
    expect(flatBefore.hiddenCount).toBe(8);

    const nested = previewChatGroups(groupChatsByParent(folder(true)), () => false, 5);
    expect(nested.visible.length).toBe(1);
    expect(nested.visible[0].children.map((c) => c.id)).toEqual(['lane-00', 'lane-01', 'lane-02', 'lane-03', 'lane-04']);
    expect(nested.visible[0].hiddenChildCount).toBe(7);
    expect(nested.hiddenCount).toBe(7);
    expect(nested.overflow).toBe(true); // the toggle stays
    const rows = flattenChatGroups(nested.visible, new Set());
    expect(rowIds(rows)).toEqual(['ps', 'lane-00', 'lane-01', 'lane-02', 'lane-03', 'lane-04']);
    expect(rows[0].childCount).toBe(12); // the chip names every sub-session
    expect(rows[rows.length - 1].moreChildren).toBe(7);
    expect(rows.slice(0, -1).every((r) => r.moreChildren === undefined)).toBe(true);
  });

  it('"Show more" (showAll) renders every lane untrimmed; "Show less" still has a reason to exist', () => {
    const all = previewChatGroups(groupChatsByParent(folder(true)), () => false, 5, true);
    expect(all.visible[0].children.length).toBe(12);
    expect(all.visible[0].hiddenChildCount).toBeUndefined();
    expect(all.hiddenCount).toBe(0);
    expect(all.overflow).toBe(true);
    expect(flattenChatGroups(all.visible, new Set()).some((r) => r.moreChildren)).toBe(false);
  });

  it('an active (open / running) lane is never hidden by the trim', () => {
    const nested = previewChatGroups(groupChatsByParent(folder(true)), (c) => c.id === 'lane-11' || c.id === 'lane-09', 5);
    const kept = nested.visible[0].children.map((c) => c.id);
    expect(kept).toContain('lane-11');
    expect(kept).toContain('lane-09');
    expect(kept.length).toBe(5);
    expect(nested.hiddenCount).toBe(7);
  });

  it('real-lineage children are never trimmed (unchanged behaviour)', () => {
    const real: Row[] = [{ id: 'ps', parentChatId: null, updatedAt: at(0) }, ...Array.from({ length: 12 }, (_, i): Row => ({ id: `kid-${i}`, parentChatId: 'ps', updatedAt: at(59 - i) }))];
    const r = previewChatGroups(groupChatsByParent(real), () => false, 5);
    expect(r.visible[0].children.length).toBe(12);
    expect(r.visible[0].displayChildIds).toBeUndefined();
    expect(r.hiddenCount).toBe(0);
    expect(r.overflow).toBe(false);
  });

  it('a mixed group keeps every real child and bounds only the display-attached ones', () => {
    const mixed: Row[] = [
      ...folder(true),
      { id: 'real-a', parentChatId: 'ps', updatedAt: at(1) },
      { id: 'real-b', parentChatId: 'ps', updatedAt: at(2) },
    ];
    const groups = groupChatsByParent(mixed);
    expect([...(groups[0].displayChildIds ?? [])].length).toBe(12);
    const r = previewChatGroups(groups, () => false, 5);
    const kept = r.visible[0].children.map((c) => c.id);
    expect(kept).toEqual(expect.arrayContaining(['real-a', 'real-b']));
    expect(kept.filter((id) => id.startsWith('lane-')).length).toBe(5);
    expect(r.hiddenCount).toBe(7);
  });

  it("a lane's own real child is display-attached (it reaches the root through the display hop)", () => {
    const list: Row[] = [{ id: 'ps', parentChatId: null }, { id: 'lane', parentChatId: null, displayParentChatId: 'ps' }, { id: 'review', parentChatId: 'lane' }];
    const [g] = groupChatsByParent(list);
    expect([...(g.displayChildIds ?? [])].sort()).toEqual(['lane', 'review']);
  });

  it('a collapsed trimmed group shows its full count and no "+N more" row', () => {
    const nested = previewChatGroups(groupChatsByParent(folder(true)), () => false, 5);
    const rows = flattenChatGroups(nested.visible, new Set(['ps']));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(expect.objectContaining({ childCount: 12, collapsed: true }));
    expect(rows[0].moreChildren).toBeUndefined();
  });
});
