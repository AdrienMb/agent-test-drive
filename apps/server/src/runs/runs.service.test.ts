import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Logger } from "@nestjs/common";
import { REDACTED, type AgentId, type RunEvent } from "@atd/shared";
import type { SandboxListener, SandboxProvider, SandboxSpec } from "../sandbox/sandbox.types.js";
import { RunsService } from "./runs.service.js";

const ANTHROPIC_KEY = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";
const OPENAI_KEY = "sk-proj-zyxwvutsrqponmlkjihgfedcba9876543210";

class FakeSandbox implements SandboxProvider {
  readonly kind = "docker" as const;
  readonly started = new Map<AgentId, { spec: SandboxSpec; listener: SandboxListener }>();

  start(spec: SandboxSpec, listener: SandboxListener) {
    this.started.set(spec.agent, { spec, listener });
    return { name: spec.name, kill: () => {} };
  }

  async shutdown() {}

  listener(agent: AgentId): SandboxListener {
    return this.started.get(agent)!.listener;
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

  it("keeps only the first files event per agent", () => {
    const claude = sandbox.listener("claude");
    claude.onEvent({ kind: "files", truncated: false, files: [{ path: "a.txt", size: 1, content: "a" }] });
    claude.onEvent({ kind: "files", truncated: false, files: [{ path: "spoof.txt", size: 1, content: "b" }] });
    sandbox.listener("codex").onEvent({ kind: "files", truncated: false, files: [] });

    const files = received.filter((e) => e.event.kind === "files");
    expect(files.map((e) => e.agent)).toEqual(["claude", "codex"]);
    expect(sent()).not.toContain("spoof.txt");
  });
});
