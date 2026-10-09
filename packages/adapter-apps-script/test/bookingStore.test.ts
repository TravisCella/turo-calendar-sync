import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Booking } from '@turo-sync/core';
import { FakeSpreadsheet, makeFakeSpreadsheetApp } from './fakes';
import { SheetBookingStore } from '../src/bookingStore';

afterEach(() => {
  vi.unstubAllGlobals();
});

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

const BOOKING_HEADER = [
  'platform', 'reservationId', 'vehicle', 'guestFirstName', 'guestPhone', 'location', 'tripStart',
  'tripEnd', 'status', 'requestedStart', 'requestedEnd', 'changeResponseBy', 'earningsUsd',
  'pickupEventId', 'returnEventId', 'lastNoticeAt', 'updatedAt',
];

function makeStore(): { store: SheetBookingStore; spreadsheet: FakeSpreadsheet } {
  const spreadsheet = new FakeSpreadsheet('ss-1', ['Bookings', 'Unparsed', 'RunLog']);
  spreadsheet.getSheetByName('Bookings')!.appendRow(BOOKING_HEADER);
  spreadsheet.getSheetByName('Unparsed')!.appendRow(['loggedAt', 'messageId', 'subject', 'reason']);
  spreadsheet.getSheetByName('RunLog')!.appendRow(['timestamp', 'message']);
  const store = new SheetBookingStore(spreadsheet as unknown as GoogleAppsScript.Spreadsheet.Spreadsheet);
  return { store, spreadsheet };
}

describe('SheetBookingStore.openOrCreate', () => {
  it('creates a new spreadsheet with Bookings/Unparsed/RunLog tabs and saves its id', () => {
    const spreadsheetApp = makeFakeSpreadsheetApp();
    vi.stubGlobal('SpreadsheetApp', spreadsheetApp);
    let savedId: string | null = null;

    SheetBookingStore.openOrCreate(
      () => null,
      (id) => {
        savedId = id;
      },
    );

    expect(savedId).not.toBeNull();
    const spreadsheet = spreadsheetApp.openById(savedId!);
    expect(spreadsheet.getSheetByName('Bookings')).not.toBeNull();
    expect(spreadsheet.getSheetByName('Unparsed')).not.toBeNull();
    expect(spreadsheet.getSheetByName('RunLog')).not.toBeNull();
    expect(spreadsheet.getSheetByName('Sheet1')).toBeNull(); // default tab dropped
    expect(spreadsheet.getSheetByName('Bookings')!.getLastRow()).toBe(1); // header only
  });

  it('reopens an existing spreadsheet by id without creating a new one', () => {
    const spreadsheetApp = makeFakeSpreadsheetApp();
    vi.stubGlobal('SpreadsheetApp', spreadsheetApp);

    const existing = spreadsheetApp.create('Turo Sync Ledger');
    existing.insertSheet('Sentinel'); // marks this exact spreadsheet instance

    let saveCalls = 0;
    SheetBookingStore.openOrCreate(
      () => existing.getId(),
      () => {
        saveCalls += 1;
      },
    );

    expect(saveCalls).toBe(0); // only a freshly-created spreadsheet gets saved
    expect(existing.getSheetByName('Sentinel')).not.toBeNull(); // same instance, not replaced
  });
});

describe('SheetBookingStore', () => {
  it('get() returns null for an unknown reservation', () => {
    const { store } = makeStore();
    expect(store.get('turo', 'does-not-exist')).toBeNull();
  });

  it('put() then get() round-trips a booking, including optional fields', () => {
    const { store } = makeStore();
    const booking = makeBooking({ earningsUsd: 245.84 });

    store.put(booking);

    expect(store.get('turo', '61467780')).toEqual(booking);
  });

  it('put() updates an existing row in place rather than appending a duplicate', () => {
    const { store, spreadsheet } = makeStore();

    store.put(makeBooking());
    store.put(makeBooking({ tripEnd: '2026-09-23T12:00:00-06:00', lastNoticeAt: '2026-09-23T18:24:26Z' }));

    expect(spreadsheet.getSheetByName('Bookings')!.getLastRow()).toBe(2); // header + one booking row
    expect(store.get('turo', '61467780')?.tripEnd).toBe('2026-09-23T12:00:00-06:00');
  });

  it('listAll() returns every stored booking', () => {
    const { store } = makeStore();

    store.put(makeBooking({ reservationId: '1' }));
    store.put(makeBooking({ reservationId: '2' }));

    expect(store.listAll().map((b) => b.reservationId).sort()).toEqual(['1', '2']);
  });

  it('logUnparsed() appends a row, and listUnparsedSince() filters by timestamp', () => {
    const { store, spreadsheet } = makeStore();
    spreadsheet.getSheetByName('Unparsed')!.appendRow(['2026-09-01T00:00:00.000Z', 'm1', 'subj1', 'old reason']);

    store.logUnparsed('m2', 'subj2', 'new reason');

    expect(store.listUnparsedSince('2026-09-15T00:00:00.000Z').map((r) => r.messageId)).toEqual(['m2']);
    expect(store.listUnparsedSince('2026-01-01T00:00:00.000Z').map((r) => r.messageId)).toEqual(['m1', 'm2']);
  });

  it('logRun() appends a timestamped row to RunLog', () => {
    const { store, spreadsheet } = makeStore();

    store.logRun('DRY_RUN: would create turo:1:pickup');

    const rows = spreadsheet.getSheetByName('RunLog')!.getDataRange().getValues();
    expect(rows[1][1]).toBe('DRY_RUN: would create turo:1:pickup');
  });
});
