import { redirect } from 'next/navigation';

// Root page — redirect to the main CrossModel chat UI.
// PWA start_url also points to /crossmodel, but this handles direct / visits.
// FORWARD THE QUERY STRING: deep links (/?chatId=…, /?projectId=…) arrive here
// from the Management dashboard, project pages, emails, and old bookmarks — a
// bare redirect('/crossmodel') silently dropped them, so the linked chat never
// opened (Management "open chat" deep links landed on the home screen).
export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(sp)) {
    if (typeof value === 'string') qs.append(key, value);
    else if (Array.isArray(value)) for (const v of value) qs.append(key, v);
  }
  const suffix = qs.toString();
  redirect(suffix ? `/crossmodel?${suffix}` : '/crossmodel');
}
