import { z } from 'zod';

/** The notification lead times exposed by the Reminders settings. */
export const REMINDER_OFFSETS = ['2d', 'morning', '2h'] as const;
export type ReminderOffset = (typeof REMINDER_OFFSETS)[number];

/** Built-in rows for the settings matrix. The planner also accepts future kinds. */
export const REMINDER_KINDS = ['assignment', 'quiz', 'discussion', 'other'] as const;
export type ReminderKind = (typeof REMINDER_KINDS)[number];

export const reminderOffsetPreferencesSchema = z.object({
  '2d': z.boolean(),
  morning: z.boolean(),
  '2h': z.boolean(),
});

export const quietHoursSchema = z.object({
  start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
});

export const reminderPreferencesSchema = z.object({
  enabled: z.boolean(),
  /** A record keeps this forward-compatible with new TaskKind values. */
  offsets: z.record(reminderOffsetPreferencesSchema),
  quietHours: quietHoursSchema,
});
export type ReminderPreferences = z.infer<typeof reminderPreferencesSchema>;

export const DEFAULT_REMINDER_PREFERENCES: ReminderPreferences = {
  enabled: false,
  offsets: {
    assignment: { '2d': true, morning: true, '2h': true },
    quiz: { '2d': true, morning: true, '2h': true },
    discussion: { '2d': true, morning: true, '2h': true },
    other: { '2d': true, morning: true, '2h': true },
  },
  quietHours: { start: '23:00', end: '08:00' },
};

export const REMINDER_PREFERENCES_KEY = 'motion.reminderPreferences';
export const SENT_REMINDERS_KEY = 'motion.reminders.sent';

/**
 * Stored preferences are untrusted extension data. Invalid data fails closed
 * to the opt-in default rather than enabling notifications accidentally.
 */
export function parseReminderPreferences(value: unknown): ReminderPreferences {
  const parsed = reminderPreferencesSchema.safeParse(value);
  return parsed.success ? parsed.data : DEFAULT_REMINDER_PREFERENCES;
}

export interface ReminderStorageArea {
  get(keys: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export async function loadReminderPreferences(
  area: ReminderStorageArea,
): Promise<ReminderPreferences> {
  const raw = (await area.get(REMINDER_PREFERENCES_KEY))[REMINDER_PREFERENCES_KEY];
  return parseReminderPreferences(raw);
}

export async function saveReminderPreferences(
  preferences: ReminderPreferences,
  area: ReminderStorageArea,
): Promise<void> {
  await area.set({ [REMINDER_PREFERENCES_KEY]: reminderPreferencesSchema.parse(preferences) });
}

export async function updateReminderPreferences(
  patch: Partial<ReminderPreferences>,
  area: ReminderStorageArea,
): Promise<ReminderPreferences> {
  const current = await loadReminderPreferences(area);
  const next = reminderPreferencesSchema.parse({ ...current, ...patch });
  await saveReminderPreferences(next, area);
  return next;
}
