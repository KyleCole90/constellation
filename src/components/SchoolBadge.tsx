import type { School } from "~/domain/lms";
import { useWorkspace } from "~/stores/workspace";

/** The one chip left in the app: a school's identity, in its own colour on a faint tint of it. */
export function SchoolBadge({ school }: { school: School | string }) {
  const found = useWorkspace((state) =>
    typeof school === "string" ? state.schools.find((s) => s.id === school) : school,
  );
  if (!found) return null;
  return (
    <span
      data-slot="badge"
      title={found.name}
      style={{ "--school": `var(--school-${found.id}, var(--muted-foreground))` }}
      className="inline-flex shrink-0 items-center rounded px-pill-x py-pill-y text-meta font-medium whitespace-nowrap bg-(--school)/10 text-(--school)"
    >
      {found.abbr}
    </span>
  );
}
