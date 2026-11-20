import { describe, expect, it } from "vitest";

// Everything the UI shows comes from the agents, so it must only ever reach the DOM as React text.
const sources = import.meta.glob<string>(["./**/*.{ts,tsx}", "!./**/*.test.{ts,tsx}"], { query: "?raw", import: "default", eager: true });

const FORBIDDEN = [/dangerouslySetInnerHTML/, /\.innerHTML\b/, /\.outerHTML\b/, /insertAdjacentHTML/, /document\.write/, /srcdoc/i, /\beval\(/, /new Function\(/];

describe("web sources", () => {
  it("are found", () => {
    expect(Object.keys(sources)).toContain("./run/FilesPanel.tsx");
  });

  it.each(Object.entries(sources))("%s uses no raw HTML sinks", (_file, source) => {
    for (const pattern of FORBIDDEN) expect(source).not.toMatch(pattern);
  });
});
