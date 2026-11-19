import type { NormalizedEvent } from "./index.js";

export type FileSkipReason = "binary" | "too_large" | "budget" | "sensitive" | "dir";

export const FILE_SKIP_REASONS: Record<FileSkipReason, true> = {
  binary: true,
  too_large: true,
  budget: true,
  sensitive: true,
  dir: true,
};

/** A file the agent left in /workspace. `content` is only set for small UTF-8 text files. */
export interface WorkspaceFile {
  /** Relative to /workspace, always passes isSafeWorkspacePath. */
  path: string;
  size: number;
  content?: string;
  skipped?: FileSkipReason;
}

/** Shared by the runner (which applies them) and the server (which enforces them again). */
export const FILE_LIMITS = {
  maxFiles: 200,
  maxFileBytes: 64_000,
  maxTotalBytes: 512_000,
  maxPathLength: 512,
} as const;

// Control and invisible format characters (incl. bidi overrides like U+202E) can disguise a name,
// e.g. "invoice‮fdp.exe" displays as "invoiceexe.pdf".
const UNSAFE_PATH_CHARS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\\]/u;

export function isSafeWorkspacePath(path: unknown): path is string {
  if (typeof path !== "string" || path.length === 0 || path.length > FILE_LIMITS.maxPathLength) return false;
  if (UNSAFE_PATH_CHARS.test(path)) return false;
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

export const REDACTED = "[redacted]";

// Short values would match ordinary text, and replacing them could make content grow past the limits.
const MIN_SECRET_LENGTH = 16;

/** Returns a copy of `value` with every secret replaced in every string, keys included. */
export function redactSecrets<T>(value: T, secrets: readonly string[]): T {
  // Longest first, so a secret that contains another is replaced whole rather than leaving its tail.
  const active = [...new Set(secrets)].filter((s) => s.length >= MIN_SECRET_LENGTH).sort((a, b) => b.length - a.length);
  if (active.length === 0) return value;
  const scrub = (s: string) => active.reduce((acc, secret) => acc.replaceAll(secret, REDACTED), s);
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return scrub(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === "object") {
      return Object.fromEntries(Object.entries(v).map(([k, inner]) => [scrub(k), walk(inner)]));
    }
    return v;
  };
  return walk(value) as T;
}

/**
 * redactSecrets for events. Two paths that differ only by a secret both become "[redacted]", so a files
 * event keeps only the first of them: duplicate paths would otherwise fail validation and React keys.
 */
export function redactEvent(event: NormalizedEvent, secrets: readonly string[]): NormalizedEvent {
  const safe = redactSecrets(event, secrets);
  if (safe.kind !== "files") return safe;
  const seen = new Set<string>();
  const files = safe.files.filter((f) => {
    if (seen.has(f.path)) return false;
    seen.add(f.path);
    return true;
  });
  return files.length === safe.files.length ? safe : { ...safe, files, truncated: true };
}
