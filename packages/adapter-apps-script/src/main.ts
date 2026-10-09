// Entry point: runSync(), runBackfill(), installTrigger(). Composes the core
// reconcile logic with the Apps Script adapters. Every run takes a script
// lock (Spec.md "Triggers") so two runs never overlap.

import {
  expirePendingChanges,
  parseTuroEmail,
  reconcile,
  toCalendarEvents,
  type Booking,
  type BookingStatus,
  type CalendarEventSpec,
  type Clock,
  type EventRole,
  type RawEmail,
  type ReconcileResult,
} from '@turo-sync/core';
import { getLastDigestAt, getSpreadsheetId, readConfig, saveLastDigestAt, saveSpreadsheetId } from './config';
import { GmailMailSource } from './mailSource';
import { CalendarAppCalendarSink } from './calendarSink';
import { SheetBookingStore, type UnparsedRow } from './bookingStore';
import { MailNotifier } from './notifier';
import { RealClock } from './clock';

const LOCK_WAIT_MS = 30_000;
const DIGEST_INTERVAL_MS = 24 * 60 * 60 * 1000;
// Apps Script kills a trigger-run execution at 6 minutes; stop processing
// emails with a comfortable margin so the run always finishes cleanly and
// the next invocation (Gmail excludes what we already labeled) picks up
// where this one left off.
const MAX_RUN_MS = 5 * 60 * 1000;
const ACTIVE_STATUSES: BookingStatus[] = ['booked', 'change_pending'];

// Structural, not the concrete classes, so tests can pass plain-object fakes.
export interface RunDeps {
  store: Pick<SheetBookingStore, 'get' | 'put' | 'listAll' | 'logUnparsed' | 'logRun' | 'listUnparsedSince'>;
  calendar: Pick<CalendarAppCalendarSink, 'create' | 'update' | 'delete'>;
  mailSource: Pick<GmailMailSource, 'markProcessed'>;
  clock: Clock;
  dryRun: boolean;
  nowMs: () => number;
}

// The vehicle's next booking after this one's return, for the "another trip
// starts within 24 hours" note. Pure: no store access, just the ledger snapshot.
export function findNextTripStart(booking: Booking, allBookings: Booking[]): string | undefined {
  const candidates = allBookings.filter(
    (other) =>
      other.vehicle === booking.vehicle &&
      !(other.platform === booking.platform && other.reservationId === booking.reservationId) &&
      other.status !== 'cancelled' &&
      new Date(other.tripStart).getTime() >= new Date(booking.tripEnd).getTime(),
  );
  if (candidates.length === 0) return undefined;
  candidates.sort((a, b) => new Date(a.tripStart).getTime() - new Date(b.tripStart).getTime());
  return candidates[0].tripStart;
}

function regenerateEvents(booking: Booking, allBookings: Booking[]): CalendarEventSpec[] {
  return toCalendarEvents(booking, { nextTripStart: findNextTripStart(booking, allBookings) });
}

function describeEvent(action: 'create' | 'update', event: CalendarEventSpec): string {
  return `${action} ${event.key}: "${event.title}" ${event.start} – ${event.end}`;
}

function roleFromKey(key: string): EventRole {
  return key.endsWith(':pickup') ? 'pickup' : 'return';
}

function knownEventId(booking: Booking, role: EventRole): string | undefined {
  return role === 'pickup' ? booking.pickupEventId : booking.returnEventId;
}

function withEventId(booking: Booking, role: EventRole, id: string): Booking {
  return role === 'pickup' ? { ...booking, pickupEventId: id } : { ...booking, returnEventId: id };
}

function applyResult(result: ReconcileResult, allBookings: Booking[], deps: RunDeps, skipCalendar: boolean): void {
  if (!result.booking) return;
  let booking = result.booking;

  if (result.actions.length > 0) {
    if (skipCalendar) {
      deps.store.logRun(
        `Skipped ${result.actions.length} calendar action(s) for ${booking.reservationId} (trip already ended; backfill)`,
      );
    } else {
      const freshEvents = booking.status === 'cancelled' ? null : regenerateEvents(booking, allBookings);

      for (const action of result.actions) {
        if (action.type === 'delete') {
          const role = roleFromKey(action.key);
          if (deps.dryRun) deps.store.logRun(`DRY_RUN: delete ${action.key}`);
          else deps.calendar.delete(action.key, knownEventId(booking, role));
          continue;
        }

        const event = freshEvents?.find((candidate) => candidate.role === action.event.role) ?? action.event;
        if (deps.dryRun) {
          deps.store.logRun(`DRY_RUN: ${describeEvent(action.type, event)}`);
          continue;
        }

        if (action.type === 'create') {
          booking = withEventId(booking, event.role, deps.calendar.create(event));
        } else {
          const recreatedId = deps.calendar.update(event, knownEventId(booking, event.role));
          if (recreatedId) booking = withEventId(booking, event.role, recreatedId);
        }
      }
    }
  }

  deps.store.put(booking);
}

