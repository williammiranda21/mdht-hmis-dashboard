import { redirect } from 'next/navigation';

/**
 * There's no separate landing page — the dashboard is the product. Anyone
 * hitting the root goes straight to it (and middleware sends them to /login
 * first if they aren't signed in).
 */
export default function Home() {
  redirect('/dashboard');
}
