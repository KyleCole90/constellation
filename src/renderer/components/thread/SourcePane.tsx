import { useEffect, useMemo, useRef } from "react";

import { OVERALL_RATIONALE, type ChangeRecord } from "~/shared/domain/change";
import type { LmsRef } from "~/shared/domain/ids";
import { excerptNote, type Conversation, type Submission } from "~/shared/domain/lms";
import { cn, formatDayTime } from "~/renderer/lib/utils";
import {
  selectAssignment,
  selectConversation,
  selectCourseOverview,
  selectSubmission,
} from "~/renderer/stores/selectors";
import { useWorkspace } from "~/renderer/stores/workspace";

import { SubmissionBadge } from "../ui/badge";
import {
  criterionHue,
  criterionNumbers,
  marksByParagraph,
  nextCriterion,
  segmentParagraph,
  type Segment,
} from "./anchors.logic";
import { useRationale } from "./context";

const markOrder = (record: ChangeRecord | null): readonly string[] =>
  record?.content.kind === "grade"
    ? (record.content.rubric?.map((score) => score.criterion) ?? [OVERALL_RATIONALE])
    : [];

const hueOf = (numbers: ReadonlyMap<string, number>, key: string): string | undefined => {
  const number = numbers.get(key);
  return number === undefined ? undefined : criterionHue(number);
};

function Passage({ segment, numbers }: { segment: Segment; numbers: ReadonlyMap<string, number> }) {
  const link = useRationale();
  const first =
    link.selected && segment.keys.includes(link.selected)
      ? link.selected
      : (segment.keys[0] as string);
  return (
    <mark
      className="passage"
      data-criterion={segment.keys.join(" ")}
      data-number={segment.opens.map((key) => numbers.get(key)).join(" ") || undefined}
      data-overlap={segment.keys.length > 1}
      data-hovered={link.hover !== null && segment.keys.includes(link.hover)}
      data-emphasized={link.selected !== null && segment.keys.includes(link.selected)}
      style={{
        "--crit": hueOf(numbers, first),
        "--number": hueOf(numbers, segment.opens[0] ?? first),
      }}
      onMouseEnter={() => link.setHover(first)}
      onMouseLeave={() => link.setHover(null)}
      onClick={() => {
        const key = nextCriterion(segment.keys, link.selected);
        if (key) link.selectFromPassage(key);
      }}
    >
      {segment.text}
    </mark>
  );
}

function Paragraphs({
  paragraphs,
  record,
  transcript,
}: {
  paragraphs: readonly string[];
  record: ChangeRecord | null;
  transcript: boolean;
}) {
  const link = useRationale();
  const { claimScroll } = link;
  const root = useRef<HTMLDivElement>(null);
  const marks = useMemo(() => marksByParagraph(record?.rationale ?? []), [record?.rationale]);
  const order = useMemo(() => markOrder(record), [record]);
  const numbers = useMemo(
    () => criterionNumbers(order, record?.rationale ?? []),
    [order, record?.rationale],
  );
  useEffect(() => {
    if (link.from !== "row" || !link.selected || !claimScroll(link.tick)) return;
    root.current?.querySelector('[data-emphasized="true"]')?.scrollIntoView({
      block: "center",
      behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    });
  }, [link.selected, link.tick, link.from, claimScroll]);
  return (
    <div ref={root} data-testid="paper" className={transcript ? "paper transcript" : "paper"}>
      {paragraphs.map((text, index) => (
        // oxlint-disable-next-line react/no-array-index-key -- pieces split from one string have no id and can repeat
        <p key={index}>
          {segmentParagraph(text, marks.get(index) ?? []).map((segment) =>
            segment.keys.length > 0 ? (
              <Passage key={segment.start} segment={segment} numbers={numbers} />
            ) : (
              <span key={segment.start}>{segment.text}</span>
            ),
          )}
        </p>
      ))}
    </div>
  );
}

