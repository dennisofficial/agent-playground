import Link from 'next/link';
import { ROUTES } from '@/lib/routes';

/**
 * Placeholder for the thread workspace + create-thread flows, which are being rebuilt on the org/repo/
 * thread API. Mounted in place of the now-dead channel-based routes so a direct URL hit shows a clear
 * message instead of crashing on the (removed) channel provider.
 */
export function DeferredWorkspace({
  title = 'Being rebuilt for multi-org',
  body = 'Thread workspaces are moving to the org → repo → thread model. This view will return with the next update.',
}: {
  title?: string;
  body?: string;
}) {
  return (
    <div className="flex h-full min-h-0 items-center justify-center px-6">
      <div className="max-w-md text-center">
        <h2 className="font-disp text-[16px] font-semibold text-text">{title}</h2>
        <p className="mt-2 text-[13px] leading-relaxed text-dim">{body}</p>
        <Link
          href={ROUTES.workspace()}
          className="mt-5 inline-block rounded-md border px-3.5 py-2 text-[12.5px] font-medium text-accent"
          style={{ background: 'var(--accent-soft)', borderColor: 'var(--accent-line)' }}
        >
          ← All organizations
        </Link>
      </div>
    </div>
  );
}
