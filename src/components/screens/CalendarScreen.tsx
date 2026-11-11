import { Tooltip } from "@base-ui/react/tooltip";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";

import { bySchoolName, type School } from "~/domain/lms";
import { cn, formatTime } from "~/lib/utils";
import {
  selectCalendar,
  selectSchoolGap,
  type CalendarData,
  type DueItem,
} from "~/stores/selectors";
import { useWorkspace } from "~/stores/workspace";

import { SchoolStar } from "../Brand";
import { EmptyState } from "../EmptyState";
import { SchoolBadge } from "../SchoolBadge";
import { ScreenHeader } from "../ScreenHeader";
import { SCREEN_ICON } from "../screenIcons";
import { Button } from "../ui/button";
import {
  calendarDays,
  calendarSearch,
  calendarSummary,
  calendarView,
  LANE_WIDTH,
  nextDue,
  rangeLabel,
  TONE_LOOK,
  toneOf,
  weekOf,
  weeksThatFit,
  wideLaneFits,
  type CalendarDay,
  type CalendarView,
} from "./calendar.logic";
import { dueProgress, inSchool } from "./due.logic";
import { DisconnectedNotice } from "./DisconnectedNotice";
import { NoSchool } from "./NoSchool";
import { SchoolChips } from "./SchoolChips";
import { useWorkLinks } from "./workLinks";

const LANE_CELL = "min-w-0 border-r border-b border-border";
const dayTint = (day: CalendarDay): string =>
  cn(day.isWeekend && "bg-foreground/[0.012]", day.isToday && "bg-primary/[0.13]");
const schoolMix = (school: School, percent: number): string =>
  `color-mix(in srgb, var(--school-${school.id}, var(--muted-foreground)) ${percent}%, transparent)`;
const dueTime = (item: DueItem): string =>
  item.assignment.dueAt ? formatTime(item.assignment.dueAt) : "";
const coverAnchor = ({ anchor }: { anchor: { height: number } }): number => -anchor.height;

