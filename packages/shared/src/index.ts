export type AgentId = "claude" | "codex";

export const AGENTS: readonly { id: AgentId; label: string }[] = [
  { id: "claude", label: "Claude Code" },
  { id: "codex", label: "Codex" },
];

export type ToolKind = "shell" | "file_edit" | "web_search" | "mcp" | "todo" | "read" | "other";

export type RunStatus = "running" | "done" | "failed" | "cancelled";

export type NormalizedEvent =
  | { kind: "status"; status: RunStatus }
  | { kind: "message"; text: string }
  | { kind: "reasoning"; text: string }
  | {
      kind: "tool_call";
      id: string;
      tool: ToolKind;
      /** Short human label, e.g. "npm test", "edit src/a.ts". */
      title: string;
      status: "started" | "completed" | "failed";
      input?: unknown;
      output?: string;
      files?: string[];
    }
  | { kind: "usage"; inputTokens?: number; outputTokens?: number; costUsd?: number; durationMs?: number }
  | { kind: "error"; message: string };

/** One line of JSON written to stdin of the runner container. */
export interface RunnerJob {
  agent: AgentId;
  prompt: string;
}

/** What the server streams to the browser over SSE. */
export interface RunEvent {
  runId: string;
  agent: AgentId;
  seq: number;
  ts: number;
  event: NormalizedEvent;
}
