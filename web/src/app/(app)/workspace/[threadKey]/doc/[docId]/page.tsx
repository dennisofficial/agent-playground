'use client';

import { use } from 'react';
import { decodeThreadKey } from '@/lib/routes';
import { DocView } from '@/components/phase/doc-view';

export default function DocPage({
  params,
}: {
  params: Promise<{ threadKey: string; docId: string }>;
}) {
  const { threadKey, docId } = use(params);
  const { channel, threadTs } = decodeThreadKey(threadKey);
  return <DocView channel={channel} threadTs={threadTs} docId={decodeURIComponent(docId)} />;
}
