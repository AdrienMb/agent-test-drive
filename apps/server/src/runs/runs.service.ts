import { randomUUID } from "node:crypto";
import { Inject, Injectable, Logger, type OnApplicationShutdown } from "@nestjs/common";
import { ReplaySubject, type Observable } from "rxjs";
import { AGENTS, redactEvent, redactSecrets, type AgentId, type NormalizedEvent, type RunEvent, type RunnerJob } from "@atd/shared";
import { SANDBOX_PROVIDER, type SandboxHandle, type SandboxProvider } from "../sandbox/sandbox.types.js";

const TIMEOUT_MS = 10 * 60 * 1000;
const RETENTION_MS = 30 * 60 * 1000;
const LIMITS = { memoryMb: 2048, cpus: 2 };
/** Log lines end up in the error event if the sandbox dies, so each is kept short. */
const MAX_LOG_LINE = 1_000;

const API_KEY_ENV: Record<AgentId, string> = {
  claude: "ANTHROPIC_API_KEY",
  codex: "OPENAI_API_KEY",
};

interface AgentRun {
  name: string;
  handle?: SandboxHandle;
  timeout?: NodeJS.Timeout;
  /** Set once the final status has been emitted; later output is ignored. */
  finished: boolean;
  /** Last log lines, shown to the user if the sandbox dies unexpectedly. */
  logTail: string[];
  /** Only the first files event is kept, so a misbehaving runner cannot fill the replay buffer. */
  filesReported: boolean;
}

interface Run {
  id: string;
  seq: number;
  events$: ReplaySubject<RunEvent>;
  agents: Record<AgentId, AgentRun>;
}

const isFinal = (e: NormalizedEvent) => e.kind === "status" && e.status !== "running";

@Injectable()
export class RunsService implements OnApplicationShutdown {
  private readonly logger = new Logger(RunsService.name);
  private readonly runs = new Map<string, Run>();
  /** Every API key the server knows, redacted from everything it streams and logs. Kept off Run so it can't be serialized with one. */
  private readonly secrets = Object.values(API_KEY_ENV).flatMap((name) => process.env[name] ?? []);

  constructor(@Inject(SANDBOX_PROVIDER) private readonly sandbox: SandboxProvider) {}

  start(prompt: string): string {
    const id = randomUUID().slice(0, 8);
    const run: Run = {
      id,
      seq: 0,
      events$: new ReplaySubject<RunEvent>(),
      agents: {
        claude: { name: `cmp-${id}-claude`, finished: false, logTail: [], filesReported: false },
        codex: { name: `cmp-${id}-codex`, finished: false, logTail: [], filesReported: false },
      },
    };
    this.runs.set(id, run);
    for (const { id: agent } of AGENTS) this.startAgent(run, agent, prompt);
    return id;
  }

  events(runId: string): Observable<RunEvent> | undefined {
    return this.runs.get(runId)?.events$.asObservable();
  }

  cancel(runId: string): boolean {
    const run = this.runs.get(runId);
    if (!run) return false;
    for (const { id: agent } of AGENTS) {
      const a = run.agents[agent];
      if (a.finished) continue;
      a.handle?.kill();
      this.finish(run, agent, { kind: "status", status: "cancelled" });
    }
    return true;
  }

  async onApplicationShutdown(): Promise<void> {
    this.logger.log(`Stopping running ${this.sandbox.kind} sandbox(es)`);
    await this.sandbox.shutdown();
  }

  private startAgent(run: Run, agent: AgentId, prompt: string): void {
    const a = run.agents[agent];
    const envVar = API_KEY_ENV[agent];
    this.emit(run, agent, { kind: "status", status: "running" });

    const apiKey = process.env[envVar];
    if (!apiKey) {
      this.fail(run, agent, `${envVar} is not set in .env`);
      return;
    }

    a.timeout = setTimeout(() => {
      if (a.finished) return;
      a.handle?.kill();
      this.fail(run, agent, `Timed out after ${TIMEOUT_MS / 60_000} minutes`);
    }, TIMEOUT_MS);

    const job: RunnerJob = { agent, prompt };
    a.handle = this.sandbox.start(
      { name: a.name, agent, job, env: { [envVar]: apiKey }, limits: LIMITS },
      {
        onEvent: (event) => {
          // The server already emitted "running" when it started the sandbox.
          if (event.kind === "status" && event.status === "running") return;
          if (event.kind === "files") {
            if (a.filesReported) return;
            a.filesReported = true;
          }
          if (isFinal(event)) this.finish(run, agent, event);
          else this.emit(run, agent, event);
        },
        onLog: (raw) => {
          // Redact before shortening, so a key cut at the limit is never partly kept.
          const redacted = redactSecrets(raw, this.secrets);
          const line = redacted.length > MAX_LOG_LINE ? `${redacted.slice(0, MAX_LOG_LINE)}… [${redacted.length - MAX_LOG_LINE} more chars]` : redacted;
          this.logger.debug(`[${a.name}] ${line}`);
          a.logTail = [...a.logTail, line].slice(-5);
        },
        onExit: ({ code, error }) => {
          clearTimeout(a.timeout);
          if (a.finished) return;
          if (error) {
            this.fail(run, agent, `Could not start sandbox (${this.sandbox.kind}): ${error.message}`);
            return;
          }
          const tail = a.logTail.length ? `\n${a.logTail.join("\n")}` : "";
          this.fail(run, agent, `Sandbox exited (code ${code}) without a final status${tail}`);
        },
      },
    );
  }

  private emit(run: Run, agent: AgentId, event: NormalizedEvent): void {
    if (run.agents[agent].finished) return;
    // The runner redacts too, but the agent can write to the runner's stdout and bypass it.
    run.events$.next({ runId: run.id, agent, seq: ++run.seq, ts: Date.now(), event: redactEvent(event, this.secrets) });
  }

  private fail(run: Run, agent: AgentId, message: string): void {
    this.emit(run, agent, { kind: "error", message });
    this.finish(run, agent, { kind: "status", status: "failed" });
  }

  private finish(run: Run, agent: AgentId, final: NormalizedEvent): void {
    const a = run.agents[agent];
    if (a.finished) return;
    this.emit(run, agent, final);
    a.finished = true;
    clearTimeout(a.timeout);

    if (Object.values(run.agents).every((x) => x.finished)) {
      run.events$.complete();
      setTimeout(() => this.runs.delete(run.id), RETENTION_MS).unref();
    }
  }
}
