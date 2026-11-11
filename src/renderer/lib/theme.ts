import { useSyncExternalStore } from "react";

export const THEMES = [
  { id: "system", label: "System" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
] as const;

export type Theme = (typeof THEMES)[number]["id"];

/** public/theme.js reads the same key before first paint, so a chosen theme never flashes the OS one. */
const KEY = "constellation.theme";
const listeners = new Set<() => void>();

const read = (): Theme => THEMES.find(({ id }) => id === localStorage.getItem(KEY))?.id ?? "system";

/** The root's color-scheme picks every light-dark() token in index.css, and without a choice it follows the OS. The built CSS reads it only from the data-theme rule, and dev paints before that rule loads, so both are set. */
export const setTheme = (theme: Theme): void => {
  if (theme === "system") {
    localStorage.removeItem(KEY);
    delete document.documentElement.dataset.theme;
    document.documentElement.style.colorScheme = "";
  } else {
    localStorage.setItem(KEY, theme);
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
  }
  for (const listener of listeners) listener();
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const useTheme = (): Theme => useSyncExternalStore(subscribe, read);

/** The theme an arrow key moves to from `theme`, wrapping at either end the way a radio group does, or null for any other key. */
export const themeAfterKey = (theme: Theme, key: string): Theme | null => {
  const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[key];
  if (!step) return null;
  const at = THEMES.findIndex(({ id }) => id === theme);
  return THEMES[(at + step + THEMES.length) % THEMES.length]?.id ?? null;
};
