import { describe, expect, it } from "vitest";
import { downloadName } from "./download";

describe("downloadName", () => {
  it.each([
    ["src/main.py", "main.py"],
    ["a b/my file (1).txt", "my_file__1_.txt"],
    ["<script>.html", "_script_.html"],
    [".bashrc", "bashrc"],
    ["..", "file"],
    ["dir/", "file"],
    ["résumé.pdf", "r_sum_.pdf"],
  ])("%j -> %j", (path, expected) => {
    expect(downloadName(path)).toBe(expected);
  });
});
