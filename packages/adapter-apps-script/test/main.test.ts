import { describe, expect, it } from 'vitest';
import type { Booking, CalendarEventSpec, RawEmail } from '@turo-sync/core';
import { findNextTripStart, maybeSendDigest, runWithDeps, type RunDeps } from '../src/main';
import type { UnparsedRow } from '../src/bookingStore';

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

function makeMemoryStore() {
  const bookings = new Map<string, Booking>();
  const unparsed: UnparsedRow[] = [];
  const runLog: string[] = [];

  return {
    get: (platform: string, reservationId: string) => bookings.get(`${platform}:${reservationId}`) ?? null,
    put: (booking: Booking) => {
      bookings.set(`${booking.platform}:${booking.reservationId}`, booking);
    },
    listAll: () => [...bookings.values()],
    logUnparsed: (messageId: string, subject: string, reason: string) => {
      unparsed.push({ loggedAt: new Date().toISOString(), messageId, subject, reason });
    },
    listUnparsedSince: (sinceIso: string) =>
      unparsed.filter((row) => new Date(row.loggedAt).getTime() > new Date(sinceIso).getTime()),
    logRun: (message: string) => {
      runLog.push(message);
    },
    runLog,
    unparsed,
  };
}

function makeMemoryCalendar() {
  const created: CalendarEventSpec[] = [];
  const updated: { event: CalendarEventSpec; knownEventId?: string }[] = [];
  const deleted: { key: string; knownEventId?: string }[] = [];
  // Simulates a known event id whose event is "gone" — update()/delete()
  // should fall back and, for update, recreate (returning a new id).
  const goneIds = new Set<string>();

  return {
    create: (event: CalendarEventSpec) => {
      created.push(event);
      return `id-${created.length}`;
    },
    update: (event: CalendarEventSpec, knownEventId?: string) => {
      updated.push({ event, knownEventId });
      if (knownEventId && goneIds.has(knownEventId)) {
        created.push(event);
        return `id-${created.length}`;
      }
      return undefined;
    },
    delete: (key: string, knownEventId?: string) => {
      deleted.push({ key, knownEventId });
    },
    markGone: (id: string) => goneIds.add(id),
    created,
    updated,
    deleted,
  };
}

function makeMemoryMailSource() {
  const marked: string[] = [];
  return { markProcessed: (id: string) => marked.push(id), marked };
}

function makeDeps(dryRun: boolean, nowIso: string, nowMs: () => number = () => 0) {
  const store = makeMemoryStore();
  const calendar = makeMemoryCalendar();
  const mailSource = makeMemoryMailSource();
  const deps: RunDeps = { store, calendar, mailSource, clock: { now: () => nowIso }, dryRun, nowMs };
  return { deps, store, calendar, mailSource };
}

function bookedEmail(opts: Partial<RawEmail> & { reservationId?: string } = {}): RawEmail {
  const { reservationId = '61467780', ...overrides } = opts;
  return {
    messageId: 'fixture-01',
    receivedAt: '2026-09-18T07:33:54Z',
    from: 'noreply@mail.turo.com',
    subject: 'Rob’s trip with your Audi Q8 is booked!',
    textBody: `Rob’s trip is booked.

    Cha-ching! Rob’s trip with your Audi Q8 at Salt Lake City International Airport is booked from Friday, September 18, 2026, 8:30 PM to Monday, September 21, 2026, 5:00 PM.

    Audi Q8 2021

            booked by Rob

            Trip start: 9/18/26 8:30 pm
        Trip end: 9/21/26 5:00 pm

            You earn: $245.84
        Mileage included: 600 miles
            Rob
                    (555) 010-0001

            Reservation ID #${reservationId}
`,
    ...overrides,
  };
}

function messageEmail(opts: {
  messageId: string;
  receivedAt: string;
  reservationId: string;
  guestFirstName: string;
  vehicle: string;
  tripStartFooter: string;
  tripEndFooter: string;
}): RawEmail {
  const vehicleNoYear = opts.vehicle.replace(/\s+\d{4}$/, '');
  return {
    messageId: opts.messageId,
    receivedAt: opts.receivedAt,
    from: 'noreply@mail.turo.com',
    subject: `${opts.guestFirstName} has sent you a message about your ${vehicleNoYear}`,
    textBody: `${opts.guestFirstName} has sent you a message about your ${vehicleNoYear}.

        [guest note redacted]

    ${opts.vehicle}

            booked by ${opts.guestFirstName}

            Trip start: ${opts.tripStartFooter}
        Trip end: ${opts.tripEndFooter}

            ${opts.guestFirstName}

            Reservation ID #${opts.reservationId}
`,
  };
}

