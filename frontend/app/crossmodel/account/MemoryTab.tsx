'use client';

import { useState, useEffect, useMemo } from 'react';
import { memoryApi } from '@/lib/api/crossmodel';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { LoadErrorState } from '@/components/ui/load-error-state';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia } from '@/components/ui/empty';
import { Textarea } from '@/components/ui/textarea';
import { toast } from 'sonner';
import {
  Plus, Pencil, Trash2, Check, X, Database, Search,
  ChevronDown, ChevronRight, User2, MapPin, Briefcase,
  Heart, Settings2, Sparkles,
  History,
} from 'lucide-react';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader,
  AlertDialogTitle, AlertDialogTrigger,
} from '@/components/ui/alert-dialog';

function displayValue(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v, null, 2);
  return String(v);
}

interface Category { id: string; label: string; icon: React.ElementType; keywords: string[] }

const CATEGORIES: Category[] = [
  { id: 'personal', label: 'Personal', icon: User2, keywords: ['name', 'age', 'birthday', 'birth', 'gender', 'language', 'personality', 'about', 'bio', 'nickname', 'pronoun'] },
  { id: 'location', label: 'Location & Time', icon: MapPin, keywords: ['location', 'city', 'country', 'timezone', 'address', 'region', 'state', 'zip', 'locale', 'time'] },
  { id: 'work', label: 'Work & Education', icon: Briefcase, keywords: ['work', 'job', 'role', 'company', 'occupation', 'profession', 'title', 'industry', 'school', 'education', 'university', 'degree', 'skill', 'tech', 'stack', 'programming', 'coding'] },
  { id: 'interests', label: 'Interests & Lifestyle', icon: Heart, keywords: ['interest', 'hobby', 'sport', 'music', 'movie', 'book', 'food', 'travel', 'pet', 'favorite', 'like', 'love', 'game', 'fitness', 'health', 'diet'] },
  { id: 'preferences', label: 'Preferences', icon: Settings2, keywords: ['prefer', 'style', 'tone', 'format', 'communication', 'setting', 'theme', 'mode', 'option'] },
];

/** Internal bookkeeping keys that live in the same UserMemory.facts blob but
 *  are not user-facing facts (ticket 8929d1ef) — mirrors the profile page's
 *  HIDDEN_FACT_KEYS (profile/page.tsx). `__`-prefixed keys are filtered
 *  separately in `visibleFactEntries` (memory-maintenance writes those). */
const HIDDEN_KEYS = new Set(['persona', 'persona_label', '__contextState']);

/** Ticket 8929d1ef: the USER-VISIBLE fact entries — internal bookkeeping
 *  (`__`-prefixed keys + persona/persona_label/__contextState) filtered out.
 *  Exported for the renderer test (the repo's pure-view vitest idiom). */
export function visibleFactEntries(facts: Record<string, unknown>): Array<[string, unknown]> {
  return Object.entries(facts).filter(([k]) => !k.startsWith('__') && !HIDDEN_KEYS.has(k));
}

function categorizeKey(key: string): string {
  const lower = key.toLowerCase();
  for (const cat of CATEGORIES) {
    if (cat.keywords.some(kw => lower.includes(kw))) return cat.id;
  }
  return 'other';
}

