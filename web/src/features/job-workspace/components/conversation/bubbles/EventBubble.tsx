'use client';
import type { EventKind } from '@/features/job-workspace/lib/classify';
import type { JobMessage } from '@/lib/api/job-api';
import { Markdown } from '../markdown';
import { KNOWN_EVENT_KINDS, eventKindPresentation, TONE_COLOR } from './bubbles';


export function EventBubble({ message }: { message: JobMessage; }) {
    const meta = message.meta ?? {};
    const eventKind = typeof meta.eventKind === 'string' &&
        (KNOWN_EVENT_KINDS as readonly string[]).includes(meta.eventKind)
        ? (meta.eventKind as EventKind)
        : null;

    if (eventKind === null) {
        // Generic fallback — unstamped legacy rows (and any future/unrecognized eventKind), unchanged.
        const source = typeof meta.eventSource === 'string' ? meta.eventSource : 'event';
        const severity = typeof meta.severity === 'string' ? meta.severity : null;
        return (
            <div
                className="anim-fadeUp rounded-[9px] border"
                style={{
                    borderColor: 'var(--accent-line)',
                    background: 'var(--accent-soft)',
                }}
            >
                <div
                    className="flex items-center gap-2 rounded-t-[8px] px-3.5 py-2"
                    style={{
                        borderBottom: '1px solid var(--accent-line)',
                        background: 'color-mix(in srgb, var(--accent) 10%, transparent)',
                    }}
                >
                    <span aria-hidden style={{ color: 'var(--accent)', fontSize: 11, lineHeight: 1 }}>
                        ◈
                    </span>
                    <span
                        className="font-mono text-[10px] font-semibold uppercase tracking-[0.12em]"
                        style={{ color: 'var(--accent)' }}
                    >
                        Event · {source}
                    </span>
                    <span className="flex-1" />
                    {severity ? <span className="font-mono text-[10px] text-faint">{severity}</span> : null}
                </div>
                <div className="px-3.5 py-3">
                    <Markdown>{message.text}</Markdown>
                </div>
            </div>
        );
    }

    const { icon: Icon, label, tone } = eventKindPresentation(eventKind);
    const color = TONE_COLOR[tone];
    return (
        <div
            className="anim-fadeUp rounded-[9px] border"
            style={{
                borderColor: 'var(--accent-line)',
                background: 'var(--accent-soft)',
            }}
        >
            <div
                className="flex items-center gap-2 rounded-t-[8px] px-3.5 py-2"
                style={{
                    borderBottom: '1px solid var(--accent-line)',
                    background: 'color-mix(in srgb, var(--accent) 10%, transparent)',
                }}
            >
                <Icon size={12} style={{ color }} />
                <span
                    className="font-mono text-[10px] font-semibold uppercase tracking-[0.12em]"
                    style={{ color }}
                >
                    {label}
                </span>
            </div>
            <div className="px-3.5 py-3">
                <Markdown>{message.text}</Markdown>
            </div>
        </div>
    );
}
