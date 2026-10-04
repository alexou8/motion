import { describe, expect, it } from 'vitest';
import { dueDateLabel, relativeDue } from './dueLabel';

describe('deadline labels', () => {
  it('uses calendar days across midnight rather than rounding elapsed hours', () => {
    expect(
      relativeDue(
        '2026-09-17T04:01:00.000Z',
        new Date('2026-09-17T03:59:00.000Z'),
        'America/Toronto',
      ),
    ).toBe('Due tomorrow');
    expect(
      relativeDue(
        '2026-09-18T03:59:00.000Z',
        new Date('2026-09-17T04:01:00.000Z'),
        'America/Toronto',
      ),
    ).toBe('Due today');
  });

  it('uses calendar days across DST and labels elapsed same-day deadlines honestly', () => {
    expect(
      relativeDue(
        '2026-03-09T04:01:00.000Z',
        new Date('2026-03-08T05:01:00.000Z'),
        'America/Toronto',
      ),
    ).toBe('Due tomorrow');
    expect(
      relativeDue(
        '2026-09-17T15:00:00.000Z',
        new Date('2026-09-17T16:00:00.000Z'),
        'America/Toronto',
      ),
    ).toBe('Overdue today');
  });

  it('shows the clock time and zone only for a known time', () => {
    const due = { iso: '2026-09-17T16:00:00.000Z', timeAssumed: false };
    expect(dueDateLabel(due, 'America/Toronto')).toMatch(/12:00.*EDT/);
    expect(dueDateLabel({ ...due, timeAssumed: true }, 'America/Toronto')).not.toMatch(/12:00|EDT/);
    expect(dueDateLabel({ iso: null, timeAssumed: true }, 'UTC')).toBe('an unparsed date');
  });
});
