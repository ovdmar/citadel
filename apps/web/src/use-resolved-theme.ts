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
    const update = () => setTheme(readResolvedTheme());

    // Re-read once on mount in case data-theme was set between the
    // initial useState read and this effect (e.g. ThemeControls's own
    // useEffect ran in between). MutationObserver only fires on FUTURE
    // mutations, so without this re-read the component would stay on
    // whatever stale value first render captured.
    update();

    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", update);

    return () => {
      observer.disconnect();
      media.removeEventListener("change", update);
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
