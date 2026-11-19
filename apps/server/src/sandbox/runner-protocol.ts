import type { NormalizedEvent, RunStatus, ToolKind } from "@atd/shared";

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

const oneOf = (table: object, value: unknown) => typeof value === "string" && Object.hasOwn(table, value);

function isNormalizedEvent(value: unknown): value is NormalizedEvent {
  if (typeof value !== "object" || value === null) return false;
  const e = value as Record<string, unknown>;
  switch (e.kind) {
    case "status":
      return oneOf(RUN_STATUSES, e.status);
    case "message":
    case "reasoning":
      return typeof e.text === "string";
    case "error":
      return typeof e.message === "string";
    case "usage":
      return true;
    case "tool_call":
      return typeof e.id === "string" && typeof e.title === "string" && oneOf(TOOL_KINDS, e.tool) && oneOf(TOOL_STATUSES, e.status);
    default:
      return false;
  }
}

export function parseRunnerLine(line: string): NormalizedEvent | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  try {
    const value: unknown = JSON.parse(trimmed);
    return isNormalizedEvent(value) ? value : undefined;
  } catch {
    return undefined;
  }
}
