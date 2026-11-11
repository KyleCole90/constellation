import { cn } from "~/renderer/lib/utils";
import { THEMES, setTheme, themeAfterKey, useTheme } from "~/renderer/lib/theme";

import { TAB, toggleState } from "../ui/toggle";
import { SettingsCard, SettingsRow, SettingsSection } from "./layout";

export function AppearanceSection() {
  const theme = useTheme();
  return (
    <SettingsSection title="Appearance">
      <SettingsCard>
        <SettingsRow
          title="Theme"
          description="System follows this computer's light or dark setting. The choice applies to this browser."
          control={
            <div
              role="radiogroup"
              aria-label="Theme"
              className="flex gap-0.5"
              onKeyDown={(event) => {
                const next = themeAfterKey(theme, event.key);
                if (!next) return;
                event.preventDefault();
                setTheme(next);
                event.currentTarget
                  .querySelector<HTMLElement>(`[data-theme-choice="${next}"]`)
                  ?.focus();
              }}
            >
              {THEMES.map(({ id, label }) => (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  data-theme-choice={id}
                  aria-checked={theme === id}
                  tabIndex={theme === id ? 0 : -1}
                  onClick={() => setTheme(id)}
                  className={cn(TAB, toggleState(theme === id))}
                >
                  {label}
                </button>
              ))}
            </div>
          }
        />
      </SettingsCard>
    </SettingsSection>
  );
}
