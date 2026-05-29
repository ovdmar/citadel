import type { DiagnosticsLogger } from "@citadel/operations";
import type { Response } from "express";

export function attachSseClientErrorHandler(
  client: Response,
  detachClient: (client: Response) => void,
  diagnostics: Pick<DiagnosticsLogger, "log">,
) {
  client.on("error", (error) => {
    detachClient(client);
    diagnostics.log("daemon", "sse.client_error", { message: error instanceof Error ? error.message : String(error) });
  });
}

export function writeSseEvent(
  clients: Set<Response>,
  type: string,
  event: unknown,
  detachClient: (client: Response) => void,
  diagnostics: Pick<DiagnosticsLogger, "log">,
) {
  const data = `event: ${type}\ndata: ${JSON.stringify(event)}\n\n`;
  for (const client of [...clients]) {
    if (client.destroyed || client.writableEnded) {
      detachClient(client);
      continue;
    }
    try {
      client.write(data);
    } catch (error) {
      detachClient(client);
      diagnostics.log("daemon", "sse.write_failed", {
        type,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
