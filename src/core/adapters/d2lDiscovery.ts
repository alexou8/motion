import { z } from 'zod';
import { courseSchema, courseTaskSchema, type Course, type CourseTask, type TaskKind } from '../domain';
import { d2lTaskId } from './d2l';
import { EXTRACTION_VERSION } from '../domain/provenance';

/**
 * Brightspace documents `/d2l/api/lp/(version)/enrollments/myenrollments/`
 * and `/d2l/api/le/(version)/(orgUnitId)/calendar/events/myEvents/` as GET
 * routes: https://docs.valence.desire2learn.com/http-routingtable.html
 */
export const discoveryRunResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('success'), courses: z.array(courseSchema).max(200), tasks: z.array(courseTaskSchema).max(100_000), scannedAt: z.string().datetime() }),
  z.object({ kind: z.literal('blocked'), message: z.string().min(1) }),
  z.object({ kind: z.literal('refused'), message: z.string().min(1) }),
  z.object({ kind: z.literal('error'), message: z.string().min(1) }),
]);
export type DiscoveryRunResult = z.infer<typeof discoveryRunResultSchema>;

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue | null => typeof value === 'object' && value !== null && !Array.isArray(value) ? value as RecordValue : null;
const string = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim() : null;
const numberString = (value: unknown): string | null => typeof value === 'number' || typeof value === 'string' ? String(value) : null;
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : record(value)?.Items as unknown[] ?? record(value)?.Objects as unknown[] ?? [];

export function versionsForDiscovery(value: unknown): { lp: string; le: string } | null {
  const rows = list(value);
  const versionFor = (code: string) => rows.find((item) => {
    const row = record(item);
    return string(row?.ProductCode)?.toLowerCase() === code;
  });
  const version = (item: unknown) => string(record(item)?.LatestVersion) ?? string(record(item)?.Version);
  const lp = version(versionFor('lp'));
  const le = version(versionFor('le'));
  return lp && le ? { lp, le } : null;
}

/**
 * `MyOrgUnitInfo.Access` carries `IsActive` and `CanAccess`; a top-level
 * `IsActive` is not part of the documented shape but is tolerated as a
 * fallback for simplified fixtures/hosts.
 * https://docs.valence.desire2learn.com/res/enroll.html#Enrollment.MyOrgUnitInfo
 */
export function coursesFromEnrollments(value: unknown, origin: string, now: Date): Course[] {
  const capturedAt = now.toISOString();
  return list(value).flatMap((item) => {
    const row = record(item);
    const unit = record(row?.OrgUnit) ?? row;
    const id = numberString(unit?.Id ?? unit?.OrgUnitId);
    const name = string(unit?.Name);
    const access = record(row?.Access ?? unit?.Access);
    const active = access?.IsActive ?? row?.IsActive ?? unit?.IsActive;
    const canAccess = access?.CanAccess;
    if (!id || !name || active !== true || canAccess !== true) return [];
    const code = string(unit?.Code);
    return [{ id: `d2l:${id}`, platformId: 'd2l', name, ...(code ? { code } : {}), homeUrl: new URL(`/d2l/home/${id}`, origin).toString(), externalId: id, lastVerifiedAt: capturedAt, archived: false }];
  });
}

export function taskKindForD2LEntity(entityType: unknown): TaskKind {
  const value = string(entityType)?.toLowerCase() ?? '';
  if (value.includes('dropbox')) return 'assignment';
  if (value.includes('quizzing') || value.includes('quiz')) return 'quiz';
  if (value.includes('discussion')) return 'discussion';
  if (value.includes('content')) return 'content';
  return 'other';
}

