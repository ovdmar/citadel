import fs from "node:fs";

/**
 * Shared cap for /log endpoints (HTTP route + MCP tool). Mirrors the
 * read_agent_output style: 200 KiB max per call, 16 KiB default, 256-byte
 * floor. Keeping these as constants prevents the HTTP and MCP transports
 * from silently disagreeing on the cap.
 */
export const LOG_SLICE_MAX_BYTES = 200 * 1024;
export const LOG_SLICE_DEFAULT_BYTES = 16 * 1024;
export const LOG_SLICE_MIN_BYTES = 256;

export type LogSliceResult = {
  content: string;
  bytesRead: number;
  nextOffset: number;
  truncated: boolean;
};

export type LogSliceError = { kind: "missing" };

/**
 * Read a byte slice of a log file with consistent bounds + UTF-8 conversion.
 * Returns `{kind: "missing"}` on ENOENT; rethrows other fs errors so the
 * caller (HTTP / MCP transport) can surface them rather than silently
 * coercing them all into "missing".
 */
export function readLogSlice(
  filePath: string,
  options: { offset?: number; maxBytes?: number },
): LogSliceResult | LogSliceError {
  const offset = Math.max(0, options.offset ?? 0);
  const maxBytes = Math.max(
    LOG_SLICE_MIN_BYTES,
    Math.min(options.maxBytes ?? LOG_SLICE_DEFAULT_BYTES, LOG_SLICE_MAX_BYTES),
  );
  let fd: number;
  try {
    fd = fs.openSync(filePath, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { kind: "missing" };
    throw error;
  }
  try {
    const stat = fs.fstatSync(fd);
    const start = Math.min(offset, stat.size);
    const length = Math.min(maxBytes, Math.max(0, stat.size - start));
    const buffer = Buffer.alloc(length);
    const bytesRead = length > 0 ? fs.readSync(fd, buffer, 0, length, start) : 0;
    return {
      content: buffer.subarray(0, bytesRead).toString("utf8"),
      bytesRead,
      nextOffset: start + bytesRead,
      truncated: start + bytesRead < stat.size,
    };
  } finally {
    fs.closeSync(fd);
  }
}
