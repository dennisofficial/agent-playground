'use client';

import { use } from 'react';
import Link from 'next/link';
import { decodeThreadRef, ROUTES } from '@/lib/routes';
import { ThreadWorkspace } from '@/features/thread-workspace/thread-workspace';

/**
 * The thread workspace — navigator + work column (Conversation / Phase). The `[threadKey]` segment
 * encodes the `org/repo/thread` triple (see `routes.ts`); a malformed key shows a recover link rather
 * than crashing.
 */
export default function ThreadPage({ params }: { params: Promise<{ threadKey: string }> }) {
  const { threadKey } = use(params);
  const ref = decodeThreadRef(threadKey);

  if (!ref) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center px-6">
        <div className="max-w-md text-center">
          <h2 className="font-disp text-[16px] font-semibold text-text">Thread not found</h2>
          <p className="mt-2 text-[13px] leading-relaxed text-dim">That thread link is malformed.</p>
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

  return <ThreadWorkspace orgId={ref.orgId} repoId={ref.repoId} threadId={ref.threadId} />;
}
