import { redirect } from 'next/navigation';

/** Moved to /helpline/report (2026-10-01). */
export default function OldReport({ searchParams }: { searchParams: Record<string, string> }) {
  const qs = new URLSearchParams(searchParams).toString();
  redirect(`/helpline/report${qs ? `?${qs}` : ''}`);
}
