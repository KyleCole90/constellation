import { describe, expect, it } from "vite-plus/test";

import type { SchoolHost, SchoolId } from "~/shared/domain/ids";
import type { School } from "~/shared/domain/lms";

import { parseSettingsSection, settingsSections } from "./sections.logic";

const school = (provider: School["provider"]): School => ({
  id: `${provider}-school` as SchoolId,
  abbr: "S",
  name: provider,
  host: `${provider}.example.edu` as SchoolHost,
  provider,
});

const ids = (schools: readonly School[]) => settingsSections(schools).map((section) => section.id);

describe("settings sections", () => {
  it("hides the Demo section when only a real school is connected", () => {
    expect(ids([school("canvas")])).not.toContain("demo");
  });

  it("shows the Demo section while a demo school exists", () => {
    expect(ids([school("canvas"), school("fake-canvas")])).toContain("demo");
  });

  it("opens Connections for a Demo link when there is no demo school", () => {
    const sections = settingsSections([school("canvas")]);
    expect(parseSettingsSection({ section: "demo" }, sections)).toBe("connections");
    expect(parseSettingsSection({ section: "appearance" }, sections)).toBe("appearance");
  });
});
