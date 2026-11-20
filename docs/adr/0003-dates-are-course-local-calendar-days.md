# Dates are calendar days in the course's own time zone

Canvas writes a course's dates in the course's time zone with no UTC offset, and the app treats a date as a plain calendar day. Code that sends a date through UTC or the machine's zone moves it by a day, so the app reads, formats and compares dates as text.

- `dayIn` in `src/main/cartridge.ts` takes the day straight from the text of a Canvas export's `<due_at>` and `<start_at>` tags and never parses it as a `Date`.
- `courseSettings` in `scripts/make-imscc.mjs` writes `start_at` and `conclude_at` as local times with no offset, as Canvas's own `course_settings.xml` does.
- `PackageTerm` in `src/shared/domain/content.ts` holds dates as written in the course's time zone. Its dates are `DraftDate` because a real export may leave out the end date or hold no due dates.
- `longDate` and `weekdayDate` in `src/shared/domain/preview.ts` format an `IsoDate` at UTC midnight with `timeZone: "UTC"`. The local zone would show the day before for anyone west of UTC.
- `IsoTimeSchema` in `src/shared/providers/schemas.ts` accepts only the exact format `isoTime` writes, so two `IsoTime` values compare correctly as text and slice to their day.
- `tests/fixtures/canvas-term-http.ts` stores a due time of exactly 00:00 as 23:59:59 the night before. That is Canvas's "fancy midnight", and term date shifting is tested against it.
- The `shiftDate` expectations in `tests/term.test.ts` come from an independent port of Canvas's Ruby date-shift method, run outside this codebase. Never regenerate them from the output of `shiftDate`.
- `mentionIsStale` in `src/shared/domain/term.ts` counts a bare date like "8/10" as stale only inside the old term, because it is as likely a score as a date.