function FactRow({ factKey, value, editingKey, editingValue, onEdit, onEditChange, onSave, onCancel, onDelete }: {
  factKey: string; value: unknown; editingKey: string | null; editingValue: string;
  onEdit: (k: string, v: string) => void; onEditChange: (v: string) => void;
  onSave: () => void; onCancel: () => void; onDelete: () => void;
}) {
  const isEditing = editingKey === factKey;
  return (
    <div className="px-3 py-2">
      {isEditing ? (
        <div className="space-y-2">
          <p className="text-[12px] font-medium text-ink-3">{factKey}</p>
          <Textarea value={editingValue} onChange={e => onEditChange(e.target.value)}
            className="text-sm min-h-[60px]" autoFocus />
          <div className="flex gap-2">
            <Button size="sm" className="h-7 text-xs" onClick={onSave}>
              <Check className="size-3 mr-1" />Save
            </Button>
            <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={onCancel}>
              <X className="size-3 mr-1" />Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex items-start gap-2">
          <div className="flex-1 min-w-0">
            <p className="text-[12px] font-medium text-ink-3">{factKey}</p>
            <p className="text-sm mt-0.5 leading-snug whitespace-pre-wrap break-words">{displayValue(value)}</p>
          </div>
          <div className="flex gap-1 shrink-0">
            <button onClick={() => onEdit(factKey, displayValue(value))}
              className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors" title="Edit">
              <Pencil className="size-3" />
            </button>
            <button onClick={onDelete}
              className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-destructive transition-colors" title="Delete">
              <Trash2 className="size-3" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function MemoryTab() {
  const [facts, setFacts] = useState<Record<string, unknown>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [showAddForm, setShowAddForm] = useState(false);

  const loadFacts = () => {
    setLoading(true);
    memoryApi.getMemory()
      .then((f) => { setFacts(f); setLoadError(false); })
      // Honest failure — never render "No memory facts yet" over an errored fetch.
      .catch(() => setLoadError(true))
      .finally(() => setLoading(false));
  };
  useEffect(() => { loadFacts(); }, []);

  // 2026-09-15 memory-wipe recovery: rebuild MY memory from my own past
  // conversations (background job on the server; poll while it runs).
  const [rebuild, setRebuild] = useState<{ running: boolean; processed: number; total: number; factsBefore: number; factsAfter: number | null; error?: string } | null>(null);
  const [rebuildStarting, setRebuildStarting] = useState(false);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    const poll = async () => {
      try {
        const s = await memoryApi.rebuildStatus();
        if (stopped) return;
        if (s.status) {
          setRebuild({ running: s.running, processed: s.status.processed, total: s.status.total, factsBefore: s.status.factsBefore, factsAfter: s.status.factsAfter, error: s.status.error });
          if (s.running) { timer = setTimeout(poll, 4000); return; }
          if (s.status.finishedAt && Date.now() - new Date(s.status.finishedAt).getTime() < 60_000) loadFacts();
        }
      } catch { /* status is a convenience — never block the tab on it */ }
    };
    void poll();
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, [rebuildStarting]);

  const handleRebuild = async () => {
    setRebuildStarting(true);
    try {
      const r = await memoryApi.rebuildMemory();
      if (r.started) toast.success(r.message || `Rebuilding from ${r.total} past exchanges…`);
      else toast.message(r.message || 'Nothing to rebuild from yet.');
    } catch { toast.error("Couldn't start the rebuild"); }
    finally { setRebuildStarting(false); }
  };

  const entries = useMemo(
    // Ticket 8929d1ef: hide internal bookkeeping keys the memory system writes
    // into the same blob (`__rejections`, `__dream`, `persona_label`,
    // `__contextState`…) — they are NOT user facts, yet they rendered as
    // editable rows, inflated the "N facts" count, and let a user delete
    // persistent banned-topic state. Same convention the profile page uses
    // (HIDDEN_FACT_KEYS + `!key.startsWith('__')`, profile/page.tsx).
    () => visibleFactEntries(facts),
    [facts],
  );

  const filtered = useMemo(() => {
    if (!searchQuery.trim()) return entries;
    const q = searchQuery.toLowerCase();
    return entries.filter(([k, v]) => k.toLowerCase().includes(q) || displayValue(v).toLowerCase().includes(q));
  }, [entries, searchQuery]);

  const orderedGroups = useMemo(() => {
    const groups: Record<string, [string, unknown][]> = {};
    for (const e of filtered) { const c = categorizeKey(e[0]); (groups[c] ??= []).push(e); }
    const result: { id: string; label: string; icon: React.ElementType; items: [string, unknown][] }[] = [];
    for (const cat of CATEGORIES) { if (groups[cat.id]?.length) result.push({ ...cat, items: groups[cat.id] }); }
    if (groups['other']?.length) result.push({ id: 'other', label: 'Other', icon: Sparkles, items: groups['other'] });
    return result;
  }, [filtered]);

  const toggle = (id: string) => setCollapsed(p => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const handleAdd = async () => {
    if (!newKey.trim() || !newValue.trim()) return;
    try {
      await memoryApi.updateFact(newKey.trim(), newValue.trim());
      setFacts(prev => ({ ...prev, [newKey.trim()]: newValue.trim() }));
      setNewKey(''); setNewValue(''); setShowAddForm(false);
      toast.success('Fact saved');
    } catch { toast.error('Failed to save fact'); }
  };

  const handleUpdate = async (key: string) => {
    if (!editingValue.trim()) return;
    try {
      await memoryApi.updateFact(key, editingValue.trim());
      setFacts(prev => ({ ...prev, [key]: editingValue.trim() }));
      setEditingKey(null);
      toast.success('Fact updated');
    } catch { toast.error('Failed to update fact'); }
  };

  const handleDelete = async (key: string) => {
    try {
      await memoryApi.deleteFact(key);
      setFacts(prev => { const n = { ...prev }; delete n[key]; return n; });
      toast.success(`"${key}" deleted`);
    } catch { toast.error('Failed to delete fact'); }
  };

  const handleClear = async () => {
    try {
      await memoryApi.clearMemory();
      setFacts({});
      toast.success('All memory cleared');
    } catch { toast.error('Failed to clear memory'); }
  };

  if (loading) {
    return (
      <div className="flex justify-center py-10">
        <Spinner className="size-5 text-brand-accent" />
      </div>
    );
  }

  if (loadError) {
    return <LoadErrorState message="Couldn't load your memory facts." onRetry={loadFacts} />;
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold mb-1">AI Memory</h2>
          <p className="text-xs text-muted-foreground">
            {entries.length} fact{entries.length !== 1 ? 's' : ''} Digby remembers about you.
          </p>
        </div>
        {entries.length > 0 && (
          <Button size="sm" variant="outline" className="h-7 text-xs shrink-0"
            onClick={() => setShowAddForm(!showAddForm)}>
            <Plus className="size-3 mr-1" />{showAddForm ? 'Cancel' : 'Add'}
          </Button>
        )}
      </div>

      {/* Rebuild from my own conversations (2026-09-15 memory-wipe recovery) */}
      <div className="rounded-lg border p-3 flex flex-wrap items-center justify-between gap-2" data-testid="memory-rebuild">
        <div className="min-w-0">
          <p className="text-xs font-medium">Rebuild from my conversations</p>
          <p className="text-xs text-muted-foreground">
            {rebuild?.running
              ? `Rebuilding… ${rebuild.processed} of ${rebuild.total} past exchanges read`
              : rebuild?.error
                ? `Last rebuild stopped early: ${rebuild.error}`
                : rebuild && rebuild.factsAfter !== null
                  ? `Last rebuild read ${rebuild.total} exchanges — ${rebuild.factsBefore} → ${rebuild.factsAfter} facts.`
                  : 'Re-reads your own past chats and re-extracts durable personal facts. Runs in the background.'}
          </p>
        </div>
        <Button size="sm" variant="outline" className="h-7 text-xs shrink-0" onClick={handleRebuild}
          disabled={rebuildStarting || !!rebuild?.running}>
          <History className="size-3 mr-1" />{rebuild?.running ? 'Rebuilding…' : 'Rebuild'}
        </Button>
      </div>

      {/* Add form */}
      {(showAddForm || entries.length === 0) && (
        <div className="rounded-lg border border-dashed p-3 space-y-2">
          <p className="text-xs font-medium text-muted-foreground">Add a fact manually</p>
          <Input placeholder="Key (e.g. name, location)" value={newKey}
            onChange={e => setNewKey(e.target.value)} className="h-8 text-sm" />
          <Textarea placeholder="Value" value={newValue}
            onChange={e => setNewValue(e.target.value)} className="text-sm min-h-[60px]" />
          <Button size="sm" className="h-8 text-xs w-full" onClick={handleAdd}
            disabled={!newKey.trim() || !newValue.trim()}>
            <Plus className="size-3.5 mr-1" />Add Fact
          </Button>
        </div>
      )}

      {/* Search */}
      {entries.length > 3 && (
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
          <Input placeholder="Search memories…" value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)} className="h-8 text-sm pl-8" />
        </div>
      )}

      {/* Empty */}
      {entries.length === 0 && (
        <Empty className="border p-8">
          <EmptyHeader>
            <EmptyMedia>
              <Database className="size-8 text-muted-foreground/40" />
            </EmptyMedia>
            <EmptyDescription className="text-sm text-muted-foreground">No memory facts yet.</EmptyDescription>
            <EmptyDescription className="text-xs">Chat with Digby and facts will appear here automatically.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}

      {/* No search results */}
      {entries.length > 0 && filtered.length === 0 && searchQuery.trim() && (
        <div className="rounded-lg border border-dashed p-6 text-center">
          <Search className="size-6 mx-auto mb-2 text-muted-foreground/40" />
          <p className="text-sm text-muted-foreground">No facts matching &ldquo;{searchQuery}&rdquo;</p>
        </div>
      )}

      {/* Categorized groups */}
      {orderedGroups.map(({ id: gid, label, icon: GIcon, items }) => {
        const isOpen = !collapsed.has(gid);
        return (
          <div key={gid} className="rounded-lg border overflow-hidden">
            <button onClick={() => toggle(gid)}
              className="w-full flex items-center gap-2.5 px-3 py-2.5 bg-muted/40 hover:bg-muted/60 transition-colors text-left">
              {isOpen
                ? <ChevronDown className="size-3.5 text-muted-foreground shrink-0" />
                : <ChevronRight className="size-3.5 text-muted-foreground shrink-0" />}
              <GIcon className="size-3.5 text-muted-foreground shrink-0" />
              <span className="text-xs font-semibold flex-1">{label}</span>
              <span className="text-[10px] text-muted-foreground bg-background rounded-full px-1.5 py-0.5 tabular-nums">{items.length}</span>
            </button>
            {isOpen && (
              <div className="divide-y">
                {items.map(([key, value]) => (
                  <FactRow key={key} factKey={key} value={value}
                    editingKey={editingKey} editingValue={editingValue}
                    onEdit={(k, v) => { setEditingKey(k); setEditingValue(v); }}
                    onEditChange={setEditingValue}
                    onSave={() => handleUpdate(key)}
                    onCancel={() => setEditingKey(null)}
                    onDelete={() => handleDelete(key)} />
                ))}
              </div>
            )}
          </div>
        );
      })}

      {/* Clear all */}
      {entries.length > 0 && (
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="outline" size="sm"
              className="w-full h-8 text-xs text-destructive hover:text-destructive border-destructive/40 hover:border-destructive">
              <Trash2 className="size-3.5 mr-1.5" />Clear All Memory
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Clear all memory?</AlertDialogTitle>
              <AlertDialogDescription>
                This will permanently delete all {entries.length} memory fact{entries.length !== 1 ? 's' : ''}.
                The AI will no longer remember anything about you until new facts are extracted.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={handleClear} className="bg-destructive hover:bg-destructive/90">
                Clear All
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </div>
  );
}
