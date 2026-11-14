import { Check, X } from "lucide-react";
import { useEffect, useState } from "react";

import { weekdayDate } from "~/shared/domain/preview";
import type { SourceCourse } from "~/shared/domain/content";
import type { CourseSetup } from "~/shared/domain/setup";
import {
  isoDate,
  shiftPreview,
  type DraftTerm,
  type PlanDraft,
  type TermPlan,
  type Weekday,
} from "~/shared/domain/term";
import { cn } from "~/renderer/lib/utils";
import { useWorkspace, workspaceStore } from "~/renderer/stores/workspace";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, Note, Refusal } from "./parts";
import {
  DAY_SHORT,
  dayMapWords,
  checkPlan,
  initialPlan,
  occupiedWords,
  packageTermWords,
  toggleDay,
  toggleNewDay,
  WEEKDAYS,
} from "./setup.logic";
import { FIELD_CLASS, WARNING_CLASS } from "./styles";

function DayToggles({
  side,
  days,
  onToggle,
}: {
  side: "old" | "new";
  days: readonly Weekday[];
  onToggle: (day: Weekday) => void;
}) {
  return (
    <div role="group" aria-label={`Meeting days, ${side} term`} className="flex gap-1">
      {WEEKDAYS.map((day) => {
        const on = days.includes(day);
        return (
          <button
            key={day}
            type="button"
            data-testid={`day-${side}-${day}`}
            aria-pressed={on}
            onClick={() => onToggle(day)}
            className={cn(
              "inline-flex h-8 min-w-0 flex-1 cursor-pointer items-center justify-center gap-0.5 rounded-md border text-meta outline-none focus-visible:border-ring",
              on
                ? "border-primary bg-primary/20 text-foreground"
                : "border-border text-muted-foreground hover:text-foreground",
            )}
          >
            {/* A wrong day moves every due date, so a chosen day stands out more than the neutral selected look of other toggles, and carries a mark as well as a fill. */}
            {on && <Check aria-hidden strokeWidth={2.5} className="size-3 flex-none" />}
            {DAY_SHORT[day]}
          </button>
        );
      })}
    </div>
  );
}

function TermFields({
  side,
  term,
  onChange,
  onDay,
}: {
  side: "old" | "new";
  term: DraftTerm;
  onChange: (patch: Partial<DraftTerm>) => void;
  onDay: (day: Weekday) => void;
}) {
  return (
    <fieldset className="flex min-w-0 flex-1 flex-col gap-2">
      <legend className="pb-label-gap text-meta text-secondary-label">
        {side === "old" ? "Old term" : "New term"}
      </legend>
      <input
        aria-label={`${side} term name`}
        data-testid={`${side}-term-name`}
        placeholder="Term name"
        value={term.name}
        onChange={(event) => onChange({ name: event.target.value })}
        className={FIELD_CLASS}
      />
      <div className="flex gap-2">
        <input
          type="date"
          aria-label={`${side} term start`}
          data-testid={`${side}-term-start`}
          value={term.start}
          onChange={(event) => onChange({ start: isoDate(event.target.value) ?? "" })}
          className={cn(FIELD_CLASS, "flex-1")}
        />
        <input
          type="date"
          aria-label={`${side} term end`}
          data-testid={`${side}-term-end`}
          value={term.end}
          onChange={(event) => onChange({ end: isoDate(event.target.value) ?? "" })}
          className={cn(FIELD_CLASS, "flex-1")}
        />
      </div>
      <DayToggles side={side} days={term.days} onToggle={onDay} />
    </fieldset>
  );
}

