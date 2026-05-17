import { spawn } from "node:child_process";

export type CommandHook = {
  id: string;
  event: string;
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  blocking: boolean;
};

export async function runCommandHook(hook: CommandHook, payload: unknown) {
  const input = JSON.stringify(payload);
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(hook.command, hook.args, { cwd: hook.cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Hook timed out after ${hook.timeoutMs}ms`));
    }, hook.timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout = `${stdout}${chunk.toString()}`.slice(-65536);
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-65536);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`Hook exited with ${code}: ${stderr || stdout}`));
    });
    child.stdin.end(input);
  });
}
