import { useEffect, useState } from "react";

export type ResolvedTheme = "light" | "dark";

/**
 * Resolves Citadel's effective theme by reading `data-theme` on <html>
 * (set by ThemeControls) and falling back to the system preference.
 * Re-renders when either source changes.
 */
export function useResolvedTheme(): ResolvedTheme {
  const [theme, setTheme] = useState<ResolvedTheme>(() => readResolvedTheme());

  useEffect(() => {
    const unsubscribe = subscribeResolvedTheme(setTheme);
    // Re-read once on mount in case data-theme was set between the
    // initial useState read and this effect (e.g. ThemeControls's own
    // useEffect ran in between).
    setTheme(readResolvedTheme());
    return unsubscribe;
  }, []);

  return theme;
}

/**
 * Subscribe to resolved-theme changes. Combines the `<html data-theme>`
 * MutationObserver path with the `matchMedia("(prefers-color-scheme: dark)")`
 * change event, and **dedupes by the last emitted resolved value** — only
 * invokes the callback when the resolved theme actually changes.
 *
 * Without dedupe a single user toggle can fire the callback twice: once for
 * the `data-theme` attribute write, once if matchMedia re-evaluates. The
 * live-re-theme orchestrator relies on the dedupe to avoid kicking off
 * concurrent respawn loops for the same logical change.
 */
export function subscribeResolvedTheme(callback: (theme: ResolvedTheme) => void): () => void {
  if (typeof document === "undefined" || typeof window === "undefined") {
    return () => {
      // no-op cleanup on SSR / non-DOM environments
    };
  }
  // Seed lastEmitted with the current resolved value so a fire that doesn't
  // actually change the theme (e.g. MutationObserver on a no-op attr write,
  // matchMedia change that doesn't flip the resolved bit because data-theme
  // is set explicitly) does NOT invoke the callback. Only true changes emit.
  let lastEmitted: ResolvedTheme = readResolvedTheme();
  const emit = () => {
    const next = readResolvedTheme();
    if (next === lastEmitted) return;
    lastEmitted = next;
    callback(next);
  };

  const observer = new MutationObserver(emit);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

  const media = window.matchMedia("(prefers-color-scheme: dark)");
  media.addEventListener("change", emit);

  return () => {
    observer.disconnect();
    media.removeEventListener("change", emit);
  };
}

export function readResolvedTheme(): ResolvedTheme {
  if (typeof document === "undefined" || typeof window === "undefined") return "dark";
  const preference = document.documentElement.dataset.theme;
  if (preference === "light") return "light";
  if (preference === "dark") return "dark";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
