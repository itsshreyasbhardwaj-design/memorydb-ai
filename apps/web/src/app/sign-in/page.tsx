'use client';

/**
 * Dashboard sign-in for self-hosted deployments.
 *
 * The operator authenticates with the same API key the SDKs use and receives an
 * HttpOnly session cookie. The key is never persisted in the browser — it is
 * posted once and exchanged for a signed token.
 */
import * as React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Brain, KeyRound } from 'lucide-react';
import { Button, Card, Input } from '@/components/ui/primitives';

function SignInForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [apiKey, setApiKey] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setPending(true);
    setError(null);

    try {
      const response = await fetch('/api/v1/auth/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ apiKey }),
        credentials: 'same-origin',
      });

      if (!response.ok) {
        const payload = (await response.json()) as { error?: { message?: string } };
        setError(payload.error?.message ?? 'Sign-in failed');
        return;
      }

      // Only allow relative redirects — an absolute URL here would be an open redirect.
      const next = searchParams.get('next');
      const destination = next?.startsWith('/') && !next.startsWith('//') ? next : '/dashboard';
      router.push(destination);
      router.refresh();
    } catch {
      setError('Could not reach the server');
    } finally {
      setPending(false);
    }
  };

  return (
    <Card className="w-full max-w-sm p-7">
      <div className="mb-6 flex flex-col items-center gap-3 text-center">
        <div className="grid size-11 place-items-center rounded-xl bg-gradient-to-br from-[var(--color-accent)] to-[var(--color-accent-strong)]">
          <Brain className="size-5 text-[var(--color-canvas)]" />
        </div>
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Sign in to MemoryDB</h1>
          <p className="mt-1 text-xs text-[var(--color-fg-subtle)]">
            Use the API key configured as <code className="font-mono">MEMORYDB_API_KEY</code>.
          </p>
        </div>
      </div>

      <form onSubmit={submit} className="space-y-3">
        <div className="relative">
          <KeyRound className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[var(--color-fg-subtle)]" />
          <Input
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder="mdb_live_…"
            className="pl-9 font-mono"
            aria-label="API key"
            autoComplete="off"
            autoFocus
            required
          />
        </div>

        {error && (
          <p role="alert" className="text-xs text-[var(--color-danger)]">
            {error}
          </p>
        )}

        <Button type="submit" variant="primary" className="w-full" disabled={pending || !apiKey}>
          {pending ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>

      <p className="mt-5 text-center text-[11px] leading-relaxed text-[var(--color-fg-subtle)]">
        Your key is exchanged for a short-lived session cookie and is never stored in the browser.
      </p>
    </Card>
  );
}

export default function SignInPage() {
  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <React.Suspense fallback={null}>
        <SignInForm />
      </React.Suspense>
    </div>
  );
}
