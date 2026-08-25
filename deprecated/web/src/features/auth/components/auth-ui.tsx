import { Card } from '@/components/ui/card';
import { AlertCircle } from 'lucide-react';
import type { ReactNode } from 'react';

export function AuthCard({ children }: { children: ReactNode }) {
  return <Card className="p-7">{children}</Card>;
}

export function AuthHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="mb-5">
      <h1 className="font-disp text-[20px] font-semibold text-text">{title}</h1>
      {subtitle ? <p className="mt-1 text-[13px] text-dim">{subtitle}</p> : null}
    </div>
  );
}

export function ErrorBanner({ message }: { message?: string | null }) {
  if (!message) return null;
  return (
    <div
      className="mb-4 flex items-start gap-2 rounded-md border px-3 py-2.5 text-[12.5px]"
      style={{
        background: 'color-mix(in srgb, var(--red) 7%, transparent)',
        borderColor: 'color-mix(in srgb, var(--red) 40%, transparent)',
        color: 'var(--red)',
      }}
      role="alert"
    >
      <AlertCircle size={15} className="mt-px shrink-0" />
      <span>{message}</span>
    </div>
  );
}

export function OrDivider() {
  return (
    <div className="my-4 flex items-center gap-3">
      <span className="h-px flex-1" style={{ background: 'var(--hair)' }} />
      <span className="font-mono text-[9.5px] uppercase tracking-[0.18em] text-faint">or</span>
      <span className="h-px flex-1" style={{ background: 'var(--hair)' }} />
    </div>
  );
}
