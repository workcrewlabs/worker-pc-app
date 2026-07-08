// Appearance (dark or light). The choice is stored per device and stamped onto
// the root element as data-theme, which the light block in styles.css keys on.
// applyStoredTheme runs before the first React render so the app never flashes
// the wrong palette on startup.

export type Theme = "dark" | "light";

const THEME_KEY = "workcrew.theme";

export function getTheme(): Theme {
  try {
    return localStorage.getItem(THEME_KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

export function setTheme(theme: Theme): void {
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Storage unavailable: the theme still applies for this session.
  }
  applyTheme(theme);
}

function applyTheme(theme: Theme): void {
  if (theme === "light") document.documentElement.dataset.theme = "light";
  else delete document.documentElement.dataset.theme;
}

export function applyStoredTheme(): void {
  applyTheme(getTheme());
}
