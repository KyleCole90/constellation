import type { School } from "~/shared/domain/lms";
import { useWorkspace } from "~/renderer/stores/workspace";

/** The one chip left in the app: which school something is in, in its own colour on a faint tint of it. */
export function SchoolBadge({ school }: { school: School | string }) {
  const found = useWorkspace((state) =>
    typeof school === "string" ? state.schools.find((s) => s.id === school) : school,
  );
  // With one school it tells the teacher nothing, so it shows only once there are two to tell apart.
  const several = useWorkspace((state) => state.schools.length > 1);
  if (!found || !several) return null;
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
