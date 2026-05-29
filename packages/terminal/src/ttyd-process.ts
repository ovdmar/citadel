import { execFileSync } from "node:child_process";
import net from "node:net";
import { TtydUnavailableError } from "./ttyd-types.js";

export function binaryExists(absolutePath: string) {
  try {
    execFileSync(absolutePath, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function portOpen(port: number) {
  return new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let settled = false;
    const finish = (alive: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(alive);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(500, () => finish(false));
  });
}

export async function reserveFreePort(base: number, max: number, reserved: Set<number>) {
  const occupied = listListeningPortsInRange(base, max);
  for (let port = base; port <= max; port += 1) {
    if (reserved.has(port)) continue;
    if (occupied.has(port)) continue;
    if (await portOpen(port)) continue;
    reserved.add(port);
    return port;
  }
  throw new TtydUnavailableError("no_free_port", `no free port between ${base} and ${max}`);
}

export async function waitForOwnedPort(port: number, pid: number, timeoutMs: number) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const owner = listeningPidForPort(port);
    if (owner === pid) return true;
    if (owner === undefined && (await portOpen(port))) return true;
    if (pid > 0 && !processAlive(pid)) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

function processAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function listeningPidForPort(port: number): number | null | undefined {
  try {
    const output = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const match = /^p(\d+)$/m.exec(output);
    return match ? Number(match[1]) : null;
  } catch (error) {
    const status = (error as { status?: unknown }).status;
    if (status === 1) return null;
    return undefined;
  }
}

function listListeningPortsInRange(portBase: number, portMax: number): Set<number> {
  const ports = new Set<number>();
  let lsofOutput = "";
  try {
    lsofOutput = execFileSync("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return ports;
  }
  for (const line of lsofOutput.split("\n")) {
    const match = /TCP .*:(\d+) \(LISTEN\)/.exec(line);
    if (!match) continue;
    const port = Number(match[1]);
    if (port >= portBase && port <= portMax) ports.add(port);
  }
  return ports;
}

export function listListeningTtydsInRange(portBase: number, portMax: number): Map<number, number> {
  const pidPort = new Map<number, number>();
  let lsofOutput = "";
  try {
    lsofOutput = execFileSync("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return pidPort;
  }
  for (const line of lsofOutput.split("\n")) {
    if (!line.includes("ttyd")) continue;
    const parts = line.trim().split(/\s+/);
    if (parts.length < 9) continue;
    const pid = Number(parts[1]);
    const name = parts[0];
    const address = parts[8] ?? "";
    const portMatch = /:(\d+)$/.exec(address);
    const port = portMatch ? Number(portMatch[1]) : Number.NaN;
    if (name === "ttyd" && Number.isFinite(pid) && port >= portBase && port <= portMax) pidPort.set(pid, port);
  }
  return pidPort;
}

export function killStaleTtydInRange(portBase: number, portMax: number) {
  const pids = new Set(listListeningTtydsInRange(portBase, portMax).keys());
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // ignore
    }
  }
  return pids.size;
}
