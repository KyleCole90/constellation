import { useRouterState } from "@tanstack/react-router";
import { ArrowDown, ArrowUp } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ComponentProps } from "react";

import type { LmsRef } from "~/domain/ids";
import type { Assignment } from "~/domain/lms";
import { cn } from "~/lib/utils";
import { selectGradebook, type GradebookCell, type GradebookRow } from "~/stores/selectors";
import { useWorkspace } from "~/stores/workspace";

import { EmptyState } from "../EmptyState";
import { STATUS_TONE } from "../StatusPill";
import { Badge, SUBMISSION_STATUS, SubmissionBadge } from "../ui/badge";
import { TAB, toggleState } from "../ui/toggle";
import { CoursePage } from "./CourseHeader";
import {
  cellMarks,
  cellTarget,
  filterRows,
  nextSort,
  orderColumns,
  pendingWords,
  sortRows,
  type ColumnOrder,
  type RowFilter,
  type RowSort,
} from "./gradebook.logic";
import { useWorkLinks } from "./workLinks";

const STICKY_TOP = "sticky top-0 z-10 bg-card";
// The pinned columns cast a shadow only while there is table hidden under them.
const EDGE_LEFT = "group-data-[hidden-left]/book:shadow-pinned-column-left";
const EDGE_RIGHT = "group-data-[hidden-right]/book:shadow-pinned-column-right";

