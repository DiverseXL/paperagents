"use client";

import { useEffect, useState } from "react";
import {
  applyTheme,
  THEME_CHANGE_EVENT,
  THEME_KEY,
  type Theme,
} from "@/lib/theme";

/**
 * The inline script in the root layout already set data-theme on <html>
 * before hydration. We read it back after mount rather than in the useState
 * initializer: the initializer would also run during SSR (rendering the sun),
 * then re-run on the client with the real theme — a hydration mismatch when
 * the resolved theme is dark. Theme colors are already correct pre-hydration,
 * so the icon settling one frame after paint is invisible.
 */
export default function ThemeToggle() {
  const [dark, setDark] = useState(false);

  useEffect(() => {
    // One frame after mount: the pre-hydration script already applied the
    // correct colors, so this invisible sync just brings the icon in line.
    // (With a stored preference, ThemeSync does not dispatch on mount, so
    // this read is what sets the icon correctly on first load.)
    const rafId = requestAnimationFrame(() => {
      setDark(document.documentElement.getAttribute("data-theme") === "dark");
    });

    // Follow OS-driven changes applied by ThemeSync (only fires while no
    // stored preference exists, so it never overrides an explicit choice).
    function onThemeChange(event: Event) {
      const theme = (event as CustomEvent<Theme>).detail;
      setDark(theme === "dark");
    }
    window.addEventListener(THEME_CHANGE_EVENT, onThemeChange);

    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener(THEME_CHANGE_EVENT, onThemeChange);
    };
  }, []);

  function toggle() {
    const next: Theme = dark ? "light" : "dark";
    setDark(!dark);
    applyTheme(next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // storage unavailable (private mode) — the attribute still applies
    }
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
      className="hit-area flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-2 border-hairline bg-paper text-ink transition-colors duration-200 hover:border-ink motion-reduce:transition-none"
    >
      <span aria-hidden="true" className="relative block h-4 w-4">
        {/* Sun — geometric disc + rays, shown in the day edition */}
        <svg
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          className={`absolute inset-0 transition-all duration-300 motion-reduce:transition-none ${
            dark ? "rotate-90 scale-50 opacity-0" : "rotate-0 scale-100 opacity-100"
          }`}
        >
          <circle cx="8" cy="8" r="3" />
          <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.8 3.8l1.4 1.4M10.8 10.8l1.4 1.4M12.2 3.8l-1.4 1.4M5.2 10.8l-1.4 1.4" />
        </svg>
        {/* Moon — geometric crescent, shown in the night edition */}
        <svg
          viewBox="0 0 16 16"
          fill="currentColor"
          className={`absolute inset-0 transition-all duration-300 motion-reduce:transition-none ${
            dark ? "rotate-0 scale-100 opacity-100" : "-rotate-90 scale-50 opacity-0"
          }`}
        >
          <path d="M13.6 9.3a5.8 5.8 0 1 1-6.9-6.9 4.7 4.7 0 0 0 6.9 6.9z" />
        </svg>
      </span>
    </button>
  );
}
