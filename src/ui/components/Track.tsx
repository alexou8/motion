import type { ReactNode } from 'react';
import { cn } from './cn';
import { type MarkerState, StatusMarker } from './StatusMarker';

export interface TrackProps {
  children: ReactNode;
  className?: string;
  label?: string;
}

export function Track({ children, className, label = 'Progress track' }: TrackProps) {
  return (
    <ol className={cn('motion-track', className)} aria-label={label}>
      {children}
    </ol>
  );
}

export interface TrackItemProps {
  state: MarkerState;
  title: string;
  children?: ReactNode;
  className?: string;
  markerLabel?: string;
}

export function TrackItem({ state, title, children, className, markerLabel }: TrackItemProps) {
  return (
    <li className={cn('motion-track-item', className)}>
      <StatusMarker state={state} label={markerLabel} />
      <div className="min-w-0 pb-4">
        <h3 className="text-md font-medium text-ink text-pretty">{title}</h3>
        {children}
      </div>
    </li>
  );
}
