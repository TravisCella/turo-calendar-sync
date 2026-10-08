import { describe, expect, it } from 'vitest';
import { parseTuroEmail } from '../src/parsers/turo';
import { expirePendingChanges, reconcile } from '../src/reconcile';
import type { Booking, ParsedNotice, ReconcileResult } from '../src/types';
import { loadFixtureEmail } from './helpers/loadFixture';

function parseKnown(fixtureName: string): ParsedNotice {
  const notice = parseTuroEmail(loadFixtureEmail(fixtureName));
  if (notice.kind === 'ignored') throw new Error(`expected a known notice from ${fixtureName}`);
  return notice;
}

function expectBooking(result: ReconcileResult): Booking {
  if (!result.booking) throw new Error('expected a booking, got null');
  return result.booking;
}

describe('reconcile replay', () => {
  it('a silent extension (01 then 13) moves tripEnd with no "changed" email', () => {
    const ledger = new Map<string, Booking>();
    const fixtures = ['01-booked-airport', '13-message-silent-extension'];

    for (const fixtureName of fixtures) {
      const notice = parseKnown(fixtureName);
      const existing = ledger.get(notice.reservationId) ?? null;
      const result = reconcile(existing, notice, notice.sourceReceivedAt);
      if (result.booking) ledger.set(notice.reservationId, result.booking);
    }

    const booking = ledger.get('61467780');
    expect(booking).toBeDefined();
    expect(booking?.tripStart).toBe('2026-09-18T20:30:00-06:00');
    expect(booking?.tripEnd).toBe('2026-09-23T12:00:00-06:00'); // was 09-21, silently extended
    expect(booking?.lastNoticeAt).toBe('2026-09-23T18:24:26Z');
  });

  it('a cancellation (09) deletes both pickup and return events', () => {
    const notice = parseKnown('09-cancelled');
    const existing: Booking = {
      platform: 'turo',
      reservationId: notice.reservationId,
      vehicle: notice.vehicle,
      guestFirstName: 'Riley',
      tripStart: notice.tripStart,
      tripEnd: notice.tripEnd,
      status: 'booked',
      lastNoticeAt: '2026-07-01T00:00:00Z',
      updatedAt: '2026-07-01T00:00:00Z',
    };

    const result = reconcile(existing, notice, notice.sourceReceivedAt);

    expect(expectBooking(result).status).toBe('cancelled');
    expect(result.actions).toEqual([
      { type: 'delete', key: 'turo:59582071:pickup' },
      { type: 'delete', key: 'turo:59582071:return' },
    ]);
  });

  it('skips a notice older than the booking’s last applied notice', () => {
    const notice = parseKnown('01-booked-airport'); // sourceReceivedAt: 2026-09-18T07:33:54Z
    const existing: Booking = {
      platform: 'turo',
      reservationId: notice.reservationId,
      vehicle: notice.vehicle,
      guestFirstName: notice.guestFirstName,
      tripStart: notice.tripStart,
      tripEnd: '2026-09-23T12:00:00-06:00',
      status: 'booked',
      lastNoticeAt: '2026-09-23T18:24:26Z', // newer than the notice being replayed
      updatedAt: '2026-09-23T18:24:26Z',
    };

    const result = reconcile(existing, notice, '2026-09-24T00:00:00Z');

    expect(result).toEqual({ booking: null, actions: [] });
  });
});