describe('findNextTripStart', () => {
  it('finds the soonest later trip for the same vehicle', () => {
    const booking = makeBooking({ reservationId: '1', tripEnd: '2026-09-21T17:00:00-06:00' });
    const later = makeBooking({ reservationId: '2', tripStart: '2026-09-25T10:00:00-06:00' });
    const soonest = makeBooking({ reservationId: '3', tripStart: '2026-09-22T09:00:00-06:00' });

    expect(findNextTripStart(booking, [booking, later, soonest])).toBe('2026-09-22T09:00:00-06:00');
  });

  it('ignores a different vehicle, the booking itself, and cancelled bookings', () => {
    const booking = makeBooking({ reservationId: '1', tripEnd: '2026-09-21T17:00:00-06:00' });
    const otherVehicle = makeBooking({
      reservationId: '2',
      vehicle: 'Cadillac Escalade ESV 2024',
      tripStart: '2026-09-22T09:00:00-06:00',
    });
    const cancelled = makeBooking({ reservationId: '3', status: 'cancelled', tripStart: '2026-09-22T09:00:00-06:00' });

    expect(findNextTripStart(booking, [booking, otherVehicle, cancelled])).toBeUndefined();
  });

  it('returns undefined when there is no later trip', () => {
    const booking = makeBooking();
    expect(findNextTripStart(booking, [booking])).toBeUndefined();
  });
});

