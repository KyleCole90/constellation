import { Plus } from "lucide-react";

import type { LmsRef } from "~/shared/domain/ids";
import { formatDayTime } from "~/renderer/lib/utils";
import { selectCourseAnnouncements } from "~/renderer/stores/selectors";
import { useWorkspace } from "~/renderer/stores/workspace";

import { EmptyState } from "../EmptyState";
import { StatusPill } from "../StatusPill";
import { Button } from "../ui/button";
import { CoursePage } from "./CourseHeader";
import { useWorkLinks } from "./workLinks";

export function AnnouncementsScreen({ courseId }: { courseId: LmsRef<"course"> }) {
  const { posted, drafts } = useWorkspace((state) => selectCourseAnnouncements(state, courseId));
  const links = useWorkLinks();
  return (
    <CoursePage courseId={courseId}>
      {(course) => (
        <div data-testid="announcements" className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-[768px] flex-col gap-4 px-5 py-4">
            <div className="flex items-center justify-between gap-2">
              <p className="text-body text-secondary-label">
                Drafts go to all {course.studentCount} {course.code} students once you approve and
                post them.
              </p>
              <Button variant="default" size="md" onClick={() => links.announcement(course)}>
                <Plus className="size-3.5" />
                New announcement
              </Button>
            </div>
            {drafts.length > 0 && (
              <section data-testid="announcement-drafts" className="flex flex-col gap-1">
                <h2 className="text-title text-foreground">Drafts</h2>
                <ul className="divide-y divide-border rounded-lg border border-border">
                  {drafts.map(({ change, summary }) => (
                    <li key={change.id}>
                      <button
                        type="button"
                        data-announcement-draft={change.id}
                        onClick={() => links.change(change, course)}
                        className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left hover:bg-accent focus-inset rounded-md"
                      >
                        <span className="min-w-0 flex-1 truncate text-body">
                          {change.content.kind === "announcement"
                            ? change.content.title
                            : change.subject}
                        </span>
                        <StatusPill tone={summary.tone} label={summary.label} />
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            <section data-testid="announcements-posted" className="flex flex-col gap-1">
              <h2 className="text-title text-foreground">Posted</h2>
              {posted.length === 0 ? (
                <EmptyState title="Nothing posted here yet." />
              ) : (
                <ul className="flex flex-col gap-2">
                  {posted.map((announcement) => (
                    <li
                      key={announcement.ref}
                      data-posted={announcement.ref}
                      className="rounded-lg border border-border bg-card px-3 py-2.5"
                    >
                      <div className="flex items-baseline justify-between gap-2">
                        <h3 className="min-w-0 truncate text-body font-medium">
                          {announcement.title}
                        </h3>
                        <span className="flex-none text-meta text-muted-foreground">
                          {formatDayTime(announcement.postedAt)}
                        </span>
                      </div>
                      <p className="mt-1 text-body whitespace-pre-wrap text-secondary-label">
                        {announcement.body}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        </div>
      )}
    </CoursePage>
  );
}
