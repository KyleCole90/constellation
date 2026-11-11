import { createFileRoute } from "@tanstack/react-router";

import { SetupScreen } from "~/components/screens/WelcomeScreen";

export const Route = createFileRoute("/setup")({ component: SetupScreen });
