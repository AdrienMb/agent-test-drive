import { describe, expect, it } from "vitest";
import { REDACTED, isSafeWorkspacePath, redactSecrets } from "./files.js";

const KEY = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";

describe("isSafeWorkspacePath", () => {
  it.each(["a.txt", "src/main.py", "dir/sub/file.tar.gz", ".gitignore", "<b>x</b>.txt", "café/ünï.md"])("accepts %j", (path) => {
    expect(isSafeWorkspacePath(path)).toBe(true);
  });

  it.each([
    ["empty", ""],
    ["absolute", "/etc/passwd"],
    ["parent", "../secret"],
    ["nested parent", "a/../../b"],
    ["dot segment", "./a"],
    ["empty segment", "a//b"],
    ["trailing slash", "a/"],
    ["backslash", "..\\..\\windows"],
    ["NUL", "a\u0000b"],
    ["newline", "a\nb"],
    ["escape sequence", "a\u001b[31mred"],
    ["RTL override", "invoice‮fdp.exe"],
    ["bidi isolate", "a⁦b"],
    ["zero-width space", "pass​word.txt"],
    ["BOM", "﻿a"],
    ["line separator", "a b"],
    ["too long", "a".repeat(513)],
  ])("rejects %s", (_label, path) => {
    expect(isSafeWorkspacePath(path)).toBe(false);
  });

  it("rejects non-strings", () => {
    expect(isSafeWorkspacePath(undefined)).toBe(false);
    expect(isSafeWorkspacePath(42)).toBe(false);
    expect(isSafeWorkspacePath({ toString: () => "a" })).toBe(false);
  });
});

describe("redactSecrets", () => {
  it("replaces secrets in nested strings and object keys", () => {
    const event = { kind: "tool_call", output: `ANTHROPIC_API_KEY=${KEY}\nok`, input: { [KEY]: [`x${KEY}y${KEY}`] } };
    const redacted = redactSecrets(event, [KEY]);
    expect(JSON.stringify(redacted)).not.toContain(KEY);
    expect(redacted.output).toBe(`ANTHROPIC_API_KEY=${REDACTED}\nok`);
    expect(redacted.input).toEqual({ [REDACTED]: [`x${REDACTED}y${REDACTED}`] });
  });

  it("does not mutate its input", () => {
    const event = { text: KEY };
    redactSecrets(event, [KEY]);
    expect(event.text).toBe(KEY);
  });

  it("ignores values too short to be a key", () => {
    expect(redactSecrets("the value is 1 or abc", ["1", "abc", ""])).toBe("the value is 1 or abc");
  });

  it("replaces a secret that contains another as a whole", () => {
    const short = "abcdefghijklmnop0123";
    const long = `${short}XYZsecretpart`;
    expect(redactSecrets(`v=${long}`, [short, long])).toBe(`v=${REDACTED}`);
  });

  it("keeps non-string values", () => {
    expect(redactSecrets({ n: 1, b: true, z: null }, [KEY])).toEqual({ n: 1, b: true, z: null });
  });
});
