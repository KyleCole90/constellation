import { cn } from "~/renderer/lib/utils";
import { selectSchoolCoverage, selectSchoolGap } from "~/renderer/stores/selectors";
import { useWorkspace } from "~/renderer/stores/workspace";

import { CHIP, toggleState } from "../ui/toggle";

import type { SchoolFilter } from "./due.logic";

export function SchoolChips({
  value,
  onChange,
}: {
  value: SchoolFilter;
  onChange: (next: SchoolFilter) => void;
}) {
  const schools = useWorkspace(selectSchoolCoverage).withData;
  const gap = useWorkspace(selectSchoolGap);
  if (gap) return null;
  return (
    <div role="group" aria-label="Filter by school" className="flex flex-wrap gap-1">
      {[
        { id: "all" as const, label: "All schools" },
        ...schools.map((school) => ({ id: school.id, label: school.abbr })),
      ].map((option) => (
        <button
          key={option.id}
          type="button"
          aria-pressed={value === option.id}
          onClick={() => onChange(option.id)}
          className={cn(CHIP, toggleState(value === option.id))}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
