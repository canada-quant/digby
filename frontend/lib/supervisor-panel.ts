/**
 * Which supervisor dashboard a chat's side panel leads with (owner 2026-10-08: "project supervisor chats on the
 * sidebar dont show the projects overview and schedules … goals sessions working on todos cost and token usage …
 * build out a special sidebar specifically for project supervisors? and then also a special sidebar for the fleet
 * supervisor"). A Fleet Supervisor chat (isSupervisor) gets the Fleet panel; a project supervisor chat
 * (isProjectSupervisor + its projectId) gets that project's panel — first in the side panel and opened by default.
 * Every other chat is unchanged. Rendering: app/crossmodel/components/supervisor-panel/*.
 */

export type SupervisorPanelKind = 'project' | 'fleet';
export interface SupervisorPanelTarget { kind: SupervisorPanelKind; projectId: string | null }

export function supervisorPanelFor(chat: { isSupervisor?: boolean | null; isProjectSupervisor?: boolean | null; projectId?: string | null } | null | undefined): SupervisorPanelTarget | null {
  if (!chat) return null;
  if (chat.isSupervisor) return { kind: 'fleet', projectId: chat.projectId ?? null };
  if (chat.isProjectSupervisor && chat.projectId) return { kind: 'project', projectId: chat.projectId };
  return null;
}
