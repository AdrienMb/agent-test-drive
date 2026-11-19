import { describe, expect, it } from "vitest";
import { FILE_LIMITS } from "@atd/shared";
import { MAX_LINE_BYTES, parseRunnerLine } from "./runner-protocol.js";

const filesLine = (files: unknown[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({ kind: "files", truncated: false, files, ...extra });

describe("parseRunnerLine: files events", () => {
  it("accepts a valid event", () => {
    const files = [
      { path: "fib.py", size: 9, content: "print(1)\n" },
      { path: "logo.png", size: 2048, skipped: "binary" },
      { path: "node_modules", size: 0, skipped: "dir" },
    ];
    expect(parseRunnerLine(filesLine(files))).toEqual({ kind: "files", truncated: false, files });
  });

  it("drops fields it does not know", () => {
    const line = filesLine([{ path: "a.html", size: 1, content: "x", html: "<script>alert(1)</script>" }], { render: true });
    expect(parseRunnerLine(line)).toEqual({ kind: "files", truncated: false, files: [{ path: "a.html", size: 1, content: "x" }] });
  });

  it.each([
    ["absolute path", { path: "/etc/passwd", size: 1 }],
    ["path traversal", { path: "../../etc/passwd", size: 1 }],
    ["nested traversal", { path: "src/../../x", size: 1 }],
    ["RTL override in name", { path: "invoice‮fdp.exe", size: 1 }],
    ["control character in name", { path: "a\u001b[2Jb", size: 1 }],
    ["non-string path", { path: ["a"], size: 1 }],
    ["negative size", { path: "a", size: -1 }],
    ["fractional size", { path: "a", size: 1.5 }],
    ["string size", { path: "a", size: "1" }],
    ["unknown skip reason", { path: "a", size: 1, skipped: "<b>hi</b>" }],
    ["content on a skipped file", { path: ".env", size: 5, skipped: "sensitive", content: "KEY=1" }],
    ["non-string content", { path: "a", size: 1, content: { toString: "x" } }],
    ["oversized content", { path: "a", size: 1, content: "x".repeat(FILE_LIMITS.maxFileBytes + 1) }],
    ["null entry", null],
  ])("rejects an event with %s", (_label, file) => {
    expect(parseRunnerLine(filesLine([file]))).toBeUndefined();
  });

  it("counts content size in UTF-8 bytes, not characters", () => {
    const content = "é".repeat(FILE_LIMITS.maxFileBytes / 2 + 1);
    expect(parseRunnerLine(filesLine([{ path: "a", size: 1, content }]))).toBeUndefined();
  });

  it("fits the largest valid event, even when JSON escaping inflates it", () => {
    const chunk = "\u0001".repeat(FILE_LIMITS.maxFileBytes);
    const count = Math.floor(FILE_LIMITS.maxTotalBytes / FILE_LIMITS.maxFileBytes);
    const files = Array.from({ length: FILE_LIMITS.maxFiles }, (_, i) => ({
      path: `${i}-`.padEnd(FILE_LIMITS.maxPathLength, '"'),
      size: chunk.length,
      ...(i < count ? { content: chunk } : { skipped: "budget" }),
    }));
    const line = filesLine(files, { truncated: true });
    expect(Buffer.byteLength(line)).toBeLessThanOrEqual(MAX_LINE_BYTES);
    expect(parseRunnerLine(line)?.kind).toBe("files");
  });

  it("rejects duplicate paths", () => {
    expect(parseRunnerLine(filesLine([{ path: "a", size: 1 }, { path: "a", size: 1 }]))).toBeUndefined();
  });

  it("rejects too many files", () => {
    const files = Array.from({ length: FILE_LIMITS.maxFiles + 1 }, (_, i) => ({ path: `f${i}`, size: 0 }));
    expect(parseRunnerLine(filesLine(files))).toBeUndefined();
  });

  it("rejects an event over the total content budget", () => {
    const chunk = "x".repeat(FILE_LIMITS.maxFileBytes);
    const count = Math.ceil(FILE_LIMITS.maxTotalBytes / FILE_LIMITS.maxFileBytes) + 1;
    const files = Array.from({ length: count }, (_, i) => ({ path: `f${i}`, size: chunk.length, content: chunk }));
    expect(parseRunnerLine(filesLine(files))).toBeUndefined();
  });

  it("rejects a missing or non-boolean truncated flag", () => {
    expect(parseRunnerLine(JSON.stringify({ kind: "files", files: [] }))).toBeUndefined();
    expect(parseRunnerLine(JSON.stringify({ kind: "files", files: [], truncated: "no" }))).toBeUndefined();
  });
});
