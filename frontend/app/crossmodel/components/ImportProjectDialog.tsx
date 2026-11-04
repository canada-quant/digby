'use client';

/**
 * Import a CODE project (GitHub repo picker · git URL · blank workspace).
 * Restored after the code-page retirement (audit 2026-07-16): the old
 * /crossmodel/code ImportDialog was the only creation UI for coding projects
 * and was deleted with that page. Opened from the New Project dialog.
 */

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { codingApi, CodingProject, GithubRepo } from '@/lib/api/coding';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { LoadErrorState } from '@/components/ui/load-error-state';
import { FolderGit2, Github, Loader2, Plus } from 'lucide-react';

type ImportTab = 'github' | 'url' | 'blank';

export default function ImportProjectDialog({ onClose, onImported }: {
  onClose: () => void;
  onImported: (p: CodingProject) => void;
}) {
  const [tab, setTab] = useState<ImportTab>('github');
  const [repos, setRepos] = useState<GithubRepo[]>([]);
  const [connected, setConnected] = useState(true);
  const [loading, setLoading] = useState(true);
  // A network/server error is NOT "GitHub not connected" — keep them distinct.
  const [loadError, setLoadError] = useState(false);
  const [manualUrl, setManualUrl] = useState('');
  const [blankName, setBlankName] = useState('');
  const [busy, setBusy] = useState(false);

  const loadRepos = () => {
    setLoading(true);
    setLoadError(false);
    codingApi.listGithubRepos()
      .then(r => { setConnected(r.connected); setRepos(r.repos); })
      .catch(() => setLoadError(true))
      .finally(() => setLoading(false));
  };
  useEffect(() => { loadRepos(); }, []);

  const importRepo = async (body: Parameters<typeof codingApi.importProject>[0]) => {
    setBusy(true);
    try { onImported(await codingApi.importProject(body)); }
    catch { toast.error('Import failed'); setBusy(false); }
  };

  return (
    <Dialog open onOpenChange={v => !v && onClose()}>
      <DialogContent className="max-w-lg max-h-[80vh] flex flex-col gap-0 p-0">
        <DialogHeader className="px-4 py-3 border-b border-border">
          <DialogTitle className="font-semibold text-sm flex items-center gap-2">
            <FolderGit2 className="size-4 text-ink-3" /> New code folder
          </DialogTitle>
        </DialogHeader>

        {/* Source tabs */}
        <div className="flex px-3 pt-3 gap-1 text-xs">
          {([['github', 'GitHub'], ['url', 'Git URL'], ['blank', 'Blank']] as [ImportTab, string][]).map(([id, label]) => (
            <button key={id} onClick={() => setTab(id)}
              className={cn('px-3 py-1.5 rounded-lg font-medium',
                tab === id ? 'bg-send text-send-ink' : 'text-muted-foreground hover:bg-muted')}>
              {label}
            </button>
          ))}
        </div>

        <div className="p-4 overflow-y-auto space-y-3">
          {tab === 'github' && (
            loading ? <div className="flex justify-center py-6"><Loader2 className="size-4 animate-spin" /></div>
              : loadError ? <LoadErrorState className="py-4" message="Couldn't load your GitHub repos." onRetry={loadRepos} />
              : !connected ? <p className="text-xs text-muted-foreground py-4 text-center">Connect GitHub in Settings → Integrations to list your repos, or use the Git URL / Blank tabs.</p>
              : repos.length === 0 ? <p className="text-xs text-muted-foreground py-4 text-center">No repositories found.</p>
              : (
                <div className="space-y-1">
                  {repos.map(r => (
                    <button key={r.fullName} disabled={busy}
                      onClick={() => importRepo({ repoUrl: r.cloneUrl, name: r.name, defaultBranch: r.defaultBranch, githubLabel: r.githubLabel, provider: 'github' })}
                      className="w-full text-left rounded-lg px-3 py-2 hover:bg-muted flex items-center gap-2 text-sm disabled:opacity-40">
                      <Github className="size-3.5 text-muted-foreground shrink-0" />
                      <span className="truncate flex-1">{r.fullName}</span>
                      {r.private && <span className="text-[10px] text-muted-foreground border border-border rounded px-1">private</span>}
                    </button>
                  ))}
                </div>
              )
          )}

          {tab === 'url' && (
            <div>
              <label className="text-xs text-muted-foreground">Any public https git URL</label>
              <Input value={manualUrl} onChange={e => setManualUrl(e.target.value)} placeholder="https://github.com/owner/repo.git"
                className="mt-1" />
              <Button disabled={busy || !manualUrl.trim()} onClick={() => importRepo({ repoUrl: manualUrl.trim(), provider: 'git' })}
                className="w-full mt-3 bg-send text-send-ink hover:opacity-90 gap-2">
                {busy ? <Loader2 className="size-4 animate-spin" /> : <>Import from URL</>}
              </Button>
            </div>
          )}

          {tab === 'blank' && (
            <div>
              <label className="text-xs text-muted-foreground">Folder name</label>
              <Input value={blankName} onChange={e => setBlankName(e.target.value)} placeholder="my-app"
                className="mt-1" />
              <p className="text-[11px] text-muted-foreground mt-2">Starts an empty git repo. Digby scaffolds an AGENTS.md so the agent codes with the right conventions from the first message.</p>
              <Button disabled={busy || !blankName.trim()} onClick={() => importRepo({ provider: 'blank', name: blankName.trim() })}
                className="w-full mt-3 bg-send text-send-ink hover:opacity-90 gap-2">
                {busy ? <Loader2 className="size-4 animate-spin" /> : <>Create blank folder</>}
              </Button>
            </div>
          )}
        </div>
        <div className="px-4 pb-3 pt-1 border-t border-border">
          <p className="text-[10px] text-muted-foreground/70 flex items-center gap-1"><Plus className="size-3" /> Code folders get an isolated git workspace — sessions branch, verify, push, and open PRs.</p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
