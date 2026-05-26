// Citadel macOS satellite — Electron main process.
//
// Registers two global shortcuts:
//   ⌘⇧S  → open the daemon's /quick-capture page in a frameless, always-on-top
//           BrowserWindow sized like Spotlight. Same window is re-shown on
//           subsequent presses (toggle-like UX).
//   ⌘⇧N  → open the cockpit at /?modal=new-workspace in the user's default
//           browser. The cockpit auto-opens the Create Workspace modal.
//
// Talks to the local daemon over HTTP — same surface as scripts/mac-satellite/
// shell helpers, no new endpoints. The shell helpers remain as a no-Electron
// fallback for users who prefer Hammerspoon or Shortcuts.app.

import { BrowserWindow, Notification, app, globalShortcut, screen, shell } from "electron";
import { type DaemonTarget, QUICK_CAPTURE_WINDOW, centerOnDisplay, resolveDaemonTarget } from "./config.js";

const QUICK_CAPTURE_ACCELERATOR = "CommandOrControl+Shift+S";
const NEW_WORKSPACE_ACCELERATOR = "CommandOrControl+Shift+N";

// Single instance — re-launching the app brings the existing one to the
// foreground rather than spawning a second copy. macOS-standard behavior.
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

// Run as a background utility (LSUIElement-style) — no Dock icon, no menu bar
// item. The app exists to host the global shortcuts; the user shouldn't see a
// permanent presence in the Dock.
if (process.platform === "darwin" && app.dock) {
  app.dock.hide();
}

let quickCaptureWindow: BrowserWindow | null = null;

function liveTarget(): DaemonTarget {
  // Re-read on every shortcut so the env override applies if the user
  // restarts the app with new CITADEL_HOST / CITADEL_PORT values.
  return resolveDaemonTarget(process.env);
}

function showFallbackNotification(title: string, body: string): void {
  if (Notification.isSupported()) {
    new Notification({ title, body }).show();
  } else {
    console.error(`${title}: ${body}`);
  }
}

async function probeDaemon(target: DaemonTarget): Promise<boolean> {
  // Liveness probe — match the shell helper's behavior (2s max). We don't care
  // about the response body; any 2xx/4xx means a daemon is answering.
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    try {
      const response = await fetch(target.livenessUrl, { signal: controller.signal });
      return response.ok || response.status >= 400;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}

function buildQuickCaptureWindow(target: DaemonTarget): BrowserWindow {
  const primary = screen.getPrimaryDisplay();
  const bounds = centerOnDisplay(primary, QUICK_CAPTURE_WINDOW);
  const win = new BrowserWindow({
    ...bounds,
    frame: false,
    titleBarStyle: "hidden",
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    backgroundColor: "#0b101a",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // alwaysOnTop with visible-on-all-workspaces gives the Spotlight feel — the
  // window appears over fullscreen apps without forcing a Space switch.
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // Closing the page from inside (window.close() after a successful capture)
  // emits 'closed'; clear our ref so the next shortcut press builds a fresh
  // window with re-resolved daemon target.
  win.on("closed", () => {
    if (quickCaptureWindow === win) quickCaptureWindow = null;
  });
  // Esc closes the popup. The /quick-capture page also calls window.close()
  // on Esc, but a top-level shortcut is more reliable across focus states.
  win.webContents.on("before-input-event", (event, input) => {
    if (input.type === "keyDown" && input.key === "Escape") {
      event.preventDefault();
      win.close();
    }
  });
  void win.loadURL(target.quickCaptureUrl);
  win.once("ready-to-show", () => {
    win.show();
    win.focus();
  });
  return win;
}

async function handleQuickCapture(): Promise<void> {
  const target = liveTarget();
  if (!(await probeDaemon(target))) {
    showFallbackNotification(
      "Citadel Quick Capture",
      `Daemon not reachable at ${target.host}:${target.port}. Set CITADEL_HOST / CITADEL_PORT if needed.`,
    );
    return;
  }
  // Toggle: if a popup already exists and is focused, close it instead of
  // stacking duplicates. Matches Spotlight's ⌘Space behavior.
  if (quickCaptureWindow && !quickCaptureWindow.isDestroyed()) {
    if (quickCaptureWindow.isFocused()) {
      quickCaptureWindow.close();
      return;
    }
    quickCaptureWindow.show();
    quickCaptureWindow.focus();
    return;
  }
  quickCaptureWindow = buildQuickCaptureWindow(target);
}

async function handleNewWorkspace(): Promise<void> {
  const target = liveTarget();
  if (!(await probeDaemon(target))) {
    showFallbackNotification("Citadel New Workspace", `Daemon not reachable at ${target.host}:${target.port}.`);
    return;
  }
  // Open in the user's default browser — they likely have a pinned cockpit
  // tab. The cockpit's ?modal=new-workspace deeplink auto-opens the modal.
  void shell.openExternal(target.newWorkspaceUrl);
}

app.whenReady().then(() => {
  const captureOk = globalShortcut.register(QUICK_CAPTURE_ACCELERATOR, () => {
    void handleQuickCapture();
  });
  const workspaceOk = globalShortcut.register(NEW_WORKSPACE_ACCELERATOR, () => {
    void handleNewWorkspace();
  });
  if (!captureOk || !workspaceOk) {
    // Another app (or a stale instance) holds the shortcut. Surface to the
    // user instead of silently failing — they can rebind in System Settings.
    showFallbackNotification(
      "Citadel Mac Satellite",
      "Could not register global shortcuts (⌘⇧S / ⌘⇧N). Another app may have claimed them.",
    );
  }
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});

// macOS apps stay running with no windows. The whole point of this app is
// the global shortcut, so do NOT quit on window-all-closed.
app.on("window-all-closed", () => {
  // no-op on macOS — keep running for the shortcut
  if (process.platform !== "darwin") app.quit();
});
