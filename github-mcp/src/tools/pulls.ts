import { Octokit } from '@octokit/rest';

export async function githubListPullRequests(
  token: string,
  owner: string,
  repo: string,
  state: 'open' | 'closed' | 'all' = 'open',
  perPage: number = 10,
): Promise<string> {
  try {
    const octokit = new Octokit({ auth: token });
    const { data } = await octokit.pulls.list({
      owner,
      repo,
      state,
      per_page: Math.min(perPage, 30),
    });

    if (data.length === 0) {
      return `No ${state} pull requests found in ${owner}/${repo}.`;
    }

    const lines = [`# Pull Requests in ${owner}/${repo} [${state.toUpperCase()}]\n`, `Total: ${data.length} PR(s)\n`];
    for (const pr of data as any[]) {
      const draftLabel = pr.draft ? ' [DRAFT]' : '';
      lines.push(
        `## #${pr.number}: ${pr.title}${draftLabel}`,
        `  Author: ${pr.user?.login} | Base: ${pr.base.ref} ← Head: ${pr.head.ref}`,
        `  State: ${pr.state}`,
        `  Created: ${new Date(pr.created_at).toISOString().split('T')[0]} | Updated: ${new Date(pr.updated_at).toISOString().split('T')[0]}`,
        `  URL: ${pr.html_url}`,
        '',
      );
    }
    return lines.join('\n');
  } catch (err: any) {
    console.error('[githubListPullRequests]', err.message);
    return `Error listing pull requests: ${err.message}`;
  }
}

export async function githubGetPullRequest(
  token: string,
  owner: string,
  repo: string,
  pull_number: number,
): Promise<string> {
  try {
    const octokit = new Octokit({ auth: token });
    const { data } = await octokit.pulls.get({ owner, repo, pull_number }) as any;
    const draftLabel = data.draft ? ' [DRAFT]' : '';
    const mergedLabel = data.merged ? ' ✅ MERGED' : '';
    const lines = [
      `# #${data.number}: ${data.title}${draftLabel}${mergedLabel}`,
      '',
      `**Author:** ${data.user?.login}`,
      `**Base:** ${data.base.ref}  **Head:** ${data.head.ref}`,
      `**State:** ${data.state}`,
      '',
      `**Created:** ${new Date(data.created_at).toISOString()}  **Updated:** ${new Date(data.updated_at).toISOString()}`,
      '',
      `**URL:** ${data.html_url}`,
      '',
    ];
    if (data.body) {
      lines.push('## Description', data.body, '');
    }
    if (data.labels && data.labels.length > 0) {
      lines.push(`**Labels:** ${data.labels.map((l: any) => l.name).join(', ')}`, '');
    }
    return lines.join('\n');
  } catch (err: any) {
    console.error('[githubGetPullRequest]', err.message);
    return `Error getting pull request #${pull_number}: ${err.message}`;
  }
}