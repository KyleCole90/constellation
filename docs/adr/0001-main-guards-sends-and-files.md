# Main decides what reaches Canvas and the disk

The renderer runs page script that a tool driving the DOM can control, so main never takes its word for a press, a file path, or a URL. Main reads files itself, checks for a real press before a send, and keeps every write to Canvas on one path.

- `pressedAt` in `src/main/index.ts`, passed to `lmsHandlers` in `src/main/lms.ts`, comes only from Electron's `input-event` mouseUp and `before-input-event` Return or Space. Page script can't produce those events. It is main's only proof that a Canvas send came from the teacher, so never let the renderer report a press over IPC.
- `SEND_PRESS_MS` in `src/main/lms.ts` is how long after the last press main accepts a first send. It must cover the read the renderer does between the press and the send. A shorter window makes real sends fail as "didn't come from your press".
- `applyCanvas` in `src/main/lms.ts` marks appending fields (comment, message, post) as sent before `provider.apply` awaits, and unmarks only failures. A second request that races the first within one press is refused, so nothing posts twice.
- `lms.apply` in `src/main/lms.ts` skips the press check for `fake-canvas`. The demo LMS is a `userData` file the renderer can already rewrite through the failure lab, and it runs only when `FAKE_ONLY` is set in an unpackaged app. The press check protects real Canvas schools.
- `choosePackage` in `src/main/index.ts` opens the dialog and reads the chosen file in main, and `lms.pickPackage` takes only a school. `PickedPackage` in `src/shared/domain/content.ts` carries the file's name, size and term hint to the renderer, never its path or bytes. The renderer never names a path that main will read.
- `MAX_PACKAGE_BYTES` in `src/main/lms.ts` is 500 MB, Canvas's default course-import limit. Main refuses a bigger `.imscc` before any upload starts, instead of letting Canvas fail it later.
- `LmsProvider.linkExport` in `src/shared/providers/provider.ts` reads only the link the LMS holds for the submission, never a URL the caller passes, and only a public Google export. It can't be used to fetch an arbitrary URL.
- `TermSetup` in `src/shared/providers/provider.ts` is read-only. The course copy and every fix go through `observe` and `apply` as changes, so no write path goes around `SendPermit`.
