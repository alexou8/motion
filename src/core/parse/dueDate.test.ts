import { describe, expect, it } from 'vitest';
import { parseDueDate } from './dueDate';

const now = new Date('2025-01-10T12:00:00.000Z');

describe('parseDueDate', () => {
  it.each([
    ['Due on Oct 14, 2025 11:59 PM', '2025-10-15T03:59:00.000Z', false, 'high'],
    ['Available until Friday, October 14, 2025', '2025-10-14T04:00:00.000Z', true, 'medium'],
    ['2025-10-14', '2025-10-14T04:00:00.000Z', true, 'medium'],
    ['14 October 2025', '2025-10-14T04:00:00.000Z', true, 'medium'],
    // Read on Jan 10, 2025: last October is three months back, next October
    // nine months ahead, so the nearest occurrence is the previous year's.
    ['Oct 14', '2024-10-14T04:00:00.000Z', true, 'medium'],
  ])('%s parses with the expected certainty', (raw, iso, timeAssumed, confidence) => {
    const result = parseDueDate(raw, now, 'America/Toronto');
    expect(result).toMatchObject({ raw, iso, timeAssumed, confidence, zoneEvidence: 'assumed-local', timeZone: 'America/Toronto' });
  });

  it('retains ambiguous numeric dates but marks them low confidence', () => {
    const raw = '10/14/2025';
    expect(parseDueDate(raw, now, 'America/Toronto')).toMatchObject({ raw, iso: '2025-10-14T04:00:00.000Z', confidence: 'low', zoneEvidence: 'assumed-local' });
  });

  it('chooses the nearest year when the source omits one', () => {
    const result = parseDueDate('Oct 14', new Date('2025-12-20T12:00:00.000Z'), 'America/Toronto');
    expect(result.iso).toBe('2025-10-14T04:00:00.000Z');
    expect(result.confidence).toBe('medium');
  });

  it('rolls a year-less January date forward when read in late December', () => {
    const result = parseDueDate('Due Jan 5 11:59 PM', new Date('2025-12-20T12:00:00.000Z'), 'America/Toronto');
    expect(result.iso).toBe('2026-01-06T04:59:00.000Z');
  });

  it('rolls a year-less December date back when read in early January', () => {
    const result = parseDueDate('Due Dec 15', new Date('2026-01-05T12:00:00.000Z'), 'America/Toronto');
    expect(result.iso).toBe('2025-12-15T05:00:00.000Z');
  });

  it('keeps the current year for a year-less date read mid-year', () => {
    const result = parseDueDate('Due Jul 20', new Date('2025-06-15T12:00:00.000Z'), 'America/Toronto');
    expect(result.iso).toBe('2025-07-20T04:00:00.000Z');
  });

  it('treats slash-separated words as prose, not an IANA zone, and still reads the date', () => {
    const raw = 'Due Oct 14 11:59 PM (Pass/Fail) and/or later';
    const result = parseDueDate(raw, new Date('2025-09-01T12:00:00.000Z'), 'America/Toronto');
    expect(result).toMatchObject({ raw, iso: '2025-10-15T03:59:00.000Z', zoneEvidence: 'assumed-local', timeZone: 'America/Toronto', confidence: 'medium' });
  });

  it('still honours a real IANA zone that follows slash-separated prose', () => {
    const result = parseDueDate('Due Oct 14 11:59 PM (Pass/Fail) America/Vancouver', new Date('2025-09-01T12:00:00.000Z'), 'America/Toronto');
    expect(result).toMatchObject({ iso: '2025-10-15T06:59:00.000Z', zoneEvidence: 'explicit', timeZone: 'America/Vancouver' });
  });

  it('does not throw when the assumed local zone is unknown to the runtime', () => {
    expect(() => parseDueDate('Due Oct 14', now, 'Pass/Fail')).not.toThrow();
    expect(parseDueDate('Due Oct 14', now, 'Pass/Fail')).toMatchObject({ iso: null, confidence: 'low' });
  });

  it.each([
    ['2025-10-14T23:59:00Z', '2025-10-14T23:59:00.000Z', 'UTC'],
    ['2025-10-14T23:59:00.000Z', '2025-10-14T23:59:00.000Z', 'UTC'],
    ['2025-10-14T23:59:00-04:00', '2025-10-15T03:59:00.000Z', 'UTC-04:00'],
  ])('reads the ISO datetime %s from a <time datetime> attribute', (raw, iso, timeZone) => {
    expect(parseDueDate(raw, now, 'America/Toronto')).toMatchObject({ raw, iso, zoneEvidence: 'explicit', timeZone, timeAssumed: false, confidence: 'high' });
  });

  it('rejects impossible calendar dates without throwing', () => {
    expect(parseDueDate('February 31, 2025', now, 'America/Toronto')).toMatchObject({ iso: null, confidence: 'low', zoneEvidence: 'none' });
  });

  it('uses explicit offsets as evidence instead of the assumed local zone', () => {
    expect(parseDueDate('October 14, 2025 11:59 PM UTC-04:00', now, 'UTC')).toMatchObject({ iso: '2025-10-15T03:59:00.000Z', zoneEvidence: 'explicit', timeZone: 'UTC-04:00', confidence: 'high' });
  });

  it('resolves a clock time across a DST boundary in the supplied IANA zone', () => {
    const result = parseDueDate('March 9, 2025 3:30 AM', now, 'America/New_York');
    expect(result.iso).toBe('2025-03-09T07:30:00.000Z');
    expect(result.zoneEvidence).toBe('assumed-local');
  });

  it('returns none when no date can be found and keeps raw text byte-for-byte', () => {
    const raw = '  not a date  ';
    expect(parseDueDate(raw, now, 'UTC')).toEqual({ iso: null, raw, zoneEvidence: 'none', timeAssumed: false, confidence: 'low' });
  });
});
