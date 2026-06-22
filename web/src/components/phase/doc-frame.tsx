import type { ReactNode } from 'react';

/** Shared scroll frame for the work-column document views (plan / doc / phase). DRY. */
export function DocFrame({ children }: { children: ReactNode }) {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[780px] px-8 py-8">{children}</div>
    </div>
  );
}

export function EmptyDoc({ title, body }: { title: string; body: string }) {
  return (
    <DocFrame>
      <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-faint">{title}</p>
      <p className="mt-3 text-[13px] text-dim">{body}</p>
    </DocFrame>
  );
}
