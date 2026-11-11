# Constellation

Each school is a star in your academic journey.

Licensed under AGPL-3.0. See [LICENSE](LICENSE).

Constellation is a prototype. An adjunct who teaches at two schools runs their week from one workspace. A course is a project, a task is a thread, and a proposed Canvas change is a plain preview that a person reads and approves. North Star is home, above every course. Each ask starts a chat that stays in the sidebar, and every return home is clean. A chat answers questions, finds things, and hands work to the right course thread or threads. The grading list opens from What's due. The data is invented and the only LMS is a fake one in the browser. The app makes no real LMS calls.

**Calendar** shows every assignment at every school by the day it is due, with one row per course. Select a day to list what is due that day beside the grid.

## Run it

From this folder, run:

```sh
npm install && npm run dev
```

Open http://localhost:4320/. The first visit shows a welcome screen and then one setup page. On the setup page, type the address of each school you teach at and paste a token of at least 20 characters into its row, then click **Connect**. The fake LMS knows two schools, `lakeshore.instructure.com` and `riverbend.instructure.com`, and refuses any other address. To fill in both addresses and their tokens, click **Use demo institutions and tokens**. You still click **Connect** on each row. Then choose where AI drafts come from: an Anthropic API key (any text works), the on-device model (offered only on a Mac), or no AI. Click **Finish setup**. To add another school later, use **Add institution** in **Settings**, under **Connections**. The app checks tokens only against the fake LMS.

AI is optional. With no AI, the app runs no agent. Opening a submission, conversation, or announcement shows a blank form to fill in by hand, and nothing is saved until the first edit. A grade with an unset score can't be approved or sent. Choosing a key or the on-device model in **Settings**, under **AI**, turns on AI drafts and chat right away, and **Turn off AI** or **Remove key** turns them off after a confirm. Drafts already written stay, and North Star chats come back when AI is on again. No model is wired up, so AI drafts come from built-in rules.

Other commands:

| Command             | What it does                                                                                                                                                                                                 |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `npm run typecheck` | Runs `tsgo -b` over the renderer, Node and test projects.                                                                                                                                                    |
| `npm run check`     | Checks formatting and lint with `vp check`.                                                                                                                                                                  |
| `npm run knip`      | Reports unused files, exports and dependencies.                                                                                                                                                              |
| `npm test`          | Runs the Vitest suite through Vite+.                                                                                                                                                                         |
| `npm run verify`    | Starts the app, drives every screen in Chrome, and saves screenshots to `out/screenshots/`. Use `--only=settings`, `--only=grading`, `--only=courses`, `--only=term`, or `--only=followups` to run one part. |
| `npm run build`     | Builds to `out/dist/`.                                                                                                                                                                                       |

`npm run verify` needs Google Chrome. It looks in `/Applications`. To use a different binary, set `CHROME_BIN`.

To restore the starting data, open **Settings**, go to the **Demo** section, and click **Reset demo data**. To make the fake LMS misbehave, use the failure lab in the same section. It can expire a token, change a grade behind your back, fail a write partway, lose a response, and throttle the next write.

## Keyboard

| Keys            | Action                                                                                                                                                                                                                             |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `⌘K`            | Opens the command palette.                                                                                                                                                                                                         |
| `⌘B`            | Toggles the sidebar.                                                                                                                                                                                                               |
| `⌘1` to `⌘9`    | Opens that thread.                                                                                                                                                                                                                 |
| `⌘⇧[` and `⌘⇧]` | Moves to the previous or next thread.                                                                                                                                                                                              |
| `⌘N`            | Goes to North Star for a new chat. Needs an AI key.                                                                                                                                                                                |
| `⌘⇧O`           | Starts a thread in the current course. Needs an AI key.                                                                                                                                                                            |
| `⌘D`            | Opens or closes the preview panel.                                                                                                                                                                                                 |
| `J` and `K`     | Moves through the grading list.                                                                                                                                                                                                    |
| `/`             | Focuses the composer. Needs an AI key.                                                                                                                                                                                             |
| `⌘↵`            | Walks to the next step. It never approves. On a draft, it moves focus to **Approve**. On a form with blanks, it stops at the preview. With a correction half typed in the composer, it opens the review and leaves the text there. |

