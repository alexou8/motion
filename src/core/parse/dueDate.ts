import type { Confidence, DueDate } from '@/core/domain';

interface DateParts {
  day: number;
  month: number;
  year: number | null;
}

interface ClockParts {
  hour: number;
  minute: number;
  timeAssumed: boolean;
}

interface ZoneParts {
  evidence: 'explicit' | 'assumed-local';
  offsetMinutes: number | null;
  timeZone: string;
}

const MONTHS: Record<string, number> = {
  january: 1,
  jan: 1,
  february: 2,
  feb: 2,
  march: 3,
  mar: 3,
  april: 4,
  apr: 4,
  may: 5,
  june: 6,
  jun: 6,
  july: 7,
  jul: 7,
  august: 8,
  aug: 8,
  september: 9,
  sep: 9,
  sept: 9,
  october: 10,
  oct: 10,
  november: 11,
  nov: 11,
  december: 12,
  dec: 12,
};

const ZONE_OFFSETS: Record<string, number> = {
  UTC: 0,
  GMT: 0,
  EST: -300,
  EDT: -240,
  CST: -360,
  CDT: -300,
  MST: -420,
  MDT: -360,
  PST: -480,
  PDT: -420,
};

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function isValidDateParts(parts: DateParts): boolean {
  return parts.month >= 1 && parts.month <= 12 && parts.day >= 1 && parts.day <= daysInMonth(parts.year ?? 2000, parts.month);
}

function parseMonth(value: string): number | null {
  return MONTHS[value.toLowerCase()] ?? null;
}

function parseDateParts(text: string): { parts: DateParts | null; confidence: Confidence; found: boolean } {
  const isoMatch = text.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (isoMatch) {
    const [, yearText, monthText, dayText] = isoMatch;
    if (!yearText || !monthText || !dayText) return { parts: null, confidence: 'low', found: true };
    return {
      parts: { year: Number(yearText), month: Number(monthText), day: Number(dayText) },
      confidence: 'high',
      found: true,
    };
  }

  const monthFirst = text.match(
    /\b(January|Jan(?:uary)?|February|Feb(?:ruary)?|March|Mar(?:ch)?|April|Apr(?:il)?|May|June|Jun(?:e)?|July|Jul(?:y)?|August|Aug(?:ust)?|September|Sept?(?:ember)?|October|Oct(?:ober)?|November|Nov(?:ember)?|December|Dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,)?(?:\s+(\d{4}))?\b/i,
  );
  if (monthFirst) {
    const [, monthText, dayText, yearText] = monthFirst;
    const month = monthText ? parseMonth(monthText) : null;
    if (month === null || !dayText) return { parts: null, confidence: 'low', found: true };
    return {
      parts: { year: yearText ? Number(yearText) : null, month, day: Number(dayText) },
      confidence: yearText ? 'high' : 'medium',
      found: true,
    };
  }

  const dayFirst = text.match(
    /\b(\d{1,2})(?:st|nd|rd|th)?\s+(January|Jan(?:uary)?|February|Feb(?:ruary)?|March|Mar(?:ch)?|April|Apr(?:il)?|May|June|Jun(?:e)?|July|Jul(?:y)?|August|Aug(?:ust)?|September|Sept?(?:ember)?|October|Oct(?:ober)?|November|Nov(?:ember)?|December|Dec(?:ember)?)(?:,)?(?:\s+(\d{4}))?\b/i,
  );
  if (dayFirst) {
    const [, dayText, monthText, yearText] = dayFirst;
    const month = monthText ? parseMonth(monthText) : null;
    if (month === null || !dayText) return { parts: null, confidence: 'low', found: true };
    return {
      parts: { year: yearText ? Number(yearText) : null, month, day: Number(dayText) },
      confidence: yearText ? 'high' : 'medium',
      found: true,
    };
  }

  const numeric = text.match(/\b(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})\b/);
  if (numeric) {
    const [, firstText, secondText, yearText] = numeric;
    if (!firstText || !secondText || !yearText) return { parts: null, confidence: 'low', found: true };
    const first = Number(firstText);
    const second = Number(secondText);
    const yearNumber = Number(yearText);
    const year = yearNumber < 100 ? 2000 + yearNumber : yearNumber;
    // There is no locale signal in LMS text. Prefer the only valid ordering and
    // mark both-valid dates low so the UI can ask the student to verify them.
    const monthDayValid = isValidDateParts({ year, month: first, day: second });
    const dayMonthValid = isValidDateParts({ year, month: second, day: first });
    const parts = monthDayValid ? { year, month: first, day: second } : dayMonthValid ? { year, month: second, day: first } : { year, month: first, day: second };
    return { parts, confidence: 'low', found: true };
  }

  return { parts: null, confidence: 'low', found: false };
}

function parseClock(text: string): ClockParts {
  const meridiem = text.match(/\b(\d{1,2})(?::(\d{2}))?\s*(AM|PM)\b/i);
  if (meridiem) {
    const [, hourText, minuteText, periodText] = meridiem;
    let hour = Number(hourText ?? 0);
    const minute = Number(minuteText ?? 0);
    const period = (periodText ?? '').toUpperCase();
    if (period === 'PM' && hour < 12) hour += 12;
    if (period === 'AM' && hour === 12) hour = 0;
    if (hour <= 23 && minute <= 59) return { hour, minute, timeAssumed: false };
  }

  const twentyFourHour = text.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (twentyFourHour) {
    return { hour: Number(twentyFourHour[1] ?? 0), minute: Number(twentyFourHour[2] ?? 0), timeAssumed: false };
  }

  // A date-only value is anchored at local midnight; retaining `timeAssumed`
  // prevents that implementation anchor from being presented as exact.
  return { hour: 0, minute: 0, timeAssumed: true };
}

