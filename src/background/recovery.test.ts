import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LEASE_ALARM_PREFIX,
  RETRY_ALARM_PREFIX,
  scheduleLeaseAlarm,
  scheduleRetryAlarm,
} from './recovery';

describe('workflow recovery alarms', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function stubAlarms() {
    const create = vi.fn(async () => undefined);
    vi.stubGlobal('chrome', { alarms: { create } });
    return create;
  }

  it('keeps a future retry time unchanged', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-18T12:00:00.000Z'));
    const create = stubAlarms();
    const retryAt = new Date('2026-09-18T12:05:00.000Z');

    scheduleRetryAlarm('workflow-1', retryAt);

    expect(create).toHaveBeenCalledWith(`${RETRY_ALARM_PREFIX}workflow-1`, {
      when: retryAt.getTime(),
    });
  });

  it('moves an overdue retry to Chrome alarms minimum delay', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-18T12:00:00.000Z'));
    const create = stubAlarms();

    scheduleRetryAlarm('workflow-2', new Date('2026-09-18T11:59:00.000Z'));

    expect(create).toHaveBeenCalledWith(`${RETRY_ALARM_PREFIX}workflow-2`, {
      when: new Date('2026-09-18T12:01:00.000Z').getTime(),
    });
  });

  it('schedules lease recovery just after the lease expires', () => {
    const create = stubAlarms();
    const expiresAt = new Date('2026-09-18T12:05:00.000Z');

    scheduleLeaseAlarm('workflow-3', expiresAt);

    expect(create).toHaveBeenCalledWith(`${LEASE_ALARM_PREFIX}workflow-3`, {
      when: expiresAt.getTime() + 1_000,
    });
  });
});
