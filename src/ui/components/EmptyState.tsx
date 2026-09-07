import { useId, type ReactNode } from 'react';
import { Button } from './Button';

export interface EmptyStateProps {
  title: string;
  children: ReactNode;
  actionLabel: string;
  onAction: () => void;
}

export function EmptyState({ title, children, actionLabel, onAction }: EmptyStateProps) {
  const titleId = useId();
  return (
    <section className="grid gap-3 rounded border border-rule bg-surface p-4" aria-labelledby={titleId}>
      <div>
        <h2 className="text-md font-medium text-balance" id={titleId}>
          {title}
        </h2>
        <p className="mt-1 text-sm text-ink-muted text-pretty">{children}</p>
      </div>
      <div>
        <Button variant="primary" onClick={onAction}>
          {actionLabel}
        </Button>
      </div>
    </section>
  );
}
