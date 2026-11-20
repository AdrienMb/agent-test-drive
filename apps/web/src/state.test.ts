import { describe, expect, it } from "vitest";
import type { NormalizedEvent } from "@atd/shared";
import { initialState, reducer } from "./state";

const started = reducer(initialState, { type: "start", runId: "r1", prompt: "p" });
const apply = (event: NormalizedEvent) => reducer(started, { type: "event", event: { runId: "r1", agent: "claude", seq: 1, ts: 0, event } });

describe("reducer: files", () => {
  it("stores the files event on the agent", () => {
    const state = apply({ kind: "files", truncated: false, files: [{ path: "a.txt", size: 1, content: "a" }] });
    expect(state.agents.claude.files).toEqual({ truncated: false, files: [{ path: "a.txt", size: 1, content: "a" }] });
    expect(state.agents.codex.files).toBeUndefined();
  });

  it("drops unsafe paths even if the server let them through, and marks the list truncated", () => {
    const state = apply({
      kind: "files",
      truncated: false,
      files: [
        { path: "../../etc/passwd", size: 1, content: "root" },
        { path: "invoice‮fdp.exe", size: 1 },
        { path: "ok.txt", size: 1, content: "ok" },
      ],
    });
    expect(state.agents.claude.files).toEqual({ truncated: true, files: [{ path: "ok.txt", size: 1, content: "ok" }] });
  });
});

describe("reducer: follow-ups", () => {
  const events = (list: [number, NormalizedEvent][]) =>
    list.reduce((s, [ts, event], i) => reducer(s, { type: "event", event: { runId: "r1", agent: "claude", seq: i + 1, ts, event } }), started);

  it("shows the follow-up prompt, sums usage and wall time across turns", () => {
    const state = events([
      [0, { kind: "status", status: "running" }],
      [0, { kind: "usage", inputTokens: 10, outputTokens: 1, costUsd: 0.5 }],
      [1_000, { kind: "status", status: "done" }],
      [60_000, { kind: "prompt", text: "add tests" }],
      [60_000, { kind: "status", status: "running" }],
      [60_000, { kind: "usage", inputTokens: 5, outputTokens: 2 }],
      [62_000, { kind: "status", status: "done" }],
    ]);
    const claude = state.agents.claude;
    expect(claude.items).toEqual([{ type: "prompt", key: "4", text: "add tests" }]);
    expect(claude.usage).toEqual({ kind: "usage", inputTokens: 15, outputTokens: 3, costUsd: 0.5, durationMs: undefined });
    expect(claude.wallMs).toBe(3_000);
    expect(claude.startedAt).toBe(60_000);
  });

  it("keeps a separate card for a tool call id reused in a later turn", () => {
    const call = (title: string, status: "started" | "completed") => ({ kind: "tool_call" as const, id: "item_0", tool: "shell" as const, title, status });
    const state = events([
      [0, { kind: "status", status: "running" }],
      [0, call("ls", "started")],
      [0, call("ls", "completed")],
      [1, { kind: "status", status: "done" }],
      [2, { kind: "prompt", text: "run tests" }],
      [2, { kind: "status", status: "running" }],
      [2, call("npm test", "started")],
    ]);
    const cards = state.agents.claude.items.flatMap((i) => (i.type === "tool_call" ? [[i.call.title, i.call.status]] : []));
    expect(cards).toEqual([
      ["ls", "completed"],
      ["npm test", "started"],
    ]);
  });

  it("records why the session ended", () => {
    const state = events([
      [0, { kind: "status", status: "done" }],
      [0, { kind: "closed", reason: "Ended by the user" }],
    ]);
    expect(state.agents.claude.closed).toBe("Ended by the user");
  });

  it("ends an idle session when the connection is lost for good", () => {
    const done = events([[0, { kind: "status", status: "done" }]]);
    const state = reducer(done, { type: "disconnected", message: "gone" });
    expect(state.agents.claude).toMatchObject({ status: "done", closed: "gone" });
    expect(state.agents.claude.items).toEqual([]);
  });
});
