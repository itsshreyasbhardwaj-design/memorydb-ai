import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { DashboardShell } from '@/components/dashboard/shell';
import { SESSION_COOKIE, verifySessionToken } from '@/lib/session';
import { apiKey, clerkEnabled, isProduction } from '@/lib/env';

/**
 * Server-side gate for the dashboard.
 *
 * Checked here rather than in middleware so the redirect happens before any
 * dashboard JavaScript is sent to an unauthenticated browser. The API enforces
 * the same rules independently — this is a UX affordance, not the security
 * boundary.
 */
export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const requestHeaders = await headers();
  const cookieHeader = requestHeaders.get('cookie') ?? '';

  const token = cookieHeader
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${SESSION_COOKIE}=`))
    ?.slice(SESSION_COOKIE.length + 1);

  const hasSession = await verifySessionToken(token);

  // Clerk handles its own redirect via middleware, and development without a
  // configured key stays open so the quickstart needs no sign-in step.
  const requiresSignIn = isProduction && !clerkEnabled && Boolean(apiKey);

  if (requiresSignIn && !hasSession) {
    redirect('/sign-in?next=/dashboard');
  }

  return <DashboardShell>{children}</DashboardShell>;
}
