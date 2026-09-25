import { isElementVoiceVisible } from "./lib/voice-targets.js";

export type TerminalHandle = {
  reload: () => void;
  // Historical name kept for Stage callers; now focuses the in-process xterm.
  focusIframe: () => void;
  recoverIfDisconnected: () => boolean;
  sendVoiceInput: (text: string, options: { submit: boolean }) => boolean;
  canAcceptVoiceInput: () => boolean;
};

const REGISTRY = new Map<string, TerminalHandle>();
const HOST_REGISTRY = new Map<string, HTMLElement>();
const LISTENERS = new Set<(id: string) => void>();
let defaultVoiceTerminalSessionId: string | null = null;

export function publishTerminalHandle(id: string, handle: TerminalHandle | null) {
  if (handle) {
    REGISTRY.set(id, handle);
  } else {
    REGISTRY.delete(id);
  }
  for (const listener of LISTENERS) listener(id);
}

export function registerTerminalHost(sessionId: string, host: HTMLElement): () => void {
  HOST_REGISTRY.set(sessionId, host);
  return () => {
    if (HOST_REGISTRY.get(sessionId) === host) HOST_REGISTRY.delete(sessionId);
  };
}

export function getTerminalHandle(sessionId: string): TerminalHandle | undefined {
  return REGISTRY.get(sessionId);
}

export function getFocusedTerminalSessionId(activeElement: Element | null = document.activeElement): string | null {
  if (!(activeElement instanceof HTMLElement)) return null;
  for (const [sessionId, host] of HOST_REGISTRY) {
    if (!host.isConnected) continue;
    if (!isElementVoiceVisible(host)) continue;
    if (host === activeElement || host.contains(activeElement)) return sessionId;
  }
  return null;
}

export function setDefaultVoiceTerminalSession(sessionId: string | null | undefined): void {
  defaultVoiceTerminalSessionId = sessionId ?? null;
}

export function getDefaultVoiceTerminalSessionId(): string | null {
  if (!defaultVoiceTerminalSessionId) return null;
  return REGISTRY.has(defaultVoiceTerminalSessionId) ? defaultVoiceTerminalSessionId : null;
}

export function subscribeTerminalHandle(listener: (sessionId: string) => void): () => void {
  LISTENERS.add(listener);
  return () => LISTENERS.delete(listener);
}

export function isRegisteredTerminalMessageSource(
  _source: MessageEventSource | null,
  sessionId: string | null | undefined,
): boolean {
  return Boolean(sessionId && REGISTRY.has(sessionId));
}

// Focus the terminal of an active session. No-op when:
//   - sessionId is null/undefined (workspace has no active session)
//   - no handle is registered (session not yet mounted)
//   - document.activeElement is a text input or contenteditable (don't steal
//     focus while the user is typing, such as inline workspace-title rename).
export function focusActiveTerminal(sessionId: string | null | undefined): void {
  if (!sessionId) return;
  const handle = REGISTRY.get(sessionId);
  if (!handle) return;
  const active = typeof document !== "undefined" ? document.activeElement : null;
  if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return;
  if (active instanceof HTMLElement && active.isContentEditable) return;
  handle.focusIframe();
}
