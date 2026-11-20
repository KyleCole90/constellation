# The fake Canvas behaves like real Canvas

The demo, verify and the tests run against the fake Canvas in `src/shared/providers/fake-canvas`. It copies real Canvas behaviour, including the odd parts, so code that passes against the fake also works on a real school.

- `seed.ts` holds invented data only, apart from the two named school instances. Never add a real student, submission or school detail.
- `migrations` in `provider.ts` reads the job list, then one progress read for each live job and one `migration_issues` read for each finished job, as the real API does. Request counts and failures then match Canvas.
- `advanceMigration` in `migrations.ts` is pure and works out a job's state from `started_at` and the clock. A reload or a long absence never changes where a fake copy stands.
- `copyBody` in `migrations.ts` points same-host `/courses/<old>/` links at the new course and leaves links to another host alone, as Canvas does after a completed import.
- `docxOf` in `files.ts` builds its heading as Word does, a Heading 1 paragraph style defined in `word/styles.xml`. Text extraction is tested against real Word structure, not inline formatting.
- The server in `server.ts` accepts an unseen well-formed token on its first verify route, because the demo has no token issuer. An unseen token on any other route gets `auth_expired`.
- `#announceable` in `server.ts` lets an unpublished new-term course take announcements, as Canvas does before students arrive.
- `copySources` in `server.ts` works out `meetingDays` from due dates, because Canvas stores no meeting pattern for a course.
- `submissions` in `server.ts` reports work with nothing turned in as missing once its due date passes, as Canvas does.
- A seeded `submittedAt` in `server.ts` is never later than the seed's now. Early work dated after today would read as a resubmission after any grade sent now.