function ReasonKey({ record }: { record: ChangeRecord }) {
  const link = useRationale();
  if (record.content.kind !== "grade" || !record.content.rubric) return null;
  const order = markOrder(record);
  const numbers = criterionNumbers(order, record.rationale);
  return (
    <div data-reason-key className="mt-3 flex-col gap-1 rounded-lg border border-border px-3 py-2">
      <h3 className="text-title text-foreground">Why these are marked</h3>
      {record.content.rubric.map((score) => {
        const why = record.rationale.find((entry) => entry.field === score.criterion)?.why;
        const number = numbers.get(score.criterion);
        if (!why) return null;
        return (
          <button
            key={score.criterion}
            type="button"
            data-text-link
            data-selected={link.selected === score.criterion}
            onClick={() => link.selectFromRow(score.criterion)}
            onMouseEnter={() => link.setHover(score.criterion)}
            onMouseLeave={() => link.setHover(null)}
            className={cn(
              "-mx-1 cursor-pointer rounded px-1 text-left text-body hover:bg-accent",
              link.selected === score.criterion && "bg-accent",
            )}
          >
            {number !== undefined && (
              <span className="crit-number" style={{ "--crit": criterionHue(number) }}>
                {number}
              </span>
            )}
            {score.name}. <span className="text-muted-foreground">{why}</span>
          </button>
        );
      })}
    </div>
  );
}

function SubmissionDoc({
  submission,
  record,
}: {
  submission: Submission;
  record: ChangeRecord | null;
}) {
  const assignment = useWorkspace((state) => selectAssignment(state, submission.assignment));
  const { body } = submission;
  const title = body.kind === "none" ? (assignment?.title ?? submission.studentName) : body.title;
  const priorComment = submission.comments.filter((comment) => comment.mine).at(-1);
  const note = excerptNote(body);
  const marked = criterionNumbers(markOrder(record), record?.rationale ?? []).size > 0;
  return (
    <div className="px-5 pt-4 pb-7">
      <h2 title={title} className="truncate text-page">
        {title}
      </h2>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-meta text-muted-foreground">
        {submission.submittedAt && <span>Submitted {formatDayTime(submission.submittedAt)}</span>}
        <span className="flex flex-none items-center gap-x-3">
          <span>
            Attempt {submission.attempt}
            {body.kind === "text" && ` · ${body.wordCount.toLocaleString("en-US")} words`}
            {body.kind === "media" && body.durationLabel && ` · ${body.durationLabel} recording`}
          </span>
          {submission.lateDays > 0 && (
            <SubmissionBadge status="late">{submission.lateDays}d late</SubmissionBadge>
          )}
        </span>
      </div>
      {submission.attempt > 1 && submission.grade !== null && (
        <div
          data-testid="prior-attempt"
          className="mt-3 rounded-lg border border-border px-3 py-2 text-body"
        >
          <div className="font-medium">
            Previous attempt: {submission.grade} / {assignment?.pointsPossible}
          </div>
          {priorComment && <p className="mt-0.5 text-secondary-label">{priorComment.text}</p>}
        </div>
      )}
      {record && <ReasonKey record={record} />}
      {(note || marked) && (
        <div className="mt-3 mb-1.5 flex flex-wrap justify-between gap-x-3 text-meta text-muted-foreground">
          {note && (
            <h3 data-excerpt-note className="section-title">
              {note}
            </h3>
          )}
          {marked && <span data-numbers-label>Numbers match the scores in the draft.</span>}
        </div>
      )}
      <div className={note || marked ? "" : "mt-3"}>
        {body.kind === "text" && (
          <Paragraphs paragraphs={body.paragraphs} record={record} transcript={false} />
        )}
        {body.kind === "media" && (
          <Paragraphs paragraphs={body.transcript} record={record} transcript />
        )}
        {body.kind === "none" && (
          <p className="text-body text-muted-foreground">Nothing was submitted.</p>
        )}
      </div>
    </div>
  );
}

