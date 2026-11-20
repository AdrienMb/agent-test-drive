import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Logger } from "@nestjs/common";
import { REDACTED, type AgentId, type RunEvent } from "@atd/shared";
import type { SandboxListener, SandboxProvider, SandboxSpec } from "../sandbox/sandbox.types.js";
import { IDLE_TIMEOUT_MS, RunsService } from "./runs.service.js";

const ANTHROPIC_KEY = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";
const OPENAI_KEY = "sk-proj-zyxwvutsrqponmlkjihgfedcba9876543210";

class FakeSandbox implements SandboxProvider {
  readonly kind = "docker" as const;
  readonly started = new Map<AgentId, { spec: SandboxSpec; listener: SandboxListener; sent: unknown[]; kill: ReturnType<typeof vi.fn> }>();

  start(spec: SandboxSpec, listener: SandboxListener) {
    const sent: unknown[] = [];
    const kill = vi.fn();
    this.started.set(spec.agent, { spec, listener, sent, kill });
    return { name: spec.name, send: (message: unknown) => void sent.push(message), kill };
  }

  async shutdown() {}

  /** Tags events with the agent's current turn by default, like the real runner. */
  listener(agent: AgentId): SandboxListener {
    const { listener } = this.started.get(agent)!;
    return { ...listener, onEvent: (event, turn = this.turn(agent)) => listener.onEvent(event, turn) };
  }

  turn(agent: AgentId): string {
    const { spec, sent } = this.started.get(agent)!;
    return ((sent.at(-1) as { turn?: string } | undefined) ?? spec.job).turn!;
  }
}

let sandbox: FakeSandbox;
let service: RunsService;
let runId: string;
let received: RunEvent[];
const savedEnv = { ...process.env };

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = ANTHROPIC_KEY;
  process.env.OPENAI_API_KEY = OPENAI_KEY;
  sandbox = new FakeSandbox();
  service = new RunsService(sandbox);
  runId = service.start("hello");
  received = [];
  service.events(runId)!.subscribe((e) => received.push(e));
});

afterEach(() => {
  service.cancel(runId);
  process.env = { ...savedEnv };
});

const sent = () => JSON.stringify(received);

describe("RunsService secrets", () => {
  it("gives each sandbox only its own key, and never in the job", () => {
    const claude = sandbox.started.get("claude")!.spec;
    const codex = sandbox.started.get("codex")!.spec;
    expect(claude.env).toEqual({ ANTHROPIC_API_KEY: ANTHROPIC_KEY });
    expect(codex.env).toEqual({ OPENAI_API_KEY: OPENAI_KEY });
    expect(JSON.stringify([claude.job, codex.job])).not.toMatch(/sk-(ant|proj)-/);
  });

  // The agent can write to the runner's stdout directly, so these events never went through the runner's redaction.
  it("redacts keys from events that bypassed the runner", () => {
    const claude = sandbox.listener("claude");
    claude.onEvent({ kind: "message", text: `here: ${ANTHROPIC_KEY}` });
    claude.onEvent({ kind: "tool_call", id: "1", tool: "shell", title: "env", status: "completed", output: `OPENAI_API_KEY=${OPENAI_KEY}` });
    claude.onEvent({ kind: "files", truncated: false, files: [{ path: "leak.txt", size: 1, content: `${ANTHROPIC_KEY}\n${OPENAI_KEY}` }] });

    expect(received.length).toBeGreaterThanOrEqual(5);
    expect(sent()).not.toContain(ANTHROPIC_KEY);
    expect(sent()).not.toContain(OPENAI_KEY);
    expect(sent()).toContain(`here: ${REDACTED}`);
  });

  it("redacts keys from runner logs, in the server log and when shown after a crash", () => {
    const debug = vi.spyOn(Logger.prototype, "debug").mockImplementation(() => {});
    const codex = sandbox.listener("codex");
    codex.onLog(`Error: invalid api key ${OPENAI_KEY}`);
    codex.onExit({ code: 1 });
    const error = received.find((e) => e.agent === "codex" && e.event.kind === "error");
    expect(error).toBeDefined();
    expect(sent()).not.toContain(OPENAI_KEY);
    expect(debug).toHaveBeenCalled();
    expect(JSON.stringify(debug.mock.calls)).not.toContain(OPENAI_KEY);
    debug.mockRestore();
  });
});

describe("RunsService logs", () => {
  it("keeps each log line short in the crash report, redacting before it shortens", () => {
    vi.spyOn(Logger.prototype, "debug").mockImplementation(() => {});
    const claude = sandbox.listener("claude");
    claude.onLog(`${"x".repeat(990)}${ANTHROPIC_KEY}${"y".repeat(5_000_000)}`);
    claude.onExit({ code: 1 });
    const error = received.find((e) => e.agent === "claude" && e.event.kind === "error");
    expect(JSON.stringify(error).length).toBeLessThan(2_000);
    expect(sent()).not.toContain(ANTHROPIC_KEY.slice(0, 10));
    vi.restoreAllMocks();
  });
});

