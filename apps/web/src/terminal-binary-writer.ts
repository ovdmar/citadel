import type { Terminal } from "@xterm/xterm";

export async function writeTerminalBinary(data: unknown, terminal: Terminal): Promise<void> {
  if (data instanceof ArrayBuffer) {
    terminal.write(new Uint8Array(data));
    return;
  }
  if (ArrayBuffer.isView(data)) {
    terminal.write(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    return;
  }
  if (data instanceof Blob) {
    terminal.write(new Uint8Array(await data.arrayBuffer()));
  }
}
