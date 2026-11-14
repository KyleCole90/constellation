import { VAULT_PLACE } from "~/renderer/desktop";
import { Link, useSearch } from "@tanstack/react-router";
import { FlaskConical, Plug, Shield, Sparkles, SunMoon } from "lucide-react";
import { useEffect, useRef } from "react";

import { cn } from "~/renderer/lib/utils";
import { useWorkspace } from "~/renderer/stores/workspace";

import { ScreenHeader } from "../ScreenHeader";
import { SCREEN_ICON } from "../screenIcons";
import { AiSection } from "../settings/AiSection";
import { AppearanceSection } from "../settings/AppearanceSection";
import { ConnectionCard } from "../settings/ConnectionCard";
import { DemoSection } from "../settings/DemoSection";
import { AddressField, InstitutionList, useInstitutions } from "../settings/Institutions";
import { SettingsSection } from "../settings/layout";
import { PrivacySection } from "../settings/Privacy";
import {
  parseSettingsSection,
  settingsSections,
  type SettingsSectionId,
} from "../settings/sections.logic";

const ICONS = {
  connections: Plug,
  ai: Sparkles,
  privacy: Shield,
  appearance: SunMoon,
  demo: FlaskConical,
} as const;

function AddInstitution() {
  const institutions = useInstitutions({ includeSaved: false });
  const enrollment = useWorkspace((state) => state.newSchoolEnrollment());
  return (
    <section
      data-testid="add-institution"
      className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4"
    >
      <h3 className="text-title">Add institution</h3>
      <AddressField
        institutions={institutions}
        placeholder={
          enrollment?.kind === "paste-token"
            ? `Type the address you sign in at, like ${enrollment.addressPlaceholder}`
            : "Type the address you sign in at"
        }
      />
      <InstitutionList institutions={institutions} className="bg-background" />
    </section>
  );
}

function ConnectionsSection() {
  const schools = useWorkspace((state) => state.schools);
  return (
    <SettingsSection
      title="Connections"
      description={`Each school's token stays in ${VAULT_PLACE} and is never shown again. Nothing reaches a school until you approve it.`}
    >
      <div className="flex flex-col gap-3">
        {schools.map((school) => (
          <ConnectionCard key={school.id} school={school} />
        ))}
        <AddInstitution />
      </div>
    </SettingsSection>
  );
}

const BODY: Readonly<Record<SettingsSectionId, () => React.JSX.Element>> = {
  connections: ConnectionsSection,
  ai: AiSection,
  privacy: PrivacySection,
  appearance: AppearanceSection,
  demo: DemoSection,
};

export function SettingsScreen() {
  const sections = settingsSections(useWorkspace((state) => state.schools));
  const section = parseSettingsSection(useSearch({ strict: false }), sections);
  const Body = BODY[section];
  const nav = useRef<HTMLElement>(null);
  // Back and Forward change the section without a click, so focus in the list follows the section on screen.
  useEffect(() => {
    if (nav.current?.contains(document.activeElement))
      nav.current.querySelector<HTMLElement>(`[data-section="${section}"]`)?.focus();
  }, [section]);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ScreenHeader icon={SCREEN_ICON.settings} title="Settings" />
      <div className="flex min-h-0 flex-1">
        <nav
          ref={nav}
          data-testid="settings-nav"
          aria-label="Settings sections"
          className="flex w-40 flex-none flex-col gap-0.5 border-r border-border p-2 max-xl:w-32"
        >
          {sections.map(({ id, label }) => {
            const Icon = ICONS[id];
            return (
              <Link
                key={id}
                data-section={id}
                to="/settings"
                search={id === "connections" ? {} : { section: id }}
                activeOptions={{ exact: true }}
                className={cn(
                  "flex h-btn-sm items-center gap-2 rounded-md px-2 text-body text-secondary-label hover:bg-accent hover:text-foreground",
                  id === section && "row-selected",
                )}
              >
                <Icon className="size-3.5 flex-none text-muted-foreground" />
                {label}
              </Link>
            );
          })}
        </nav>
        <div data-testid="settings-body" className="min-w-0 flex-1 overflow-y-auto">
          <div className="w-full max-w-settings p-6">
            <Body />
          </div>
        </div>
      </div>
    </div>
  );
}
