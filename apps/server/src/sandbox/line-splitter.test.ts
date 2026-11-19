import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { splitLines } from "./line-splitter.js";

function run(chunks: (string | Buffer)[], maxBytes = 10) {
  const input = new PassThrough();
  const lines: string[] = [];
  let overflows = 0;
  splitLines(input, maxBytes, (l) => lines.push(l), () => overflows++);
  for (const c of chunks) input.write(typeof c === "string" ? Buffer.from(c) : c);
  input.end();
  return new Promise<{ lines: string[]; overflows: number }>((resolve) => input.on("end", () => resolve({ lines, overflows })));
}

describe("splitLines", () => {
  it("joins lines across chunks and emits the last unterminated line", async () => {
    expect(await run(["ab", "c\nde\n", "f"])).toEqual({ lines: ["abc", "de", "f"], overflows: 0 });
  });

  it("drops an oversized line up to its newline and keeps going", async () => {
    expect(await run(["ok\n0123456", "789abc", "def\nnext\n"])).toEqual({ lines: ["ok", "next"], overflows: 1 });
  });

  it("drops an oversized unterminated line at the end", async () => {
    expect(await run(["x".repeat(50)])).toEqual({ lines: [], overflows: 1 });
  });

  it("keeps multi-byte characters split across chunks", async () => {
    const bytes = Buffer.from("é\n");
    expect(await run([bytes.subarray(0, 1), bytes.subarray(1)])).toEqual({ lines: ["é"], overflows: 0 });
  });
});