function parseOffset(value: string): number | null {
  const sign = value.startsWith('-') ? -1 : 1;
  const body = value.slice(1);
  const colonIndex = body.indexOf(':');
  const hoursText = colonIndex >= 0 ? body.slice(0, colonIndex) : body.length > 2 ? body.slice(0, -2) : body;
  const minutesText = colonIndex >= 0 ? body.slice(colonIndex + 1) : body.length > 2 ? body.slice(-2) : '';
  if (!hoursText || (minutesText && minutesText.length !== 2)) return null;
  const hours = Number(hoursText);
  const minutes = Number(minutesText || 0);
  if (hours > 23 || minutes > 59) return null;
  return sign * (hours * 60 + minutes);
}

function parseZone(text: string, assumedTimeZone: string): ZoneParts {
  const offset = text.match(/\b(?:UTC|GMT)\s*([+-]\d{1,2}(?::?\d{2})?)\b/i);
  if (offset?.[1]) {
    const minutes = parseOffset(offset[1]);
    if (minutes !== null) return { evidence: 'explicit', offsetMinutes: minutes, timeZone: `UTC${offset[1]}` };
  }

  if (/\b(?:Z|UTC|GMT)\b/i.test(text)) return { evidence: 'explicit', offsetMinutes: 0, timeZone: 'UTC' };

  const namedZone = text.match(/\b([A-Za-z]+(?:\/[A-Za-z_]+)+)\b/);
  if (namedZone?.[1]) return { evidence: 'explicit', offsetMinutes: null, timeZone: namedZone[1] };

  const abbreviation = text.match(/\b([A-Z]{2,5})\b/g)?.find((candidate) => candidate in ZONE_OFFSETS);
  if (abbreviation) return { evidence: 'explicit', offsetMinutes: ZONE_OFFSETS[abbreviation] ?? 0, timeZone: abbreviation };

  const numericOffset = text.match(/(?<!\d)([+-]\d{2}:?\d{2})(?!\d)/);
  if (numericOffset?.[1]) {
    const minutes = parseOffset(numericOffset[1]);
    if (minutes !== null) return { evidence: 'explicit', offsetMinutes: minutes, timeZone: `UTC${numericOffset[1]}` };
  }

  return { evidence: 'assumed-local', offsetMinutes: null, timeZone: assumedTimeZone };
}

function formatParts(date: Date, timeZone: string): Record<string, number> {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    calendar: 'gregory',
    numberingSystem: 'latn',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const result: Record<string, number> = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== 'literal') result[part.type] = Number(part.value);
  }
  return result;
}

function zoneOffsetAt(instant: number, timeZone: string): number {
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' });
  const zonePart = formatter.formatToParts(new Date(instant)).find((part) => part.type === 'timeZoneName');
  const value = zonePart?.value ?? 'GMT';
  const match = value.match(/^GMT([+-])(\d{2})(?::?(\d{2}))?$/);
  if (!match) return 0;
  return (match[1] === '-' ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3] ?? 0));
}

function localDateToInstant(parts: DateParts, clock: ClockParts, zone: ZoneParts): number | null {
  if (parts.year === null || !isValidDateParts(parts)) return null;
  const localAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, clock.hour, clock.minute);
  if (zone.offsetMinutes !== null) return localAsUtc - zone.offsetMinutes * 60_000;

  try {
    let instant = localAsUtc - zoneOffsetAt(localAsUtc, zone.timeZone) * 60_000;
    instant = localAsUtc - zoneOffsetAt(instant, zone.timeZone) * 60_000;
    const actual = formatParts(new Date(instant), zone.timeZone);
    if (actual.year !== parts.year || actual.month !== parts.month || actual.day !== parts.day || actual.hour !== clock.hour || actual.minute !== clock.minute) return null;
    return instant;
  } catch {
    return null;
  }
}

function nearestYear(parts: DateParts, clock: ClockParts, now: Date, timeZone: string): number {
  const current = formatParts(now, timeZone);
  const currentYear = current.year ?? now.getUTCFullYear();
  const target = Date.UTC(current.year ?? 1970, parts.month, parts.day, clock.hour, clock.minute);
  let bestYear = currentYear;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const year of [currentYear - 1, currentYear, currentYear + 1]) {
    const candidate = Date.UTC(year, parts.month, parts.day, clock.hour, clock.minute);
    const distance = Math.abs(candidate - target);
    if (distance < bestDistance) {
      bestYear = year;
      bestDistance = distance;
    }
  }
  return bestYear;
}

export function parseDueDate(raw: string, now: Date, timeZone: string): DueDate {
  const dateResult = parseDateParts(raw);
  if (!dateResult.found || dateResult.parts === null || !isValidDateParts(dateResult.parts)) {
    return { iso: null, raw, zoneEvidence: 'none', timeAssumed: false, confidence: 'low' };
  }

  const clock = parseClock(raw);
  const zone = parseZone(raw, timeZone);
  const year = dateResult.parts.year ?? nearestYear(dateResult.parts, clock, now, zone.timeZone);
  const parts = { ...dateResult.parts, year };
  const instant = localDateToInstant(parts, clock, zone);
  const confidence: Confidence = instant === null ? 'low' : dateResult.confidence === 'low' ? 'low' : clock.timeAssumed || dateResult.parts.year === null ? 'medium' : 'high';
  return {
    iso: instant === null ? null : new Date(instant).toISOString(),
    raw,
    zoneEvidence: zone.evidence,
    ...(zone.evidence === 'explicit' || zone.evidence === 'assumed-local' ? { timeZone: zone.timeZone } : {}),
    timeAssumed: clock.timeAssumed,
    confidence,
  };
}

export const dueDateFromText = parseDueDate;
export const parseDueDateText = parseDueDate;
