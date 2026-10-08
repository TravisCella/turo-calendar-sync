// Core domain types. Platform-free: no Gmail, Calendar, Supabase or Node types here.

export type Platform = 'turo' | 'outdoorsy';

export interface RawEmail {
  messageId: string;      // provider's message id, for dedupe
  receivedAt: string;     // ISO timestamp
  from: string;
  subject: string;
  textBody: string;
}

export type NoticeKind =
  | 'booked' | 'changed' | 'change_requested'
  | 'cancelled' | 'upcoming' | 'message' | 'ignored';

export interface ParsedNotice {
  platform: Platform;
  kind: Exclude<NoticeKind, 'ignored'>;
  reservationId: string;
  guestFirstName: string;     // subject prefix, e.g. 'Kevin Mark'
  vehicle: string;            // 'Audi Q8 2021'
  tripStart: string;          // ISO with offset, from the footer
  tripEnd: string;
  location?: string;          // 'Salt Lake City International Airport'
  guestPhone?: string;
  earningsUsd?: number;
  requestedStart?: string;    // change_requested only, from body
  requestedEnd?: string;
  changeResponseBy?: string;  // change_requested only: Turo's response deadline
  sourceMessageId: string;
  sourceReceivedAt: string;
}

export interface IgnoredNotice {
  kind: 'ignored';
}

export type ParseResult = ParsedNotice | IgnoredNotice;

export type BookingStatus = 'booked' | 'change_pending' | 'cancelled' | 'completed';

export interface Booking {
  platform: Platform;
  reservationId: string;      // primary key with platform
  vehicle: string;
  guestFirstName: string;
  guestPhone?: string;
  location?: string;
  tripStart: string;
  tripEnd: string;
  status: BookingStatus;
  requestedStart?: string;
  requestedEnd?: string;
  changeResponseBy?: string;  // past this with no footer showing requested times = declined (Turo rule)
  earningsUsd?: number;
  pickupEventId?: string;
  returnEventId?: string;
  lastNoticeAt: string;       // receivedAt of the newest notice applied
  updatedAt: string;
}

export type EventRole = 'pickup' | 'return';

export interface CalendarEventSpec {
  key: string;                // `${platform}:${reservationId}:${role}`
  role: EventRole;
  title: string;              // 'PICKUP · Audi Q8 · Rob', with NO LOCATION / CHANGE REQUESTED prefixes
  start: string;              // ISO with offset
  end: string;                // start + 30 minutes
  location?: string;
  description: string;        // guest name and phone, reservation link, trip window, mileage
  colorKey: string;           // vehicle, mapped to a color by the adapter
  tentative: boolean;
}

export type CalendarAction =
  | { type: 'create'; event: CalendarEventSpec }
  | { type: 'update'; event: CalendarEventSpec }
  | { type: 'delete'; key: string };

export interface ReconcileResult {
  booking: Booking | null;    // null when the notice was skipped
  actions: CalendarAction[];
}
