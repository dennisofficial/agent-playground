'use client';

import { use, type ReactNode } from 'react';
import { useSelectedLayoutSegment } from 'next/navigation';
import { PhaseHeader } from '@/features/phase/components/phase-header';
import type { PhaseTab } from '@/lib/routes';

/** Phase shell (DRY): header + Transcript/Diff/Logs tab bar persist across the tab routes. */
export default function PhaseLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ threadKey: string; phaseId: string }>;
}) {
  const { threadKey, phaseId } = use(params);
  const segment = useSelectedLayoutSegment() as PhaseTab | null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PhaseHeader threadKey={threadKey} phaseId={phaseId} activeTab={segment} />
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}
