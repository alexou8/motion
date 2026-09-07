export interface SkeletonRowProps {
  label?: string;
}

export function SkeletonRow({ label = 'Loading row' }: SkeletonRowProps) {
  return (
    <div className="motion-skeleton-row grid min-h-12 items-center gap-3 rounded border border-rule bg-surface p-3" aria-label={label}>
      <span className="size-3 rounded-full border-2 border-edge" aria-hidden="true" />
      <span className="grid gap-2" aria-hidden="true">
        <span className="block h-3 w-3/4 rounded-sm bg-sunken" />
        <span className="block h-2 w-1/2 rounded-sm bg-sunken" />
      </span>
    </div>
  );
}
