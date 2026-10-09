import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CalendarEventSpec } from '@turo-sync/core';
import { makeFakeCalendarApp, type FakeCalendarEvent } from './fakes';
import { CalendarAppCalendarSink } from '../src/calendarSink';

afterEach(() => {
  vi.unstubAllGlobals();
});

function makeSpec(overrides: Partial<CalendarEventSpec> = {}): CalendarEventSpec {
  return {
    key: 'turo:61467780:pickup',
    role: 'pickup',
    title: 'PICKUP · Audi Q8 · Rob',
    start: '2026-09-18T20:30:00-06:00',
    end: '2026-09-18T21:00:00-06:00',
    location: 'Salt Lake City International Airport',
    description: 'Rob · (555) 010-0001',
    colorKey: 'Audi Q8 2021',
    tentative: false,
    ...overrides,
  };
}

describe('CalendarAppCalendarSink', () => {
  it('throws when the calendar id does not resolve', () => {
    vi.stubGlobal('CalendarApp', makeFakeCalendarApp([]));
    expect(() => new CalendarAppCalendarSink('missing-calendar')).toThrow(/Calendar not found/);
  });

  it('create() tags the event and sets pickup reminders (2h and 30m)', () => {
    const events: FakeCalendarEvent[] = [];
    vi.stubGlobal('CalendarApp', makeFakeCalendarApp(events));

    const sink = new CalendarAppCalendarSink('cal-1');
    const id = sink.create(makeSpec());

    expect(events).toHaveLength(1);
    expect(events[0].tags['turoSyncKey']).toBe('turo:61467780:pickup');
    expect(events[0].reminders.sort((a, b) => a - b)).toEqual([30, 120]);
    expect(id).toBe(events[0].id);
  });

  it('return events only get a 30-minute reminder', () => {
    const events: FakeCalendarEvent[] = [];
    vi.stubGlobal('CalendarApp', makeFakeCalendarApp(events));

    new CalendarAppCalendarSink('cal-1').create(makeSpec({ key: 'turo:61467780:return', role: 'return' }));

    expect(events[0].reminders).toEqual([30]);
  });

  it('update() finds the event by its tag and changes title/time/location/description', () => {
    const events: FakeCalendarEvent[] = [];
    vi.stubGlobal('CalendarApp', makeFakeCalendarApp(events));

    const sink = new CalendarAppCalendarSink('cal-1');
    sink.create(makeSpec());
    sink.update(
      makeSpec({
        title: 'CHANGE REQUESTED · PICKUP · Audi Q8 · Rob',
        start: '2026-09-19T20:30:00-06:00',
        end: '2026-09-19T21:00:00-06:00',
        tentative: true,
      }),
    );

    expect(events).toHaveLength(1); // no duplicate created
    expect(events[0].title).toBe('CHANGE REQUESTED · PICKUP · Audi Q8 · Rob');
    expect(events[0].start.toISOString()).toBe(new Date('2026-09-19T20:30:00-06:00').toISOString());
    expect(events[0].color).toBe('8'); // GRAY, since tentative
  });

  it('update() recreates the event if nothing tagged with its key exists', () => {
    const events: FakeCalendarEvent[] = [];
    vi.stubGlobal('CalendarApp', makeFakeCalendarApp(events));

    const id = new CalendarAppCalendarSink('cal-1').update(makeSpec());

    expect(events).toHaveLength(1);
    expect(events[0].tags['turoSyncKey']).toBe('turo:61467780:pickup');
    expect(id).toBe(events[0].id); // the caller needs this to re-persist it
  });

  it('update() with a known event id uses getEventById and never scans by tag', () => {
    const events: FakeCalendarEvent[] = [];
    const fakeCalendarApp = makeFakeCalendarApp(events);
    vi.stubGlobal('CalendarApp', fakeCalendarApp);

    const sink = new CalendarAppCalendarSink('cal-1');
    const id = sink.create(makeSpec());
    const calendar = fakeCalendarApp.getCalendarById('cal-1')!;
    const getEventsCallsAfterCreate = calendar.getEventsCalls;

    const returnedId = sink.update(makeSpec({ title: 'Updated title' }), id);

    expect(returnedId).toBeUndefined(); // normal update, nothing recreated
    expect(calendar.getEventByIdCalls).toBe(1);
    expect(calendar.getEventsCalls).toBe(getEventsCallsAfterCreate); // no tag scan needed
    expect(events[0].title).toBe('Updated title');
  });

  it('update() falls back to the tag search when the known id is gone', () => {
    const events: FakeCalendarEvent[] = [];
    const fakeCalendarApp = makeFakeCalendarApp(events);
    vi.stubGlobal('CalendarApp', fakeCalendarApp);

    const sink = new CalendarAppCalendarSink('cal-1');
    sink.create(makeSpec());
    const calendar = fakeCalendarApp.getCalendarById('cal-1')!;

    const returnedId = sink.update(makeSpec({ title: 'Updated title' }), 'some-stale-id-not-in-the-store');

    expect(calendar.getEventByIdCalls).toBe(1); // tried first
    expect(calendar.getEventsCalls).toBeGreaterThan(0); // then fell back
    expect(events[0].title).toBe('Updated title'); // found via the tag scan
    expect(returnedId).toBeUndefined(); // it was found, not recreated
  });

  it('update() ignores a known id whose event belongs to a different key', () => {
    const events: FakeCalendarEvent[] = [];
    vi.stubGlobal('CalendarApp', makeFakeCalendarApp(events));

    const sink = new CalendarAppCalendarSink('cal-1');
    const otherId = sink.create(makeSpec({ key: 'turo:99999999:pickup' }));
    sink.create(makeSpec({ key: 'turo:61467780:pickup' }));

    // Passing the OTHER booking's event id as if it were this one's should not
    // corrupt that other event — it must fall back to the correct tag match.
    sink.update(makeSpec({ key: 'turo:61467780:pickup', title: 'Updated title' }), otherId);

    expect(events.find((e) => e.id === otherId)?.title).not.toBe('Updated title');
    expect(events.find((e) => e.tags['turoSyncKey'] === 'turo:61467780:pickup')?.title).toBe('Updated title');
  });

  it('delete() with a known event id uses getEventById', () => {
    const events: FakeCalendarEvent[] = [];
    const fakeCalendarApp = makeFakeCalendarApp(events);
    vi.stubGlobal('CalendarApp', fakeCalendarApp);

    const sink = new CalendarAppCalendarSink('cal-1');
    const id = sink.create(makeSpec());
    const calendar = fakeCalendarApp.getCalendarById('cal-1')!;

    sink.delete('turo:61467780:pickup', id);

    expect(calendar.getEventByIdCalls).toBe(1);
    expect(events[0].deleted).toBe(true);
  });

  it('delete() only removes the event carrying the matching tag', () => {
    const events: FakeCalendarEvent[] = [];
    vi.stubGlobal('CalendarApp', makeFakeCalendarApp(events));

    const sink = new CalendarAppCalendarSink('cal-1');
    sink.create(makeSpec({ key: 'turo:61467780:pickup' }));
    sink.create(makeSpec({ key: 'turo:61467780:return', role: 'return' }));

    sink.delete('turo:61467780:pickup');

    expect(events.find((e) => e.tags['turoSyncKey'] === 'turo:61467780:pickup')?.deleted).toBe(true);
    expect(events.find((e) => e.tags['turoSyncKey'] === 'turo:61467780:return')?.deleted).toBe(false);
  });

  it('delete() is a no-op when no event carries the key', () => {
    const events: FakeCalendarEvent[] = [];
    vi.stubGlobal('CalendarApp', makeFakeCalendarApp(events));

    expect(() => new CalendarAppCalendarSink('cal-1').delete('turo:nonexistent:pickup')).not.toThrow();
  });
});
