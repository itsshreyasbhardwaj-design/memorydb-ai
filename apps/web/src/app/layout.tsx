import type { Metadata, Viewport } from 'next';
import { Toaster } from 'sonner';
import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'MemoryDB AI — long-term memory for AI agents',
    template: '%s · MemoryDB AI',
  },
  description:
    'Production-ready long-term memory infrastructure for AI agents. Semantic, episodic, and knowledge-graph memory with hybrid retrieval, intelligent ranking, and citations.',
  keywords: [
    'AI memory', 'vector database', 'semantic search', 'pgvector',
    'knowledge graph', 'LLM', 'RAG', 'agent memory', 'embeddings',
  ],
  authors: [{ name: 'MemoryDB AI' }],
  openGraph: {
    type: 'website',
    title: 'MemoryDB AI',
    description: 'Long-term memory infrastructure for AI agents.',
    siteName: 'MemoryDB AI',
  },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: dark)', color: '#0b0d14' },
    { media: '(prefers-color-scheme: light)', color: '#fbfbfd' },
  ],
  width: 'device-width',
  initialScale: 1,
};

/**
 * Applied before paint to prevent a flash of the wrong theme.
 * Inlined deliberately: any deferred script runs after first paint.
 */
const THEME_SCRIPT = `
(function() {
  try {
    var stored = localStorage.getItem('memorydb-theme');
    var prefersLight = window.matchMedia('(prefers-color-scheme: light)').matches;
    var theme = stored || (prefersLight ? 'light' : 'dark');
    document.documentElement.setAttribute('data-theme', theme);
  } catch (e) {
    document.documentElement.setAttribute('data-theme', 'dark');
  }
})();
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="min-h-screen antialiased">
        <div className="aurora" aria-hidden />
        {children}
        <Toaster
          position="bottom-right"
          toastOptions={{
            style: {
              background: 'var(--color-surface-raised)',
              border: '1px solid var(--color-border)',
              color: 'var(--color-fg)',
            },
          }}
        />
      </body>
    </html>
  );
}
