import { describe, expect, it } from 'vitest';
import { deleteDatabase, getAllRecords, openDatabase, putRecord } from './db';
import { courseLinkRepository, sessionRepository } from './repositories';
import { DB_VERSION, STORE } from './schema';
import { courseSchema } from '../domain';

const NAME = 'motion-test-v2';

const NOW = '2026-03-02T12:00:00.000Z';

function course() {
  return courseSchema.parse({
    id: 'd2l:1',
    platformId: 'd2l',
    name: 'Database II',
    code: 'CP363',
    lastVerifiedAt: NOW,
    archived: false,
  });
}

describe('DB_VERSION 2 migration', () => {
  it('adds sessions and courseLinks stores with their indexes', async () => {
    await deleteDatabase(NAME);
    const db = await openDatabase(NAME);
    expect(db.version).toBe(DB_VERSION);
    expect(db.objectStoreNames.contains(STORE.sessions)).toBe(true);
    expect(db.objectStoreNames.contains(STORE.courseLinks)).toBe(true);

    const sessions = db.transaction(STORE.sessions, 'readonly').objectStore(STORE.sessions);
    expect([...sessions.indexNames]).toEqual(
      expect.arrayContaining(['byStatus', 'byUpdatedAt', 'byCourse']),
    );

    const courseLinks = db.transaction(STORE.courseLinks, 'readonly').objectStore(STORE.courseLinks);
    expect([...courseLinks.indexNames]).toEqual(expect.arrayContaining(['byCourse', 'byTask']));
    db.close();
  });

  it('is idempotent: opening twice at the current version does not error or duplicate stores', async () => {
    const first = await openDatabase(NAME);
    first.close();
    const second = await openDatabase(NAME);
    expect(second.objectStoreNames.contains(STORE.sessions)).toBe(true);
    second.close();
  });

  it('migrating a v1 database preserves existing data and adds the new stores', async () => {
    await deleteDatabase(NAME);
    // Simulate an existing installation at v1 with real data.
    const v1 = await openDatabase(NAME, 1);
    await putRecord(v1, STORE.courses, course());
    v1.close();

    const upgraded = await openDatabase(NAME, DB_VERSION);
    expect(upgraded.version).toBe(DB_VERSION);
    expect(upgraded.objectStoreNames.contains(STORE.sessions)).toBe(true);
    expect(upgraded.objectStoreNames.contains(STORE.courseLinks)).toBe(true);

    const courses = await getAllRecords(upgraded, STORE.courses);
    expect(courses).toHaveLength(1);
    upgraded.close();
  });

  it('sessionRepository and courseLinkRepository round-trip validated records', async () => {
    const db = await openDatabase(NAME);
    const sessions = sessionRepository(db);
    await sessions.put({
      id: 's1',
      title: 'CP363 · Assignment 2',
      goal: 'Work on Assignment 2',
      courseId: 'd2l:1',
      taskId: null,
      status: 'active',
      createdAt: NOW,
      updatedAt: NOW,
      workspace: {
        groupId: null,
        groupTitle: '',
        sessionKey: null,
        ownedTabIds: [],
        adoptedTabIds: [],
        releasedTabIds: [],
      },
      plan: { steps: [], currentStepId: null },
      blockers: [],
      context: { sources: [] },
      artifacts: [],
      agent: { providerId: null, model: null },
      conversation: [],
      activity: [],
      workflowIds: [],
      pendingModelRequest: null,
    });
    expect((await sessions.get('s1'))?.title).toBe('CP363 · Assignment 2');
    const byCourse = await sessions.byIndex('byCourse', 'd2l:1');
    expect(byCourse.records).toHaveLength(1);

    const links = courseLinkRepository(db);
    await links.put({
      id: 'cl_1',
      courseId: 'd2l:1',
      taskId: null,
      from: { kind: 'course', id: 'd2l:1' },
      relation: 'has-module',
      to: { kind: 'page', url: 'https://lms.example.com/module1', title: 'Module 1' },
      confidence: 'medium',
      provenance: {
        sourceUrl: 'https://lms.example.com/home',
        pageTitle: '',
        platformId: 'd2l',
        pageType: 'course-home',
        capturedAt: NOW,
        extractionVersion: 1,
      },
      userOverride: null,
    });
    expect((await links.byIndex('byCourse', 'd2l:1')).records).toHaveLength(1);
    db.close();
  });
});
