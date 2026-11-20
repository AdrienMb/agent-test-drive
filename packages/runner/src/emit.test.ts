import { describe, expect, it } from "vitest";
import { REDACTED } from "@atd/shared";
import { MAX_OUTPUT, MAX_TITLE, createEmitter, secretsFromEnv } from "./emit.js";

const KEY = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789";

function capture(secrets: string[]) {
  const lines: string[] = [];
  return { lines, emit: createEmitter(secrets, (line) => lines.push(line)) };
}

describe("secretsFromEnv", () => {
  it("collects keys, tokens and passwords but not ordinary variables", () => {
    const env = { OPENAI_API_KEY: KEY, GH_TOKEN: "ghp_x", DB_PASSWORD: "pw", PATH: "/usr/bin", HOME: "/home/node", EMPTY_KEY: "" };
    expect(secretsFromEnv(env).sort()).toEqual([KEY, "ghp_x", "pw"].sort());
  });
});

describe("createEmitter", () => {
  it("redacts a key the agent printed in shell output", () => {
    const { lines, emit } = capture([KEY]);
    emit({ kind: "tool_call", id: "1", tool: "shell", title: "env", status: "completed", output: `OPENAI_API_KEY=${KEY}` });
    expect(lines.join("")).not.toContain(KEY);
    expect(JSON.parse(lines[0]!).output).toBe(`OPENAI_API_KEY=${REDACTED}`);
  });

  it("redacts keys in messages, tool input, errors and files", () => {
    const { lines, emit } = capture([KEY]);
    emit({ kind: "message", text: `Your key is ${KEY}` });
    emit({ kind: "tool_call", id: "2", tool: "shell", title: `echo ${KEY}`, status: "started", input: { command: `echo ${KEY}` } });
    emit({ kind: "error", message: `401 for ${KEY}` });
    emit({ kind: "files", truncated: false, files: [{ path: "k.txt", size: KEY.length, content: KEY }] });
    expect(lines).toHaveLength(4);
    expect(lines.join("")).not.toContain(KEY);
  });

  it("redacts a key that straddles the output limit before truncating", () => {
    const { lines, emit } = capture([KEY]);
    const output = `${"x".repeat(MAX_OUTPUT - 10)}${KEY}`;
    emit({ kind: "tool_call", id: "1", tool: "shell", title: "env", status: "completed", output });
    const sentOutput: string = JSON.parse(lines[0]!).output;
    expect(sentOutput).not.toContain(KEY.slice(0, 10));
    expect(sentOutput.startsWith(`${"x".repeat(MAX_OUTPUT - 10)}${REDACTED.slice(0, 10)}`)).toBe(true);
  });

  it("truncates long titles and output", () => {
    const { lines, emit } = capture([]);
    emit({ kind: "tool_call", id: "1", tool: "shell", title: "t".repeat(MAX_TITLE + 5), status: "completed", output: "o".repeat(MAX_OUTPUT + 5) });
    const sent = JSON.parse(lines[0]!);
    expect(sent.title).toBe(`${"t".repeat(MAX_TITLE)}… [5 more chars]`);
    expect(sent.output).toBe(`${"o".repeat(MAX_OUTPUT)}… [5 more chars]`);
  });

  it("keeps one file when redaction makes two paths identical", () => {
    const other = "sk-ant-api03-0123456789abcdefghijklmnopqrstuvwxyz";
    const { lines, emit } = capture([KEY, other]);
    emit({ kind: "files", truncated: false, files: [{ path: `a-${KEY}.txt`, size: 1 }, { path: `a-${other}.txt`, size: 2 }] });
    expect(JSON.parse(lines[0]!)).toEqual({ kind: "files", truncated: true, files: [{ path: `a-${REDACTED}.txt`, size: 1 }] });
  });

  it("writes one JSON object per line and drops repeated errors", () => {
    const { lines, emit } = capture([]);
    emit({ kind: "error", message: "boom" });
    emit({ kind: "error", message: "boom" });
    emit({ kind: "status", status: "failed" });
    expect(lines).toEqual([`{"kind":"error","message":"boom"}\n`, `{"kind":"status","status":"failed"}\n`]);
  });

  it("shows a repeated error again once the turn has ended", () => {
    const { lines, emit } = capture([]);
    emit({ kind: "error", message: "rate limited" });
    emit({ kind: "status", status: "failed" });
    emit({ kind: "error", message: "rate limited" });
    expect(lines.filter((l) => l.includes("rate limited"))).toHaveLength(2);
  });

  it("tags each line with the current turn id", () => {
    const lines: string[] = [];
    let turn: string | undefined;
    const emit = createEmitter([], (line) => lines.push(line), () => turn);
    emit({ kind: "status", status: "running" });
    turn = "t1";
    emit({ kind: "message", text: "hi" });
    expect(lines.map((l) => JSON.parse(l))).toEqual([
      { kind: "status", status: "running" },
      { kind: "message", text: "hi", turn: "t1" },
    ]);
  });
});
