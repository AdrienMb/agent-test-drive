import type { AgentId, NormalizedEvent, RunnerJob } from "@atd/shared";

export interface SandboxSpec {
  /** Unique, readable name, e.g. cmp-<runId>-<agent>. */
  name: string;
  agent: AgentId;
  job: RunnerJob;
  /** Secrets for the runner (only the one API key its agent needs). */
  env: Record<string, string>;
  limits: { memoryMb: number; cpus: number };
}

export interface SandboxListener {
  onEvent(event: NormalizedEvent): void;
  /** Runner stderr or provider diagnostics. Never shown to the user directly. */
  onLog(line: string): void;
  /** Called exactly once, after the last onEvent. `error` is set when the sandbox could not start. */
  onExit(info: { code: number | null; error?: Error }): void;
}

export interface SandboxHandle {
  readonly name: string;
  /** Best effort and idempotent; onExit still fires afterwards. */
  kill(): void;
}

/** Where runners execute: Docker locally, Railway sandboxes in production. */
export interface SandboxProvider {
  readonly kind: SandboxKind;
  start(spec: SandboxSpec, listener: SandboxListener): SandboxHandle;
  /** Kills every sandbox this provider started that is still alive (app shutdown). */
  shutdown(): Promise<void>;
}

type SandboxKind = "docker" | "railway";

export const SANDBOX_PROVIDER = Symbol("SANDBOX_PROVIDER");
