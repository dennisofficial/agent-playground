'use client';

export function ClaudeAvatar({ size = 24 }: { size?: number; }) {
    const inner = Math.round(size * 0.38);
    return (
        <span
            className="flex shrink-0 items-center justify-center rounded-md"
            style={{
                width: size,
                height: size,
                background: 'linear-gradient(145deg, var(--accent), var(--accent-2))',
            }}
            aria-hidden
        >
            <span
                style={{
                    width: inner,
                    height: inner,
                    transform: 'rotate(45deg)',
                    border: '1.5px solid rgba(255,255,255,0.92)',
                    borderRadius: 2,
                }} />
        </span>
    );
}
