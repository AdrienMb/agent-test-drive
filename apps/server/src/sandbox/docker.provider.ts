import { spawn, spawnSync } from "node:child_process";
import type { AgentId } from "@atd/shared";
import { splitLines } from "./line-splitter.js";
import { MAX_LINE_BYTES, parseRunnerLine } from "./runner-protocol.js";
import type { SandboxHandle, SandboxListener, SandboxProvider, SandboxSpec } from "./sandbox.types.js";

const MAX_STDERR_LINE_BYTES = 64 * 1024;

/** Each agent has its own image; override with e.g. RUNNER_IMAGE_CLAUDE. */
function runnerImage(agent: AgentId): string {
  return process.env[`RUNNER_IMAGE_${agent.toUpperCase()}`] ?? `agent-runner-${agent}:latest`;
}

export class DockerSandboxProvider implements SandboxProvider {
  readonly kind = "docker" as const;
  private readonly live = new Set<string>();

  start(spec: SandboxSpec, listener: SandboxListener): SandboxHandle {
    const { name } = spec;
    const args = [
      "run",
      "--rm",
      "-i",
      "--init", // tini as PID 1 so signals actually stop the runner
      "--pull=never", // fail fast if `yarn docker:build` was not run
      "--name",
      name,
      "--memory",
      `${spec.limits.memoryMb}m`,
      "--cpus",
      String(spec.limits.cpus),
      // `-e NAME` without a value reads it from the docker CLI's env, so secrets
      // never appear in the process list.
      ...Object.keys(spec.env).flatMap((key) => ["-e", key]),
      runnerImage(spec.agent),
    ];
    const child = spawn("docker", args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...spec.env },
    });
    this.live.add(name);

    let settled = false;
    const exit = (code: number | null, error?: Error) => {
      if (settled) return;
      settled = true;
      this.live.delete(name);
      listener.onExit({ code, error });
    };

    child.stdin.on("error", () => {}); // EPIPE if docker exits before reading the job
    child.stdin.write(`${JSON.stringify(spec.job)}\n`);

    // The agent can write to these pipes too, so no line may grow without bound in server memory.
    splitLines(
      child.stdout,
      MAX_LINE_BYTES,
      (line) => {
        if (!line.trim()) return;
        const parsed = parseRunnerLine(line);
        if (parsed) listener.onEvent(parsed.event, parsed.turn);
        else listener.onLog(`unrecognized stdout: ${line}`);
      },
      () => listener.onLog(`dropped a stdout line over ${MAX_LINE_BYTES} bytes`),
    );
    splitLines(
      child.stderr,
      MAX_STDERR_LINE_BYTES,
      (line) => listener.onLog(line),
      () => listener.onLog(`dropped a stderr line over ${MAX_STDERR_LINE_BYTES} bytes`),
    );

    child.on("error", (err) => exit(null, err));
    child.on("close", (code) => exit(code));

    return {
      name,
      send: (message) => {
        if (!settled && child.stdin.writable) child.stdin.write(`${JSON.stringify(message)}\n`);
      },
      kill: () => {
        if (settled) return;
        dockerKill(name);
        // Also signal the docker CLI: it forwards the signal to the container, which
        // covers the case where `docker kill` raced with container creation.
        child.kill("SIGTERM");
      },
    };
  }

  async shutdown(): Promise<void> {
    // Synchronous on purpose: the event loop may stop right after shutdown hooks.
    if (this.live.size > 0) spawnSync("docker", ["kill", ...this.live], { stdio: "ignore" });
  }
}

function dockerKill(name: string): void {
  const child = spawn("docker", ["kill", name], { stdio: "ignore" });
  child.on("error", () => {});
}
