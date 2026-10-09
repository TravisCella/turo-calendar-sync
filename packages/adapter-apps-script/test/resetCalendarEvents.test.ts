import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FakeSpreadsheet,
  makeFakeCalendarApp,
  makeFakeCalendarEvent,
  makeFakeLock,
  makeFakeProperties,
  type FakeCalendarEvent,
} from './fakes';
import { resetCalendarEvents } from '../src/main';

afterEach(() => {
  vi.unstubAllGlobals();
});

const BOOKING_HEADER = [
  'platform', 'reservationId', 'vehicle', 'guestFirstName', 'guestPhone', 'location', 'tripStart',
  'tripEnd', 'status', 'requestedStart', 'requestedEnd', 'changeResponseBy', 'earningsUsd',
  'pickupEventId', 'returnEventId', 'lastNoticeAt', 'updatedAt',
];

describe('resetCalendarEvents', () => {
  it('deletes every tagged calendar event and clears ids on every booking, ignoring DRY_RUN', () => {
    const events: FakeCalendarEvent[] = [
      makeFakeCalendarEvent({ id: 'e1', tags: { turoSyncKey: 'turo:1:pickup' } }),
      makeFakeCalendarEvent({ id: 'e2', tags: { turoSyncKey: 'turo:1:return' } }),
      makeFakeCalendarEvent({ id: 'e3', title: 'Dentist' }), // untagged, not ours
    ];
    vi.stubGlobal('CalendarApp', makeFakeCalendarApp(events));
    vi.stubGlobal('LockService', { getScriptLock: makeFakeLock });
    vi.stubGlobal('PropertiesService', {
      getScriptProperties: () =>
        makeFakeProperties({ CALENDAR_ID: 'cal-1', SPREADSHEET_ID: 'ss-1', DRY_RUN: 'true' }),
    });

    const spreadsheet = new FakeSpreadsheet('ss-1', ['Bookings', 'Unparsed', 'RunLog']);
    const sheet = spreadsheet.getSheetByName('Bookings')!;
    sheet.appendRow(BOOKING_HEADER);
    sheet.appendRow([
      'turo', '1', 'Audi Q8 2021', 'Rob', '(555) 010-0001', '', '2026-09-18T20:30:00-06:00',
      '2026-09-21T17:00:00-06:00', 'booked', '', '', '', '', 'e1', 'e2', '2026-09-18T07:33:54Z', '2026-09-18T07:33:54Z',
    ]);
    sheet.appendRow([
      'turo', '2', 'Audi Q8 2021', 'Casey', '', '', '2026-07-09T20:00:00-06:00',
      '2026-07-26T20:00:00-06:00', 'booked', '', '', '', '', '', '', '2026-06-30T02:06:44Z', '2026-06-30T02:06:44Z',
    ]);
    vi.stubGlobal('SpreadsheetApp', { openById: (id: string) => (id === 'ss-1' ? spreadsheet : null) });

    resetCalendarEvents();

    expect(events.find((e) => e.id === 'e1')?.deleted).toBe(true);
    expect(events.find((e) => e.id === 'e2')?.deleted).toBe(true);
    expect(events.find((e) => e.id === 'e3')?.deleted).toBe(false); // not ours, left alone

    const rows = sheet.getDataRange().getValues();
    const row1 = rows.find((r) => r[1] === '1')!;
    expect(row1[13]).toBe(''); // pickupEventId cleared
    expect(row1[14]).toBe(''); // returnEventId cleared

    const row2 = rows.find((r) => r[1] === '2')!;
    expect(row2[13]).toBe(''); // had none to begin with, untouched
    expect(row2[14]).toBe('');
  });

  it('does nothing to the ledger when the spreadsheet has not been created yet', () => {
    const events: FakeCalendarEvent[] = [
      makeFakeCalendarEvent({ id: 'e1', tags: { turoSyncKey: 'turo:1:pickup' } }),
    ];
    vi.stubGlobal('CalendarApp', makeFakeCalendarApp(events));
    vi.stubGlobal('LockService', { getScriptLock: makeFakeLock });
    vi.stubGlobal('PropertiesService', {
      getScriptProperties: () => makeFakeProperties({ CALENDAR_ID: 'cal-1' }),
    });

    expect(() => resetCalendarEvents()).not.toThrow();
    expect(events[0].deleted).toBe(true); // the calendar side still runs
  });
});
