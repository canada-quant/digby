#!/usr/bin/env node
/**
 * sync-help-docs — copies the CURATED ALLOWLIST of user/operator-facing docs
 * from the repo (docs/, macos-app/, imessage-agent/) into frontend/content/help/
 * and writes manifest.json (slug, title, description, category, source,
 * filename, headings) that the /help route renders.
 *
 * Why committed copies: the frontend Docker build context is frontend/ only
 * (see frontend/Dockerfile `COPY . .`), so repo-root docs/ is unavailable at
 * image build time. Generated-but-committed is the accepted pattern — re-run
 * this script whenever a source doc changes:
 *
 *   cd frontend && npm run sync-help-docs
 *
 * Internal ops runbooks (BACKUPS.md, REMOTE_OPS.md, fleet/incident notes…) are
 * deliberately NOT in the allowlist.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FRONTEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.resolve(FRONTEND_ROOT, '..');
const OUT_DIR = path.join(FRONTEND_ROOT, 'content', 'help');

/** @type {{source: string, slug: string, category: string, description: string}[]} */
const ALLOWLIST = [
  {
    source: 'docs/SELF_HOST.md',
    slug: 'self-host',
    category: 'Self-hosting & Digby Edge',
    description: 'Run the full Digby stack on your own machine or server with Docker Compose.',
  },
  {
    source: 'docs/DIGBY_EDGE_TESTING.md',
    slug: 'edge-testing',
    category: 'Self-hosting & Digby Edge',
    description: 'End-to-end testing guide for the cloud↔edge instance tunnel: pairing, presence, proxied browsing, and messaging.',
  },
  {
    source: 'docs/IMESSAGE_AGENT.md',
    slug: 'imessage-agent',
    category: 'iMessage & macOS',
    description: 'Architecture and runbook for the paired-Mac iMessage bridge (read/send iMessages, browser and screen control).',
  },
  {
    source: 'imessage-agent/README.md',
    slug: 'imessage-agent-install',
    category: 'iMessage & macOS',
    description: 'Install the Digby iMessage agent on your own Mac and pair it with your account.',
  },
  {
    source: 'macos-app/README.md',
    slug: 'macos-app',
    category: 'iMessage & macOS',
    description: 'The native Digby macOS desktop app — a signed WKWebView wrapper around digby.ai.',
  },
  {
    source: 'docs/DIGBY_MCP.md',
    slug: 'digby-mcp',
    category: 'Platform & Integrations',
    description: 'Drive the Digby platform as MCP tools from any MCP-capable client or agent.',
  },
  {
    source: 'docs/DIGBY_PLATFORM_API.md',
    slug: 'platform-api',
    category: 'Platform & Integrations',
    description: 'External REST API and scoped agent tokens for chats, coding sessions, schedules, and fleet automation.',
  },
  {
    source: 'docs/api-reference.md',
    slug: 'api-reference',
    category: 'Platform & Integrations',
    description: 'Backend REST API reference: authentication, chats, messages, and core endpoints.',
  },
  {
    source: 'docs/DEPTH_AND_DIG_DEEPER.md',
    slug: 'depth',
    category: 'Using Digby',
    description: 'How deep Digby thinks per message: the Checked / Updated pill, "Dig deeper", and why there is no depth setting (the old Advanced tab was removed 2026-10-27, ticket c99b404a).',
  },
  {
    source: 'docs/ASKING_BIGGER.md',
    slug: 'asking-bigger',
    category: 'Using Digby',
    description: 'Ask for the outcome, not the task: altitude, depth, and range — three ways to get more from every prompt, with a meta-prompt that upgrades any ask.',
  },
  {
    source: 'docs/GHOST_MODE.md',
    slug: 'ghost-mode',
    category: 'Using Digby',
    description: 'Per-conversation ghost mode: route a chat through the admin’s private endpoint and keep it out of memory and learning.',
  },
];

// GitHub-style heading slug (github-slugger parity: punctuation stripped,
// spaces → hyphens ONE-FOR-ONE) — keep in sync with the identical helper in
// frontend/lib/help-links.ts (both derive anchor ids from headings).
function slugifyHeading(text) {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/ /g, '-');
}

// Strip inline markdown (links, emphasis, code ticks) for the plain-text
// heading/search forms.
function plainText(md) {
  return md
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~]/g, '')
    .trim();
}

function extractTitle(markdown, fallback) {
  const m = markdown.match(/^#\s+(.+)$/m);
  return m ? plainText(m[1]) : fallback;
}

// h2/h3 headings outside code fences — powers the /help search index and
// deep links (/help/<slug>#<id>).
function extractHeadings(markdown) {
  const headings = [];
  let inFence = false;
  for (const line of markdown.split('\n')) {
    if (/^\s*```/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const m = line.match(/^(#{2,3})\s+(.+)$/);
    if (m) {
      const text = plainText(m[2]);
      headings.push({ depth: m[1].length, text, id: slugifyHeading(text) });
    }
  }
  return headings;
}

// Warn about relative .md links whose target is not in the allowlist — those
// render as plain (unlinked) text in the app, so the curator should notice.
function findUnresolvedDocLinks(markdown, selfSource, allowlistedSources) {
  const unresolved = [];
  const linkRe = /\]\(([^)\s]+)\)/g;
  let m;
  while ((m = linkRe.exec(markdown)) !== null) {
    const href = m[1].split('#')[0];
    if (!/\.md$/i.test(href)) continue;
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) continue; // external
    // Resolve against the source file's directory (same rule as the
    // /help renderer's rewriteDocHref in lib/help-links.ts).
    const base = path.posix.dirname(selfSource);
    const repoRel = href.startsWith('/')
      ? href.slice(1)
      : path.posix.normalize(path.posix.join(base, href));
    const asRepoRel = path.posix.normalize(href);
    if (!allowlistedSources.has(repoRel) && !allowlistedSources.has(asRepoRel)) {
      unresolved.push(href);
    }
  }
  return unresolved;
}

function main() {
  const allowlistedSources = new Set(ALLOWLIST.map((d) => d.source));
  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });

  const docs = [];
  let warned = false;
  for (const entry of ALLOWLIST) {
    const abs = path.join(REPO_ROOT, entry.source);
    let markdown;
    try {
      markdown = readFileSync(abs, 'utf8');
    } catch {
      console.error(`✗ missing source doc: ${entry.source}`);
      process.exitCode = 1;
      continue;
    }
    const filename = `${entry.slug}.md`;
    writeFileSync(path.join(OUT_DIR, filename), markdown);
    docs.push({
      slug: entry.slug,
      title: extractTitle(markdown, entry.slug),
      description: entry.description,
      category: entry.category,
      source: entry.source,
      filename,
      headings: extractHeadings(markdown),
    });
    for (const href of findUnresolvedDocLinks(markdown, entry.source, allowlistedSources)) {
      console.warn(`  ⚠ ${entry.source}: relative doc link not in allowlist (renders unlinked): ${href}`);
      warned = true;
    }
  }

  const manifest = { generatedAt: new Date().toISOString(), docs };
  writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`✓ synced ${docs.length} help docs → ${path.relative(REPO_ROOT, OUT_DIR)}/ (+ manifest.json)`);
  if (warned) console.log('  (warnings above are informational — unresolved .md links render as plain text)');
}

main();
