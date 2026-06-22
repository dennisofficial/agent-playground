'use client';

import { use } from 'react';
import { decodeThreadKey, type PhaseTab } from '@/lib/routes';
import { BuildPhase } from '@/components/phase/build-phase';

const TABS: readonly PhaseTab[] = ['transcript', 'diff', 'logs'];

export default function PhaseTabPage({
  params,
}: {
  params: Promise<{ threadKey: string; phaseId: string; tab: string }>;
}) {
  const { threadKey, tab } = use(params);
  const { channel, threadTs } = decodeThreadKey(threadKey);
  const safeTab: PhaseTab = TABS.includes(tab as PhaseTab) ? (tab as PhaseTab) : 'transcript';
  return <BuildPhase channel={channel} threadTs={threadTs} tab={safeTab} />;
}
