import { Octokit } from '@octokit/rest';

export async function githubListRepos(
  token: string,
  sort?: 'created' | 'updated' | 'pushed' | 'full_name',
  perPage: number = 10,
  type?: 'all' | 'owner' | 'public' | 'private' | 'member',
): Promise<string> {
  try {
    const octokit = new Octokit({ auth: token });
    const { data } = await octokit.repos.listForAuthenticatedUser({
      sort: sort || 'updated',
      per_page: Math.min(perPage, 30),
      type: type || 'owner',
    });

    if (data.length === 0) {
      return 'No repositories found.';
    }

    const lines = ['# Your Repositories\n'];
    for (const repo of data) {
      const visibility = repo.private ? '🔒 private' : repo.fork ? '🍴 forked' : '🌐 public';
      lines.push(
        `## ${repo.full_name} ${visibility}`,
        `  Description: ${repo.description || '(none)'}`,
        `  URL: ${repo.html_url}`,
        `  Stars: ⭐ ${repo.stargazers_count} | Forks: ${repo.forks_count} | Watchers: ${repo.watchers_count}`,
        `  Language: ${repo.language || 'N/A'} | Size: ${(repo.size / 1024).toFixed(1)} MB`,
        `  Last updated: ${repo.updated_at ? new Date(repo.updated_at).toISOString().split('T')[0] : 'N/A'}`,
        '',
      );
    }
    lines.push(`\nTotal: ${data.length} repository(s)`);
    return lines.join('\n');
  } catch (err: any) {
    console.error('[githubListRepos]', err.message);
    return `Error listing repositories: ${err.message}`;
  }
}

export async function githubGetRepo(
  token: string,
  owner: string,
  repo: string,
): Promise<string> {
  try {
    const octokit = new Octokit({ auth: token });
    const { data } = await octokit.repos.get({ owner, repo });

    const visibility = data.private ? '🔒 private' : data.fork ? '🍴 forked' : '🌐 public';
    const lines = [
      `# ${data.full_name} ${visibility}`,
      '',
      `**Description:** ${data.description || '(none)'}`,
      '',
      `**URL:** ${data.html_url}`,
      '',
      `**Stars:** ⭐ ${data.stargazers_count}  **Forks:** ${data.forks_count}  **Watchers:** ${data.watchers_count}`,
      `**Language:** ${data.language || 'N/A'}  **Size:** ${(data.size / 1024).toFixed(1)} MB`,
      `**Open Issues:** ${data.open_issues_count}`,
      '',
      `**Created:** ${new Date(data.created_at).toISOString().split('T')[0]}  **Updated:** ${new Date(data.updated_at).toISOString().split('T')[0]}  **Pushed:** ${new Date(data.pushed_at as string).toISOString().split('T')[0]}`,
      '',
    ];

    if (data.homepage) {
      lines.push(`**Homepage:** ${data.homepage}`, '');
    }
    if (data.topics && data.topics.length > 0) {
      lines.push(`**Topics:** ${data.topics.join(', ')}`, '');
    }
    if (data.license) {
      lines.push(`**License:** ${data.license.name}`, '');
    }
    if (data.default_branch) {
      lines.push(`**Default branch:** ${data.default_branch}`, '');
    }

    return lines.join('\n').trim();
  } catch (err: any) {
    console.error('[githubGetRepo]', err.message);
    return `Error getting repository "${owner}/${repo}": ${err.message}`;
  }
}

export async function githubSearchRepos(
  token: string,
  query: string,
  perPage: number = 10,
): Promise<string> {
  try {
    const octokit = new Octokit({ auth: token });
    const { data } = await octokit.search.repos({
      q: query,
      per_page: Math.min(perPage, 30),
    });

    if (data.items.length === 0) {
      return `No repositories found matching: "${query}"`;
    }

    const lines = [`# Search Results for "${query}"\n`, `Total matches: ${data.total_count.toLocaleString()}\n`];
    for (const repo of data.items) {
      const visibility = repo.private ? '🔒 private' : '🌐 public';
      lines.push(
        `## ${repo.full_name} ${visibility}`,
        `  ${repo.description || '(no description)'}`,
        `  Stars: ⭐ ${repo.stargazers_count.toLocaleString()} | Forks: ${repo.forks_count.toLocaleString()} | Language: ${repo.language || 'N/A'}`,
        `  ${repo.html_url}`,
        '',
      );
    }
    lines.push(`\nShowing ${data.items.length} of ${data.total_count.toLocaleString()} total matches`);
    return lines.join('\n');
  } catch (err: any) {
    console.error('[githubSearchRepos]', err.message);
    return `Error searching repositories: ${err.message}`;
  }
}