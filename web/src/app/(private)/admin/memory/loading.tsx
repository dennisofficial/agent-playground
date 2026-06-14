/**
 * Next.js route-level loading UI — shown while the Server Component is streaming or during a
 * tenant-switch navigation. Skeleton rows match the fact-row height for a stable layout.
 */
export default function MemoryLoading() {
  return (
    <main className="flex flex-1 justify-center bg-zinc-50 px-6 py-12 font-sans dark:bg-black">
      <div className="w-full max-w-5xl">
        <header className="mb-10 flex items-center justify-between">
          <div>
            <div className="h-6 w-64 animate-pulse rounded-md bg-zinc-200 dark:bg-zinc-800" />
            <div className="mt-1.5 h-4 w-40 animate-pulse rounded-md bg-zinc-200 dark:bg-zinc-800" />
          </div>
          <div className="h-8 w-16 animate-pulse rounded-md bg-zinc-200 dark:bg-zinc-800" />
        </header>

        <div className="flex gap-6">
          {/* Sidebar skeleton */}
          <aside className="w-44 shrink-0">
            <div className="h-4 w-24 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
            <div className="mt-3 flex flex-col gap-2">
              {[...Array(5)].map((_, i) => (
                <div
                  key={i}
                  className="h-8 animate-pulse rounded-md bg-zinc-200 dark:bg-zinc-800"
                />
              ))}
            </div>
          </aside>

          {/* Main area skeleton */}
          <div className="min-w-0 flex-1">
            {/* Tabs */}
            <div className="flex gap-2 border-b border-zinc-200 pb-3 dark:border-zinc-800">
              {[...Array(4)].map((_, i) => (
                <div
                  key={i}
                  className="h-7 w-20 animate-pulse rounded-md bg-zinc-200 dark:bg-zinc-800"
                />
              ))}
            </div>
            {/* Toolbar */}
            <div className="my-3 flex items-center gap-3">
              <div className="h-8 flex-1 animate-pulse rounded-md bg-zinc-200 dark:bg-zinc-800" />
              <div className="h-8 w-36 animate-pulse rounded-md bg-zinc-200 dark:bg-zinc-800" />
            </div>
            {/* Fact rows */}
            <div className="flex flex-col gap-2">
              {[...Array(6)].map((_, i) => (
                <div
                  key={i}
                  className="h-16 animate-pulse rounded-lg bg-zinc-200 dark:bg-zinc-800"
                />
              ))}
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
