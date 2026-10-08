# turo-calendar-sync

Reads Turo booking emails and keeps pickup/return events on a Google Calendar. `Spec.md` is the source of truth; read it before changing behavior.

## Hard rules

- `packages/core` is pure TypeScript. It must not import or reference `GmailApp`, `CalendarApp`, `SpreadsheetApp`, `fetch`, `Deno`, Node built-ins (`fs`, `path`, …) or any npm package with platform code. It talks to the world only through the interfaces in `packages/core/src/ports.ts`. This is what lets the same core move into HostLedger later.
- Trip times always come from the email footer (`Trip start:` / `Trip end:`), never from body sentences.
- Times are wall-clock America/Denver. Output ISO 8601 with the correct offset for that date (MDT `-06:00`, MST `-07:00`).
- Never guess. An email from Turo with a reservation ID that matches no known pattern goes to the Unparsed log.
- The sync only edits or deletes calendar events it created (identified by its private tag). It is writing to a shared family calendar.

## Fixtures

- `packages/core/fixtures/turo/*.txt` are redacted real emails; `*.expected.json` is the exact expected `ParsedNotice`. Read the fixtures README for the rules each one pins down.
- Never add unredacted guest data (real names, phone numbers, driver IDs, guest-written notes) to the repo.
- When a new email shape shows up, add a fixture first, then change the parser.

## Workflow

- Work one phase at a time (phases are in `Spec.md`). Stop at the end of each phase and show test results.
- Test-first: `npm test` (vitest) must pass before a phase is done.
- `npm run typecheck` must pass.
