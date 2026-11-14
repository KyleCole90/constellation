import { isDemoSchool, type School } from "~/shared/domain/lms";

const SETTINGS_SECTIONS = [
  { id: "connections", label: "Connections" },
  { id: "ai", label: "AI" },
  { id: "privacy", label: "Privacy" },
  { id: "appearance", label: "Appearance" },
  { id: "demo", label: "Demo" },
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]["id"];

/** The Demo section drives the fake LMS, so it shows only while a demo school exists. */
export const settingsSections = (schools: readonly School[]) =>
  schools.some(isDemoSchool)
    ? SETTINGS_SECTIONS
    : SETTINGS_SECTIONS.filter((section) => section.id !== "demo");

export const parseSettingsSection = (
  search: Record<string, unknown>,
  sections: ReturnType<typeof settingsSections> = SETTINGS_SECTIONS,
): SettingsSectionId =>
  sections.find((section) => section.id === search["section"])?.id ?? "connections";
