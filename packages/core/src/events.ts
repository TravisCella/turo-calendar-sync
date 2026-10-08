// Maps a Booking to the two calendar events (pickup, return) it should have
// right now. Pure TypeScript: no platform APIs.

import type { Booking, CalendarEventSpec, EventRole } from './types';

const EVENT_DURATION_MINUTES = 30;

export function eventKey(platform: string, reservationId: string, role: EventRole): string {
  return `${platform}:${reservationId}:${role}`;
}

function vehicleWithoutYear(vehicle: string): string {
  return vehicle.replace(/\s+\d{4}$/, '');
}

function formatWallClock(iso: string): string {
  return iso.slice(0, 16).replace('T', ' ');
}

// Adds minutes to an ISO-with-offset timestamp, keeping the same offset.
// Only ever used for a 30-minute shift from a trip start/end, which never
// crosses a DST transition in practice.
function addMinutesPreservingOffset(iso: string, minutesToAdd: number): string {
  const match = iso.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})([+-]\d{2}:\d{2})$/);
  if (!match) throw new Error(`Unrecognized ISO timestamp: ${iso}`);
  const [, year, month, day, hour, minute, second, offset] = match;

  const shifted = new Date(
    Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute) + minutesToAdd, Number(second)),
  );
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}T${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}${offset}`;
}

function buildEvent(booking: Booking, role: EventRole): CalendarEventSpec {
  const start = role === 'pickup' ? booking.tripStart : booking.tripEnd;
  const end = addMinutesPreservingOffset(start, EVENT_DURATION_MINUTES);
  const vehicle = vehicleWithoutYear(booking.vehicle);
  const pending = booking.status === 'change_pending';

  let title = `${role === 'pickup' ? 'PICKUP' : 'RETURN'} · ${vehicle} · ${booking.guestFirstName}`;
  if (!booking.location) title = `NO LOCATION · ${title}`;
  if (pending) title = `CHANGE REQUESTED · ${title}`;

  const description = [
    booking.guestPhone ? `${booking.guestFirstName} · ${booking.guestPhone}` : booking.guestFirstName,
    `https://turo.com/reservation/${booking.reservationId}`,
    `Trip: ${formatWallClock(booking.tripStart)} – ${formatWallClock(booking.tripEnd)}`,
    !booking.location ? 'Confirm the meeting point with the guest.' : null,
    pending && booking.requestedStart && booking.requestedEnd
      ? `Requested: ${formatWallClock(booking.requestedStart)} – ${formatWallClock(booking.requestedEnd)}`
      : null,
  ]
    .filter((line): line is string => line !== null)
    .join('\n');

  return {
    key: eventKey(booking.platform, booking.reservationId, role),
    role,
    title,
    start,
    end,
    location: booking.location,
    description,
    colorKey: booking.vehicle,
    tentative: pending,
  };
}

export function toCalendarEvents(booking: Booking): CalendarEventSpec[] {
  return [buildEvent(booking, 'pickup'), buildEvent(booking, 'return')];
}
