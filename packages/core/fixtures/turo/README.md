# Turo fixtures

16 real Turo emails received at the host's Gmail between Dec 2025 and Sep 2026, redacted.

- **Redacted:** guest names (replaced with pseudonyms that keep the original shape: one word, two words, ALL CAPS), phone numbers, driver profile IDs, and every guest-written note (`[guest note redacted]`).
- **Kept as received:** spacing, line breaks, date formats, am/pm casing, vehicle lines, reservation IDs, links.

Each `NN-name.txt` has four header lines (`From`, `Subject`, `Received-At`, `Message-Id`), a blank line, then the plain-text body. Each `NN-name.expected.json` is the `ParsedNotice` that `parseTuroEmail()` must return. Times are ISO 8601 in America/Denver with the correct offset (`-06:00` MDT, `-07:00` MST). Fields that are absent in an email are absent in the JSON.

## Parsing rules the fixtures pin down

| Rule | Fixtures |
| --- | --- |
| Trip times come from the footer `Trip start:` / `Trip end:` lines, never from body sentences | all |
| `am`/`pm` casing varies; parse case-insensitively | 01 vs 04 |
| Daylight saving: January trips are `-07:00` | 03, 10 |
| Location comes only from `with your <Vehicle> at <Location> (is booked\|starting)` in the body; else absent | 01, 02, 11, 12 |
| Changed/message emails show the "Special airport requirements" block but name no location; leave location absent | 04, 13 |
| Guest name comes from the subject prefix, not the footer (cancelled footers can show a full name) | 07, 10 |
| Earnings may contain a thousands separator | 06 |
| Phone may be international (`+39 …`) | 06 |
| Cancelled emails say `requested by` and have no earnings or phone | 09, 10 |
| A change request's footer already shows the requested (unconfirmed) times; `requestedStart`/`End` come from the body's `New trip start/end on …` lines. The calendar shows confirmed times only, so `reconcile()` must never apply times from a `change_requested` notice. `changeResponseBy` comes from "You have until … to respond"; after it passes, the request counts as declined (Turo lapses unanswered requests) unless a footer shows the requested times | 08 |
| A guest message's footer can carry times that changed with no "changed" email | 13 (same reservation as 01, end moved from 9/21 to 9/23) |
| A footer alone does not make a notice actionable; subject decides the kind | 15 (rating request → ignored) |
| A reservation number without a trip footer → ignored | 16 |

## Findings while collecting

- **Extensions can be silent.** Reservation 61467780 was extended by two days with no "has changed their trip" email; only the later guest messages show the new end time. The `message`/`upcoming` self-heal rule is required, not optional.
- **Change requests had no follow-up email.** No accept/decline email exists for reservation 58900705.
- **Not found in the inbox:** host-initiated cancellations, declined change requests, mid-trip extension requests. Add fixtures if any arrive.
