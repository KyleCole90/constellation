import { createFileRoute, redirect } from "@tanstack/react-router";

import { NORTH_STAR_THREAD } from "~/renderer/stores/selectors";
import { workspaceStore } from "~/renderer/stores/workspace";

export const Route = createFileRoute("/")({
  beforeLoad: () => {
    if (!workspaceStore().getState().aiOn()) throw redirect({ to: "/due" });
    throw redirect({ to: "/threads/$threadId", params: { threadId: NORTH_STAR_THREAD } });
  },
});
