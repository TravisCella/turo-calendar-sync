// Turo transactional email parser. Pure TypeScript: no platform APIs.
// Trip times always come from the footer (`Trip start:` / `Trip end:`), never body sentences.

import type { NoticeKind, ParsedNotice, ParseResult, RawEmail } from '../types';

const MONTHS: Record<string, number> = {
  january: 0,
  february: 1,
  march: 2,
  april: 3,
  may: 4,
  june: 5,
  july: 6,
  august: 7,
  september: 8,
  october: 9,
  november: 10,
  december: 11,
};

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

function to24Hour(hour12: number, ampm: string): number {
  const hour = hour12 % 12;
  return ampm.toLowerCase() === 'pm' ? hour + 12 : hour;
}

// America/Denver has observed US DST since 2007: starts 2nd Sunday of March,
// ends 1st Sunday of November, both at 2:00am local. Compared here as
// wall-clock values (via Date.UTC, never the host's own timezone).
function denverOffsetMinutes(year: number, monthIndex: number, day: number, hour: number, minute: number): number {
  const wallClock = Date.UTC(year, monthIndex, day, hour, minute);

  const firstSundayOfMonth = (y: number, m: number): number => {
    const dayOfWeek = new Date(Date.UTC(y, m, 1)).getUTCDay();
    return 1 + ((7 - dayOfWeek) % 7);
  };

  const dstStart = Date.UTC(year, 2, firstSundayOfMonth(year, 2) + 7, 2, 0);
  const dstEnd = Date.UTC(year, 10, firstSundayOfMonth(year, 10), 2, 0);

  return wallClock >= dstStart && wallClock < dstEnd ? -6 * 60 : -7 * 60;
}

function toIsoWithOffset(year: number, monthIndex: number, day: number, hour: number, minute: number): string {
  const offsetMinutes = denverOffsetMinutes(year, monthIndex, day, hour, minute);
  const absMinutes = Math.abs(offsetMinutes);
  const offset = `${offsetMinutes <= 0 ? '-' : '+'}${pad(Math.floor(absMinutes / 60))}:${pad(absMinutes % 60)}`;
  return `${year}-${pad(monthIndex + 1)}-${pad(day)}T${pad(hour)}:${pad(minute)}:00${offset}`;
}

// Footer format: `M/D/YY h:mm am|pm`, am/pm case varies.
function parseFooterDate(raw: string): string {
  const match = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})\s+(\d{1,2}):(\d{2})\s*([AaPp][Mm])$/);
  if (!match) throw new Error(`Unrecognized footer date: ${raw}`);
  const [, month, day, year, hour, minute, ampm] = match;
  return toIsoWithOffset(2000 + Number(year), Number(month) - 1, Number(day), to24Hour(Number(hour), ampm), Number(minute));
}

// Body long-form date, e.g. `September 15, 2026, 11:30 PM` (weekday already stripped by caller).
function parseLongDate(raw: string): string {
  const match = raw.match(/([A-Za-z]+) (\d{1,2}), (\d{4}),\s*(\d{1,2}):(\d{2})\s*([AaPp][Mm])/);
  if (!match) throw new Error(`Unrecognized date: ${raw}`);
  const [, monthName, day, year, hour, minute, ampm] = match;
  const monthIndex = MONTHS[monthName.toLowerCase()];
  if (monthIndex === undefined) throw new Error(`Unrecognized month: ${monthName}`);
  return toIsoWithOffset(Number(year), monthIndex, Number(day), to24Hour(Number(hour), ampm), Number(minute));
}

type KnownKind = Exclude<NoticeKind, 'ignored'>;

const SUBJECT_PATTERNS: Array<[KnownKind, RegExp]> = [
  ['booked', /^(.+?)’s trip with your .+ is booked!$/],
  ['changed', /^(.+?) has changed their trip with your /],
  ['change_requested', /^(.+?) has requested a change to their trip with your /],
  ['cancelled', /^(.+?) has cancelled their trip with your /],
  ['upcoming', /^(.+?) has an upcoming trip with your /],
  ['message', /^(.+?) has sent you a message about your /],
];

function matchSubject(subject: string): { kind: KnownKind; guestFirstName: string } | null {
  for (const [kind, pattern] of SUBJECT_PATTERNS) {
    const match = subject.match(pattern);
    if (match) return { kind, guestFirstName: match[1] };
  }
  return null;
}

