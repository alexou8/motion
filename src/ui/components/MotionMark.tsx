import { cn } from './cn';

/** The Motion mark is a single continuous coursework path, shaped as an M. */
export function MotionMark({ className }: { className?: string }) {
  return <span aria-hidden="true" className={cn('motion-brand-mark', className)} />;
}