// Reservation 58900705 (fixture 08) never got a follow-up accept/decline
// email in the sampled inbox (see fixtures/turo/README.md). The confirmed
// booking below and the follow-up notices are hand-built to exercise rule 6's
// pending/deadline branches, which no real fixture covers end to end.
describe('reconcile change_requested deadline handling (58900705)', () => {
  const confirmed: Booking = {
    platform: 'turo',
    reservationId: '58900705',
    vehicle: 'Cadillac Escalade ESV 2024',
    guestFirstName: 'JORDAN',
    guestPhone: '(555) 010-0008',
    tripStart: '2026-09-10T20:00:00-06:00',
    tripEnd: '2026-09-14T20:00:00-06:00',
    status: 'booked',
    lastNoticeAt: '2026-09-01T00:00:00Z',
    updatedAt: '2026-09-01T00:00:00Z',
  };

  function requestChange(): Booking {
    const notice = parseKnown('08-change-requested');
    return expectBooking(reconcile(confirmed, notice, notice.sourceReceivedAt));
  }

  function followUp(tripStart: string, tripEnd: string, sourceReceivedAt: string): ParsedNotice {
    return {
      platform: 'turo',
      kind: 'message',
      reservationId: '58900705',
      guestFirstName: 'JORDAN',
      vehicle: 'Cadillac Escalade ESV 2024',
      tripStart,
      tripEnd,
      sourceMessageId: 'synthetic',
      sourceReceivedAt,
    };
  }

  it('sets change_pending and leaves confirmed times untouched', () => {
    const pending = requestChange();
    expect(pending.status).toBe('change_pending');
    expect(pending.tripStart).toBe(confirmed.tripStart);
    expect(pending.tripEnd).toBe(confirmed.tripEnd);
    expect(pending.requestedStart).toBe('2026-09-15T23:30:00-06:00');
    expect(pending.requestedEnd).toBe('2026-09-20T23:30:00-06:00');
    expect(pending.changeResponseBy).toBe('2026-09-15T12:39:00-06:00');
  });

  it('before the deadline, does not apply footer times even if they match the request', () => {
    const pending = requestChange();
    const notice = followUp(pending.requestedStart!, pending.requestedEnd!, '2026-09-15T10:00:00-06:00');

    const result = reconcile(pending, notice, '2026-09-15T10:00:00-06:00');

    expect(expectBooking(result).status).toBe('change_pending');
    expect(expectBooking(result).tripStart).toBe(confirmed.tripStart);
    expect(result.actions).toEqual([]);
  });

  it('after the deadline, footer times matching the request mean accepted', () => {
    const pending = requestChange();
    const notice = followUp(pending.requestedStart!, pending.requestedEnd!, '2026-09-16T00:00:00-06:00');

    const result = reconcile(pending, notice, '2026-09-16T00:00:00-06:00');
    const booking = expectBooking(result);

    expect(booking.status).toBe('booked');
    expect(booking.tripStart).toBe('2026-09-15T23:30:00-06:00');
    expect(booking.tripEnd).toBe('2026-09-20T23:30:00-06:00');
    expect(booking.requestedStart).toBeUndefined();
    expect(booking.changeResponseBy).toBeUndefined();
    expect(result.actions).toHaveLength(2);
  });

  it('after the deadline, footer times matching the original booking mean declined', () => {
    const pending = requestChange();
    const notice = followUp(confirmed.tripStart, confirmed.tripEnd, '2026-09-16T00:00:00-06:00');

    const result = reconcile(pending, notice, '2026-09-16T00:00:00-06:00');
    const booking = expectBooking(result);

    expect(booking.status).toBe('booked');
    expect(booking.tripStart).toBe(confirmed.tripStart);
    expect(booking.tripEnd).toBe(confirmed.tripEnd);
    expect(booking.requestedStart).toBeUndefined();
    expect(result.actions).toHaveLength(2);
  });

  it('after the deadline, footer times matching neither request nor original flag it as unparsed', () => {
    const pending = requestChange();
    const notice = followUp('2026-09-16T00:00:00-06:00', '2026-09-18T00:00:00-06:00', '2026-09-16T00:00:00-06:00');

    const result = reconcile(pending, notice, '2026-09-16T00:00:00-06:00');

    expect(result.booking).toBe(pending);
    expect(result.actions).toEqual([]);
    expect(result.unparsed?.reason).toContain('58900705');
    expect(result.unparsed?.reason).toContain(pending.requestedStart!);
    expect(result.unparsed?.reason).toContain(pending.requestedEnd!);
    expect(result.unparsed?.reason).toContain(confirmed.tripStart);
    expect(result.unparsed?.reason).toContain(confirmed.tripEnd);
  });

  it('expirePendingChanges leaves a pending booking untouched before its deadline', () => {
    const pending = requestChange();
    expect(expirePendingChanges([pending], '2026-09-15T10:00:00-06:00')).toEqual([]);
  });

  it('expirePendingChanges reverts to booked with original times once the deadline passes unanswered', () => {
    const pending = requestChange();
    const [result] = expirePendingChanges([pending], '2026-09-16T00:00:00-06:00');
    const booking = expectBooking(result);

    expect(booking.status).toBe('booked');
    expect(booking.tripStart).toBe(confirmed.tripStart);
    expect(booking.tripEnd).toBe(confirmed.tripEnd);
    expect(booking.requestedStart).toBeUndefined();
    expect(booking.changeResponseBy).toBeUndefined();
    expect(result.actions).toHaveLength(2);
  });
});
