import { createFileRoute, redirect } from "@tanstack/react-router";

import { parseThreadSearch } from "~/renderer/components/thread/queue.logic";
import { ThreadScreen } from "~/renderer/components/thread/ThreadScreen";
import { isChatThread, threadAt } from "~/renderer/stores/selectors";
import { workspaceStore } from "~/renderer/stores/workspace";

const Screen = () => <ThreadScreen threadId={Route.useParams().threadId} />;

export const Route = createFileRoute("/threads/$threadId")({
  validateSearch: parseThreadSearch,
  beforeLoad: ({ params }) => {
    const state = workspaceStore().getState();
    const thread = threadAt(state, params.threadId);
    if (!thread) throw redirect({ to: "/", replace: true });
    if (isChatThread(thread) && !state.aiOn()) throw redirect({ to: "/" });
  },
  component: Screen,
});
