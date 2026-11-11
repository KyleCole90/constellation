import { createFileRoute, redirect } from "@tanstack/react-router";

import { parseThreadSearch } from "~/renderer/components/thread/queue.logic";
import { ThreadScreen } from "~/renderer/components/thread/ThreadScreen";
import type { ThreadId } from "~/shared/domain/ids";
import { isChatThread } from "~/renderer/stores/selectors";
import { workspaceStore } from "~/renderer/stores/workspace";

const Screen = () => <ThreadScreen threadId={Route.useParams().threadId as ThreadId} />;

export const Route = createFileRoute("/threads/$threadId")({
  validateSearch: parseThreadSearch,
  beforeLoad: ({ params }) => {
    const state = workspaceStore().getState();
    const thread = state.threads[params.threadId as ThreadId];
    if (!thread) throw redirect({ to: "/", replace: true });
    if (isChatThread(thread) && !state.aiOn()) throw redirect({ to: "/" });
  },
  component: Screen,
});
