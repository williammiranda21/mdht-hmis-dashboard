import { redirect } from 'next/navigation';

/** The Helpline moved to its own app at /helpline (2026-10-01) — old links redirect. */
export default function OldHelpline({ searchParams }: { searchParams: Record<string, string> }) {
  const qs = new URLSearchParams(searchParams).toString();
  redirect(`/helpline${qs ? `?${qs}` : ''}`);
}
