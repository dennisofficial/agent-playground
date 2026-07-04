"use client";

/**
 * Root-level error boundary — catches errors in the root layout itself (rare, but required).
 * Next.js replaces the entire document when this fires, so we must include <html>/<body>.
 * Without this file, Next.js 16 preview auto-generates one that fails to prerender due to a
 * known useContext bug in the preview build.
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
      <body className="flex min-h-full flex-col items-center justify-center bg-zinc-50 font-sans dark:bg-black">
        <div className="w-full max-w-sm rounded-xl border border-red-200 bg-white p-8 dark:border-red-900 dark:bg-zinc-950">
          <h1 className="text-lg font-semibold text-black dark:text-zinc-50">
            Something went wrong
          </h1>
          <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
            An unexpected error occurred. Try refreshing the page.
          </p>
          {error.digest && (
            <p className="mt-2 font-mono text-xs text-zinc-400 dark:text-zinc-500">
              {error.digest}
            </p>
          )}
          <button
            type="button"
            onClick={reset}
            className="mt-4 rounded-md bg-black px-3 py-2 text-sm font-medium text-white dark:bg-zinc-50 dark:text-black"
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
