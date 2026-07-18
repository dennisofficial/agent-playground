import { cn } from '@/lib/cn';
import type { HTMLAttributes } from 'react';

/** Surface panel with the design card shadow + hairline border. */
export function Card({ className, style, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('rounded-lg border border-border bg-surface', className)}
      style={{ boxShadow: 'var(--shadow-card)', ...style }}
      {...rest}
    />
  );
}
