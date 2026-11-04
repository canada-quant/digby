'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { childrenApi, type ChildAccount } from '@/lib/api/children';
import { cn } from '@/lib/utils';
import { Baby, Plus, Trash2, ShieldCheck, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

const inputCls =
  'w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-brand-accent focus:ring-1 focus:ring-brand-accent';

export function KidsTab() {
  const [children, setChildren] = useState<ChildAccount[]>([]);
  const [pinSet, setPinSet] = useState(false);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);

  // form state
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [age, setAge] = useState('');
  const [guardrails, setGuardrails] = useState('');
  const [pin, setPin] = useState('');

  async function load() {
    try {
      const data = await childrenApi.list();
      setChildren(data.children);
      setPinSet(data.pinSet);
    } catch {
      toast.error('Could not load child accounts.');
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); }, []);

  function resetForm() {
    setName(''); setEmail(''); setPassword(''); setAge(''); setGuardrails(''); setPin('');
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    const ageNum = parseInt(age, 10);
    if (!name.trim()) return toast.error('Please enter the child\'s name.');
    if (!email.trim()) return toast.error('Please enter a login email.');
    if (password.length < 6) return toast.error('Password must be at least 6 characters.');
    if (isNaN(ageNum) || ageNum < 2 || ageNum > 17) return toast.error('Enter an age between 2 and 17.');
    if (!/^\d{4,6}$/.test(pin)) return toast.error('Parent PIN must be 4–6 digits.');

    setSaving(true);
    try {
      await childrenApi.create({ name: name.trim(), email: email.trim(), password, age: ageNum, guardrails: guardrails.trim(), parentPin: pin });
      toast.success(`${name.trim()}'s account is ready.`);
      resetForm();
      setShowForm(false);
      load();
    } catch (err: any) {
      toast.error(err?.response?.data?.error || 'Could not create the account.');
    } finally {
      setSaving(false);
    }
  }

  // ── Remove-child dialog (masked parent-PIN entry — no window.prompt) ──
  const [removeTarget, setRemoveTarget] = useState<ChildAccount | null>(null);
  const [removePin, setRemovePin] = useState('');
  const [removing, setRemoving] = useState(false);

  async function handleRemoveConfirm() {
    if (!removeTarget || !removePin) return;
    setRemoving(true);
    try {
      await childrenApi.remove(removeTarget.id, removePin);
      toast.success(`${removeTarget.name}'s account was removed.`);
      setRemoveTarget(null);
      setRemovePin('');
      load();
    } catch (err: any) {
      toast.error(err?.response?.data?.error || 'Could not remove the account.');
    } finally {
      setRemoving(false);
    }
  }

  // ── Edit-rules dialog (rules textarea + masked parent PIN) ──
  const [editTarget, setEditTarget] = useState<ChildAccount | null>(null);
  const [editRules, setEditRules] = useState('');
  const [editPin, setEditPin] = useState('');
  const [savingRules, setSavingRules] = useState(false);

  function openEditGuardrails(child: ChildAccount) {
    setEditTarget(child);
    setEditRules(child.guardrails || '');
    setEditPin('');
  }

  async function handleEditConfirm() {
    if (!editTarget || !editPin) return;
    setSavingRules(true);
    try {
      await childrenApi.update(editTarget.id, { guardrails: editRules, parentPin: editPin });
      toast.success('Updated.');
      setEditTarget(null);
      load();
    } catch (err: any) {
      toast.error(err?.response?.data?.error || 'Could not update.');
    } finally {
      setSavingRules(false);
    }
  }

  if (loading) {
    return <div className="flex justify-center py-10"><Loader2 className="size-5 animate-spin text-brand-accent" /></div>;
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-sm font-semibold mb-1 flex items-center gap-2"><Baby className="size-4 text-brand-accent" /> Digby for Kids</h2>
        <p className="text-xs text-muted-foreground">
          Create a safe sub-account for a child. Kids get a simpler assistant that always uses kid-safe web search and a
          strict tutor that helps them <strong>think for themselves</strong> — it asks guiding questions instead of just
          giving answers. You set the age and any extra house rules. Children sign in with their own email and password.
        </p>
      </div>

      {/* Existing children */}
      {children.length > 0 && (
        <div className="space-y-2">
          {children.map((c) => (
            <div key={c.id} className="rounded-lg border border-border p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium">{c.name} <span className="text-xs text-muted-foreground">· age {c.age ?? '?'}</span></div>
                  <div className="text-xs text-muted-foreground truncate">{c.email}</div>
                  {c.guardrails
                    ? <div className="text-xs text-foreground/70 mt-1.5"><span className="font-medium">House rules:</span> {c.guardrails}</div>
                    : <div className="text-xs text-muted-foreground/70 mt-1.5 italic">No extra rules — built-in kid-safe rules apply.</div>}
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => openEditGuardrails(c)}>Edit rules</Button>
                  <Button variant="ghost" size="icon" className="size-7 text-destructive hover:text-destructive" onClick={() => { setRemovePin(''); setRemoveTarget(c); }}><Trash2 className="size-3.5" /></Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Create */}
      {!showForm ? (
        <Button size="sm" className="gap-1.5 bg-brand hover:bg-brand-hover" onClick={() => setShowForm(true)}>
          <Plus className="size-4" /> Add a child account
        </Button>
      ) : (
        <form onSubmit={handleCreate} className="rounded-lg border border-border p-4 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium">Child's name</label>
              <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Mia" />
            </div>
            <div>
              <label className="text-xs font-medium">Age</label>
              <input className={inputCls} value={age} onChange={(e) => setAge(e.target.value)} inputMode="numeric" placeholder="2–17" />
            </div>
            <div>
              <label className="text-xs font-medium">Login email</label>
              <input className={inputCls} value={email} onChange={(e) => setEmail(e.target.value)} type="email" placeholder="mia@family.com" />
            </div>
            <div>
              <label className="text-xs font-medium">Password</label>
              <input className={inputCls} value={password} onChange={(e) => setPassword(e.target.value)} type="password" placeholder="min 6 characters" />
            </div>
          </div>
          <div>
            <label className="text-xs font-medium">Extra house rules <span className="text-muted-foreground">(optional)</span></label>
            <textarea className={cn(inputCls, 'min-h-[64px] resize-y')} value={guardrails} onChange={(e) => setGuardrails(e.target.value)} placeholder="e.g. No talk of scary movies. Encourage reading. Keep answers short." />
            <p className="text-[11px] text-muted-foreground mt-1">These are layered on top of Digby's built-in kid-safe rules — they can only add restrictions.</p>
          </div>
          <div>
            <label className="text-xs font-medium flex items-center gap-1"><ShieldCheck className="size-3.5 text-brand-accent" /> {pinSet ? 'Your parent PIN' : 'Create a parent PIN (4–6 digits)'}</label>
            <input className={cn(inputCls, 'max-w-[160px]')} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} inputMode="numeric" maxLength={6} placeholder="••••" />
            <p className="text-[11px] text-muted-foreground mt-1">{pinSet ? 'Required to create or change a child account.' : 'You\'ll use this to manage kids and to leave kid mode. Keep it private from your child.'}</p>
          </div>
          <div className="flex gap-2 pt-1">
            <Button type="submit" size="sm" disabled={saving} className="gap-1.5 bg-brand hover:bg-brand-hover">
              {saving && <Loader2 className="size-3.5 animate-spin" />} Create account
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => { setShowForm(false); resetForm(); }}>Cancel</Button>
          </div>
        </form>
      )}

      {/* Remove-child confirmation — masked parent-PIN entry */}
      <Dialog open={!!removeTarget} onOpenChange={v => { if (!v) { setRemoveTarget(null); setRemovePin(''); } }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Trash2 className="size-4 text-destructive" /> Remove {removeTarget?.name}'s account?
            </DialogTitle>
            <DialogDescription>
              Enter your parent PIN to permanently remove this child account.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={e => { e.preventDefault(); handleRemoveConfirm(); }} className="space-y-3">
            <Input
              autoFocus
              type="password"
              inputMode="numeric"
              maxLength={6}
              placeholder="Parent PIN"
              value={removePin}
              onChange={e => setRemovePin(e.target.value.replace(/\D/g, ''))}
            />
            <div className="flex gap-2 justify-end">
              <Button type="button" variant="ghost" size="sm" onClick={() => { setRemoveTarget(null); setRemovePin(''); }}>Cancel</Button>
              <Button type="submit" size="sm" variant="destructive" disabled={removing || !removePin} className="gap-1.5">
                {removing && <Loader2 className="size-3.5 animate-spin" />} Remove account
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* Edit house rules — rules + masked parent PIN */}
      <Dialog open={!!editTarget} onOpenChange={v => { if (!v) setEditTarget(null); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>House rules for {editTarget?.name}</DialogTitle>
            <DialogDescription>
              Digby follows these on top of its built-in kid-safe rules — they can only add restrictions.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={e => { e.preventDefault(); handleEditConfirm(); }} className="space-y-3">
            <textarea
              autoFocus
              className={cn(inputCls, 'min-h-[80px] resize-y')}
              value={editRules}
              onChange={e => setEditRules(e.target.value)}
              placeholder="e.g. No talk of scary movies. Encourage reading. Keep answers short."
            />
            <div>
              <label className="text-xs font-medium flex items-center gap-1"><ShieldCheck className="size-3.5 text-brand-accent" /> Parent PIN</label>
              <Input
                type="password"
                inputMode="numeric"
                maxLength={6}
                placeholder="Parent PIN"
                className="mt-1 max-w-[160px]"
                value={editPin}
                onChange={e => setEditPin(e.target.value.replace(/\D/g, ''))}
              />
            </div>
            <div className="flex gap-2 justify-end">
              <Button type="button" variant="ghost" size="sm" onClick={() => setEditTarget(null)}>Cancel</Button>
              <Button type="submit" size="sm" disabled={savingRules || !editPin} className="gap-1.5 bg-brand hover:bg-brand-hover">
                {savingRules && <Loader2 className="size-3.5 animate-spin" />} Save
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