function useWeeksThatFit() {
  const [weeks, setWeeks] = useState<1 | 2>(1);
  const [wideLane, setWideLane] = useState(true);
  const measureOnAttach = useCallback((element: HTMLElement | null) => {
    if (!element) return;
    const update = () => {
      const width = element.getBoundingClientRect().width;
      setWeeks(weeksThatFit(width));
      setWideLane(wideLaneFits(width));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return { weeks, wideLane, measureOnAttach };
}

function Marker({ item }: { item: DueItem }) {
  const links = useWorkLinks();
  const tone = toneOf(item);
  const { borderPercent, fillPercent, dashed } = TONE_LOOK[tone];
  return (
    <Tooltip.Root disableHoverablePopup>
      <Tooltip.Trigger
        type="button"
        data-row-hit
        data-calendar-marker={item.assignment.ref}
        aria-label={`${item.school.name}: ${item.assignment.title}: ${item.toGrade} to grade`}
        onClick={() => links.assignment(item.assignment)}
        style={{
          borderColor: schoolMix(item.school, borderPercent),
          backgroundColor: schoolMix(item.school, fillPercent),
        }}
        className={cn(
          "focus-inset",
          "flex min-h-9 w-full min-w-0 cursor-pointer flex-col rounded border px-1 py-px text-left text-meta hover:brightness-125",
          dashed && "border-dashed",
        )}
      >
        {/* Up to two lines, then an ellipsis. The popup shows the whole title. */}
        <span data-calendar-title className="line-clamp-2 wrap-break-word">
          {item.assignment.shortTitle}
        </span>
        {tone === "to-grade" && (
          <span className="truncate text-secondary-label tabular-nums">
            {item.toGrade} to grade
          </span>
        )}
      </Tooltip.Trigger>
      <Tooltip.Portal>
        {/* The default 5px padding would shift the popup off a marker in the last column, leaving its edge showing. */}
        <Tooltip.Positioner
          side="bottom"
          align="start"
          sideOffset={coverAnchor}
          collisionPadding={0}
          className="z-50"
        >
          <Tooltip.Popup
            data-calendar-popup
            style={{ borderColor: schoolMix(item.school, 70) }}
            className="flex w-max max-w-[260px] min-w-(--anchor-width) origin-(--transform-origin) flex-col gap-0.5 rounded border bg-popover px-1.5 py-1 shadow-popover data-ending-style:scale-95 data-ending-style:opacity-0 data-instant:transition-none data-starting-style:scale-95 data-starting-style:opacity-0 motion-safe:transition-[opacity,scale] motion-safe:duration-100"
          >
            <span className="flex items-center gap-1.5 text-meta text-secondary-label">
              <SchoolStar school={item.school.id} />
              {item.school.name}
            </span>
            <span className="wrap-anywhere text-body">{item.assignment.title}</span>
            <span className="text-meta text-secondary-label tabular-nums">
              {item.toGrade} to grade
            </span>
          </Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

function DayPanel({
  day,
  items,
  onClose,
}: {
  day: CalendarDay;
  items: readonly DueItem[];
  onClose: () => void;
}) {
  const links = useWorkLinks();
  return (
    <aside
      data-testid="calendar-day-panel"
      className="flex w-[280px] flex-none flex-col border-l border-border"
    >
      <div className="flex h-10 flex-none items-center gap-2 border-b border-border pr-2 pl-4">
        <h2 className="min-w-0 flex-1 truncate text-title">
          {day.date.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}
        </h2>
        <Button variant="ghost-muted" size="icon" aria-label="Close day" onClick={onClose}>
          <X />
        </Button>
      </div>
      {items.length === 0 ? (
        <p className="p-4 text-body text-muted-foreground">Nothing is due this day.</p>
      ) : (
        <ul className="min-h-0 flex-1 divide-y divide-border overflow-y-auto">
          {items.map((item) => {
            const tone = toneOf(item);
            return (
              <li key={item.assignment.ref}>
                <button
                  type="button"
                  data-row-hit
                  data-calendar-day-row={item.assignment.ref}
                  onClick={() => links.assignment(item.assignment)}
                  className={cn(
                    "focus-inset",
                    "flex w-full cursor-pointer flex-col gap-1 px-4 py-3 text-left hover:bg-accent",
                  )}
                >
                  <span className="flex items-center gap-2">
                    <SchoolBadge school={item.school} />
                    <span className="min-w-0 flex-1 truncate text-meta text-secondary-label">
                      {item.course.code}
                    </span>
                    <span className="flex-none text-meta text-muted-foreground tabular-nums">
                      {dueTime(item)}
                    </span>
                  </span>
                  <span className="wrap-anywhere text-body">{item.assignment.title}</span>
                  <span className="text-meta text-muted-foreground tabular-nums">
                    {[
                      tone === "to-grade" && `${item.toGrade} to grade`,
                      dueProgress(item).label,
                      `${item.assignment.pointsPossible} pts`,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}

function LoadLegend({ lanes }: { lanes: CalendarData["lanes"] }) {
  return (
    <span
      data-testid="calendar-load-legend"
      className="flex flex-none items-center gap-x-2.5 text-meta text-tertiary-label"
    >
      <span className="text-muted-foreground">Due</span>
      {lanes.map(({ school }) => (
        <span key={school.id} title={school.name} className="flex items-center gap-1">
          <span
            className="h-1.5 w-3 rounded-bar"
            style={{ backgroundColor: schoolMix(school, 55) }}
          />
          {school.abbr}
        </span>
      ))}
      <span className="flex items-center gap-1">
        <span className="h-2.5 w-3 rounded-xs border border-dashed border-muted-foreground" />
        Nothing to grade
      </span>
    </span>
  );
}

const focusDay = (daysFromToday: number): boolean => {
  const day = document.querySelector<HTMLElement>(`[data-calendar-day="${daysFromToday}"]`);
  day?.focus();
  return day !== null;
};

function CalendarGrid({
  days,
  items,
  lanes,
  picked,
  onPick,
  onStep,
  wideLane,
}: {
  days: readonly CalendarDay[];
  items: readonly DueItem[];
  lanes: CalendarData["lanes"];
  picked: number | null;
  onPick: (daysFromToday: number) => void;
  onStep: (daysFromToday: number) => void;
  wideLane: boolean;
}) {
  // A day past the window's edge exists only once the window has moved, so it takes focus after that render.
  const focusOnRender = useRef<number | null>(null);
  useEffect(() => {
    if (focusOnRender.current !== null && focusDay(focusOnRender.current))
      focusOnRender.current = null;
  });
  const dueOn = (day: CalendarDay) => items.filter((item) => item.days === day.daysFromToday);
  const dayCell = (day: CalendarDay) =>
    cn(LANE_CELL, dayTint(day), picked === day.daysFromToday && "bg-selected");
  return (
    // Below 1280px, or when the day panel leaves too little room for a week beside the wide lane, the lane shows only course codes, so its width goes to the day columns. weeksThatFit keeps counting the wide lane, which only ever errs toward one week. Each course row is as tall as its chips.
    <div
      className="grid [--lane:var(--lane-wide)] max-xl:[--lane:96px]"
      style={{
        "--lane-wide": `${wideLane ? LANE_WIDTH : 96}px`,
        gridTemplateColumns: `var(--lane) repeat(${days.length}, minmax(0, 1fr))`,
        gridTemplateRows: [
          "auto auto",
          ...lanes.flatMap(({ courses }) => ["auto", ...courses.map(() => "auto")]),
        ].join(" "),
      }}
    >
      <div className="sticky top-0 z-10 border-r border-b border-border bg-background" />
      {days.map((day) => (
        <div
          key={day.daysFromToday}
          className={cn(
            "sticky top-0 z-10 border-r border-b border-border bg-background",
            day.isToday && "shadow-today",
          )}
        >
          <button
            type="button"
            data-row-hit
            data-calendar-day={day.daysFromToday}
            aria-label={`${day.date.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}, ${dueOn(day).length} due`}
            aria-pressed={picked === day.daysFromToday}
            aria-current={day.isToday ? "date" : undefined}
            onClick={() => onPick(day.daysFromToday)}
            onKeyDown={(event) => {
              const step = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
              if (!step) return;
              event.preventDefault();
              const target = day.daysFromToday + step;
              if (!focusDay(target)) focusOnRender.current = target;
              onStep(target);
            }}
            className={cn(
              "focus-inset",
              "flex w-full cursor-pointer flex-col items-center py-1 hover:bg-accent",
              picked === day.daysFromToday && "bg-selected",
            )}
          >
            <span className="text-meta text-muted-foreground">
              {day.date.toLocaleDateString("en-US", { weekday: "short" })}
            </span>
            <span
              className={cn(
                "flex size-5 items-center justify-center rounded-full text-meta tabular-nums",
                day.isToday
                  ? "bg-primary font-medium text-primary-foreground"
                  : "text-secondary-label",
              )}
            >
              {day.date.getDate()}
            </span>
          </button>
        </div>
      ))}

      <div className={cn(LANE_CELL, "flex items-center pr-2 pl-6 text-meta leading-3 font-medium")}>
        Due
      </div>
      {days.map((day) => {
        const due = dueOn(day);
        return (
          <button
            key={day.daysFromToday}
            type="button"
            data-row-hit
            data-calendar-load={day.daysFromToday}
            aria-label={`${due.length} due`}
            tabIndex={-1}
            onClick={() => onPick(day.daysFromToday)}
            className={cn(
              dayCell(day),
              "focus-inset",
              "flex min-h-5 cursor-pointer flex-col-reverse justify-center gap-px px-1.5 py-1 hover:bg-accent",
            )}
          >
            {due
              .toSorted((a, b) => bySchoolName(a.school, b.school))
              .map((item) => (
                <span
                  key={item.assignment.ref}
                  className="block h-1.5 w-full rounded-bar"
                  style={{ backgroundColor: schoolMix(item.school, 55) }}
                />
              ))}
          </button>
        );
      })}

      {lanes.map(({ school, courses }) => (
        <Fragment key={school.id}>
          <div
            data-calendar-school={school.id}
            title={school.name}
            className="col-span-full flex h-7 items-center gap-1.5 border-b border-border bg-card px-3 text-meta font-medium"
          >
            <SchoolStar school={school.id} />
            <span className="min-w-0 truncate">{school.name}</span>
          </div>
          {courses.map((course) => (
            <Fragment key={course.ref}>
              <div
                data-calendar-course={course.ref}
                title={`${course.code} ${course.title}`}
                className={cn(LANE_CELL, "flex min-h-12 flex-col py-1 pr-2 pl-6")}
              >
                <span className="truncate text-meta font-medium">{course.code}</span>
                <span
                  className={cn(
                    "line-clamp-2 wrap-break-word text-meta text-muted-foreground max-xl:hidden",
                    !wideLane && "hidden",
                  )}
                >
                  {course.title}
                </span>
              </div>
              {days.map((day) => (
                <div
                  key={day.daysFromToday}
                  className={cn(dayCell(day), "flex flex-col gap-0.5 p-px")}
                >
                  {dueOn(day)
                    .filter((item) => item.course.ref === course.ref)
                    .map((item) => (
                      <Marker key={item.assignment.ref} item={item} />
                    ))}
                </div>
              ))}
            </Fragment>
          ))}
        </Fragment>
      ))}
    </div>
  );
}

export function CalendarScreen() {
  const data = useWorkspace((state) => selectCalendar(state, state.now()));
  const gap = useWorkspace(selectSchoolGap);
  const { week, picked, school } = calendarView(data.today, useSearch({ from: "/calendar" }));
  const navigate = useNavigate({ from: "/calendar" });
  const today = data.today;
  const show = useCallback(
    (next: Partial<CalendarView>) =>
      void navigate({
        search: (search) => calendarSearch(today, { ...calendarView(today, search), ...next }),
        replace: true,
      }),
    [navigate, today],
  );
  const setWeek = (next: number) =>
    show({ week: next, picked: picked === undefined ? undefined : picked + 7 * (next - week) });
  const setSchool = (next: CalendarView["school"]) => show({ school: next });
  const { weeks, wideLane, measureOnAttach } = useWeeksThatFit();

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        event.key === "Escape" &&
        !event.defaultPrevented &&
        !document.querySelector('[role="dialog"]')
      )
        show({ picked: undefined });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [show]);

  const days = calendarDays(data.today, week, weeks);
  const shown = data.items.filter((item) => inSchool(school, item.school.id));
  const lanes = data.lanes.filter((lane) => inSchool(school, lane.school.id));
  const pickedDay = days.find((day) => day.daysFromToday === picked);
  const inWindow = shown.filter((item) => days.some((day) => day.daysFromToday === item.days));
  const next = nextDue(data.today, shown, days);

  const open = (daysFromToday: number) => show({ picked: daysFromToday });
  const pick = (daysFromToday: number) =>
    picked === daysFromToday ? show({ picked: undefined }) : open(daysFromToday);
  const step = (daysFromToday: number) => {
    if (picked !== undefined) open(daysFromToday);
    else if (!days.some((day) => day.daysFromToday === daysFromToday))
      show({ week: weekOf(data.today, daysFromToday) });
  };
  const goToday = () => show({ week: 0, picked: picked === undefined ? undefined : 0 });

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <ScreenHeader icon={SCREEN_ICON.calendar} title="Calendar" />
      <div className="flex flex-none flex-wrap items-center gap-x-4 gap-y-1 border-b border-border px-4 py-1.5">
        <p data-testid="calendar-summary" className="min-w-0 flex-1 text-body text-secondary-label">
          {calendarSummary(inWindow, school === "all" ? data.undated : 0)}
        </p>
        <LoadLegend lanes={lanes} />
        <SchoolChips value={school} onChange={setSchool} />
      </div>
      <DisconnectedNotice />
      {gap ? (
        <NoSchool gap={gap} />
      ) : shown.length === 0 ? (
        <EmptyState
          title={
            school !== "all"
              ? "Nothing is due at this school."
              : "No assignments have a due date yet."
          }
        >
          {school !== "all" && (
            <Button size="sm" onClick={() => setSchool("all")}>
              Show all schools
            </Button>
          )}
        </EmptyState>
      ) : (
        <div className="flex min-h-0 flex-1">
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex h-10 flex-none items-center gap-1 border-b border-border px-4">
              <h2 data-testid="calendar-range" className="mr-2 text-title tabular-nums">
                {rangeLabel(days)}
              </h2>
              <Button
                variant="ghost-muted"
                size="icon"
                aria-label="Previous week"
                onClick={() => setWeek(week - 1)}
              >
                <ChevronLeft />
              </Button>
              <Button
                variant="ghost-muted"
                size="icon"
                aria-label="Next week"
                onClick={() => setWeek(week + 1)}
              >
                <ChevronRight />
              </Button>
              <Button size="sm" onClick={goToday}>
                Today
              </Button>
              {next.daysFromToday === null ? (
                <span
                  data-testid="calendar-next-due"
                  className="ml-auto text-meta text-muted-foreground tabular-nums"
                >
                  {next.label}
                </span>
              ) : (
                <Button
                  data-testid="calendar-next-due"
                  variant="ghost-muted"
                  size="sm"
                  className="ml-auto"
                  onClick={() => setWeek(weekOf(data.today, next.daysFromToday))}
                >
                  <span className="tabular-nums">{next.label}</span>
                </Button>
              )}
            </div>
            <div
              ref={measureOnAttach}
              data-testid="calendar-grid"
              className="flex min-h-0 flex-1 flex-col overflow-y-auto pb-4"
            >
              <Tooltip.Provider delay={150}>
                <CalendarGrid
                  days={days}
                  items={inWindow}
                  lanes={lanes}
                  picked={pickedDay?.daysFromToday ?? null}
                  onPick={pick}
                  onStep={step}
                  wideLane={wideLane}
                />
              </Tooltip.Provider>
            </div>
          </div>
          {pickedDay && (
            <DayPanel
              day={pickedDay}
              items={inWindow.filter((item) => item.days === pickedDay.daysFromToday)}
              onClose={() => show({ picked: undefined })}
            />
          )}
        </div>
      )}
    </div>
  );
}