Enter or Space on the focused **Approve** button does approve. That press is still a person pressing that button, and keyboard users need it.

## Why it is built this way

The hard part of this app is the path from a draft to a grade in Canvas. The screens are comparatively simple, so most of the design effort went into that path.

Before anything goes out, the preview panel shows what will be sent in plain text: the grade, the rubric scores, the feedback, and the announcement or reply text. `previewOf` in `src/domain/preview.ts` builds it from the same content the approval fingerprint covers, so the text you read is the text the send writes. **Approve** and **Send** sit below it. **Send** stays disabled until you press **Approve**.

Approval is a chain, and the agent has no way onto it. `AgentEffect` in `src/agent/agent.ts` has no approve or send member, and agent output passes through a parser before it does anything. A trusted click on `src/components/ApproveButton.tsx` creates an `ApprovalWitness`. `transition` in `src/domain/approval.ts` accepts that witness only if its fingerprint matches the current content. `src/writeback` mints a `SendPermit` only from the `sending` state, and `provider.apply` refuses anything else. `tests/structure.test.ts` fails if another file creates a witness. Editing moves the change back to `draft`, and the `draft` type has no approval field, so an edited change cannot read as approved.

There is one write path. It reads the LMS first, then `classify` decides each field. A conflict writes nothing. A value that is already there counts as landed. Everything else is written, and the provider reports an outcome per field, so a partial write retries only the part that failed.

The worst failure here is a double post, because a duplicate comment on a student's work cannot be taken back. So the app records which comments existed at the first send (`ChangeRecord.seen`) and keeps that record through edits, conflicts, and discards. A retry compares against that record to recognize its own earlier write. If a response is lost, the runner waits, then only reads. If it still cannot tell, the change is held as `in-doubt` until a person clicks **Resume**. After a reload the app only reads. A 429 pauses that school's lane and spends no retry. An expired token holds the change and closes that school's lane until you reconnect.

Three designs competed. I took the one whose providers report facts per field, and I took neutral `RemoteState`, the witness, and the first-send record from the others. I rejected a step-plan design because it doubled the Canvas requests and wrote the grade before the comment. I rejected event sourcing because it needed 18 event types for what `transition` does in one function. I rejected a fake REST server behind a transport layer because it tests the fake more than the app.

Tokens stay out of the UI, logs, and localStorage. A `Secret` prints as `[secret]`. The vault keeps AES-GCM ciphertext and a non-extractable key in IndexedDB. `tests/structure.test.ts` limits `revealSecret` to `src/providers/` and `src/stores/workspace.ts`.

## The provider interface in plain words

`LmsProvider` in `src/providers/provider.ts` is everything the app knows about an LMS. Each school gets one instance. It does four things:

- It reads: `verify`, `courses`, `assignments`, `students`, `submissions`, `conversations`, and `announcements`. Each read returns a whole list, so paging stays inside the provider.
- It reports what is on the LMS now for one change, through `observe`. It only reads, and it shows every write that landed, including one whose response was lost.
- It writes, through `apply`. It accepts only a real `SendPermit`, writes the fields the permit names, and reports per field. A field it cannot vouch for comes back `unknown`. It never sleeps on a 429 and never throws.
- It describes itself, through `describeScope` and `capabilities`. The UI turns off what `capabilities` says is missing. `capabilities.commentEffect` says whether a new comment adds to earlier feedback or replaces it, and the preview says so in a sentence.

A provider holds no retry, backoff, conflict, or duplicate logic. The runner in `src/writeback/writeback.ts` and `classify` own those once, so every vendor gets the same rules.

Constellation is Canvas-only for now. The interface stays so another LMS can be added later. To add one, write a `ProviderDescriptor`. It names the LMS, its enrollment (`paste-token` or `redirect`), and a `create` function. Onboarding renders from the descriptor and has no vendor branch. Canvas sends a grade and a comment in one `PUT`. An LMS that needs separate requests keeps that difference inside `apply`.

`tests/fixtures/provider-contract.ts` holds `runProviderContract`. The suite runs it against the fake Canvas provider and against a made-up second LMS in `tests/fixtures/second-lms-stub.ts`. The stub replaces feedback rather than adding to it, and it has no messaging. It is a test fixture that proves the interface fits something other than Canvas.