describe('runWithDeps', () => {
  it('a booked email creates the booking and both calendar events', () => {
    const { deps, store, calendar, mailSource } = makeDeps(false, '2026-09-18T07:33:54Z');

    runWithDeps(deps, [bookedEmail()], false);

    expect(store.get('turo', '61467780')?.status).toBe('booked');
    expect(calendar.created).toHaveLength(2);
    expect(mailSource.marked).toEqual(['fixture-01']);
  });

  it('dry run logs every calendar action and the gmail label, and performs neither', () => {
    const { deps, store, calendar, mailSource } = makeDeps(true, '2026-09-18T07:33:54Z');

    runWithDeps(deps, [bookedEmail()], false);

    expect(calendar.created).toHaveLength(0);
    expect(mailSource.marked).toHaveLength(0);
    expect(store.runLog.some((line) => line.startsWith('DRY_RUN: create'))).toBe(true);
    expect(store.runLog.some((line) => line.startsWith('DRY_RUN: would label fixture-01 processed'))).toBe(true);
    expect(store.get('turo', '61467780')).not.toBeNull(); // the ledger still gets updated
  });

  it('skips calendar actions (but still updates the ledger) for a trip that already ended, during backfill', () => {
    const { deps, store, calendar } = makeDeps(false, '2027-01-01T00:00:00Z'); // long after the trip

    runWithDeps(deps, [bookedEmail()], true);

    expect(calendar.created).toHaveLength(0);
    expect(store.get('turo', '61467780')).not.toBeNull();
    expect(store.runLog.some((line) => line.includes('Skipped 2 calendar action'))).toBe(true);
  });

  it('notes a tight turnaround on the return event when the vehicle has another trip within 24 hours', () => {
    const { deps, store, calendar } = makeDeps(false, '2026-09-10T00:00:00Z');
    // Seed a later booking for the same vehicle, starting 10 hours after the first trip's return.
    // Already has event ids so the missing-event self-heal pass leaves it alone.
    store.put(
      makeBooking({
        reservationId: '99999999',
        tripStart: '2026-09-22T03:00:00-06:00',
        tripEnd: '2026-09-25T00:00:00-06:00',
        lastNoticeAt: '2026-09-01T00:00:00Z',
        updatedAt: '2026-09-01T00:00:00Z',
        pickupEventId: 'preexisting-pickup',
        returnEventId: 'preexisting-return',
      }),
    );

    runWithDeps(deps, [bookedEmail()], false);

    const returnEvent = calendar.created.find((e) => e.role === 'return');
    expect(returnEvent?.description).toContain('Another trip starts at 2026-09-22 03:00');
  });

  it('create() persists the returned event ids onto the booking', () => {
    const { deps, store } = makeDeps(false, '2026-09-18T07:33:54Z');

    runWithDeps(deps, [bookedEmail()], false);

    const booking = store.get('turo', '61467780');
    expect(booking?.pickupEventId).toBe('id-1');
    expect(booking?.returnEventId).toBe('id-2');
  });

  it('update() passes the stored event id, and persists a new one if update() had to recreate it', () => {
    const { deps, store, calendar } = makeDeps(false, '2026-09-18T07:33:54Z');
    runWithDeps(deps, [bookedEmail()], false); // creates it, ids id-1 (pickup) / id-2 (return)
    calendar.markGone('id-1'); // simulate someone deleting the pickup event by hand

    const changeEmail: RawEmail = {
      messageId: 'fixture-04',
      receivedAt: '2026-09-19T00:00:00Z', // after the booked email, so it isn't skipped as "older"
      from: 'noreply@mail.turo.com',
      subject: 'Rob has changed their trip with your Audi Q8 (61467780)',
      textBody: `Rob has changed their trip

Here’s what Rob changed:
-
    New trip end on Fri, Sep 25 11:00 AM

    Audi Q8 2021

            booked by Rob

            Trip start: 9/18/26 8:30 PM
        Trip end: 9/25/26 11:00 AM

            Rob
                    (555) 010-0001

            Reservation ID #61467780
`,
    };

    runWithDeps(deps, [changeEmail], false);

    const pickupCall = calendar.updated.find((u) => u.event.role === 'pickup');
    expect(pickupCall?.knownEventId).toBe('id-1'); // tried the stored id first
    const booking = store.get('turo', '61467780');
    expect(booking?.pickupEventId).toBe('id-3'); // recreated, new id persisted
    expect(booking?.returnEventId).toBe('id-2'); // untouched, still the original
  });

  it('a live run after a dry run still creates both events for a booking with no event ids', () => {
    const { deps: dryDeps, store, calendar } = makeDeps(true, '2026-09-18T07:33:54Z');
    runWithDeps(dryDeps, [bookedEmail()], false);

    expect(calendar.created).toHaveLength(0); // nothing really created in dry run
    expect(store.get('turo', '61467780')).not.toBeNull(); // but the ledger knows about it

    // Flip to live, reusing the same store/calendar — and feed no new emails,
    // to prove this doesn't depend on the booked email being reprocessed.
    const liveDeps: RunDeps = { ...dryDeps, dryRun: false };
    runWithDeps(liveDeps, [], false);

    expect(calendar.created.map((e) => e.role).sort()).toEqual(['pickup', 'return']);
    const booking = store.get('turo', '61467780');
    expect(booking?.pickupEventId).toBeDefined();
    expect(booking?.returnEventId).toBeDefined();
  });

  it('stops processing before the time limit and leaves the rest for the next run', () => {
    const timestamps = [0, 0, 10 * 60 * 1000]; // startedAt=0, first check=0 (ok), second check=10min (over limit)
    let call = 0;
    const { deps, store, mailSource } = makeDeps(false, '2026-09-18T07:33:54Z', () => timestamps[Math.min(call++, timestamps.length - 1)]);

    const email1 = bookedEmail({ reservationId: '11111111', messageId: 'e1' });
    const email2 = bookedEmail({ reservationId: '22222222', messageId: 'e2' });

    runWithDeps(deps, [email1, email2], false);

    expect(mailSource.marked).toEqual(['e1']); // only the first got processed
    expect(store.get('turo', '11111111')).not.toBeNull();
    expect(store.get('turo', '22222222')).toBeNull(); // left for the next run
    expect(store.runLog.some((line) => line.includes('Stopping after 1/2 email'))).toBe(true);
  });

  it('logs an unparsed row when a footer matches neither the requested nor the confirmed times', () => {
    const { deps, store } = makeDeps(false, '2026-09-20T00:00:00Z');
    store.put(
      makeBooking({
        reservationId: '58900705',
        vehicle: 'Cadillac Escalade ESV 2024',
        guestFirstName: 'JORDAN',
        guestPhone: '(555) 010-0008',
        tripStart: '2026-09-10T20:00:00-06:00',
        tripEnd: '2026-09-14T20:00:00-06:00',
        status: 'change_pending',
        requestedStart: '2026-09-15T23:30:00-06:00',
        requestedEnd: '2026-09-20T23:30:00-06:00',
        changeResponseBy: '2026-09-15T12:39:00-06:00',
        lastNoticeAt: '2026-09-15T06:39:26Z',
        updatedAt: '2026-09-15T06:39:26Z',
      }),
    );

    const email = messageEmail({
      messageId: 'synthetic-ambiguous',
      receivedAt: '2026-09-19T00:00:00Z',
      reservationId: '58900705',
      guestFirstName: 'JORDAN',
      vehicle: 'Cadillac Escalade ESV 2024',
      tripStartFooter: '9/16/26 12:00 am',
      tripEndFooter: '9/18/26 12:00 am',
    });

    runWithDeps(deps, [email], false);

    expect(store.unparsed).toHaveLength(1);
    expect(store.unparsed[0]).toMatchObject({ messageId: 'synthetic-ambiguous', subject: email.subject });
    expect(store.unparsed[0].reason).toContain('58900705');
    // Its deadline has also passed, so the same run's end-of-batch expiry
    // sweep reverts it afterward — the unparsed row is what we're checking here.
    expect(store.get('turo', '58900705')?.status).toBe('booked');
  });

  it('expires an unanswered change request past its deadline at the end of the run', () => {
    const { deps, store, calendar } = makeDeps(false, '2026-09-20T00:00:00Z');
    store.put(
      makeBooking({
        reservationId: '58900705',
        vehicle: 'Cadillac Escalade ESV 2024',
        guestFirstName: 'JORDAN',
        tripStart: '2026-09-10T20:00:00-06:00',
        tripEnd: '2026-09-14T20:00:00-06:00',
        status: 'change_pending',
        requestedStart: '2026-09-15T23:30:00-06:00',
        requestedEnd: '2026-09-20T23:30:00-06:00',
        changeResponseBy: '2026-09-15T12:39:00-06:00', // long past by "now"
        lastNoticeAt: '2026-09-15T06:39:26Z',
        updatedAt: '2026-09-15T06:39:26Z',
      }),
    );

    runWithDeps(deps, [], false);

    const reverted = store.get('turo', '58900705');
    expect(reverted?.status).toBe('booked');
    expect(reverted?.requestedStart).toBeUndefined();
    expect(calendar.updated).toHaveLength(2);
  });
});

