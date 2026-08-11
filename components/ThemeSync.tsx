"use client";

import { useEffect } from "react";
import {
  applyTheme,
  readStoredTheme,
  readSystemTheme,
  THEME_CHANGE_EVENT,
} from "@/lib/theme";

/**
 * Follows the OS color-scheme live — but only while the user hasn't made an
 * explicit choice. Once localStorage holds a preference, OS changes are
 * ignored: the stored choice wins until the user clears it (the toggle never
 * clears it — an explicit click permanently opts out of OS-following).
 *
 * Emits THEME_CHANGE_EVENT so UI like the masthead toggle can react without
 * re-reading the DOM itself. Renders nothing.
 */
export default function ThemeSync() {
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");

    function applyFromSystem() {
      if (readStoredTheme()) return; // explicit user choice outranks the OS
      const theme = readSystemTheme();
      applyTheme(theme);
      window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT, { detail: theme }));
    }

    applyFromSystem(); // align on mount too (e.g. icon state after load)
    media.addEventListener("change", applyFromSystem);
    return () => media.removeEventListener("change", applyFromSystem);
  }, []);

  return null;
}
