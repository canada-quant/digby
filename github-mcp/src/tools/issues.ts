import { Octokit } from '@octokit/rest';

export async function githubListIssues(
  token: string,
  owner: string,
  repo: string,
  state: 'open' | 'closed' | 'all' = 'open',
  perPage: number = 10,
): Promise<string> {
  try {
    const octokit = new Octokit({ auth: token });
    const { data } = await octokit.issues.listForRepo({
      owner,
      repo,
      state,
      per_page: Math.min(perPage, 30),
    });

    if (data.length === 0) {
      return `No ${state} issues found in ${owner}/${repo}.`;
    }

    const lines = [`# Issues in ${owner}/${repo} [${state.toUpperCase()}]\n`, `Total: ${data.length} issue(s)\n`];
    for (const issue of data) {
      if (issue.pull_request) continue;
      const labels = issue.labels.map((l: any) => l.name).join(', ');
      const assignees = (issue.assignees ?? []).map((a: any) => a.login).join(', ') || 'unassigned';
      lines.push(
        `## #${issue.number}: ${issue.title}`,
        `  State: ${issue.state} | Author: ${issue.user?.login} | Assignees: ${assignees}`,
        `  Labels: ${labels || 'none'}`,
        `  Created: ${new Date(issue.created_at).toISOString().split('T')[0]} | Updated: ${new Date(issue.updated_at).toISOString().split('T')[0]}`,
        `  URL: ${issue.html_url}`,
        '',
      );
    }
    return lines.join('\n');
  } catch (err: any) {
    console.error('[githubListIssues]', err.message);
    return `Error listing issues: ${err.message}`;
  }
}

export async function githubCreateIssue(
  token: string,
  owner: string,
  repo: string,
  title: string,
  body?: string,
  labels?: string[],
): Promise<string> {
  try {
    const octokit = new Octokit({ auth: token });
    const { data } = await octokit.issues.create({
      owner,
      repo,
      title,
      body: body || '',
      labels: labels || [],
    });
    return `Issue created successfully!\n\n#${data.number}: ${data.title}\nURL: ${data.html_url}\nState: ${data.state}`;
  } catch (err: any) {
    console.error('[githubCreateIssue]', err.message);
    return `Error creating issue: ${err.message}`;
  }
}

export async function githubGetIssue(
  token: string,
  owner: string,
  repo: string,
  issue_number: number,
): Promise<string> {
  try {
    const octokit = new Octokit({ auth: token });
    const { data } = await octokit.issues.get({ owner, repo, issue_number });
    const labels = data.labels.map((l: any) => l.name).join(', ') || 'none';
    const assignees = (data.assignees ?? []).map((a: any) => a.login).join(', ') || 'unassigned';
    const lines = [
      `# #${data.number}: ${data.title}`,
      '',
      `**State:** ${data.state}  **Author:** ${data.user?.login}`,
      `**Assignees:** ${assignees}`,
      `**Labels:** ${labels}`,
      '',
      `**Created:** ${new Date(data.created_at).toISOString()}  **Updated:** ${new Date(data.updated_at).toISOString()}`,
      '',
      `**URL:** ${data.html_url}`,
      '',
      `## Body`,
      data.body || '(no description)',
      '',
    ];
    if (data.comments > 0) {
      lines.push(`**Comments:** ${data.comments}`, '');
    }
    return lines.join('\n');
  } catch (err: any) {
    console.error('[githubGetIssue]', err.message);
    return `Error getting issue #${issue_number}: ${err.message}`;
  }
}