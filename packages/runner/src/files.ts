import { constants, type Dirent } from "node:fs";
import { open, opendir, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { FILE_LIMITS, isSafeWorkspacePath, type NormalizedEvent, type WorkspaceFile } from "@atd/shared";

type FilesEvent = Extract<NormalizedEvent, { kind: "files" }>;

const SKIP_DIRS = new Set([".git", "node_modules", ".venv", "venv", "__pycache__", ".cache"]);
// The image runs `git init` in /workspace, so the top-level .git is not something the agent made.
const HIDDEN_ROOT_DIRS = new Set([".git"]);

/**
 * maxFiles only counts what is listed. These bound the walk itself, so a huge tree of directories,
 * symlinks or other unlisted entries cannot hold up the final status.
 */
const SCAN_LIMITS = { maxEntries: 10_000, timeoutMs: 10_000 };

// The agent may write credentials into the workspace (e.g. a .env); list them but never send their content.
const SENSITIVE_NAMES = [
  /^\.env(\..*)?$/i,
  /\.(pem|key|p12|pfx|keystore|jks)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)/i,
  /^\.(npmrc|netrc|pypirc|git-credentials|htpasswd)$/i,
  /^credentials(\.json)?$/i,
];

const isSensitive = (name: string) => SENSITIVE_NAMES.some((re) => re.test(name));

/**
 * Opens `path` only if it is a regular file. The walk already skips symlinks and FIFOs, but the agent's
 * background processes can swap a file for one after readdir: O_NOFOLLOW refuses the symlink, O_NONBLOCK
 * keeps a FIFO from blocking the open, and fstat checks what was actually opened.
 */
export async function openRegularFile(path: string): Promise<{ handle: FileHandle; size: number } | undefined> {
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return undefined;
  }
  const stat = await handle.stat().catch(() => undefined);
  if (stat?.isFile()) return { handle, size: stat.size };
  await handle.close();
  return undefined;
}

export interface ScanOptions {
  limits?: Partial<Record<keyof typeof FILE_LIMITS | keyof typeof SCAN_LIMITS, number>>;
}

/**
 * Lists what the agent left in `root`. Never follows symlinks and never reads past the limits.
 * Contents are not redacted here: every event, this one included, is redacted by the emitter.
 */
export async function scanWorkspace(root: string, options: ScanOptions = {}): Promise<FilesEvent> {
  const limits = { ...FILE_LIMITS, ...SCAN_LIMITS, ...options.limits };
  const deadline = Date.now() + limits.timeoutMs;
  const files: WorkspaceFile[] = [];
  let truncated = false;
  let totalBytes = 0;
  let entriesSeen = 0;
  // One buffer for the whole scan; only the bytes read into it are ever used.
  const buffer = Buffer.allocUnsafe(limits.maxFileBytes + 1);

  const full = () => {
    if (files.length < limits.maxFiles) return false;
    truncated = true;
    return true;
  };

  async function readFile(absolute: string, path: string, name: string): Promise<WorkspaceFile | undefined> {
    const opened = await openRegularFile(absolute);
    if (!opened) return undefined;
    const { handle, size } = opened;
    try {
      if (isSensitive(name)) return { path, size, skipped: "sensitive" };
      if (size > limits.maxFileBytes) return { path, size, skipped: "too_large" };
      if (totalBytes + size > limits.maxTotalBytes) return { path, size, skipped: "budget" };

      // The file can still grow after stat, so the read itself is bounded too.
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length > limits.maxFileBytes) return { path, size: length, skipped: "too_large" };
      if (totalBytes + length > limits.maxTotalBytes) return { path, size: length, skipped: "budget" };

      const bytes = buffer.subarray(0, length);
      let text: string;
      try {
        if (bytes.includes(0)) throw new Error("NUL byte");
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        return { path, size: length, skipped: "binary" };
      }
      totalBytes += length;
      return { path, size: length, content: text };
    } finally {
      await handle.close();
    }
  }

  /** Reads at most the entries left in the budget; a directory with more ends the walk. */
  async function readEntries(dir: string): Promise<{ entries: Dirent[]; complete: boolean } | undefined> {
    const entries: Dirent[] = [];
    try {
      // The async iterator closes the directory however the loop exits.
      for await (const entry of await opendir(dir)) {
        if (entriesSeen >= limits.maxEntries || Date.now() > deadline) return { entries, complete: false };
        entriesSeen++;
        entries.push(entry);
      }
    } catch {
      return undefined;
    }
    return { entries, complete: true };
  }

  /** Returns false once a limit is reached, to stop the walk. */
  async function visit(dir: string, prefix: string): Promise<boolean> {
    const read = await readEntries(dir);
    if (!read) {
      truncated = true;
      return true;
    }
    const { entries, complete } = read;
    if (!complete) truncated = true;
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    for (const entry of entries) {
      if (Date.now() > deadline) {
        truncated = true;
        return false;
      }
      if (prefix === "" && HIDDEN_ROOT_DIRS.has(entry.name) && entry.isDirectory()) continue;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (!isSafeWorkspacePath(path)) {
        truncated = true;
        continue;
      }
      // Dirent types come from lstat: symlinks, FIFOs and sockets are neither, so they are skipped.
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) {
          if (full()) return false;
          files.push({ path, size: 0, skipped: "dir" });
        } else if (!(await visit(join(dir, entry.name), path))) {
          return false;
        }
      } else if (entry.isFile()) {
        if (full()) return false;
        const file = await readFile(join(dir, entry.name), path, entry.name);
        if (file) files.push(file);
      }
    }
    return complete;
  }

  await visit(root, "");
  return { kind: "files", files, truncated };
}
