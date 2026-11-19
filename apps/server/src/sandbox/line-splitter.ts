import type { Readable } from "node:stream";

/**
 * Like readline, but never holds more than `maxBytes` of one line in memory. A longer line is dropped
 * up to its newline, and onOverflow is called once for it.
 */
export function splitLines(input: Readable, maxBytes: number, onLine: (line: string) => void, onOverflow: () => void): void {
  let parts: Buffer[] = [];
  let size = 0;
  let dropping = false;

  input.on("data", (chunk: Buffer) => {
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(0x0a, start);
      const piece = chunk.subarray(start, newline === -1 ? chunk.length : newline);
      if (!dropping && size + piece.length > maxBytes) {
        dropping = true;
        parts = [];
        size = 0;
        onOverflow();
      }
      if (!dropping) {
        parts.push(piece);
        size += piece.length;
      }
      if (newline === -1) return;
      // Splitting on the 0x0a byte is safe for UTF-8: it never occurs inside a multi-byte character.
      if (!dropping) onLine(Buffer.concat(parts, size).toString("utf8"));
      parts = [];
      size = 0;
      dropping = false;
      start = newline + 1;
    }
  });
  input.on("end", () => {
    if (!dropping && size > 0) onLine(Buffer.concat(parts, size).toString("utf8"));
  });
}
