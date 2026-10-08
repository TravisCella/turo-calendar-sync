# Turo → Google Calendar Sync: Build Spec

Oct 7, 2026 · @Travis Cella

## Overview

We will build a sync that reads Turo's booking emails in Gmail and keeps pickup and return events current on a Google Calendar. v1 runs as a Google Apps Script in Travis's own Google account. v2 lifts the same core code into HostLedger as a feature module.

**Problem.** Turo has no public API and no calendar export for hosts, so the drop-off and pickup schedule lives only inside the Turo app. Pickup and return handoffs get planned by scrolling the app.

**Goal.** Within 10 minutes of a Turo email arriving, the calendar shows a correct pickup and return event for every active booking, including changes and cancellations.

**In scope for v1**

- Turo notices: booked, changed, change requested, cancelled, upcoming-trip reminder
- Two events per booking (pickup, return) on the shared Family calendar
- One-time backfill of future trips already in Gmail
- A Google Sheet ledger of bookings, which doubles as the future HostLedger table

**Not in v1**

- Outdoorsy (planned as a second parser in phase 4)
- Writing anything back to Turo
- Earnings or analytics (HostLedger's job)
- Scraping turo.com

## What the Turo emails contain

Every transactional Turo email ends in the same trip footer, so one footer parser covers almost every notice type. This comes from five real emails sampled from travis.cella@gmail.com (Jun to Sep 2026), all sent from noreply@mail.turo.com.

The footer looks like this in every booked, changed, change-requested, cancelled, upcoming and guest-message email:

```
Audi Q8 2021
        booked by Rich
        Trip start: 9/18/26 8:30 pm
    Trip end: 9/21/26 5:00 pm
        You earn: $245.84
    Mileage included: 600 miles
        Rich
                (xxx) xxx-xxxx
        Reservation ID #61467780
```

**Parsing facts that matter**

- Reservation ID is the stable key. It appears as `Reservation ID #NNNNNNNN` and in every `turo.com/reservation/NNNNNNNN` link.
- Footer dates use `M/D/YY h:mm am|pm`, and the case of am/pm varies between emails. Parse case-insensitively.
- Body sentences use other formats (`Friday, September 18, 2026, 8:30 PM`, and `Fri, Oct 16 11:00 AM` with no year). Ignore them; always take times from the footer.
- Times carry no time zone. Treat them as the vehicle's local time, America/Denver for the current fleet.
- Location shows only in the body (`with your Audi Q8 at Salt Lake City International Airport`). When absent, the trip uses the host's standard pickup spot.
- Vehicle line is `<Make Model> <Year>`. Seen so far: Audi Q8 2021, Cadillac Escalade ESV 2024.
- Cancelled emails say `requested by` instead of `booked by` and have no earnings or phone.

**Notice types and what the sync does**

| Notice | Subject pattern | Action |
| --- | --- | --- |
| Booked | `<Guest>'s trip with your <Vehicle> is booked!` | Create booking and both events |
| Changed | `<Guest> has changed their trip with your <Vehicle> (<ResID>)` | Update times from footer |
| Change requested | `<Guest> has requested a change to their trip...` | Flag events as pending change; do not move them |
| Cancelled | `<Guest> has cancelled their trip with your <Vehicle>` | Mark cancelled, remove events |
| Upcoming trip | `<Guest> has an upcoming trip with your <Vehicle>` | Reconcile: create if missing |
| Guest message | `<Guest> has sent you a message about your <Vehicle>` | Reconcile footer times only |
| Rated, earnings, marketing, support | various | Ignore |

The change-requested footer still shows the old times. The new times appear only in the body, so a pending request must never move an event.

## Portable architecture

All business logic lives in a pure TypeScript `core/` that never calls Gmail, Calendar or Supabase directly. It talks to the outside through four ports: MailSource, BookingStore, CalendarSink and Notifier. v1 and v2 differ only in which adapters plug into those ports.

&#91;embedded content: sync architecture · one core, two sets of adapters\]

Arrows are the ports. Solid boxes are built in v1; dashed boxes are written when the module moves into HostLedger.

## Data model

Four core types carry everything, and none of them mention Gmail, Apps Script or Google Calendar. The Booking shape is the HostLedger table schema from day one.

```typescript
// core/types.ts
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
  kind: NoticeKind;
  reservationId: string;
  guestFirstName: string;
  vehicle: string;            // 'Audi Q8 2021'
  tripStart: string;          // ISO with offset, from the footer
  tripEnd: string;
  location?: string;          // 'Salt Lake City International Airport'
  guestPhone?: string;
  earningsUsd?: number;
  requestedStart?: string;    // change_requested only, from body
  requestedEnd?: string;
  sourceMessageId: string;
  sourceReceivedAt: string;
}

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
  earningsUsd?: number;
  pickupEventId?: string;
  returnEventId?: string;
  lastNoticeAt: string;       // receivedAt of the newest notice applied
  updatedAt: string;
}

export interface CalendarEventSpec {
  key: string;                // `${platform}:${reservationId}:pickup|return`
  title: string;
  start: string;
  end: string;
  location?: string;
  description: string;
  colorKey: string;           // vehicle, mapped to a color by the adapter
  tentative: boolean;
}
```

`lastNoticeAt` is what makes out-of-order processing safe: an older email never overwrites a newer one.

## Sync logic

Each run does the same four steps: fetch unprocessed Turo emails, parse each into a notice, reconcile it against the stored booking, then apply the resulting calendar actions. Only the fetch and apply steps touch Google.

**Reconcile rules** (pure function: `reconcile(existing: Booking | null, notice: ParsedNotice) → { booking, actions[] }`)

1. Skip if `notice.sourceReceivedAt` is older than `existing.lastNoticeAt`.
2. `booked`: create the booking; actions = create pickup and return events.
3. `changed`: overwrite tripStart and tripEnd from the footer; clear any pending flag; actions = update both events.
4. `change_requested`: set status `change_pending` and store requested times; actions = mark both events tentative and add the requested times to the description. Times stay put.
5. `cancelled`: set status `cancelled`; actions = delete both events.
6. `upcoming` or `message`: if no booking exists, create it as in rule 2. If the footer times differ from stored times, apply them as in rule 3. This self-heals a missed or unparsed email.
7. Unknown subject from mail.turo.com containing a Reservation ID: log it to an Unparsed tab and send one daily digest email. Never guess.

**Idempotency**

- The ledger is keyed on platform + reservationId, so re-processing an email is a no-op.
- Each calendar event stores its key in a private extended property, so the sync can find and fix its own events even if the ledger is lost. On the shared Family calendar, this tag also ensures the sync only edits or deletes events it created.
- Processed emails get a Gmail label `TuroSync/Processed`; the fetch query excludes it.

**Backfill.** First run reads the last 365 days of Turo notices, sorts them oldest first, and replays them through the same reconcile function. Only trips ending after today get calendar events. Your inbox already holds bookings into March 2027.

**Edge cases to test**

- A change-request email followed by no confirmation email (unknown if Turo sends one; see Open decisions)
- A host-initiated cancellation, whose wording has not been sampled yet
- A trip extension sent as a change
- Two emails for the same reservation in one run
- Daylight saving: a trip spanning Nov 1, 2026 must keep wall-clock times

## Calendar event design

Each booking produces two events, a pickup and a return, on the shared **Family** calendar so both of you see every handoff. Turo already enforces turnaround time between trips, so events sit at the exact trip times with no added buffers.

| Field | Pickup event | Return event |
| --- | --- | --- |
| Title | `PICKUP · Audi Q8 · Rich` | `RETURN · Audi Q8 · Rich` |
| Start | trip start | trip end |
| Length | 30 minutes | 30 minutes |
| Location | parsed location; if none, title starts with `NO LOCATION ·` | same |
| Color | per vehicle | same as pickup |
| Reminders | 2 hours and 30 minutes before | 30 minutes before |
| Description | guest name and phone, reservation link, trip window, mileage | same, plus a note if another trip starts within 24 hours |

A pending change request prefixes the title with `CHANGE REQUESTED ·` and marks the event tentative. A missing location adds a line to the description: confirm the meeting point with the guest.

Guest phone numbers go in every description so either of you can reach the guest straight from the event. Earnings stay out of descriptions; they live in the ledger.

## v1 runtime: Google Apps Script

v1 runs entirely inside Travis's Google account on a 10-minute timer, so there is no server, no hosting bill, and no third party holding Gmail access.

**Adapters for v1**

| Port | Apps Script adapter | Notes |
| --- | --- | --- |
| MailSource | `GmailApp.search('from:mail.turo.com -label:TuroSync/Processed newer_than:30d')` | Plain-text body via `getPlainBody()` |
| CalendarSink | `CalendarApp` on the Family calendar | Event key stored with `setTag()` |
| BookingStore | Google Sheet: Bookings, Unparsed, RunLog tabs | Same columns as the Booking type |
| Notifier | `MailApp.sendEmail` to Travis | Daily digest only when something is unparsed or failed |
| Clock / Config | `Utilities`, Script Properties | Calendar id, time zone |

**Triggers.** One time-driven trigger every 10 minutes calls `runSync()`. A manual `runBackfill()` function handles the first load. Every run takes a script lock so two runs never overlap.

**Build and deploy.** Code is written in TypeScript in a normal repo, bundled with esbuild into one file, and pushed with `clasp`. Apps Script never holds the source of truth; GitHub does.

**Permissions.** The script requests Gmail read and label, Calendar, Sheets and send-mail scopes for Travis's own account only. Nothing is published as an add-on, so Google's app verification does not apply.

## v2 path: HostLedger module

Moving to HostLedger means copying `core/` unchanged and writing new adapters; the parser, reconcile rules and tests come along untouched. What changes is how mail gets in and how events get out, because HostLedger serves many hosts instead of one.

| Port | v1 (Apps Script) | v2 (HostLedger) |
| --- | --- | --- |
| MailSource | GmailApp search | Inbound email webhook: each host forwards Turo mail to a unique address such as `h_8f2k@in.hostledger.app` |
| Runtime | 10-minute Apps Script trigger | Supabase Edge Function per inbound email |
| BookingStore | Google Sheet | Supabase `bookings` table, same columns, row-level security per host |
| CalendarSink | CalendarApp | Option A: Google Calendar API via OAuth. Option B: a private ICS feed URL per host |
| Notifier | MailApp digest | Push notification in the app |

**Why forwarding instead of reading Gmail directly.** For a public app, Gmail read scopes are classed by Google as restricted. As far as I know, that requires app verification plus a paid third-party security assessment, renewed yearly. A forwarding address avoids Gmail OAuth entirely and works for hosts on any email provider. Confirm current Google policy before committing.

**Calendar choice for v2.** The Google Calendar API gives near-instant updates but needs OAuth consent and Google's verification for a sensitive scope. An ICS feed needs no OAuth and works with Apple and Outlook too, but Google Calendar refreshes subscribed feeds slowly, often hours. The core emits CalendarEventSpec either way, so this can be decided later.

**Portability rules for the v1 build**

- `core/` imports nothing platform-specific: no `GmailApp`, no `fetch`, no `Deno`, no Node built-ins.
- Dates handled with a small pure library that runs in Apps Script V8, Deno and React Native.
- Every adapter implements a typed port interface; core receives ports as arguments.
- Fixtures and tests live beside core and run with plain `vitest`.

## Testing and Claude Code build plan

The build runs in four phases, and the parser is fully tested against real emails before anything touches the calendar.

**Repo layout**

```
turo-calendar-sync/
  CLAUDE.md                  # rules: core stays pure, fixtures redacted
  packages/
    core/                    # types, parsers/turo.ts, reconcile.ts, events.ts
      fixtures/turo/         # redacted .txt emails, one per notice type
      test/                  # vitest: parser + reconcile + events
    adapter-apps-script/     # ports for GmailApp, CalendarApp, Sheets
      appsscript.json
      main.ts                # runSync(), runBackfill()
  esbuild.config.mjs         # bundles core + adapter into one Code.js
  .clasp.json
```

**Phases**

1. **Fixtures and parser.** Export 15 to 20 real Turo emails as text, replace phone numbers and last names, and save one per notice type. Build `parseTuroEmail()` until every fixture parses. Done when all fixture tests pass.
2. **Reconcile and events.** Build `reconcile()` and `toCalendarEvents()` with tests for every rule and edge case in Sync logic. Done when replaying all fixtures in order produces the expected ledger.
3. **Apps Script MVP.** Write the adapters, deploy with clasp, run backfill against a test calendar, compare against the Turo app, then switch to the Family calendar and enable the 10-minute trigger. Done after one week with no missed or wrong events.
4. **Hardening and Outdoorsy.** Daily digest for unparsed mail, a `parsers/outdoorsy.ts` built from real Outdoorsy emails, and a README for the HostLedger port.

**Kickoff prompt for Claude Code**

```
Read SPEC.md (this doc, exported). Set up the repo layout it describes.
Start with phase 1 only: create packages/core with types.ts exactly as
specified, then write parseTuroEmail() test-first against the fixtures
in packages/core/fixtures/turo. core must not import any platform API.
Stop when all fixture tests pass and show me the results.
```

Export this doc as Markdown into the repo as `SPEC.md` so Claude Code works from the same spec.

## Open decisions and unknowns

All five design decisions were settled on Oct 8, 2026; the unknowns get answered by collecting more emails in phase 1.

**Decisions**

- [x] Calendar: the shared Family calendar under travis.cella@gmail.com.
- [x] Events: two per trip, pickup and return. No all-day bar.
- [x] Buffers: none. Turo already enforces turnaround time.
- [x] Guest phone numbers: included in every event description.
- [x] No parsed location: flag the event title with `NO LOCATION ·`.

**Unknowns to resolve from more emails**

- [ ] Does Turo send an email when a host accepts a change request? If not, the sync relies on the next upcoming or message email to correct the times.
- [ ] Wording of host-initiated cancellations and declined change requests.
- [ ] Wording of trip extensions requested mid-trip.
- [ ] Whether a delivery address appears anywhere for non-airport deliveries.
- [ ] Whether any Turo email lists times in a zone other than the car's local time.
