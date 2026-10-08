// The only way core talks to the outside world. Each runtime (Apps Script now,
// HostLedger later) provides its own adapters for these interfaces.

import type { Booking, CalendarEventSpec, Platform, RawEmail } from './types';

export interface MailSource {
  /** Unprocessed platform emails, oldest first. */
  fetchNew(): RawEmail[];
  markProcessed(messageId: string): void;
}

export interface BookingStore {
  get(platform: Platform, reservationId: string): Booking | null;
  put(booking: Booking): void;
  logUnparsed(messageId: string, subject: string, reason: string): void;
}

export interface CalendarSink {
  /** Returns the provider's event id. */
  create(event: CalendarEventSpec): string;
  update(event: CalendarEventSpec): void;
  /** Must only delete events this sync created (matched by event.key tag). */
  delete(key: string): void;
}

export interface Notifier {
  digest(lines: string[]): void;
}

export interface Clock {
  now(): string; // ISO timestamp
}
