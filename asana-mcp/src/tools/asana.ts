import axios, { AxiosInstance } from 'axios';

const BASE_URL = 'https://app.asana.com/api/1.0';

function client(token: string): AxiosInstance {
  return axios.create({
    baseURL: BASE_URL,
    headers: { Authorization: `Bearer ${token}` },
    timeout: 15000,
  });
}

function errMessage(err: any): string {
  return err.response?.data?.errors?.[0]?.message || err.message;
}

async function resolveFirstWorkspace(api: AxiosInstance): Promise<string> {
  const { data } = await api.get('/users/me', { params: { opt_fields: 'workspaces.name' } });
  const workspaces = data.data?.workspaces || [];
  if (workspaces.length === 0) {
    throw new Error('No workspaces found for this user');
  }
  return workspaces[0].gid;
}

function formatTask(task: any): string {
  const lines: string[] = [];
  const status = task.completed ? '✅ completed' : '⬜ incomplete';
  lines.push(`## ${task.name || '(untitled)'} ${status}`);
  if (task.gid) {
    lines.push(`  ID: ${task.gid}`);
  }
  if (task.due_on) {
    lines.push(`  📅 Due: ${task.due_on}`);
  }
  if (task.assignee?.name) {
    lines.push(`  👤 Assignee: ${task.assignee.name}`);
  }
  const projects = (task.projects || []).map((p: any) => p.name).filter(Boolean);
  if (projects.length > 0) {
    lines.push(`  📁 Projects: ${projects.join(', ')}`);
  }
  return lines.join('\n');
}

/** Create a task (the write twin of the reads). projects/workspace default to the user's first workspace. */
export async function asanaCreateTask(token: string, input: { name: string; notes?: string; project?: string; workspace?: string; dueOn?: string; assignee?: string }): Promise<string> {
  try {
    const api = client(token);
    const workspace = input.workspace || (input.project ? undefined : await resolveFirstWorkspace(api));
    const data: Record<string, unknown> = { name: input.name };
    if (input.notes) data.notes = input.notes;
    if (input.project) data.projects = [input.project];
    if (workspace) data.workspace = workspace;
    if (input.dueOn) data.due_on = input.dueOn;
    if (input.assignee) data.assignee = input.assignee;
    const { data: res } = await api.post('/tasks', { data }, { params: { opt_fields: 'name,due_on,completed,assignee.name,projects.name,permalink_url' } });
    const t = res.data;
    return `Created task "${t.name}" — taskId ${t.gid}${t.permalink_url ? ` — ${t.permalink_url}` : ''}`;
  } catch (err: any) {
    console.error('[asanaCreateTask]', err.message);
    return `Error creating task: ${errMessage(err)}`;
  }
}

/** Update a task's name / notes / completed / due date. */
export async function asanaUpdateTask(token: string, taskId: string, input: { name?: string; notes?: string; completed?: boolean; dueOn?: string | null }): Promise<string> {
  try {
    const api = client(token);
    const data: Record<string, unknown> = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.notes !== undefined) data.notes = input.notes;
    if (input.completed !== undefined) data.completed = input.completed;
    if (input.dueOn !== undefined) data.due_on = input.dueOn;
    const { data: res } = await api.put(`/tasks/${taskId}`, { data }, { params: { opt_fields: 'name,due_on,completed,permalink_url' } });
    const t = res.data;
    return `Updated task "${t.name}" — taskId ${t.gid} — ${t.completed ? 'completed' : 'incomplete'}${t.due_on ? `, due ${t.due_on}` : ''}${t.permalink_url ? ` — ${t.permalink_url}` : ''}`;
  } catch (err: any) {
    console.error('[asanaUpdateTask]', err.message);
    return `Error updating task "${taskId}": ${errMessage(err)}`;
  }
}

export async function asanaGetUser(token: string): Promise<string> {
  try {
    const api = client(token);
    const { data } = await api.get('/users/me', {
      params: { opt_fields: 'name,email,workspaces.name' },
    });
    const user = data.data;

    const lines = [
      `# ${user.name || '(unknown)'}`,
      '',
      `**Email:** ${user.email || '(none)'}`,
      `**ID:** ${user.gid}`,
      '',
    ];

    const workspaces = user.workspaces || [];
    if (workspaces.length > 0) {
      lines.push('**Workspaces:**');
      for (const ws of workspaces) {
        lines.push(`  - ${ws.name} (${ws.gid})`);
      }
    } else {
      lines.push('**Workspaces:** (none)');
    }

    return lines.join('\n').trim();
  } catch (err: any) {
    console.error('[asanaGetUser]', err.message);
    return `Error getting user: ${errMessage(err)}`;
  }
}

