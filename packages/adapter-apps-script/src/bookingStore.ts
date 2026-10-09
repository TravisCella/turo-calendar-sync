// SpreadsheetApp-backed BookingStore: Bookings, Unparsed, RunLog tabs.
// Creates the spreadsheet on first run; the caller is responsible for
// persisting the id it returns (see openOrCreate).

import type { Booking, BookingStatus, BookingStore, Platform } from '@turo-sync/core';

const BOOKINGS_SHEET = 'Bookings';
const UNPARSED_SHEET = 'Unparsed';
const RUNLOG_SHEET = 'RunLog';

const BOOKING_COLUMNS = [
  'platform',
  'reservationId',
  'vehicle',
  'guestFirstName',
  'guestPhone',
  'location',
  'tripStart',
  'tripEnd',
  'status',
  'requestedStart',
  'requestedEnd',
  'changeResponseBy',
  'earningsUsd',
  'pickupEventId',
  'returnEventId',
  'lastNoticeAt',
  'updatedAt',
] as const;

const UNPARSED_COLUMNS = ['loggedAt', 'messageId', 'subject', 'reason'] as const;
const RUNLOG_COLUMNS = ['timestamp', 'message'] as const;

export interface UnparsedRow {
  loggedAt: string;
  messageId: string;
  subject: string;
  reason: string;
}

type Row = (string | number)[];

function bookingToRow(b: Booking): Row {
  return [
    b.platform,
    b.reservationId,
    b.vehicle,
    b.guestFirstName,
    b.guestPhone ?? '',
    b.location ?? '',
    b.tripStart,
    b.tripEnd,
    b.status,
    b.requestedStart ?? '',
    b.requestedEnd ?? '',
    b.changeResponseBy ?? '',
    b.earningsUsd ?? '',
    b.pickupEventId ?? '',
    b.returnEventId ?? '',
    b.lastNoticeAt,
    b.updatedAt,
  ];
}

function rowToBooking(row: Row): Booking {
  const [
    platform,
    reservationId,
    vehicle,
    guestFirstName,
    guestPhone,
    location,
    tripStart,
    tripEnd,
    status,
    requestedStart,
    requestedEnd,
    changeResponseBy,
    earningsUsd,
    pickupEventId,
    returnEventId,
    lastNoticeAt,
    updatedAt,
  ] = row;

  const booking: Booking = {
    platform: platform as Platform,
    reservationId: String(reservationId),
    vehicle: String(vehicle),
    guestFirstName: String(guestFirstName),
    tripStart: String(tripStart),
    tripEnd: String(tripEnd),
    status: status as BookingStatus,
    lastNoticeAt: String(lastNoticeAt),
    updatedAt: String(updatedAt),
  };
  if (guestPhone) booking.guestPhone = String(guestPhone);
  if (location) booking.location = String(location);
  if (requestedStart) booking.requestedStart = String(requestedStart);
  if (requestedEnd) booking.requestedEnd = String(requestedEnd);
  if (changeResponseBy) booking.changeResponseBy = String(changeResponseBy);
  if (earningsUsd !== '' && earningsUsd !== undefined && earningsUsd !== null) {
    booking.earningsUsd = Number(earningsUsd);
  }
  if (pickupEventId) booking.pickupEventId = String(pickupEventId);
  if (returnEventId) booking.returnEventId = String(returnEventId);
  return booking;
}

function ensureSheet(
  spreadsheet: GoogleAppsScript.Spreadsheet.Spreadsheet,
  name: string,
  columns: readonly string[],
): GoogleAppsScript.Spreadsheet.Sheet {
  let sheet = spreadsheet.getSheetByName(name);
  if (!sheet) sheet = spreadsheet.insertSheet(name);
  if (sheet.getLastRow() === 0) sheet.appendRow([...columns]);
  return sheet;
}

function ensureSheets(spreadsheet: GoogleAppsScript.Spreadsheet.Spreadsheet): void {
  ensureSheet(spreadsheet, BOOKINGS_SHEET, BOOKING_COLUMNS);
  ensureSheet(spreadsheet, UNPARSED_SHEET, UNPARSED_COLUMNS);
  ensureSheet(spreadsheet, RUNLOG_SHEET, RUNLOG_COLUMNS);

  // SpreadsheetApp.create() leaves a default "Sheet1"; drop it once our tabs exist.
  const defaultSheet = spreadsheet.getSheetByName('Sheet1');
  if (defaultSheet && spreadsheet.getSheets().length > 1) {
    spreadsheet.deleteSheet(defaultSheet);
  }
}

export class SheetBookingStore implements BookingStore {
  constructor(private spreadsheet: GoogleAppsScript.Spreadsheet.Spreadsheet) {}

  static openOrCreate(
    getSpreadsheetId: () => string | null,
    saveSpreadsheetId: (id: string) => void,
  ): SheetBookingStore {
    const existingId = getSpreadsheetId();
    const spreadsheet = existingId ? SpreadsheetApp.openById(existingId) : SpreadsheetApp.create('Turo Sync Ledger');
    ensureSheets(spreadsheet);
    if (!existingId) saveSpreadsheetId(spreadsheet.getId());
    return new SheetBookingStore(spreadsheet);
  }

  private sheet(name: string): GoogleAppsScript.Spreadsheet.Sheet {
    const sheet = this.spreadsheet.getSheetByName(name);
    if (!sheet) throw new Error(`Sheet not found: ${name}`);
    return sheet;
  }

  get(platform: Platform, reservationId: string): Booking | null {
    const values = this.sheet(BOOKINGS_SHEET).getDataRange().getValues();
    for (let i = 1; i < values.length; i++) {
      if (values[i][0] === platform && String(values[i][1]) === reservationId) {
        return rowToBooking(values[i]);
      }
    }
    return null;
  }

  put(booking: Booking): void {
    const sheet = this.sheet(BOOKINGS_SHEET);
    const values = sheet.getDataRange().getValues();
    const row = bookingToRow(booking);

    for (let i = 1; i < values.length; i++) {
      if (values[i][0] === booking.platform && String(values[i][1]) === booking.reservationId) {
        sheet.getRange(i + 1, 1, 1, row.length).setValues([row]);
        return;
      }
    }
    sheet.appendRow(row);
  }

  listAll(): Booking[] {
    const values = this.sheet(BOOKINGS_SHEET).getDataRange().getValues();
    return values.slice(1).filter((row) => row[0] !== '' && row[0] !== undefined).map(rowToBooking);
  }

  logUnparsed(messageId: string, subject: string, reason: string): void {
    this.sheet(UNPARSED_SHEET).appendRow([new Date().toISOString(), messageId, subject, reason]);
  }

  listUnparsedSince(sinceIso: string): UnparsedRow[] {
    const values = this.sheet(UNPARSED_SHEET).getDataRange().getValues();
    const since = new Date(sinceIso).getTime();
    return values
      .slice(1)
      .filter((row) => row[0] !== '' && row[0] !== undefined && new Date(String(row[0])).getTime() > since)
      .map(([loggedAt, messageId, subject, reason]) => ({
        loggedAt: String(loggedAt),
        messageId: String(messageId),
        subject: String(subject),
        reason: String(reason),
      }));
  }

  logRun(message: string): void {
    this.sheet(RUNLOG_SHEET).appendRow([new Date().toISOString(), message]);
  }
}
