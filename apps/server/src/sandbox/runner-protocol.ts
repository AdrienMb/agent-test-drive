import {
  FILE_LIMITS,
  FILE_SKIP_REASONS,
  isSafeWorkspacePath,
  type NormalizedEvent,
  type RunStatus,
  type ToolKind,
  type WorkspaceFile,
} from "@atd/shared";

// Records rather than arrays so the compiler flags a missing entry when the unions grow.
const RUN_STATUSES: Record<RunStatus, true> = { running: true, done: true, failed: true, cancelled: true };
const TOOL_KINDS: Record<ToolKind, true> = {
  shell: true,
  file_edit: true,
  web_search: true,
  mcp: true,
  todo: true,
  read: true,
  other: true,
};
const TOOL_STATUSES: Record<Extract<NormalizedEvent, { kind: "tool_call" }>["status"], true> = {
  started: true,
  completed: true,
  failed: true,
};

/**
 * Room for the largest valid files event. JSON escapes a control character as \u00XX, so each byte of
 * content or path can take up to 6 bytes on the line; the margin covers the per-file field names.
 */
export const MAX_LINE_BYTES = 6 * (FILE_LIMITS.maxTotalBytes + FILE_LIMITS.maxFiles * FILE_LIMITS.maxPathLength) + 64 * 1024;

const oneOf = (table: object, value: unknown) => typeof value === "string" && Object.hasOwn(table, value);

/**
 * The agent runs as the same user as the runner and can write to the runner's stdout directly,
 * so a files event is untrusted input: every field is checked and the event is rebuilt from them.
 */
function parseFilesEvent(e: Record<string, unknown>): NormalizedEvent | undefined {
  if (typeof e.truncated !== "boolean" || !Array.isArray(e.files) || e.files.length > FILE_LIMITS.maxFiles) return undefined;
  const files: WorkspaceFile[] = [];
  const seen = new Set<string>();
  let totalBytes = 0;
  for (const raw of e.files as unknown[]) {
    if (typeof raw !== "object" || raw === null) return undefined;
    const { path, size, content, skipped } = raw as Record<string, unknown>;
    if (!isSafeWorkspacePath(path) || seen.has(path)) return undefined;
    if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) return undefined;
    seen.add(path);
    const file: WorkspaceFile = { path, size };
    if (skipped !== undefined) {
      if (!oneOf(FILE_SKIP_REASONS, skipped) || content !== undefined) return undefined;
      file.skipped = skipped as WorkspaceFile["skipped"];
    }
    if (content !== undefined) {
      if (typeof content !== "string") return undefined;
      const bytes = Buffer.byteLength(content);
      if (bytes > FILE_LIMITS.maxFileBytes) return undefined;
      totalBytes += bytes;
      file.content = content;
    }
    files.push(file);
  }
  if (totalBytes > FILE_LIMITS.maxTotalBytes) return undefined;
  return { kind: "files", files, truncated: e.truncated };
}

function toNormalizedEvent(value: unknown): NormalizedEvent | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const e = value as Record<string, unknown>;
  switch (e.kind) {
    case "status":
      return oneOf(RUN_STATUSES, e.status) ? (e as NormalizedEvent) : undefined;
    case "message":
    case "reasoning":
      return typeof e.text === "string" ? (e as NormalizedEvent) : undefined;
    case "error":
      return typeof e.message === "string" ? (e as NormalizedEvent) : undefined;
    case "usage":
      return e as NormalizedEvent;
    case "tool_call":
      return typeof e.id === "string" && typeof e.title === "string" && oneOf(TOOL_KINDS, e.tool) && oneOf(TOOL_STATUSES, e.status)
        ? (e as NormalizedEvent)
        : undefined;
    case "files":
      return parseFilesEvent(e);
    default:
      return undefined;
  }
}

/** A runner stdout line: the event plus the turn id the runner tagged it with. */
export interface RunnerLine {
  event: NormalizedEvent;
  turn?: string;
}

/** Expects lines already bounded by MAX_LINE_BYTES (see splitLines). */
export function parseRunnerLine(line: string): RunnerLine | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  // Removed so it isn't passed on as part of the event.
  const { turn, ...rest } = value as Record<string, unknown>;
  const event = toNormalizedEvent(rest);
  if (!event) return undefined;
  return typeof turn === "string" ? { event, turn } : { event };
}
