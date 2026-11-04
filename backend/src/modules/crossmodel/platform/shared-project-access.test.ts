/**
 * SHARED-PROJECT-DISPATCH (2026-10-20, ticket 22d667e7) — the pure rules for
 * a project MEMBER starting a lane: writer roles, role-naming refusals, the
 * member-spawn envelope note and the shared charter lookup.
 */
import {
  charterRowReadable,
  describeCallerRole,
  isWriterRole,
  lookupCharterRow,
  memberSpawnNote,
  spawnAccessRefusal,
  spawnMemberAccessDisabled,
} from './shared-project-access';

const ON: NodeJS.ProcessEnv = {};
const OFF: NodeJS.ProcessEnv = { SPAWN_MEMBER_ACCESS_DISABLED: '1' };

describe('spawnMemberAccessDisabled', () => {
  it('reads the kill switch (1 / true / on / yes)', () => {
    expect(spawnMemberAccessDisabled({})).toBe(false);
    expect(spawnMemberAccessDisabled({ SPAWN_MEMBER_ACCESS_DISABLED: '1' })).toBe(true);
    expect(spawnMemberAccessDisabled({ SPAWN_MEMBER_ACCESS_DISABLED: 'true' })).toBe(true);
    expect(spawnMemberAccessDisabled({ SPAWN_MEMBER_ACCESS_DISABLED: '0' })).toBe(false);
  });
});

describe('isWriterRole', () => {
  it('owner / admin / editor may start a lane; a viewer or no role never', () => {
    expect(isWriterRole('owner')).toBe(true);
    expect(isWriterRole('admin')).toBe(true);
    expect(isWriterRole('editor')).toBe(true);
    expect(isWriterRole('viewer')).toBe(false);
    expect(isWriterRole(null)).toBe(false);
    expect(isWriterRole(undefined)).toBe(false);
  });
});

describe('spawnAccessRefusal — every refusal names the caller role', () => {
  it('a viewer is told it is read-only and who can start lanes', () => {
    const t = spawnAccessRefusal({ projectId: 'p-1', role: 'viewer' });
    expect(t).toContain('viewer (read-only member)');
    expect(t).toMatch(/only the owner, an admin or an editor/);
    expect(t).not.toMatch(/not found/i);
  });

  it('a member under the kill switch is told the switch is off (and its role)', () => {
    const t = spawnAccessRefusal({ projectId: 'p-1', role: 'editor', memberAccessDisabled: true });
    expect(t).toContain('editor (member)');
    expect(t).toContain('SPAWN_MEMBER_ACCESS_DISABLED=1');
  });

  it('no role keeps the existence-safe "not found or no access" wording (the tool 404 recovery keys on it) and names role none', () => {
    const t = spawnAccessRefusal({ projectId: 'p-1', role: null });
    expect(t).toMatch(/^Project not found or no access/);
    expect(t).toContain('p-1');
    expect(t).toContain(describeCallerRole(null));
  });
});

describe('memberSpawnNote', () => {
  it('says the session runs as the project owner, spend + quota are the owner\'s, and the start is audited', () => {
    const t = memberSpawnNote({ role: 'editor', ownerUserId: 'owner-123456789', projectId: 'p-1' });
    expect(t).toContain('editor (member)');
    expect(t).toContain('PROJECT OWNER');
    expect(t).toContain('owner-12');
    expect(t).toMatch(/spend and quota are the owner's/);
    expect(t).toMatch(/audited/);
  });
});

describe('charterRowReadable', () => {
  const row = { userId: 'owner', projectId: 'p-1' };
  it('the row owner always reads it', () => {
    expect(charterRowReadable(row, 'owner', null, OFF)).toBe(true);
  });
  it('a member with ANY role reads it (member access on); no role never', () => {
    expect(charterRowReadable(row, 'member', 'viewer', ON)).toBe(true);
    expect(charterRowReadable(row, 'member', 'editor', ON)).toBe(true);
    expect(charterRowReadable(row, 'member', null, ON)).toBe(false);
  });
  it('the kill switch restores owner-only', () => {
    expect(charterRowReadable(row, 'member', 'editor', OFF)).toBe(false);
  });
  it('a missing row is never readable', () => {
    expect(charterRowReadable(null, 'owner', 'owner', ON)).toBe(false);
  });
});

describe('lookupCharterRow', () => {
  const ownerRow = { id: 'g-1', title: 'Goal', userId: 'owner', projectId: 'p-1' };

  it('an owner-scoped hit returns at once — no second read, no access lookup', async () => {
    const findById = jest.fn();
    const projectRole = jest.fn();
    const r = await lookupCharterRow({ findOwned: async () => ownerRow, findById, projectRole }, 'owner', ON);
    expect(r).toBe(ownerRow);
    expect(findById).not.toHaveBeenCalled();
    expect(projectRole).not.toHaveBeenCalled();
  });

  it('the ticket 22d667e7 shape: a member\'s own goal (stamped with the project owner) resolves by id + read access', async () => {
    const projectRole = jest.fn(async () => 'editor' as const);
    const r = await lookupCharterRow({ findOwned: async () => null, findById: async () => ownerRow, projectRole }, 'member', ON);
    expect(r).toBe(ownerRow);
    expect(projectRole).toHaveBeenCalledWith('p-1');
  });

  it('no role on the row\'s project ⇒ not found (existence never leaks)', async () => {
    const r = await lookupCharterRow({ findOwned: async () => null, findById: async () => ownerRow, projectRole: async () => null }, 'stranger', ON);
    expect(r).toBeNull();
  });

  it('kill switch ⇒ the caller-scoped lookup only', async () => {
    const findById = jest.fn(async () => ownerRow);
    const r = await lookupCharterRow({ findOwned: async () => null, findById, projectRole: async () => 'editor' as const }, 'member', OFF);
    expect(r).toBeNull();
    expect(findById).not.toHaveBeenCalled();
  });

  it('never throws — a read error is not found', async () => {
    const r = await lookupCharterRow({ findOwned: async () => { throw new Error('db down'); }, findById: async () => ownerRow, projectRole: async () => 'editor' as const }, 'member', ON);
    expect(r).toBeNull();
    const r2 = await lookupCharterRow({ findOwned: async () => null, findById: async () => ownerRow, projectRole: async () => { throw new Error('x'); } }, 'member', ON);
    expect(r2).toBeNull();
  });
});