describe("RunsService files", () => {
  it("keeps one file when redaction makes two paths identical", () => {
    sandbox.listener("claude").onEvent({
      kind: "files",
      truncated: false,
      files: [
        { path: `a-${ANTHROPIC_KEY}.txt`, size: 1 },
        { path: `a-${OPENAI_KEY}.txt`, size: 2 },
      ],
    });
    const files = received.find((e) => e.event.kind === "files")?.event;
    expect(files).toEqual({ kind: "files", truncated: true, files: [{ path: `a-${REDACTED}.txt`, size: 1 }] });
  });

  it("keeps only the first files event per agent and turn", () => {
    const claude = sandbox.listener("claude");
    claude.onEvent({ kind: "files", truncated: false, files: [{ path: "a.txt", size: 1, content: "a" }] });
    claude.onEvent({ kind: "files", truncated: false, files: [{ path: "spoof.txt", size: 1, content: "b" }] });
    sandbox.listener("codex").onEvent({ kind: "files", truncated: false, files: [] });

    const files = received.filter((e) => e.event.kind === "files");
    expect(files.map((e) => e.agent)).toEqual(["claude", "codex"]);
    expect(sent()).not.toContain("spoof.txt");
  });
});

const endTurn = (agent: AgentId) => sandbox.listener(agent).onEvent({ kind: "status", status: "done" });
const kinds = (agent: AgentId) => received.filter((e) => e.agent === agent).map((e) => (e.event.kind === "status" ? e.event.status : e.event.kind));

describe("RunsService follow-ups", () => {
  it("refuses a follow-up until every agent has finished its turn", () => {
    expect(service.followUp(runId, "add tests")).toBe("busy");
    endTurn("claude");
    expect(service.followUp(runId, "add tests")).toBe("busy");
    expect(service.followUp("nope", "add tests")).toBe("unknown");
  });

  it("sends the follow-up to each live sandbox and starts a new turn", () => {
    endTurn("claude");
    endTurn("codex");
    expect(service.followUp(runId, "add tests")).toBe("sent");
    expect(sandbox.started.get("claude")!.sent).toEqual([{ prompt: "add tests", turn: expect.any(String) }]);
    expect(sandbox.started.get("codex")!.sent).toEqual([{ prompt: "add tests", turn: expect.any(String) }]);
    expect(sandbox.turn("claude")).not.toBe(sandbox.started.get("claude")!.spec.job.turn);
    expect(kinds("claude")).toEqual(["running", "done", "prompt", "running"]);

    sandbox.listener("claude").onEvent({ kind: "message", text: "second turn" });
    expect(received.at(-1)?.event).toEqual({ kind: "message", text: "second turn" });
  });

  it("ignores lines tagged with another turn or not tagged at all", () => {
    const firstTurn = sandbox.turn("claude");
    const claude = sandbox.listener("claude");
    sandbox.started.get("claude")!.listener.onEvent({ kind: "status", status: "done" });
    claude.onEvent({ kind: "message", text: "spoofed" }, "guess");
    expect(kinds("claude")).toEqual(["running"]);

    endTurn("claude");
    endTurn("codex");
    service.followUp(runId, "add tests");
    claude.onEvent({ kind: "status", status: "done" }, firstTurn);
    expect(kinds("claude")).toEqual(["running", "done", "prompt", "running"]);
    expect(sent()).not.toContain("spoofed");
  });

  it("ignores runner output between turns", () => {
    endTurn("claude");
    sandbox.listener("claude").onEvent({ kind: "message", text: "late" });
    expect(sent()).not.toContain("late");
  });

  it("only talks to agents whose sandbox is still up, and reports a closed session", () => {
    endTurn("claude");
    sandbox.listener("codex").onExit({ code: 137 });
    expect(kinds("codex")).toEqual(["running", "error", "failed", "closed"]);
    expect(service.followUp(runId, "again")).toBe("sent");
    expect(sandbox.started.get("codex")!.sent).toEqual([]);

    sandbox.listener("claude").onExit({ code: 0 });
    expect(service.followUp(runId, "again")).toBe("closed");
  });

  it("closes the sandboxes when no follow-up comes before the idle timeout", () => {
    vi.useFakeTimers();
    try {
      endTurn("claude");
      endTurn("codex");
      vi.advanceTimersByTime(IDLE_TIMEOUT_MS - 1);
      expect(sandbox.started.get("claude")!.kill).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      for (const agent of ["claude", "codex"] as const) {
        expect(sandbox.started.get(agent)!.kill).toHaveBeenCalled();
        expect(kinds(agent).at(-1)).toBe("closed");
      }
      expect(service.followUp(runId, "too late")).toBe("closed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancel stops a running turn and ends the session", () => {
    endTurn("claude");
    service.cancel(runId);
    expect(kinds("claude")).toEqual(["running", "done", "closed"]);
    expect(kinds("codex")).toEqual(["running", "cancelled", "closed"]);
    expect(sandbox.started.get("codex")!.kill).toHaveBeenCalled();
  });
});
