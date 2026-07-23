import { Suspense } from 'react';
import Link from 'next/link';
import LoginForm from './LoginForm';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Sign in · HMIS Performance Dashboard' };

export default function LoginPage() {
  return (
    <main className="loginwrap">
      <div className="logincard">
        <div className="loginbrand">
          <span className="mark">HT</span>
          <span>
            <span className="nm">Miami-Dade County Homeless Trust</span>
            <span className="sub">FL-600 System Dashboard</span>
          </span>
        </div>
        <h1>Sign in</h1>
        <p className="loginhint">
          HMIS Performance Dashboard. Accounts are issued by the Homeless Trust — contact your
          administrator if you need access.
        </p>
        <Suspense fallback={null}>
          <LoginForm />
        </Suspense>
        <p className="loginalt">
          Need access? <Link href="/signup">Request an account</Link>
        </p>
      </div>
    </main>
  );
}
