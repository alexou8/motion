import { createContext, useContext, useEffect, useState } from 'react';

/**
 * A fixed clock for tests and previews. When provided, {@link useNow} returns
 * it and never ticks, so a rendered relative time is deterministic.
 */
export const FixedNowContext = createContext<Date | undefined>(undefined);

/**
 * The current time, re-read every `intervalMs` while `enabled`, so relative
 * copy ("Retrying in 12s", "read just now") keeps moving between worker
 * updates. The interval is cleared on unmount and whenever it is disabled.
 */
export function useNow(intervalMs: number, enabled = true): Date {
  const fixed = useContext(FixedNowContext);
  const [now, setNow] = useState(() => new Date());
  const ticking = enabled && fixed === undefined;
  useEffect(() => {
    if (!ticking) return;
    setNow(new Date());
    const timer = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs, ticking]);
  return fixed ?? now;
}
