import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { coursesFromEnrollments, tasksFromCalendarEvents, tasksFromDropboxFolders, versionsForDiscovery } from './d2lDiscovery';

const json = (name: string) => JSON.parse(readFileSync(resolve(process.cwd(), `src/test/fixtures/d2l/${name}.json`), 'utf8')) as unknown;
const now = new Date('2026-09-16T12:00:00.000Z');

describe('D2L all-course discovery parsers', () => {
  it('parses active course offerings and API calendar dates with explicit timezone evidence', () => {
    const courses = coursesFromEnrollments(json('discovery-enrollments'), 'https://school.brightspace.com', now);
    const tasks = tasksFromCalendarEvents(json('discovery-calendar-events'), courses[0]!, 'https://school.brightspace.com/d2l/api/le/1.75/101/calendar/events/myEvents/', now);
    expect(courses).toHaveLength(1);
    expect(tasks.map((task) => [task.kind, task.due.zoneEvidence, task.provenance.strategy])).toEqual([['quiz', 'explicit', 'lms-api'], ['discussion', 'explicit', 'lms-api']]);
  });

  it('maps Dropbox folders to assignments', () => {
    const course = coursesFromEnrollments(json('discovery-enrollments'), 'https://school.brightspace.com', now)[0]!;
    expect(tasksFromDropboxFolders(json('discovery-dropbox'), course, 'https://school.brightspace.com/api', now)[0]).toMatchObject({ kind: 'assignment', title: 'Lab 1' });
  });

  it('requires both LP and LE versions instead of guessing a version', () => {
    expect(versionsForDiscovery([{ ProductCode: 'LP', LatestVersion: '1.80' }, { ProductCode: 'LE', LatestVersion: '1.90' }])).toEqual({ lp: '1.80', le: '1.90' });
    expect(versionsForDiscovery([{ ProductCode: 'LP', LatestVersion: '1.80' }])).toBeNull();
  });

  it('reads the documented numeric EVENTTYPE_T code, not a string name (SOL-13/CalendarEventDataInfo)', () => {
    // Valence's real Calendar.EventDataInfo.EventType is the numeric
    // EVENTTYPE_T enum (6 = DueDate, 3 = AvailabilityEnds), not a string:
    // https://docs.valence.desire2learn.com/res/calendar.html#Calendar.EventDataInfo
    // discovery-calendar-events.json now uses that real shape; this inline
    // case pins the availability-vs-due preference against it directly.
    const course = coursesFromEnrollments(json('discovery-enrollments'), 'https://school.brightspace.com', now)[0]!;
    const tasks = tasksFromCalendarEvents({ Items: [
      { Title: 'Quiz 1 available', EventType: 2, EndDateTime: '2026-09-10T12:00:00Z', AssociatedEntity: { AssociatedEntityType: 'D2L.LE.Quizzing.Quiz', AssociatedEntityId: 77 } },
      { Title: 'Quiz 1 due', EventType: 6, EndDateTime: '2026-09-17T12:00:00Z', AssociatedEntity: { AssociatedEntityType: 'D2L.LE.Quizzing.Quiz', AssociatedEntityId: 77 } },
      { Title: 'Quiz 1 reminder', EventType: 1, EndDateTime: '2026-09-16T12:00:00Z', AssociatedEntity: { AssociatedEntityType: 'D2L.LE.Quizzing.Quiz', AssociatedEntityId: 77 } },
    ] }, course, 'https://school.brightspace.com/api', now);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ id: 'd2l:101:quiz:77', due: { iso: '2026-09-17T12:00:00.000Z' } });
  });

  it('uses the associated due event, not availability or array order, and ignores plain events', () => {
    const course = coursesFromEnrollments(json('discovery-enrollments'), 'https://school.brightspace.com', now)[0]!;
    const tasks = tasksFromCalendarEvents({ Items: [
      { Title: 'Quiz 1 available', EventType: 'AvailabilityStarts', EndDateTime: '2026-09-10T12:00:00Z', AssociatedEntity: { AssociatedEntityType: 'D2L.LE.Quizzing.Quiz', AssociatedEntityId: 77 } },
      { Title: 'Lecture', EventType: 'Calendar', EndDateTime: '2026-09-11T12:00:00Z' },
      { Title: 'Quiz 1 due', EventType: 'DueDate', EndDateTime: '2026-09-17T12:00:00Z', AssociatedEntity: { AssociatedEntityType: 'D2L.LE.Quizzing.Quiz', AssociatedEntityId: 77 } },
      { Title: 'Quiz 1 reminder', EventType: 'Reminder', EndDateTime: '2026-09-16T12:00:00Z', AssociatedEntity: { AssociatedEntityType: 'D2L.LE.Quizzing.Quiz', AssociatedEntityId: 77 } },
    ] }, course, 'https://school.brightspace.com/api', now);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ id: 'd2l:101:quiz:77', due: { iso: '2026-09-17T12:00:00.000Z' } });
  });

  it('reads real MyOrgUnitInfo Access fields and rejects inaccessible enrollments', () => {
    const courses = coursesFromEnrollments({ Items: [
      { OrgUnit: { Id: 101, Name: 'Open course', Code: 'OPEN' }, Access: { IsActive: true, CanAccess: true } },
      { OrgUnit: { Id: 102, Name: 'Archived course', Code: 'OLD' }, Access: { IsActive: false, CanAccess: true } },
      { OrgUnit: { Id: 103, Name: 'No access course', Code: 'NOPE' }, Access: { IsActive: true, CanAccess: false } },
    ] }, 'https://school.brightspace.com', now);
    expect(courses.map((course) => course.externalId)).toEqual(['101']);
  });
});
