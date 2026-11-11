import { createRootRoute, redirect } from "@tanstack/react-router";

import { AppShell } from "~/renderer/components/AppShell";
import { workspaceStore } from "~/renderer/stores/workspace";

export const Route = createRootRoute({
  beforeLoad: ({ location }) => {
    const step = workspaceStore().getState().onboarding;
    const onboarding = location.pathname === "/welcome" || location.pathname === "/setup";
    if (step !== "done" && !onboarding)
      throw redirect({
        to: step === "setup" ? "/setup" : "/welcome",
        state: { next: location.href },
      });
    if (step === "done" && onboarding) throw redirect({ href: location.state.next ?? "/" });
  },
  component: AppShell,
});
