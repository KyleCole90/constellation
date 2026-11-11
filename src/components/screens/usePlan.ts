import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";

import { selectDueExtras, selectWhatsDue, selectWorkStages } from "~/stores/selectors";
import { useWorkspace, workspaceStore } from "~/stores/workspace";

import {
  filterDue,
  filterExtras,
  inSchool,
  planWork,
  type SchoolFilter,
  type WorkPlan,
} from "./due.logic";

export const usePlan = (school: SchoolFilter): WorkPlan => {
  const groups = useWorkspace((state) => selectWhatsDue(state, state.now()));
  const extras = useWorkspace(selectDueExtras);
  const stages = useWorkspace(selectWorkStages);
  const expired = useWorkspace(
    useShallow((state) =>
      state.schools.filter((home) => state.connections[home.id]?.status === "expired"),
    ),
  );
  return useMemo(
    () =>
      planWork({
        groups: filterDue(groups, school),
        extras: filterExtras(extras, school),
        stages,
        expired: expired.filter((home) => inSchool(school, home.id)),
        now: workspaceStore().getState().now(),
      }),
    [groups, extras, stages, expired, school],
  );
};
