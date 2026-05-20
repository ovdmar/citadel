import { useCallback, useEffect, useState } from "react";

type LayoutState = {
  leftWidth: number;
  rightWidth: number;
  leftCollapsed: boolean;
  rightCollapsed: boolean;
};

const STORAGE_KEY = "citadel.cockpit-layout";
const MIN_LEFT = 220;
const MAX_LEFT = 480;
const MIN_RIGHT = 240;
const MAX_RIGHT = 520;
const DEFAULT: LayoutState = {
  leftWidth: 280,
  rightWidth: 320,
  leftCollapsed: false,
  rightCollapsed: false,
};

export function useCockpitLayout() {
  const [state, setState] = useState<LayoutState>(() => {
    if (typeof window === "undefined") return DEFAULT;
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return DEFAULT;
      const parsed = JSON.parse(raw) as Partial<LayoutState>;
      return {
        leftWidth: clamp(parsed.leftWidth ?? DEFAULT.leftWidth, MIN_LEFT, MAX_LEFT),
        rightWidth: clamp(parsed.rightWidth ?? DEFAULT.rightWidth, MIN_RIGHT, MAX_RIGHT),
        leftCollapsed: Boolean(parsed.leftCollapsed),
        rightCollapsed: Boolean(parsed.rightCollapsed),
      };
    } catch {
      return DEFAULT;
    }
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }, [state]);

  const setLeftWidth = useCallback(
    (next: number) => setState((current) => ({ ...current, leftWidth: clamp(next, MIN_LEFT, MAX_LEFT) })),
    [],
  );
  const setRightWidth = useCallback(
    (next: number) => setState((current) => ({ ...current, rightWidth: clamp(next, MIN_RIGHT, MAX_RIGHT) })),
    [],
  );
  const toggleLeft = useCallback(
    () => setState((current) => ({ ...current, leftCollapsed: !current.leftCollapsed })),
    [],
  );
  const toggleRight = useCallback(
    () => setState((current) => ({ ...current, rightCollapsed: !current.rightCollapsed })),
    [],
  );

  return { state, setLeftWidth, setRightWidth, toggleLeft, toggleRight };
}

export function startColumnDrag(args: {
  side: "left" | "right";
  onChange: (next: number) => void;
  initial: number;
}) {
  const startX = args.initial;
  return (event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    const origin = event.clientX;
    const startWidth = startX;
    const move = (moveEvent: MouseEvent) => {
      const delta = moveEvent.clientX - origin;
      const next = args.side === "left" ? startWidth + delta : startWidth - delta;
      args.onChange(next);
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}
