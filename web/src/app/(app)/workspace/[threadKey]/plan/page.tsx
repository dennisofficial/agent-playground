'use client';

import { use } from 'react';
import { decodeThreadKey } from '@/lib/routes';
import { FullPlan } from '@/features/phase/components/full-plan';

export default function PlanPage({ params }: { params: Promise<{ threadKey: string }> }) {
  const { threadKey } = use(params);
  const { channel, threadTs } = decodeThreadKey(threadKey);
  return <FullPlan channel={channel} threadTs={threadTs} />;
}
