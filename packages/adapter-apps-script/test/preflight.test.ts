import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Booking } from '@turo-sync/core';
import { FakeSpreadsheet, makeFakeCalendarApp, makeFakeProperties, makeFakeScriptApp } from './fakes';
import { preflight } from '../src/main';

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubGlobals(opts: {
  properties?: Record<string, string>;
  calendarEvents?: Parameters<typeof makeFakeCalendarApp>[0];
  calendarName?: string;
  calendarId?: string;
  triggerHandlers?: string[];
}) {
  const fakeCalendarApp = makeFakeCalendarApp(opts.calendarEvents ?? [], opts.calendarName);
  vi.stubGlobal('CalendarApp', fakeCalendarApp);
  vi.stubGlobal('ScriptApp', makeFakeScriptApp(opts.triggerHandlers ?? []));
  vi.stubGlobal(
    'PropertiesService',
    { getScriptProperties: () => makeFakeProperties({ CALENDAR_ID: opts.calendarId ?? 'cal-1', ...opts.properties }) },
  );
  return fakeCalendarApp;
}

function makeBooking(overrides: Partial<Booking> = {}): Booking {
  return {
    platform: 'turo',
    reservationId: '1',
    vehicle: 'Audi Q8 2021',
    guestFirstName: 'Rob',
    tripStart: '2026-09-18T20:30:00-06:00',
    tripEnd: '2026-09-21T17:00:00-06:00',
    status: 'booked',
    lastNoticeAt: '2026-09-18T07:33:54Z',
    updatedAt: '2026-09-18T07:33:54Z',
    ...overrides,
  };
}

const BOOKING_HEADER = [
  'platform', 'reservationId', 'vehicle', 'guestFirstName', 'guestPhone', 'location', 'tripStart',
  'tripEnd', 'status', 'requestedStart', 'requestedEnd', 'changeResponseBy', 'earningsUsd',
  'pickupEventId', 'returnEventId', 'lastNoticeAt', 'updatedAt',
];

describe('preflight', () => {
  it('throws when CALENDAR_ID is not set', () => {
    vi.stubGlobal('PropertiesService', { getScriptProperties: () => makeFakeProperties({}) });

    expect(() => preflight()).toThrow(/CALENDAR_ID/);
  });

  it('fails loudly when CALENDAR_ID does not resolve to a calendar', () => {
    stubGlobals({ calendarId: 'missing-calendar' });

    expect(() => preflight()).toThrow(/does not resolve to a calendar/);
  });

  it('logs the calendar name, DRY_RUN, trigger count, and "not created yet" with no spreadsheet', () => {
    stubGlobals({
      calendarName: 'Turo Sync Test',
      properties: { DRY_RUN: 'false' },
      triggerHandlers: ['runSync', 'runSync', 'someOtherFunction'],
    });
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => {
      logs.push(line);
    });

    preflight();

    expect(logs.some((l) => l.includes('Turo Sync Test'))).toBe(true);
    expect(logs.some((l) => l.includes('DRY_RUN: false'))).toBe(true);
    expect(logs.some((l) => l.includes('runSync triggers installed: 2'))).toBe(true);
    expect(logs.some((l) => l.includes('not created yet'))).toBe(true);
  });

  it('logs ledger row counts and future-active-bookings-missing-ids, and writes nothing', () => {
    const fakeCalendarApp = stubGlobals({ properties: { SPREADSHEET_ID: 'ss-1' } });
    const spreadsheet = new FakeSpreadsheet('ss-1', ['Bookings', 'Unparsed', 'RunLog']);
    spreadsheet.getSheetByName('Bookings')!.appendRow(BOOKING_HEADER);
    spreadsheet.getSheetByName('Unparsed')!.appendRow(['loggedAt', 'messageId', 'subject', 'reason']);
    spreadsheet.getSheetByName('Unparsed')!.appendRow(['2026-09-01T00:00:00.000Z', 'm1', 'subj', 'reason']);
    vi.stubGlobal('SpreadsheetApp', { openById: (id: string) => (id === 'ss-1' ? spreadsheet : null) });

    // Rewrite PropertiesService to also carry SPREADSHEET_ID (stubGlobals already set CALENDAR_ID).
    vi.stubGlobal('PropertiesService', {
      getScriptProperties: () => makeFakeProperties({ CALENDAR_ID: 'cal-1', SPREADSHEET_ID: 'ss-1' }),
    });

    // Future, active, missing both ids -> counted.
    const missing = makeBooking({ reservationId: '1', tripEnd: '2027-01-01T00:00:00-07:00' });
    // Future, active, already has both ids -> not counted.
    const complete = makeBooking({
      reservationId: '2',
      tripEnd: '2027-01-01T00:00:00-07:00',
      pickupEventId: 'p',
      returnEventId: 'r',
    });
    // Already ended -> not counted even though it's missing ids.
    const ended = makeBooking({ reservationId: '3', tripEnd: '2020-01-01T00:00:00-07:00' });
    // Cancelled -> not counted.
    const cancelled = makeBooking({ reservationId: '4', status: 'cancelled', tripEnd: '2027-01-01T00:00:00-07:00' });

    const sheet = spreadsheet.getSheetByName('Bookings')!;
    for (const booking of [missing, complete, ended, cancelled]) {
      sheet.appendRow([
        booking.platform, booking.reservationId, booking.vehicle, booking.guestFirstName, '', '',
        booking.tripStart, booking.tripEnd, booking.status, '', '', '', '',
        booking.pickupEventId ?? '', booking.returnEventId ?? '', booking.lastNoticeAt, booking.updatedAt,
      ]);
    }

    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => {
      logs.push(line);
    });

    preflight();

    expect(logs.some((l) => l.includes('Ledger: 4 booking(s), 1 unparsed row(s)'))).toBe(true);
    expect(logs.some((l) => l.includes('Future active bookings missing event ids: 1'))).toBe(true);
    // Read-only: no calendar events created, no new sheet rows beyond what we seeded.
    expect(fakeCalendarApp.getCalendarById('cal-1')!.getEventsCalls).toBe(0);
    expect(fakeCalendarApp.getCalendarById('cal-1')!.getEventByIdCalls).toBe(0);
    expect(sheet.getLastRow()).toBe(5); // header + 4 bookings, nothing appended by preflight
  });
});
