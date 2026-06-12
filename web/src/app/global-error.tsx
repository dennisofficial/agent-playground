'use client';

/**
 * Global error boundary — catches errors thrown in the root layout.
 * Must include its own <html> and <body> tags (replaces the root layout on error).
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body className="min-h-full flex flex-col">
        <main className="flex flex-1 items-center justify-center bg-zinc-50 p-6 font-sans dark:bg-black">
          <div className="w-full max-w-sm rounded-xl border border-red-200 bg-white p-8 dark:border-red-900 dark:bg-zinc-950">
            <h1 className="text-lg font-semibold text-black dark:text-zinc-50">
              Something went wrong
            </h1>
            <p className="mt-2 font-mono text-xs text-zinc-500 dark:text-zinc-400">
              {error.digest ?? error.message}
            </p>
            <button
              type="button"
              onClick={reset}
              className="mt-4 rounded-md bg-black px-3 py-2 text-sm font-medium text-white dark:bg-zinc-50 dark:text-black"
            >
              Try again
            </button>
          </div>
        </main>
      </body>
    </html>
  );
}
