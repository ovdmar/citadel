import type { SqliteStore } from "@citadel/db";
import { type TtydManager, discoverExistingTtyds } from "@citadel/terminal";

export function adoptExistingTtyds(input: {
  store: SqliteStore;
  ttyd: TtydManager;
  emit: (type: string, payload: unknown) => void;
}) {
  if (process.env.VITEST) return;

  const { store, ttyd, emit } = input;
  const survivors = discoverExistingTtyds({
    basePathPrefix: ttyd.config.basePathPrefix,
    portBase: ttyd.config.portBase,
    portMax: ttyd.config.portMax,
  });
  const sessionTabIds = new Map<string, string>();
  for (const session of store.listSessions()) {
    sessionTabIds.set(session.id, session.tabId ?? session.id);
  }
  const resolveTabId = (key: string): string | null => sessionTabIds.get(key) ?? null;
  const { adopted, reapedDuplicates, reapedUnknown } = ttyd.adopt(survivors, resolveTabId);
  if (adopted > 0 || reapedDuplicates > 0 || reapedUnknown > 0) {
    emit("terminal.adopted", {
      adopted,
      reapedDuplicates,
      reapedUnknown,
      portRange: [ttyd.config.portBase, ttyd.config.portMax],
    });
  }
}
