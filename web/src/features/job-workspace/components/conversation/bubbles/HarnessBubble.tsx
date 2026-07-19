'use client';
import type { JobMessage } from '@/lib/api/job-api';
import { Markdown } from '../markdown';


export function HarnessBubble({ message }: { message: JobMessage; }) {
    return (
        <div
            className="anim-fadeUp rounded-[9px] border"
            style={{
                borderColor: 'var(--border-2)',
                background: 'color-mix(in srgb, var(--surface-2) 60%, transparent)',
            }}
        >
            <div
                className="flex items-center gap-2 rounded-t-[8px] px-3.5 py-2"
                style={{
                    borderBottom: '1px solid var(--border)',
                    background: 'color-mix(in srgb, var(--surface-3) 70%, transparent)',
                }}
            >
                {/* Small "codex" logo — a diamond/square rotated 45°, echoing the ClaudeAvatar shape */}
                <span
                    className="flex h-4 w-4 shrink-0 items-center justify-center rounded-[3px]"
                    style={{ background: 'var(--dim)' }}
                    aria-hidden
                >
                    <span
                        style={{
                            display: 'block',
                            width: 6,
                            height: 6,
                            transform: 'rotate(45deg)',
                            border: '1.5px solid rgba(255,255,255,0.85)',
                            borderRadius: 1,
                        }} />
                </span>
                <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-dim">
                    Codex review
                </span>
                <span className="flex-1" />
                <span className="font-mono text-[10px] text-faint">{message.authorName}</span>
            </div>
            <div className="px-3.5 py-3">
                <Markdown>{message.text}</Markdown>
            </div>
        </div>
    );
}