describe('maybeSendDigest', () => {
  function makeDigestDeps() {
    const unparsed: UnparsedRow[] = [];
    const store = {
      listUnparsedSince: (sinceIso: string) =>
        unparsed.filter((row) => new Date(row.loggedAt).getTime() > new Date(sinceIso).getTime()),
    };
    return { deps: { store }, unparsed };
  }

  it('sends nothing when there is no new unparsed row', () => {
    const { deps } = makeDigestDeps();
    const sent: string[][] = [];
    let saved: string | null = null;

    maybeSendDigest(deps, '2026-09-20T00:00:00Z', () => null, (iso) => (saved = iso), {
      digest: (lines) => sent.push(lines),
    });

    expect(sent).toHaveLength(0);
    expect(saved).toBeNull();
  });

  it('sends and saves the timestamp when 24h have passed and there is something new', () => {
    const { deps, unparsed } = makeDigestDeps();
    unparsed.push({ loggedAt: '2026-09-19T12:00:00.000Z', messageId: 'm1', subject: 'subj', reason: 'why' });
    const sent: string[][] = [];
    let saved: string | null = null;

    maybeSendDigest(
      deps,
      '2026-09-20T00:00:00Z',
      () => '2026-09-18T00:00:00Z',
      (iso) => {
        saved = iso;
      },
      { digest: (lines) => sent.push(lines) },
    );

    expect(sent).toHaveLength(1);
    expect(sent[0][0]).toContain('why');
    expect(saved).toBe('2026-09-20T00:00:00Z');
  });

  it('does not send again before 24 hours have passed since the last digest', () => {
    const { deps, unparsed } = makeDigestDeps();
    unparsed.push({ loggedAt: '2026-09-19T23:00:00.000Z', messageId: 'm1', subject: 'subj', reason: 'why' });
    const sent: string[][] = [];

    maybeSendDigest(deps, '2026-09-20T00:00:00Z', () => '2026-09-19T12:00:00Z', () => {}, {
      digest: (lines) => sent.push(lines),
    });

    expect(sent).toHaveLength(0);
  });
});
