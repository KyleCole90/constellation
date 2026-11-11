// Before first paint, so a theme chosen in Settings never flashes the OS one. src/renderer/lib/theme.ts writes this key and sets the same two values.
// A file, not an inline script, because the desktop app's CSP allows no inline script.
{
  const theme = localStorage.getItem("constellation.theme");
  if (theme === "light" || theme === "dark") {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
  }
}
