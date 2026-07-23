import Link from 'next/link';

/**
 * Signed-in user chip + account link + sign-out.
 *
 * Deliberately NOT a client component: sign-out is a plain form POST to
 * /auth/signout so the server clears the session cookies. Doing it in the
 * browser raced the middleware and silently bounced back to the dashboard.
 */
export default function UserMenu({
  label,
  isAdmin,
  showAccountLink = true,
}: {
  label: string;
  isAdmin: boolean;
  showAccountLink?: boolean;
}) {
  return (
    <div className="usermenu">
      <span className="uname">
        {label}
        {isAdmin && <span className="ubadge">Admin</span>}
      </span>
      {showAccountLink && (
        <Link href="/dashboard/account" className="tbtn">My account</Link>
      )}
      <form action="/auth/signout" method="post">
        <button className="tbtn" type="submit">Sign out</button>
      </form>
    </div>
  );
}
