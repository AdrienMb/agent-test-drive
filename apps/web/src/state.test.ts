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
