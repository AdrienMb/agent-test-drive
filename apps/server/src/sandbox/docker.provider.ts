import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import type { AgentId } from "@atd/shared";
import { parseRunnerLine } from "./runner-protocol.js";
import type { SandboxHandle, SandboxListener, SandboxProvider, SandboxSpec } from "./sandbox.types.js";

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
    child.stdin.end(`${JSON.stringify(spec.job)}\n`);

    createInterface({ input: child.stdout }).on("line", (line) => {
      if (!line.trim()) return;
      const event = parseRunnerLine(line);
      if (event) listener.onEvent(event);
      else listener.onLog(`unrecognized stdout: ${line}`);
    });
    createInterface({ input: child.stderr }).on("line", (line) => listener.onLog(line));

    child.on("error", (err) => exit(null, err));
    child.on("close", (code) => exit(code));

    return {
      name,
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
