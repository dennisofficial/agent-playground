'use client';
import { formatClockTime } from '@/utils/org-display';
import { TimeTone, TIME_TONE_COLOR } from './bubbles';

/**
 * A small, muted timestamp shown beside a conversation block. `tone` colors it by message type. Always
 * rendered for now so the operator can judge the density; flip an individual call site to `hoverOnly`
 * (reveals on parent `.group` hover) once we decide which types should be quiet — a one-prop change.
 */

export function MessageTime({
    iso, tone = 'muted', align = 'left', hoverOnly = false,
}: {
    iso?: string;
    tone?: TimeTone;
    align?: 'left' | 'right';
    hoverOnly?: boolean;
}) {
    if (!iso) return null;
    const label = formatClockTime(iso);
    if (!label) return null;
    return (
        <span
            className={`select-none font-mono text-[9.5px] tabular-nums tracking-[0.04em] ${align === 'right' ? 'self-end pr-0.5' : 'pl-0.5'} ${hoverOnly ? 'opacity-0 transition-opacity group-hover:opacity-100' : 'opacity-70'}`}
            style={{ color: TIME_TONE_COLOR[tone] }}
            title={new Date(iso).toLocaleString()}
        >
            {label}
        </span>
    );
}