function ConversationDoc({ conversation }: { conversation: Conversation }) {
  return (
    <div className="px-5 pt-4 pb-7">
      <h2 className="text-page">{conversation.subject}</h2>
      <div className="mt-1 mb-3 text-meta text-muted-foreground">From {conversation.from}</div>
      <div className="flex flex-col gap-2.5">
        {conversation.messages.map((message) => (
          <div key={message.id} className="rounded-lg border border-border px-3 py-2">
            <div className="mb-0.5 flex justify-between gap-2 text-meta text-muted-foreground">
              <span>{message.mine ? "You" : message.author}</span>
              <span>{formatDayTime(message.at)}</span>
            </div>
            <p className="text-body whitespace-pre-wrap">{message.text}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function CourseContextDoc({ course }: { course: LmsRef<"course"> }) {
  const overview = useWorkspace((state) => selectCourseOverview(state, course, state.now()));
  if (!overview) return null;
  return (
    <div className="flex flex-col gap-4 px-5 pt-4 pb-7">
      <div>
        <h2 className="text-page">
          {overview.course.code} {overview.course.title}
        </h2>
        <div className="mt-0.5 text-meta text-muted-foreground">
          {overview.course.studentCount} students
        </div>
      </div>
      <section>
        <h3 className="mb-1 text-title text-foreground">Coming up</h3>
        {overview.upcoming.length === 0 && (
          <p className="text-body text-muted-foreground">Nothing scheduled.</p>
        )}
        <ul className="flex flex-col gap-1 text-body">
          {overview.upcoming.map((assignment) => (
            <li key={assignment.ref} className="flex justify-between gap-3">
              <span className="truncate">{assignment.title}</span>
              <span className="flex-none text-meta text-muted-foreground">
                {assignment.dueAt && formatDayTime(assignment.dueAt)}
              </span>
            </li>
          ))}
        </ul>
      </section>
      {overview.lastAnnouncement && (
        <section>
          <h3 className="mb-1 text-title text-foreground">Already posted</h3>
          <div className="rounded-lg border border-border px-3 py-2 text-body">
            <div className="font-medium">{overview.lastAnnouncement.title}</div>
            <p className="mt-0.5 text-secondary-label">{overview.lastAnnouncement.body}</p>
          </div>
        </section>
      )}
    </div>
  );
}

export function SourcePane({
  record,
  current,
}: {
  record: ChangeRecord | null;
  current: string | null;
}) {
  const target = record?.content.target ?? current;
  const submission = useWorkspace((state) =>
    selectSubmission(state, target as LmsRef<"submission"> | null),
  );
  const conversation = useWorkspace((state) =>
    target ? selectConversation(state, target as LmsRef<"conversation">) : null,
  );
  if (submission) return <SubmissionDoc submission={submission} record={record} />;
  if (conversation) return <ConversationDoc conversation={conversation} />;
  if (record?.content.kind === "announcement") return <CourseContextDoc course={record.course} />;
  return <p className="p-5 text-body text-muted-foreground">Nothing to show yet.</p>;
}

/** A setup change has no source document beside it: its review row already shows the finding, and the preview shows the passage. */
const SOURCE_TAB: Readonly<Record<ChangeRecord["content"]["kind"], string | null>> = {
  grade: "Submission",
  reply: "Student message",
  message: null,
  announcement: "Course context",
  "course-copy": null,
  "text-fix": null,
  "item-set": null,
};

export const useSourceTabName = (
  record: ChangeRecord | null,
  current: string | null,
): string | null => {
  const conversation = useWorkspace((state) =>
    current && !record ? selectConversation(state, current as LmsRef<"conversation">) : null,
  );
  return record
    ? SOURCE_TAB[record.content.kind]
    : conversation
      ? SOURCE_TAB.reply
      : SOURCE_TAB.grade;
};
