import { randomUUID } from "node:crypto";
import { Inject, Injectable, Logger, type OnApplicationShutdown } from "@nestjs/common";
import { ReplaySubject, type Observable } from "rxjs";
import { AGENTS, redactEvent, redactSecrets, type AgentId, type NormalizedEvent, type RunEvent, type RunnerJob } from "@atd/shared";
import { SANDBOX_PROVIDER, type SandboxHandle, type SandboxProvider } from "../sandbox/sandbox.types.js";

/** Per turn. */
const TURN_TIMEOUT_MS = 10 * 60 * 1000;
/** Sandboxes stay up between turns for follow-ups, until this long without one. */
export const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
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
  /** A turn is in progress; runner output is ignored otherwise. */
  busy: boolean;
  /** Id of the current (or last) turn; runner lines tagged with any other id are ignored. */
  turn?: string;
  /** The sandbox is gone (or never started); no more turns. */
  closed: boolean;
  /** Last log lines, shown to the user if the sandbox dies unexpectedly. */
  logTail: string[];
  /** Only the first files event of a turn is kept, so a misbehaving runner cannot fill the replay buffer. */
  filesReported: boolean;
}

interface Run {
  id: string;
  seq: number;
  events$: ReplaySubject<RunEvent>;
  agents: Record<AgentId, AgentRun>;
  idleTimer?: NodeJS.Timeout;
}

export type FollowUpResult = "sent" | "unknown" | "busy" | "closed";

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
    const agentRun = (agent: AgentId): AgentRun => ({ name: `cmp-${id}-${agent}`, busy: false, closed: false, logTail: [], filesReported: false });
    const run: Run = {
      id,
      seq: 0,
      events$: new ReplaySubject<RunEvent>(),
      agents: { claude: agentRun("claude"), codex: agentRun("codex") },
    };
    this.runs.set(id, run);
    for (const { id: agent } of AGENTS) this.startAgent(run, agent, prompt);
    return id;
  }

  events(runId: string): Observable<RunEvent> | undefined {
    return this.runs.get(runId)?.events$.asObservable();
  }

  /** Sends a follow-up prompt to every agent whose sandbox is still up, once all of them have finished their turn. */
  followUp(runId: string, prompt: string): FollowUpResult {
    const run = this.runs.get(runId);
    if (!run) return "unknown";
    const live = AGENTS.map((a) => a.id).filter((agent) => !run.agents[agent].closed);
    if (live.length === 0) return "closed";
    if (live.some((agent) => run.agents[agent].busy)) return "busy";
    for (const agent of live) {
      this.emit(run, agent, { kind: "prompt", text: prompt });
      const turn = this.beginTurn(run, agent);
      run.agents[agent].handle?.send({ prompt, turn });
    }
    return "sent";
  }

  /** Stops any turn in progress and ends the session. */
  cancel(runId: string): boolean {
    const run = this.runs.get(runId);
    if (!run) return false;
    for (const { id: agent } of AGENTS) {
      if (run.agents[agent].busy) this.endTurn(run, agent, { kind: "status", status: "cancelled" });
      this.close(run, agent, "Ended by the user");
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
    const turn = this.beginTurn(run, agent);

    const apiKey = process.env[envVar];
    if (!apiKey) {
      this.fail(run, agent, `${envVar} is not set in .env`);
      this.close(run, agent, "No API key");
      return;
    }

    const job: RunnerJob = { agent, prompt, turn };
    a.handle = this.sandbox.start(
      { name: a.name, agent, job, env: { [envVar]: apiKey }, limits: LIMITS },
      {
        onEvent: (event, eventTurn) => {
          // An untagged or stale line is either the agent writing to stdout or output from an earlier turn.
          if (!a.busy || eventTurn !== a.turn) return;
          // The server already emitted "running" when it started the turn.
          if (event.kind === "status" && event.status === "running") return;
          if (event.kind === "files") {
            if (a.filesReported) return;
            a.filesReported = true;
          }
          if (isFinal(event)) this.endTurn(run, agent, event);
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
          if (a.busy) {
            const tail = a.logTail.length ? `\n${a.logTail.join("\n")}` : "";
            this.fail(
              run,
              agent,
              error ? `Could not start sandbox (${this.sandbox.kind}): ${error.message}` : `Sandbox exited (code ${code}) without a final status${tail}`,
            );
          }
          this.close(run, agent, "The sandbox stopped");
        },
      },
    );
  }

  /** Returns the new turn's id. */
  private beginTurn(run: Run, agent: AgentId): string {
    const a = run.agents[agent];
    a.busy = true;
    a.turn = randomUUID();
    a.filesReported = false;
    clearTimeout(run.idleTimer);
    this.emit(run, agent, { kind: "status", status: "running" });
    a.timeout = setTimeout(() => {
      if (!a.busy) return;
      this.fail(run, agent, `Timed out after ${TURN_TIMEOUT_MS / 60_000} minutes`);
      this.close(run, agent, "Timed out");
    }, TURN_TIMEOUT_MS);
    return a.turn;
  }

  private emit(run: Run, agent: AgentId, event: NormalizedEvent): void {
    // The runner redacts too, but the agent can write to the runner's stdout and bypass it.
    run.events$.next({ runId: run.id, agent, seq: ++run.seq, ts: Date.now(), event: redactEvent(event, this.secrets) });
  }

  private fail(run: Run, agent: AgentId, message: string): void {
    this.emit(run, agent, { kind: "error", message });
    this.endTurn(run, agent, { kind: "status", status: "failed" });
  }

  private endTurn(run: Run, agent: AgentId, final: NormalizedEvent): void {
    const a = run.agents[agent];
    if (!a.busy) return;
    this.emit(run, agent, final);
    a.busy = false;
    clearTimeout(a.timeout);

    if (Object.values(run.agents).every((x) => !x.busy)) {
      clearTimeout(run.idleTimer);
      run.idleTimer = setTimeout(() => {
        for (const { id } of AGENTS) this.close(run, id, `Ended after ${IDLE_TIMEOUT_MS / 60_000} minutes without a follow-up`);
      }, IDLE_TIMEOUT_MS);
      run.idleTimer.unref();
    }
  }

  /** Call endTurn first if a turn is in progress. */
  private close(run: Run, agent: AgentId, reason: string): void {
    const a = run.agents[agent];
    if (a.closed) return;
    a.closed = true;
    a.busy = false;
    clearTimeout(a.timeout);
    a.handle?.kill();
    this.emit(run, agent, { kind: "closed", reason });

    if (Object.values(run.agents).every((x) => x.closed)) {
      clearTimeout(run.idleTimer);
      run.events$.complete();
      setTimeout(() => this.runs.delete(run.id), RETENTION_MS).unref();
    }
  }
}