The agent has the same kind of boundary. `Agent` in `src/agent/agent.ts` yields `unknown`, and `parseAgentEffect` checks every effect against what the thread opened. The rule agent goes through that parser too, so a real model can replace it. North Star chats use the same seam. Its `handoff` effect names a course and the work, and the parser refuses a handoff from any other thread.

## Start of term

An adjunct who just got a new course sets it up from one thread. Constellation folds each school's unpublished Spring 2027 courses into one sidebar row, such as "2 Spring 2027 courses to set up", that opens to list them, and lists them on **What's due** with a **Set up this course** button. A setup under way keeps its own row. The thread then shows seven steps along the top. Every write in these steps is a change that waits for the Approve button, and editing an approved fix resets its approval.

The fake provider models the Canvas content migration API and makes no network call. This table lists the real calls a Canvas provider would make at each step.

| Step             | What the instructor does                                   | Canvas API                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1. Detect        | Sees the new course and clicks **Set up this course**.     | `GET /api/v1/courses` with `enrollment_type=teacher` and `state[]=unpublished`. `include[]=total_students` gives the student count. Canvas has no content count on this endpoint, so a provider would list modules, pages, and assignments.                                                                                                                                                            |
| 2. Source        | Picks a previous course or uploads an `.imscc` export.     | `POST /api/v1/courses/:course_id/content_migrations`. A previous course uses `migration_type=course_copy_importer` and `settings[source_course_id]`. A package uses `migration_type=common_cartridge_importer` and `pre_attachment[name]`, then uploads the file. `POST /api/v1/courses/:course_id/content_exports` with `export_type=common_cartridge` makes the `.imscc`.                            |
| 3. Dates         | Confirms old and new term dates, meeting days, and breaks. | `date_shift_options` on the same POST: `shift_dates`, `old_start_date`, `old_end_date`, `new_start_date`, `new_end_date`, and `day_substitutions[X]`. Canvas has no break option, so Constellation drafts a due-date fix for anything that lands in a break.                                                                                                                                           |
| 4. Scan          | Watches copy and scan progress in the thread.              | `GET /api/v1/progress/:id` from the migration's `progress_url`, and `GET /api/v1/courses/:course_id/content_migrations/:id/migration_issues`. The scan reads `GET /api/v1/courses/:id` with `include[]=syllabus_body`, then `pages`, `assignments`, `discussion_topics` with `only_announcements=true`, `modules`, `files`, and `external_tools` under the course.                                     |
| 5. Review        | Approves, edits, or dismisses each finding.                | `PUT /api/v1/courses/:id` with `course[syllabus_body]`. `PUT /api/v1/courses/:course_id/pages/:url_or_id` with `wiki_page[body]` or `wiki_page[published]`. `PUT /api/v1/courses/:course_id/assignments/:id` with `assignment[description]`, `assignment[due_at]`, or `assignment[published]`. `PUT` and `DELETE /api/v1/courses/:course_id/discussion_topics/:topic_id`, with `message` on the `PUT`. |
| 6. Publish check | Runs the check, then approves **Publish course**.          | The same reads as step 4, then `PUT /api/v1/courses/:id` with `offer=true`.                                                                                                                                                                                                                                                                                                                            |
| 7. End of term   | Approves **Save as template for next term**.               | `PUT /api/v1/courses/:id` with `course[template]`, which needs the Course Templates feature. A school without that feature could keep a `common_cartridge` export instead.                                                                                                                                                                                                                             |

The date shift follows the `shift_date` method in the public canvas-lms source. The date moves in proportion across the term, then to the substituted weekday. A Tuesday, October 13 2026 with Tue/Thu becoming Mon/Wed lands on Monday, March 8 2027. With a March 8 to 12 break, it moves to March 15 and carries a flag.

If a course already has students or content, Approve asks the instructor to type the course code. That check lives in `ApproveButton`, so a batch can't skip it. A batch that holds such a copy refuses to approve.

The sample packages are in `fixtures/imscc/`. `node scripts/make-imscc.mjs` rebuilds them. One comes from Northgate College, a school that isn't connected, and one fails partway through.

## What's next

Things that are wrong or thin today:

