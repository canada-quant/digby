import { Octokit } from '@octokit/rest';

export async function githubSearchCode(
  token: string,
  query: string,
  perPage: number = 10,
): Promise<string> {
  try {
    const octokit = new Octokit({ auth: token });
    const { data } = await octokit.search.code({
      q: query,
      per_page: Math.min(perPage, 30),
    });

    if (data.items.length === 0) {
      return [
        `No code results found for: "${query}"`,
        `(GitHub's code-search index covers each repository's default branch only; forks are excluded unless the query includes fork:true, and some private repositories are not indexed at all. "No results" can therefore mean "not indexed", not just "no match" — for a known file path, use github_get_file_contents.)`,
      ].join('\n');
    }

    const lines = [
      `# Code Search Results for "${query}"\n`,
      `Total matches: ${data.total_count.toLocaleString()}\n`,
    ];
    for (const item of data.items) {
      lines.push(
        `## ${item.repository.full_name}`,
        `  File: ${item.path}`,
        `  ${item.html_url}`,
        '',
      );
    }
    lines.push(`\nShowing ${data.items.length} of ${data.total_count.toLocaleString()} matches`);
    return lines.join('\n');
  } catch (err: any) {
    console.error('[githubSearchCode]', err.message);
    return `Error searching code: ${err.message}`;
  }
}

export async function githubGetFileContents(
  token: string,
  owner: string,
  repo: string,
  path: string,
  ref?: string,
): Promise<string> {
  try {
    const octokit = new Octokit({ auth: token });
    const { data } = await octokit.repos.getContent({ owner, repo, path, ref });

    if (Array.isArray(data)) {
      const lines = [`# Contents of ${path} in ${owner}/${repo}\n`];
      for (const item of data) {
        lines.push(`${item.type === 'dir' ? '📁' : item.type === 'submodule' ? '🔗' : '📄'} ${item.name}${item.type === 'dir' ? '/' : ''}`);
      }
      return lines.join('\n');
    }

    if (data.type !== 'file') {
      return `Unsupported type: ${data.type} for path ${path}`;
    }

    const content = Buffer.from(data.content, 'base64').toString('utf-8');
    const lines = [
      `# ${path}`,
      `Repository: ${owner}/${repo}${ref ? ` | Ref: ${ref}` : ''}`,
      `Size: ${(data.size / 1024).toFixed(1)} KB | SHA: ${data.sha}`,
      '',
      '```',
      content,
      '```',
    ];
    return lines.join('\n');
  } catch (err: any) {
    console.error('[githubGetFileContents]', err.message);
    return `Error getting file ${path}: ${err.message}`;
  }
}

export async function githubCreateOrUpdateFile(
  token: string,
  owner: string,
  repo: string,
  path: string,
  message: string,
  content: string,
  branch?: string,
  sha?: string,
): Promise<string> {
  try {
    const octokit = new Octokit({ auth: token });
    const encodedContent = Buffer.from(content).toString('base64');
    const { data } = await octokit.repos.createOrUpdateFileContents({
      owner,
      repo,
      path,
      message,
      content: encodedContent,
      branch,
      sha,
    });
    return [
      `✅ File ${sha ? 'updated' : 'created'} successfully!`,
      `Path: ${path}`,
      `Commit: ${data.commit.sha}`,
      `URL: ${data.content?.html_url || 'N/A'}`,
    ].join('\n');
  } catch (err: any) {
    console.error('[githubCreateOrUpdateFile]', err.message);
    return `Error writing file ${path}: ${err.message}`;
  }
}

export async function githubGetUser(token: string): Promise<string> {
  try {
    const octokit = new Octokit({ auth: token });
    const { data } = await octokit.users.getAuthenticated();
    const lines = [
      `# ${data.login}`,
      '',
      `**Name:** ${data.name || 'N/A'}`,
      `**Bio:** ${data.bio || 'N/A'}`,
      `**Location:** ${data.location || 'N/A'}`,
      `**Blog:** ${data.blog || 'N/A'}`,
      '',
      `**Public repos:** ${data.public_repos}  **Public gists:** ${data.public_gists}`,
      `**Followers:** ${data.followers}  **Following:** ${data.following}`,
      '',
      `**GitHub:** ${data.html_url}`,
      `**Created:** ${new Date(data.created_at).toISOString().split('T')[0]}`,
    ];
    if (data.company) lines.push(`**Company:** ${data.company}`, '');
    if (data.twitter_username) lines.push(`**Twitter:** @${data.twitter_username}`, '');
    return lines.join('\n');
  } catch (err: any) {
    console.error('[githubGetUser]', err.message);
    return `Error getting authenticated user: ${err.message}`;
  }
}