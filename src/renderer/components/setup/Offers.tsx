import { useNavigate } from "@tanstack/react-router";

import type { LmsRef } from "~/shared/domain/ids";
import { workspaceStore } from "~/renderer/stores/workspace";

export const useStartSetup = () => {
  const navigate = useNavigate();
  return (course: LmsRef<"course">) => {
    const threadId = workspaceStore().getState().startSetup(course);
    void navigate({ to: "/threads/$threadId", params: { threadId } });
  };
};
