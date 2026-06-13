/**
 * Route-level Suspense boundary for /admin.
 * Shown while the page component is loading (initial navigation, hard reload).
 * Matches the card-list shape of the admin surface.
 */
export default function AdminLoading() {
  return (
    <div className="flex animate-pulse flex-col gap-8">
      {/* GitHub tokens section */}
      <div>
        <div className="mb-4 h-5 w-36 rounded bg-zinc-200 dark:bg-zinc-800" />
        <div className="flex flex-col gap-2">
          {[0, 1].map((i) => (
            <div key={i} className="h-14 rounded-lg bg-zinc-100 dark:bg-zinc-900" />
          ))}
        </div>
      </div>
      {/* Projects section */}
      <div>
        <div className="mb-4 h-5 w-24 rounded bg-zinc-200 dark:bg-zinc-800" />
        <div className="flex flex-col gap-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-14 rounded-lg bg-zinc-100 dark:bg-zinc-900" />
          ))}
        </div>
      </div>
    </div>
  );
}