function Breaks({
  plan,
  onChange,
}: {
  plan: PlanDraft;
  onChange: (breaks: PlanDraft["breaks"]) => void;
}) {
  const patch = (index: number, next: Partial<PlanDraft["breaks"][number]>) =>
    onChange(plan.breaks.map((held, at) => (at === index ? { ...held, ...next } : held)));
  return (
    <section className="flex flex-col gap-2">
      <h4 className="section-title">Breaks</h4>
      {plan.breaks.map((held, index) => (
        // oxlint-disable-next-line react/no-array-index-key -- breaks have no id, and each row is controlled inputs with no local state
        <div key={index} data-testid="break-row" className="flex items-center gap-2">
          <input
            aria-label="Break name"
            placeholder="Spring break"
            value={held.name}
            onChange={(event) => patch(index, { name: event.target.value })}
            className={cn(FIELD_CLASS, "flex-1")}
          />
          <input
            type="date"
            aria-label="Break start"
            value={held.start}
            onChange={(event) => patch(index, { start: isoDate(event.target.value) ?? "" })}
            className={FIELD_CLASS}
          />
          <input
            type="date"
            aria-label="Break end"
            value={held.end}
            onChange={(event) => patch(index, { end: isoDate(event.target.value) ?? "" })}
            className={FIELD_CLASS}
          />
          <Button
            variant="ghost-muted"
            size="icon"
            aria-label={`Remove break ${index + 1}`}
            onClick={() => onChange(plan.breaks.filter((_, at) => at !== index))}
          >
            <X />
          </Button>
        </div>
      ))}
      <Button
        variant="outline"
        size="sm"
        className="self-start"
        data-testid="add-break"
        onClick={() => onChange([...plan.breaks, { name: "", start: "", end: "" }])}
      >
        Add a break
      </Button>
    </section>
  );
}

