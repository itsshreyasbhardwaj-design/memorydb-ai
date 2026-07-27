'use client';

/**
 * Application shell: sidebar navigation, theme toggle, and the content frame.
 */
import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Brain,
  Database,
  GitGraph,
  LayoutDashboard,
  Moon,
  Search,
  Settings2,
  Sun,
  Terminal,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/primitives';

const NAV_ITEMS = [
  { href: '/dashboard', label: 'Overview', icon: LayoutDashboard },
  { href: '/dashboard/memories', label: 'Memories', icon: Database },
  { href: '/dashboard/search', label: 'Search', icon: Search },
  { href: '/dashboard/graph', label: 'Knowledge graph', icon: GitGraph },
  { href: '/dashboard/settings', label: 'Settings', icon: Settings2 },
] as const;

function ThemeToggle() {
  const [theme, setTheme] = React.useState<'dark' | 'light'>('dark');

  React.useEffect(() => {
    const current = document.documentElement.getAttribute('data-theme');
    setTheme(current === 'light' ? 'light' : 'dark');
  }, []);

  const toggle = (): void => {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    document.documentElement.setAttribute('data-theme', next);
    try {
      localStorage.setItem('memorydb-theme', next);
    } catch {
      // Private browsing can reject writes; the in-memory state still applies.
    }
  };

  return (
    <Button variant="ghost" size="icon" onClick={toggle} aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}>
      {theme === 'dark' ? <Sun /> : <Moon />}
    </Button>
  );
}

export function DashboardShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <div className="flex min-h-screen">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-[var(--color-accent)] focus:px-4 focus:py-2 focus:text-[var(--color-canvas)]"
      >
        Skip to content
      </a>

      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-[var(--color-border)] bg-[color-mix(in_oklch,var(--color-surface)_50%,transparent)] backdrop-blur-xl lg:flex">
        <div className="flex h-16 items-center gap-2.5 px-5">
          <div className="grid size-8 place-items-center rounded-lg bg-gradient-to-br from-[var(--color-accent)] to-[var(--color-accent-strong)]">
            <Brain className="size-4 text-[var(--color-canvas)]" />
          </div>
          <div className="leading-tight">
            <p className="text-sm font-semibold tracking-tight">MemoryDB</p>
            <p className="text-[10px] uppercase tracking-widest text-[var(--color-fg-subtle)]">AI</p>
          </div>
        </div>

        <nav className="flex-1 space-y-0.5 px-3 py-2" aria-label="Main">
          {NAV_ITEMS.map((item) => {
            // Exact match for the index route so it isn't active on every child.
            const isActive =
              item.href === '/dashboard' ? pathname === item.href : pathname.startsWith(item.href);
            const Icon = item.icon;

            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={isActive ? 'page' : undefined}
                className={cn(
                  'flex items-center gap-2.5 rounded-[var(--radius-control)] px-3 py-2 text-sm transition-colors',
                  isActive
                    ? 'bg-[var(--color-surface-raised)] font-medium text-[var(--color-fg)]'
                    : 'text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-fg)]',
                )}
              >
                <Icon className="size-4 shrink-0" />
                {item.label}
                {isActive && <span className="ml-auto size-1 rounded-full bg-[var(--color-accent)]" aria-hidden />}
              </Link>
            );
          })}
        </nav>

        <div className="space-y-1 border-t border-[var(--color-border)] p-3">
          <a
            href="/api/v1/openapi"
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-2.5 rounded-[var(--radius-control)] px-3 py-2 text-sm text-[var(--color-fg-muted)] transition-colors hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-fg)]"
          >
            <Terminal className="size-4" />
            API reference
          </a>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-[var(--color-border)] bg-[color-mix(in_oklch,var(--color-canvas)_75%,transparent)] px-5 backdrop-blur-xl">
          <div className="flex items-center gap-2.5 lg:hidden">
            <div className="grid size-7 place-items-center rounded-md bg-gradient-to-br from-[var(--color-accent)] to-[var(--color-accent-strong)]">
              <Brain className="size-3.5 text-[var(--color-canvas)]" />
            </div>
            <span className="text-sm font-semibold">MemoryDB</span>
          </div>

          <nav className="flex items-center gap-1 overflow-x-auto lg:hidden" aria-label="Main">
            {NAV_ITEMS.map((item) => {
              const isActive =
                item.href === '/dashboard' ? pathname === item.href : pathname.startsWith(item.href);
              const Icon = item.icon;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-label={item.label}
                  aria-current={isActive ? 'page' : undefined}
                  className={cn(
                    'grid size-9 place-items-center rounded-[var(--radius-control)] transition-colors',
                    isActive
                      ? 'bg-[var(--color-surface-raised)] text-[var(--color-accent)]'
                      : 'text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-raised)]',
                  )}
                >
                  <Icon className="size-4" />
                </Link>
              );
            })}
          </nav>

          <div className="ml-auto flex items-center gap-2">
            <ThemeToggle />
          </div>
        </header>

        <main id="main" className="min-w-0 flex-1 p-5 lg:p-8">
          {children}
        </main>
      </div>
    </div>
  );
}
