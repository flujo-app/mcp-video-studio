import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StudioException } from "@mcp-video-studio/core";

export interface ProcessResult {
  executable: string;
  args: string[];
  exitCode: number;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  durationMs: number;
}

export interface ProcessOptions {
  cwd?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
  maxOutputChars?: number | undefined;
  stdin?: NodeJS.ReadableStream | undefined;
  onProgress?: ((progress: Record<string, string>) => void) | undefined;
}

class BoundedText {
  private value = "";
  truncated = false;
  constructor(private readonly max: number) {}
  append(chunk: string): void {
    this.value += chunk;
    if (this.value.length > this.max) {
      const half = Math.floor(this.max / 2);
      this.value = `${this.value.slice(0, half)}\n... output truncated ...\n${this.value.slice(-half)}`;
      this.truncated = true;
    }
  }
  toString(): string { return this.value; }
}

function stopProcess(child: ChildProcessWithoutNullStreams): void {
  if (child.exitCode !== null || child.killed) return;
  if (process.platform === "win32" && child.pid) {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", shell: false });
    killer.once("error", () => child.kill("SIGKILL"));
  } else {
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 2_000);
    timer.unref();
  }
}

export async function runProcess(executable: string, args: string[], options: ProcessOptions = {}): Promise<ProcessResult> {
  if (!executable.trim()) throw new StudioException("INVALID_EXECUTABLE", "Executable cannot be empty.", "input");
  const started = Date.now();
  const max = options.maxOutputChars ?? 200_000;
  const stdout = new BoundedText(max);
  const stderr = new BoundedText(max);
  const child: ChildProcessWithoutNullStreams = spawn(executable, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    windowsHide: true,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"]
  });

  let progress: Record<string, string> = {};
  let progressBuffer = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => stdout.append(chunk));
  child.stderr.on("data", (chunk: string) => {
    stderr.append(chunk);
    if (options.onProgress) {
      progressBuffer += chunk;
      const lines = progressBuffer.split(/\r?\n/);
      progressBuffer = lines.pop() ?? "";
      for (const line of lines) {
        const separator = line.indexOf("=");
        if (separator <= 0) continue;
        progress[line.slice(0, separator)] = line.slice(separator + 1);
        if (line.startsWith("progress=")) {
          options.onProgress(progress);
          progress = {};
        }
      }
    }
  });

  if (options.stdin) options.stdin.pipe(child.stdin);
  else child.stdin.end();
  const abort = () => stopProcess(child);
  options.signal?.addEventListener("abort", abort, { once: true });
  const timeout = options.timeoutMs && options.timeoutMs > 0 ? setTimeout(() => stopProcess(child), options.timeoutMs) : undefined;
  timeout?.unref();

  try {
    const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    if (options.signal?.aborted) throw new StudioException("CANCELLED", "Process was cancelled.", "runtime");
    return {
      executable, args: [...args], exitCode: outcome.code ?? -1, signal: outcome.signal,
      stdout: stdout.toString(), stderr: stderr.toString(), truncated: stdout.truncated || stderr.truncated,
      durationMs: Date.now() - started
    };
  } finally {
    if (timeout) clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abort);
  }
}

export async function runChecked(executable: string, args: string[], options: ProcessOptions = {}): Promise<ProcessResult> {
  const result = await runProcess(executable, args, options);
  if (result.exitCode !== 0) throw new StudioException("PROCESS_FAILED", `${executable} exited with ${result.exitCode}.`, "runtime", { executable, args, exitCode: result.exitCode, stderr: result.stderr, truncated: result.truncated });
  return result;
}
