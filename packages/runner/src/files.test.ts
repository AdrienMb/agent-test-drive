import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openRegularFile, scanWorkspace } from "./files.js";

const KEY = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";

let base: string;
let workspace: string;
let outside: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "atd-scan-"));
  workspace = join(base, "workspace");
  outside = join(base, "outside");
  await mkdir(workspace);
  await mkdir(outside);
  await writeFile(join(outside, "secret.txt"), `TOP SECRET ${KEY}`);
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const write = async (path: string, content: string | Buffer) => {
  await mkdir(join(workspace, path, ".."), { recursive: true });
  await writeFile(join(workspace, path), content);
};

describe("scanWorkspace", () => {
  it("lists text files with relative paths and content, sorted", async () => {
    await write("fib.py", "print(1)\n");
    await write("src/b.ts", "b");
    await write("src/a.ts", "a");

    expect(await scanWorkspace(workspace)).toEqual({
      kind: "files",
      truncated: false,
      files: [
        { path: "fib.py", size: 9, content: "print(1)\n" },
        { path: "src/a.ts", size: 1, content: "a" },
        { path: "src/b.ts", size: 1, content: "b" },
      ],
    });
  });

  it("never follows a symlinked file out of the workspace", async () => {
    await symlink(join(outside, "secret.txt"), join(workspace, "innocent.txt"));
    const event = await scanWorkspace(workspace);
    expect(event.files).toEqual([]);
    expect(JSON.stringify(event)).not.toContain("TOP SECRET");
  });

  it("never follows a symlinked directory out of the workspace", async () => {
    await symlink(outside, join(workspace, "linked"));
    const event = await scanWorkspace(workspace);
    expect(event.files).toEqual([]);
    expect(JSON.stringify(event)).not.toContain("TOP SECRET");
  });

  it("ignores a symlink to the process environment", async () => {
    await symlink("/proc/self/environ", join(workspace, "env.txt"));
    expect((await scanWorkspace(workspace)).files).toEqual([]);
  });

  it("does not hang on a FIFO", { timeout: 5_000 }, async () => {
    execFileSync("mkfifo", [join(workspace, "pipe")]);
    await write("a.txt", "a");
    expect((await scanWorkspace(workspace)).files.map((f) => f.path)).toEqual(["a.txt"]);
  });

  it.each([".env", ".env.local", "id_rsa", "id_ed25519.pub", "server.pem", "tls.key", ".npmrc", ".netrc", ".git-credentials", "credentials.json"])(
    "lists %s without its content",
    async (name) => {
      await write(name, "password=hunter2");
      const event = await scanWorkspace(workspace);
      expect(event.files).toEqual([{ path: name, size: 16, skipped: "sensitive" }]);
      expect(JSON.stringify(event)).not.toContain("hunter2");
    },
  );

  it("does not descend into .git or dependency folders, and hides the image's own .git", async () => {
    await write(".git/config", `[credential] token=${KEY}`);
    await write("node_modules/pkg/index.js", "x");
    await write("main.js", "y");
    await write("vendor/lib/.git/config", `[credential] token=${KEY}`);
    const event = await scanWorkspace(workspace);
    expect(event.files).toEqual([
      { path: "main.js", size: 1, content: "y" },
      { path: "node_modules", size: 0, skipped: "dir" },
      { path: "vendor/lib/.git", size: 0, skipped: "dir" },
    ]);
    expect(JSON.stringify(event)).not.toContain(KEY);
  });

  it("stops walking after maxEntries, counting folders the list never shows", async () => {
    for (let i = 0; i < 20; i++) await mkdir(join(workspace, "deep", `d${i}`), { recursive: true });
    await write("zz.txt", "z");
    const event = await scanWorkspace(workspace, { limits: { maxEntries: 10 } });
    expect(event.files).toEqual([]);
    expect(event.truncated).toBe(true);
  });

  it("stops walking at the time limit", async () => {
    await write("a.txt", "a");
    const event = await scanWorkspace(workspace, { limits: { timeoutMs: -1 } });
    expect(event.files).toEqual([]);
    expect(event.truncated).toBe(true);
  });

  it("reads each file into the shared buffer without leaking the previous one", async () => {
    await write("a.txt", "a".repeat(50));
    await write("b.txt", "bb");
    expect((await scanWorkspace(workspace)).files.map((f) => f.content)).toEqual(["a".repeat(50), "bb"]);
  });

  it("sends no content for binary or invalid UTF-8 files", async () => {
    await write("a.bin", Buffer.from([0x50, 0x4b, 0x00, 0x01]));
    await write("b.txt", Buffer.from([0xff, 0xfe, 0x41]));
    expect((await scanWorkspace(workspace)).files).toEqual([
      { path: "a.bin", size: 4, skipped: "binary" },
      { path: "b.txt", size: 3, skipped: "binary" },
    ]);
  });

  it("enforces the per-file and total size limits", async () => {
    await write("a.txt", "a".repeat(40));
    await write("b.txt", "b".repeat(40));
    await write("c.txt", "c".repeat(200));
    await write("d.txt", "d".repeat(10));
    const event = await scanWorkspace(workspace, { limits: { maxFileBytes: 100, maxTotalBytes: 60 } });
    expect(event.files).toEqual([
      { path: "a.txt", size: 40, content: "a".repeat(40) },
      { path: "b.txt", size: 40, skipped: "budget" },
      { path: "c.txt", size: 200, skipped: "too_large" },
      { path: "d.txt", size: 10, content: "d".repeat(10) },
    ]);
  });

  it("stops at the file limit and says the list is truncated", async () => {
    for (const name of ["a", "b", "c", "d"]) await write(name, name);
    const event = await scanWorkspace(workspace, { limits: { maxFiles: 2 } });
    expect(event.files.map((f) => f.path)).toEqual(["a", "b"]);
    expect(event.truncated).toBe(true);
  });

  it("leaves out files whose names could disguise them", async () => {
    await write("invoice‮fdp.exe", "x");
    await write("two\nlines.txt", "x");
    await write("ok.txt", "ok");
    const event = await scanWorkspace(workspace);
    expect(event.files.map((f) => f.path)).toEqual(["ok.txt"]);
    expect(event.truncated).toBe(true);
  });
});

// The walk filters these out first; this covers a file swapped for one between readdir and open.
describe("openRegularFile", () => {
  it("opens a regular file", async () => {
    await write("a.txt", "abc");
    const opened = await openRegularFile(join(workspace, "a.txt"));
    expect(opened?.size).toBe(3);
    await opened?.handle.close();
  });

  it("refuses a symlink, even to a regular file", async () => {
    await symlink(join(outside, "secret.txt"), join(workspace, "link"));
    expect(await openRegularFile(join(workspace, "link"))).toBeUndefined();
  });

  it("refuses a FIFO without blocking", { timeout: 5_000 }, async () => {
    execFileSync("mkfifo", [join(workspace, "pipe")]);
    expect(await openRegularFile(join(workspace, "pipe"))).toBeUndefined();
  });

  it("refuses a directory", async () => {
    expect(await openRegularFile(outside)).toBeUndefined();
  });
});
