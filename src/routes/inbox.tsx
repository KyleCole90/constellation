import { createFileRoute } from "@tanstack/react-router";

import { parseInboxSearch } from "~/components/screens/inbox.logic";
import { InboxScreen } from "~/components/screens/InboxScreen";

export const Route = createFileRoute("/inbox")({
  validateSearch: parseInboxSearch,
  component: InboxScreen,
});