export async function asanaListWorkspaces(token: string): Promise<string> {
  try {
    const api = client(token);
    const { data } = await api.get('/workspaces');
    const workspaces = data.data || [];

    if (workspaces.length === 0) {
      return 'No workspaces found.';
    }

    const lines = ['# Your Workspaces\n'];
    for (const ws of workspaces) {
      lines.push(`## ${ws.name || '(unnamed)'}`, `  ID: ${ws.gid}`, '');
    }
    lines.push(`\nTotal: ${workspaces.length} workspace(s)`);
    return lines.join('\n');
  } catch (err: any) {
    console.error('[asanaListWorkspaces]', err.message);
    return `Error listing workspaces: ${errMessage(err)}`;
  }
}

export async function asanaListProjects(token: string, workspace?: string): Promise<string> {
  try {
    const api = client(token);
    const workspaceGid = workspace || (await resolveFirstWorkspace(api));
    const { data } = await api.get('/projects', {
      params: { workspace: workspaceGid, opt_fields: 'name,archived' },
    });
    const projects = data.data || [];

    if (projects.length === 0) {
      return 'No projects found.';
    }

    const lines = ['# Projects\n'];
    for (const project of projects) {
      const state = project.archived ? '🗄️ archived' : '📂 active';
      lines.push(`## ${project.name || '(unnamed)'} ${state}`, `  ID: ${project.gid}`, '');
    }
    lines.push(`\nTotal: ${projects.length} project(s)`);
    return lines.join('\n');
  } catch (err: any) {
    console.error('[asanaListProjects]', err.message);
    return `Error listing projects: ${errMessage(err)}`;
  }
}

export async function asanaListMyTasks(token: string, workspace?: string): Promise<string> {
  try {
    const api = client(token);
    const workspaceGid = workspace || (await resolveFirstWorkspace(api));
    const { data } = await api.get('/tasks', {
      params: {
        assignee: 'me',
        workspace: workspaceGid,
        completed_since: 'now',
        opt_fields: 'name,due_on,completed,projects.name',
      },
    });
    const tasks = data.data || [];

    if (tasks.length === 0) {
      return 'No incomplete assigned tasks found.';
    }

    const lines = ['# My Tasks\n'];
    for (const task of tasks) {
      lines.push(formatTask(task), '');
    }
    lines.push(`\nTotal: ${tasks.length} task(s)`);
    return lines.join('\n');
  } catch (err: any) {
    console.error('[asanaListMyTasks]', err.message);
    return `Error listing my tasks: ${errMessage(err)}`;
  }
}

export async function asanaGetTask(token: string, taskId: string): Promise<string> {
  try {
    const api = client(token);
    const { data } = await api.get(`/tasks/${taskId}`, {
      params: { opt_fields: 'name,notes,due_on,completed,assignee.name,projects.name' },
    });
    const task = data.data;

    const status = task.completed ? '✅ completed' : '⬜ incomplete';
    const lines = [
      `# ${task.name || '(untitled)'} ${status}`,
      '',
      `**ID:** ${task.gid}`,
    ];
    if (task.due_on) {
      lines.push(`**📅 Due:** ${task.due_on}`);
    }
    if (task.assignee?.name) {
      lines.push(`**👤 Assignee:** ${task.assignee.name}`);
    }
    const projects = (task.projects || []).map((p: any) => p.name).filter(Boolean);
    if (projects.length > 0) {
      lines.push(`**📁 Projects:** ${projects.join(', ')}`);
    }
    lines.push('', `**Notes:**`, task.notes || '(none)');

    return lines.join('\n').trim();
  } catch (err: any) {
    console.error('[asanaGetTask]', err.message);
    return `Error getting task "${taskId}": ${errMessage(err)}`;
  }
}

export async function asanaSearchTasks(token: string, text: string, workspace?: string): Promise<string> {
  try {
    const api = client(token);
    const workspaceGid = workspace || (await resolveFirstWorkspace(api));
    const { data } = await api.get(`/workspaces/${workspaceGid}/tasks/search`, {
      params: { text, opt_fields: 'name,due_on,completed' },
    });
    const tasks = data.data || [];

    if (tasks.length === 0) {
      return `No tasks found matching: "${text}"`;
    }

    const lines = [`# Search Results for "${text}"\n`];
    for (const task of tasks) {
      lines.push(formatTask(task), '');
    }
    lines.push(`\nShowing ${tasks.length} match(es)`);
    return lines.join('\n');
  } catch (err: any) {
    console.error('[asanaSearchTasks]', err.message);
    return `Error searching tasks: ${errMessage(err)}`;
  }
}
