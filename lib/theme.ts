/**
 * Shared theme plumbing for the night-edition system.
 * The pre-hydration script in app/layout.tsx owns the first paint; these
 * helpers serve the live (post-hydration) layer: OS-following and the toggle.
 */

export const THEME_KEY = "paperagents-theme";

/** Dispatched whenever the theme is applied for reasons other than a click. */
export const THEME_CHANGE_EVENT = "paperagents:theme-change";

export type Theme = "light" | "dark";

/** The user's explicit choice, or null when they haven't made one. */
export function readStoredTheme(): Theme | null {
  try {
    const value = localStorage.getItem(THEME_KEY);
    return value === "dark" || value === "light" ? value : null;
  } catch {
    return null; // storage unavailable — treat as no explicit choice
  }
}

export function readSystemTheme(): Theme {
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

export function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute("data-theme", theme);
}
