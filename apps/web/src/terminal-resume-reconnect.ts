export function addTerminalResumeReconnectListeners(listener: () => void): () => void {
  document.addEventListener("visibilitychange", listener);
  document.addEventListener("resume", listener);
  window.addEventListener("pageshow", listener);
  window.addEventListener("online", listener);
  return () => {
    document.removeEventListener("visibilitychange", listener);
    document.removeEventListener("resume", listener);
    window.removeEventListener("pageshow", listener);
    window.removeEventListener("online", listener);
  };
}
