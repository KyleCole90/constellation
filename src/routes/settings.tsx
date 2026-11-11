import { createFileRoute } from "@tanstack/react-router";

import { SettingsScreen } from "~/components/screens/SettingsScreen";
import { parseSettingsSection, type SettingsSectionId } from "~/components/settings/sections.logic";

export const Route = createFileRoute("/settings")({
  validateSearch: (search: Record<string, unknown>): { section?: SettingsSectionId } => {
    const section = parseSettingsSection(search);
    return section === "connections" ? {} : { section };
  },
  component: SettingsScreen,
});
