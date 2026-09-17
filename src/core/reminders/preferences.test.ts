import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_REMINDER_PREFERENCES,
  loadReminderPreferences,
  parseReminderPreferences,
  REMINDER_PREFERENCES_KEY,
  updateReminderPreferences,
  type ReminderStorageArea,
} from './preferences';

describe('reminder preferences', () => {
  it('defaults to disabled with the standard matrix and quiet hours', () => {
    expect(parseReminderPreferences(undefined)).toEqual(DEFAULT_REMINDER_PREFERENCES);
    expect(DEFAULT_REMINDER_PREFERENCES.enabled).toBe(false);
    expect(DEFAULT_REMINDER_PREFERENCES.quietHours).toEqual({ start: '23:00', end: '08:00' });
  });

  it('fails closed when stored preferences are malformed', () => {
    expect(parseReminderPreferences({ enabled: true, quietHours: { start: 'soon', end: '08:00' } }).enabled).toBe(false);
  });

  it('validates reads and writes through the storage boundary', async () => {
    const values: Record<string, unknown> = {};
    const area: ReminderStorageArea = {
      get: vi.fn(async (key) => ({ [key]: values[key] })),
      set: vi.fn(async (items) => { Object.assign(values, items); }),
    };
    expect((await loadReminderPreferences(area)).enabled).toBe(false);
    const updated = await updateReminderPreferences({ enabled: true }, area);
    expect(updated.enabled).toBe(true);
    expect(values[REMINDER_PREFERENCES_KEY]).toEqual(expect.objectContaining({ enabled: true }));
  });
});