function findLine(lines: string[], pattern: RegExp): { index: number; match: RegExpMatchArray } | null {
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(pattern);
    if (match) return { index: i, match };
  }
  return null;
}

interface FooterData {
  vehicle: string;
  tripStart: string;
  tripEnd: string;
  reservationId: string;
  earningsUsd?: number;
  guestPhone?: string;
}

function parseFooter(textBody: string): FooterData {
  const lines = textBody.split('\n').map((line) => line.trim());

  const bookedBy = findLine(lines, /^(?:booked|requested) by (.+)$/);
  if (!bookedBy) throw new Error('Footer "booked by"/"requested by" line not found');

  let vehicleIndex = bookedBy.index - 1;
  while (vehicleIndex >= 0 && lines[vehicleIndex] === '') vehicleIndex--;
  if (vehicleIndex < 0) throw new Error('Vehicle line not found above footer');

  const tripStart = findLine(lines, /^Trip start:\s*(.+)$/i);
  const tripEnd = findLine(lines, /^Trip end:\s*(.+)$/i);
  if (!tripStart || !tripEnd) throw new Error('Trip start/end footer lines not found');

  const reservation = findLine(lines, /^Reservation ID #(\d+)$/);
  if (!reservation) throw new Error('Reservation ID footer line not found');

  const earnings = findLine(lines, /^You earn:\s*\$([\d,]+\.\d{2})$/);

  const between = lines
    .slice(tripEnd.index + 1, reservation.index)
    .filter((line) => line !== '' && !/^You earn:/i.test(line) && !/^Mileage included:/i.test(line));
  const phoneCandidate = between[between.length - 1];
  const guestPhone = phoneCandidate && /^[+()0-9][0-9() +-]*$/.test(phoneCandidate) ? phoneCandidate : undefined;

  return {
    vehicle: lines[vehicleIndex],
    tripStart: parseFooterDate(tripStart.match[1].trim()),
    tripEnd: parseFooterDate(tripEnd.match[1].trim()),
    reservationId: reservation.match[1],
    earningsUsd: earnings ? Number(earnings.match[1].replace(/,/g, '')) : undefined,
    guestPhone,
  };
}

function parseLocation(textBody: string): string | undefined {
  const match = textBody.match(/with your .+? at (.+?) (?:is booked|starting)/);
  return match ? match[1] : undefined;
}

interface ChangeRequestFields {
  requestedStart?: string;
  requestedEnd?: string;
  changeResponseBy?: string;
}

function parseChangeRequestFields(textBody: string): ChangeRequestFields {
  const start = textBody.match(/New trip start on [A-Za-z]+, (.+?)(?=-|\n)/);
  const end = textBody.match(/New trip end on [A-Za-z]+, (.+?)(?=-|\n)/);
  const respondBy = textBody.match(/You have until [A-Za-z]+, (.+?) to respond/);

  return {
    requestedStart: start ? parseLongDate(start[1]) : undefined,
    requestedEnd: end ? parseLongDate(end[1]) : undefined,
    changeResponseBy: respondBy ? parseLongDate(respondBy[1]) : undefined,
  };
}

export function parseTuroEmail(email: RawEmail): ParseResult {
  const subjectMatch = matchSubject(email.subject);
  if (!subjectMatch) return { kind: 'ignored' };

  const footer = parseFooter(email.textBody);
  const location = parseLocation(email.textBody);

  const notice: ParsedNotice = {
    platform: 'turo',
    kind: subjectMatch.kind,
    reservationId: footer.reservationId,
    guestFirstName: subjectMatch.guestFirstName,
    vehicle: footer.vehicle,
    tripStart: footer.tripStart,
    tripEnd: footer.tripEnd,
    sourceMessageId: email.messageId,
    sourceReceivedAt: email.receivedAt,
  };

  if (location) notice.location = location;
  if (footer.guestPhone) notice.guestPhone = footer.guestPhone;
  if (footer.earningsUsd !== undefined) notice.earningsUsd = footer.earningsUsd;

  if (subjectMatch.kind === 'change_requested') {
    const fields = parseChangeRequestFields(email.textBody);
    if (fields.requestedStart) notice.requestedStart = fields.requestedStart;
    if (fields.requestedEnd) notice.requestedEnd = fields.requestedEnd;
    if (fields.changeResponseBy) notice.changeResponseBy = fields.changeResponseBy;
  }

  return notice;
}