/** Marks which sides of a sideways scroller have content hidden past them. */
const markHiddenEdges = (el: HTMLDivElement | null) => {
  if (!el) return;
  const mark = () => {
    el.toggleAttribute("data-hidden-left", el.scrollLeft > 0);
    el.toggleAttribute("data-hidden-right", el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
  };
  mark();
  el.addEventListener("scroll", mark, { passive: true });
  const observer = new ResizeObserver(mark);
  observer.observe(el);
  if (el.firstElementChild) observer.observe(el.firstElementChild);
  return () => {
    el.removeEventListener("scroll", mark);
    observer.disconnect();
  };
};
const STICKY_LEFT = `sticky left-0 z-[5] bg-background ${EDGE_LEFT}`;
const STICKY_RIGHT = `sticky right-0 z-[5] bg-background ${EDGE_RIGHT}`;
const LINE = "border-b border-border";
const DASH = <span className="text-muted-foreground">–</span>;

function SortHeader({
  sort,
  by,
  onSort,
  children,
  className,
}: {
  sort: RowSort;
  by: RowSort["by"];
  onSort: (by: RowSort["by"]) => void;
  children: React.ReactNode;
  className?: string;
}) {
  const active = sort.by === by;
  const Arrow = sort.descending ? ArrowDown : ArrowUp;
  return (
    <button
      type="button"
      data-text-link
      onClick={() => onSort(by)}
      aria-pressed={active}
      className={cn(
        "flex w-full cursor-pointer items-center gap-1 text-left text-meta font-medium text-foreground",
        className,
      )}
    >
      <span className="min-w-0 truncate">{children}</span>
      {active && <Arrow className="size-3 flex-none" />}
    </button>
  );
}

/** A status beside a score shrinks to its icon, and its words go to the tooltip and to screen readers. Without a score, the words are the cell. */
function Marker({
  words,
  short,
  compact,
  ...badge
}: ComponentProps<typeof Badge> & { words: string; short?: string | undefined; compact: boolean }) {
  if (!compact) return <Badge {...badge}>{words}</Badge>;
  return (
    <Badge title={words} {...badge}>
      {short && <span aria-hidden>{short}</span>}
      <span className="sr-only">{words}</span>
    </Badge>
  );
}

function Cell({ cell, assignment }: { cell: GradebookCell; assignment: Assignment }) {
  const links = useWorkLinks();
  const target = cellTarget(cell);
  const marks = cellMarks(cell);
  const pending = pendingWords(cell);
  const lateDays = cell.submission?.lateDays ?? 0;
  const compact = cell.grade !== null || pending !== null;
  const body = (
    <span className="relative flex h-5 items-center justify-end gap-1.5 whitespace-nowrap">
      {marks.map((mark) => (
        <Marker
          key={mark}
          data-mark={mark}
          tone={SUBMISSION_STATUS[mark].tone}
          icon={SUBMISSION_STATUS[mark].icon}
          words={mark === "late" ? `${lateDays}d late` : SUBMISSION_STATUS[mark].word}
          short={mark === "late" ? `${lateDays}d` : undefined}
          compact={compact}
        />
      ))}
      {pending && cell.pending && (
        <Marker
          data-pending
          tone={STATUS_TONE[cell.pending.tone]}
          icon="draft"
          words={pending}
          short={cell.proposed === null ? "Pending" : `${cell.proposed} pending`}
          compact
        />
      )}
      {cell.sent && !pending && <Marker tone="success" icon="sent" words="sent" compact />}
      {(cell.grade !== null || (marks.length === 0 && !pending)) && (
        <span data-grade className="tabular-nums text-body">
          {cell.grade ?? DASH}
        </span>
      )}
    </span>
  );
  if (target === "none") return <div className="px-cell-x">{body}</div>;
  return (
    <button
      type="button"
      data-row-hit
      data-cell={cell.submission?.ref}
      data-target={target}
      onClick={() => links.cell(cell, assignment)}
      className="block h-full w-full cursor-pointer px-cell-x text-right hover:bg-accent focus-inset"
    >
      {body}
    </button>
  );
}

function StudentRow({
  row,
  columns,
  assignments,
  highlighted,
}: {
  row: GradebookRow;
  columns: readonly Assignment[];
  assignments: readonly Assignment[];
  highlighted: boolean;
}) {
  const ref = useRef<HTMLTableRowElement>(null);
  useEffect(() => {
    if (highlighted) ref.current?.scrollIntoView({ block: "center" });
  }, [highlighted]);
  return (
    <tr
      ref={ref}
      data-student={row.student.ref}
      data-highlighted={highlighted}
      className={cn(highlighted && "[&>*]:bg-row-highlight")}
    >
      <th
        scope="row"
        data-first-col
        className={cn(
          STICKY_LEFT,
          LINE,
          "h-row-table border-r px-cell-x text-left text-body font-normal whitespace-nowrap",
        )}
      >
        {row.student.name}
      </th>
      {columns.map((assignment) => {
        const cell = row.cells[assignments.indexOf(assignment)];
        return (
          <td key={assignment.ref} className={cn(LINE, "h-row-table border-r p-0")}>
            {cell && <Cell cell={cell} assignment={assignment} />}
          </td>
        );
      })}
      <td
        data-total
        className={cn(
          STICKY_RIGHT,
          LINE,
          "h-row-table border-l px-cell-x text-right tabular-nums whitespace-nowrap",
        )}
      >
        {row.percent !== null ? (
          <>
            <span className="font-medium text-foreground">{row.percent}%</span>
            <span className="text-secondary-label">
              {" · "}
              {row.earned}/{row.possible}
            </span>
          </>
        ) : (
          DASH
        )}
      </td>
    </tr>
  );
}

export function GradebookScreen({ courseId }: { courseId: LmsRef<"course"> }) {
  const book = useWorkspace((state) => selectGradebook(state, courseId));
  const hash = useRouterState({ select: (state) => state.location.hash });
  const [sort, setSort] = useState<RowSort>({ by: "student", descending: false });
  const [order, setOrder] = useState<ColumnOrder>("due");
  const [picked, setFilter] = useState<RowFilter>("all");
  const assignments = book?.assignments ?? [];
  const countOf = (only: RowFilter) => (book ? filterRows(book.rows, only).length : 0);
  // Once nobody is left under a filter, as after a sync or in another course, show everyone.
  const filter = countOf(picked) > 0 ? picked : "all";
  const rows = useMemo(
    () => (book ? sortRows(filterRows(book.rows, filter), sort, book.assignments) : []),
    [book, sort, filter],
  );
  const columns = useMemo(() => orderColumns(assignments, order), [assignments, order]);
  const onSort = (by: RowSort["by"]) => setSort((prior) => nextSort(prior, by));

  return (
    <CoursePage courseId={courseId}>
      {() =>
        !book || book.rows.length === 0 ? (
          <EmptyState title="This course has no students yet." />
        ) : (
          <>
            <div className="flex flex-none items-center gap-0.5 px-4 py-1 text-meta text-tertiary-label">
              <span className="mr-1">Columns by</span>
              {(["due", "title"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={order === value}
                  onClick={() => setOrder(value)}
                  className={cn(TAB, toggleState(order === value))}
                >
                  {value === "due" ? "Due date" : "Title"}
                </button>
              ))}
              <span className="mr-1 ml-4">Show</span>
              {(["all", "missing", "late"] as const)
                .filter((value) => countOf(value) > 0)
                .map((value) => (
                  <button
                    key={value}
                    type="button"
                    data-filter={value}
                    aria-pressed={filter === value}
                    onClick={() => setFilter(value)}
                    className={cn(TAB, "gap-1", toggleState(filter === value))}
                  >
                    {value === "all" ? "Everyone" : value === "missing" ? "Missing" : "Late"}
                    {value !== "all" && (
                      <span className="tabular-nums text-tertiary-label">{countOf(value)}</span>
                    )}
                  </button>
                ))}
            </div>
            <div
              ref={markHiddenEdges}
              data-testid="gradebook-scroll"
              data-scroll-x
              className="group/book mx-4 min-h-0 snap-x snap-proximity scroll-pl-[188px] overflow-auto rounded-lg border border-border"
            >
              <table
                data-testid="gradebook"
                className="min-w-full border-separate border-spacing-0 text-body"
              >
                <thead>
                  <tr>
                    <th
                      scope="col"
                      data-corner
                      className={cn(
                        STICKY_TOP,
                        "left-0 z-20 w-[188px] min-w-[188px] border-r border-b border-border px-cell-x py-cell-y align-top",
                        EDGE_LEFT,
                      )}
                    >
                      <SortHeader sort={sort} by="student" onSort={onSort}>
                        Student
                      </SortHeader>
                    </th>
                    {columns.map((assignment) => (
                      <th
                        key={assignment.ref}
                        scope="col"
                        data-column={assignment.ref}
                        className={cn(
                          STICKY_TOP,
                          "min-w-[148px] snap-start border-r border-b border-border px-cell-x py-cell-y align-top font-normal",
                        )}
                      >
                        <SortHeader
                          sort={sort}
                          by={assignment.ref}
                          onSort={onSort}
                          className="justify-end"
                        >
                          {assignment.shortTitle}
                        </SortHeader>
                        <span className="block text-right text-meta text-tertiary-label">
                          {assignment.pointsPossible} pts
                        </span>
                      </th>
                    ))}
                    <th
                      scope="col"
                      className={cn(
                        STICKY_TOP,
                        "right-0 z-20 w-[104px] min-w-[104px] border-b border-l border-border px-cell-x py-cell-y align-top",
                        EDGE_RIGHT,
                      )}
                    >
                      <SortHeader sort={sort} by="total" onSort={onSort} className="justify-end">
                        Total
                      </SortHeader>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <StudentRow
                      key={row.student.ref}
                      row={row}
                      columns={columns}
                      assignments={assignments}
                      highlighted={decodeURIComponent(hash) === row.student.ref}
                    />
                  ))}
                </tbody>
                <tfoot>
                  <tr data-testid="class-average">
                    <th
                      scope="row"
                      className={cn(
                        "sticky bottom-0 left-0 z-20 h-row-table border-t border-r border-border bg-card px-cell-x text-left text-meta font-medium text-secondary-label",
                        EDGE_LEFT,
                      )}
                    >
                      Class average
                    </th>
                    {columns.map((assignment) => (
                      <td
                        key={assignment.ref}
                        data-average={assignment.ref}
                        className="sticky bottom-0 z-10 h-row-table border-t border-r border-border bg-card px-cell-x text-right tabular-nums text-body"
                      >
                        {book.averages[assignment.ref] ?? DASH}
                      </td>
                    ))}
                    <td
                      className={cn(
                        "sticky right-0 bottom-0 z-20 border-t border-l border-border bg-card px-cell-x text-right",
                        EDGE_RIGHT,
                      )}
                    >
                      {DASH}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
            <p
              data-testid="gradebook-footnote"
              className="flex-none px-4 pt-4 text-meta text-tertiary-label"
            >
              Totals leave out ungraded and missing work.
            </p>
            <ul
              data-testid="gradebook-legend"
              className="flex flex-none flex-wrap gap-x-4 gap-y-1 px-4 pt-1.5 pb-2 *:flex"
            >
              {(["ungraded", "late", "missing"] as const).map((status) => (
                <li key={status}>
                  <SubmissionBadge status={status} />
                </li>
              ))}
              <li>
                <Badge tone="warning" icon="draft">
                  Pending
                </Badge>
              </li>
              <li>
                <SubmissionBadge status="resubmitted" />
              </li>
              <li>
                <Badge tone="success" icon="sent">
                  Sent
                </Badge>
              </li>
              <li>
                <Badge>{DASH}Not due yet</Badge>
              </li>
            </ul>
          </>
        )
      }
    </CoursePage>
  );
}
