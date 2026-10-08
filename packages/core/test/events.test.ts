import { describe, expect, it } from 'vitest';
import { toCalendarEvents } from '../src/events';
import type { Booking } from '../src/types';

function makeBooking(overrides: Partial<Booking> = {}): Booking {
  return {
    platform: 'turo',
    reservationId: '61467780',
    vehicle: 'Audi Q8 2021',
    guestFirstName: 'Rob',
    guestPhone: '(555) 010-0001',
    location: 'Salt Lake City International Airport',
    tripStart: '2026-09-18T20:30:00-06:00',
    tripEnd: '2026-09-21T17:00:00-06:00',
    status: 'booked',
    lastNoticeAt: '2026-09-18T07:33:54Z',
    updatedAt: '2026-09-18T07:33:54Z',
    ...overrides,
  };
}

describe('toCalendarEvents', () => {
  it('builds a pickup and return event 30 minutes long, keyed by role', () => {
    const [pickup, returnEvent] = toCalendarEvents(makeBooking());

    expect(pickup.key).toBe('turo:61467780:pickup');
    expect(pickup.role).toBe('pickup');
    expect(pickup.title).toBe('PICKUP · Audi Q8 · Rob');
    expect(pickup.start).toBe('2026-09-18T20:30:00-06:00');
    expect(pickup.end).toBe('2026-09-18T21:00:00-06:00');
    expect(pickup.location).toBe('Salt Lake City International Airport');
    expect(pickup.tentative).toBe(false);

    expect(returnEvent.key).toBe('turo:61467780:return');
    expect(returnEvent.role).toBe('return');
    expect(returnEvent.title).toBe('RETURN · Audi Q8 · Rob');
    expect(returnEvent.start).toBe('2026-09-21T17:00:00-06:00');
    expect(returnEvent.end).toBe('2026-09-21T17:30:00-06:00');
  });

  it('keeps the vehicle year out of the title but not the color key', () => {
    const [pickup] = toCalendarEvents(makeBooking({ vehicle: 'Cadillac Escalade ESV 2024' }));
    expect(pickup.title).toBe('PICKUP · Cadillac Escalade ESV · Rob');
    expect(pickup.colorKey).toBe('Cadillac Escalade ESV 2024');
  });

  it('prefixes NO LOCATION and adds a note when location is absent', () => {
    const [pickup] = toCalendarEvents(makeBooking({ location: undefined }));
    expect(pickup.title).toBe('NO LOCATION · PICKUP · Audi Q8 · Rob');
    expect(pickup.location).toBeUndefined();
    expect(pickup.description).toContain('Confirm the meeting point with the guest.');
  });

  it('prefixes CHANGE REQUESTED, marks events tentative, and lists requested times while pending', () => {
    const booking = makeBooking({
      status: 'change_pending',
      requestedStart: '2026-09-22T20:30:00-06:00',
      requestedEnd: '2026-09-25T17:00:00-06:00',
    });
    const [pickup] = toCalendarEvents(booking);

    expect(pickup.title).toBe('CHANGE REQUESTED · PICKUP · Audi Q8 · Rob');
    expect(pickup.tentative).toBe(true);
    expect(pickup.description).toContain('Requested: 2026-09-22 20:30 – 2026-09-25 17:00');
  });

  it('never includes earnings in the description', () => {
    const [pickup] = toCalendarEvents(makeBooking({ earningsUsd: 245.84 }));
    expect(pickup.description).not.toMatch(/\$|earn/i);
  });

  it('rolls a 30-minute addition across midnight correctly', () => {
    const [pickup] = toCalendarEvents(makeBooking({ tripStart: '2026-09-18T23:45:00-06:00' }));
    expect(pickup.end).toBe('2026-09-19T00:15:00-06:00');
  });
});
