import type { ReactNode } from 'react';
import { cn } from './cn';

export const calloutVariants = ['info', 'warning', 'blocked', 'restricted'] as const;
export type CalloutVariant = (typeof calloutVariants)[number];

const variantClasses: Record<CalloutVariant, string> = {
  info: 'border-signal text-ink',
  warning: 'border-attention text-ink',
  blocked: 'border-attention text-ink',
  restricted: 'border-edge text-ink',
};

export interface CalloutProps {
  variant: CalloutVariant;
  title?: string;
  children: ReactNode;
  className?: string;
}

export function Callout({ variant, title, children, className }: CalloutProps) {
  return (
    <aside className={cn('rounded border-l-4 bg-surface px-3 py-2 text-sm', variantClasses[variant], className)}>
      {title ? <h2 className="mb-1 font-medium text-balance">{title}</h2> : null}
      <div className="text-pretty">{children}</div>
    </aside>
  );
}
