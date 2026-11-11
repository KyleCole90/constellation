import { createRouter } from "@tanstack/react-router";

import type { ThreadId } from "~/shared/domain/ids";
import { routeTree } from "./routeTree.gen";

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

declare module "@tanstack/history" {
  interface HistoryState {
    /** Set on the /setup entry that Set up pushed, so Finish setup knows the welcome entry sits right behind it. */
    fromWelcome?: true;
    /** The address the onboarding gate turned away, so Finish setup can open it. */
    next?: string;
    /** The chat whose handoff card opened this thread, so the sidebar marks that chat. */
    fromChat?: ThreadId;
  }
}
