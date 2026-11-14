import type { Assignment } from "~/shared/domain/lms";
import type { GradebookCell, GradebookRow } from "~/renderer/stores/selectors";

import type { SubmissionStatus } from "../ui/badge";

export const cellMarks = (cell: GradebookCell): readonly SubmissionStatus[] => {
  const submission = cell.submission;
  if (!submission) return [];
  if (submission.workflow === "missing") return ["missing"];
  const late: readonly SubmissionStatus[] = submission.lateDays > 0 ? ["late"] : [];
  if (submission.workflow !== "submitted") return submission.workflow === "graded" ? late : [];
  if (cell.grade !== null) return ["resubmitted", ...late];
  // A pending grade says the cell's state itself, so "ungraded" beside it reads as a contradiction.
  return cell.pending ? late : ["ungraded", ...late];
};

export const pendingWords = (cell: GradebookCell): string | null => {
  if (!cell.pending) return null;
  const state = cell.pending.canApprove ? "pending approval" : cell.pending.label.toLowerCase();
  return cell.proposed === null ? state : `${cell.proposed} ${state}`;
};

/** What clicking a cell does: open work to grade, read the record of a send, read the submission, or nothing at all. */
export type CellTarget = "work" | "record" | "view" | "none";

export const cellTarget = (cell: GradebookCell): CellTarget => {
  const submission = cell.submission;
  if (!submission || submission.workflow === "missing" || submission.workflow === "unsubmitted")
    return "none";
  if (cell.pending || submission.workflow === "submitted") return "work";
  return cell.sent ? "record" : "view";
};

export type RowSort = { by: "student" | "total" | Assignment["ref"]; descending: boolean };

const sortValue = (
  row: GradebookRow,
  by: RowSort["by"],
  assignments: readonly Assignment[],
): number | null => {
  if (by === "total") return row.percent;
  const index = assignments.findIndex((assignment) => assignment.ref === by);
  return row.cells[index]?.grade ?? null;
};

/** Students with no value stay at the bottom either way, because a blank isn't low or high. */
export const sortRows = (
  rows: readonly GradebookRow[],
  sort: RowSort,
  assignments: readonly Assignment[],
): readonly GradebookRow[] => {
  const direction = sort.descending ? -1 : 1;
  return [...rows].sort((a, b) => {
    if (sort.by === "student") return direction * a.student.name.localeCompare(b.student.name);
    const left = sortValue(a, sort.by, assignments);
    const right = sortValue(b, sort.by, assignments);
    if (left === null || right === null)
      return left === right ? a.student.name.localeCompare(b.student.name) : left === null ? 1 : -1;
    return direction * (left - right) || a.student.name.localeCompare(b.student.name);
  });
};

/** The first click on a grade column shows the highest first, since that's what a person usually wants. */
export const nextSort = (sort: RowSort, by: RowSort["by"]): RowSort =>
  sort.by === by ? { by, descending: !sort.descending } : { by, descending: by !== "student" };

export type ColumnOrder = "due" | "title";

export const orderColumns = (
  assignments: readonly Assignment[],
  order: ColumnOrder,
): readonly Assignment[] =>
  order === "due"
    ? assignments
    : [...assignments].sort((a, b) => a.shortTitle.localeCompare(b.shortTitle));

/** Who is behind: students with a missing or late mark in any cell. */
export type RowFilter = "all" | "missing" | "late";

export const filterRows = (
  rows: readonly GradebookRow[],
  filter: RowFilter,
): readonly GradebookRow[] =>
  filter === "all"
    ? rows
    : rows.filter((row) => row.cells.some((cell) => cellMarks(cell).includes(filter)));