function apiTask(row: RecordValue, course: Course, sourceUrl: string, now: Date): CourseTask | null {
  const title = string(row.Title ?? row.Name);
  const dueRaw = string(row.EndDateTime ?? row.DueDate);
  if (!title || !dueRaw) return null;
  const dueDate = new Date(dueRaw);
  if (!Number.isFinite(dueDate.getTime())) return null;
  const entity = record(row.AssociatedEntity);
  const kind = taskKindForD2LEntity(entity?.AssociatedEntityType ?? row.AssociatedEntityType);
  const entityId = numberString(entity?.AssociatedEntityId ?? row.FolderId ?? row.CalendarEventId ?? row.Id);
  if (!entityId) return null;
  const capturedAt = now.toISOString();
  return {
    id: d2lTaskId(course.externalId ?? course.id.replace(/^d2l:/, ''), kind, entityId), courseId: course.id, title, kind,
    due: { iso: dueDate.toISOString(), raw: dueRaw, zoneEvidence: /(?:Z|[+-]\d\d:\d\d)$/i.test(dueRaw) ? 'explicit' : 'none', timeAssumed: false, confidence: 'high', lastObservedAt: capturedAt },
    dueHistory: [], dueConflict: null, status: row.IsCompleted === true || row.IsSubmitted === true ? 'submitted' : 'todo', weight: null,
    provenance: { sourceUrl, pageTitle: 'D2L calendar', platformId: 'd2l', pageType: 'calendar', capturedAt, extractionVersion: EXTRACTION_VERSION, strategy: 'lms-api' },
    corrections: [], studentEdited: false, manual: false, archived: false, createdAt: capturedAt, updatedAt: capturedAt,
  };
}

/**
 * Valence's `Calendar.EventDataInfo.EventType` is the numeric `EVENTTYPE_T`
 * enum (1 Reminder, 2 AvailabilityStarts, 3 AvailabilityEnds, 4 UnlockStarts,
 * 5 UnlockEnds, 6 DueDate) — not a string. We still accept the equivalent
 * string names defensively, in case a host or fixture sends the readable form.
 * https://docs.valence.desire2learn.com/res/calendar.html#Calendar.EventDataInfo
 */
const EVENT_TYPE_DUE_DATE = 6;
const EVENT_TYPE_AVAILABILITY_ENDS = 3;
const EVENT_TYPE_UNLOCK_ENDS = 5;

function eventTypeName(row: RecordValue): string {
  const raw = row.EventType;
  if (typeof raw === 'number') {
    if (raw === EVENT_TYPE_DUE_DATE) return 'duedate';
    if (raw === EVENT_TYPE_AVAILABILITY_ENDS) return 'availabilityends';
    if (raw === EVENT_TYPE_UNLOCK_ENDS) return 'unlockends';
    return String(raw);
  }
  return string(raw)?.toLowerCase() ?? '';
}

export function tasksFromCalendarEvents(value: unknown, course: Course, sourceUrl: string, now: Date): CourseTask[] {
  const preference = (row: RecordValue): number => {
    const type = eventTypeName(row);
    if (type.includes('duedate') || type === 'due') return 3;
    if (type.includes('enddate') || type.includes('availabilityends') || type.includes('unlockends')) return 2;
    return 0;
  };
  const chosen = new Map<string, { task: CourseTask; preference: number }>();
  for (const item of list(value)) {
    const row = record(item);
    if (!row || !record(row.AssociatedEntity)) continue;
    const rank = preference(row);
    if (rank === 0) continue;
    const task = apiTask(row, course, sourceUrl, now);
    if (!task) continue;
    const existing = chosen.get(task.id);
    if (!existing || rank > existing.preference) chosen.set(task.id, { task, preference: rank });
  }
  return [...chosen.values()].map(({ task }) => task);
}

/** Dropbox `DueDate` is a UTCDateTime in Valence's Dropbox resource. */
export function tasksFromDropboxFolders(value: unknown, course: Course, sourceUrl: string, now: Date): CourseTask[] {
  return list(value).flatMap((item) => {
    const row = record(item);
    return row ? (() => {
      const task = apiTask({ ...row, AssociatedEntityType: 'D2L.LE.Dropbox.Dropbox', AssociatedEntityId: row.FolderId }, course, sourceUrl, now);
      return task ? [task] : [];
    })() : [];
  });
}
