// CalendarApp-backed CalendarSink. Every event we own carries a tag so we
// can find and fix it later (Spec.md "Idempotency") and so update/delete
// never touch an event this sync didn't create.

import type { CalendarEventSpec, CalendarSink } from '@turo-sync/core';

const TAG_KEY = 'turoSyncKey';
const SEARCH_WINDOW_DAYS = 400;

// Deterministic, config-free color assignment per vehicle. Computed lazily
// (not at module load) so this module can be imported before a test's fake
// CalendarApp global is in place.
function colorPalette(): GoogleAppsScript.Calendar.EventColor[] {
  return [
    CalendarApp.EventColor.BLUE,
    CalendarApp.EventColor.GREEN,
    CalendarApp.EventColor.YELLOW,
    CalendarApp.EventColor.ORANGE,
    CalendarApp.EventColor.RED,
    CalendarApp.EventColor.CYAN,
    CalendarApp.EventColor.PALE_BLUE,
    CalendarApp.EventColor.PALE_GREEN,
    CalendarApp.EventColor.MAUVE,
    CalendarApp.EventColor.PALE_RED,
  ];
}

function colorForVehicle(colorKey: string): GoogleAppsScript.Calendar.EventColor {
  let hash = 0;
  for (let i = 0; i < colorKey.length; i++) hash = (hash * 31 + colorKey.charCodeAt(i)) >>> 0;
  const palette = colorPalette();
  return palette[hash % palette.length];
}

function applyColorAndReminders(calEvent: GoogleAppsScript.Calendar.CalendarEvent, event: CalendarEventSpec): void {
  // Google Calendar has no native "tentative" status for events you own
  // (that's only for a guest's RSVP), so a pending change is marked with a
  // distinct color instead; the title prefix carries the rest of the signal.
  // The ambient types declare EventColor as a numeric TS enum, but the real
  // Apps Script object returns Google Calendar's string color ids at
  // runtime ("1".."11"); setColor expects that string, hence the cast.
  calEvent.setColor(String(event.tentative ? CalendarApp.EventColor.GRAY : colorForVehicle(event.colorKey)));

  calEvent.removeAllReminders();
  calEvent.addPopupReminder(30);
  calEvent.addPopupReminder(120);
}

export class CalendarAppCalendarSink implements CalendarSink {
  private calendar: GoogleAppsScript.Calendar.Calendar;

  constructor(calendarId: string) {
    const calendar = CalendarApp.getCalendarById(calendarId);
    if (!calendar) throw new Error(`Calendar not found: ${calendarId}`);
    this.calendar = calendar;
  }

  create(event: CalendarEventSpec): string {
    const calEvent = this.calendar.createEvent(event.title, new Date(event.start), new Date(event.end), {
      location: event.location,
      description: event.description,
    });
    calEvent.setTag(TAG_KEY, event.key);
    applyColorAndReminders(calEvent, event);
    return calEvent.getId();
  }

  // knownEventId (the ledger's stored pickupEventId/returnEventId) is tried
  // first via getEventById — a single lookup instead of scanning a date
  // window. Only missing or gone (deleted by hand) falls back to the tag
  // search. Returns the new event's id when the tagged event was gone and
  // had to be recreated, so the caller can re-persist it; otherwise undefined.
  update(event: CalendarEventSpec, knownEventId?: string): string | undefined {
    const calEvent = this.findEvent(event.key, knownEventId);
    if (!calEvent) {
      return this.create(event);
    }
    calEvent.setTitle(event.title);
    calEvent.setTime(new Date(event.start), new Date(event.end));
    calEvent.setLocation(event.location ?? '');
    calEvent.setDescription(event.description);
    calEvent.setTag(TAG_KEY, event.key);
    applyColorAndReminders(calEvent, event);
    return undefined;
  }

  delete(key: string, knownEventId?: string): void {
    const calEvent = this.findEvent(key, knownEventId);
    if (calEvent) calEvent.deleteEvent();
  }

  // Deletes every event this sync ever tagged, regardless of key — an
  // explicit full reset, not a per-booking operation. Returns how many it
  // deleted so the caller can report it.
  deleteAllTagged(): number {
    const tagged = this.searchWindow().filter((event) => !!event.getTag(TAG_KEY));
    tagged.forEach((event) => event.deleteEvent());
    return tagged.length;
  }

  private findEvent(key: string, knownEventId?: string): GoogleAppsScript.Calendar.CalendarEvent | null {
    if (knownEventId) {
      const byId = this.tryGetEventById(knownEventId);
      if (byId && byId.getTag(TAG_KEY) === key) return byId;
    }
    return this.findByKey(key);
  }

  private tryGetEventById(id: string): GoogleAppsScript.Calendar.CalendarEvent | null {
    try {
      return this.calendar.getEventById(id) ?? null;
    } catch {
      return null; // deleted by hand, or an id from another calendar
    }
  }

  // Only deletes/updates events carrying our own tag, matched by this key.
  // Last resort: getEventById needs a known id; this is how we stay
  // rediscoverable even if the ledger (and its ids) is lost entirely.
  private findByKey(key: string): GoogleAppsScript.Calendar.CalendarEvent | null {
    return this.searchWindow().find((event) => event.getTag(TAG_KEY) === key) ?? null;
  }

  private searchWindow(): GoogleAppsScript.Calendar.CalendarEvent[] {
    const now = new Date();
    const windowMs = SEARCH_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    return this.calendar.getEvents(new Date(now.getTime() - windowMs), new Date(now.getTime() + windowMs));
  }
}
