import { createFileRoute } from "@tanstack/react-router";

import { DueScreen } from "~/components/screens/DueScreen";

export const Route = createFileRoute("/due")({ component: DueScreen });
