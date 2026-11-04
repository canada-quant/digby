/**
 * One-time secret hand-off from a confirmed card (capability gap #32 close-out,
 * 2026-09-25). A consequential tool that MINTS a secret (create_chat_webhook)
 * returns it ONLY on the owner-browser confirm path, inside the result JSON as
 * `secret: { label, value }`. The model path and the transcripts never carry
 * it, so this toast is the only place the owner ever sees the value.
 */
import { toast } from 'sonner';

export function surfaceConfirmSecret(result: string | undefined | null): boolean {
  if (!result) return false;
  let parsed: any;
  try { parsed = JSON.parse(result); } catch { return false; }
  const secret = parsed?.secret;
  if (!secret || typeof secret.value !== 'string' || !secret.value) return false;
  const label = typeof secret.label === 'string' && secret.label ? secret.label : 'Secret (shown once)';
  const copy = () => { try { void navigator.clipboard?.writeText(secret.value); toast.success('Copied.'); } catch { /* clipboard unavailable */ } };
  toast.message(label, {
    description: secret.value,
    duration: 180_000,
    action: { label: 'Copy', onClick: copy },
  });
  return true;
}
