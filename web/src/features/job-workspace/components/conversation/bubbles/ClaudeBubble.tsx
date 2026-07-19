'use client';
import type { JobMessage } from '@/lib/api/job-api';
import { StreamTextBubble } from './StreamTextBubble';


export function ClaudeBubble({
    message, onSelectNode,
}: {
    message: JobMessage;
    onSelectNode?: (node: string) => void;
}) {
    // No per-bubble timestamp on assistant prose — the end-of-turn `TurnMetaDivider` line carries the
    // turn's time (next to its token counter), so a timestamp here would just duplicate it.
    return <StreamTextBubble text={message.text} onSelectNode={onSelectNode} />;
}
