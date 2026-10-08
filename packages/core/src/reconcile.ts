// Reconcile rules from Spec.md "Sync logic". Pure TypeScript: no platform APIs.

import type { Booking, BookingStatus, CalendarAction, ParsedNotice, ReconcileResult } from './types';
import { eventKey, toCalendarEvents } from './events';

function isBefore(a: string, b: string): boolean {
  return new Date(a).getTime() < new Date(b).getTime();
}

function baseFromNotice(notice: ParsedNotice, now: string, status: BookingStatus): Booking {
  const booking: Booking = {
    platform: notice.platform,
    reservationId: notice.reservationId,
    vehicle: notice.vehicle,
    guestFirstName: notice.guestFirstName,
    tripStart: notice.tripStart,
    tripEnd: notice.tripEnd,
    status,
    lastNoticeAt: notice.sourceReceivedAt,
    updatedAt: now,
  };
  if (notice.guestPhone) booking.guestPhone = notice.guestPhone;
  if (notice.location) booking.location = notice.location;
  if (notice.earningsUsd !== undefined) booking.earningsUsd = notice.earningsUsd;
  return booking;
}

function createActions(booking: Booking): CalendarAction[] {
  return toCalendarEvents(booking).map((event) => ({ type: 'create', event }));
}

function updateActions(booking: Booking): CalendarAction[] {
  return toCalendarEvents(booking).map((event) => ({ type: 'update', event }));
}

function deleteActions(booking: Pick<Booking, 'platform' | 'reservationId'>): CalendarAction[] {
  return [
    { type: 'delete', key: eventKey(booking.platform, booking.reservationId, 'pickup') },
    { type: 'delete', key: eventKey(booking.platform, booking.reservationId, 'return') },
  ];
}

// Rule 2: booked.
function reconcileBooked(notice: ParsedNotice, now: string): ReconcileResult {
  const booking = baseFromNotice(notice, now, 'booked');
  return { booking, actions: createActions(booking) };
}

// Rule 3: changed. Overwrites tripStart/tripEnd from the footer, clears any pending flag.
function reconcileChanged(existing: Booking | null, notice: ParsedNotice, now: string): ReconcileResult {
  const base = existing ?? baseFromNotice(notice, now, 'booked');
  const { requestedStart, requestedEnd, changeResponseBy, ...rest } = base;
  const booking: Booking = {
    ...rest,
    guestFirstName: notice.guestFirstName,
    guestPhone: notice.guestPhone ?? base.guestPhone,
    location: notice.location ?? base.location,
    vehicle: notice.vehicle,
    earningsUsd: notice.earningsUsd ?? base.earningsUsd,
    tripStart: notice.tripStart,
    tripEnd: notice.tripEnd,
    status: 'booked',
    lastNoticeAt: notice.sourceReceivedAt,
    updatedAt: now,
  };
  return { booking, actions: updateActions(booking) };
}

// Rule 4: change_requested. Never touches tripStart/tripEnd; the footer here
// carries the unconfirmed requested times, not confirmed ones.
function reconcileChangeRequested(existing: Booking | null, notice: ParsedNotice, now: string): ReconcileResult {
  if (!existing) {
    // A change request implies a prior confirmed booking we don't have; nothing safe to do.
    return { booking: null, actions: [] };
  }
  const booking: Booking = {
    ...existing,
    status: 'change_pending',
    requestedStart: notice.requestedStart,
    requestedEnd: notice.requestedEnd,
    changeResponseBy: notice.changeResponseBy,
    lastNoticeAt: notice.sourceReceivedAt,
    updatedAt: now,
  };
  return { booking, actions: updateActions(booking) };
}

// Rule 5: cancelled.
function reconcileCancelled(existing: Booking | null, notice: ParsedNotice, now: string): ReconcileResult {
  const base = existing ?? baseFromNotice(notice, now, 'booked');
  const booking: Booking = { ...base, status: 'cancelled', lastNoticeAt: notice.sourceReceivedAt, updatedAt: now };
  return { booking, actions: deleteActions(booking) };
}

