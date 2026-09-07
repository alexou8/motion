import { cn } from './cn';

export const markerStates = ['done', 'active', 'pending', 'skipped', 'blocked', 'failed'] as const;
export type MarkerState = (typeof markerStates)[number];

const markerLabels: Record<MarkerState, string> = {
  done: 'Done',
  active: 'Active now',
  pending: 'Pending',
  skipped: 'Skipped',
  blocked: 'Blocked, waiting on you',
  failed: 'Failed',
};

export interface StatusMarkerProps {
  state: MarkerState;
  label?: string;
  className?: string;
}

export function StatusMarker({ state, label = markerLabels[state], className }: StatusMarkerProps) {
  return (
    <span
      className={cn('motion-marker size-4', `motion-marker-${state}`, className)}
      role="img"
      aria-label={label}
      data-state={state}
    />
  );
}
