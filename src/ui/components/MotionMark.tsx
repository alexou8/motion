import type { HTMLAttributes } from 'react';
import { cn } from './cn';

/** The canonical rising M keeps its purple-and-gold identity in every surface. */
export function MotionMark({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return <span {...props} aria-hidden="true" className={cn('motion-brand-mark', className)} />;
}