// Rule 6: upcoming / message.
function reconcileFooterNotice(existing: Booking | null, notice: ParsedNotice, now: string): ReconcileResult {
  if (!existing) {
    const booking = baseFromNotice(notice, now, 'booked');
    return { booking, actions: createActions(booking) };
  }

  if (existing.status === 'change_pending' && existing.changeResponseBy) {
    if (isBefore(now, existing.changeResponseBy)) {
      // Deadline hasn't passed: the footer may still show the unconfirmed
      // requested times, so never apply it.
      const booking: Booking = { ...existing, lastNoticeAt: notice.sourceReceivedAt, updatedAt: now };
      return { booking, actions: [] };
    }

    const matchesRequested = notice.tripStart === existing.requestedStart && notice.tripEnd === existing.requestedEnd;
    const matchesConfirmed = notice.tripStart === existing.tripStart && notice.tripEnd === existing.tripEnd;

    if (matchesRequested) {
      const { requestedStart, requestedEnd, changeResponseBy, ...rest } = existing;
      const booking: Booking = {
        ...rest,
        tripStart: notice.tripStart,
        tripEnd: notice.tripEnd,
        status: 'booked',
        lastNoticeAt: notice.sourceReceivedAt,
        updatedAt: now,
      };
      return { booking, actions: updateActions(booking) };
    }

    if (matchesConfirmed) {
      const { requestedStart, requestedEnd, changeResponseBy, ...rest } = existing;
      const booking: Booking = { ...rest, status: 'booked', lastNoticeAt: notice.sourceReceivedAt, updatedAt: now };
      return { booking, actions: updateActions(booking) };
    }

    // Neither matches the request nor the original booking: Turo's rule can't
    // resolve this footer. This should go to the Unparsed log, but
    // ReconcileResult has no field to carry that signal today — see the
    // note back to Travis. We leave the booking untouched rather than guess.
    const booking: Booking = { ...existing, lastNoticeAt: notice.sourceReceivedAt, updatedAt: now };
    return { booking, actions: [] };
  }

  const timesChanged = notice.tripStart !== existing.tripStart || notice.tripEnd !== existing.tripEnd;
  const booking: Booking = {
    ...existing,
    guestFirstName: notice.guestFirstName,
    guestPhone: notice.guestPhone ?? existing.guestPhone,
    location: notice.location ?? existing.location,
    vehicle: notice.vehicle,
    earningsUsd: notice.earningsUsd ?? existing.earningsUsd,
    tripStart: notice.tripStart,
    tripEnd: notice.tripEnd,
    lastNoticeAt: notice.sourceReceivedAt,
    updatedAt: now,
  };
  return { booking, actions: timesChanged ? updateActions(booking) : [] };
}

export function reconcile(existing: Booking | null, notice: ParsedNotice, now: string): ReconcileResult {
  if (existing && isBefore(notice.sourceReceivedAt, existing.lastNoticeAt)) {
    return { booking: null, actions: [] };
  }

  switch (notice.kind) {
    case 'booked':
      return reconcileBooked(notice, now);
    case 'changed':
      return reconcileChanged(existing, notice, now);
    case 'change_requested':
      return reconcileChangeRequested(existing, notice, now);
    case 'cancelled':
      return reconcileCancelled(existing, notice, now);
    case 'upcoming':
    case 'message':
      return reconcileFooterNotice(existing, notice, now);
  }
}

// Every run calls this after processing new notices. Turo lapses an
// unanswered change request at its deadline, so a change_pending booking
// nobody resolved reverts to its original (never-touched) times.
export function expirePendingChanges(bookings: Booking[], now: string): ReconcileResult[] {
  const results: ReconcileResult[] = [];

  for (const booking of bookings) {
    if (booking.status !== 'change_pending' || !booking.changeResponseBy) continue;
    if (isBefore(now, booking.changeResponseBy)) continue;

    const { requestedStart, requestedEnd, changeResponseBy, ...rest } = booking;
    const reverted: Booking = { ...rest, status: 'booked', updatedAt: now };
    results.push({ booking: reverted, actions: updateActions(reverted) });
  }

  return results;
}
