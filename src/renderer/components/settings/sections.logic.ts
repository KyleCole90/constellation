export const SETTINGS_SECTIONS = [
  { id: "connections", label: "Connections" },
  { id: "ai", label: "AI" },
  { id: "privacy", label: "Privacy" },
  { id: "appearance", label: "Appearance" },
  { id: "demo", label: "Demo" },
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]["id"];

export const parseSettingsSection = (search: Record<string, unknown>): SettingsSectionId =>
  SETTINGS_SECTIONS.find((section) => section.id === search["section"])?.id ?? "connections";
