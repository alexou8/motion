import type { HTMLAttributes } from 'react';
import { cn } from './cn';

/** The canonical continuous M follows the semantic accent in every surface. */
export function MotionMark({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return <span {...props} aria-hidden="true" className={cn('motion-brand-mark', className)} />;
}
