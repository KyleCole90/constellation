import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import type { LmsRef } from "~/domain/ids";
import type { Course } from "~/domain/lms";
import { cn } from "~/lib/utils";
import { selectCourse } from "~/stores/selectors";
import { useWorkspace, workspaceStore } from "~/stores/workspace";

import { EmptyState } from "../EmptyState";
import { SchoolBadge } from "../SchoolBadge";
import { ScreenHeader } from "../ScreenHeader";
import { SCREEN_ICON } from "../screenIcons";
import { Button } from "../ui/button";
import { TAB, toggleState } from "../ui/toggle";
import { ageWords, isStale, syncFailureWords } from "./course.logic";

const TABS = [
  { to: "/courses/$courseId", label: "Overview" },
  { to: "/courses/$courseId/gradebook", label: "Gradebook" },
  { to: "/courses/$courseId/announcements", label: "Announcements" },
] as const;

function SyncLine({ course }: { course: Course }) {
  const connection = useWorkspace((state) => state.connections[course.school]);
  const syncing = useWorkspace((state) => state.syncing[course.school] ?? false);
  const now = workspaceStore().getState().now();
  const at = connection?.lastSyncedAt ?? null;
  const error = connection?.syncError ?? null;
  const stale = isStale(at, now);
  return (
    <span data-testid="sync-line" className="flex min-w-0 items-center gap-1.5 text-meta">
      {error ? (
        <span
          data-testid="sync-failed"
          role="alert"
          className="min-w-0 truncate text-error-foreground"
        >
          {syncFailureWords(error, at, now)}
        </span>
      ) : (
        <span
          data-testid="sync-age"
          data-stale={stale}
          className={cn(
            "whitespace-nowrap",
            stale ? "text-warning-foreground" : "text-muted-foreground",
          )}
        >
          Synced {ageWords(at, now)}
        </span>
      )}
      <Button
        size="sm"
        disabled={syncing}
        onClick={() => void workspaceStore().getState().syncSchool(course.school)}
      >
        {syncing ? "Syncing" : "Sync now"}
      </Button>
    </span>
  );
}

export function CoursePage({
  courseId,
  actions,
  children,
}: {
  courseId: LmsRef<"course">;
  actions?: ReactNode;
  children: (course: Course) => ReactNode;
}) {
  const course = useWorkspace((state) => selectCourse(state, courseId));
  const school = useWorkspace((state) =>
    state.schools.find((candidate) => candidate.id === course?.school),
  );
  if (!course) return <EmptyState title="This course isn't here any more." />;
  const details = [course.section, course.modality, school?.host].filter(Boolean).join(" · ");
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <ScreenHeader
        icon={SCREEN_ICON.course}
        trail={course.code}
        title={course.title}
        chip={
          <>
            <SchoolBadge school={course.school} />
            <span
              data-testid="course-details"
              className="min-w-0 truncate text-meta text-muted-foreground"
            >
              {details}
            </span>
          </>
        }
        actions={actions}
      />
      <div className="flex min-w-0 flex-none items-center justify-between gap-4 border-b border-border px-4 py-2">
        <nav data-testid="course-tabs" className="flex flex-none gap-0.5">
          {TABS.map((tab) => (
            <Link
              key={tab.to}
              to={tab.to}
              params={{ courseId }}
              activeOptions={{ exact: true, includeSearch: false }}
              activeProps={{ className: toggleState(true), "aria-current": "page" }}
              inactiveProps={{ className: toggleState(false) }}
              className={TAB}
            >
              {tab.label}
            </Link>
          ))}
        </nav>
        <SyncLine course={course} />
      </div>
      {children(course)}
    </div>
  );
}
