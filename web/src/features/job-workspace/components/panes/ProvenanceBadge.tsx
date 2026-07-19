'use client';
export function ProvenanceBadge({ confirmed }: { confirmed?: boolean; }) {
    return confirmed ? (
        <span
            className="whitespace-nowrap rounded px-1.5 py-0.5 font-mono text-[8.5px] uppercase tracking-[0.04em]"
            style={{
                color: 'var(--green, #15803d)',
                background: 'color-mix(in srgb, var(--green, #15803d) 12%, transparent)',
            }}
        >
            confirmed
        </span>
    ) : (
        <span
            className="whitespace-nowrap rounded px-1.5 py-0.5 font-mono text-[8.5px] uppercase tracking-[0.04em]"
            style={{
                color: 'var(--amber, #b45309)',
                background: 'color-mix(in srgb, var(--amber, #b45309) 12%, transparent)',
            }}
        >
            Atlas-authored
        </span>
    );
}
