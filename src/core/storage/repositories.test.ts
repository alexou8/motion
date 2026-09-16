import { beforeEach, describe, expect, it } from 'vitest';
import { adoptTab, agentSessionSchema, appendMessage, excludeSource, releaseTab } from '@/core/session';
import { deleteDatabase, openDatabase } from './db';
import { sessionRepository, updateSession } from './repositories';

const DB = 'motion-session-cas-test';
const NOW = '2026-09-16T12:00:00.000Z';

function session() {
  return agentSessionSchema.parse({
    id: 'session-1',
    title: 'Synthetic session',
    goal: 'Test concurrent session updates',
    createdAt: NOW,
    updatedAt: NOW,
  });
}

beforeEach(async () => {
  await deleteDatabase(DB);
});

describe('updateSession', () => {
  it('defaults revision to zero and increments it inside the write transaction', async () => {
    const db = await openDatabase(DB);
    await sessionRepository(db).put(session());

    const updated = await updateSession(db, 'session-1', (current) => ({
      ...appendMessage(current, { id: 'm1', role: 'student', text: 'Hello' }, NOW),
      updatedAt: NOW,
    }));

    expect(updated?.revision).toBe(1);
    expect(updated?.conversation.at(-1)?.text).toBe('Hello');
    expect((await sessionRepository(db).get('session-1'))?.revision).toBe(1);
    db.close();
  });

  it('serializes concurrent mutations without losing either update', async () => {
    const db = await openDatabase(DB);
    await sessionRepository(db).put(session());

    const [first, second] = await Promise.all([
      updateSession(db, 'session-1', (current) =>
        appendMessage(current, { id: 'm1', role: 'student', text: 'First' }, NOW),
      ),
      updateSession(db, 'session-1', (current) =>
        appendMessage(current, { id: 'm2', role: 'student', text: 'Second' }, NOW),
      ),
    ]);

    const stored = await sessionRepository(db).get('session-1');
    expect(first?.revision).toBe(1);
    expect(second?.revision).toBe(2);
    expect(stored?.revision).toBe(2);
    expect(stored?.conversation.map((entry) => entry.id)).toEqual(['m1', 'm2']);
    db.close();
  });

  it('preserves the student release when adopt and release events race', async () => {
    const db = await openDatabase(DB);
    await sessionRepository(db).put(agentSessionSchema.parse({
      ...session(),
      workspace: { ownedTabIds: [], adoptedTabIds: [7], releasedTabIds: [] },
    }));

    await Promise.all([
      updateSession(db, 'session-1', (current) => releaseTab(current, 7, 'Student released tab 7.', NOW)),
      updateSession(db, 'session-1', (current) => adoptTab(current, 7, NOW)),
    ]);

    const stored = await sessionRepository(db).get('session-1');
    expect(stored?.workspace.adoptedTabIds).not.toContain(7);
    expect(stored?.workspace.releasedTabIds).toContain(7);
    db.close();
  });

  it('preserves source exclusion and a concurrent conversation message', async () => {
    const db = await openDatabase(DB);
    await sessionRepository(db).put(agentSessionSchema.parse({
      ...session(),
      context: { sources: [{ url: 'https://lms.example.test/page', title: 'Page', kind: 'reading', excluded: false, provenance: 'observed' }] },
    }));

    await Promise.all([
      updateSession(db, 'session-1', (current) => excludeSource(current, 'https://lms.example.test/page', NOW)),
      updateSession(db, 'session-1', (current) => appendMessage(current, { id: 'm-race', role: 'student', text: 'Keep my message' }, NOW)),
    ]);

    const stored = await sessionRepository(db).get('session-1');
    expect(stored?.context.sources[0]?.excluded).toBe(true);
    expect(stored?.conversation.at(-1)?.id).toBe('m-race');
    db.close();
  });

  it('aborts when the mutator returns null and leaves the record unchanged', async () => {
    const db = await openDatabase(DB);
    await sessionRepository(db).put(session());

    await expect(updateSession(db, 'session-1', () => null)).resolves.toBeNull();
    expect((await sessionRepository(db).get('session-1'))?.revision).toBe(0);
    db.close();
  });
});
