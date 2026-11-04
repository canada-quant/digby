/**
 * Canvas (in-chat document file) type metadata — single source of truth (deduped from
 * CanvasPanel.tsx and files/page.tsx, keeping the dark-capable colour set).
 */
import { FileText, Code2, Globe, GitBranch } from 'lucide-react';

export const TYPE_ICONS = {
  document: FileText,
  code: Code2,
  html: Globe,
  mermaid: GitBranch,
};

export const TYPE_LABELS = {
  document: 'Document',
  code: 'Code',
  html: 'HTML',
  mermaid: 'Diagram',
};

export const TYPE_COLORS = {
  document: 'text-blue-600 bg-blue-50 dark:bg-blue-900/20 dark:text-blue-400 border-blue-200 dark:border-blue-800',
  code: 'text-emerald-600 bg-emerald-50 dark:bg-emerald-900/20 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800',
  html: 'text-orange-600 bg-orange-50 dark:bg-orange-900/20 dark:text-orange-400 border-orange-200 dark:border-orange-800',
  mermaid: 'text-violet-600 bg-violet-50 dark:bg-violet-900/20 dark:text-violet-400 border-violet-200 dark:border-violet-800',
};

/** File extension a canvas downloads / lists under (shared by CanvasPanel + ChatFilesSection). */
export function getFileExtension(type: string, language?: string | null): string {
  if (type === 'code') {
    const lang = (language || '').toLowerCase();
    const extMap: Record<string, string> = {
      typescript: 'ts', javascript: 'js', python: 'py', rust: 'rs',
      go: 'go', java: 'java', kotlin: 'kt', swift: 'swift',
      sql: 'sql', bash: 'sh', shell: 'sh', css: 'css',
      html: 'html', markdown: 'md', json: 'json', yaml: 'yml',
      c: 'c', cpp: 'cpp', csharp: 'cs', php: 'php', ruby: 'rb',
    };
    return extMap[lang] || 'txt';
  }
  if (type === 'html') return 'html';
  if (type === 'mermaid') return 'mmd';
  return 'md';
}

/** Title → safe lowercase filename stem. */
export function sanitizeFilename(title: string): string {
  return title.replace(/[^a-zA-Z0-9_\-. ]/g, '').replace(/\s+/g, '-').toLowerCase() || 'canvas';
}