- A write that lands after the settle window can double post once a person clicks **Resume**. Canvas has no idempotency key or ETag, so no client can fully close this. A test named `KNOWN LIMIT` records it.
- The agent's refusal after a failed draft has no change tag, so it shows in every inbox conversation.
- Below 1108px wide, the inbox preview floats over the conversation. It still works.
- What's due counts each announcement thread with nothing posted as a draft.
- The sync age updates only when the screen renders.
- A real resubmission or new message during a batch outcome drops that row from the outcome list.
- The fake data reuses submission texts across students.
- The preview says in one sentence which grade it replaces, but it does not show a replaced comment's text. When the LMS replaces feedback rather than adding to it, the instructor reads the earlier feedback in the **Submission** tab.
- Only the `changes` part of saved state is protected from a stale tab. Threads and preferences from an old tab can still overwrite newer ones.
- A change to the saved format resets the demo data. The old data stays in `lms-app.v1.unreadable`.
- Saved data still uses the old `lms-app` prefix in its localStorage keys and vault name. Renaming them needs a migration, and without one every saved token and change would be lost.
- The fake LMS keeps a non-cryptographic hash of pasted tokens in localStorage. A real provider would have no fake server.

Things that are thin in the start-of-term flow:

- A course edit made outside the app after **Publish course** is approved does not raise a conflict at send.
- With as many new meeting days as old ones, a click moves a day. A course can't gain a meeting day unless the instructor also adds an old one.
- **Edit** covers text fixes only. A due-date fix can be approved or dismissed, but not reworded.
- Breaks start empty, and new-term days start as the old days, because the provider has no academic calendar.
- Fixing one of two identical passages in a page redrafts the other, and any edit or approval on it is lost. The instructor approves the new draft.
- A second tab shows no copy progress while the first tab runs the watcher. It takes over if the first tab closes.
- The app reads only a package's name and size. A file the LMS lists as a sample package takes that package's old term, and the Dates step warns when the typed old term differs. Any other file needs its old term typed in, and the fake fails any package it doesn't recognize.
- The Northgate package carries no broken link, missing file, or external tool link, because every link in it points at the old school.
- Due dates shift in UTC, so a date can show a different time of day in the instructor's time zone. A real provider needs the school's time zone.
- Office hours from another school stay a by-hand finding. The agent has nothing true to suggest for a new day and room.

Tests prove these paths, but the browser script does not click them: the messaging-off note, reconnecting from every held state, the batch retry exclusions, possible-own-write, and overlapping passage anchors.

Code to clean up:

- `faultLab` uses casts, and the **Demo** section assumes the fake provider.
- The store is one closure of about 450 lines, and the store builds the fake backend itself.
- `connect` keeps the previous credential in memory so it can restore it.
- `src/stores/selectors.ts` has two copies of the check for a submission newer than the sent grade.
- The **Edit** banner uses `document.querySelector` and does nothing if the card has unmounted.

Things to find out before real providers:

- Browser calls to real Canvas may be blocked by CORS or OAuth rules. I have not checked. The app may need a small relay.
- The API facts behind the interface come from the vendor docs, and nothing has run against a real LMS.

Vendor docs used:

- [Canvas submissions](https://canvas.instructure.com/doc/api/submissions)
- [Canvas throttling](https://canvas.instructure.com/doc/api/file.throttling.html)
- [Canvas pagination](https://canvas.instructure.com/doc/api/file.pagination.html)
- [Canvas content migrations](https://canvas.instructure.com/doc/api/content_migrations.html)
- [Canvas progress](https://canvas.instructure.com/doc/api/progress.html)
- [Canvas courses](https://canvas.instructure.com/doc/api/courses.html)
- [Canvas content exports](https://canvas.instructure.com/doc/api/content_exports.html)
- [Canvas pages](https://canvas.instructure.com/doc/api/pages.html)
- [Canvas assignments](https://canvas.instructure.com/doc/api/assignments.html)
- [Canvas discussion topics](https://canvas.instructure.com/doc/api/discussion_topics.html)
- [Canvas modules](https://canvas.instructure.com/doc/api/modules.html)
- [Canvas files](https://canvas.instructure.com/doc/api/files.html)
- [Canvas external tools](https://canvas.instructure.com/doc/api/external_tools.html)
