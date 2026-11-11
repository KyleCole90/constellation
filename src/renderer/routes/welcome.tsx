import { createFileRoute } from "@tanstack/react-router";

import { WelcomeScreen } from "~/renderer/components/screens/WelcomeScreen";

export const Route = createFileRoute("/welcome")({ component: WelcomeScreen });
