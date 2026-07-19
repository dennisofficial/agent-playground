'use client';
export function DocLabel({ children }: { children: React.ReactNode; }) {
    return <div className="mb-2.5 font-mono text-[9px] tracking-[0.14em] text-faint">{children}</div>;
}
