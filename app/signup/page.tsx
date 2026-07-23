import { Suspense } from 'react';
import Link from 'next/link';
import SignupForm from './SignupForm';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Request access · HMIS Performance Dashboard' };

export default function SignupPage() {
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
        <h1>Request access</h1>
        <p className="loginhint">
          Create your account, then a Homeless Trust administrator reviews it and assigns which
          projects you can see. You won’t be able to view any data until it’s approved.
        </p>
        <Suspense fallback={null}>
          <SignupForm />
        </Suspense>
        <p className="loginalt">
          Already have an account? <Link href="/login">Sign in</Link>
        </p>
      </div>
    </main>
  );
}