function ShiftPreview({ source, plan }: { source: SourceCourse; plan: TermPlan }) {
  if (source.dated.length === 0) return <Note>{source.code} has no due dates to move.</Note>;
  return (
    <table className="w-full text-left text-meta">
      <caption className="pt-1 pb-label-gap text-left section-title">
        Where the due dates land
      </caption>
      <thead className="text-meta text-muted-foreground">
        <tr>
          <th className="py-row-y pr-cell-x font-normal">Item</th>
          <th className="py-row-y pr-cell-x font-normal">Old due</th>
          <th className="py-row-y pr-cell-x font-normal">New due</th>
        </tr>
      </thead>
      <tbody>
        {shiftPreview(source.dated, plan).map((row) => (
          <tr key={row.item.ref} data-testid="shift-row" className="border-t border-border">
            <td className="py-cell-y pr-cell-x">{row.item.title}</td>
            <td className="py-cell-y pr-cell-x whitespace-nowrap text-muted-foreground">
              {weekdayDate(row.from)}
            </td>
            <td className="py-cell-y pr-cell-x whitespace-nowrap">
              {weekdayDate(row.date)}
              {(row.movedFrom || row.outsideTerm) && (
                <Badge
                  tone={row.movedFrom ? "neutral" : "danger"}
                  icon={row.movedFrom ? undefined : "error"}
                  className="flex"
                >
                  {row.movedFrom ? `Moved out of ${row.movedFrom.name}` : "Outside the term"}
                </Badge>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const sourceRefOf = (setup: CourseSetup) =>
  setup.source?.kind === "course" ? setup.source.ref : null;

/** Inside the copy card: where each due date lands under the dates the copy was drafted from, which is what the approval covers. */
export function CopyDates({ setup }: { setup: CourseSetup }) {
  const source = useWorkspace(
    (state) =>
      state.setupOptions[setup.school]?.sources.find((entry) => entry.ref === sourceRefOf(setup)) ??
      null,
  );
  if (!source || !setup.plan) return null;
  return (
    <section data-testid="copy-dates" className="border-b border-border px-card py-3">
      <ShiftPreview source={source} plan={setup.plan} />
    </section>
  );
}

function DatesForm({
  setup,
  source,
  confirmed,
}: {
  setup: CourseSetup;
  source: SourceCourse | null;
  confirmed: boolean;
}) {
  const plan = initialPlan(setup, source);
  const setPlan = (change: (current: PlanDraft) => PlanDraft) => {
    const state = workspaceStore().getState();
    state.editDates(setup.course, change(initialPlan(state.setups[setup.course] ?? setup, source)));
  };
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const checked = checkPlan(plan);
  const problems = checked.ok ? [] : checked.error;
  const unchanged = confirmed && JSON.stringify(plan) === JSON.stringify(setup.plan);
  const occupied = occupiedWords(setup.shell);
  const packageTerm = packageTermWords(setup.source, plan.oldTerm);
  const patchOld = (patch: Partial<DraftTerm>) =>
    setPlan((current) => ({ ...current, oldTerm: { ...current.oldTerm, ...patch } }));
  const patchNew = (patch: Partial<DraftTerm>) =>
    setPlan((current) => ({ ...current, newTerm: { ...current.newTerm, ...patch } }));
  const review = async (confirming: TermPlan) => {
    setBusy(true);
    setRefused(await workspaceStore().getState().confirmDates(setup.course, confirming));
    setBusy(false);
  };
  const changeSource = () =>
    setRefused(workspaceStore().getState().chooseSource(setup.course, null));
  const sourceName = setup.source?.kind === "course" ? setup.source.label : setup.source?.name;

  return (
    <Card
      title={`Dates for ${setup.shell.code}`}
      testId="dates-card"
      footer={
        <Button
          variant="default"
          size="lg"
          data-testid="review-copy"
          disabled={busy || !checked.ok || unchanged}
          onClick={() => checked.ok && void review(checked.value)}
        >
          Review the copy
        </Button>
      }
    >
      <div className="flex items-center gap-2">
        <p className="min-w-0 flex-1 truncate text-meta text-muted-foreground">From {sourceName}</p>
        <Button variant="link" size="sm" onClick={changeSource}>
          Change source
        </Button>
      </div>
      <div className="flex gap-4">
        <TermFields
          side="old"
          term={plan.oldTerm}
          onChange={patchOld}
          onDay={(day) => patchOld({ days: toggleDay(plan.oldTerm.days, day) })}
        />
        <TermFields
          side="new"
          term={plan.newTerm}
          onChange={patchNew}
          onDay={(day) =>
            patchNew({ days: toggleNewDay(plan.newTerm.days, day, plan.oldTerm.days) })
          }
        />
      </div>
      <p data-testid="day-map" className="text-body">
        {dayMapWords(plan.oldTerm.days, plan.newTerm.days)}
      </p>
      <Breaks plan={plan} onChange={(breaks) => setPlan((current) => ({ ...current, breaks }))} />
      {setup.source?.kind === "cartridge" ? (
        <Note>
          Dates in a package are read during the import, so there is nothing to preview here. Only
          the rule applies later.
        </Note>
      ) : source && checked.ok && !unchanged ? (
        // Unchanged since the review, the copy card below shows this same table.
        <ShiftPreview source={source} plan={checked.value} />
      ) : null}
      {packageTerm && (
        <p data-testid="package-term-warning" role="alert" className={WARNING_CLASS}>
          {packageTerm}
        </p>
      )}
      {occupied && (
        <p data-testid="occupied-warning" role="alert" className={WARNING_CLASS}>
          {occupied}
        </p>
      )}
      {problems.length > 0 && (
        <ul
          data-testid="plan-problems"
          className="flex flex-col gap-0.5 text-meta text-warning-foreground"
        >
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}
      <Refusal text={refused} />
    </Card>
  );
}

/** Waits for the source's real dates, so the form can open prefilled. A failed read opens it blank, because everything here is editable. */
export function DatesCard({
  setup,
  confirmed = false,
}: {
  setup: CourseSetup;
  confirmed?: boolean;
}) {
  const needsSource = setup.source?.kind === "course" && setup.plan === null;
  const options = useWorkspace((state) => state.setupOptions[setup.school]);
  const sourceRef = sourceRefOf(setup);
  const source = options?.sources.find((entry) => entry.ref === sourceRef) ?? null;
  const [read, setRead] = useState(Boolean(options));
  useEffect(() => {
    if (options) return;
    let live = true;
    void workspaceStore()
      .getState()
      .loadSetupOptions(setup.school)
      .finally(() => {
        if (live) setRead(true);
      });
    return () => {
      live = false;
    };
  }, [options, setup.school]);
  if (needsSource && !read && !options) return <Note>Reading the source course.</Note>;
  return (
    <DatesForm
      key={`${sourceRef ?? setup.source?.kind}`}
      setup={setup}
      source={source}
      confirmed={confirmed}
    />
  );
}
