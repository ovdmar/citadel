import { useEffect, useState } from "react";

export type ResolvedTheme = "light" | "dark";
export type ThemePreference = ResolvedTheme | "system";

const THEME_STORAGE_KEY = "citadel.theme";
const THEME_CHANGE_EVENT = "citadel-theme-preference-change";

export function readThemePreference(): ThemePreference {
  if (typeof window === "undefined") return "system";
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return stored === "light" || stored === "dark" || stored === "system" ? stored : "system";
  } catch {
    return "system";
  }
}

export function applyThemePreference(preference: ThemePreference): void {
  if (typeof document === "undefined" || typeof window === "undefined") return;
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // localStorage is best-effort; data-theme is the live source of truth.
  }
  if (preference === "system") {
    delete document.documentElement.dataset.theme;
  } else {
    document.documentElement.dataset.theme = preference;
  }
  window.dispatchEvent(new Event(THEME_CHANGE_EVENT));
}

/**
 * Resolves Citadel's effective theme by reading `data-theme` on <html>
 * (set by ThemeControls) and falling back to the system preference.
 * Re-renders when either source changes.
 */
export function useResolvedTheme(): ResolvedTheme {
  const [theme, setTheme] = useState<ResolvedTheme>(() => readResolvedTheme());

  useEffect(() => {
    const update = () => setTheme(readResolvedTheme());

    // Re-read once on mount in case data-theme was set between the
    // initial useState read and this effect (e.g. ThemeControls's own
    // useEffect ran in between). MutationObserver only fires on FUTURE
    // mutations, so without this re-read the component would stay on
    // whatever stale value first render captured.
    update();

    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    window.addEventListener(THEME_CHANGE_EVENT, update);

    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", update);

    const onStorage = (event: StorageEvent) => {
      if (event.key !== null && event.key !== THEME_STORAGE_KEY) return;
      applyThemePreference(readThemePreference());
      update();
    };
    window.addEventListener("storage", onStorage);

    return () => {
      observer.disconnect();
      window.removeEventListener(THEME_CHANGE_EVENT, update);
      media.removeEventListener("change", update);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  return theme;
}

function readResolvedTheme(): ResolvedTheme {
  if (typeof document === "undefined" || typeof window === "undefined") return "dark";
  const preference = document.documentElement.dataset.theme;
  if (preference === "light") return "light";
  if (preference === "dark") return "dark";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
