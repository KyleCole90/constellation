import { useNavigate } from "@tanstack/react-router";

import type { LmsRef } from "~/domain/ids";
import { workspaceStore } from "~/stores/workspace";

export const useStartSetup = () => {
  const navigate = useNavigate();
  return (course: LmsRef<"course">) => {
    const threadId = workspaceStore().getState().startSetup(course);
    void navigate({ to: "/threads/$threadId", params: { threadId } });
  };
};