// Any active booking still missing a pickup or return event id gets one
// created now. This is what makes a dry run harmless to run before the real
// thing: the ledger already reflects every booking either way, and this
// pass is what actually materializes the calendar events once DRY_RUN is
// off — whether or not the original email gets reprocessed.
function materializeMissingEvents(deps: RunDeps, now: string): void {
  const allBookings = deps.store.listAll();

  for (const booking of allBookings) {
    if (!ACTIVE_STATUSES.includes(booking.status)) continue;
    if (booking.pickupEventId && booking.returnEventId) continue;
    if (new Date(booking.tripEnd).getTime() < new Date(now).getTime()) continue; // trip already over

    const freshEvents = regenerateEvents(booking, allBookings);
    let updated = booking;

    for (const role of ['pickup', 'return'] as const) {
      if (knownEventId(updated, role)) continue;
      const event = freshEvents.find((candidate) => candidate.role === role)!;
      if (deps.dryRun) {
        deps.store.logRun(`DRY_RUN: ${describeEvent('create', event)} (self-heal: missing ${role} event)`);
      } else {
        updated = withEventId(updated, role, deps.calendar.create(event));
      }
    }

    if (updated !== booking) deps.store.put(updated);
  }
}

function markProcessed(email: RawEmail, deps: RunDeps): void {
  if (deps.dryRun) deps.store.logRun(`DRY_RUN: would label ${email.messageId} processed`);
  else deps.mailSource.markProcessed(email.messageId);
}

export function runWithDeps(deps: RunDeps, emails: RawEmail[], skipPastTrips: boolean): void {
  const now = deps.clock.now();
  const startedAtMs = deps.nowMs();

  for (let i = 0; i < emails.length; i++) {
    if (deps.nowMs() - startedAtMs > MAX_RUN_MS) {
      deps.store.logRun(
        `Stopping after ${i}/${emails.length} email(s) to stay under Apps Script's execution time limit; ` +
          'the next run will pick up where this one left off.',
      );
      break;
    }

    const email = emails[i];
    const notice = parseTuroEmail(email);

    if (notice.kind === 'ignored') {
      markProcessed(email, deps);
      continue;
    }

    const existing = deps.store.get(notice.platform, notice.reservationId);
    const result = reconcile(existing, notice, now);

    if (result.unparsed) {
      deps.store.logUnparsed(email.messageId, email.subject, result.unparsed.reason);
    }

    if (result.booking) {
      const tripEnded = new Date(result.booking.tripEnd).getTime() < new Date(now).getTime();
      applyResult(result, deps.store.listAll(), deps, skipPastTrips && tripEnded);
    }

    markProcessed(email, deps);
  }

  for (const result of expirePendingChanges(deps.store.listAll(), now)) {
    applyResult(result, deps.store.listAll(), deps, false);
  }

  materializeMissingEvents(deps, now);
}

export function maybeSendDigest(
  deps: Pick<RunDeps, 'store'>,
  now: string,
  getLastDigestAt: () => string | null,
  saveLastDigestAt: (iso: string) => void,
  notifier: Pick<MailNotifier, 'digest'>,
): void {
  const lastDigestAt = getLastDigestAt() ?? new Date(0).toISOString();
  if (new Date(now).getTime() - new Date(lastDigestAt).getTime() < DIGEST_INTERVAL_MS) return;

  const newUnparsed: UnparsedRow[] = deps.store.listUnparsedSince(lastDigestAt);
  if (newUnparsed.length === 0) return;

  notifier.digest(newUnparsed.map((row) => `${row.loggedAt} — ${row.subject}: ${row.reason}`));
  saveLastDigestAt(now);
}

function buildDeps(mailSource: GmailMailSource): RunDeps {
  const config = readConfig();
  return {
    store: SheetBookingStore.openOrCreate(getSpreadsheetId, saveSpreadsheetId),
    calendar: new CalendarAppCalendarSink(config.calendarId),
    mailSource,
    clock: new RealClock(),
    dryRun: config.dryRun,
    nowMs: Date.now,
  };
}

function withScriptLock(fn: () => void): void {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_WAIT_MS)) {
    console.log('Could not acquire script lock; another run is already in progress.');
    return;
  }
  try {
    fn();
  } finally {
    lock.releaseLock();
  }
}

function notifyAndDigest(deps: RunDeps): void {
  maybeSendDigest(
    deps,
    deps.clock.now(),
    getLastDigestAt,
    saveLastDigestAt,
    new MailNotifier(Session.getActiveUser().getEmail()),
  );
}

export function runSync(): void {
  withScriptLock(() => {
    const mailSource = new GmailMailSource();
    const deps = buildDeps(mailSource);
    runWithDeps(deps, mailSource.fetchNew(), false);
    notifyAndDigest(deps);
  });
}

export function runBackfill(): void {
  withScriptLock(() => {
    const mailSource = new GmailMailSource();
    const deps = buildDeps(mailSource);
    runWithDeps(deps, mailSource.fetchBackfill(), true);
    notifyAndDigest(deps);
  });
}

export function installTrigger(): void {
  ScriptApp.getProjectTriggers()
    .filter((trigger) => trigger.getHandlerFunction() === 'runSync')
    .forEach((trigger) => ScriptApp.deleteTrigger(trigger));
  ScriptApp.newTrigger('runSync').timeBased().everyMinutes(10).create();
}

(globalThis as any).runSync = runSync;
(globalThis as any).runBackfill = runBackfill;
(globalThis as any).installTrigger = installTrigger;
