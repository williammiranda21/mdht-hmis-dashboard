import { redirect } from 'next/navigation';

/** Moved to /helpline/print/[id] (2026-10-01). */
export default function OldPrint({ params }: { params: { id: string } }) {
  redirect(`/helpline/print/${encodeURIComponent(params.id)}`);
}
