import { createFileRoute } from "@tanstack/react-router";

import { DueScreen } from "~/renderer/components/screens/DueScreen";

export const Route = createFileRoute("/due")({ component: DueScreen });
