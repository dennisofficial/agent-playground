'use client';
import type { SystemTone } from '@/features/job-workspace/lib/classify';
import type { JobMessage } from '@/lib/api/job-api';
import { TONE_COLOR } from './bubbles';


export function SystemEventPill({ message, tone }: { message: JobMessage; tone: SystemTone; }) {
    return (
        <div
            className="anim-fadeUp flex items-center gap-2.5 self-stretch rounded-md border px-3.5 py-1.5 font-mono text-[10px] text-dim"
            style={{
                borderColor: 'var(--hair)',
                background: 'color-mix(in srgb, var(--surface-2) 70%, transparent)',
            }}
        >
            <span
                className="h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ background: TONE_COLOR[tone] }} />
            <span className="truncate">{message.text}</span>
        </div>
    );
}
