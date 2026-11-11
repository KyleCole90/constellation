import { createFileRoute } from "@tanstack/react-router";

import { parseInboxSearch } from "~/renderer/components/screens/inbox.logic";
import { InboxScreen } from "~/renderer/components/screens/InboxScreen";

export const Route = createFileRoute("/inbox")({
  validateSearch: parseInboxSearch,
  component: InboxScreen,
});
