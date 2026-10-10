import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FixedNowContext, useNow } from './useNow';

function Clock({ interval, enabled }: { interval: number; enabled?: boolean }) {
  return <p>{useNow(interval, enabled).toISOString()}</p>;
}

describe('useNow', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-16T12:00:00.000Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('ticks on its interval and stops when unmounted', () => {
    const { unmount } = render(<Clock interval={1_000} />);
    expect(screen.getByText('2026-09-16T12:00:00.000Z')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(3_000));
    expect(screen.getByText('2026-09-16T12:00:03.000Z')).toBeInTheDocument();
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not tick while disabled', () => {
    render(<Clock interval={1_000} enabled={false} />);
    act(() => vi.advanceTimersByTime(5_000));
    expect(screen.getByText('2026-09-16T12:00:00.000Z')).toBeInTheDocument();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('returns a fixed clock without scheduling timers', () => {
    render(
      <FixedNowContext.Provider value={new Date('2026-01-01T00:00:00.000Z')}>
        <Clock interval={1_000} />
      </FixedNowContext.Provider>,
    );
    act(() => vi.advanceTimersByTime(5_000));
    expect(screen.getByText('2026-01-01T00:00:00.000Z')).toBeInTheDocument();
    expect(vi.getTimerCount()).toBe(0);
  });
});
