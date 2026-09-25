import type { WorkspaceSession } from "@citadel/contracts";
import { useCallback, useEffect, useMemo, useState } from "react";
import { sessionAttentionFingerprint } from "./session-status-display.js";

const STORAGE_SESSION_ATTENTION_ACK = "citadel.session-attention-ack";

export function useSessionAttentionAcknowledgement(
  allSessions: WorkspaceSession[],
  activeSession: WorkspaceSession | null,
) {
  const [attentionAckBySession, setAttentionAckBySession] = useLocalStorageRecord(STORAGE_SESSION_ATTENTION_ACK);
  const unseenAttentionSessionIds = useMemo(() => {
    const ids = new Set<string>();
    for (const session of allSessions) {
      const fingerprint = sessionAttentionFingerprint(session);
      if (fingerprint && attentionAckBySession[session.id] !== fingerprint) ids.add(session.id);
    }
    return ids;
  }, [allSessions, attentionAckBySession]);
  const acknowledgeSessionAttention = useCallback(
    (session: WorkspaceSession | null | undefined) => {
      if (!session) return;
      const fingerprint = sessionAttentionFingerprint(session);
      if (!fingerprint) return;
      setAttentionAckBySession((current) => {
        if (current[session.id] === fingerprint) return current;
        return { ...current, [session.id]: fingerprint };
      });
    },
    [setAttentionAckBySession],
  );

  useEffect(() => {
    const liveIds = new Set(allSessions.map((session) => session.id));
    setAttentionAckBySession((current) => {
      let changed = false;
      const next: Record<string, string> = {};
      for (const [sessionId, fingerprint] of Object.entries(current)) {
        if (liveIds.has(sessionId)) next[sessionId] = fingerprint;
        else changed = true;
      }
      return changed ? next : current;
    });
  }, [allSessions, setAttentionAckBySession]);

  useEffect(() => {
    acknowledgeSessionAttention(activeSession);
  }, [
    activeSession,
    activeSession?.exitCode,
    activeSession?.lastStatusAt,
    activeSession?.status,
    activeSession?.statusReason,
    activeSession?.statusReasonAt,
    acknowledgeSessionAttention,
  ]);

  return { acknowledgeSessionAttention, unseenAttentionSessionIds };
}

function useLocalStorageRecord(key: string) {
  const [value, setValue] = useState<Record<string, string>>(() => {
    if (typeof window === "undefined") return {};
    try {
      return JSON.parse(window.localStorage.getItem(key) || "{}") as Record<string, string>;
    } catch {
      return {};
    }
  });
  useEffect(() => {
    if (typeof window !== "undefined") window.localStorage.setItem(key, JSON.stringify(value));
  }, [key, value]);
  return [value, setValue] as const;
}
